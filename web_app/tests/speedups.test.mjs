// Tests for the speed-ups that must not change a single assignment: the id
// index in the construction passes, numeric time comparisons, and the memory of
// failed displacement-chain searches kept across improveAssignment calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runOptimizer, patchConflicts, improveAssignment, conflictsWith, validatePlan,
} from '../src/optimizer.js';
import { resolveStaffingWithCallIns } from '../src/utils/staffingGap.js';

const D = (h, m = 0) => new Date(2026, 0, 1, h, m);
const DATE = '2026-01-01';
const WIN = [DATE];
const OPEN = 'Не назначено';
const mk = (id, h, m, eh, em, qual, employee = OPEN, extra = {}) => ({
  id, date: DATE, name: 'T' + id, flight: 'FL' + id, pos: 'POS1', entryPos: 'POS1', exitPos: 'POS1',
  reqType: qual, reqTypes: [qual], start: D(h, m), end: D(eh, em), employee, isLocked: false, ...extra,
});
const person = (name, quals, from = 6, to = 20) => ({ name, quals, shiftStart: D(from), shiftEnd: D(to), basePos: null });
const db = (...people) => ({ [DATE]: people });
const assignmentOf = tasks => Object.fromEntries(tasks.map(t => [t.id, t.employee]));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('a repeated id is committed to its first occurrence, as findIndex did', () => {
  const people = [person('S1', ['Q1']), person('S2', ['Q1'])];
  const tasks = [mk('x', 9, 0, 9, 30, 'Q1'), mk('x', 11, 0, 11, 30, 'Q1')];
  for (const construction of ['bestfit', 'greedy']) {
    const r = runOptimizer(tasks, db(...people), DATE, null, WIN, undefined, { construction });
    assert.notEqual(r[0].employee, OPEN, construction + ': the first occurrence takes the assignment');
    assert.equal(r[1].employee, OPEN, construction + ': the second one is never written to');
  }
});

test('an Invalid Date never makes two tasks conflict (comparisons with NaN are false)', () => {
  const bad = { ...mk('bad', 9, 0, 9, 30, 'Q1'), start: new Date(NaN) };
  const ok = mk('ok', 9, 0, 9, 30, 'Q1');
  assert.equal(conflictsWith(bad, ok, null), false);
  assert.equal(conflictsWith(ok, bad, null), false);
  assert.equal(conflictsWith(bad, { ...bad, id: 'bad2' }, null), false);
  // and the ordinary cases around it still hold
  assert.equal(conflictsWith(ok, mk('o2', 9, 15, 9, 45, 'Q1'), null), true);
  assert.equal(conflictsWith(ok, mk('o3', 9, 30, 10, 0, 'Q1'), null), false);
});

test('patchConflicts reaches the right task when ids repeat', () => {
  const people = [person('S1', ['Q1']), person('S2', ['Q1'])];
  const tasks = [mk('a', 9, 0, 9, 30, 'Q1', 'S1'), mk('b', 9, 0, 9, 30, 'Q1', 'S1')];
  const r = patchConflicts(tasks, db(...people), DATE, null, WIN, D(0), D(23));
  assert.equal(r.tasks.filter(t => t.employee === 'S1').length, 1);
  assert.equal(r.tasks.filter(t => t.employee === 'S2').length, 1);
});

// `t` needs Q1+Q2, so only S1/S2 can take it directly. S2 is busy with locked
// work; S1 holds `m` (Q1 only), which could move to anyone with Q1 who is free.
const both = { reqType: 'Q1 + Q2', reqTypes: ['Q1', 'Q2'] };
const chainDay = () => [
  mk('m', 9, 0, 9, 30, 'Q1', 'S1'), mk('l', 9, 0, 9, 30, 'Q1', 'S2', { isLocked: true }), mk('t', 9, 0, 9, 30, 'Q1', OPEN, both),
];
const chainPeople = () => [person('S1', ['Q1', 'Q2']), person('S2', ['Q1', 'Q2'])];
const solve = (tasks, people, memory) =>
  assignmentOf(improveAssignment(tasks, db(...people), DATE, null, WIN, { scopeEmployees: [], chainMemory: memory }).tasks);

test('chainMemory: a failed search is remembered, and run again once someone who could help is added', () => {
  const memory = {};
  assert.equal(solve(chainDay(), chainPeople(), memory).t, OPEN);
  assert.equal(memory.failures.size, 1, 'the failed search is remembered');
  // someone who can take nothing here changes nothing
  assert.equal(solve(chainDay(), [...chainPeople(), person('S3', ['Q9'])], memory).t, OPEN);
  // a Q1-only person cannot take `t` himself, but can take `m`: the chain t -> S1, m -> S4 opens up
  const r = solve(chainDay(), [...chainPeople(), person('S4', ['Q1'])], memory);
  assert.equal(r.t, 'S1');
  assert.equal(r.m, 'S4');
});

test('chainMemory: a change in the day of someone the search only looked at triggers a new search', () => {
  // t -> S1 would bump m to S3 (Q1), who is busy with `x`; x has nowhere to go (S2 is locked up).
  const day = withX => (withX ? [...chainDay(), mk('x', 9, 0, 9, 30, 'Q1', 'S3')] : chainDay());
  const people = [...chainPeople(), person('S3', ['Q1'])];
  const memory = {};
  assert.equal(solve(day(true), people, memory).t, OPEN);
  assert.equal(memory.failures.size, 1);
  // x leaves S3's day: S3 is not eligible for `t`, yet his list is what the search depended on
  const r = solve(day(false), people, memory);
  assert.equal(r.t, 'S1');
  assert.equal(r.m, 'S3');
});

// The same sequence of states, once with the memory and once without: every
// call must return exactly the same assignment.
test('chainMemory never changes the outcome (randomized sequences of added people)', () => {
  let remembered = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = rng(seed);
    const quals = ['Q1', 'Q2', 'Q3', 'Q4'];
    const pick = () => quals.filter(() => rnd() < 0.4).concat(quals[Math.floor(rnd() * 4)]).filter((q, i, a) => a.indexOf(q) === i);
    const staff = [];
    for (let i = 0; i < 8; i++) staff.push(person('P' + i, pick(), 6 + Math.floor(rnd() * 3), 16 + Math.floor(rnd() * 4)));
    let tasks = [];
    for (let i = 0; i < 70; i++) {
      const h = 7 + Math.floor(rnd() * 8), m = Math.floor(rnd() * 4) * 15, len = 30 + Math.floor(rnd() * 3) * 15;
      tasks.push({ ...mk('k' + i, h, m, h, m + len, quals[Math.floor(rnd() * 4)]), isLocked: rnd() < 0.15 });
    }
    // everything locked is placed by the construction first; the rest is what a plan would work in
    tasks = runOptimizer(tasks, db(...staff), DATE, null, WIN);
    const memory = {};
    const startEmp = new Map(tasks.map(t => [t.id, t.employee]));
    const moveCost = t => (startEmp.get(t.id) !== OPEN ? 3000 : 0);
    const people = [...staff];
    for (let step = 0; step < 10; step++) {
      if (step % 3 === 2) { // a shift is extended
        const i = Math.floor(rnd() * people.length);
        people[i] = { ...people[i], shiftEnd: new Date(people[i].shiftEnd.getTime() + 3600000) };
      } else {
        people.push(person('N' + step, pick(), 6 + Math.floor(rnd() * 6), 12 + Math.floor(rnd() * 8)));
      }
      if (step % 2 === 1) { // some placed work is taken off its person
        tasks = tasks.map(t => (!t.isLocked && rnd() < 0.08 ? { ...t, employee: OPEN } : t));
      }
      const stillOpen = tasks.filter(t => t.employee === OPEN).map(t => t.id);
      const common = { scopeEmployees: [], scopeTaskIds: stillOpen, moveCost };
      const plain = improveAssignment(tasks, db(...people), DATE, null, WIN, common).tasks;
      const withMemory = improveAssignment(tasks, db(...people), DATE, null, WIN, { ...common, chainMemory: memory }).tasks;
      assert.deepEqual(assignmentOf(withMemory), assignmentOf(plain), `seed ${seed}, step ${step}`);
      tasks = plain;
    }
    remembered += memory.failures ? memory.failures.size : 0;
    assert.deepEqual(validatePlan(tasks, db(...people), DATE, null, WIN).filter(v => v.code === 'OVERLAP' || v.code === 'TRAVEL'), []);
  }
  assert.ok(remembered > 0, 'the generated days must actually exercise failed chain searches');
});

test('call-in plan with the chain memory in use still covers every open task it can', () => {
  // two Q1 people, both holding work that cannot move (locked); three open Q1 tasks and a roster
  // of off-duty people to call in
  const tasks = [
    mk('l1', 9, 0, 11, 0, 'Q1', 'S1', { isLocked: true }), mk('l2', 9, 0, 11, 0, 'Q1', 'S2', { isLocked: true }),
    mk('o1', 9, 30, 10, 0, 'Q1'), mk('o2', 10, 0, 10, 30, 'Q1'), mk('o3', 10, 0, 10, 30, 'Q2'),
  ];
  const staffDB = db(person('S1', ['Q1'], 8, 12), person('S2', ['Q1'], 8, 12));
  const fullRoster = [{ name: 'R1', quals: ['Q1'] }, { name: 'R2', quals: ['Q1', 'Q2'] }];
  const r = resolveStaffingWithCallIns({ tasksDB: tasks, staffDB, targetDate: DATE, windowDates: WIN, fullRoster });
  assert.equal(r.unresolved.length, 0);
  assert.ok(r.actions.length >= 1 && r.actions.length <= 3);
  const used = new Set(r.tasks.filter(t => t.id.startsWith('o')).map(t => t.employee));
  assert.ok(![...used].includes(OPEN));
});
