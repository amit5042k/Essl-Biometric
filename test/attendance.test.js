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
