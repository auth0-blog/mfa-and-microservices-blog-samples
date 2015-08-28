var http = require('http');

http.createServer(function(req, res) {
    console.log(req.url);
    console.log(req.headers);
    
    req.on('data', function(chunk) {
        console.log(chunk);
    });
    
    res.statusCode = 200;
    res.end();
}).listen(3001);

console.log("Listening on port 3001");


