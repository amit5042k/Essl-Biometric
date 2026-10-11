#!/usr/bin/env node
'use strict';

/**
 * Pretends to be an ADMS (push) terminal such as an eSSL Orcus:
 * handshakes, uploads a few attendance logs and a user, then polls for commands.
 *
 *   node tools/adms-simulator.js [serverUrl] [serialNumber]
 */
const server = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const sn = process.argv[3] || 'ORCUS0001';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

async function req(method, path, body) {
  const res = await fetch(`${server}/iclock/${path}`, { method, body, headers: { 'content-type': 'text/plain' } });
  const text = await res.text();
  console.log(`${method} /iclock/${path} -> ${res.status} ${text.split('\n')[0]}`);
  return { status: res.status, text };
}

(async () => {
  const hs = await req('GET', `cdata?SN=${sn}&options=all&pushver=2.4.1&language=69`);
  if (hs.status !== 200) {
    console.log('Device is not approved yet - enable it on the Devices page and run again.');
    return;
  }
  const now = new Date();
  const morning = new Date(now); morning.setHours(9, 12, 0, 0);
  await req('POST', `cdata?SN=${sn}&table=OPERLOG&Stamp=1`, 'USER PIN=301\tName=Sanjay Gupta\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000100000000\n');
  await req('POST', `cdata?SN=${sn}&table=ATTLOG&Stamp=1`, `301\t${stamp(morning)}\t0\t15\t0\t0\t0\n`);
  const { text } = await req('GET', `getrequest?SN=${sn}&INFO=Ver 8.0.4.2,1,0,1,127.0.0.1`);
  for (const m of text.matchAll(/^C:(\d+):(.*)$/gm)) {
    console.log(`  executing command #${m[1]}: ${m[2]}`);
    await req('POST', `devicecmd?SN=${sn}`, `ID=${m[1]}&Return=0&CMD=${m[2].split(' ')[0]}\n`);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
