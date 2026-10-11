'use strict';

const { normalizeTimestamp } = require('../util/time');

/**
 * Stores attendance logs and creates placeholder employees for unknown codes.
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} deviceId
 * @param {{userId:string,timestamp:string,punchState?:number,verifyType?:number}[]} logs
 * @returns {number} number of new punches
 */
function savePunches(db, deviceId, logs, source = 'device') {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO punches (employee_code, punch_time, device_id, punch_state, verify_type, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const ensureEmp = db.prepare(
    `INSERT OR IGNORE INTO employees (code, name) VALUES (?, ?)`
  );
  const run = db.transaction((rows) => {
    let added = 0;
    for (const l of rows) {
      const code = String(l.userId ?? '').trim();
      const ts = normalizeTimestamp(l.timestamp);
      if (!code || !ts) continue;
      ensureEmp.run(code, `Employee ${code}`);
      added += insert.run(code, ts, deviceId, l.punchState ?? null, l.verifyType ?? null, source).changes;
    }
    return added;
  });
  return run(logs);
}

/**
 * Imports users enrolled on a device into the employee master. Existing
 * employees keep their details; placeholder names get replaced.
 */
function importDeviceUsers(db, users) {
  const insert = db.prepare(`INSERT OR IGNORE INTO employees (code, name, card_no) VALUES (?, ?, ?)`);
  const rename = db.prepare(
    `UPDATE employees SET name = ? WHERE code = ? AND name = 'Employee ' || code AND ? <> ''`
  );
  const run = db.transaction((rows) => {
    let created = 0;
    for (const u of rows) {
      const code = String(u.userId ?? '').trim();
      if (!code) continue;
      const name = String(u.name || '').trim();
      created += insert.run(code, name || `Employee ${code}`, u.card ? String(u.card) : null).changes;
      rename.run(name, code, name);
    }
    return created;
  });
  return run(users);
}

module.exports = { savePunches, importDeviceUsers };
