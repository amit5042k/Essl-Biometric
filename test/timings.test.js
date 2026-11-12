'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

// Teaching shift 08:10–14:40 (halves 11:35 / 11:05), then several timing
// changes during November, including a week with morning + evening sessions.
async function setup(t) {
  await t.login();
  const base = { start_time: '08:10', end_time: '14:40', grace_minutes: 10, early_exit_grace: 5, weekly_off: '', first_half_end: '11:35', second_half_start: '11:05' };
  const teaching = (await t.call('POST', '/api/shifts', { name: 'Teaching', ...base })).data.id;
  const office = (await t.call('POST', '/api/shifts', { name: 'Non-teaching', ...base, first_half_end: '11:25', second_half_start: '11:25' })).data.id;
  const add = async (body) => {
    const r = await t.call('POST', '/api/shift-timings', body);
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    return r.data.ids;
  };
  await add({ shift_ids: [teaching, office], from_date: '2025-11-03', to_date: '2025-11-08', start_time: '08:30', end_time: '14:30', first_half_end: '11:20', second_half_start: '11:20', note: 'Winter timing' });
  await add({ shift_ids: [teaching, office], from_date: '2025-11-10', to_date: '2025-11-15', start_time: '08:00', end_time: '12:00', session2_start: '16:00', session2_end: '19:00', note: 'Dual shift' });
  await add({ shift_ids: [teaching], from_date: '2025-11-12', to_date: '2025-11-12', start_time: '08:00', end_time: '11:00', first_half_end: '09:30', second_half_start: '09:30', note: 'Exam day' });
  await add({ shift_ids: [teaching], from_date: '2025-11-17', start_time: '08:10', end_time: '14:00', note: 'New timing' });
  await t.call('POST', '/api/employees', { code: 'T1', name: 'Teacher', shift_id: teaching });
  return { teaching, office };
}

async function punch(t, day, ...times) {
  for (const hm of times) await t.call('POST', '/api/punches', { employee_code: 'T1', punch_time: `2025-11-${day} ${hm}` });
}

test('each day is judged by the timing in force that day', async () => {
  const t = await startApp();
  try {
    await setup(t);
    await punch(t, '03', '08:28', '14:31'); // winter timing: on time (base shift would call this late)
    await punch(t, '10', '07:58', '12:01', '15:59', '19:02'); // both sessions
    await punch(t, '11', '07:58', '12:01'); // morning only
    await punch(t, '12', '07:59', '11:01'); // exam day overrides the dual week
    await punch(t, '13', '07:58', '12:01', '16:30', '19:00'); // late for the evening
    await punch(t, '14', '07:58', '12:01', '16:00'); // evening out punch missing
    await punch(t, '17', '08:10', '14:01'); // open-ended new timing (base: early exit)
    await punch(t, '18', '08:10', '11:40'); // new timing keeps the shift's half-day times

    const m = (await t.call('GET', '/api/reports/monthly?month=2025-11&code=T1')).data;
    const day = (d) => m.rows[0].days[Number(d) - 1];
    const expect = {
      '03': ['P', '08:30–14:30', 'Winter timing', ''],
      '10': ['P', '08:00–12:00 + 16:00–19:00', 'Dual shift', ''],
      '11': ['HD', '08:00–12:00 + 16:00–19:00', 'Dual shift', 'Evening: absent'],
      '12': ['P', '08:00–11:00', 'Exam day', ''],
      '13': ['HD', '08:00–12:00 + 16:00–19:00', 'Dual shift', 'Evening: late 30 min'],
      '14': ['HD', '08:00–12:00 + 16:00–19:00', 'Dual shift', 'Evening: one punch only'],
      '17': ['P', '08:10–14:00', 'New timing', ''],
      '18': ['HD', '08:10–14:00', 'New timing', 'First half only'],
      '01': ['A', '08:10–14:40', '', ''], // before any change: the shift itself
    };
    for (const [d, [status, timing, note, remark]] of Object.entries(expect)) {
      const x = day(d);
      assert.deepStrictEqual([x.status, x.timing, x.timingNote, x.remark], [status, timing, note, remark], `Nov ${d}`);
    }
    // Sessions exclude the break from work time: 4h03 + 3h03.
    assert.strictEqual(day('10').workMin, 243 + 183);
    assert.strictEqual(day('13').lateMin, 30);
  } finally {
    await t.close();
  }
});

test('timing changes are checked and can be edited or removed', async () => {
  const t = await startApp();
  try {
    const { teaching } = await setup(t);
    const post = (b) => t.call('POST', '/api/shift-timings', { shift_ids: [teaching], from_date: '2025-11-20', start_time: '08:00', end_time: '12:00', ...b });
    assert.strictEqual((await post({ to_date: '2025-11-19' })).status, 400, 'to before from');
    assert.strictEqual((await post({ from_date: '2025-11-31' })).status, 400, 'impossible date');
    assert.strictEqual((await post({ session2_start: '16:00' })).status, 400, 'evening start without end');
    assert.strictEqual((await post({ session2_start: '11:00', session2_end: '13:00' })).status, 400, 'sessions overlap');
    const r = await post({ start_time: '16:00', end_time: '19:00' });
    assert.strictEqual(r.status, 400, 'inherited half-day times 11:35/11:05 do not fit 16:00–19:00');
    assert.match(r.data.error, /set the half-day times/);
    assert.strictEqual((await t.call('POST', '/api/shift-timings', { shift_ids: [], from_date: '2025-11-20', start_time: '08:00', end_time: '12:00' })).status, 400);

    const list = (await t.call('GET', '/api/shift-timings')).data;
    assert.strictEqual(list.length, 6, 'two shifts x two ranges + exam day + new timing');
    const exam = list.find((x) => x.note === 'Exam day');
    assert.strictEqual(exam.shift_name, 'Teaching');
    assert.strictEqual((await t.call('PUT', `/api/shift-timings/${exam.id}`, { end_time: '25:00' })).status, 400);
    assert.strictEqual((await t.call('PUT', `/api/shift-timings/${exam.id}`, { note: 'Unit test' })).status, 200);

    await punch(t, '12', '07:59', '11:01');
    let d = (await t.call('GET', '/api/reports/daily?date=2025-11-12')).data.rows.find((x) => x.employee.code === 'T1');
    assert.deepStrictEqual([d.status, d.timingNote], ['P', 'Unit test']);
    await t.call('DELETE', `/api/shift-timings/${exam.id}`);
    d = (await t.call('GET', '/api/reports/daily?date=2025-11-12')).data.rows.find((x) => x.employee.code === 'T1');
    // Back to the dual week: 07:59–11:01 leaves the 08:00–12:00 morning session early.
    assert.deepStrictEqual([d.status, d.timingNote, d.remark], ['A', 'Dual shift', 'Morning: left 59 min early; Evening: absent']);
  } finally {
    await t.close();
  }
});
