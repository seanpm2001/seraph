'use strict';
var url = require('url');
var neo4j = require('neo4j-driver').v1;
var _ = require('underscore');
var nodeify = require('ascallback');

module.exports = function(options) {
  var db;
  if (!options || !options.nodeify) db =  new Seraph(options);
  else {
    db = new Proxy(new Seraph(options), {
      get: function(target, name) {
        if (name in target && typeof target[name] == 'function') {
          return function() {
            var args = [].slice.call(arguments, 0, arguments.length - 1);
            var cb = arguments[arguments.length - 1];
            nodeify(target[name].apply(target, args), cb);
          }
        } else {
          return target[name]
        }
      }
    });
  }

  var recursiveProxy = (obj) => {
    return new Proxy(obj, {
      get: (_, k) => {
        if (!obj[k]) return undefined;
        if (typeof obj[k] == 'object') return recursiveProxy(obj[k]);
        return db[obj[k]].bind(db);
      }
    });
  }

  return new Proxy(db, {
    get: (target, key) => {
      if (target[key]) return target[key];
      var proxy = proxyMap[key];
      if (!proxy) return undefined;
      if (typeof proxy == 'object') return recursiveProxy(proxy);
      else return db[proxy].bind(db);
    }
  })
}

var proxyMap = {
  node: {
    save: 'save',
    read: 'read',
    nodesWithLabel: 'nodesWithLabel',
    readLabels: 'readLabels'
  },
  constraints: {
    uniqueness: {
      create: 'createUniquenessConstraint'
    }
  },
  rel: {
    read: 'readRel',
    create: 'createRel',
    update: 'updateRel'
  }
}

class Seraph {
  constructor(options) {
    if (!options) options = 'bolt://neo4j:neo4j@localhost';
    if (typeof options != 'object') {
      var server = url.parse(options);
      options = {
        user: server.auth ? server.auth.split(':')[0] : 'neo4j',
        pass: server.auth ? server.auth.split(':')[1] : 'neo4j'
      };
      delete server.auth;
      options.server = url.format(server);
    }

    options.user = options.user || 'neo4j';
    options.pass = options.pass || 'neo4j';   
    options.server = options.server || 'bolt://localhost';
    options.id = options.id || 'id';

    this.options = options;
    this.driver = options.driver ||  neo4j.driver(options.server, neo4j.auth.basic(options.user, options.pass));
    this.label = options.label === false ? false : true;
    this.unboxInts = options.unboxInts === false ? false : true;


  }

  _unboxInt(i) {
    return this.unboxInts ? i.toNumber() : i;
  }

  _unboxAll(obj) {
    Object.keys(obj).forEach((key) => {
      if (neo4j.isInt(obj[key])) obj[key] = this._unboxInt(obj[key]);
    });
    return obj;
  }

  _getId(obj, requireData) {
    return new Promise((resolve, reject) => {
      var id;
      if (requireData) {
        id = typeof obj == 'object' ? obj[this.options.id] : undefined;
      } else {
        id = typeof obj == 'object' ? obj[this.options.id] : obj;
      }

      if (id != null) id = parseInt(id, 10);
      if (isNaN(id) || id == null) return reject(new Error("Invalid ID"));
      resolve(neo4j.int(id));
    });
  }

  _processResult(result, singleOrNull) {
    var records = result.records;
    var assemble = (field) => {
      if (typeof field != 'object' || !field) return field;
      else if (neo4j.isInt(field)) return this._unboxInt(field);
      else if (field instanceof neo4j.types.Node) {
        var obj = field.properties;
        if (this.options.label) obj.labels = field.labels;
        obj[this.options.id] = this._unboxInt(field.identity);
        return this._unboxAll(obj);
      }
      else if (field instanceof neo4j.types.Relationship) {
        field.start = this._unboxInt(field.start);
        field.end = this._unboxInt(field.end);
        field[this.options.id] = this._unboxInt(field.identity);
        if (this.options.id != 'identity') delete field.identity;
        field.properties = this._unboxAll(field.properties);
        return field;
      }
      else return field;
    }
    var processed = records.map((record) => {
      if (record.keys.length == 1) return assemble(record._fields[0]);
      else {
        var row = {};
        Object.keys(record).forEach((key) => {
          row[key] = assemble(record._fields[record._fieldLookup[key]])
        });
        return row;
      }
    });
    if (singleOrNull) processed = this._selectSingleOrNull(processed);
    return processed;
  }

  _selectSingleOrNull(results) {
    return results.length > 0 ? results[0] : null;
  }

  _session() {
    return this.options.session || this.driver.session();
  }

  _endSession(sess) {
    return (passthrough) => {
      if (this.options.session != sess) sess.close();
      return passthrough;
    }
  }

  _aggregate(fn, arr, argnum, allargs) {
    var sess = this.options.session ? this : this.session();
    var aggregated = Promise.all(arr.map(arg => {
      allargs[argnum] = arg;
      return fn.apply(sess, allargs);
    }))
    if (!this.options.session) {
      aggregated = aggregated
        .then((r) => { return sess.close(), r })
        .catch((e) => {
          sess.close();
          return new Promise((_, r) => r(e))
        });
    }
    return aggregated;
  }

  _run(query, params) {
    var sess = this._session();
    return sess.run(query, params)
      .then(this._endSession(sess))
      .catch((e) => {
        this._endSession(sess)();
        return new Promise((_, r) => r(e));
      });
  }

  session() { 
    var sess = this.driver.session();
    var sessSeraph = new Seraph(this.options);
    sessSeraph.session = sess;
    return sessSeraph;
  }

  close() {
    this.options.session && this.options.session.close();
  }

  query(cypher, params) {
    return this._run(cypher, params)
      .then((result) => this._processResult(result));
  }

  read(node, prop) {
    if (Array.isArray(node)) return this._aggregate(this.read, node, 0, arguments);
    return this._getId(node)
      .then((id) => {
        return this._run(`
          MATCH (node) WHERE id(node) = {id}
          RETURN ${prop ? "node." + prop : "node"}
        `, {id});
      })
      .then((result) => this._processResult(result, true))
  }

  save(node, label) {
    if (Array.isArray(node)) return this._aggregate(this.save, node, 0, arguments);
    if (arguments[2] != null) return this._saveProperty(node, arguments[1], arguments[2]);

    if (label) {
      if (!Array.isArray(label)) label = [label];
      label = label.map(l => `SET node:${l}`).join(' ');
    } else {
      label = '';
    }

    return this._getId(node)
      .then(id => {
        var props = _.omit(node, this.options.id);
        return this._run(`
          MATCH (node) WHERE id(node) = {id}
          SET node = {props} ${label}
          RETURN node
        `, { id, props });
      })
      .catch(() => {
        return this._run(`
          CREATE (node) 
          SET node = {node} ${label}
          RETURN node
        `, {node})
      })
      .then((result) => this._processResult(result, true))
  }

  _saveProperty(node, key, value) {
    return this._getId(node)
      .then(id => {
        return this._run(`
          MATCH (node) WHERE id(node) = {id}
          SET node.${key} = {value}
          RETURN node
        `, { id, value });
      })
      .then((result) => this._processResult(result, true))
  }

  delete(node, detach) {
    if (Array.isArray(node)) return this._aggregate(this.delete, node, 0, arguments);
    if (detach != null && typeof detach != 'boolean') return this.remove(node, detach);

    return this._getId(node)
      .then(id => {
        return this._run(`
          MATCH (node) WHERE id(node) = {id}
          ${detach ? 'detach' : ''} DELETE node
        `, { id })
      })
      .then(() => true);
  }

  remove(node, prop) {
    if (Array.isArray(node)) return this._aggregate(this.remove, node, 0, arguments);
    return this._getId(node)
      .then(id => {
        return this._run(`
          MATCH (node) WHERE id(node) = {id}
          REMOVE node.${prop}
          RETURN node
        `, { id })
      })
      .then((result) => this._processResult(result, true))
  }

  nodesWithLabel(label) {
    return this._run(`MATCH (n:${label}) RETURN n`)
      .then((result) => this._processResult(result));
  }

  readLabels(node) {
    return this._getId(node)
      .then(id => this._run(`MATCH (node) WHERE id(node) = {id} RETURN labels(node)`, { id }))
      .then((result) => {
        var rows = this._processResult(result)
        return rows[0] || [];
      })
  }

  readRel(rel) {
    if (Array.isArray(rel)) return this._aggregate(this.readRel, rel, 0, arguments);
    return this._getId(rel)
      .then(id => {
        return this._run(`
          MATCH (a)-[rel]-(b)
          WHERE id(rel) = {id}
          RETURN rel
        `, { id })
      })
      .then((result) => this._processResult(result, true))
  }

  relate() { return this.createRel.apply(this, arguments) }
  createRel(startNode, type, endNode, properties) {
    if (Array.isArray(startNode)) return this._aggregate(this.createRel, startNode, 0, arguments);
    if (Array.isArray(endNode)) return this._aggregate(this.createRel, endNode, 2, arguments);
    properties = properties || {};

    return Promise.all([ this._getId(startNode), this._getId(endNode) ])
      .then(ids => {
        return this._run(`
          MATCH (start), (end)
          WHERE id(start) = {startId} AND id(end) = {endId}
          CREATE (start)-[rel:\`${type}\`]->(end)
          SET rel = {properties}
          RETURN rel
        `, { startId: ids[0], endId: ids[1], properties });
      })
      .then((result) => this._processResult(result, true))
  }

  updateRel(rel) {
    if (Array.isArray(rel)) return this._aggregate(this.updateRel, rel, 0, arguments);
    if (arguments[2] != null) return this._updateRelProperty.apply(this, arguments);
    return this._getId(rel)
      .then(id => {
        return this._run(`
          MATCH (a)-[rel]-(b)
          WHERE id(rel) = {id}
          SET rel = {props}
          RETURN rel
        `, { id, props: rel.properties });
      })
      .then((result) => this._processResult(result, true))
  }

  _updateRelProperties(rel, key, value) {
    return this._getId(rel)
      .then(id => {
        return this._run(`
          MATCH (a)-[rel]-(b)
          WHERE id(rel) = {id}
          SET rel.\`${key}\` = {value}
          RETURN rel
        `, { id, value });
      })
      .then((result) => this._processResult(result, true))
  }

  createUniquenessConstraint(label, key) {
    return this._run(`CREATE CONSTRAINT ON (n:${label}) ASSERT n.${key} IS UNIQUE`)
      //compat. query returns nothing anyway
      .then(() => { return { type: 'UNIQUENESS', label: label, property_keys: [key] } });
  }

}