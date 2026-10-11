'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ZKClient } = require('../src/zk/client');
const U = require('../src/zk/utils');
const { createSimulator } = require('../tools/zk-simulator');

test('time encoding round-trips', () => {
  const d = new Date(2024, 2, 15, 9, 5, 7);
  assert.strictEqual(U.decodeTime(U.encodeTime(d)), '2024-03-15 09:05:07');
});

async function withDevice(opts, fn) {
  const sim = createSimulator(opts);
  const port = await sim.listen(0, '127.0.0.1');
  const zk = new ZKClient({ ip: '127.0.0.1', port, password: opts.commKey, timeout: 3000 });
  try {
    await zk.connect();
    await fn(zk, sim);
  } finally {
    await zk.disconnect();
    await sim.close();
  }
}

test('reads info, users and a large attendance log', async () => {
  const users = [{ userId: '1', name: 'Asha' }, { userId: 'EMP02', name: 'Rahul' }];
  const logs = [];
  for (let i = 0; i < 500; i++) {
    logs.push({ userId: i % 2 ? 'EMP02' : '1', timestamp: `2024-01-${String((i % 28) + 1).padStart(2, '0')} 09:00:${String(i % 60).padStart(2, '0')}`, punchState: i % 2, verifyType: 15 });
  }
  await withDevice({ users, logs, commKey: 0 }, async (zk) => {
    const info = await zk.getInfo();
    assert.strictEqual(info.serialNumber, 'SIMULATOR0001');
    assert.strictEqual(info.sizes.records, 500);

    const u = await zk.getUsers();
    assert.deepStrictEqual(u.map((x) => [x.userId, x.name]), [['1', 'Asha'], ['EMP02', 'Rahul']]);

    const att = await zk.getAttendance();
    assert.strictEqual(att.length, 500);
    assert.deepStrictEqual(att[1], { userId: 'EMP02', timestamp: '2024-01-02 09:00:01', verifyType: 15, punchState: 1 });
  });
});

test('authenticates with comm key, writes/deletes users, sets time', async () => {
  await withDevice({ commKey: 12345 }, async (zk, sim) => {
    await zk.setUser({ userId: '77', name: 'New Joinee', card: 998877 });
    assert.strictEqual(sim.state.users[0].name, 'New Joinee');
    assert.strictEqual(sim.state.users[0].card, 998877);
    assert.strictEqual(await zk.deleteUser('77'), true);
    assert.strictEqual(sim.state.users.length, 0);

    await zk.setTime(new Date(2025, 0, 2, 3, 4, 5));
    assert.strictEqual(await zk.getTime(), '2025-01-02 03:04:05');
  });
});

test('wrong comm key is rejected', async () => {
  const sim = createSimulator({ commKey: 111 });
  const port = await sim.listen(0, '127.0.0.1');
  const zk = new ZKClient({ ip: '127.0.0.1', port, password: 222, timeout: 2000 });
  await assert.rejects(zk.connect(), /communication key/);
  await sim.close();
});
