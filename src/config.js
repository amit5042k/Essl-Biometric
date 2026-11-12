'use strict';

const path = require('node:path');
const { appRoot, isSea } = require('./runtime');

try {
  process.loadEnvFile(path.join(appRoot, '.env'));
} catch {
  // .env is optional
}

const env = process.env;
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

// Machines keep local wall-clock time, so the app must use the machines' time
// zone, not the server's (VPS and shared hosts usually run on UTC). Node
// applies a change to process.env.TZ immediately.
function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
const timezone = env.TIMEZONE || 'Asia/Kolkata';
if (validZone(timezone)) {
  process.env.TZ = timezone;
} else {
  console.warn(`[config] TIMEZONE "${timezone}" is not a valid time zone; using the server's time zone`);
}

module.exports = {
  timezone: process.env.TZ,
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  dbPath: env.DB_PATH || path.join(appRoot, 'data', 'attendance.db'),
  // Open the browser when the .exe starts (OPEN_BROWSER=false to turn off)
  openBrowser: bool(env.OPEN_BROWSER, isSea),

  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || 'admin123',
  sessionHours: Number(env.SESSION_HOURS) || 12,

  // ADMS / iClock push (Orcus and newer Classic firmware: "Cloud Server Setting")
  adms: {
    // Accept data from devices that are not registered yet. When false, unknown
    // serial numbers are added as disabled devices and must be enabled in the UI.
    autoApprove: bool(env.ADMS_AUTO_APPROVE, false),
    // Server time zone sent to the device (hours, or minutes for e.g. 330 = +05:30)
    // Defaults to the offset of TIMEZONE (330 for Asia/Kolkata).
    timeZone: env.ADMS_TIMEZONE || String(-new Date().getTimezoneOffset()),
    delay: Number(env.ADMS_DELAY) || 10,
  },

  // Default polling interval for pull (TCP/UDP 4370) devices, in minutes
  defaultPollMinutes: Number(env.POLL_MINUTES) || 5,
  // Sync device clocks once a day for pull devices
  autoTimeSync: bool(env.AUTO_TIME_SYNC, true),
  // Correct a TCP/IP device's clock whenever it is off by more than this (seconds)
  timeDriftSeconds: Number(env.TIME_DRIFT_SECONDS) || 60,
};
