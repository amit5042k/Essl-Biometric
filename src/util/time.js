'use strict';

// All device times are local wall-clock strings ("YYYY-MM-DD HH:MM:SS").
// We do arithmetic on them as if they were UTC so DST/TZ never shifts values.

const pad = (n) => String(n).padStart(2, '0');

function toMinutes(str) {
  const [d, t = '00:00:00'] = str.split(/[ T]/);
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, s = 0] = t.split(':').map(Number);
  return Date.UTC(y, mo - 1, da, h, mi, s) / 60000;
}

function fromMinutes(min) {
  const d = new Date(Math.round(min * 60000));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function addDays(dateStr, n) {
  return fromMinutes(toMinutes(dateStr) + n * 1440).slice(0, 10);
}

function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function weekday(dateStr) {
  return new Date(toMinutes(dateStr) * 60000).getUTCDay();
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDuration(min) {
  if (min == null || Number.isNaN(min)) return '';
  const m = Math.max(0, Math.round(min));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function nowLocal(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/** Normalises the many timestamp formats devices send into "YYYY-MM-DD HH:MM:SS". */
function normalizeTimestamp(s) {
  const m = String(s || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${m[5]}:${m[6] || '00'}`;
}

/** ADMS_TIMEZONE ("330", "5.5", "+0530", "-3") -> offset in minutes. */
function tzMinutes(value) {
  const s = String(value ?? '').trim();
  const hhmm = s.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (hhmm) return (hhmm[1] === '-' ? -1 : 1) * (Number(hhmm[2]) * 60 + Number(hhmm[3]));
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.abs(n) <= 14 ? Math.round(n * 60) : Math.round(n); // small values are hours
}

/** 330 -> "+0530" */
function tzString(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const m = Math.abs(minutes);
  return `${sign}${pad(Math.floor(m / 60))}${pad(m % 60)}`;
}

/** Seconds -> "3 min 12 s" */
function formatDrift(seconds) {
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

module.exports = {
  tzMinutes,
  tzString,
  formatDrift,
  pad,
  toMinutes,
  fromMinutes,
  hhmmToMinutes,
  addDays,
  dateRange,
  weekday,
  daysInMonth,
  formatDuration,
  nowLocal,
  isDate,
  normalizeTimestamp,
};
