'use strict';

var Bluebird = require('bluebird');

module.exports = function concat(stream) {
  return new Bluebird((resolve, reject) => {
    var chunks = [];
    stream.on('error', reject);
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      var body = Buffer.concat(chunks).toString();
      var json;
      try {
        json = JSON.parse(body);
      } catch (err) {
        json = { message: err.message, body: body };
      }
      resolve(json);
    });
  });
};
