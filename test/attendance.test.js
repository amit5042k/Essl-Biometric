'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateDay, shiftInfo, attendanceDate } = require('../src/services/attendance');
const { startApp } = require('./helpers');

const general = shiftInfo({
  id: 1, name: 'General', start_time: '09:30', end_time: '18:30', grace_minutes: 15, early_exit_grace: 15,
  half_day_minutes: 240, full_day_minutes: 480, weekly_off: '0', ot_enabled: 1,
});
const night = shiftInfo({ ...general, start_time: '22:00', end_time: '06:00' });

const day = (date, punches, extra = {}) => evaluateDay({ date, shift: general, punches, ...extra });

test('present, late, OT', () => {
  const r = day('2024-05-06', ['2024-05-06 09:50:00', '2024-05-06 19:40:00']);
  assert.strictEqual(r.status, 'P');
  assert.strictEqual(r.lateMin, 20);
  assert.strictEqual(r.workMin, 590);
  assert.strictEqual(r.otMin, 50);
});

test('within grace is not late; duplicates collapse', () => {
  const r = day('2024-05-06', ['2024-05-06 09:44:00', '2024-05-06 09:44:30', '2024-05-06 18:30:00']);
  assert.strictEqual(r.lateMin, 0);
  assert.strictEqual(r.punchCount, 2);
});

test('half day, missed punch, absent, weekly off, holiday, leave', () => {
  assert.strictEqual(day('2024-05-06', ['2024-05-06 09:30:00', '2024-05-06 14:00:00']).status, 'HD');
  assert.strictEqual(day('2024-05-06', ['2024-05-06 09:30:00']).status, 'MP');
  assert.strictEqual(day('2024-05-06', []).status, 'A');
  assert.strictEqual(day('2024-05-05', []).status, 'WO'); // Sunday
  assert.strictEqual(day('2024-05-06', [], { isHoliday: true }).status, 'HO');
  assert.strictEqual(day('2024-05-06', [], { leave: { leave_type: 'CL' } }).status, 'L');
});

test('night shift punches map to the shift start date', () => {
  assert.strictEqual(attendanceDate('2024-05-06 21:55:00', night), '2024-05-06');
  assert.strictEqual(attendanceDate('2024-05-07 06:05:00', night), '2024-05-06');
  const r = evaluateDay({ date: '2024-05-06', shift: night, punches: ['2024-05-06 21:55:00', '2024-05-07 06:05:00'] });
  assert.strictEqual(r.status, 'P');
  assert.strictEqual(r.workMin, 490);
  // a general-shift late checkout after midnight still belongs to the previous day
  assert.strictEqual(attendanceDate('2024-05-07 01:30:00', general), '2024-05-06');
});

test('monthly muster report and CSV', async () => {
  const t = await startApp();
  try {
    await t.login();
    await t.call('POST', '/api/employees', { code: '1', name: 'Asha', department: 'Ops' });
    await t.call('POST', '/api/punches', { employee_code: '1', punch_time: '2024-05-06 09:30' });
    await t.call('POST', '/api/punches', { employee_code: '1', punch_time: '2024-05-06 18:30' });
    await t.call('POST', '/api/holidays', { date: '2024-05-01', name: 'May Day' });
    await t.call('POST', '/api/leaves', { employee_code: '1', from_date: '2024-05-07', to_date: '2024-05-08', leave_type: 'SL' });

    const r = await t.call('GET', '/api/reports/monthly?month=2024-05');
    const row = r.data.rows[0];
    assert.strictEqual(row.days[0].status, 'HO');
    assert.strictEqual(row.days[5].status, 'P');
    assert.strictEqual(row.days[6].status, 'L');
    assert.strictEqual(row.summary.present, 1);
    assert.strictEqual(row.summary.leave, 2);
    assert.strictEqual(row.summary.weeklyOff, 4);

    const csv = await t.call('GET', '/api/reports/monthly.csv?month=2024-05');
    assert.match(csv.data, /Code,Name,Department,01,02/);

    const daily = await t.call('GET', '/api/reports/daily?date=2024-05-06');
    assert.strictEqual(daily.data.rows[0].inTime, '09:30');
    assert.strictEqual(daily.data.rows[0].outTime, '18:30');
  } finally {
    await t.close();
  }
});

// School: 08:10–14:40. Non-teaching staff split the day at 11:25; teaching
// staff's first half runs to 11:35 and their second half starts at 11:05.
const school = { id: 9, name: 'School', start_time: '08:10', end_time: '14:40', grace_minutes: 10, early_exit_grace: 5, half_day_minutes: 0, full_day_minutes: 0, weekly_off: '0', ot_enabled: 0 };
const teaching = shiftInfo({ ...school, first_half_end: '11:35', second_half_start: '11:05' });
const nonTeaching = shiftInfo({ ...school, first_half_end: '11:25', second_half_start: '11:25' });
const at = (shift, from, to) => evaluateDay({ date: '2024-05-06', shift, punches: [`2024-05-06 ${from}:00`, `2024-05-06 ${to}:00`] });

test('half days follow separate first-half and second-half times', () => {
  const cases = [
    // in, out, teaching, non-teaching
    ['08:05', '14:42', 'P', 'P'],
    ['08:10', '11:40', 'HD', 'HD'], // left after both first halves ended
    ['08:10', '11:30', 'A', 'HD'], //  teachers must stay till 11:35
    ['11:00', '14:40', 'HD', 'HD'], // came before both second halves started
    ['11:10', '14:40', 'A', 'HD'], //  teachers must be in by 11:05
    ['09:00', '11:00', 'A', 'A'],
  ];
  for (const [i, o, t, n] of cases) {
    assert.strictEqual(at(teaching, i, o).status, t, `teaching ${i}-${o}`);
    assert.strictEqual(at(nonTeaching, i, o).status, n, `non-teaching ${i}-${o}`);
  }
  assert.strictEqual(at(teaching, '08:10', '11:40').remark, 'First half only');
  assert.strictEqual(at(teaching, '11:00', '14:40').remark, 'Second half only');
  assert.strictEqual(at(teaching, '08:10', '14:36').status, 'P', 'early-exit grace applies at the end of the day');
  assert.strictEqual(at(teaching, '08:10', '14:30').status, 'HD');
});

test('late arrival loses the first half beyond the allowance (default: late grace)', () => {
  const r = at(teaching, '08:30', '14:40');
  assert.deepStrictEqual([r.status, r.remark, r.lateMin], ['HD', 'Second half only', 20]);
  const lenient = shiftInfo({ ...school, first_half_end: '11:35', second_half_start: '11:05', half_late_minutes: 30 });
  const r2 = at(lenient, '08:30', '14:40');
  assert.deepStrictEqual([r2.status, r2.lateMin], ['P', 20], 'still marked late');
});

test('half-day times on a night shift and validation', async () => {
  const night = shiftInfo({ ...school, start_time: '22:00', end_time: '06:00', first_half_end: '02:00', second_half_start: '02:00' });
  const n = (a, b) => evaluateDay({ date: '2024-05-06', shift: night, punches: [a, b] }).status;
  assert.strictEqual(n('2024-05-06 21:58:00', '2024-05-07 02:10:00'), 'HD');
  assert.strictEqual(n('2024-05-06 21:58:00', '2024-05-07 06:00:00'), 'P');

  const t = await startApp();
  try {
    await t.login();
    const base = { name: 'Teaching', start_time: '08:10', end_time: '14:40' };
    assert.strictEqual((await t.call('POST', '/api/shifts', { ...base, first_half_end: '11:35' })).status, 400, 'both or neither');
    assert.strictEqual((await t.call('POST', '/api/shifts', { ...base, first_half_end: '15:00', second_half_start: '11:05' })).status, 400, 'inside the shift');
    assert.strictEqual((await t.call('POST', '/api/shifts', { ...base, first_half_end: '11:35', second_half_start: '11:05', half_late_minutes: -3 })).status, 400);
    const ok = await t.call('POST', '/api/shifts', { ...base, first_half_end: '11:35', second_half_start: '11:05' });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));

    // End to end: a teacher who leaves at 11:40 gets a half day in the report.
    await t.call('POST', '/api/employees', { code: '7', name: 'Teacher', shift_id: ok.data.id });
    await t.call('POST', '/api/punches', { employee_code: '7', punch_time: '2024-05-06 08:09' });
    await t.call('POST', '/api/punches', { employee_code: '7', punch_time: '2024-05-06 11:40' });
    const d = (await t.call('GET', '/api/reports/daily?date=2024-05-06')).data.rows[0];
    assert.deepStrictEqual([d.status, d.remark], ['HD', 'First half only']);
  } finally {
    await t.close();
  }
});

test('a shift can be assigned to many selected employees at once', async () => {
  const t = await startApp();
  try {
    await t.login();
    const sid = (await t.call('POST', '/api/shifts', { name: 'Teaching', start_time: '08:10', end_time: '14:40', first_half_end: '11:35', second_half_start: '11:05' })).data.id;
    for (const c of ['1', '2', '3']) await t.call('POST', '/api/employees', { code: c, name: `E${c}` });
    let r = await t.call('POST', '/api/employees/set-shift', { codes: ['1', '3'], shift_id: sid });
    assert.strictEqual(r.data.updated, 2);
    const shifts = Object.fromEntries(t.db.prepare('SELECT code, shift_id FROM employees').all().map((e) => [e.code, e.shift_id]));
    assert.deepStrictEqual(shifts, { 1: sid, 2: null, 3: sid });
    assert.strictEqual((await t.call('POST', '/api/employees/set-shift', { codes: ['1'], shift_id: 999 })).status, 400);
    r = await t.call('POST', '/api/employees/set-shift', { codes: ['1'], shift_id: null });
    assert.strictEqual(r.data.updated, 1, 'back to the default shift');
  } finally {
    await t.close();
  }
});
