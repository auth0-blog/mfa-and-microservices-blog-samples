var express = require('express');
var morgan = require('morgan');
var http = require('http');
var mongo = require('mongodb').MongoClient;
var winston = require('winston');

// Logging
winston.emitErrs = true;
var logger = new winston.Logger({
    transports: [
        new winston.transports.Console({
            timestamp: true,
            level: 'debug',
            handleExceptions: true,
            json: false,
            colorize: true
        })
    ],
    exitOnError: false
});

logger.stream = {
    write: function(message, encoding){
        logger.debug(message.replace(/\n$/, ''));
    }
};

// Express and middlewares
var app = express();
app.use(
    //Log requests
    morgan(':method :url :status :response-time ms - :res[content-length]', { 
        stream: logger.stream 
    })
);

var db;
if(process.env.MONGO_URL) {
    mongo.connect(process.env.MONGO_URL, null, function(err, db_) {
        if(err) {
            logger.error(err);
        } else {
            db = db_;
        }
    });
}

app.use(function(req, res, next) {    
    if(!db) {
        //Database not connected
        mongo.connect(process.env.MONGO_URL, null, function(err, db_) {
            if(err) {
                logger.error(err);
                res.sendStatus(500);                
            } else {
                db = db_;
                next();
            }
        });
    } else {
        next();
    }    
});

// Actual query
app.get('/tickets', function(req, res, next) {
    var collection = db.collection('tickets');
    collection.find().toArray(function(err, result) {
        if(err) {
            logger.error(err);
            res.sendStatus(500);
            return;
        } 
        res.json(result);
    });   
});

// Standalone server setup
var port = process.env.PORT || 3001;
http.createServer(app).listen(port, function (err) {
  if (err) {
    logger.error(err);
  } else {
    logger.info('Listening on http://localhost:' + port);
  }
});


