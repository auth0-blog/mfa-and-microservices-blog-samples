var http = require('http');
var httpProxy = require('http-proxy');
var jwt = require('jsonwebtoken');

// User data. Valid users data that normally gets loaded from a database.
var users = {
    "user1": {
        username: "user1",
        password: "user1pass"
    },
    "user2": {
        username: "user2",
        password: "user2pass"
    }
};

var secretKey = "super secret jwt key";
var issuerStr = "Sample API Proxy"

var proxy = httpProxy.createProxyServer({});

function send401(res) {
    res.statusCode = 401;
    res.end();
}

function doLogin(req, res) {
    req.on('data', function(chunk) {
        try {
            var loginData = JSON.parse(chunk);
            var user = users[loginData.username];
            if(user && user.password === loginData.password) {
                var token = jwt.sign({}, secretKey, {
                    subject: user.username,
                    issuer: issuerStr
                });
                
                res.writeHeader(200, {
                    'Content-Length': token.length,
                    'Content-Type': "text/plain"
                });
                res.write(token);
                res.end;                
            } else {
                send401(res);
            }
        } catch(err) {
            console.log(err);
            send401(res);
        }
    });
}

function validateAuth(data) {
    data = data.split(" ");
    if(data[0] !== "Bearer" || !data[1]) {
        return false;
    }
    
    var token = data[1];    
    try {
        var payload = jwt.verify(token, secretKey);
        // Custom validation logic, in this case we just check that the 
        // user exists
        if(users[payload.sub]) {
            return true;
        }
    } catch(err) {
        console.log(err);
    }
    
    return false;
}

var server = http.createServer(function(req, res) {
    if(req.url === "/login" && req.method === 'POST') {
        doLogin(req, res);
        return;
    }

    var authHeader = req.headers["authorization"];
    if(!authHeader || !validateAuth(authHeader)) {
        send401(res);
        return;
    }
    
    proxy.web(req, res, { target: "http://127.0.0.1:3001" });
});

console.log("Listening on port 3000");
server.listen(3000);




