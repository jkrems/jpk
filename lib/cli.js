'use strict';

var http = require('http');

var concat = require('./concat');
var resolvePackageJson = require('./tree').resolvePackageJson;

http.createServer((req, res) => {
  concat(req)
    .then(resolvePackageJson)
    .then(tree => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tree));
    })
    .done();
}).listen(3000);
