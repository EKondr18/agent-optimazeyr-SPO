// The operating policy: what setPolicy accepts, and that a policy given to one
// call stays inside that call (the policy is module state; a server answers
// many requests in one process).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, getPolicy, runWithPolicy, DEFAULT_POLICY, planWindow, applyChanges, runOptimizer,
  improveAssignment, fitsShift, validatePlan,
} from '../src/optimizer.js';
import { resolveStaffingWithCallIns } from '../src/utils/staffingGap.js';

const D = (h, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));
const DATE = '2026-01-01';
const WIN = [DATE];
const OPEN = 'Не назначено';
const mk = (id, h, m, eh, em, qual, extra = {}) => ({
  id, date: DATE, name: 'T' + id, flight: 'FL' + id, pos: 'POS1', entryPos: 'POS1', exitPos: 'POS1',
  reqType: qual, reqTypes: [qual], start: D(h, m), end: D(eh, em), employee: OPEN, isLocked: false, ...extra,
});
const person = (name, quals, from = 6, to = 20) => ({ name, quals, shiftStart: D(from), shiftEnd: D(to), basePos: null });
const db = (...people) => ({ [DATE]: people });
const empOf = (tasks, id) => tasks.find(t => t.id === id).employee;

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

test('setPolicy: maxOvertimeMin is always a finite number from 0 to 240', () => {
  const overtime = v => { setPolicy({ maxOvertimeMin: v }); return getPolicy().maxOvertimeMin; };
  assert.equal(overtime(NaN), DEFAULT_POLICY.maxOvertimeMin);
  assert.equal(overtime(undefined), DEFAULT_POLICY.maxOvertimeMin);
  assert.equal(overtime(null), DEFAULT_POLICY.maxOvertimeMin);
  assert.equal(overtime(Infinity), DEFAULT_POLICY.maxOvertimeMin);
  assert.equal(overtime('abc'), DEFAULT_POLICY.maxOvertimeMin);
  assert.equal(overtime(''), DEFAULT_POLICY.maxOvertimeMin);
  assert.equal(overtime({}), DEFAULT_POLICY.maxOvertimeMin);
  assert.equal(overtime('30'), 30);
  assert.equal(overtime(' 45 '), 45);
  assert.equal(overtime(-30), 0);
  assert.equal(overtime(0), 0);
  assert.equal(overtime(12.5), 12.5);
  assert.equal(overtime(1000), 240);
});

test('setPolicy: waivedQuals is an array of strings, sameFlightOverlap a boolean', () => {
  const waived = v => { setPolicy({ waivedQuals: v }); return getPolicy().waivedQuals; };
  assert.deepEqual(waived(null), []);
  assert.deepEqual(waived(undefined), []);
  assert.deepEqual(waived('Q1'), []);
  assert.deepEqual(waived({ 0: 'Q1', length: 1 }), []);
  assert.deepEqual(waived(['Q1', 7, null, 'Q2']), ['Q1', 'Q2']);
  const src = ['Q1'];
  assert.notEqual(waived(src), src, 'a copy: later edits of the caller\'s array do not change the policy');

  const overlap = v => { setPolicy({ sameFlightOverlap: v }); return getPolicy().sameFlightOverlap; };
  assert.equal(overlap(undefined), false);
  assert.equal(overlap(1), true);
  assert.equal(overlap(0), false);
  assert.equal(overlap(null), false);
  assert.equal(overlap(true), true);
  // no policy at all, or something that is not one: the defaults
  setPolicy(null);
  assert.deepEqual(getPolicy(), DEFAULT_POLICY);
  setPolicy('nonsense');
  assert.deepEqual(getPolicy(), DEFAULT_POLICY);
});

test('a NaN overtime allowance no longer means unlimited overtime', () => {
  // shift ends 10:00; the task runs 09:30-18:00 (eight hours over)
  const people = [person('S1', ['Q1'], 6, 10)];
  const tasks = [mk('long', 9, 30, 18, 0, 'Q1')];
  setPolicy({ maxOvertimeMin: NaN });
  const r = runOptimizer(tasks, db(...people), DATE, null, WIN);
  assert.equal(empOf(r, 'long'), OPEN);
  // an allowance that is a numeric string still works
  setPolicy({ maxOvertimeMin: '30' });
  const ok = runOptimizer([mk('short', 9, 30, 10, 30, 'Q1')], db(...people), DATE, null, WIN);
  assert.equal(empOf(ok, 'short'), 'S1');
  // and waivedQuals: null no longer throws
  setPolicy({ waivedQuals: null });
  assert.doesNotThrow(() => runOptimizer(tasks, db(...people), DATE, null, WIN));
});

test('runWithPolicy runs under the policy and restores the previous one, also after an error', () => {
  setPolicy({ maxOvertimeMin: 15 });
  const seen = runWithPolicy({ maxOvertimeMin: 200, waivedQuals: ['X'] }, () => getPolicy());
  assert.equal(seen.maxOvertimeMin, 200);
  assert.deepEqual(seen.waivedQuals, ['X']);
  assert.equal(getPolicy().maxOvertimeMin, 15);

  assert.throws(() => runWithPolicy({ maxOvertimeMin: 99 }, () => { throw new Error('boom'); }), /boom/);
  assert.equal(getPolicy().maxOvertimeMin, 15, 'restored after the exception');

  // returns what fn returns; nests; the given policy is normalized like setPolicy's
  const value = runWithPolicy({ maxOvertimeMin: 10 }, () =>
    [getPolicy().maxOvertimeMin, runWithPolicy({ maxOvertimeMin: NaN }, () => getPolicy().maxOvertimeMin), getPolicy().maxOvertimeMin]);
  assert.deepEqual(value, [10, DEFAULT_POLICY.maxOvertimeMin, 10]);
  assert.equal(getPolicy().maxOvertimeMin, 15);

  // no policy given: runs under the current one
  assert.equal(runWithPolicy(undefined, () => getPolicy().maxOvertimeMin), 15);
});

test('planWindow: two calls with different policies are independent and leave the global one alone', () => {
  const people = [person('S1', ['Q1'])];
  const tasks = [mk('rare', 9, 0, 9, 30, 'Q_RARE')];
  setPolicy({ maxOvertimeMin: 33 });
  const waived = planWindow(tasks, db(...people), DATE, null, WIN, { lnsIterations: 0, policy: { waivedQuals: ['Q_RARE'] } });
  const strict = planWindow(tasks, db(...people), DATE, null, WIN, { lnsIterations: 0 });
  const strictExplicit = planWindow(tasks, db(...people), DATE, null, WIN, { lnsIterations: 0, policy: { waivedQuals: [] } });
  assert.equal(empOf(waived.tasks, 'rare'), 'S1');
  assert.equal(waived.stats.waived, 1);
  assert.equal(empOf(strict.tasks, 'rare'), OPEN, 'the first call\'s policy did not leak into the second');
  assert.equal(empOf(strictExplicit.tasks, 'rare'), OPEN);
  assert.equal(getPolicy().maxOvertimeMin, 33);
  assert.deepEqual(getPolicy().waivedQuals, []);

  // the other way round, and a throw inside leaves nothing behind
  assert.throws(() => planWindow(tasks, null, DATE, null, WIN, { policy: { maxOvertimeMin: 5 } }));
  assert.equal(getPolicy().maxOvertimeMin, 33);
});

test('planWindow: sameFlightOverlap given per call decides whether one person may do parallel tasks of a flight', () => {
  const a = mk('a', 9, 0, 10, 0, 'Q1', { flight: 'FL9', name: 'OUT_1' });
  const b = mk('b', 9, 15, 10, 15, 'Q1', { flight: 'FL9', name: 'OUT_2' });
  const people = db(person('S1', ['Q1']));
  const together = planWindow([a, b], people, DATE, null, WIN, { lnsIterations: 0, policy: { sameFlightOverlap: true } });
  const apart = planWindow([a, b], people, DATE, null, WIN, { lnsIterations: 0, policy: { sameFlightOverlap: false } });
  assert.equal(together.tasks.filter(t => t.employee === 'S1').length, 2);
  assert.equal(apart.tasks.filter(t => t.employee === 'S1').length, 1);
  assert.deepEqual(apart.stats.violations, []);
});

test('applyChanges: options.policy applies to that call only', () => {
  const people = db(person('S1', ['Q1']));
  const base = [mk('a', 9, 0, 9, 30, 'Q1', { employee: 'S1' })];
  const add = [mk('rare', 12, 0, 12, 30, 'Q_RARE')];
  const waived = applyChanges(base, people, DATE, null, WIN, add, { policy: { waivedQuals: ['Q_RARE'] } });
  const strict = applyChanges(base, people, DATE, null, WIN, add, {});
  assert.equal(empOf(waived.tasks, 'rare'), 'S1');
  assert.equal(empOf(strict.tasks, 'rare'), OPEN);
  assert.deepEqual(getPolicy(), DEFAULT_POLICY);
});

test('resolveStaffingWithCallIns: the policy parameter applies to that call only', () => {
  const people = db(person('S1', ['Q1'], 6, 14));
  const base = [mk('a', 9, 0, 9, 30, 'Q1', { employee: 'S1' }), mk('rare', 10, 0, 10, 30, 'Q_RARE')];
  const run = policy => resolveStaffingWithCallIns({
    tasksDB: base, staffDB: people, targetDate: DATE, windowDates: WIN, fullRoster: [], distanceResolver: null, policy,
  });
  const waived = run({ waivedQuals: ['Q_RARE'] });
  const strict = run(undefined);
  assert.equal(empOf(waived.tasks, 'rare'), 'S1');
  assert.deepEqual(waived.unresolved, []);
  assert.deepEqual(strict.unresolved.map(t => t.id), ['rare']);
  assert.deepEqual(getPolicy(), DEFAULT_POLICY);
});

test('F9: a task starting at the shift end is outside the shift for every caller, a zero-length one at the shift start is inside', () => {
  const shift = { name: 'S1', quals: ['Q1'], shiftStart: D(6), shiftEnd: D(20), basePos: null };
  const zeroAtEnd = mk('z', 20, 0, 20, 0, 'Q1');
  const zeroAtStart = mk('s', 6, 0, 6, 0, 'Q1');
  const zeroInside = mk('m', 12, 0, 12, 0, 'Q1');
  for (const allowOvertime of [false, true]) {
    assert.equal(fitsShift(shift, zeroAtEnd, null, allowOvertime), false, `at the end, overtime=${allowOvertime}`);
    assert.equal(fitsShift(shift, zeroAtStart, null, allowOvertime), true, `at the start, overtime=${allowOvertime}`);
    assert.equal(fitsShift(shift, zeroInside, null, allowOvertime), true);
    assert.equal(fitsShift(shift, mk('p', 20, 0, 20, 30, 'Q1'), null, allowOvertime), false, 'a normal task starting at the end');
  }

  // the builder and the validator now agree on it: the improvement search
  // (which has no input filter of its own) leaves the zero-length task open,
  // and the validator names the problem as out-of-shift, not as a walk
  const people = db(shift);
  const improved = improveAssignment([zeroAtEnd, zeroAtStart], people, DATE, null, WIN).tasks;
  assert.equal(empOf(improved, 'z'), OPEN);
  assert.equal(empOf(improved, 's'), 'S1');
  assert.deepEqual(validatePlan(improved, people, DATE, null, WIN), []);
  const forced = validatePlan([{ ...zeroAtEnd, employee: 'S1' }], people, DATE, null, WIN);
  assert.deepEqual(forced.map(v => v.code), ['OUT_OF_SHIFT']);
  assert.deepEqual(validatePlan([{ ...zeroAtStart, employee: 'S1' }], people, DATE, null, WIN), []);
});
