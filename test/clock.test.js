'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const { createSimulator } = require('../tools/zk-simulator');
const T = require('../src/util/time');
const U = require('../src/zk/utils');

test('TCP/IP sync measures clock drift and corrects it', async () => {
  const sim = createSimulator({ clockOffsetSeconds: -300 }); // 5 minutes behind
  const port = await sim.listen(0, '127.0.0.1');
  const t = await startApp({ autoTimeSync: true, timeDriftSeconds: 60 });
  try {
    await t.login();
    const id = (await t.call('POST', '/api/devices', { name: 'Orcus TCP', mode: 'pull', ip: '127.0.0.1', port })).data.id;
    // A clock check that day already happened, so only the drift can trigger a correction.
    t.db.prepare('UPDATE devices SET last_time_sync = ? WHERE id = ?').run(T.nowLocal(), id);

    const r = await t.call('POST', `/api/devices/${id}/sync`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.drift <= -298 && r.data.drift >= -302, `drift ${r.data.drift}`);
    assert.strictEqual(r.data.timeSynced, true);
    assert.ok(Math.abs(sim.state.clockOffsetMs) < 2000, 'device clock corrected');
    const dev = t.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    assert.deepStrictEqual([dev.clock_drift, dev.clock_source], [0, 'read']);
    assert.ok(t.db.prepare(`SELECT 1 FROM device_logs WHERE device_id = ? AND message LIKE 'Clock was 5 min % behind; corrected'`).get(id));

    // Within the threshold and already synced today: measured, left alone.
    sim.state.clockOffsetMs = -20000;
    const r2 = await t.call('POST', `/api/devices/${id}/sync`);
    assert.strictEqual(r2.data.timeSynced, false);
    const d2 = t.db.prepare('SELECT clock_drift FROM devices WHERE id = ?').get(id).clock_drift;
    assert.ok(d2 <= -18 && d2 >= -22, `drift ${d2}`);

    // Manual "Sync time" reports what it fixed.
    sim.state.clockOffsetMs = 125000;
    const r3 = await t.call('POST', `/api/devices/${id}/time`);
    assert.match(r3.data.message, /^Device time updated \(it was 2 min [4-6] s ahead\)$/);
  } finally {
    await t.close();
    await sim.close();
  }
});

test('ADMS: server time endpoint, drift estimate from punches, restart to re-sync', async () => {
  const t = await startApp({ adms: { autoApprove: true, timeZone: '330', delay: 10 } });
  try {
    await t.login();
    let r = await t.call('GET', '/iclock/rtdata?SN=ORC1&type=time');
    const m = r.data.match(/^DateTime=(\d+),ServerTZ=\+0530$/);
    assert.ok(m, r.data);
    const now = new Date();
    const utc = U.formatParts(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
    assert.ok(Math.abs(T.toMinutes(U.decodeTime(Number(m[1]))) - T.toMinutes(utc)) * 60 <= 2, 'DateTime is current UTC');

    // A real-time punch stamped 4 minutes ago means the clock is ~4 minutes behind.
    const punchAt = T.fromMinutes(T.toMinutes(T.nowLocal()) - 4);
    await t.call('POST', '/iclock/cdata?SN=ORC1&table=ATTLOG', `9\t${punchAt}\t0\t15\t0\t0\n`);
    const dev = t.db.prepare(`SELECT * FROM devices WHERE serial_number = 'ORC1'`).get();
    assert.strictEqual(dev.clock_source, 'punch');
    assert.ok(dev.clock_drift <= -238 && dev.clock_drift >= -242, `drift ${dev.clock_drift}`);

    // A backlog of old punches is not mistaken for drift.
    await t.call('POST', '/iclock/cdata?SN=ORC1&table=ATTLOG', '9\t2024-01-01 09:00:00\t0\t15\t0\t0\n');
    assert.strictEqual(t.db.prepare('SELECT clock_drift FROM devices WHERE id = ?').get(dev.id).clock_drift, dev.clock_drift);

    // "Sync time" on an ADMS device queues a restart.
    r = await t.call('POST', `/api/devices/${dev.id}/time`);
    assert.strictEqual(r.data.queued, true);
    r = await t.call('GET', '/iclock/getrequest?SN=ORC1');
    assert.match(r.data, /^C:\d+:REBOOT/);

    // Daily restart: once, within an hour after the set time.
    r = await t.call('PUT', `/api/devices/${dev.id}`, { auto_restart_at: '03:30' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await t.call('PUT', `/api/devices/${dev.id}`, { auto_restart_at: '3.30' })).status, 400);
    assert.deepStrictEqual(t.devices.queueDailyRestarts('2026-10-28 03:10:00'), []);
    assert.deepStrictEqual(t.devices.queueDailyRestarts('2026-10-28 03:31:00'), [dev.id]);
    assert.deepStrictEqual(t.devices.queueDailyRestarts('2026-10-28 03:45:00'), [], 'only once a day');
    assert.deepStrictEqual(t.devices.queueDailyRestarts('2026-10-29 05:00:00'), [], 'missed window is skipped');
    assert.deepStrictEqual(t.devices.queueDailyRestarts('2026-10-30 03:30:00'), [dev.id]);
  } finally {
    await t.close();
  }
});
