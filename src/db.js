'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '09:00',
  end_time TEXT NOT NULL DEFAULT '18:00',
  grace_minutes INTEGER NOT NULL DEFAULT 15,
  early_exit_grace INTEGER NOT NULL DEFAULT 15,
  half_day_minutes INTEGER NOT NULL DEFAULT 240,
  full_day_minutes INTEGER NOT NULL DEFAULT 480,
  weekly_off TEXT NOT NULL DEFAULT '0',
  ot_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  designation TEXT,
  phone TEXT,
  email TEXT,
  card_no TEXT,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  join_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT,
  mode TEXT NOT NULL DEFAULT 'pull',
  ip TEXT,
  port INTEGER DEFAULT 4370,
  transport TEXT DEFAULT 'tcp',
  comm_key INTEGER DEFAULT 0,
  serial_number TEXT UNIQUE,
  location TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  poll_minutes INTEGER,
  clear_after_sync INTEGER NOT NULL DEFAULT 0,
  firmware TEXT,
  user_count INTEGER,
  log_count INTEGER,
  last_seen TEXT,
  last_sync TEXT,
  last_time_sync TEXT,
  last_error TEXT,
  att_stamp TEXT,
  op_stamp TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS punches (
  id INTEGER PRIMARY KEY,
  employee_code TEXT NOT NULL,
  punch_time TEXT NOT NULL,
  device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  punch_state INTEGER,
  verify_type INTEGER,
  source TEXT NOT NULL DEFAULT 'device',
  note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (employee_code, punch_time, device_id)
);
CREATE INDEX IF NOT EXISTS idx_punches_time ON punches(punch_time);
CREATE INDEX IF NOT EXISTS idx_punches_emp_time ON punches(employee_code, punch_time);

CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY,
  date TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY,
  employee_code TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  leave_type TEXT NOT NULL DEFAULT 'CL',
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_leaves_emp ON leaves(employee_code, from_date);

-- Commands queued for ADMS (push) devices, delivered on /iclock/getrequest
CREATE TABLE IF NOT EXISTS device_commands (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  sent_at TEXT,
  completed_at TEXT
);

-- Fingerprint / face / palm templates captured from devices, so they can be
-- copied to other devices. kind: 'finger' (ZK FP), 'face' (ADMS FACE) or
-- 'bio' (ADMS BIODATA, bio_type 1 = finger, 2/9 = face, 8 = palm).
CREATE TABLE IF NOT EXISTS biometrics (
  id INTEGER PRIMARY KEY,
  employee_code TEXT NOT NULL,
  kind TEXT NOT NULL,
  bio_type INTEGER NOT NULL DEFAULT 0,
  idx INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 1,
  template TEXT NOT NULL,
  extra TEXT,
  source_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (employee_code, kind, bio_type, idx)
);

CREATE TABLE IF NOT EXISTS device_logs (
  id INTEGER PRIMARY KEY,
  device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  if (!db.prepare('SELECT 1 FROM shifts LIMIT 1').get()) {
    db.prepare(
      `INSERT INTO shifts (name, start_time, end_time, grace_minutes, half_day_minutes, full_day_minutes, weekly_off)
       VALUES ('General', '09:30', '18:30', 15, 240, 480, '0')`
    ).run();
  }
  return db;
}

module.exports = { open };
