'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const { createSimulator } = require('../tools/zk-simulator');
const T = require('../src/util/time');

test('only real calendar dates and months are accepted', async () => {
  assert.strictEqual(T.isDate('2024-02-29'), true);
  assert.strictEqual(T.isDate('2023-02-29'), false);
  assert.strictEqual(T.isDate('2024-02-31'), false);
  assert.strictEqual(T.isDate('2024-13-01'), false);
  const t = await startApp();
  try {
    await t.login();
    await t.call('POST', '/api/employees', { code: '1', name: 'A' });
    assert.strictEqual((await t.call('GET', '/api/reports/monthly?month=2024-13')).status, 400);
    assert.strictEqual((await t.call('GET', '/api/reports/monthly?month=2024-00')).status, 400);
    assert.strictEqual((await t.call('GET', '/api/reports/daily?date=2024-02-31')).status, 400);
    assert.strictEqual((await t.call('GET', '/api/reports/employee?code=1&from=2024-05-10&to=2024-05-01')).status, 400);
    assert.strictEqual((await t.call('GET', '/api/punches?from=2024-05-10&to=2024-05-01')).status, 400);
    assert.strictEqual((await t.call('POST', '/api/holidays', { date: '2024-04-31', name: 'X' })).status, 400);
  } finally {
    await t.close();
  }
});

test('punch log paging values cannot break the query', async () => {
  const t = await startApp();
  try {
    await t.login();
    await t.call('POST', '/api/employees', { code: '1', name: 'A' });
    for (const m of ['09:00', '10:00', '11:00']) await t.call('POST', '/api/punches', { employee_code: '1', punch_time: `2024-05-06 ${m}` });
    const q = '/api/punches?from=2024-05-06&to=2024-05-06';
    for (const extra of ['&limit=-1&offset=Infinity', '&limit=abc&offset=-5', '&limit=1e9&offset=1;DROP']) {
      const r = await t.call('GET', q + extra);
      assert.strictEqual(r.status, 200, `${extra}: ${JSON.stringify(r.data)}`);
    }
    assert.strictEqual((await t.call('GET', q + '&limit=-1')).data.rows.length, 1, 'negative limit is clamped, not unlimited');
    assert.strictEqual((await t.call('GET', q + '&limit=2&offset=2')).data.rows.length, 1);
    // Junk in "from" falls back to today and never reaches the file name header.
    const csv = await fetch(t.base + '/api/punches.csv?from=2024-05-06%22%0D%0Ax:y', { headers: { cookie: t.cookie() } });
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /^attachment; filename="punches_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
  } finally {
    await t.close();
  }
});

test('employees created from a machine user ID can still be edited', async () => {
  const t = await startApp({ adms: { autoApprove: true, timeZone: '330', delay: 10 } });
  try {
    await t.login();
    await t.call('POST', '/iclock/cdata?SN=ADMS1&table=ATTLOG', 'EMP-07\t2024-05-06 09:00:00\t0\t1\n');
    const e = t.db.prepare(`SELECT * FROM employees WHERE code = 'EMP-07'`).get();
    const r = await t.call('PUT', `/api/employees/${e.id}`, { name: 'Real Name', department: 'Stores' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.name, 'Real Name');
    // bulk import may update it too, but new codes are still checked
    const b = await t.call('POST', '/api/employees/bulk', [{ code: 'EMP-07', name: 'Again' }, { code: 'BAD-NEW', name: 'X' }]);
    assert.strictEqual(b.data.imported, 1);
    assert.strictEqual(b.data.errors[0].row, 2);
    assert.strictEqual((await t.call('POST', '/api/employees', { code: 'NEW-1', name: 'X' })).status, 400);
  } finally {
    await t.close();
  }
});

test('ADMS traffic does not overwrite a TCP/IP device address', async () => {
  const sim = createSimulator({ serialNumber: 'BOTH1' });
  const port = await sim.listen(0, '127.0.0.1');
  const t = await startApp({ adms: { autoApprove: true, timeZone: '330', delay: 10 } });
  try {
    await t.login();
    const id = (await t.call('POST', '/api/devices', { name: 'Pull', mode: 'pull', ip: '127.0.0.1', port })).data.id;
    await t.call('POST', `/api/devices/${id}/sync`);
    // The ADMS request arrives from another address (here via the local proxy header).
    await t.call('GET', '/iclock/cdata?SN=BOTH1&options=all', undefined, { 'x-forwarded-for': '10.9.9.9' });
    const d = t.db.prepare('SELECT ip, mode, last_seen FROM devices WHERE id = ?').get(id);
    assert.deepStrictEqual([d.ip, d.mode], ['127.0.0.1', 'pull']);
    assert.ok(d.last_seen);
    assert.strictEqual((await t.call('POST', `/api/devices/${id}/sync`)).status, 200, 'still syncs');
  } finally {
    await t.close();
    await sim.close();
  }
});

test('repeated wrong passwords lock that username for a while', async () => {
  const t = await startApp();
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await t.call('POST', '/api/login', { username: 'admin', password: `wrong${i}` })).status);
    assert.deepStrictEqual(statuses, [401, 401, 401, 401, 401, 429]);
    const r = await t.call('POST', '/api/login', { username: 'admin', password: 'secret1' });
    assert.strictEqual(r.status, 429, 'even the right password waits out the lock');
    assert.match(r.data.error, /Too many failed sign-ins/);
  } finally {
    await t.close();
  }
});

test('a successful sign-in clears earlier failures', async () => {
  const t = await startApp();
  try {
    for (let i = 0; i < 4; i++) await t.call('POST', '/api/login', { username: 'admin', password: 'nope' });
    assert.strictEqual((await t.login()).status, 200);
    for (let i = 0; i < 4; i++) assert.strictEqual((await t.call('POST', '/api/login', { username: 'admin', password: 'nope' })).status, 401);
  } finally {
    await t.close();
  }
});
