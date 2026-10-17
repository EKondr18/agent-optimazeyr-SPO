// The frozen hour of a batch update. Tasks starting before now + frozenWindowMs
// are the dispatcher's immediate work: the conflict repair may move a task that
// the edit itself broke, but it must not shuffle OTHER people's tasks in that
// hour to make room (a displacement chain used to, because it only looked at
// "starts after now"). A repair also stays inside its scope end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy, DEFAULT_POLICY, applyChanges, patchConflicts, validatePlan } from '../src/optimizer.js';

const OPEN = 'Не назначено';
const DATE = '2026-01-01';
const WIN = [DATE];
const D = (h, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));
const mk = (id, sh, sm, eh, em, qual, employee, extra = {}) => ({
  id, date: DATE, name: 'T' + id, flight: 'FL' + id, pos: 'S01', entryPos: 'S01', exitPos: 'S01',
  reqType: qual, reqTypes: qual ? [qual] : [], start: D(sh, sm), end: D(eh, em), employee, isLocked: false, ...extra,
});
const person = (name, quals, from, to) => ({ name, quals, shiftStart: D(from), shiftEnd: D(to), basePos: null });
const empOf = (tasks, id) => tasks.find(t => t.id === id).employee;

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

// Six tasks, four people (the minimal case the review found), now = 09:00.
// Editing t3 from 06:30-08:30 to 07:15-09:15 makes it overlap t9 (09:10-09:40) of
// the same person. Every other person is busy at 09:10 too, so the only way to
// seat t9 is to push t5 (09:10-09:55) or t7 or t2 (09:20) onto someone else — all
// of them inside the frozen hour and none of them broken by the edit.
function scene() {
  const staff = { [DATE]: [
    person('P00', ['Q1'], 8, 18), person('P01', ['Q1'], 8, 20), person('P02', ['Q1'], 5, 14), person('P03', ['Q1'], 6, 16),
  ] };
  const tasks = [
    mk('t0', 6, 50, 8, 50, 'Q1', 'P03'),
    mk('t2', 9, 20, 11, 20, '', 'P03'),
    mk('t3', 6, 30, 8, 30, 'Q1', 'P02'),
    mk('t5', 9, 10, 9, 55, '', 'P01'),
    mk('t7', 8, 15, 9, 15, 'Q1', 'P00'),
    mk('t9', 9, 10, 9, 40, 'Q1', 'P02'),
  ];
  return { staff, tasks, change: { id: 't3', start: D(7, 15), end: D(9, 15) }, now: D(9) };
}

test('a repair does not shuffle other people\'s tasks inside the frozen hour', () => {
  const { staff, tasks, change, now } = scene();
  const out = applyChanges(tasks, staff, DATE, null, WIN, [change], { now });
  for (const id of ['t0', 't2', 't5', 't7']) {
    assert.equal(empOf(out.tasks, id), tasks.find(t => t.id === id).employee, `${id} was moved`);
  }
  // what the edit broke is repaired (here: nowhere to go, so it is open) and the plan is valid
  assert.deepEqual(validatePlan(out.tasks, staff, DATE, null, WIN), []);
  assert.ok(out.repairs.every(r => !r.viaBump), 'no displacement chain inside the hour');
  assert.notEqual(empOf(out.tasks, 't9'), 'P02');
});

test('outside the frozen hour a displacement chain still makes room', () => {
  const { staff, tasks, change } = scene();
  // the same case an hour and a half earlier: now = 07:30, the hour ends 08:30, so t5/t2/t7 are free to move
  const out = applyChanges(tasks, staff, DATE, null, WIN, [change], { now: D(7, 30) });
  assert.deepEqual(validatePlan(out.tasks, staff, DATE, null, WIN), []);
  assert.notEqual(empOf(out.tasks, 't9'), OPEN, 'with the hour not in the way t9 is seated by a chain');
});

test('patchConflicts: frozenBefore limits what a chain may displace, not what the edit broke', () => {
  const { staff, tasks, change } = scene();
  const edited = tasks.map(t => (t.id === change.id ? { ...t, ...change } : t));
  const free = patchConflicts(edited, staff, DATE, null, WIN, D(9), new Date(8.64e15));
  assert.ok(free.changes.some(c => c.viaBump), 'without a frozen hour the chain is used (the old behaviour)');
  const held = patchConflicts(edited, staff, DATE, null, WIN, D(9), new Date(8.64e15), { frozenBefore: D(10) });
  assert.deepEqual(held.changes.filter(c => c.viaBump), []);
  // the broken task itself is still dealt with, even though it starts inside the hour
  assert.ok(held.changes.some(c => c.taskId === 't9'));
});

test('patchConflicts: a chain does not displace a task that starts at or after scopeEnd', () => {
  // B (09:00-10:00) is broken by C (09:30-10:30) on P1; C starts after the scope, so B has to leave.
  // P2 holds D (09:30-10:30, Q2), which is the only thing in B's way there — and D is beyond the scope too.
  const staff = { [DATE]: [
    person('P1', ['Q1'], 6, 18), person('P2', ['Q1', 'Q2'], 6, 18), person('P3', ['Q2'], 6, 18),
  ] };
  const tasks = [
    mk('B', 9, 0, 10, 0, 'Q1', 'P1'),
    mk('C', 9, 30, 10, 30, 'Q1', 'P1'),
    mk('D', 9, 30, 10, 30, 'Q2', 'P2'),
    // P3 is free for D, so a chain through D would work if it were allowed
  ];
  const r = patchConflicts(tasks, staff, DATE, null, WIN, D(8), D(9, 15));
  assert.equal(empOf(r.tasks, 'D'), 'P2', 'D is outside the scope and stays');
  assert.deepEqual(r.changes.filter(c => c.viaBump), []);
  assert.equal(empOf(r.tasks, 'C'), 'P1', 'C is outside the scope and stays');
});
