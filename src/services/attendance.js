'use strict';

const T = require('../util/time');

// Punches closer than this to the previous one are treated as accidental repeats.
const DUPLICATE_WINDOW_MIN = 1;
// A shift's attendance "day" starts this many minutes before the shift start,
// so a 09:00 shift collects punches from 05:00 to 05:00 the next day and a
// 22:00 night shift collects punches from 18:00 to 18:00 the next day.
const DAY_LEAD_MIN = 240;

const STATUS_LABELS = {
  P: 'Present',
  A: 'Absent',
  HD: 'Half Day',
  MP: 'Missed Punch',
  WO: 'Weekly Off',
  HO: 'Holiday',
  L: 'Leave',
};

function shiftInfo(shift) {
  const start = T.hhmmToMinutes(shift.start_time);
  let end = T.hhmmToMinutes(shift.end_time);
  if (end <= start) end += 1440; // overnight shift
  return {
    ...shift,
    startMin: start,
    endMin: end,
    durationMin: end - start,
    lead: start - DAY_LEAD_MIN,
    weeklyOff: String(shift.weekly_off ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(Number),
  };
}

/** Attendance date a punch belongs to for a given shift. */
function attendanceDate(punchTime, shift) {
  return T.fromMinutes(T.toMinutes(punchTime) - shift.lead).slice(0, 10);
}

/**
 * Evaluates one employee-day.
 * @returns {{status, inTime, outTime, workMin, lateMin, earlyMin, otMin, punches, remark}}
 */
function evaluateDay({ date, shift, punches, isHoliday, holidayName, leave, isToday = false }) {
  const dayStart = T.toMinutes(date);
  const shiftStart = dayStart + shift.startMin;
  const shiftEnd = dayStart + shift.endMin;
  const isWeeklyOff = shift.weeklyOff.includes(T.weekday(date));

  const times = [];
  for (const p of punches) {
    const m = T.toMinutes(p);
    if (!times.length || m - times[times.length - 1] >= DUPLICATE_WINDOW_MIN) times.push(m);
  }

  const r = {
    date,
    status: 'A',
    inTime: null,
    outTime: null,
    workMin: 0,
    lateMin: 0,
    earlyMin: 0,
    otMin: 0,
    punchCount: times.length,
    punches: times.map((m) => T.fromMinutes(m).slice(11, 16)),
    remark: '',
  };

  if (!times.length) {
    if (isHoliday) {
      r.status = 'HO';
      r.remark = holidayName || '';
    } else if (isWeeklyOff) {
      r.status = 'WO';
    } else if (leave) {
      r.status = 'L';
      r.remark = leave.leave_type;
    }
    return r;
  }

  const first = times[0];
  const last = times[times.length - 1];
  r.inTime = T.fromMinutes(first).slice(11, 16);

  if (first > shiftStart + shift.grace_minutes) r.lateMin = first - shiftStart;

  if (times.length === 1) {
    // While the day is still running a single punch just means "checked in".
    r.status = isToday ? 'P' : 'MP';
    r.remark = isToday ? 'Checked in' : 'Out punch missing';
  } else {
    r.outTime = T.fromMinutes(last).slice(11, 16);
    r.workMin = last - first;
    if (last < shiftEnd - shift.early_exit_grace) r.earlyMin = shiftEnd - last;
    if (shift.ot_enabled) r.otMin = Math.max(0, r.workMin - shift.durationMin);

    if (r.workMin >= shift.full_day_minutes) r.status = 'P';
    else if (r.workMin >= shift.half_day_minutes) r.status = 'HD';
    else {
      r.status = 'A';
      r.remark = 'Insufficient work hours';
    }
  }

  if (isHoliday || isWeeklyOff) {
    if (shift.ot_enabled) r.otMin = r.workMin;
    r.remark = isHoliday ? `Worked on holiday${holidayName ? ` (${holidayName})` : ''}` : 'Worked on weekly off';
  }
  // Punch times carry seconds; report whole minutes.
  for (const k of ['workMin', 'lateMin', 'earlyMin', 'otMin']) r[k] = Math.round(r[k]);
  return r;
}

/**
 * Builds the attendance grid for every (selected) employee over a date range.
 * @returns {{ dates: string[], rows: {employee, days: object[]}[] }}
 */
function buildAttendance(db, { from, to, employeeCode, department, includeInactive = false }) {
  const shifts = new Map(db.prepare('SELECT * FROM shifts').all().map((s) => [s.id, shiftInfo(s)]));
  const defaultShift = [...shifts.values()].sort((a, b) => a.id - b.id)[0];

  const where = [];
  const args = [];
  if (!includeInactive) where.push('active = 1');
  if (employeeCode) { where.push('code = ?'); args.push(employeeCode); }
  if (department) { where.push('department = ?'); args.push(department); }
  const employees = db
    .prepare(`SELECT * FROM employees ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY code`)
    .all(...args);

  const holidays = new Map(
    db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ?').all(from, to).map((h) => [h.date, h.name])
  );

  const punchRows = db
    .prepare(
      `SELECT employee_code, punch_time FROM punches
       WHERE punch_time >= ? AND punch_time < ? ORDER BY punch_time`
    )
    .all(`${T.addDays(from, -1)} 00:00:00`, `${T.addDays(to, 2)} 00:00:00`);
  const punchesByEmp = new Map();
  for (const p of punchRows) {
    if (!punchesByEmp.has(p.employee_code)) punchesByEmp.set(p.employee_code, []);
    punchesByEmp.get(p.employee_code).push(p.punch_time);
  }

  const leaves = db
    .prepare('SELECT * FROM leaves WHERE from_date <= ? AND to_date >= ?')
    .all(to, from);

  const today = T.nowLocal().slice(0, 10);
  const dates = T.dateRange(from, to);

  const rows = employees.map((emp) => {
    const shift = shifts.get(emp.shift_id) || defaultShift;
    const byDate = new Map();
    for (const p of punchesByEmp.get(emp.code) || []) {
      const d = attendanceDate(p, shift);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(p);
    }
    const empLeaves = leaves.filter((l) => l.employee_code === emp.code);

    const days = dates.map((date) => {
      if (date > today || (emp.join_date && date < emp.join_date)) {
        return { date, status: '', punches: [], workMin: 0, lateMin: 0, earlyMin: 0, otMin: 0 };
      }
      return evaluateDay({
        date,
        shift,
        punches: byDate.get(date) || [],
        isHoliday: holidays.has(date),
        holidayName: holidays.get(date),
        leave: empLeaves.find((l) => l.from_date <= date && l.to_date >= date),
        isToday: date === today,
      });
    });
    return { employee: { ...emp, shift_name: shift && shift.name }, days };
  });

  return { dates, rows };
}

function summarize(days) {
  const s = { present: 0, absent: 0, halfDay: 0, missedPunch: 0, weeklyOff: 0, holiday: 0, leave: 0, late: 0, earlyExit: 0, workMin: 0, otMin: 0 };
  for (const d of days) {
    switch (d.status) {
      case 'P': s.present += 1; break;
      case 'HD': s.present += 0.5; s.absent += 0.5; s.halfDay += 1; break;
      case 'MP': s.present += 1; s.missedPunch += 1; break;
      case 'A': s.absent += 1; break;
      case 'WO': s.weeklyOff += 1; break;
      case 'HO': s.holiday += 1; break;
      case 'L': s.leave += 1; break;
      default: break;
    }
    if (d.lateMin > 0) s.late += 1;
    if (d.earlyMin > 0) s.earlyExit += 1;
    s.workMin += d.workMin || 0;
    s.otMin += d.otMin || 0;
  }
  s.payableDays = s.present + s.weeklyOff + s.holiday + s.leave;
  return s;
}

module.exports = { buildAttendance, evaluateDay, shiftInfo, attendanceDate, summarize, STATUS_LABELS };
