// Single rules, each with the smallest scene that shows it: the freeze time of the construction,
// the history of a batch update, locked tasks in a repair chain, the lower bound adding separate
// bottlenecks, an unknown flight, the price of overtime and of a thin hand-off.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, DEFAULT_POLICY, runOptimizer, applyChanges, patchConflicts, unassignedLowerBound, assignmentCost, conflictsWith,
} from '../src/optimizer.js';
import { OPEN, DATE, D, mkTask, mkPerson, dbOf, empOf } from './helpers.mjs';

const WIN = [DATE];
test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

test('runOptimizer: what starts before freezeBeforeTime keeps its person, the rest is planned afresh', () => {
  const staff = dbOf(mkPerson('P1', ['Q1'], 6, 20), mkPerson('P2', ['Q1'], 6, 20));
  const tasks = [
    mkTask('early', D(9), D(10), ['Q1'], { employee: 'P2' }),
    mkTask('late', D(12), D(13), ['Q1'], { employee: 'P2' }),
  ];
  for (const construction of ['regret', 'bestfit', 'greedy']) {
    const free = runOptimizer(tasks, staff, DATE, null, WIN, undefined, { construction });
    assert.equal(empOf(free, 'early'), 'P1', `${construction}: with no freeze the whole window is planned again (control)`);
    const frozen = runOptimizer(tasks, staff, DATE, null, WIN, D(10), { construction });
    assert.equal(empOf(frozen, 'early'), 'P2', `${construction}: before the freeze time it stays`);
    assert.notEqual(empOf(frozen, 'late'), OPEN, `${construction}: the later one is planned`);
  }
});

test('applyChanges: a task that started before now stays as recorded even if its person is gone; later ones are re-placed', () => {
  const staff = dbOf(mkPerson('P2', ['Q1'], 6, 20));          // P1 is no longer on the roster
  const base = [
    mkTask('done', D(9), D(10), ['Q1'], { employee: 'P1' }),
    mkTask('next', D(14), D(15), ['Q1'], { employee: 'P1' }),
  ];
  const withNow = applyChanges(base, staff, DATE, null, WIN, [], { now: D(12) });
  assert.equal(empOf(withNow.tasks, 'done'), 'P1', 'history is not rewritten');
  assert.equal(empOf(withNow.tasks, 'next'), 'P2');
  const noNow = applyChanges(base, staff, DATE, null, WIN, []);
  assert.equal(empOf(noNow.tasks, 'done'), 'P2', 'without now everything may be re-placed (control)');
});

test('patchConflicts: a locked task is never pushed aside to make room, the broken task goes to the backlog instead', () => {
  // P1 does T and U at once (a clash). Only P2 could take T, but P2 holds a locked L at the same time,
  // and L (Q2) could only move to P3: the chain would have to displace a locked task.
  const staff = dbOf(
    mkPerson('P1', ['Q1'], 6, 20), mkPerson('P2', ['Q1', 'Q2'], 6, 20), mkPerson('P3', ['Q2'], 6, 20),
  );
  const plan = [
    mkTask('T', D(9), D(10), ['Q1'], { employee: 'P1' }),
    mkTask('U', D(9, 30), D(10, 30), ['Q1'], { employee: 'P1' }),
    mkTask('L', D(9), D(10), ['Q2'], { employee: 'P2', isLocked: true }),
  ];
  const r = patchConflicts(plan, staff, DATE, null, WIN, new Date(-8.64e15), new Date(8.64e15));
  assert.equal(empOf(r.tasks, 'L'), 'P2', 'the locked one did not move');
  assert.equal(r.tasks.filter(t => t.employee === OPEN).length, 1);
  assert.deepEqual(r.changes.map(c => [c.taskId, c.backlog]), [['T', true]]);
  assert.equal(r.changes.some(c => c.viaBump), false);
  // control: unlocked, the same chain works
  const free = patchConflicts(plan.map(t => ({ ...t, isLocked: false })), staff, DATE, null, WIN, new Date(-8.64e15), new Date(8.64e15));
  assert.equal(free.tasks.filter(t => t.employee === OPEN).length, 0);
  assert.ok(free.changes.some(c => c.viaBump));
});

test('lower bound: separate bottlenecks of one day add up (a morning and an evening peak = 2)', () => {
  const staff = dbOf(mkPerson('P1', ['Q1'], 6, 20), mkPerson('P2', ['Q1'], 6, 20));
  const peak = (tag, h) => [0, 1, 2].map(i => mkTask(tag + i, D(h, i), D(h + 1), ['Q1']));
  const lb = unassignedLowerBound([...peak('m', 9), ...peak('e', 17)], staff, DATE, WIN);
  assert.equal(lb.bound, 2);
  assert.equal(lb.bottlenecks.length, 2);
  assert.deepEqual(lb.bottlenecks.map(b => b.deficit), [1, 1]);
  assert.ok(lb.bottlenecks[0].at < lb.bottlenecks[1].at, 'in time order');
  assert.equal(unassignedLowerBound(peak('m', 9), staff, DATE, WIN).bound, 1);
});

test('lower bound: tasks that share a task are not added twice (a chain of overlaps is one bottleneck)', () => {
  const staff = dbOf(mkPerson('P1', ['Q1'], 6, 20));
  // a 09:00-11:00, b 10:00-12:00, c 11:00-13:00: one person can do a and c, b is the odd one out
  const tasks = [mkTask('a', D(9), D(11), ['Q1']), mkTask('b', D(10), D(12), ['Q1']), mkTask('c', D(11), D(13), ['Q1'])];
  assert.equal(unassignedLowerBound(tasks, staff, DATE, WIN).bound, 1);
});

test('the same-flight exemption never applies to "Рейс не указ." (no flight is not one flight)', () => {
  setPolicy({ sameFlightOverlap: true });
  const mk = (id, flight, name) => ({ ...mkTask(id, D(9), D(10), ['Q1']), flight, name });
  assert.equal(conflictsWith(mk('a', 'SU1', 'OUT_1'), mk('b', 'SU1', 'OUT_2'), null), false, 'one real flight, two roles');
  assert.equal(conflictsWith(mk('a', 'Рейс не указ.', 'OUT_1'), mk('b', 'Рейс не указ.', 'OUT_2'), null), true);
  assert.equal(conflictsWith(mk('a', 'SU1', 'OUT_1'), mk('b', 'SU2', 'OUT_2'), null), true);
});

test('cost: a minute of overtime costs 50, a thin hand-off 3 per missing minute, load squared', () => {
  const one = [mkTask('o', D(9, 30), D(10, 30), ['Q1'], { employee: 'P' })];
  const shortShift = dbOf(mkPerson('P', ['Q1'], 8, 10));
  assert.equal(assignmentCost(one, shortShift, DATE, null, WIN), 100 + 30 * 50, 'load 1, 30 minutes past the shift');
  assert.equal(assignmentCost(one, shortShift, DATE, null, WIN, { overtime: 0 }), 100);
  assert.equal(assignmentCost(one, shortShift, DATE, null, WIN, { overtime: 10 }), 100 + 30 * 10);
  const two = [
    mkTask('a', D(9), D(9, 30), ['Q1'], { employee: 'P' }), mkTask('b', D(9, 35), D(10), ['Q1'], { employee: 'P' }),
  ];
  const wide = dbOf(mkPerson('P', ['Q1'], 8, 12));
  // load 2 squared = 4 x 100; the 5 minute gap leaves 10 minutes below the 15 wanted
  assert.equal(assignmentCost(two, wide, DATE, null, WIN), 400 + 10 * 3);
  assert.equal(assignmentCost(two, wide, DATE, null, WIN, { slack: 0 }), 400);
  assert.equal(assignmentCost(two, wide, DATE, null, WIN, { load: 1 }), 4 + 30);
});
