'use strict';

var http = require('http');

var concat = require('./concat');
var resolvePackageJson = require('./tree').resolvePackageJson;

http.createServer((req, res) => {
  concat(req)
    .then(resolvePackageJson)
    .then(tree => {
      res.writeHead(200, { 'Content-Type': 'application/x-json-stream' });
      function writeNode(node) {
        var refs = node.getChildren().map(child => {
          var childType = child.getType();
          writeNode(child);
          return `${childType.name}@${childType.version}`;
        });
        var type = node.getType();
        res.write(JSON.stringify({ name: type.name, version: type.version, refs: refs }) + '\n');
      }
      writeNode(tree);
      res.end();
    })
    .catch(err => {
      res.statusCode = 500;
      try {
        res.end(JSON.stringify({ error: { message: err.message } }));
      } catch (fatal) {}
    });
}).listen(3000);
