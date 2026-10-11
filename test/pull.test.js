'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const { createSimulator } = require('../tools/zk-simulator');

test('pull device: test connection, sync, upload employee, clear logs', async () => {
  const sim = createSimulator({
    serialNumber: 'CLS0001',
    commKey: 4321,
    users: [{ userId: '201', name: 'Kiran Rao' }],
    logs: [
      { userId: '201', timestamp: '2024-05-06 09:00:00', punchState: 0 },
      { userId: '201', timestamp: '2024-05-06 18:00:00', punchState: 1 },
    ],
  });
  const port = await sim.listen(0, '127.0.0.1');
  const t = await startApp();
  try {
    let r = await t.call('GET', '/api/devices');
    assert.strictEqual(r.status, 401);
    await t.login();

    r = await t.call('POST', '/api/devices/test', { ip: '127.0.0.1', port, comm_key: 4321 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.serialNumber, 'CLS0001');

    r = await t.call('POST', '/api/devices/test', { ip: '127.0.0.1', port, comm_key: 1 });
    assert.strictEqual(r.status, 502);

    r = await t.call('POST', '/api/devices', { name: 'Office Classic', mode: 'pull', ip: '127.0.0.1', port, comm_key: 4321 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const id = r.data.id;

    r = await t.call('POST', `/api/devices/${id}/sync`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.added, 2);
    assert.strictEqual(t.db.prepare(`SELECT name FROM employees WHERE code = '201'`).get().name, 'Kiran Rao');
    assert.strictEqual(t.db.prepare('SELECT serial_number FROM devices WHERE id = ?').get(id).serial_number, 'CLS0001');

    r = await t.call('POST', '/api/employees', { code: '202', name: 'Meena K', card_no: '5566' });
    assert.strictEqual(r.status, 201);
    r = await t.call('POST', `/api/devices/${id}/upload-employees`, { codes: ['202'] });
    assert.deepStrictEqual(r.data.failed, []);
    assert.ok(sim.state.users.find((u) => u.userId === '202' && u.name === 'Meena K' && u.card === 5566));

    r = await t.call('POST', `/api/devices/${id}/clear-logs`);
    assert.strictEqual(r.data.cleared, true);
    assert.strictEqual(sim.state.logs.length, 0);
    assert.strictEqual(t.db.prepare('SELECT COUNT(*) n FROM punches').get().n, 2);
  } finally {
    await t.close();
    await sim.close();
  }
});
