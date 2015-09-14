var http = require('http');
var url = require('url');
var jwt = require('jsonwebtoken');
var mongoose = require('mongoose');
var morgan = require('morgan');
var sprintf = require('sprintf');
var Q = require('q');
var _ = require('underscore');
var amqp = require('amqp');

var logger = require('./logger');

var amqpHost = process.env.AMQP_HOST || 'amqp://gateway:gateway@127.0.0.1:5672';

var httpLogger = morgan('combined', { stream: logger.stream });

function toBase64(obj) {
    return new Buffer(JSON.stringify(obj)).toString('base64');
}

var amqpConn = amqp.createConnection({url: amqpHost});

var userDb = mongoose.createConnection(process.env.USER_DB_URL || 
                'mongodb://guest:guest@localhost:21017/test/users');
var servicesDb = mongoose.createConnection(process.env.SERVICES_DB_URL || 
                'mongodb://guest:guest@localhost:21017/test/services');

// Mongoose user model
var User = userDb.model('User', new mongoose.Schema ({
    username: String,
    password: String,
    roles: [ String ]
}));

var Service = servicesDb.model('Service', new mongoose.Schema ({
    name: String,
    url: String,
    endpoints: [ new mongoose.Schema({
        type: String,
        url: String
    }) ],
    authorizedRoles: [ String ]
}));

var secretKey = "super secret jwt key";
var issuerStr = "Sample API Gateway"

function send401(res) {
    res.statusCode = 401;
    res.end();
}

function send500(res) {
    res.statusCode = 500;
    res.end();
}

/* Get all pending data from HTTP request */
function getData(req) {
    var result = Q.defer();
    
    var data = "";
    req.on('data', function(data_) {
        data += data_;
        if(data.length >= (1024 * 1024)) {
            data = "";
            result.reject("Bad request");
        }
    });
    
    req.on('end', function() {
        if(result.promise.isPending()) {
            try {
                result.resolve(data);
            } catch(err) {
                result.reject(err.toString());
            }
        }
    });
    
    return result.promise;
}

/*
 * Simple login: returns a JWT if login data is valid.
 */
function doLogin(req, res) {
    getData(req).then(function(data) { 
        try {
            var loginData = JSON.parse(data);
            User.findOne({ username: loginData.username }, function(err, user) { 
                if(err) {
                    logger.error(err);
                    send401(res);
                    return;
                }
            
                if(user.password === loginData.password) {
                    var token = jwt.sign({}, secretKey, {
                        subject: user.username,
                        issuer: issuerStr
                    });
                    
                    res.writeHeader(200, {
                        'Content-Length': token.length,
                        'Content-Type': "text/plain"
                    });
                    res.write(token);
                    res.end();                
                } else {
                    send401(res);
                }
            }, 'users');
        } catch(err) {
            logger.error(err);            
            send401(res);
        }
    }, function(err) {
        logger.error(err);            
        send401(res);
    });
}

/*
 * Authentication validation using JWT. Strategy: find existing user.
 */
function validateAuth(data, callback) {
    if(!data) {
        callback(null);
        return;
    }
    
    data = data.split(" ");
    if(data[0] !== "Bearer" || !data[1]) {
        callback(null);
        return;
    }
    
    var token = data[1];    
    try {
        var payload = jwt.verify(token, secretKey);
        // Custom validation logic, in this case we just check that the 
        // user exists
        User.findOne({ username: payload.sub }, function(err, user) {
            if(err) {
                logger.error(err);
            } else {
                callback({
                    user: user,
                    jwt: payload 
                });
            }
        });                
    } catch(err) {
        logger.error(err);
        callback(null);
    }
}

/*
 * Internal HTTP request, auth data is passed in headers.
 */
function httpSend(oldReq, endpoint, data, deferred, isGet) {
    var parsedEndpoint = url.parse(endpoint);

    var options = {
        hostname: parsedEndpoint.hostname,
        port: parsedEndpoint.port,
        path: parsedEndpoint.path,
        method: isGet ? 'GET' : 'POST',
        headers: isGet ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': data.length,
            'GatewayAuth': toBase64(oldReq.authPayload)
        }
    };

    var req = http.request(options, function(res) {
        var resData = "";
        res.on('data', function (chunk) {
            resData += chunk;
        });
        res.on('end', function() {
            try {
                var json = JSON.parse(resData);
                deferred.resolve(json);
            } catch(err) {
                deferred.reject({
                    req: oldReq, 
                    endpoint: endpoint, 
                    message: 'Invalid data format: ' + err.toString()
                });
            }
        });
    });

    req.on('error', function(e) {
        deferred.reject({
            req: oldReq, 
            endpoint: endpoint, 
            message: e.toString()
        });
    });

    if(!isGet && data) {
        req.write(data);
    }
    req.end();
}

/* 
 * Internal HTTP request
 */
function httpPromise(req, endpoint, isGet) {
    var result = Q.defer();
    
    function reject(msg) {
        result.reject({
            req: req, 
            endpoint: endpoint, 
            message: msg
        });
    }
    
    if(isGet) {
        httpSend(req, endpoint, null, result, isGet);
    } else {
        getData(req).then(function(data) {
            httpSend(req, endpoint, data, result, isGet);
        }, function(err) {
            reject(err);
        });
    }
    
    return result.promise;
}

function amqpSend(req, endpoint, data, result) {
    amqpConn.queue('', {
        exclusive: true
    }, function(queue) {
        queue.bind('#');
        
        queue.subscribe({ ack: true, prefetchCount: 1 }, 
            function(message, headers, deliveryInfo, messageObject) {
                messageObject.acknowledge();
                
                try {
                    var json = JSON.parse(message);
                    deferred.resolve(json);
                } catch(err) {
                    deferred.reject({
                        req: req, 
                        endpoint: endpoint, 
                        message: 'Invalid data format: ' + err.toString()
                    });
                }               
            }
        );
        
        //Default exchange
        var exchange = amqpConn.exchange();
        //Send data
        exchange.publish(endpoint, data ? data : {}, {
            headers: {
                'GatewayAuth': toBase64(req.authPayload),                
            },
            deliveryMode: 1, //non-persistent
            replyTo: queue.name,
            mandatory: true,
            immediate: true
        }, function(err) {
            if(err) {
                deferred.reject({
                    req: req, 
                    endpoint: endpoint, 
                    message: 'Could not publish message to the default ' + 
                             'AMQP exchange'
                });
            }
        });
    });
}

/* 
 * Internal AMQP request
 */
function amqpPromise(req, endpoint, isGet) {
    var result = Q.defer();
    
    function reject(msg) {
        result.reject({
            req: req, 
            endpoint: endpoint, 
            message: msg
        });
    }
    
    if(req.method === 'POST') {
        getData(req).then(function(data) {
            amqpSend(req, endpoint, data, result);
        }, function(err) {
            reject(err);
        });        
    } else {
        amqpSend(req, endpoint, null, result);
    }
    
    return result.promise;
}

function roleCheck(user, service) {
    var intersection = _.intersection(user.roles, service.authorizedRoles);
    return intersection.length === service.authorizedRoles.length;
}

/* 
 * Parses the request and dispatches multiple concurrent requests to each
 * internal endpoint. Results are aggregated and returned.
 */
function serviceDispatch(req, res) {
    var parsedUrl = url.parse(req.url);
    
    Service.findOne({ url: parsedUrl.pathname }, function(err, service) {
        if(err) {
            logger.error(err);
            send500(res);
            return;
        }
    
        var authorized = roleCheck(req.context.authPayload.user, service);
        if(!authorized) {
            send401(res);
            return;
        }       
        
        // Fanout all requests to all related endpoints. 
        // Results are aggregated (more complex strategies are possible).
        var promises = [];
        service.endpoints.forEach(function(endpoint) {   
            logger.debug(sprintf('Dispatching request from public endpoint ' + 
                '%s to internal endpoint %s (%s)', 
                req.url, endpoint.url, endpoint.type));
                         
            switch(endpoint.type) {
                case 'http-get':
                case 'http-post':
                    promises.push(httpPromise(req, endpoint.url, 
                        endpoint.type === 'http-get'));
                    break;
                case 'amqp':
                    promises.push(amqpPromise(req, endpoint.url));
                    break;
                default:
                    logger.error('Unknown endpoint type: ' + endpoint.type);
            }            
        });
        
        //Aggregation strategy for multiple endpoints.
        Q.allSettled(promises).then(function(results) {
            var responseData = {};
        
            results.forEach(function(result) {
                if(result.state === 'fulfilled') {
                    responseData = _.extend(responseData, result.value);
                } else {
                    logger.error(result.reason.message);
                }
            });
            
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(responseData));
        });
    }, 'services');
}

var server = http.createServer(function(req, res) {
    httpLogger(req, res, function(){});

    // Login endpoint
    if(req.url === "/login" && req.method === 'POST') {
        doLogin(req, res);
        return;
    }

    // Authentication
    var authHeader = req.headers["authorization"];
    validateAuth(authHeader, function(authPayload) {
        if(!authPayload) {
            send401(res);
            return;
        }
        
        // We keep the authentication payload to pass it to 
        // microservices decoded.
        req.context = {
            authPayload: authPayload
        };
        
        serviceDispatch(req, res);        
    });
});

logger.info("Listening on port 3000");
server.listen(3000);




