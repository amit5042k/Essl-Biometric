'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const { createSimulator } = require('../tools/zk-simulator');
const { parseTemplates } = require('../src/adms/parser');

const tpl = (seed, len = 600) => Buffer.from(Array.from({ length: len }, (_, i) => (i * 7 + seed) & 0xff));

test('parses FP, FACE and BIODATA upload lines', () => {
  const body = [
    'USER PIN=7\tName=Ravi',
    'FP PIN=7\tFID=3\tSize=8\tValid=1\tTMP=AAECAw==',
    'FACE PIN=7\tFID=0\tSIZE=4\tVALID=1\tTMP=BAUG',
    'BIODATA Pin=7\tNo=0\tIndex=1\tValid=1\tDuress=0\tType=9\tMajorVer=5\tMinorVer=8\tFormat=0\tTmp=CQkJ',
  ].join('\n');
  const t = parseTemplates(body, 'OPERLOG');
  assert.deepStrictEqual(t.map((x) => [x.code, x.kind, x.idx, x.bioType]), [['7', 'finger', 3, undefined], ['7', 'face', 0, undefined], ['7', 'bio', 1, 9]]);
  assert.deepStrictEqual(t[2].extra, { No: 0, Index: 1, Duress: 0, MajorVer: 5, MinorVer: 8, Format: 0 });
  // table=BIODATA lines can come without the prefix
  assert.strictEqual(parseTemplates('Pin=8\tNo=6\tIndex=0\tValid=1\tType=1\tTmp=QUJD', 'BIODATA')[0].idx, 600);
});

test('copies fingerprints of selected employees between TCP/IP devices', async () => {
  const a = createSimulator({
    serialNumber: 'SRC',
    users: [{ userId: '1', name: 'Asha' }, { userId: '2', name: 'Rahul' }, { userId: '3', name: 'Priya' }],
    templates: [
      { uid: 1, fid: 0, template: tpl(1) }, { uid: 1, fid: 5, template: tpl(2, 900) },
      { uid: 2, fid: 0, template: tpl(3) },
      { uid: 3, fid: 9, template: tpl(4) },
    ],
  });
  // Target already knows Priya under another internal uid.
  const b = createSimulator({ serialNumber: 'DST', users: [{ userId: '50', name: 'Other' }, { userId: '3', name: 'Priya' }] });
  const pa = await a.listen(0, '127.0.0.1');
  const pb = await b.listen(0, '127.0.0.1');
  const t = await startApp();
  try {
    await t.login();
    const src = (await t.call('POST', '/api/devices', { name: 'Gate', mode: 'pull', ip: '127.0.0.1', port: pa })).data.id;
    const dst = (await t.call('POST', '/api/devices', { name: 'Office', mode: 'pull', ip: '127.0.0.1', port: pb })).data.id;
    await t.call('POST', '/api/devices/' + src + '/sync');

    const r = await t.call('POST', '/api/biometrics/copy', { codes: ['1', '3'], sourceDeviceId: src, targetDeviceIds: [dst], types: ['finger'] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.fetched.saved, 3);
    assert.deepStrictEqual(r.data.results[0].employees.map((e) => [e.code, e.status, e.finger]), [['1', 'copied', 2], ['3', 'copied', 1]]);

    // Only the selected employees reach the target, with byte-identical templates.
    const userIds = b.state.users.map((u) => u.userId).sort();
    assert.deepStrictEqual(userIds, ['1', '3', '50']);
    const asha = b.state.users.find((u) => u.userId === '1');
    const priya = b.state.users.find((u) => u.userId === '3');
    assert.strictEqual(asha.name, 'Asha');
    assert.strictEqual(priya.uid, 2, 'existing user keeps its uid');
    const ashaFp = b.state.templates.filter((x) => x.uid === asha.uid).sort((x, y) => x.fid - y.fid);
    assert.deepStrictEqual(ashaFp.map((x) => x.fid), [0, 5]);
    assert.ok(ashaFp[1].template.equals(tpl(2, 900)));
    assert.ok(b.state.templates.find((x) => x.uid === 2 && x.fid === 9).template.equals(tpl(4)));
    assert.ok(!b.state.templates.some((x) => x.template.equals(tpl(3))), 'unselected employee not copied');

    const sum = (await t.call('GET', '/api/biometrics/summary')).data;
    assert.deepStrictEqual(sum['1'], { finger: 2, face: 0, palm: 0, other: 0 });
    assert.strictEqual(sum['2'], undefined, 'only selected employees are fetched');

    const del = await t.call('DELETE', '/api/biometrics/1');
    assert.strictEqual(del.data.removed, 2);
  } finally {
    await t.close();
    await a.close();
    await b.close();
  }
});

test('ADMS templates are stored and copied to ADMS and TCP/IP devices', async () => {
  const sim = createSimulator({ serialNumber: 'PULL1' });
  const port = await sim.listen(0, '127.0.0.1');
  const t = await startApp({ adms: { autoApprove: true, timeZone: '330', delay: 10 } });
  try {
    await t.login();
    const fp = tpl(9, 700).toString('base64');
    const up = [
      'USER PIN=7\tName=Ravi Kumar\tPri=0\tPasswd=\tCard=\tGrp=1',
      `FP PIN=7\tFID=6\tSize=${fp.length}\tValid=1\tTMP=${fp}`,
      'BIODATA Pin=7\tNo=0\tIndex=0\tValid=1\tDuress=0\tType=9\tMajorVer=5\tMinorVer=8\tFormat=0\tTmp=RkFDRQ==',
    ].join('\n');
    let r = await t.call('POST', '/iclock/cdata?SN=ORCUS1&table=OPERLOG&Stamp=2', up);
    assert.strictEqual(r.data, 'OK: 3');
    const orcus1 = t.db.prepare(`SELECT id FROM devices WHERE serial_number = 'ORCUS1'`).get().id;
    await t.call('GET', '/iclock/cdata?SN=ORCUS2&options=all');
    const orcus2 = t.db.prepare(`SELECT id FROM devices WHERE serial_number = 'ORCUS2'`).get().id;
    const pull = (await t.call('POST', '/api/devices', { name: 'Classic', mode: 'pull', ip: '127.0.0.1', port })).data.id;

    r = await t.call('POST', '/api/biometrics/copy', { codes: ['7'], sourceDeviceId: orcus1, targetDeviceIds: [orcus2, pull], types: ['finger', 'face'] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const [toPush, toPull] = r.data.results;
    assert.deepStrictEqual([toPush.employees[0].status, toPush.employees[0].finger, toPush.employees[0].face], ['queued', 1, 1]);

    // ADMS target gets the user, then each template in the protocol's format.
    r = await t.call('GET', '/iclock/getrequest?SN=ORCUS2');
    const cmds = r.data.trim().split('\r\n').map((l) => l.replace(/^C:\d+:/, ''));
    assert.match(cmds[0], /^DATA UPDATE USERINFO PIN=7\tName=Ravi Kumar/);
    assert.ok(cmds.includes('DATA UPDATE BIODATA Pin=7\tNo=0\tIndex=0\tValid=1\tDuress=0\tType=9\tMajorVer=5\tMinorVer=8\tFormat=0\tTmp=RkFDRQ=='), cmds.join('\n'));
    assert.ok(cmds.includes(`DATA UPDATE FINGERTMP PIN=7\tFID=6\tSize=${fp.length}\tValid=1\tTMP=${fp}`));

    // TCP/IP target: fingerprint copied, face reported as not possible.
    assert.strictEqual(toPull.employees[0].status, 'copied');
    assert.match(toPull.employees[0].note, /face\/palm/);
    const u = sim.state.users.find((x) => x.userId === '7');
    assert.strictEqual(u.name, 'Ravi Kumar');
    assert.ok(sim.state.templates.find((x) => x.uid === u.uid && x.fid === 6).template.equals(tpl(9, 700)));

    // Nothing stored -> reported, not silently ignored.
    await t.call('POST', '/api/employees', { code: '8', name: 'No Prints' });
    r = await t.call('POST', '/api/biometrics/copy', { codes: ['8'], targetDeviceIds: [orcus2] });
    assert.strictEqual(r.data.results[0].employees[0].note, 'No stored biometrics');
  } finally {
    await t.close();
    await sim.close();
  }
});
