'use strict';

const C = require('./constants');

/** 16-bit one's-complement style checksum used by the ZK protocol. */
function checksum(buf) {
  let sum = 0;
  let i = 0;
  for (; i + 1 < buf.length; i += 2) {
    sum += buf.readUInt16LE(i);
    if (sum > C.USHRT_MAX) sum -= C.USHRT_MAX;
  }
  if (i < buf.length) sum += buf[buf.length - 1];
  while (sum > C.USHRT_MAX) sum -= C.USHRT_MAX;
  sum = ~sum;
  while (sum < 0) sum += C.USHRT_MAX;
  return sum;
}

/**
 * Builds a ZK packet: [cmd u16][checksum u16][session u16][reply u16][data].
 * The checksum is computed with the current reply id and the packet carries
 * reply id + 1, which is what the device firmware expects.
 */
function createPacket(command, sessionId, replyId, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(command, 0);
  head.writeUInt16LE(0, 2);
  head.writeUInt16LE(sessionId, 4);
  head.writeUInt16LE(replyId, 6);
  const sum = checksum(Buffer.concat([head, data]));

  let nextReply = replyId + 1;
  if (nextReply >= C.USHRT_MAX) nextReply -= C.USHRT_MAX;

  head.writeUInt16LE(sum, 2);
  head.writeUInt16LE(nextReply, 6);
  return Buffer.concat([head, data]);
}

/** Wraps a packet in the TCP envelope. */
function wrapTcp(packet) {
  const top = Buffer.alloc(8);
  top.writeUInt16LE(C.MACHINE_PREPARE_DATA_1, 0);
  top.writeUInt16LE(C.MACHINE_PREPARE_DATA_2, 2);
  top.writeUInt32LE(packet.length, 4);
  return Buffer.concat([top, packet]);
}

function parsePacket(buf) {
  if (buf.length < 8) return null;
  return {
    command: buf.readUInt16LE(0),
    checksum: buf.readUInt16LE(2),
    sessionId: buf.readUInt16LE(4),
    replyId: buf.readUInt16LE(6),
    data: buf.subarray(8),
  };
}

/** Decodes the packed 32-bit device time into a local "YYYY-MM-DD HH:MM:SS" string. */
function decodeTime(value) {
  let t = value;
  const second = t % 60; t = Math.floor(t / 60);
  const minute = t % 60; t = Math.floor(t / 60);
  const hour = t % 24; t = Math.floor(t / 24);
  const day = (t % 31) + 1; t = Math.floor(t / 31);
  const month = (t % 12) + 1; t = Math.floor(t / 12);
  const year = t + 2000;
  return formatParts(year, month, day, hour, minute, second);
}

/** Encodes a JS Date (local wall clock) into the packed 32-bit device time. */
function encodeTime(date) {
  return (
    ((date.getFullYear() % 100) * 12 * 31 + date.getMonth() * 31 + date.getDate() - 1) * 86400 +
    (date.getHours() * 60 + date.getMinutes()) * 60 +
    date.getSeconds()
  ) >>> 0;
}

/** Same packed format, from the UTC fields of a Date. */
function encodeTimeUTC(date) {
  return encodeTime(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()));
}

function formatParts(y, mo, d, h, mi, s) {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(s)}`;
}

/** Computes the CMD_AUTH key for a device protected with a comm password. */
function makeCommKey(password, sessionId, ticks = 50) {
  const key = Number(password) >>> 0;
  let k = 0;
  for (let i = 0; i < 32; i++) {
    k = ((k << 1) | ((key >>> i) & 1)) >>> 0;
  }
  k = (k + sessionId) >>> 0;

  const b = Buffer.alloc(4);
  b.writeUInt32LE(k, 0);
  const x = Buffer.from([b[0] ^ 0x5a, b[1] ^ 0x4b, b[2] ^ 0x53, b[3] ^ 0x4f]); // 'Z','K','S','O'
  // swap the two 16-bit halves
  const swapped = Buffer.from([x[2], x[3], x[0], x[1]]);
  const B = 0xff & ticks;
  return Buffer.from([swapped[0] ^ B, swapped[1] ^ B, B, swapped[3] ^ B]);
}

/** Reads a NUL-terminated string from a fixed-width field. */
function cstr(buf, encoding = 'latin1') {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString(encoding).trim();
}

function fixedField(value, size) {
  const out = Buffer.alloc(size);
  Buffer.from(String(value ?? ''), 'latin1').copy(out, 0, 0, size);
  return out;
}

module.exports = {
  checksum,
  createPacket,
  wrapTcp,
  parsePacket,
  decodeTime,
  encodeTime,
  encodeTimeUTC,
  formatParts,
  makeCommKey,
  cstr,
  fixedField,
};
