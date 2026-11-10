'use strict';

// The server's own clock is UTC (typical VPS / shared hosting), the machines
// show India time. TIMEZONE (default Asia/Kolkata) must win.
process.env.TZ = 'UTC';
delete process.env.TIMEZONE;

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const T = require('../src/util/time');
const { startApp } = require('./helpers');
const { createSimulator } = require('../tools/zk-simulator');

function indiaNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

test('app runs on TIMEZONE, not on the server clock zone', () => {
  assert.strictEqual(config.timezone, 'Asia/Kolkata');
  assert.ok(Math.abs(T.toMinutes(T.nowLocal()) - T.toMinutes(indiaNow())) <= 1 / 30, `${T.nowLocal()} vs ${indiaNow()}`);
  assert.strictEqual(config.adms.timeZone, '330', 'ADMS offset derived from TIMEZONE');
});

/** What the simulated machine shows, formatted the way it does (process-local wall clock). */
function deviceShows(sim) {
  return T.nowLocal(new Date(Date.now() + sim.state.clockOffsetMs));
}

test('a machine on correct India time is not "corrected" on a UTC server', async () => {
  // The simulator renders its clock in the process time zone; offset it so it
  // shows India wall time whatever that zone is.
  const offset = Math.round((T.toMinutes(indiaNow()) - T.toMinutes(T.nowLocal())) * 60);
  const sim = createSimulator({ clockOffsetSeconds: offset });
  assert.ok(Math.abs(T.toMinutes(deviceShows(sim)) - T.toMinutes(indiaNow())) <= 1 / 30);
  const port = await sim.listen(0, '127.0.0.1');
  const t = await startApp({ autoTimeSync: true, timeDriftSeconds: 60 });
  try {
    await t.login();
    t.db.prepare('SELECT 1').get();
    const id = (await t.call('POST', '/api/devices', { name: 'P', mode: 'pull', ip: '127.0.0.1', port })).data.id;
    t.db.prepare('UPDATE devices SET last_time_sync = ? WHERE id = ?').run(T.nowLocal(), id);
    const r = await t.call('POST', `/api/devices/${id}/sync`);
    assert.ok(Math.abs(r.data.drift) <= 2, `drift ${r.data.drift}`);
    assert.strictEqual(r.data.timeSynced, false);
    // and a forced "Sync time" writes India time, not UTC
    await t.call('POST', `/api/devices/${id}/time`);
    const diff = (T.toMinutes(deviceShows(sim)) - T.toMinutes(indiaNow())) * 60;
    assert.ok(Math.abs(diff) <= 2, `device ${deviceShows(sim)} vs India ${indiaNow()}`);
  } finally {
    await t.close();
    await sim.close();
  }
});
