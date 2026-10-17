// Data-quality report: qualifications nobody ON SHIFT holds in the window,
// days with an incomplete window, the reason each open task is open, and the
// load report shown next to them. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataQualityReport, openTaskReasons } from '../src/utils/dataQuality.js';
import { unassignedLowerBound, setPolicy, DEFAULT_POLICY } from '../src/optimizer.js';
import { dayStart, addDays } from '../src/utils/tz.js';

const OPEN = 'Не назначено';
const at = (day, h, m = 0) => new Date(dayStart(day).getTime() + (h * 60 + m) * 60000);
const task = (id, day, h, eh, qual, extra = {}) => ({
  id, date: day, name: 'T' + id, flight: 'F' + id, pos: 'P', entryPos: 'P', exitPos: 'P',
  reqType: qual, reqTypes: [qual], start: at(day, h), end: at(day, eh), employee: OPEN, isLocked: false, ...extra,
});
const person = (name, quals, day, from = 6, to = 20) =>
  ({ name, quals, shiftStart: at(day, from), shiftEnd: at(day, to), basePos: null });

const D1 = '2026-09-10', D2 = addDays(D1, 1), D3 = addDays(D1, 2), D4 = addDays(D1, 3), D5 = addDays(D1, 4), D6 = addDays(D1, 5);

test.beforeEach(() => setPolicy(DEFAULT_POLICY));

// ── qualifications nobody on shift holds ────────────────────────────────────

test('a qualification is "held" only by people on shift in the day-1..day+1 window', () => {
  const staffDB = {
    [D1]: [person('A', ['CRJ'], D1), person('B', ['SV'], D1)],
    [D2]: [person('B', ['SV'], D2)],
    [D3]: [person('B', ['SV'], D3)],
    [D4]: [person('B', ['SV'], D4)],
    [D5]: [person('B', ['SV'], D5)],
  };
  const tasks = [
    task('c1', D1, 9, 10, 'CRJ'),   // A is on shift that day
    task('c2', D2, 9, 10, 'CRJ'),   // A was on shift the day before: inside the window
    task('c3', D3, 9, 10, 'CRJ'),   // two days away: nobody
    task('c4', D3, 11, 12, 'CRJ'),
    task('c5', D5, 9, 10, 'CRJ'),   // nobody
    task('s1', D3, 9, 10, 'SV'),
  ];
  // A holds CRJ in the personal roster, but is off shift on D3/D5: the old
  // "held anywhere in the file" check called CRJ covered
  const rep = dataQualityReport({ tasks, staffDB, fullRoster: [{ name: 'A', quals: ['CRJ'] }] });
  assert.deepEqual(rep.qualsNobodyHolds, [{ qual: 'CRJ', tasks: 3, days: 2, totalTasks: 5 }]);
});

test('days with no shifts at all are not repeated per qualification', () => {
  const staffDB = { [D1]: [person('B', ['SV'], D1)] };
  const tasks = [task('a', D1, 9, 10, 'SV'), task('b', D5, 9, 10, 'SV'), task('c', D5, 9, 10, 'CRJ')];
  const rep = dataQualityReport({ tasks, staffDB });
  assert.deepEqual(rep.qualsNobodyHolds, []);
  assert.deepEqual(rep.datesWithoutShifts, [D5]);
});

test('every required qualification of a task counts, not only the first', () => {
  const staffDB = { [D1]: [person('A', ['Q1'], D1)] };
  const t = { ...task('m', D1, 9, 10, 'Q1'), reqTypes: ['Q1', 'Q2'], reqType: 'Q1 + Q2' };
  const rep = dataQualityReport({ tasks: [t], staffDB });
  assert.deepEqual(rep.qualsNobodyHolds.map(q => [q.qual, q.tasks, q.days]), [['Q2', 1, 1]]);
});

// ── incomplete window ───────────────────────────────────────────────────────

test('days whose window has a neighbour without shifts or far too few people are flagged', () => {
  const crowd = (day, n) => Array.from({ length: n }, (_, i) => person(`P${i}`, ['Q'], day));
  const staffDB = {
    [D1]: crowd(D1, 10), [D2]: crowd(D2, 10), [D3]: crowd(D3, 10), [D4]: crowd(D4, 10),
    [D5]: crowd(D5, 3),      // 3 < 50 % of the median (10)
    // D6: no shifts at all
  };
  const tasks = [D1, D2, D3, D4, D5, D6].map(d => task('t' + d, d, 9, 10, 'Q'));
  const rep = dataQualityReport({ tasks, staffDB });
  const by = Object.fromEntries(rep.incompleteWindowDays.map(d => [d.date, d]));
  assert.deepEqual(Object.keys(by).sort(), [D1, D4, D5, D6]);
  assert.deepEqual(by[D1].reasons, ['NO_SHIFTS_PREV']);                 // nothing the day before the data starts
  assert.deepEqual(by[D4].reasons, ['FEW_PEOPLE']);                     // its neighbour D5 is thin
  assert.deepEqual(by[D5].reasons, ['NO_SHIFTS_NEXT', 'FEW_PEOPLE']);
  assert.deepEqual(by[D6].reasons, ['NO_SHIFTS_DAY', 'NO_SHIFTS_NEXT', 'FEW_PEOPLE']);
  assert.deepEqual(by[D5].people, { prev: 10, day: 3, next: 0 });
  assert.equal(by[D5].medianPeople, 10);
  assert.equal(by[D5].tasks, 1);
});

test('a complete stretch of days is not flagged', () => {
  const staffDB = {};
  for (const d of [D1, D2, D3, D4, D5]) staffDB[d] = [person('A', ['Q'], d), person('B', ['Q'], d)];
  const tasks = [D2, D3, D4].map(d => task('t' + d, d, 9, 10, 'Q'));
  assert.deepEqual(dataQualityReport({ tasks, staffDB }).incompleteWindowDays, []);
});

// ── reasons for open tasks ──────────────────────────────────────────────────

test('open tasks are split into no-qualification / no shift at that time / busy', () => {
  const staffDB = { [D2]: [person('A', ['Q1'], D2, 8, 16), person('B', ['Q2'], D2, 8, 16)] };
  const tasks = [
    task('noq', D2, 9, 10, 'Q_NOBODY'),
    task('late', D2, 22, 23, 'Q1'),                    // A holds Q1 but is off shift at 22:00
    task('busy1', D2, 9, 10, 'Q1'),                    // could be taken: still open because busy
    task('busy2', D2, 11, 12, 'Q2'),
    task('done', D2, 9, 10, 'Q1', { employee: 'A' }),  // assigned: not counted
    task('other', D3, 9, 10, 'Q_NOBODY'),              // another day: not counted
  ];
  const r = openTaskReasons(tasks, staffDB, D2, null, [D1, D2, D3]);
  assert.equal(r.total, 4);
  assert.deepEqual(r.byReason, { NO_QUAL: 1, NO_SHIFT_AT_TIME: 1, BUSY: 2 });
  assert.deepEqual(r.byQual.Q_NOBODY, { total: 1, NO_QUAL: 1, NO_SHIFT_AT_TIME: 0, BUSY: 0 });
  assert.deepEqual(r.byQual.Q1, { total: 2, NO_QUAL: 0, NO_SHIFT_AT_TIME: 1, BUSY: 1 });
  assert.deepEqual(r.byQual.Q2, { total: 1, NO_QUAL: 0, NO_SHIFT_AT_TIME: 0, BUSY: 1 });
});

test('overtime counts as "has a shift": a task just past the end is BUSY, not no-shift', () => {
  const staffDB = { [D2]: [person('A', ['Q1'], D2, 8, 16)] };
  const near = task('near', D2, 15, 16, 'Q1', { end: at(D2, 16, 30) });   // ends 30 min after the shift
  const far = task('far', D2, 15, 20, 'Q1');                             // 4 h after the shift end
  const r = openTaskReasons([near, far], staffDB, D2, null, [D2]);
  assert.deepEqual(r.byReason, { NO_QUAL: 0, NO_SHIFT_AT_TIME: 1, BUSY: 1 });
});

test('NO_QUAL + NO_SHIFT_AT_TIME equals the lower bound\'s noEligible', () => {
  const staffDB = {
    [D2]: [person('A', ['Q1'], D2, 8, 16), person('B', ['Q2'], D2, 8, 16)],
    [D3]: [person('C', ['Q3'], D3, 8, 16)],
  };
  const tasks = [
    task('a', D2, 9, 10, 'Q9'), task('b', D2, 9, 10, 'Q1'), task('c', D2, 21, 22, 'Q2'),
    task('d', D2, 22, 23, 'Q1'), task('e', D2, 12, 13, 'Q2'), task('f', D2, 7, 8, 'Q3'),
  ];
  const win = [D2];
  const r = openTaskReasons(tasks, staffDB, D2, null, win);
  const lb = unassignedLowerBound(tasks, staffDB, D2, win);
  assert.equal(r.byReason.NO_QUAL + r.byReason.NO_SHIFT_AT_TIME, lb.noEligible);
  assert.equal(r.total, 6);
});

test('a waived qualification is not a missing one (the policy is respected)', () => {
  const staffDB = { [D2]: [person('A', ['Q1'], D2, 8, 16)] };
  const tasks = [task('x', D2, 9, 10, 'Q_WAIVED')];
  assert.equal(openTaskReasons(tasks, staffDB, D2, null, [D2]).byReason.NO_QUAL, 1);
  setPolicy({ waivedQuals: ['Q_WAIVED'] });
  assert.equal(openTaskReasons(tasks, staffDB, D2, null, [D2]).byReason.BUSY, 1);
});

// ── load report next to the quality report ──────────────────────────────────

test('loadSkipped carries the loader report (null without one)', () => {
  const staffDB = { [D1]: [person('A', ['Q'], D1)] };
  const tasks = [task('a', D1, 9, 10, 'Q')];
  assert.equal(dataQualityReport({ tasks, staffDB }).loadSkipped, null);
  const loadReport = {
    orders: { total: 3, used: 1, skipped: { badDates: 1, duplicateIds: 1, noId: 0 } },
    shifts: { total: 10, used: 7, skipped: { noResource: 1, otherDepartment: 2, cancelled: 0, badDates: 0 }, badIntervals: 0 },
    warnings: ['Пропущено 3 из 10 смен: чужой отдел — 2, ресурса нет в справочнике — 1'],
  };
  const rep = dataQualityReport({ tasks, staffDB, loadReport });
  assert.equal(rep.loadSkipped.skippedTotal, 5);
  assert.deepEqual(rep.loadSkipped.warnings, loadReport.warnings);
  assert.equal(rep.loadSkipped.shifts.total, 10);
});
