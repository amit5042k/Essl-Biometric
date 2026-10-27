'use strict';

const express = require('express');
const T = require('../util/time');
const { sendCsv } = require('../util/csv');
const { buildAttendance, summarize, STATUS_LABELS } = require('../services/attendance');
const { savePunches } = require('../services/punches');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  return out;
}

function update(db, table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...data, __id: id });
}

function insert(db, table, data) {
  const keys = Object.keys(data);
  return db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`).run(data).lastInsertRowid;
}

function requireDate(v, name = 'date') {
  if (!T.isDate(v)) throw bad(`${name} must be YYYY-MM-DD`);
  return v;
}

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw bad('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: `${month}-${T.pad(T.daysInMonth(y, m))}` };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function createApiRouter({ db, auth, devices, biometrics }) {
  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));

  // ------------------------------------------------------------------ auth
  r.post('/login', (req, res) => {
    const s = auth.login(req.body.username, req.body.password);
    if (!s) throw new HttpError(401, 'Invalid username or password');
    auth.setCookie(res, s.token, req);
    res.json({ user: s.user });
  });

  r.use(auth.middleware);

  r.post('/logout', (req, res) => {
    auth.logout(req.user.token);
    auth.clearCookie(res);
    res.json({ ok: true });
  });
  r.get('/me', (req, res) => res.json({ user: { id: req.user.id, username: req.user.username } }));
  r.post('/change-password', (req, res) => {
    const { current, next } = req.body;
    if (!next || String(next).length < 6) throw bad('New password must be at least 6 characters');
    if (!auth.changePassword(req.user.id, current, next)) throw bad('Current password is incorrect');
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- dashboard
  r.get('/dashboard', (req, res) => {
    const today = T.nowLocal().slice(0, 10);
    const { rows } = buildAttendance(db, { from: today, to: today });
    const counts = { total: rows.length, present: 0, absent: 0, late: 0, onLeave: 0, off: 0 };
    for (const { days } of rows) {
      const d = days[0];
      if (['P', 'HD', 'MP'].includes(d.status) || d.punchCount) counts.present += 1;
      else if (d.status === 'L') counts.onLeave += 1;
      else if (d.status === 'WO' || d.status === 'HO') counts.off += 1;
      else counts.absent += 1;
      if (d.lateMin > 0) counts.late += 1;
    }
    const devs = db.prepare('SELECT id, name, mode, enabled, last_seen, last_sync, last_error FROM devices ORDER BY name').all();
    const recent = db
      .prepare(
        `SELECT p.*, e.name AS employee_name, d.name AS device_name FROM punches p
         LEFT JOIN employees e ON e.code = p.employee_code
         LEFT JOIN devices d ON d.id = p.device_id
         ORDER BY p.punch_time DESC LIMIT 15`
      )
      .all();
    res.json({ date: today, counts, devices: devs, recent });
  });

  // --------------------------------------------------------------- devices
  const DEVICE_FIELDS = ['name', 'model', 'mode', 'ip', 'port', 'transport', 'comm_key', 'serial_number', 'location', 'enabled', 'poll_minutes', 'clear_after_sync'];

  function validateDevice(d, partial = false) {
    if (!partial || d.name !== undefined) if (!String(d.name || '').trim()) throw bad('Name is required');
    if (d.mode !== undefined && !['pull', 'push'].includes(d.mode)) throw bad('mode must be pull or push');
    if (d.transport != null && !['tcp', 'udp'].includes(d.transport)) throw bad('transport must be tcp or udp');
    if (d.mode === 'pull' && !d.ip) throw bad('IP address is required for TCP/IP devices');
    if (d.mode === 'push' && !d.serial_number) throw bad('Serial number is required for ADMS devices');
    for (const k of ['port', 'comm_key', 'poll_minutes']) {
      if (d[k] != null && !Number.isInteger(Number(d[k]))) throw bad(`${k} must be a number`);
    }
  }

  function getDevice(id) {
    const d = devices.get(Number(id));
    if (!d) throw new HttpError(404, 'Device not found');
    return d;
  }

  r.get('/devices', (req, res) => {
    const list = db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM punches p WHERE p.device_id = d.id) AS punch_count,
           (SELECT COUNT(*) FROM device_commands c WHERE c.device_id = d.id AND c.status = 'pending') AS pending_commands
         FROM devices d ORDER BY d.name`
      )
      .all();
    res.json(list);
  });

  r.post('/devices', (req, res) => {
    const data = pick(req.body, DEVICE_FIELDS);
    data.mode = data.mode || 'pull';
    validateDevice(data);
    const id = insert(db, 'devices', data);
    res.status(201).json(devices.get(id));
  });

  r.put('/devices/:id', (req, res) => {
    const current = getDevice(req.params.id);
    const data = pick(req.body, DEVICE_FIELDS);
    validateDevice({ ...current, ...data });
    update(db, 'devices', current.id, data);
    res.json(devices.get(current.id));
  });

  r.delete('/devices/:id', (req, res) => {
    const d = getDevice(req.params.id);
    db.prepare('DELETE FROM devices WHERE id = ?').run(d.id);
    res.json({ ok: true });
  });

  r.post('/devices/test', async (req, res) => {
    const d = req.body;
    if (!d.ip) throw bad('IP address is required');
    const info = await devices.probe({ ip: d.ip, port: Number(d.port) || 4370, comm_key: Number(d.comm_key) || 0, transport: d.transport || 'tcp' });
    res.json(info);
  });

  const action = (fn) => async (req, res) => {
    const d = getDevice(req.params.id);
    res.json(await fn(d, req));
  };

  r.post('/devices/:id/sync', action((d) => devices.sync(d.id)));
  r.get('/devices/:id/info', action((d) => devices.info(d.id)));
  r.post('/devices/:id/time', action((d) => devices.setTime(d.id)));
  r.post('/devices/:id/restart', action((d) => devices.restart(d.id)));
  r.post('/devices/:id/clear-logs', action((d) => devices.clearLogs(d.id)));
  r.get('/devices/:id/users', action((d) => devices.deviceUsers(d.id)));

  r.post('/devices/:id/reupload', action((d) => {
    if (d.mode !== 'push') throw bad('Only for ADMS devices; use Sync for TCP/IP devices');
    db.prepare('UPDATE devices SET att_stamp = NULL, op_stamp = NULL WHERE id = ?').run(d.id);
    devices.queueCommand(d.id, 'CHECK');
    return { queued: true, message: 'Device will re-upload its stored logs on next connection' };
  }));

  r.post('/devices/:id/upload-employees', action(async (d, req) => {
    const codes = Array.isArray(req.body.codes) ? req.body.codes.map(String) : null;
    const emps = db.prepare('SELECT * FROM employees WHERE active = 1 ORDER BY code').all()
      .filter((e) => !codes || codes.includes(e.code));
    const results = [];
    for (const e of emps) {
      try {
        await devices.uploadEmployee(d.id, e);
        results.push({ code: e.code, ok: true });
      } catch (err) {
        results.push({ code: e.code, ok: false, error: err.message });
      }
    }
    return { total: results.length, failed: results.filter((x) => !x.ok), queued: d.mode === 'push' };
  }));

  r.post('/devices/:id/remove-employee', action((d, req) => {
    if (!req.body.code) throw bad('code is required');
    return devices.removeEmployee(d.id, String(req.body.code));
  }));

  r.get('/devices/:id/logs', action((d) =>
    db.prepare('SELECT * FROM device_logs WHERE device_id = ? ORDER BY id DESC LIMIT 200').all(d.id)
  ));
  r.get('/devices/:id/commands', action((d) =>
    db.prepare('SELECT * FROM device_commands WHERE device_id = ? ORDER BY id DESC LIMIT 200').all(d.id)
  ));
  r.post('/devices/:id/commands', action((d, req) => {
    if (d.mode !== 'push') throw bad('Commands can only be queued for ADMS devices');
    const cmd = String(req.body.command || '').trim();
    if (!cmd || /[\r\n]/.test(cmd)) throw bad('Invalid command');
    return { id: devices.queueCommand(d.id, cmd) };
  }));

  // ------------------------------------------------------------- employees
  const EMP_FIELDS = ['code', 'name', 'department', 'designation', 'phone', 'email', 'card_no', 'shift_id', 'join_date', 'active'];

  function validateEmployee(e) {
    if (!String(e.code || '').trim()) throw bad('Employee code (device user ID) is required');
    if (!/^[A-Za-z0-9]{1,24}$/.test(String(e.code))) throw bad('Employee code must be 1-24 letters/digits');
    if (!String(e.name || '').trim()) throw bad('Name is required');
    if (e.join_date && !T.isDate(e.join_date)) throw bad('join_date must be YYYY-MM-DD');
  }

  r.get('/employees', (req, res) => {
    const where = [];
    const args = {};
    if (req.query.q) {
      where.push('(e.code LIKE @q OR e.name LIKE @q OR e.department LIKE @q)');
      args.q = `%${req.query.q}%`;
    }
    if (req.query.department) { where.push('e.department = @dept'); args.dept = req.query.department; }
    if (req.query.active !== undefined && req.query.active !== '') { where.push('e.active = @active'); args.active = Number(req.query.active); }
    res.json(
      db.prepare(
        `SELECT e.*, s.name AS shift_name FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.code`
      ).all(args)
    );
  });

  r.post('/employees', (req, res) => {
    const data = pick(req.body, EMP_FIELDS);
    validateEmployee(data);
    if (db.prepare('SELECT 1 FROM employees WHERE code = ?').get(data.code)) throw bad('Employee code already exists');
    const id = insert(db, 'employees', data);
    res.status(201).json(db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
  });

  r.put('/employees/:id', (req, res) => {
    const cur = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!cur) throw new HttpError(404, 'Employee not found');
    const data = pick(req.body, EMP_FIELDS);
    if (data.code && data.code !== cur.code) throw bad('Employee code cannot be changed (it is the device user ID)');
    validateEmployee({ ...cur, ...data });
    update(db, 'employees', cur.id, data);
    res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(cur.id));
  });

  r.delete('/employees/:id', (req, res) => {
    db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  /** Bulk import: [{code,name,department,designation,card_no,...}] */
  r.post('/employees/bulk', (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : [];
    const upsert = db.prepare(
      `INSERT INTO employees (code, name, department, designation, phone, email, card_no, join_date)
       VALUES (@code, @name, @department, @designation, @phone, @email, @card_no, @join_date)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name,
         department = COALESCE(excluded.department, department), designation = COALESCE(excluded.designation, designation),
         phone = COALESCE(excluded.phone, phone), email = COALESCE(excluded.email, email),
         card_no = COALESCE(excluded.card_no, card_no), join_date = COALESCE(excluded.join_date, join_date)`
    );
    const errors = [];
    let ok = 0;
    db.transaction(() => {
      rows.forEach((row, i) => {
        const e = { department: null, designation: null, phone: null, email: null, card_no: null, join_date: null, ...pick(row, EMP_FIELDS) };
        try {
          validateEmployee(e);
          upsert.run(e);
          ok += 1;
        } catch (err) {
          errors.push({ row: i + 1, error: err.message });
        }
      });
    })();
    res.json({ imported: ok, errors });
  });

  r.get('/departments', (req, res) => {
    res.json(db.prepare(`SELECT DISTINCT department FROM employees WHERE department IS NOT NULL AND department <> '' ORDER BY 1`).all().map((x) => x.department));
  });

  // ------------------------------------------------------------ biometrics
  const codeList = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

  r.get('/biometrics/summary', (req, res) => res.json(biometrics.summary()));
  r.get('/biometrics/:code', (req, res) => res.json(biometrics.list(req.params.code)));
  r.delete('/biometrics/:code', (req, res) => res.json({ removed: biometrics.remove(req.params.code) }));

  r.post('/biometrics/fetch', async (req, res) => {
    getDevice(req.body.deviceId);
    res.json(await biometrics.fetch(Number(req.body.deviceId), codeList(req.body.codes)));
  });

  r.post('/biometrics/copy', async (req, res) => {
    const types = codeList(req.body.types).filter((t) => ['finger', 'face', 'palm'].includes(t));
    res.json(await biometrics.copy({
      codes: codeList(req.body.codes),
      sourceDeviceId: req.body.sourceDeviceId ? Number(req.body.sourceDeviceId) : null,
      targetDeviceIds: Array.isArray(req.body.targetDeviceIds) ? req.body.targetDeviceIds.map(Number) : [],
      types: types.length ? types : ['finger', 'face'],
    }));
  });

  // ---------------------------------------------------------------- shifts
  const SHIFT_FIELDS = ['name', 'start_time', 'end_time', 'grace_minutes', 'early_exit_grace', 'half_day_minutes', 'full_day_minutes', 'weekly_off', 'ot_enabled'];

  function validateShift(s) {
    if (!String(s.name || '').trim()) throw bad('Shift name is required');
    if (!HHMM.test(s.start_time) || !HHMM.test(s.end_time)) throw bad('Times must be HH:MM (24h)');
    if (s.weekly_off != null && !/^([0-6](,[0-6])*)?$/.test(String(s.weekly_off))) throw bad('weekly_off must be weekday numbers like "0" or "0,6" (0 = Sunday)');
  }

  r.get('/shifts', (req, res) => res.json(db.prepare('SELECT s.*, (SELECT COUNT(*) FROM employees e WHERE e.shift_id = s.id) AS employees FROM shifts s ORDER BY id').all()));
  r.post('/shifts', (req, res) => {
    const data = pick(req.body, SHIFT_FIELDS);
    validateShift(data);
    res.status(201).json({ id: insert(db, 'shifts', data) });
  });
  r.put('/shifts/:id', (req, res) => {
    const cur = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!cur) throw new HttpError(404, 'Shift not found');
    const data = pick(req.body, SHIFT_FIELDS);
    validateShift({ ...cur, ...data });
    update(db, 'shifts', cur.id, data);
    res.json({ ok: true });
  });
  r.delete('/shifts/:id', (req, res) => {
    if (db.prepare('SELECT COUNT(*) n FROM shifts').get().n <= 1) throw bad('At least one shift is required');
    db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------- holidays
  r.get('/holidays', (req, res) => {
    const year = String(req.query.year || new Date().getFullYear());
    res.json(db.prepare(`SELECT * FROM holidays WHERE date LIKE ? ORDER BY date`).all(`${year}-%`));
  });
  r.post('/holidays', (req, res) => {
    requireDate(req.body.date);
    if (!String(req.body.name || '').trim()) throw bad('Holiday name is required');
    db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name').run(req.body.date, req.body.name.trim());
    res.status(201).json({ ok: true });
  });
  r.delete('/holidays/:id', (req, res) => {
    db.prepare('DELETE FROM holidays WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- leaves
  r.get('/leaves', (req, res) => {
    const { from, to } = req.query.month ? monthRange(req.query.month) : { from: '0000-01-01', to: '9999-12-31' };
    res.json(
      db.prepare(
        `SELECT l.*, e.name AS employee_name FROM leaves l LEFT JOIN employees e ON e.code = l.employee_code
         WHERE l.from_date <= ? AND l.to_date >= ? ORDER BY l.from_date DESC`
      ).all(to, from)
    );
  });
  r.post('/leaves', (req, res) => {
    const { employee_code, from_date, to_date, leave_type, reason } = req.body;
    if (!db.prepare('SELECT 1 FROM employees WHERE code = ?').get(employee_code)) throw bad('Unknown employee');
    requireDate(from_date, 'from_date');
    requireDate(to_date, 'to_date');
    if (to_date < from_date) throw bad('to_date is before from_date');
    const id = insert(db, 'leaves', { employee_code, from_date, to_date, leave_type: String(leave_type || 'CL').slice(0, 8), reason: reason || null });
    res.status(201).json({ id });
  });
  r.delete('/leaves/:id', (req, res) => {
    db.prepare('DELETE FROM leaves WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // --------------------------------------------------------------- punches
  function punchQuery(q) {
    const from = q.from && T.isDate(q.from) ? q.from : T.nowLocal().slice(0, 10);
    const to = q.to && T.isDate(q.to) ? q.to : from;
    const where = ['p.punch_time >= @from', 'p.punch_time < @to'];
    const args = { from: `${from} 00:00:00`, to: `${T.addDays(to, 1)} 00:00:00` };
    if (q.code) { where.push('p.employee_code = @code'); args.code = q.code; }
    if (q.device) { where.push('p.device_id = @device'); args.device = Number(q.device); }
    if (q.department) { where.push('e.department = @dept'); args.dept = q.department; }
    const sql = `FROM punches p LEFT JOIN employees e ON e.code = p.employee_code LEFT JOIN devices d ON d.id = p.device_id WHERE ${where.join(' AND ')}`;
    return { sql, args };
  }

  r.get('/punches', (req, res) => {
    const { sql, args } = punchQuery(req.query);
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    const offset = Number(req.query.offset) || 0;
    const total = db.prepare(`SELECT COUNT(*) n ${sql}`).get(args).n;
    const rows = db
      .prepare(`SELECT p.*, e.name AS employee_name, e.department, d.name AS device_name ${sql} ORDER BY p.punch_time DESC LIMIT ${limit} OFFSET ${offset}`)
      .all(args);
    res.json({ total, rows });
  });

  r.get('/punches.csv', (req, res) => {
    const { sql, args } = punchQuery(req.query);
    const rows = db.prepare(`SELECT p.*, e.name AS employee_name, e.department, d.name AS device_name ${sql} ORDER BY p.punch_time`).all(args);
    sendCsv(res, `punches_${req.query.from || 'today'}.csv`, ['Code', 'Name', 'Department', 'Punch Time', 'Device', 'State', 'Verify', 'Source'],
      rows.map((p) => [p.employee_code, p.employee_name, p.department, p.punch_time, p.device_name, p.punch_state, p.verify_type, p.source]));
  });

  r.post('/punches', (req, res) => {
    const { employee_code, punch_time, note } = req.body;
    if (!db.prepare('SELECT 1 FROM employees WHERE code = ?').get(employee_code)) throw bad('Unknown employee');
    const ts = T.normalizeTimestamp(punch_time);
    if (!ts) throw bad('punch_time must be YYYY-MM-DD HH:MM');
    savePunches(db, null, [{ userId: employee_code, timestamp: ts }], 'manual');
    if (note) db.prepare(`UPDATE punches SET note = ? WHERE employee_code = ? AND punch_time = ? AND source = 'manual'`).run(note, employee_code, ts);
    res.status(201).json({ ok: true });
  });

  r.delete('/punches/:id', (req, res) => {
    const info = db.prepare(`DELETE FROM punches WHERE id = ? AND source = 'manual'`).run(req.params.id);
    if (!info.changes) throw bad('Only manual punches can be deleted');
    res.json({ ok: true });
  });

  // --------------------------------------------------------------- reports
  function dailyRows(q) {
    const date = requireDate(q.date || T.nowLocal().slice(0, 10));
    const { rows } = buildAttendance(db, { from: date, to: date, department: q.department || null });
    return { date, rows: rows.map(({ employee, days }) => ({ employee, ...days[0] })) };
  }

  r.get('/reports/daily', (req, res) => res.json(dailyRows(req.query)));

  r.get('/reports/daily.csv', (req, res) => {
    const { date, rows } = dailyRows(req.query);
    sendCsv(res, `daily_${date}.csv`,
      ['Code', 'Name', 'Department', 'Shift', 'Status', 'In', 'Out', 'Work Hrs', 'Late (min)', 'Early Exit (min)', 'OT Hrs', 'Punches', 'Remark'],
      rows.map((x) => [x.employee.code, x.employee.name, x.employee.department, x.employee.shift_name, STATUS_LABELS[x.status] || x.status,
        x.inTime, x.outTime, T.formatDuration(x.workMin), x.lateMin || '', x.earlyMin || '', x.otMin ? T.formatDuration(x.otMin) : '',
        (x.punches || []).join(' '), x.remark]));
  });

  function monthly(q) {
    const month = q.month || T.nowLocal().slice(0, 7);
    const { from, to } = monthRange(month);
    const data = buildAttendance(db, { from, to, department: q.department || null, employeeCode: q.code || null });
    return {
      month,
      dates: data.dates,
      rows: data.rows.map(({ employee, days }) => ({ employee, days, summary: summarize(days) })),
    };
  }

  r.get('/reports/monthly', (req, res) => res.json(monthly(req.query)));

  r.get('/reports/monthly.csv', (req, res) => {
    const m = monthly(req.query);
    const headers = ['Code', 'Name', 'Department', ...m.dates.map((d) => d.slice(8)), 'Present', 'Absent', 'Half Day', 'Leave', 'Weekly Off', 'Holiday', 'Late', 'Payable Days', 'Work Hrs', 'OT Hrs'];
    sendCsv(res, `muster_${m.month}.csv`, headers, m.rows.map(({ employee, days, summary: s }) => [
      employee.code, employee.name, employee.department, ...days.map((d) => d.status),
      s.present, s.absent, s.halfDay, s.leave, s.weeklyOff, s.holiday, s.late, s.payableDays, T.formatDuration(s.workMin), T.formatDuration(s.otMin),
    ]));
  });

  r.get('/reports/employee', (req, res) => {
    if (!req.query.code) throw bad('code is required');
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    if (T.toMinutes(to) - T.toMinutes(from) > 366 * 1440) throw bad('Range too large (max 1 year)');
    const { rows } = buildAttendance(db, { from, to, employeeCode: req.query.code, includeInactive: true });
    if (!rows.length) throw new HttpError(404, 'Employee not found');
    res.json({ employee: rows[0].employee, days: rows[0].days, summary: summarize(rows[0].days) });
  });

  // ---------------------------------------------------------------- errors
  r.use((err, req, res, _next) => {
    let status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    const deviceError = /timed out|ECONN|EHOST|ETIMEDOUT|ENETUNREACH|communication key|closed by device/i.test(err.message);
    if (status === 500 && deviceError) status = 502;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Server error' });
  });

  return r;
}

module.exports = { createApiRouter };
