'use strict';

const T = require('../util/time');

// BIODATA "Type" values used by ZKTeco/eSSL push firmware.
const BIO_TYPES = { 1: 'finger', 2: 'face', 8: 'palm', 9: 'face' };

const LABEL = { finger: 'fingerprint', face: 'face', palm: 'palm', other: 'other' };

/** "10", "10.0", "ZKFinger10" -> 10; empty/unknown -> null. */
function majorVersion(v) {
  const m = String(v ?? '').match(/\d+/);
  return m && Number(m[0]) > 0 ? Number(m[0]) : null;
}

/** Algorithm version a device uses for a template category, if it reported one. */
function deviceVersion(device, cat) {
  if (!device) return null;
  if (cat === 'finger') return majorVersion(device.fp_version);
  if (cat === 'face') return majorVersion(device.face_version);
  return null;
}

/** Which user-facing category a stored template belongs to. */
function category(rec) {
  if (rec.kind === 'finger') return 'finger';
  if (rec.kind === 'face') return 'face';
  return BIO_TYPES[rec.bio_type] || 'other';
}

/**
 * Stores templates; the newest copy of each (employee, kind, type, index) wins.
 * @param {{code:string, kind:string, bioType?:number, idx:number, valid?:number, template:string, extra?:object}[]} records
 */
function saveTemplates(db, deviceId, records) {
  const ensureEmp = db.prepare(`INSERT OR IGNORE INTO employees (code, name) VALUES (?, ?)`);
  const upsert = db.prepare(
    `INSERT INTO biometrics (employee_code, kind, bio_type, idx, valid, template, extra, source_device_id, updated_at)
     VALUES (@code, @kind, @bioType, @idx, @valid, @template, @extra, @deviceId, @now)
     ON CONFLICT (employee_code, kind, bio_type, idx) DO UPDATE SET
       valid = excluded.valid, template = excluded.template, extra = excluded.extra,
       source_device_id = excluded.source_device_id, updated_at = excluded.updated_at`
  );
  const now = T.nowLocal();
  return db.transaction((rows) => {
    let n = 0;
    for (const r of rows) {
      if (!r.code || !r.template) continue;
      ensureEmp.run(r.code, `Employee ${r.code}`);
      upsert.run({
        code: r.code,
        kind: r.kind,
        bioType: r.bioType || 0,
        idx: Number(r.idx) || 0,
        valid: r.valid ?? 1,
        template: r.template,
        extra: r.extra ? JSON.stringify(r.extra) : null,
        deviceId,
        now,
      });
      n += 1;
    }
    return n;
  })(records);
}

/** Builds the ADMS commands that write one stored template to a push device. */
function admsCommand(code, rec) {
  const extra = rec.extra ? JSON.parse(rec.extra) : {};
  if (rec.kind === 'finger') {
    return `DATA UPDATE FINGERTMP PIN=${code}\tFID=${rec.idx}\tSize=${rec.template.length}\tValid=${rec.valid}\tTMP=${rec.template}`;
  }
  if (rec.kind === 'face') {
    return `DATA UPDATE FACE PIN=${code}\tFID=${rec.idx}\tSIZE=${rec.template.length}\tVALID=${rec.valid}\tTMP=${rec.template}`;
  }
  const f = [
    `Pin=${code}`,
    `No=${extra.No ?? rec.idx}`,
    `Index=${extra.Index ?? 0}`,
    `Valid=${rec.valid}`,
    `Duress=${extra.Duress ?? 0}`,
    `Type=${rec.bio_type}`,
    `MajorVer=${extra.MajorVer ?? 0}`,
    `MinorVer=${extra.MinorVer ?? 0}`,
    `Format=${extra.Format ?? 0}`,
    `Tmp=${rec.template}`,
  ];
  return `DATA UPDATE BIODATA ${f.join('\t')}`;
}

class BiometricService {
  constructor(db, devices) {
    this.db = db;
    this.devices = devices;
  }

  /** { code: { finger, face, palm, other } } for every employee with templates. */
  summary() {
    const out = {};
    for (const r of this.db.prepare('SELECT employee_code, kind, bio_type FROM biometrics').all()) {
      const s = (out[r.employee_code] ||= { finger: 0, face: 0, palm: 0, other: 0 });
      s[category(r)] += 1;
    }
    return out;
  }

  list(code) {
    return this.db
      .prepare(
        `SELECT b.id, b.kind, b.bio_type, b.idx, b.valid, length(b.template) AS size, b.updated_at, d.name AS device_name
         FROM biometrics b LEFT JOIN devices d ON d.id = b.source_device_id
         WHERE b.employee_code = ? ORDER BY b.kind, b.bio_type, b.idx`
      )
      .all(code)
      .map((r) => ({ ...r, category: category(r) }));
  }

  remove(code) {
    return this.db.prepare('DELETE FROM biometrics WHERE employee_code = ?').run(code).changes;
  }

  /**
   * Pull device: downloads fingerprint templates of the given employees (all if
   * codes is empty). Push device: asks it to upload users and templates again.
   */
  async fetch(deviceId, codes = []) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error('Device not found');
    if (device.mode === 'push') {
      this.db.prepare('UPDATE devices SET op_stamp = NULL WHERE id = ?').run(device.id);
      this.devices.queueCommand(device.id, 'CHECK');
      return { queued: true, saved: 0, message: 'The device will upload its users and biometrics on its next connection (usually within a minute).' };
    }
    return this.devices._serial(device.id, async () => {
      const { users, templates } = await this.devices.withClient(device, async (zk) => ({
        users: await zk.getUsers(),
        templates: await zk.getTemplates(),
      }));
      const want = codes.length ? new Set(codes.map(String)) : null;
      const byUid = new Map(users.map((u) => [u.uid, u.userId]));
      const records = [];
      for (const t of templates) {
        const code = byUid.get(t.uid);
        if (!code || (want && !want.has(code))) continue;
        records.push({ code, kind: 'finger', idx: t.fid, valid: t.valid, template: t.template.toString('base64') });
      }
      const saved = saveTemplates(this.db, device.id, records);
      this.devices.log(device.id, `Downloaded ${saved} fingerprint template(s)`);
      return { queued: false, saved, message: `Downloaded ${saved} fingerprint template(s) from ${device.name}` };
    });
  }

  /**
   * Copies templates of the selected employees to the target devices.
   * Templates whose algorithm version differs from the target's are skipped
   * unless force is set; unknown versions are copied with a warning.
   * @param {{codes:string[], sourceDeviceId?:number|null, targetDeviceIds:number[], types?:string[], force?:boolean}} opts
   */
  async copy({ codes, sourceDeviceId = null, targetDeviceIds, types = ['finger', 'face'], force = false }) {
    if (!codes?.length) throw Object.assign(new Error('Select at least one employee'), { status: 400 });
    if (!targetDeviceIds?.length) throw Object.assign(new Error('Select at least one target device'), { status: 400 });

    let fetched = null;
    if (sourceDeviceId) {
      const src = this.devices.get(sourceDeviceId);
      if (!src) throw Object.assign(new Error('Source device not found'), { status: 400 });
      // A pull device is read now; a push device's templates arrive on their own.
      if (src.mode === 'pull') fetched = await this.fetch(src.id, codes);
    }

    const employees = new Map(
      this.db
        .prepare(`SELECT * FROM employees WHERE code IN (${codes.map(() => '?').join(',')})`)
        .all(...codes)
        .map((e) => [e.code, e])
    );
    const templatesFor = (code) =>
      this.db
        .prepare(`SELECT * FROM biometrics WHERE employee_code = ? ${sourceDeviceId ? 'AND source_device_id = ?' : ''} ORDER BY kind, bio_type, idx`)
        .all(...(sourceDeviceId ? [code, sourceDeviceId] : [code]))
        .filter((r) => types.includes(category(r)));

    const results = [];
    for (const targetId of targetDeviceIds.map(Number)) {
      if (targetId === Number(sourceDeviceId)) continue;
      const target = this.devices.get(targetId);
      if (!target) {
        results.push({ deviceId: targetId, device: `#${targetId}`, ok: false, error: 'Device not found', employees: [] });
        continue;
      }
      try {
        const check = (recs) => this._checkVersions(recs, target, force);
        const rows = target.mode === 'push'
          ? this._copyToPush(target, codes, employees, templatesFor, check)
          : await this._copyToPull(target, codes, employees, templatesFor, check);
        results.push({ deviceId: target.id, device: target.name, mode: target.mode, ok: true, fpVersion: target.fp_version, faceVersion: target.face_version, employees: rows });
      } catch (err) {
        this.devices.log(target.id, `Biometric copy failed: ${err.message}`, 'error');
        results.push({ deviceId: target.id, device: target.name, mode: target.mode, ok: false, error: err.message, employees: [] });
      }
    }
    return { fetched, results };
  }

  /** Algorithm version of a stored template: BIODATA says it, otherwise its source device does. */
  _templateVersion(rec) {
    const cat = category(rec);
    if (rec.kind === 'bio') {
      const extra = rec.extra ? JSON.parse(rec.extra) : {};
      if (majorVersion(extra.MajorVer)) return majorVersion(extra.MajorVer);
    }
    return rec.source_device_id ? deviceVersion(this.devices.get(rec.source_device_id), cat) : null;
  }

  /** Splits templates into ones safe to send and a note about the rest. */
  _checkVersions(recs, target, force) {
    const use = [];
    const notes = [];
    const mismatch = new Map();
    let unknown = false;
    for (const r of recs) {
      const cat = category(r);
      const from = this._templateVersion(r);
      const to = deviceVersion(target, cat);
      if (from && to && from !== to) {
        const key = `${cat}:${from}:${to}`;
        mismatch.set(key, (mismatch.get(key) || 0) + 1);
        if (force) use.push(r);
        continue;
      }
      if (!from || !to) unknown = true;
      use.push(r);
    }
    for (const [key, n] of mismatch) {
      const [cat, from, to] = key.split(':');
      notes.push(`${n} ${LABEL[cat]} template(s) ${force ? 'sent although' : 'not sent:'} algorithm ${from}, target uses ${to}`);
    }
    if (unknown && use.length) notes.push('Algorithm version unknown for some templates; check on the machine');
    return { use, note: notes.join('. ') };
  }

  // The user record (ID, name, card) is always transferred; templates only when compatible.
  // Status: 'queued' (user + templates), 'user-queued' (user only), 'skipped'.
  _copyToPush(target, codes, employees, templatesFor, check) {
    const rows = [];
    for (const code of codes) {
      const emp = employees.get(code);
      if (!emp) { rows.push({ code, status: 'skipped', note: 'Unknown employee' }); continue; }
      const all = templatesFor(code);
      const { use: recs, note } = all.length ? check(all) : { use: [], note: 'No stored biometrics' };
      this.devices.queueCommand(target.id, userInfoCommand(emp));
      for (const r of recs) this.devices.queueCommand(target.id, admsCommand(code, r));
      rows.push({ code, status: recs.length ? 'queued' : 'user-queued', ...counts(recs), note });
    }
    this.devices.log(target.id, `Queued ${rows.filter((r) => r.status !== 'skipped').length} user(s) with their compatible biometrics`);
    return rows;
  }

  async _copyToPull(target, codes, employees, templatesFor, check) {
    return this.devices._serial(target.id, () =>
      this.devices.withClient(target, async (zk) => {
        const existing = await zk.getUsers();
        let nextUid = existing.reduce((m, u) => Math.max(m, u.uid), 0) + 1;
        const rows = [];
        const entries = [];
        const userOnly = [];
        for (const code of codes) {
          const emp = employees.get(code);
          const recs = templatesFor(code);
          if (!emp) { rows.push({ code, status: 'skipped', note: 'Unknown employee' }); continue; }
          // The TCP/IP protocol only carries fingerprints; BIODATA type 1 is the same template.
          const allFingers = recs.filter((r) => category(r) === 'finger');
          const others = recs.length - allFingers.length;
          const { use: fingers, note: versionNote } = allFingers.length ? check(allFingers) : { use: [], note: '' };
          const otherNote = others ? `${others} face/palm template(s) need an ADMS device` : '';
          if (!fingers.length) {
            userOnly.push(emp);
            rows.push({ code, status: 'user', note: [recs.length ? versionNote : 'No stored biometrics', otherNote].filter(Boolean).join('. ') });
            continue;
          }
          const match = existing.find((u) => u.userId === code);
          const uid = match ? match.uid : nextUid++;
          entries.push({
            user: { uid, userId: code, name: emp.name, card: Number(emp.card_no) || 0, privilege: match?.privilege || 0, password: match?.password || '' },
            fingers: fingers.map((r) => ({ fid: r.kind === 'finger' ? r.idx : idxFromExtra(r), valid: r.valid, template: Buffer.from(r.template, 'base64') })),
          });
          rows.push({ code, status: 'copied', finger: fingers.length, note: [versionNote, otherNote].filter(Boolean).join('. ') });
        }
        if (entries.length) await zk.saveUserTemplates(entries);
        // setUser looks the user up again, so it sees the ones written above.
        for (const emp of userOnly) await zk.setUser({ userId: emp.code, name: emp.name, card: emp.card_no });
        this.devices.log(target.id, `Transferred ${entries.length + userOnly.length} user(s); fingerprints for ${entries.length}`);
        return rows;
      })
    );
  }
}

function idxFromExtra(rec) {
  const extra = rec.extra ? JSON.parse(rec.extra) : {};
  return Number(extra.No ?? rec.idx) || 0;
}

function counts(recs) {
  const c = { finger: 0, face: 0, palm: 0 };
  for (const r of recs) {
    const k = category(r);
    if (k in c) c[k] += 1;
  }
  return c;
}

function userInfoCommand(emp) {
  return `DATA UPDATE USERINFO ${[
    `PIN=${emp.code}`, `Name=${emp.name}`, 'Pri=0', 'Passwd=', `Card=${emp.card_no || ''}`, 'Grp=1', 'TZ=0000000100000000', 'Verify=0',
  ].join('\t')}`;
}

module.exports = { BiometricService, saveTemplates, category, admsCommand, userInfoCommand, majorVersion };
