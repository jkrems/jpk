'use strict';

var http = require('http');
var https = require('https');
var path = require('path');
var Url = require('url');

var Bluebird = require('bluebird');
var debug = require('debug')('jpk:tree');
var _ = require('lodash');
var rc = require('rc');
var semver = require('semver');
var Range = semver.Range;
var SemVer = semver.SemVer;

var concat = require('./concat');

var config = rc('npm', {
  registry: 'https://registry.npmjs.org/',
});

function getHttpLib(url) {
  return /^https:/.test(url) ? https : http;
}

function fetch(url, headers) {
  url = Url.resolve(config.registry, url);
  debug('fetch', url);
  return new Bluebird((resolve, reject) => {
    var req = getHttpLib(url).request(url);
    _.each(headers, (value, name) => req.setHeader(name, value));
    req.on('error', reject);
    req.on('response', (res) => {
      if (res.statusCode === 304) {
        return resolve({ json: null, headers: res.headers, statusCode: res.statusCode });
      }

      if (res.statusCode >= 300) {
        return reject(new Error('Unexpected ' + res.statusCode));
      }

      resolve(concat(res).then(json => {
        return { json: json, headers: res.headers, statusCode: res.statusCode };
      }));
    });
    req.end();
  });
}

function tryMakeRange(range) {
  try {
    return new Range(range);
  } catch (err) {
    debug('Failed to create range', err.message);
    return range;
  }
}

function PackageType(doc, range) {
  function addAsRange(result, versionSpec, name) {
    result[name] = tryMakeRange(versionSpec);
  }

  this.name = doc.name;
  this.version = doc.version;
  this.range = range || new Range(doc.version);
  this.dependencies = _.transform(doc.dependencies || {}, addAsRange);
}

PackageType.prototype.toString = function toString() {
  return `${this.name}@${this.version}[${this.range}]`;
};

function Node(type, children) {
  debug('new Node(%s@%s)', type.name, type.version);
  this._type = type;
  this._children = children;
  this._parent = null;
  this._actual = null;
  children.forEach(child => child.parent = this);
}

Node.prototype.merge = function merge(other) {
  var ownType = this.getType();
  var otherType = other.getType();
  if (ownType !== otherType && ownType.range.test(otherType.version)) {
    debug('Replacing %s with %s', ownType, otherType);
    this._actual = other;
    return true;
  }
  return false;
};

Node.prototype.isReference = function isReference() {
  return this._actual !== null;
};

Node.prototype.getType = function getType() {
  if (this._actual) return this._actual.getType();
  return this._type;
};

Node.prototype.getChildren = function getChildren() {
  if (this._actual) return this._actual.getChildren();
  return this._children;
};

Node.prototype.setChildren = function setChildren(children) {
  if (this._actual) return this._actual.setChildren(children);
  this._children = children;
  return children;
};

Node.prototype.toJSON = function toJSON() {
  return {
    name: this.getType().name,
    version: this.getType().version,
    children: this.getChildren().map(child => child.toJSON()),
  };
};

var packageMetaCache = {};
function getPackageMetaCacheState(name) {
  if (!packageMetaCache[name]) {
    packageMetaCache[name] = {
      expires: 0,
      etag: null,
      pending: false,
      cached: false,
      data: null
    };
  }
  return packageMetaCache[name];
}
function getPackageMeta(name) {
  var state = getPackageMetaCacheState(name);
  var headers = {};

  if (state.pending) {
    return state.promise;
  } else if (state.cached) {
    if (state.expires >= Date.now()) {
      return Bluebird.resolve(state.data);
    }
    // Reload!
    headers['If-None-Match'] = state.etag;
  }

  state.promise = fetch(name, headers)
    .then(res => {
      var meta;
      if (res.statusCode === 304) {
        debug('Serving from cache, not modified');
      } else {
        state.data = res.json;
        state.etag = res.headers.etag;
      }
      state.expires = Date.now() + 60 * 1000; // 60 seconds
      state.cached = true;
      state.pending = false;
      state.promise = null;
      return state.data;
    });
  state.pending = true;

  return state.promise;
}

var pending = {};

function loadPackageMetaData(name, range) {
  debug('load meta data', name, range);
  pending[name] = (pending[name] || 0) + 1;
  return getPackageMeta(name)
    .then(doc => {
      var match;
      if (typeof range === 'string') {
        match = new SemVer(doc['dist-tags'][range]);
        range = new Range(match.version);
      } else {
        match = Object.keys(doc.versions || {})
          .map(v => new SemVer(v))
          .filter(v => range.test(v))
          .reduce((a, b) => (b.compare(a) > 0 ? b : a));
      }

      if (!match) {
        throw new Error(`Could not find ${name}@${range}`);
      }

      --pending[name];
      debug('Resolved %s@%s -> %s', name, range, match.version);
      var versionDoc = doc.versions[match.version];
      if (!versionDoc) {
        debug('Missing %s in versions{}',
          match.version, doc.versions);
        throw new Error(`Missing versions{} data for ${name}@${match}`);
      }
      return new PackageType(versionDoc, range);
    });
}

function createNode(type, chain) {
  debug('createNode(%s@%s)', type.name, type.version, chain);
  if (chain.indexOf(type.name) !== -1) {
    throw new Error('Recursive dependency chain: ' + chain);
  }

  var deps = Object.keys(type.dependencies || {})
    .sort()
    .map(name =>
      loadPackageMetaData(name, type.dependencies[name]));

  return Bluebird.all(deps)
    .map(dep => createNode(dep, chain.concat([type.name])))
    .then(function(depMeta) {
      return new Node(type, depMeta);
    });
}

function optimizeTree(tree) {
  var byName = {};

  function optimizeNode(node) {
    var name = node.getType().name;
    var version = node.getType().version;
    var range = node.getType().range;

    function isCompatible(other) {
      return node.merge(other) || other.merge(node);
    }

    var existing = (byName[name] || []).filter(isCompatible);

    byName[name] = existing.concat(node);

    if (!node.isReference()) {
      node.getChildren().forEach(child => optimizeNode(child));
    }
  }
  optimizeNode(tree);

  return tree;
}

function pruneDuplicates(tree) {
  function getTag(node) {
    var type = node.getType();
    return `${type.name}@${type.version}`;
  }

  function pruneNode(node, known) {
    var childKnown = known.concat([]);
    function notKnown(child) {
      var tag = getTag(child);
      if (childKnown.indexOf(tag) === -1) {
        // We never saw this before. Adding & visiting.
        childKnown.push(tag);
        return true;
      } else {
        // We already saw this, we can drop it.
        return false;
      }
    }

    var children = node.getChildren().filter(notKnown);
    node.setChildren(children);
    children.forEach(child => pruneNode(child, childKnown));
  }
  pruneNode(tree, []);

  return tree;
}

function prettyTree(tree) {
  function printNode(node, indent) {
    var name = node.getType().name;
    var version = node.getType().version;
    var tag = `${name}@${version}`;
    console.log(`${indent}${tag} (from ${node.getType().range})`);
    node.getChildren().forEach(child =>
      printNode(child, `${indent}  `));
  }
  printNode(tree, '');
}

exports.resolvePackageJson = function resolvePackageJson(pkgJson) {
  return createNode(new PackageType(pkgJson), [])
    .then(optimizeTree)
    .then(pruneDuplicates);
};
