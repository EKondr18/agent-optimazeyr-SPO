// Regression tests for the optimizer core (no browser, no React): run with
//   npm test        (node --test tests/)
// They pin down behaviour that was easy to get subtly wrong — double-booking,
// frozen work being moved, chains of displacements, the improvement search,
// the regret construction, the incremental batch update and the cost weights.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runOptimizer, patchConflicts, improveAssignment, applyChanges,
  conflictsWith, hasAllQuals, DEFAULT_WEIGHTS,
} from '../src/optimizer.js';

const D = (h, m = 0) => new Date(2026, 0, 1, h, m);
const DATE = '2026-01-01';
const WIN = [DATE];
const mk = (id, h, m, eh, em, qual, employee = 'Не назначено', pos = 'POS1') => ({
  id, date: DATE, name: 'T' + id, flight: 'FL' + id, pos, entryPos: pos, exitPos: pos,
  reqType: qual, reqTypes: [qual], start: D(h, m), end: D(eh, em), employee, isLocked: false,
});
const person = (name, quals, from = 6, to = 20, basePos = null) =>
  ({ name, quals, shiftStart: D(from), shiftEnd: D(to), basePos });
const db = (...people) => ({ [DATE]: people });
const empOf = (tasks, id) => tasks.find(t => t.id === id).employee;
const open = tasks => tasks.filter(t => t.employee === 'Не назначено').length;
const violations = (tasks, people) => {
  let bad = 0;
  const by = {};
  for (const t of tasks) if (t.employee !== 'Не назначено') (by[t.employee] ??= []).push(t);
  for (const [name, list] of Object.entries(by)) {
    const p = people.find(x => x.name === name);
    list.forEach((t, i) => {
      if (!hasAllQuals(p.quals, t)) bad++;
      for (let j = i + 1; j < list.length; j++) if (conflictsWith(t, list[j], null)) bad++;
    });
  }
  return bad;
};

// A four-person qualification ladder: S1{Q1} S2{Q1,Q2} S3{Q2,Q3} S4{Q3}.
const ladder = () => [
  person('S1', ['Q1']), person('S2', ['Q1', 'Q2']), person('S3', ['Q2', 'Q3']), person('S4', ['Q3']),
];

test('chain of displacements places a task a one-hop swap could not', () => {
  const people = ladder();
  // fed in an order that makes the greedy first pass strand t1
  const tasks = [mk('t4', 9, 0, 9, 30, 'Q3'), mk('t3', 9, 0, 9, 30, 'Q2'), mk('t2', 9, 0, 9, 30, 'Q1'), mk('t1', 9, 0, 9, 30, 'Q1')];
  const r = runOptimizer(tasks, db(...people), DATE, null, WIN, undefined, { construction: 'greedy' });
  assert.equal(open(r), 0);
  assert.equal(new Set(r.map(t => t.employee)).size, 4);
});

test('a genuinely impossible task stays in the backlog (no forced double-booking)', () => {
  const people = [person('S1', ['Q1'])];
  const r = runOptimizer([mk('a', 9, 0, 9, 30, 'Q1'), mk('b', 9, 15, 9, 45, 'Q1')], db(...people), DATE, null, WIN);
  assert.equal(open(r), 1);
  assert.equal(violations(r, people), 0);
});

test('work before freezeBeforeTime is never moved, even by a chain', () => {
  const people = ladder();
  const tasks = [mk('t4', 9, 0, 9, 30, 'Q3'), mk('t3', 9, 0, 9, 30, 'Q2'), mk('t2', 9, 0, 9, 30, 'Q1', 'S2'), mk('t1', 9, 0, 9, 30, 'Q1', 'S1')];
  const r = runOptimizer(tasks, db(...people), DATE, null, WIN, D(10));
  assert.equal(empOf(r, 't1'), 'S1');
  assert.equal(empOf(r, 't2'), 'S2');
});

test('locked tasks are never displaced', () => {
  const people = [person('S1', ['Q1']), person('S2', ['Q1'])];
  const locked = { ...mk('l', 9, 0, 9, 30, 'Q1', 'S2'), isLocked: true };
  const r = runOptimizer([locked, mk('a', 9, 0, 9, 30, 'Q1'), mk('b', 9, 0, 9, 30, 'Q1')], db(...people), DATE, null, WIN);
  assert.equal(empOf(r, 'l'), 'S2');
  assert.equal(open(r), 1); // two free slots needed, only S1 is left
});

test('patchConflicts repairs only what is broken, via a chain if needed', () => {
  const people = ladder();
  const tasks = [
    mk('s1o', 9, 0, 9, 30, 'Q1', 'S1'), mk('br', 9, 0, 9, 30, 'Q1', 'S1'),
    mk('s2', 9, 0, 9, 30, 'Q2', 'S2'), mk('s3', 9, 0, 9, 30, 'Q3', 'S3'),
  ];
  const { tasks: out } = patchConflicts(tasks, db(...people), DATE, null, WIN, D(9), D(12));
  assert.equal(open(out), 0);
  assert.equal(violations(out, people), 0);
});

test('improveAssignment untangles criss-crossing walks with one swap', () => {
  const people = [person('S1', ['Q1']), person('S2', ['Q1'])];
  const tasks = [
    mk('t1', 9, 0, 9, 30, 'Q1', 'S1', 'POS10'), mk('t4', 11, 0, 11, 30, 'Q1', 'S1', 'POS50'),
    mk('t2', 10, 0, 10, 30, 'Q1', 'S2', 'POS50'), mk('t3', 12, 0, 12, 30, 'Q1', 'S2', 'POS10'),
  ];
  const r = improveAssignment(tasks, db(...people), DATE, null, WIN);
  assert.equal(r.moves, 1);
  assert.equal(empOf(r.tasks, 't1'), empOf(r.tasks, 't3'));
  assert.equal(empOf(r.tasks, 't2'), empOf(r.tasks, 't4'));
});

test('improveAssignment respects frozenBefore, locks, pinned people and qualifications', () => {
  const people = [person('S1', ['Q1']), person('S2', ['Q1']), person('S3', ['Q9'])];
  const mk3 = () => [mk('a', 9, 0, 9, 30, 'Q1', 'S1'), mk('b', 10, 0, 10, 30, 'Q1', 'S1'), mk('c', 11, 0, 11, 30, 'Q1', 'S1')];
  assert.equal(improveAssignment(mk3(), db(...people), DATE, null, WIN, { frozenBefore: D(12) }).moves, 0);
  assert.equal(improveAssignment(mk3().map(t => ({ ...t, isLocked: true })), db(...people), DATE, null, WIN).moves, 0);
  assert.equal(improveAssignment(mk3(), db(...people), DATE, null, WIN, { pinnedEmployees: ['S1'] }).moves, 0);
  const r = improveAssignment(mk3(), db(...people), DATE, null, WIN);
  assert.ok(r.tasks.every(t => t.employee !== 'S3'), 'unqualified S3 must get nothing');
  assert.deepEqual([...['S1', 'S2'].map(n => r.tasks.filter(t => t.employee === n).length)].sort(), [1, 2]);
});

test('improveAssignment places an open task once something frees up a slot', () => {
  const people = ladder();
  const r = improveAssignment([mk('a', 9, 0, 9, 30, 'Q1', 'S1'), mk('b', 9, 0, 9, 30, 'Q1')], db(...people), DATE, null, WIN);
  assert.equal(open(r.tasks), 0);
});

test('regret construction leaves no more tasks open than greedy on a scarce roster', () => {
  const people = [person('A', ['Q1', 'Q2']), person('B', ['Q1']), person('C', ['Q2'])];
  const tasks = [
    mk('x1', 9, 0, 9, 30, 'Q1', undefined, 'POS5'), mk('x2', 9, 0, 9, 30, 'Q2', undefined, 'POS5'),
    mk('x3', 9, 0, 9, 30, 'Q1', undefined, 'POS5'),
  ].map(t => ({ ...t, employee: 'Не назначено' }));
  const g = runOptimizer(tasks, db(...people), DATE, null, WIN, undefined, { construction: 'greedy' });
  const r = runOptimizer(tasks, db(...people), DATE, null, WIN, undefined, { construction: 'regret' });
  assert.ok(open(r) <= open(g));
  assert.equal(violations(r, people), 0);
});

test('cost weights steer the search: a heavy walk weight beats a light one', () => {
  const people = [person('S1', ['Q1'], 6, 20, 'POS10'), person('S2', ['Q1'], 6, 20, 'POS50')];
  const tasks = [mk('a', 9, 0, 9, 30, 'Q1', 'S2', 'POS10'), mk('b', 10, 0, 10, 30, 'Q1', 'S1', 'POS50')];
  const walkHeavy = improveAssignment(tasks, db(...people), DATE, null, WIN, { weights: { ...DEFAULT_WEIGHTS, walk: 50 } });
  assert.equal(empOf(walkHeavy.tasks, 'a'), 'S1'); // each task goes to the person based where it is
  assert.equal(empOf(walkHeavy.tasks, 'b'), 'S2');
});

test('overtime is penalized', () => {
  // Same two tasks, one person; S2 is free — with overtime weighted, the task
  // that runs past S1's shift end moves to S2 whose shift covers it.
  const people = [person('S1', ['Q1'], 6, 10), person('S2', ['Q1'], 6, 20)];
  const tasks = [{ ...mk('late', 9, 40, 10, 40, 'Q1', 'S1') }];
  const r = improveAssignment(tasks, db(...people), DATE, null, WIN, { weights: { overtime: 50 } });
  // S1's shift ends at 10:00 so the task doesn't fit S1 strictly; S2 can take it
  assert.equal(empOf(r.tasks, 'late'), 'S2');
});

test('applyChanges: batch update is incremental, valid and does not churn the rest', () => {
  const people = [person('S1', ['Q1']), person('S2', ['Q1']), person('S3', ['Q1'])];
  const base = improveAssignment(runOptimizer([
    mk('a', 8, 0, 8, 30, 'Q1'), mk('b', 9, 0, 9, 30, 'Q1'), mk('c', 10, 0, 10, 30, 'Q1'),
    mk('d', 11, 0, 11, 30, 'Q1'), mk('e', 12, 0, 12, 30, 'Q1'), mk('f', 13, 0, 13, 30, 'Q1'),
  ], db(...people), DATE, null, WIN), db(...people), DATE, null, WIN).tasks;

  const out = applyChanges(base, db(...people), DATE, null, WIN, [
    { id: 'c', start: D(10, 20), end: D(10, 50) },           // shifted
    mk('new', 10, 30, 11, 0, 'Q1'),                             // added
    { id: 'f', removed: true },                                 // cancelled
  ], { now: D(9, 30) });

  assert.equal(violations(out.tasks, people), 0);
  assert.ok(!out.tasks.some(t => t.id === 'f'));
  assert.equal(out.unplaced.length, 0);
  // the hard-frozen first hour (before 10:30) keeps its assignments
  for (const id of ['a', 'b']) assert.equal(empOf(out.tasks, id), empOf(base, id));
});

test('applyChanges: a changed task its employee can no longer take is re-placed', () => {
  const people = [person('S1', ['Q1'], 6, 12), person('S2', ['Q1'], 6, 20)];
  const base = [mk('a', 9, 0, 9, 30, 'Q1', 'S1')];
  // moved past S1's shift end — must end up with S2
  const out = applyChanges(base, db(...people), DATE, null, WIN, [{ id: 'a', start: D(13, 0), end: D(13, 30) }]);
  assert.equal(empOf(out.tasks, 'a'), 'S2');
});

test('a thin hand-off margin is penalized only while the slack weight is on', () => {
  // S1 does a (9:00-9:30) then b (9:35-10:00) at the same stand — no walking,
  // but only 5 min spare. S2 has one task far later. Loads are 2/1 either way,
  // so the only reason to separate a and b is the missing margin.
  const people = [person('S1', ['Q1']), person('S2', ['Q1'])];
  const tasks = () => [
    mk('a', 9, 0, 9, 30, 'Q1', 'S1'), mk('b', 9, 35, 10, 0, 'Q1', 'S1'), mk('c', 12, 0, 12, 30, 'Q1', 'S2'),
  ];
  const on = improveAssignment(tasks(), db(...people), DATE, null, WIN, { weights: { slack: 3 } });
  assert.notEqual(empOf(on.tasks, 'a'), empOf(on.tasks, 'b')); // either one may be the one that moves
  const off = improveAssignment(tasks(), db(...people), DATE, null, WIN, { weights: { slack: 0 } });
  assert.equal(off.moves, 0);
});
