'use strict';

const { normalizeTimestamp } = require('../util/time');

/** ATTLOG lines: PIN \t TIME \t STATUS \t VERIFY \t WORKCODE \t ... */
function parseAttLog(body) {
  const logs = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    const timestamp = normalizeTimestamp(f[1]);
    if (!f[0] || !timestamp) continue;
    logs.push({
      userId: f[0].trim(),
      timestamp,
      punchState: f[2] !== undefined && f[2] !== '' ? Number(f[2]) : null,
      verifyType: f[3] !== undefined && f[3] !== '' ? Number(f[3]) : null,
      workCode: f[4] || null,
    });
  }
  return logs;
}

/** "KEY=VAL\tKEY2=VAL2" -> { KEY: 'VAL', KEY2: 'VAL2' } */
function parseKeyValues(text, sep = '\t') {
  const out = {};
  for (const part of String(text || '').split(sep)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * OPERLOG / USERINFO uploads. Returns users found in "USER PIN=..." lines and
 * the number of lines processed.
 */
function parseOperLog(body) {
  const users = [];
  let count = 0;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    count += 1;
    let rest = null;
    if (line.startsWith('USER ')) rest = line.slice(5);
    else if (/^PIN=/.test(line)) rest = line;
    if (rest === null) continue;
    const kv = parseKeyValues(rest);
    if (kv.PIN) users.push({ userId: kv.PIN, name: kv.Name || '', card: kv.Card ? kv.Card.replace(/[^\d]/g, '') : '' });
  }
  return { users, count };
}

/** devicecmd replies: "ID=12&Return=0&CMD=DATA" (one per line). */
function parseCommandReplies(body) {
  return String(body || '')
    .split(/\r?\n/)
    .filter((l) => l.includes('ID='))
    .map((l) => {
      const kv = parseKeyValues(l, '&');
      return { id: Number(kv.ID), returnCode: Number(kv.Return), cmd: kv.CMD || '' };
    })
    .filter((r) => Number.isFinite(r.id));
}

/** "~DeviceName=X,FWVersion=Y,..." or "INFO=Ver 8.0,12,3,456,192.168.1.5" */
function parseDeviceInfo(text) {
  const kv = parseKeyValues(String(text || '').replace(/\r?\n/g, ','), ',');
  const info = {};
  for (const [k, v] of Object.entries(kv)) info[k.replace(/^~/, '')] = v;
  return info;
}

module.exports = { parseAttLog, parseOperLog, parseCommandReplies, parseKeyValues, parseDeviceInfo };
