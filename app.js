/**
 * Created by xianda on 15/10/5.
 */
'use strict';

var crypto = require("crypto");
var dgram = require("dgram");
var timers = require("timers");
var bencode = require("bencode");
var randomstring = require("randomstring");
var _ = require('lodash');

const BOOTSTRAP_NODES = [
  ["router.bittorrent.com", 6881],
  ["dht.transmissionbt.com", 6881],
  ["router.utorrent.com", 6881]
];

const TID_LENGTH = 4;
const MAX_QUEUE_LENGTH =2000;

var running = false;

function randomID() {
  //return crypto.createHash("sha1")
  //  .update(crypto.randomBytes(20))
  //  .digest("hex");
  return new Buffer(
    crypto.createHash("sha1")
      .update(crypto.randomBytes(20))
      .digest("hex"),
    "hex"
  );
}

//function decodeNodes(data) {
//  var nodes = [];
//  var i = 0;
//  while(i < data.length) {
//    nodes.push({
//      nid: data.slice(i, i + 20),
//      host: data[i + 20] + "." + data[i + 21] + "." + data[i + 22] + "." + data[i + 23],
//      port: data.readUInt16BE(i + 24)
//    });
//    i = i + 26;
//  }
//  return nodes;
//}

function decodeNodes(data) {
  var nodes = [];
  for (var i = 0; i + 26 <= data.length; i += 26) {
    nodes.push({
      id: data.slice(i, i + 20).toString('hex'),
      nid: data.slice(i, i + 20),
      host: data[i + 20] + "." + data[i + 21] + "." + data[i + 22] + "." + data[i + 23],
      port: data.readUInt16BE(i + 24)
    });
  }
  return _.uniq(nodes, 'id');
}

function getNeighbor(target) {
  return  Buffer.concat([target.slice(0, 10), randomID().slice(10)]);
}

function DHT(port) {
  this.ktable = new KTable();
  this.udp = dgram.createSocket('udp4');
  this.udp.bind(port);
  this.nid = randomID();
}


DHT.prototype.log = function(infohash, rinfo) {
  console.log("%s from %s:%s", infohash.toString("hex"), rinfo.address, rinfo.port);
};

DHT.prototype.joinDHT = function() {
  let self = this;
  BOOTSTRAP_NODES.forEach(function(node) {
    let host = node[0];
    let port = node[1];
    let nid = randomID();
    self.sendFindNode({host: host, port: port}, nid);
  });
};

DHT.prototype.resolveMsg = function(msg, rinfo) {
  msg = bencode.decode(msg);
  var y = msg.y.toString();
  switch (y) {
    case 'r': 
      var nodes = msg.r.nodes;
      if (nodes) {
        this.processFindNodeReceived(nodes);
      }
      break;
    case 'q':
      console.log('enter')
      let q = msg.q.toString();
      console.log(q)
      if (q === 'ping') {
        this.processPing(msg, rinfo);
      }
      if (q === 'find_node') {
        this.processFindNode(msg, rinfo)
      }
      if (q === 'get_peers') {
        this.processGetPeers(msg, rinfo);
      }
      if (q === 'announce_peer') {
        this.processAnnouncePeer(msg, rinfo);
      }
  }
};
DHT.prototype.processFindNodeReceived = function(nodes) {
  var self = this;
  nodes = decodeNodes(nodes);
  nodes.forEach(function(node) {
    if (node.port < 1 || node.port > 65535) {
      return;
    }
    self.ktable.push(node);
  });
};

DHT.prototype.processFindNode = function(msg, rinfo) {
  this.playDead(msg.t, rinfo);
};

DHT.prototype.playDead = function(tid, rinfo) {
  var msg = {
    t: tid,
    y: "e",
    e: [202, "Server Error"]
  };
  this.sendKRPC(msg, rinfo);
};

DHT.prototype.processPing = function(msg, rinfo) {
  var message = {
    t: msg.t,
    y: 'r',
    r: {
      'id': randomID()
    }
  };
  this.sendKRPC(message, rinfo);
};


DHT.prototype.processGetPeers = function(msg, rinfo) {
  var info_hash = msg.a.info_hash;
  this.log(info_hash, rinfo);
  var message = {
    t: msg.t,
    y: 'r',
    r: {
      'id': randomID(),
      'nodes': '',
      'token': randomstring.generate(TID_LENGTH)
    }
  };
  this.sendKRPC(message, rinfo);
};

DHT.prototype.processAnnouncePeer= function(msg, rinfo) {
  var info_hash = msg.a.info_hash;
  this.log(info_hash, rinfo);
  var message = {
    t: msg.t,
    y: 'r',
    r: {
      'id': randomID()
    }
  };
  this.sendKRPC(message, rinfo);
};
DHT.prototype.sendFindNode = function(addr, nid) {
  var msg = {
    t: randomstring.generate(TID_LENGTH),
    y: "q",
    q: "find_node",
    a: {
      id: this.nid,
      target: randomID()
    }
  };
  this.sendKRPC(msg, addr);
};

DHT.prototype.sendKRPC = function(msg, addr) {
  var buf = bencode.encode(msg);
  this.udp.send(buf, 0, buf.length, addr.port, addr.host, function(err) {
    if (err) {
      //throw err;
    }
  });
};
DHT.prototype.wander = function() {
  running = true;
  var self = this;
  var num = this.ktable.nodes.length;
  while(num > 0) {
    num--;
    let node = this.ktable.nodes.shift();
    self.sendFindNode({host: node.host, port: node.port}, node.nid);
  }
  if (num === 0) {
    running = false;
  }
};

DHT.prototype.start = function() {
  let self = this;
  this.joinDHT();
  this.udp.on('message', function(msg, rinfo) {
    self.resolveMsg(msg, rinfo);
  });
  this.udp.on('error', function(err) {
    throw err
  });
  timers.setInterval(function() {self.joinDHT()}, 10000);
  timers.setInterval(function() {
    if (running) {
      return;
    }
    self.wander()
  }, 2000);
};

function KTable() {
  this.nodes = [];
}

KTable.prototype.push = function(node) {
  if (this.nodes.length > MAX_QUEUE_LENGTH) {
    return;
  }
  this.nodes.push(node);
};

new DHT(6881).start();