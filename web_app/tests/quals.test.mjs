// "All qualifications" rule: a task that requires [Q1, Q2] may only go to someone
// who holds BOTH (AND, never OR). The check here is a plain loop over the
// qualification lists, not hasAllQuals, so a slip in that function cannot hide
// behind itself. Every entry point that places or moves work is run on the same
// scene: A holds [Q1], B holds [Q2], C holds [Q1, Q2].
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, DEFAULT_POLICY, runOptimizer, improveAssignment, lnsImprove, applyChanges, patchConflicts,
  planWindow, validatePlan, unassignedLowerBound, certifyPlan,
} from '../src/optimizer.js';
import { OPEN, DATE, D, mkTask, mkPerson, dbOf, empOf } from './helpers.mjs';

const WIN = [DATE];
const A = mkPerson('A', ['Q1'], 6, 20);
const B = mkPerson('B', ['Q2'], 6, 20);
const C = mkPerson('C', ['Q1', 'Q2'], 6, 20);
const staff = dbOf(A, B, C);
const QUALS = { A: ['Q1'], B: ['Q2'], C: ['Q1', 'Q2'] };

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

// Directly: does `who` hold every qualification of the task, given what is waived?
function holdsEvery(who, task, waived = []) {
  for (const q of task.reqTypes) {
    if (!QUALS[who].includes(q) && !waived.includes(q)) return false;
  }
  return true;
}
// Every assigned task of the plan goes to someone who holds all of its qualifications.
function assertAllHold(tasks, label, waived = []) {
  for (const t of tasks) {
    if (t.employee === OPEN) continue;
    assert.ok(holdsEvery(t.employee, t, waived), `${label}: ${t.id} [${t.reqTypes}] went to ${t.employee} [${QUALS[t.employee]}]`);
  }
}

// three separate tasks only C can do, and one of Q1 for the control
const separate = () => [
  mkTask('t1', D(9), D(10), ['Q1', 'Q2']),
  mkTask('t2', D(11), D(12), ['Q1', 'Q2']),
  mkTask('t3', D(13), D(14), ['Q2', 'Q1']),
  mkTask('q1', D(15), D(16), ['Q1']),
];
// X and T both need Q1+Q2 and overlap: only C can take either, so exactly one stays open
const squeezed = () => [
  mkTask('X', D(9), D(10), ['Q1', 'Q2']),
  mkTask('T', D(9, 30), D(10, 30), ['Q1', 'Q2']),
];

test('runOptimizer: every construction gives a Q1+Q2 task to C only; with C busy it stays open', () => {
  for (const construction of ['regret', 'bestfit', 'greedy']) {
    const out = runOptimizer(separate(), staff, DATE, null, WIN, undefined, { construction });
    for (const id of ['t1', 't2', 't3']) assert.equal(empOf(out, id), 'C', `${construction} ${id}`);
    assertAllHold(out, construction);
    const sq = runOptimizer(squeezed(), staff, DATE, null, WIN, undefined, { construction });
    assert.equal(sq.filter(t => t.employee === OPEN).length, 1, `${construction}: one of the two stays open`);
    assert.equal(sq.filter(t => t.employee === 'C').length, 1, construction);
    assertAllHold(sq, construction);
    assert.deepEqual(validatePlan(sq, staff, DATE, null, WIN), [], construction);
  }
});

test('a qualification nobody holds together leaves the task open (Q3 on top of Q1+Q2)', () => {
  const t = mkTask('z', D(9), D(10), ['Q1', 'Q2', 'Q3']);
  const out = runOptimizer([t], staff, DATE, null, WIN);
  assert.equal(empOf(out, 'z'), OPEN);
  const r = planWindow([t], staff, DATE, null, WIN, { lnsIterations: 5 });
  assert.equal(r.stats.openDay, 1);
  assert.equal(r.stats.lowerBound.bound, 1);
});

test('improveAssignment and lnsImprove never move a Q1+Q2 task to A or B, from an open start or from C', () => {
  for (const start of [squeezed(), squeezed().map(t => (t.id === 'X' ? { ...t, employee: 'C' } : t)),
    squeezed().map(t => (t.id === 'T' ? { ...t, employee: 'C' } : t))]) {
    const imp = improveAssignment(start, staff, DATE, null, WIN);
    assertAllHold(imp.tasks, 'improve');
    assert.equal(imp.tasks.filter(t => t.employee === OPEN).length, 1);
    const lns = lnsImprove(start, staff, DATE, null, WIN, { maxIterations: 30 });
    assertAllHold(lns.tasks, 'lns');
    assert.equal(lns.tasks.filter(t => t.employee === OPEN).length, 1);
    assert.deepEqual(validatePlan(lns.tasks, staff, DATE, null, WIN), []);
  }
  const sep = improveAssignment(separate(), staff, DATE, null, WIN);
  for (const id of ['t1', 't2', 't3']) assert.equal(empOf(sep.tasks, id), 'C');
});

test('planWindow: the same, and the lower bound counts the task A or B could "almost" do as open', () => {
  const r = planWindow(squeezed(), staff, DATE, null, WIN, { lnsIterations: 20 });
  assertAllHold(r.tasks, 'planWindow');
  assert.equal(r.stats.openDay, 1);
  assert.equal(r.stats.lowerBound.bound, 1, 'with OR instead of AND three people could have covered both');
  assert.deepEqual(r.stats.violations, []);
  const lb = unassignedLowerBound(squeezed(), staff, DATE, WIN);
  assert.equal(lb.bound, 1);
});

test('applyChanges: an added overlapping Q1+Q2 task is not given to A or B; a task that became Q1+Q2 leaves A', () => {
  const base = [mkTask('X', D(9), D(10), ['Q1', 'Q2'], { employee: 'C' }), mkTask('k', D(12), D(13), ['Q1'], { employee: 'A' })];
  const added = applyChanges(base, staff, DATE, null, WIN, [mkTask('T', D(9, 30), D(10, 30), ['Q1', 'Q2'])]);
  assertAllHold(added.tasks, 'add');
  assert.equal(empOf(added.tasks, 'T'), OPEN);
  assert.deepEqual(added.unplaced, ['T']);
  assert.equal(empOf(added.tasks, 'k'), 'A', 'the Q1 task of A is not touched');
  // the requirement of an assigned task grows to Q1+Q2: A no longer qualifies
  const grown = applyChanges(base, staff, DATE, null, WIN, [{ id: 'k', reqTypes: ['Q1', 'Q2'], reqType: 'Q1 + Q2' }]);
  assertAllHold(grown.tasks, 'grown');
  assert.equal(empOf(grown.tasks, 'k'), 'C', 'k is free at 12:00 for C');
  // C goes off the roster: the Q1+Q2 task is open, not handed to A or B
  const noC = applyChanges(base, dbOf(A, B), DATE, null, WIN, []);
  assert.equal(empOf(noC.tasks, 'X'), OPEN);
  assert.deepEqual(validatePlan(noC.tasks, dbOf(A, B), DATE, null, WIN), []);
});

test('patchConflicts: the broken one of two overlapping Q1+Q2 tasks of C goes to the backlog, not to A or B', () => {
  const plan = squeezed().map(t => ({ ...t, employee: 'C' }));
  const r = patchConflicts(plan, staff, DATE, null, WIN, new Date(-8.64e15), new Date(8.64e15));
  assertAllHold(r.tasks, 'patch');
  assert.equal(r.tasks.filter(t => t.employee === OPEN).length, 1);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].to, null);
  assert.equal(r.changes[0].backlog, true);
});

test('validatePlan and certifyPlan: a Q1+Q2 task on A or on B is QUAL_MISSING and is reopened', () => {
  for (const who of ['A', 'B']) {
    const plan = [mkTask('T', D(9), D(10), ['Q1', 'Q2'], { employee: who })];
    const v = validatePlan(plan, staff, DATE, null, WIN);
    assert.deepEqual(v.map(x => x.code), ['QUAL_MISSING'], who);
    assert.equal(v[0].detail, who === 'A' ? 'Q2' : 'Q1', 'names the qualification that is missing');
    assert.equal(certifyPlan(plan, staff, DATE, null, WIN).tasks[0].employee, OPEN);
  }
  assert.deepEqual(validatePlan([mkTask('T', D(9), D(10), ['Q1', 'Q2'], { employee: 'C' })], staff, DATE, null, WIN), []);
});

test('waived Q2: A (Q1) may take the Q1+Q2 task, B (Q2 only) still may not; waiving both frees everyone', () => {
  // C is busy with X, so T goes to whoever else qualifies
  setPolicy({ waivedQuals: ['Q2'] });
  for (const construction of ['regret', 'bestfit', 'greedy']) {
    const out = runOptimizer(squeezed().map(t => (t.id === 'X' ? { ...t, employee: 'C', isLocked: true } : t)), staff, DATE, null, WIN, undefined, { construction });
    assert.equal(empOf(out, 'T'), 'A', construction);
    assertAllHold(out, construction, ['Q2']);
  }
  const r = planWindow(squeezed(), staff, DATE, null, WIN, { lnsIterations: 10 });
  assert.equal(r.stats.openDay, 0);
  assertAllHold(r.tasks, 'planWindow', ['Q2']);
  assert.deepEqual(r.tasks.filter(t => t.employee === 'B'), [], 'B lacks Q1, which is not waived');
  assert.equal(r.stats.waived, r.tasks.filter(t => t.employee === 'A').length);
  setPolicy({ waivedQuals: ['Q1', 'Q2'] });
  const all = planWindow([...squeezed(), mkTask('U', D(9, 15), D(10, 15), ['Q1', 'Q2'])], staff, DATE, null, WIN, { lnsIterations: 0 });
  assert.equal(all.stats.openDay, 0, 'three overlapping tasks, three people');
});
