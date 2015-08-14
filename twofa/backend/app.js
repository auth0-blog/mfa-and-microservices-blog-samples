var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var session = require('express-session');

var base32 = require('thirty-two');
var sprintf = require('sprintf');
var crypto = require('crypto');

var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var TotpStrategy = require('passport-totp').Strategy;

var strings = require('./views/strings.json');

/* PERSISTENT STORAGE */
var fs = require('fs');
// Load users from a persistent store (a DB is what you normally use here).
// For the sake of simplicity we will use a JSON file storing usernames,
// passwords and secrets. DO NOT DO THIS in production, passwords must
// never be stored as plain text.
var users = {};
try {
    users = JSON.parse(fs.readFileSync('users.json', { encoding: "utf8" }));
} catch(e) {
    //Do nothing, keep users empty
}
/* END: PERSISTENT STORAGE */

function verifyCredentials(username, password) {
    console.log(users);
    var user = users[username];
    if(!user) {
         return false;
    }
    
    return user.password === password;
}

passport.use(new LocalStrategy(
    function(username, password, done) {
        var valid = verifyCredentials(username, password);
        return done(null, valid ? users[username] : false);
    })
);

passport.use(new TotpStrategy(
    function(user, done) {
        var key = user.key;
        if(!key) {
            return done(new Error('No key'));
        } else {
            return done(null, base32.decode(key), 30); //30 = valid key period
        }
    })
);

passport.serializeUser(function(user, done) {
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {
    for(var u in users) {
        if(users[u].id === id) {
            done(null, users[u]);
            return;
        }
    }
    
    done(new Error("Not found"));
});

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hjs');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: 'totp test app secret' }));
app.use(passport.initialize());
app.use(passport.session());

function isLoggedIn(req, res, next) {
    if(req.isAuthenticated()) {
        next();
    } else {
        res.redirect('/login');
    }
}

function ensureTotp(req, res, next) {
    if((req.user.key && req.session.method == 'totp') ||
       (!req.user.key && req.session.method == 'plain')) {
        next();
    } else {
        res.redirect('/login');
    }
}

app.get('/', isLoggedIn, ensureTotp, function(req, res) {
    res.redirect('/totp-setup');
});

app.get('/login', function(req, res) {
    req.logout();
    res.render('login', {
        strings: strings
    });
});

app.post('/login', 
    passport.authenticate('local', { failureRedirect: '/login' }),
    function(req, res) {
        if(req.user.key) {
            req.session.method = 'totp';
            res.redirect('/totp-input');
        } else {
            req.session.method = 'plain';
            res.redirect('/totp-setup');
        }
    }
);

app.get('/totp-input', isLoggedIn, function(req, res) {
    if(!req.user.key) {
        console.log("Logic error, totp-input requested with no key set");
        res.redirect('/login');
    }
    
    res.render('totp-input', {
        strings: strings
    });
});

app.post('/totp-input', isLoggedIn, passport.authenticate('totp', {
    failureRedirect: '/login',
    successRedirect: '/totp-setup'
}));

app.get('/totp-setup', 
    isLoggedIn,
    ensureTotp,
    function(req, res) {
        var url = null;
        if(req.user.key) {
            var qrData = sprintf('otpauth://totp/%s?secret=%s', 
                                 req.user.username, req.user.key);
            url = "https://chart.googleapis.com/chart?chs=166x166&chld=L|0&cht=qr&chl=" + 
                   qrData;
        }
    
        res.render('totp-setup', {
            strings: strings,
            user: req.user,
            qrUrl: url 
        });
    }
);

app.post('/totp-setup',
    isLoggedIn,
    ensureTotp,
    function(req, res) {
        if(req.body.totp) {
            req.session.method = 'totp';
            
            var secret = base32.encode(crypto.randomBytes(16));
            //Discard equal signs (part of base32, 
            //not required by Google Authenticator)
            //Base32 encoding is required by Google Authenticator. 
            //Other applications
            //may place other restrictions on the shared key format.
            secret = secret.toString().replace(/=/g, '');
            req.user.key = secret;
        } else {
            req.session.method = 'plain';
            
            req.user.key = null;
        }
        
        res.redirect('/totp-setup');
    }
);

// error handlers

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

var errorHandler = function(err, req, res, next){
   console.log(err.stack);
   res.send(500);
   // or you could call res.render('error'); if you have a view for that.
};

app.use(errorHandler);


// Exit handler
function onExit() {
    try {
        fs.writeFileSync('users.json', JSON.stringify(users), { 
            encoding: "utf8" 
        });
    } catch(e) {
        console.log(e);
    }
    
    process.exit();
}

process.on('exit', onExit);
process.on('SIGINT', onExit);

module.exports = app;


