'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { open } = require('./db');
const { createAuth, ensureAdmin } = require('./auth');
const { createAdmsRouter } = require('./adms/router');
const { createApiRouter } = require('./routes/api');
const { DeviceService } = require('./services/devices');

function createApp({ db, cfg = config, logger = console }) {
  ensureAdmin(db, cfg.adminUser, cfg.adminPassword, logger);
  const auth = createAuth(db, cfg);
  const devices = new DeviceService(db, cfg, logger);

  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  // Device endpoints (ADMS push). Routing is case-insensitive, so /iClock works too.
  app.use('/iclock', createAdmsRouter({ db, config: cfg, logger }));

  app.use('/api', createApiRouter({ db, auth, devices }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return { app, devices };
}

if (require.main === module) {
  const db = open(config.dbPath);
  const { app, devices } = createApp({ db });
  devices.start();
  const server = app.listen(config.port, config.host, () => {
    console.log(`eSSL Attendance running on http://localhost:${config.port}`);
    console.log(`ADMS devices: set Cloud Server to this machine's IP, port ${config.port}`);
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
}

module.exports = { createApp };
