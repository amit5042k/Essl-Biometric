#!/usr/bin/env node
'use strict';

/**
 * A small eSSL/ZK terminal emulator speaking the TCP protocol on port 4370.
 * Useful for trying the app without hardware and used by the test-suite.
 *
 *   node tools/zk-simulator.js [port] [commKey]
 */
const net = require('node:net');
const C = require('../src/zk/constants');
const U = require('../src/zk/utils');

function reply(command, req, data = Buffer.alloc(0), sessionId = req.sessionId) {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(command, 0);
  head.writeUInt16LE(sessionId, 4);
  head.writeUInt16LE(req.replyId, 6);
  const pkt = Buffer.concat([head, data]);
  pkt.writeUInt16LE(U.checksum(pkt), 2);
  return U.wrapTcp(pkt);
}

function encodeUser(u) {
  const b = Buffer.alloc(72);
  b.writeUInt16LE(u.uid, 0);
  b[2] = u.privilege || 0;
  U.fixedField(u.password || '', 8).copy(b, 3);
  Buffer.from(u.name || '', 'utf8').copy(b, 11, 0, 24);
  b.writeUInt32LE(u.card || 0, 35);
  U.fixedField(u.groupId || '1', 7).copy(b, 40);
  U.fixedField(u.userId, 24).copy(b, 48);
  return b;
}

function decodeUser(b) {
  return {
    uid: b.readUInt16LE(0),
    privilege: b[2],
    password: U.cstr(b.subarray(3, 11)),
    name: U.cstr(b.subarray(11, 35), 'utf8'),
    card: b.readUInt32LE(35),
    groupId: U.cstr(b.subarray(40, 47)),
    userId: U.cstr(b.subarray(48, 72)),
  };
}

function encodeLog(l, uid) {
  const b = Buffer.alloc(40);
  b.writeUInt16LE(uid, 0);
  U.fixedField(l.userId, 24).copy(b, 2);
  b[26] = l.verifyType ?? 1;
  const [d, t] = l.timestamp.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  b.writeUInt32LE(U.encodeTime(new Date(y, mo - 1, da, h, mi, s)), 27);
  b[31] = l.punchState ?? 0;
  return b;
}

function createSimulator({
  serialNumber = 'SIMULATOR0001',
  commKey = 0,
  users = [],
  logs = [],
  templates = [],
  chunkSize = 300,
} = {}) {
  const state = {
    users: users.map((u, i) => ({ uid: i + 1, ...u })),
    logs: [...logs],
    // [{ uid, fid, valid, template: Buffer }]
    templates: templates.map((t) => ({ valid: 1, ...t })),
    time: null,
  };

  const server = net.createServer((sock) => {
    let rx = Buffer.alloc(0);
    let session = 0;
    let authed = !commKey;
    let pending = null; // buffer prepared by DATA_WRRQ
    let incoming = null; // upload started with PREPARE_DATA

    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      while (rx.length >= 8) {
        const len = rx.readUInt32LE(4);
        if (rx.length < 8 + len) break;
        const req = U.parsePacket(rx.subarray(8, 8 + len));
        rx = rx.subarray(8 + len);
        handle(req);
      }
    });

    function sizes() {
      const b = Buffer.alloc(92);
      b.writeInt32LE(state.users.length, 4 * 4);
      b.writeInt32LE(state.logs.length, 8 * 4);
      b.writeInt32LE(3000, 15 * 4);
      b.writeInt32LE(100000, 16 * 4);
      return b;
    }

    function buildBuffer(cmd) {
      let body;
      if (cmd === C.CMD_DB_RRQ) {
        body = Buffer.concat(state.templates.map((t) => {
          const r = Buffer.alloc(6 + t.template.length);
          r.writeUInt16LE(r.length, 0);
          r.writeUInt16LE(t.uid, 2);
          r.writeInt8(t.fid, 4);
          r.writeInt8(t.valid, 5);
          t.template.copy(r, 6);
          return r;
        }));
      } else if (cmd === C.CMD_ATTLOG_RRQ) {
        const uidOf = new Map(state.users.map((u) => [u.userId, u.uid]));
        body = Buffer.concat(state.logs.map((l) => encodeLog(l, uidOf.get(l.userId) || 0)));
      } else {
        body = Buffer.concat(state.users.map(encodeUser));
      }
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      return Buffer.concat([head, body]);
    }

    // Mirrors the firmware: [sizes][73-byte users][8-byte index][len+template...]
    function saveUserTemplates(buf) {
      const ulen = buf.readUInt32LE(0);
      const tlen = buf.readUInt32LE(4);
      const users = buf.subarray(12, 12 + ulen);
      const table = buf.subarray(12 + ulen, 12 + ulen + tlen);
      const fpack = buf.subarray(12 + ulen + tlen);
      for (let off = 0; off + 73 <= users.length; off += 73) {
        const r = users.subarray(off, off + 73);
        const u = {
          uid: r.readUInt16LE(1),
          privilege: r[3],
          password: U.cstr(r.subarray(4, 12)),
          name: U.cstr(r.subarray(12, 36), 'utf8'),
          card: r.readUInt32LE(36),
          groupId: U.cstr(r.subarray(41, 48)),
          userId: U.cstr(r.subarray(49, 73)),
        };
        state.users = state.users.filter((x) => x.uid !== u.uid);
        state.users.push(u);
      }
      for (let off = 0; off + 8 <= table.length; off += 8) {
        const uid = table.readUInt16LE(off + 1);
        const fid = table[off + 3] - 0x10;
        const at = table.readUInt32LE(off + 4);
        const len = fpack.readUInt16LE(at);
        const template = Buffer.from(fpack.subarray(at + 2, at + 2 + len));
        state.templates = state.templates.filter((t) => !(t.uid === uid && t.fid === fid));
        state.templates.push({ uid, fid, valid: 1, template });
      }
    }

    function handle(req) {
      const send = (cmd, data) => sock.write(reply(cmd, req, data, session));
      if (req.command === C.CMD_CONNECT) {
        session = 0x1234;
        return send(commKey ? C.CMD_ACK_UNAUTH : C.CMD_ACK_OK);
      }
      if (req.command === C.CMD_AUTH) {
        const expected = U.makeCommKey(commKey, session);
        authed = expected.equals(req.data);
        return send(authed ? C.CMD_ACK_OK : C.CMD_ACK_UNAUTH);
      }
      if (!authed) return send(C.CMD_ACK_UNAUTH);

      switch (req.command) {
        case C.CMD_EXIT:
          send(C.CMD_ACK_OK);
          return sock.end();
        case C.CMD_OPTIONS_RRQ: {
          const key = U.cstr(req.data);
          const values = {
            '~SerialNumber': serialNumber,
            '~DeviceName': 'eSSL Simulator',
            '~Platform': 'ZMM220_TFT',
          };
          return send(C.CMD_ACK_OK, Buffer.from(`${key}=${values[key] ?? ''}\0`));
        }
        case C.CMD_GET_VERSION:
          return send(C.CMD_ACK_OK, Buffer.from('Ver 6.60 Sim\0'));
        case C.CMD_GET_FREE_SIZES:
          return send(C.CMD_ACK_OK, sizes());
        case C.CMD_GET_TIME: {
          const b = Buffer.alloc(4);
          b.writeUInt32LE(state.time ?? U.encodeTime(new Date()), 0);
          return send(C.CMD_ACK_OK, b);
        }
        case C.CMD_SET_TIME:
          state.time = req.data.readUInt32LE(0);
          return send(C.CMD_ACK_OK);
        case C.CMD_DATA_WRRQ: {
          const cmd = req.data.readInt16LE(1);
          const buf = buildBuffer(cmd);
          if (buf.length < 256) return send(C.CMD_DATA, buf); // small payloads come inline
          pending = buf;
          const d = Buffer.alloc(9);
          d.writeUInt32LE(buf.length, 1);
          return send(C.CMD_ACK_OK, d);
        }
        case C.CMD_READ_BUFFER: {
          const start = req.data.readInt32LE(0);
          const size = req.data.readInt32LE(4);
          const part = pending.subarray(start, start + size);
          const p = Buffer.alloc(8);
          p.writeUInt32LE(part.length, 0);
          send(C.CMD_PREPARE_DATA, p);
          for (let off = 0; off < part.length; off += chunkSize) {
            send(C.CMD_DATA, part.subarray(off, off + chunkSize));
          }
          return send(C.CMD_ACK_OK);
        }
        case C.CMD_FREE_DATA:
          pending = null;
          return send(C.CMD_ACK_OK);
        case C.CMD_PREPARE_DATA:
          incoming = { size: req.data.readUInt32LE(0), parts: [] };
          return send(C.CMD_ACK_OK);
        case C.CMD_DATA:
          if (!incoming) return send(C.CMD_ACK_ERROR);
          incoming.parts.push(Buffer.from(req.data));
          return send(C.CMD_ACK_OK);
        case C.CMD_SAVE_USERTEMPS: {
          const buf = Buffer.concat(incoming ? incoming.parts : []);
          incoming = null;
          if (buf.length < 12) return send(C.CMD_ACK_ERROR);
          saveUserTemplates(buf);
          return send(C.CMD_ACK_OK);
        }
        case C.CMD_USER_WRQ: {
          const u = decodeUser(req.data);
          state.users = state.users.filter((x) => x.uid !== u.uid);
          state.users.push(u);
          return send(C.CMD_ACK_OK);
        }
        case C.CMD_DELETE_USER: {
          const uid = req.data.readUInt16LE(0);
          state.users = state.users.filter((x) => x.uid !== uid);
          return send(C.CMD_ACK_OK);
        }
        case C.CMD_CLEAR_ATTLOG:
          state.logs = [];
          return send(C.CMD_ACK_OK);
        default:
          return send(C.CMD_ACK_OK);
      }
    }
  });

  return {
    state,
    server,
    listen(port = 4370, host = '0.0.0.0') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createSimulator };

if (require.main === module) {
  const port = Number(process.argv[2]) || 4370;
  const commKey = Number(process.argv[3]) || 0;
  const today = new Date();
  const day = (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  const users = [
    { userId: '101', name: 'Asha Verma' },
    { userId: '102', name: 'Rahul Singh' },
    { userId: '103', name: 'Priya Nair' },
  ];
  const logs = [];
  for (let i = 0; i < 7; i++) {
    logs.push({ userId: '101', timestamp: `${day(i)} 09:02:11`, punchState: 0 });
    logs.push({ userId: '101', timestamp: `${day(i)} 18:05:40`, punchState: 1 });
    logs.push({ userId: '102', timestamp: `${day(i)} 09:41:03`, punchState: 0 });
    logs.push({ userId: '102', timestamp: `${day(i)} 14:00:00`, punchState: 1 });
    if (i % 2) logs.push({ userId: '103', timestamp: `${day(i)} 08:55:00`, punchState: 0 });
  }
  // Fake fingerprint templates (random bytes) so biometric copying can be tried.
  const fake = (seed) => Buffer.from(Array.from({ length: 800 }, (_, i) => (i * 31 + seed * 17) & 0xff));
  const templates = [
    { uid: 1, fid: 0, template: fake(1) }, { uid: 1, fid: 1, template: fake(2) },
    { uid: 2, fid: 0, template: fake(3) },
    { uid: 3, fid: 5, template: fake(4) }, { uid: 3, fid: 6, template: fake(5) },
  ];
  const sim = createSimulator({ users, logs, commKey, templates, serialNumber: process.env.SIM_SERIAL || 'SIMULATOR0001' });
  sim.listen(port).then((p) => console.log(`ZK simulator listening on tcp/${p} (comm key ${commKey})`));
}
