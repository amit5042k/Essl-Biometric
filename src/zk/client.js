'use strict';

const net = require('node:net');
const dgram = require('node:dgram');
const C = require('./constants');
const U = require('./utils');

class ZKError extends Error {}

/**
 * Client for the ZK binary protocol spoken by eSSL Classic and Orcus
 * terminals on port 4370 (TCP by default, UDP for older firmware).
 *
 *   const zk = new ZKClient({ ip: '192.168.1.201' });
 *   await zk.connect();
 *   const logs = await zk.getAttendance();
 *   await zk.disconnect();
 */
class ZKClient {
  constructor({ ip, port = 4370, timeout = 10000, password = 0, transport = 'tcp' } = {}) {
    if (!ip) throw new ZKError('Device IP is required');
    this.ip = ip;
    this.port = Number(port) || 4370;
    this.timeout = timeout;
    this.password = Number(password) || 0;
    this.transport = transport === 'udp' ? 'udp' : 'tcp';

    this.sessionId = 0;
    this.replyId = C.USHRT_MAX - 1;
    this.connected = false;
    this.userPacketSize = null;

    this._socket = null;
    this._rx = Buffer.alloc(0);
    this._frames = [];
    this._waiter = null;
    this._lock = Promise.resolve();
  }

  // ---------------------------------------------------------------- transport

  _openSocket() {
    return new Promise((resolve, reject) => {
      if (this.transport === 'udp') {
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg) => this._onFrame(msg));
        sock.on('error', (err) => this._onError(err));
        sock.connect(this.port, this.ip, (err) => (err ? reject(err) : resolve(sock)));
        this._socket = sock;
        return;
      }
      const sock = net.createConnection({ host: this.ip, port: this.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new ZKError(`Connection to ${this.ip}:${this.port} timed out`));
      }, this.timeout);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.setNoDelay(true);
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.on('data', (chunk) => this._onTcpData(chunk));
      sock.on('error', (err) => this._onError(err));
      sock.on('close', () => this._onError(new ZKError('Connection closed by device')));
      this._socket = sock;
    });
  }

  _onTcpData(chunk) {
    this._rx = Buffer.concat([this._rx, chunk]);
    while (this._rx.length >= 8) {
      if (
        this._rx.readUInt16LE(0) !== C.MACHINE_PREPARE_DATA_1 ||
        this._rx.readUInt16LE(2) !== C.MACHINE_PREPARE_DATA_2
      ) {
        // Lost sync: skip ahead to the next envelope header.
        const next = this._rx.indexOf(Buffer.from([0x50, 0x50, 0x82, 0x7d]), 1);
        this._rx = next === -1 ? Buffer.alloc(0) : this._rx.subarray(next);
        continue;
      }
      const len = this._rx.readUInt32LE(4);
      if (this._rx.length < 8 + len) break;
      const frame = this._rx.subarray(8, 8 + len);
      this._rx = this._rx.subarray(8 + len);
      this._onFrame(frame);
    }
  }

  _onFrame(buf) {
    const pkt = U.parsePacket(buf);
    if (!pkt) return;
    if (pkt.command === C.CMD_REG_EVENT) return; // real-time events are not used
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w.resolve(pkt);
    } else {
      this._frames.push(pkt);
    }
  }

  _onError(err) {
    this.connected = false;
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w.reject(err);
    }
  }

  _nextFrame(timeout = this.timeout) {
    if (this._frames.length) return Promise.resolve(this._frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiter = null;
        reject(new ZKError(`Timed out waiting for response from ${this.ip}`));
      }, timeout);
      this._waiter = {
        resolve: (p) => { clearTimeout(timer); resolve(p); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  _write(buf) {
    return new Promise((resolve, reject) => {
      if (!this._socket) return reject(new ZKError('Not connected'));
      if (this.transport === 'udp') {
        this._socket.send(buf, (err) => (err ? reject(err) : resolve()));
      } else {
        this._socket.write(U.wrapTcp(buf), (err) => (err ? reject(err) : resolve()));
      }
    });
  }

  /** Sends a command and returns the first response packet. */
  async _command(command, data = Buffer.alloc(0)) {
    this._frames.length = 0; // discard stale frames from a previous exchange
    const packet = U.createPacket(command, this.sessionId, this.replyId, data);
    await this._write(packet);
    const resp = await this._nextFrame();
    this.replyId = resp.replyId;
    return resp;
  }

  /** Serialises access so concurrent callers never interleave on the socket. */
  _exclusive(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  _expectOk(resp, what) {
    if (resp.command !== C.CMD_ACK_OK && resp.command !== C.CMD_ACK_DATA) {
      throw new ZKError(`${what} failed (device replied ${resp.command})`);
    }
    return resp;
  }

  // -------------------------------------------------------------- connection

  async connect() {
    await this._openSocket();
    this.sessionId = 0;
    this.replyId = C.USHRT_MAX - 1;
    let resp = await this._command(C.CMD_CONNECT);
    this.sessionId = resp.sessionId;
    if (resp.command === C.CMD_ACK_UNAUTH) {
      resp = await this._command(C.CMD_AUTH, U.makeCommKey(this.password, this.sessionId));
      if (resp.command !== C.CMD_ACK_OK) {
        await this._close();
        throw new ZKError('Device rejected the communication key (check Comm Key / password)');
      }
    } else if (resp.command !== C.CMD_ACK_OK) {
      await this._close();
      throw new ZKError(`Unexpected reply to CONNECT: ${resp.command}`);
    }
    this.connected = true;
    return this;
  }

  async disconnect() {
    if (this._socket && this.connected) {
      try {
        await this._command(C.CMD_EXIT);
      } catch {
        // ignore - we are closing anyway
      }
    }
    await this._close();
  }

  _close() {
    this.connected = false;
    const sock = this._socket;
    this._socket = null;
    this._rx = Buffer.alloc(0);
    if (!sock) return Promise.resolve();
    sock.removeAllListeners();
    sock.on('error', () => {});
    if (this.transport === 'udp') {
      return new Promise((r) => sock.close(() => r()));
    }
    sock.destroy();
    return Promise.resolve();
  }

  // ---------------------------------------------------------- buffered reads

  async _receiveChunk(resp) {
    if (resp.command === C.CMD_DATA) return resp.data;
    if (resp.command !== C.CMD_PREPARE_DATA) {
      throw new ZKError(`Unexpected reply while reading data: ${resp.command}`);
    }
    const size = resp.data.readUInt32LE(0);
    const parts = [];
    let got = 0;
    while (got < size) {
      const f = await this._nextFrame();
      if (f.command === C.CMD_DATA) {
        parts.push(f.data);
        got += f.data.length;
      } else if (f.command === C.CMD_ACK_OK) {
        return Buffer.concat(parts);
      } else {
        throw new ZKError(`Unexpected packet ${f.command} while receiving data`);
      }
    }
    // Device closes the transfer with an ACK_OK; consume it if it arrives.
    try {
      await this._nextFrame(Math.min(this.timeout, 2000));
    } catch {
      // some firmwares omit the trailing ACK
    }
    return Buffer.concat(parts).subarray(0, size);
  }

  async _readWithBuffer(command, fct = 0, ext = 0) {
    const req = Buffer.alloc(11);
    req.writeInt8(1, 0);
    req.writeInt16LE(command, 1);
    req.writeInt32LE(fct, 3);
    req.writeInt32LE(ext, 7);

    const resp = await this._command(C.CMD_DATA_WRRQ, req);
    if (resp.command === C.CMD_DATA || resp.command === C.CMD_PREPARE_DATA) {
      return this._receiveChunk(resp);
    }
    this._expectOk(resp, 'Buffered read');

    const size = resp.data.readUInt32LE(1);
    const maxChunk = this.transport === 'tcp' ? 0xffc0 : 16 * 1024;
    const parts = [];
    for (let start = 0; start < size; start += maxChunk) {
      const len = Math.min(maxChunk, size - start);
      const r = Buffer.alloc(8);
      r.writeInt32LE(start, 0);
      r.writeInt32LE(len, 4);
      const chunkResp = await this._command(C.CMD_READ_BUFFER, r);
      parts.push(await this._receiveChunk(chunkResp));
    }
    await this._command(C.CMD_FREE_DATA);
    return Buffer.concat(parts);
  }

  /** Uploads a large payload: PREPARE_DATA(size), then DATA chunks. */
  async _sendWithBuffer(buf) {
    await this._command(C.CMD_FREE_DATA);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(buf.length, 0);
    this._expectOk(await this._command(C.CMD_PREPARE_DATA, size), 'Prepare upload');
    for (let start = 0; start < buf.length; start += 1024) {
      this._expectOk(await this._command(C.CMD_DATA, buf.subarray(start, start + 1024)), 'Upload chunk');
    }
  }

  // ------------------------------------------------------------- device info

  getOption(name) {
    return this._exclusive(async () => {
      const resp = await this._command(C.CMD_OPTIONS_RRQ, Buffer.from(`${name}\0`, 'latin1'));
      if (resp.command !== C.CMD_ACK_OK) return null;
      const text = U.cstr(resp.data);
      const idx = text.indexOf('=');
      return idx === -1 ? text : text.slice(idx + 1);
    });
  }

  getVersion() {
    return this._exclusive(async () => {
      const resp = await this._command(C.CMD_GET_VERSION);
      return resp.command === C.CMD_ACK_OK ? U.cstr(resp.data) : null;
    });
  }

  getSizes() {
    return this._exclusive(async () => {
      const resp = this._expectOk(await this._command(C.CMD_GET_FREE_SIZES), 'Read sizes');
      const d = resp.data;
      if (d.length < 80) return null;
      const f = (i) => d.readInt32LE(i * 4);
      const sizes = {
        users: f(4),
        fingers: f(6),
        records: f(8),
        cards: f(12),
        fingersCapacity: f(14),
        usersCapacity: f(15),
        recordsCapacity: f(16),
      };
      if (d.length >= 92) {
        sizes.faces = d.readInt32LE(80);
        sizes.facesCapacity = d.readInt32LE(88);
      }
      return sizes;
    });
  }

  getTime() {
    return this._exclusive(async () => {
      const resp = this._expectOk(await this._command(C.CMD_GET_TIME), 'Get time');
      return U.decodeTime(resp.data.readUInt32LE(0));
    });
  }

  setTime(date = new Date()) {
    return this._exclusive(async () => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(U.encodeTime(date), 0);
      this._expectOk(await this._command(C.CMD_SET_TIME, b), 'Set time');
      return true;
    });
  }

  async getInfo() {
    const [serialNumber, deviceName, platform, firmware, time, sizes] = [
      await this.getOption('~SerialNumber'),
      await this.getOption('~DeviceName'),
      await this.getOption('~Platform'),
      await this.getVersion(),
      await this.getTime(),
      await this.getSizes(),
    ];
    return { serialNumber, deviceName, platform, firmware, time, sizes };
  }

  enableDevice() {
    return this._exclusive(async () => {
      this._expectOk(await this._command(C.CMD_ENABLEDEVICE), 'Enable device');
    });
  }

  disableDevice() {
    return this._exclusive(async () => {
      this._expectOk(await this._command(C.CMD_DISABLEDEVICE), 'Disable device');
    });
  }

  restart() {
    return this._exclusive(async () => {
      await this._command(C.CMD_RESTART);
      await this._close();
    });
  }

  // ------------------------------------------------------------------- users

  async getUsers() {
    const sizes = await this.getSizes();
    return this._exclusive(async () => {
      const raw = await this._readWithBuffer(C.CMD_USERTEMP_RRQ, C.FCT_USER);
      if (raw.length < 4) return [];
      const total = raw.readUInt32LE(0);
      const data = raw.subarray(4, 4 + total);

      let size = sizes && sizes.users > 0 ? total / sizes.users : null;
      if (size !== 28 && size !== 72) size = total % 72 === 0 ? 72 : 28;
      this.userPacketSize = size;

      const users = [];
      for (let off = 0; off + size <= data.length; off += size) {
        const r = data.subarray(off, off + size);
        if (size === 28) {
          users.push({
            uid: r.readUInt16LE(0),
            privilege: r[2],
            password: U.cstr(r.subarray(3, 8)),
            name: U.cstr(r.subarray(8, 16)),
            card: r.readUInt32LE(16),
            groupId: String(r[21]),
            userId: String(r.readUInt32LE(24)),
          });
        } else {
          users.push({
            uid: r.readUInt16LE(0),
            privilege: r[2],
            password: U.cstr(r.subarray(3, 11)),
            name: U.cstr(r.subarray(11, 35), 'utf8'),
            card: r.readUInt32LE(35),
            groupId: U.cstr(r.subarray(40, 47)),
            userId: U.cstr(r.subarray(48, 72)),
          });
        }
      }
      return users.map((u) => ({ ...u, name: u.name || `User ${u.userId}` }));
    });
  }

  /**
   * Creates or updates a user on the device.
   * @param {{userId:string, name?:string, password?:string, privilege?:number, card?:number, uid?:number}} user
   */
  async setUser(user) {
    const userId = String(user.userId || '').trim();
    if (!userId) throw new ZKError('userId is required');
    const existing = await this.getUsers();
    let uid = user.uid;
    if (!uid) {
      const match = existing.find((u) => u.userId === userId);
      uid = match ? match.uid : existing.reduce((m, u) => Math.max(m, u.uid), 0) + 1;
    }
    const size = this.userPacketSize || 72;
    const privilege = Number(user.privilege) || 0;
    const card = Number(user.card) || 0;
    const name = user.name || '';
    const password = user.password || '';

    let buf;
    if (size === 28) {
      if (!/^\d+$/.test(userId)) throw new ZKError('This device only supports numeric user IDs');
      buf = Buffer.alloc(28);
      buf.writeUInt16LE(uid, 0);
      buf[2] = privilege;
      U.fixedField(password, 5).copy(buf, 3);
      U.fixedField(name, 8).copy(buf, 8);
      buf.writeUInt32LE(card >>> 0, 16);
      buf[21] = 1;
      buf.writeUInt16LE(0, 22);
      buf.writeUInt32LE(Number(userId) >>> 0, 24);
    } else {
      buf = Buffer.alloc(72);
      buf.writeUInt16LE(uid, 0);
      buf[2] = privilege;
      U.fixedField(password, 8).copy(buf, 3);
      Buffer.from(name, 'utf8').copy(buf, 11, 0, 24);
      buf.writeUInt32LE(card >>> 0, 35);
      U.fixedField('1', 7).copy(buf, 40);
      U.fixedField(userId, 24).copy(buf, 48);
    }

    return this._exclusive(async () => {
      this._expectOk(await this._command(C.CMD_USER_WRQ, buf), 'Write user');
      await this._command(C.CMD_REFRESHDATA);
      return { uid, userId };
    });
  }

  async deleteUser(userId) {
    const users = await this.getUsers();
    const match = users.find((u) => u.userId === String(userId));
    if (!match) return false;
    return this._exclusive(async () => {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(match.uid, 0);
      this._expectOk(await this._command(C.CMD_DELETE_USER, b), 'Delete user');
      await this._command(C.CMD_REFRESHDATA);
      return true;
    });
  }

  // ------------------------------------------------------- finger templates

  /**
   * Reads every fingerprint template stored on the device:
   * [{ uid, fid, valid, template: Buffer }]
   */
  getTemplates() {
    return this._exclusive(async () => {
      const raw = await this._readWithBuffer(C.CMD_DB_RRQ, C.FCT_FINGERTMP);
      if (raw.length < 4) return [];
      const total = raw.readUInt32LE(0);
      const data = raw.subarray(4, 4 + total);
      const out = [];
      let off = 0;
      while (off + 6 <= data.length) {
        const size = data.readUInt16LE(off);
        if (size < 6 || off + size > data.length) break;
        out.push({
          uid: data.readUInt16LE(off + 2),
          fid: data.readInt8(off + 4),
          valid: data.readInt8(off + 5),
          template: Buffer.from(data.subarray(off + 6, off + size)),
        });
        off += size;
      }
      return out;
    });
  }

  /**
   * Writes users together with their fingerprint templates in one batch.
   * Call getUsers() first so the device's user record format is known.
   * @param {{user:{uid:number,userId:string,name?:string,privilege?:number,password?:string,card?:number},
   *          fingers:{fid:number,valid?:number,template:Buffer}[]}[]} entries
   */
  saveUserTemplates(entries) {
    const size = this.userPacketSize || 72;
    const users = [];
    const table = [];
    const fingers = [];
    let offset = 0;
    for (const { user, fingers: list } of entries) {
      users.push(size === 28 ? packUser29(user) : packUser73(user));
      for (const f of list) {
        const t = Buffer.alloc(8);
        t.writeInt8(2, 0);
        t.writeUInt16LE(user.uid, 1);
        t.writeUInt8(0x10 + f.fid, 3);
        t.writeUInt32LE(offset, 4);
        table.push(t);
        const rec = Buffer.alloc(2 + f.template.length);
        rec.writeUInt16LE(f.template.length, 0);
        f.template.copy(rec, 2);
        fingers.push(rec);
        offset += rec.length;
      }
    }
    const upack = Buffer.concat(users);
    const tpack = Buffer.concat(table);
    const fpack = Buffer.concat(fingers);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(upack.length, 0);
    head.writeUInt32LE(tpack.length, 4);
    head.writeUInt32LE(fpack.length, 8);

    return this._exclusive(async () => {
      await this._sendWithBuffer(Buffer.concat([head, upack, tpack, fpack]));
      const args = Buffer.alloc(8);
      args.writeUInt32LE(12, 0);
      args.writeUInt16LE(0, 4);
      args.writeUInt16LE(8, 6);
      this._expectOk(await this._command(C.CMD_SAVE_USERTEMPS, args), 'Save templates');
      await this._command(C.CMD_REFRESHDATA);
      return true;
    });
  }

  // -------------------------------------------------------------- attendance

  /**
   * Returns every attendance log stored on the device:
   * [{ userId, timestamp: 'YYYY-MM-DD HH:MM:SS', verifyType, punchState }]
   */
  async getAttendance() {
    const sizes = await this.getSizes();
    if (sizes && sizes.records === 0) return [];

    let uidMap = null;
    const raw = await this._exclusive(() => this._readWithBuffer(C.CMD_ATTLOG_RRQ));
    if (raw.length < 4) return [];
    const total = raw.readUInt32LE(0);
    const data = raw.subarray(4, 4 + total);

    let size = sizes && sizes.records > 0 ? total / sizes.records : null;
    if (![8, 16, 40].includes(size)) {
      size = total % 40 === 0 ? 40 : total % 16 === 0 ? 16 : 8;
    }
    if (size === 8) {
      // Very old firmware only stores the internal uid - map it to the user id.
      uidMap = new Map((await this.getUsers()).map((u) => [u.uid, u.userId]));
    }

    const logs = [];
    for (let off = 0; off + size <= data.length; off += size) {
      const r = data.subarray(off, off + size);
      if (size === 8) {
        const uid = r.readUInt16LE(0);
        logs.push({
          userId: uidMap.get(uid) || String(uid),
          verifyType: r[2],
          timestamp: U.decodeTime(r.readUInt32LE(3)),
          punchState: r[7],
        });
      } else if (size === 16) {
        logs.push({
          userId: String(r.readUInt32LE(0)),
          timestamp: U.decodeTime(r.readUInt32LE(4)),
          verifyType: r[8],
          punchState: r[9],
        });
      } else {
        logs.push({
          userId: U.cstr(r.subarray(2, 26)) || String(r.readUInt16LE(0)),
          verifyType: r[26],
          timestamp: U.decodeTime(r.readUInt32LE(27)),
          punchState: r[31],
        });
      }
    }
    return logs;
  }

  clearAttendance() {
    return this._exclusive(async () => {
      this._expectOk(await this._command(C.CMD_CLEAR_ATTLOG), 'Clear attendance');
      return true;
    });
  }
}

/** 73-byte user record used inside template uploads (newer firmware). */
function packUser73(u) {
  const b = Buffer.alloc(73);
  b[0] = 2;
  b.writeUInt16LE(u.uid, 1);
  b[3] = Number(u.privilege) || 0;
  U.fixedField(u.password || '', 8).copy(b, 4);
  Buffer.from(u.name || '', 'utf8').copy(b, 12, 0, 24);
  b.writeUInt32LE(Number(u.card) >>> 0, 36);
  b[40] = 1;
  U.fixedField(u.groupId || '1', 7).copy(b, 41);
  U.fixedField(u.userId, 24).copy(b, 49);
  return b;
}

/** 29-byte user record for older firmware (numeric user ids only). */
function packUser29(u) {
  if (!/^\d+$/.test(String(u.userId))) throw new ZKError('This device only supports numeric user IDs');
  const b = Buffer.alloc(29);
  b[0] = 2;
  b.writeUInt16LE(u.uid, 1);
  b[3] = Number(u.privilege) || 0;
  U.fixedField(u.password || '', 5).copy(b, 4);
  U.fixedField(u.name || '', 8).copy(b, 9);
  b.writeUInt32LE(Number(u.card) >>> 0, 17);
  b[22] = 1;
  b.writeInt16LE(0, 23);
  b.writeUInt32LE(Number(u.userId) >>> 0, 25);
  return b;
}

module.exports = { ZKClient, ZKError };
