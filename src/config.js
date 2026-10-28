'use strict';

const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // .env is optional
}

const env = process.env;
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

module.exports = {
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'attendance.db'),

  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || 'admin123',
  sessionHours: Number(env.SESSION_HOURS) || 12,

  // ADMS / iClock push (Orcus and newer Classic firmware: "Cloud Server Setting")
  adms: {
    // Accept data from devices that are not registered yet. When false, unknown
    // serial numbers are added as disabled devices and must be enabled in the UI.
    autoApprove: bool(env.ADMS_AUTO_APPROVE, false),
    // Server time zone sent to the device (hours, or minutes for e.g. 330 = +05:30)
    timeZone: env.ADMS_TIMEZONE || '330',
    delay: Number(env.ADMS_DELAY) || 10,
  },

  // Default polling interval for pull (TCP/UDP 4370) devices, in minutes
  defaultPollMinutes: Number(env.POLL_MINUTES) || 5,
  // Sync device clocks once a day for pull devices
  autoTimeSync: bool(env.AUTO_TIME_SYNC, true),
  // Correct a TCP/IP device's clock whenever it is off by more than this (seconds)
  timeDriftSeconds: Number(env.TIME_DRIFT_SECONDS) || 60,
};
