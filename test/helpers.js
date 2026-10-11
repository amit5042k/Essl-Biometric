'use strict';

const { open } = require('../src/db');
const { createApp } = require('../src/server');

const silent = { log() {}, error() {}, warn() {} };

async function startApp(overrides = {}) {
  const db = open(':memory:');
  const cfg = {
    adminUser: 'admin',
    adminPassword: 'secret1',
    sessionHours: 1,
    adms: { autoApprove: false, timeZone: '330', delay: 10 },
    defaultPollMinutes: 5,
    autoTimeSync: false,
    ...overrides,
  };
  const { app, devices } = createApp({ db, cfg, logger: silent });
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }

  return {
    db,
    devices,
    base,
    call,
    login: () => call('POST', '/api/login', { username: 'admin', password: 'secret1' }),
    close: () => new Promise((r) => server.close(r)).then(() => db.close()),
  };
}

module.exports = { startApp };
