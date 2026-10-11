'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

test('ADMS push device: approval, handshake, logs, users, commands', async () => {
  const t = await startApp();
  try {
    // Unknown device is registered but not acknowledged until approved.
    let r = await t.call('GET', '/iclock/cdata?SN=ORCUS123&options=all&pushver=2.4.1');
    assert.strictEqual(r.status, 403);
    const dev = t.db.prepare('SELECT * FROM devices WHERE serial_number = ?').get('ORCUS123');
    assert.strictEqual(dev.enabled, 0);

    await t.login();
    r = await t.call('PUT', `/api/devices/${dev.id}`, { enabled: 1, name: 'Main Gate Orcus' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));

    r = await t.call('GET', '/iClock/cdata?SN=ORCUS123&options=all');
    assert.strictEqual(r.status, 200);
    assert.match(r.data, /GET OPTION FROM: ORCUS123/);
    assert.match(r.data, /ATTLOGStamp=None/);
    assert.match(r.data, /TimeZone=330/);

    const body = '101\t2024-05-06 09:01:00\t0\t15\t0\t0\n101\t2024-05-06 18:30:00\t1\t15\t0\t0\n102\t2024/05/06 10:15\t0\t1\n';
    r = await t.call('POST', '/iclock/cdata?SN=ORCUS123&table=ATTLOG&Stamp=9999', body, { 'content-type': 'text/plain' });
    assert.strictEqual(r.data, 'OK: 3');
    // re-sent logs are de-duplicated
    r = await t.call('POST', '/iclock/cdata?SN=ORCUS123&table=ATTLOG&Stamp=9999', body);
    assert.strictEqual(t.db.prepare('SELECT COUNT(*) n FROM punches').get().n, 3);
    assert.strictEqual(t.db.prepare('SELECT att_stamp FROM devices WHERE id = ?').get(dev.id).att_stamp, '9999');

    r = await t.call('POST', '/iclock/cdata?SN=ORCUS123&table=OPERLOG&Stamp=5', 'USER PIN=101\tName=Asha Verma\tPri=0\tPasswd=\tCard=[0012345]\tGrp=1\nOPLOG 4\t0\t2024-05-06 09:00:00\t0\t0\t0\t0\n');
    assert.strictEqual(r.data, 'OK: 2');
    assert.strictEqual(t.db.prepare(`SELECT name FROM employees WHERE code = '101'`).get().name, 'Asha Verma');

    // Upload employee -> command queued -> delivered on getrequest -> acknowledged
    r = await t.call('POST', `/api/devices/${dev.id}/upload-employees`, { codes: ['102'] });
    assert.strictEqual(r.data.total, 1);
    r = await t.call('GET', '/iclock/getrequest?SN=ORCUS123&INFO=Ver 8.0.4,25,10,1234,192.168.1.50');
    const m = r.data.match(/^C:(\d+):DATA UPDATE USERINFO PIN=102\tName=Employee 102/);
    assert.ok(m, r.data);
    r = await t.call('GET', '/iclock/getrequest?SN=ORCUS123');
    assert.strictEqual(r.data, 'OK');
    await t.call('POST', '/iclock/devicecmd?SN=ORCUS123', `ID=${m[1]}&Return=0&CMD=DATA\n`);
    assert.strictEqual(t.db.prepare('SELECT status FROM device_commands WHERE id = ?').get(Number(m[1])).status, 'done');
    assert.strictEqual(t.db.prepare('SELECT user_count FROM devices WHERE id = ?').get(dev.id).user_count, 25);
  } finally {
    await t.close();
  }
});

test('ADMS auto-approve accepts new devices immediately', async () => {
  const t = await startApp({ adms: { autoApprove: true, timeZone: '5.5', delay: 10 } });
  try {
    const r = await t.call('POST', '/iclock/cdata?SN=CLASSIC9&table=ATTLOG', '7\t2024-05-06 09:01:00\t0\t1\n');
    assert.strictEqual(r.data, 'OK: 1');
  } finally {
    await t.close();
  }
});
