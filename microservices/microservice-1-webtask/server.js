var webtask = require('webtask-tools');
var express = require('express');
var morgan = require('morgan');
var mongoose = require('mongoose');

// Our ticket sample schema
var Ticket = mongoose.model('Ticket', {
    id: Number,
    status: String,
    title: String,
    userInitials: String,
    assignedTo: String,
    shortDescription: String,
    description: String,
    replies: [{ user: String, message: String }]
});

var connected = false;
function connectOnce(url) {
    if(connected) {
        return;
    }
    mongoose.connect(url);
    connected = true;
}

var app = express();
app.use(
    //Log requests
    morgan(':method :url :status :response-time ms - :res[content-length]', { 
        stream: {
            write: function(message, encoding) {
                console.log("DEBUG: " + message.replace(/\n$/, ''));
            }
        }
    })
);

app.get('/tickets', function(req, res, next) {
    connectOnce(req.webtaskContext.data.MONGO_URL);

    Ticket.find({}, function(err, result) {
        if(err) {
            console.log("ERROR: " + err);
            res.sendStatus(500);
            return;
        } 
        res.json(result);
    });
});

//Express to webtask adapter
module.exports = webtask.fromExpress(app);


