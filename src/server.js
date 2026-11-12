'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { open } = require('./db');
const { createAuth, ensureAdmin } = require('./auth');
const { createAdmsRouter } = require('./adms/router');
const { createApiRouter } = require('./routes/api');
const { DeviceService } = require('./services/devices');
const { BiometricService } = require('./services/biometrics');
const { isSea, embeddedUi } = require('./runtime');

function createApp({ db, cfg = config, logger = console }) {
  ensureAdmin(db, cfg.adminUser, cfg.adminPassword, logger);
  const auth = createAuth(db, cfg);
  const devices = new DeviceService(db, cfg, logger);
  const biometrics = new BiometricService(db, devices);

  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  // Device endpoints (ADMS push). Routing is case-insensitive, so /iClock works too.
  app.use('/iclock', createAdmsRouter({ db, config: cfg, logger }));

  app.use('/api', createApiRouter({ db, auth, devices, biometrics }));
  if (isSea) app.use(embeddedUi());
  else app.use(express.static(path.join(__dirname, '..', 'public')));

  return { app, devices };
}

function start() {
  let db;
  try {
    db = open(config.dbPath);
  } catch (err) {
    fatal(`Could not open the database ${config.dbPath}: ${err.message}`);
    return null;
  }
  const { app, devices } = createApp({ db });
  devices.start();
  // Under Phusion Passenger (cPanel "Setup Node.js App") the port is managed by
  // Passenger and whatever we pass to listen() is ignored.
  const url = `http://localhost:${config.port}`;
  const server = app.listen(config.port, config.host, () => {
    console.log(`eSSL Attendance running on ${url}`);
    console.log(`ADMS devices: set Cloud Server to this machine's IP, port ${config.port}`);
    console.log(`Data: ${config.dbPath}`);
    if (isSea) console.log('Keep this window open while the app is in use. Close it (or press Ctrl+C) to stop.');
    if (config.openBrowser) openInBrowser(url);
  });
  server.on('error', (err) => {
    const msg = err.code === 'EADDRINUSE'
      ? `Port ${config.port} is already in use. Is the app already running? Otherwise set PORT=3001 (for example) in the .env file next to the program.`
      : `Could not start: ${err.message}`;
    fatal(msg);
  });
  const shutdown = () => {
    devices.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();

function openInBrowser(url) {
  const { exec } = require('node:child_process'); // eslint-disable-line global-require
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best effort; the address is printed anyway
}

/** Print a startup error. The .exe's console window closes on exit, so keep it open until Enter. */
function fatal(msg) {
  console.error(`\n  ${msg}\n`);
  if (isSea && process.stdin.isTTY) {
    console.error('  Press Enter to close this window.');
    process.stdin.once('data', () => process.exit(1));
    return;
  }
  process.exit(1);
}

module.exports = { createApp, start };
