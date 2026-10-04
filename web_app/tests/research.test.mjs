// Regression tests for the defects found by the external research review
// (SPO_Research_and_Implementation_Plan, October 2026). Each test is the
// minimal reproduction the review gives, turned into an assertion about the
// correct behaviour, plus property tests that every entry point only ever
// produces plans the independent validator accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runOptimizer, improveAssignment, applyChanges, hasAllQuals, setPolicy, DEFAULT_POLICY,
  validatePlan, lnsImprove, unassignedLowerBound, assignmentCost,
} from '../src/optimizer.js';
import { createDistanceResolver } from '../src/utils/travelGraph.js';
import { resolveStaffingWithCallIns } from '../src/utils/staffingGap.js';
import { dataQualityReport } from '../src/utils/dataQuality.js';

const D = (h, m = 0) => new Date(2026, 0, 1, h, m);
const DATE = '2026-01-01';
const WIN = [DATE];
const OPEN = 'Не назначено';
const mk = (id, h, m, eh, em, qual, employee = OPEN, pos = 'POS1', extra = {}) => ({
  id, date: DATE, name: 'T' + id, flight: 'FL' + id, pos, entryPos: pos, exitPos: pos,
  reqType: qual, reqTypes: [qual], start: D(h, m), end: D(eh, em), employee, isLocked: false, ...extra,
});
const person = (name, quals, from = 6, to = 20, basePos = null) =>
  ({ name, quals, shiftStart: D(from), shiftEnd: D(to), basePos });
const db = (...people) => ({ [DATE]: people });
const empOf = (tasks, id) => tasks.find(t => t.id === id).employee;
const open = tasks => tasks.filter(t => t.employee === OPEN).length;
const fullRun = (tasks, staffDB, resolver = null) =>
  improveAssignment(runOptimizer(tasks, staffDB, DATE, resolver, WIN), staffDB, DATE, resolver, WIN).tasks;

test.beforeEach(() => setPolicy(DEFAULT_POLICY));

test('R1: an empty reqTypes array does not erase a scalar requirement', () => {
  const t = { reqTypes: [], reqType: 'MANDATORY' };
  assert.equal(hasAllQuals([], t), false);
  assert.equal(hasAllQuals(['MANDATORY'], t), true);
});

test('R8: overtime is bounded by policy, not unlimited', () => {
  const staff = db(person('S1', ['Q1'], 6, 10));
  // 10:00-18:00 against a 06-10 shift: +480 min, never acceptable
  assert.equal(open(fullRun([mk('long', 9, 59, 18, 0, 'Q1')], staff)), 1);
  // +30 min fits the default allowance
  assert.equal(open(fullRun([mk('short', 9, 30, 10, 30, 'Q1')], staff)), 0);
  setPolicy({ maxOvertimeMin: 0 });
  assert.equal(open(fullRun([mk('short', 9, 30, 10, 30, 'Q1')], staff)), 1);
});

// Two stands 20 minutes' walk apart (1667 m at 5 km/h), plus a third stand
// that exists in the network but has no path to the others.
const resolver = () => createDistanceResolver({
  locations: [
    { internal_id: 'BASE', node_ref: 'n1' }, { internal_id: 'FAR', node_ref: 'n2' },
    { internal_id: 'POS1', node_ref: 'n1' }, { internal_id: 'ISLAND', node_ref: 'n9' },
  ],
  travelEdges: [{ 'Start node': 'n1', 'End node': 'n2', Distance: 1667 }],
});

test('R2: the walk from the shift base to the first task is a hard check', () => {
  const r = resolver();
  const staff = db(person('S1', ['Q1'], 6, 20, 'BASE'));
  assert.equal(open(fullRun([mk('first', 6, 0, 6, 30, 'Q1', OPEN, 'FAR')], staff, r)), 1);
  assert.equal(open(fullRun([mk('later', 6, 30, 7, 0, 'Q1', OPEN, 'FAR')], staff, r)), 0);
});

test('R4: two overlapping tasks of one flight are not given to one person by default', () => {
  const staff = db(person('S1', ['Q1']));
  const a = { ...mk('a', 9, 0, 10, 0, 'Q1'), flight: 'SU100', name: 'OUT_1' };
  const b = { ...mk('b', 9, 0, 10, 0, 'Q1'), flight: 'SU100', name: 'OUT_2' };
  assert.equal(open(fullRun([a, b], staff)), 1);
  setPolicy({ sameFlightOverlap: true }); // the old rule, still available as an explicit policy
  assert.equal(open(fullRun([a, b], staff)), 0);
});

test('R11: stands with no path between them are not treated as next to each other', () => {
  const r = resolver();
  const staff = db(person('S1', ['Q1']));
  const tasks = [mk('a', 9, 0, 10, 0, 'Q1', OPEN, 'POS1'), mk('b', 10, 0, 11, 0, 'Q1', OPEN, 'ISLAND')];
  assert.equal(open(fullRun(tasks, staff, r)), 1);
});

test('R3: a displacement chain explores a person again on a different branch', () => {
  const staff = db(person('A', ['qa', 'qb', 'qt']), person('B', ['qb', 'qt']));
  const tasks = [
    mk('a', 10, 0, 10, 30, 'qa', 'A'),
    mk('b', 9, 30, 10, 0, 'qb', 'B'),
    mk('target', 9, 30, 10, 30, 'qt'),
  ];
  for (const weights of [undefined, { load: 0, walk: 0, slack: 0, overtime: 0 }]) {
    const r = improveAssignment(tasks, staff, DATE, null, WIN, { weights }).tasks;
    assert.equal(open(r), 0);
    assert.equal(empOf(r, 'target'), 'B');
    assert.deepEqual(validatePlan(r, staff, DATE, null, WIN), []);
  }
});

test('R9: an assignment to someone no longer on shift is re-placed with no explicit change', () => {
  const s1 = person('S1', ['Q1']), s2 = person('S2', ['Q1']);
  const base = [mk('a', 9, 0, 9, 30, 'Q1', 'S1'), mk('b', 12, 0, 12, 30, 'Q1', 'S1')];
  const out = applyChanges(base, db(s2), DATE, null, WIN, []);
  assert.equal(empOf(out.tasks, 'a'), 'S2');
  assert.equal(empOf(out.tasks, 'b'), 'S2');
  assert.deepEqual(validatePlan(out.tasks, db(s2), DATE, null, WIN), []);
  // nobody left at all: the tasks go back to the backlog and are reported
  const none = applyChanges(base, db(), DATE, null, WIN, []);
  assert.equal(open(none.tasks), 2);
  assert.equal(none.unplaced.length, 2);
});

test('R12: a call-in never overlaps the person\'s own next shift', () => {
  const p = { name: 'P', quals: ['Q1'] };
  const shifts = new Map([['P', [{ shiftStart: D(13), shiftEnd: D(17) }]]]);
  const r = resolveStaffingWithCallIns({
    tasksDB: [mk('t', 8, 0, 8, 30, 'Q1')], staffDB: db(), targetDate: DATE, windowDates: WIN,
    fullRoster: [p], allShiftsByPerson: shifts, distanceResolver: null,
  });
  assert.equal(r.unresolved.length, 0);
  for (const a of r.actions) {
    assert.ok(a.shiftEnd <= D(13), `proposed duty ${a.shiftStart.toTimeString()}-${a.shiftEnd.toTimeString()} runs into the 13:00 shift`);
  }
});

test('validator reports each kind of hard violation', () => {
  const staff = db(person('S1', ['Q1'], 6, 12));
  const plan = [
    mk('ok', 7, 0, 7, 30, 'Q1', 'S1'),
    mk('qual', 8, 0, 8, 30, 'Q2', 'S1'),
    mk('ov1', 9, 0, 9, 40, 'Q1', 'S1'), mk('ov2', 9, 20, 9, 50, 'Q1', 'S1'),
    mk('late', 13, 0, 13, 30, 'Q1', 'S1'),
    mk('ghost', 7, 0, 7, 30, 'Q1', 'NOBODY'),
  ];
  const codes = validatePlan(plan, staff, DATE, null, WIN).map(v => `${v.taskId}:${v.code}`).sort();
  assert.deepEqual(codes, ['ghost:NO_SHIFT', 'late:OUT_OF_SHIFT', 'ov2:OVERLAP', 'qual:QUAL_MISSING']);
});

// Small seeded random instances: mixed qualifications, short shifts, stands
// near and far, flights shared by several tasks.
function randomInstance(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const quals = ['Q1', 'Q2', 'Q3'];
  const people = Array.from({ length: 6 }, (_, i) => {
    const qs = quals.filter(() => rnd() < 0.6);
    const from = 5 + Math.floor(rnd() * 4);
    return person('P' + i, qs.length ? qs : ['Q1'], from, from + 6 + Math.floor(rnd() * 6), 'POS' + Math.floor(rnd() * 40));
  });
  const tasks = Array.from({ length: 40 }, (_, i) => {
    const h = 6 + Math.floor(rnd() * 14), m = Math.floor(rnd() * 4) * 15;
    const dur = 15 + Math.floor(rnd() * 5) * 15;
    const start = D(h, m), end = new Date(start.getTime() + dur * 60000);
    const q = [quals[Math.floor(rnd() * 3)]];
    if (rnd() < 0.15) q.push(quals[Math.floor(rnd() * 3)]);
    const pos = 'POS' + Math.floor(rnd() * 40);
    return {
      id: 'r' + i, date: DATE, name: 'N' + (i % 5), flight: 'F' + Math.floor(i / 3), pos, entryPos: pos, exitPos: pos,
      reqType: [...new Set(q)].join(' + '), reqTypes: [...new Set(q)], start, end, employee: OPEN, isLocked: false,
    };
  });
  return { people, tasks, staff: db(...people) };
}

test('property: every entry point yields only plans the validator accepts', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { tasks, staff } = randomInstance(seed);
    const built = runOptimizer(tasks, staff, DATE, null, WIN);
    assert.deepEqual(validatePlan(built, staff, DATE, null, WIN), [], `runOptimizer seed ${seed}`);
    const packed = runOptimizer(tasks, staff, DATE, null, WIN, undefined, { construction: 'bestfit' });
    assert.deepEqual(validatePlan(packed, staff, DATE, null, WIN), [], `bestfit seed ${seed}`);
    const imp = improveAssignment(built, staff, DATE, null, WIN).tasks;
    assert.deepEqual(validatePlan(imp, staff, DATE, null, WIN), [], `improve seed ${seed}`);
    const lns = lnsImprove(imp, staff, DATE, null, WIN, { maxIterations: 60, seed }).tasks;
    assert.deepEqual(validatePlan(lns, staff, DATE, null, WIN), [], `lns seed ${seed}`);
    assert.ok(open(lns) <= open(imp), `lns must not lose coverage (seed ${seed})`);
    if (open(lns) === open(imp)) {
      assert.ok(assignmentCost(lns, staff, DATE, null, WIN) <= assignmentCost(imp, staff, DATE, null, WIN) + 1e-6);
    }
    const lb = unassignedLowerBound(tasks, staff, DATE, WIN);
    assert.ok(lb.bound <= open(lns), `lower bound ${lb.bound} above achieved ${open(lns)} (seed ${seed})`);
    const changed = applyChanges(lns, staff, DATE, null, WIN, [
      { id: 'r3', start: new Date(tasks[3].start.getTime() + 25 * 60000), end: new Date(tasks[3].end.getTime() + 25 * 60000) },
      { id: 'r7', removed: true },
    ], { now: D(8) }).tasks;
    assert.deepEqual(validatePlan(changed, staff, DATE, null, WIN), [], `applyChanges seed ${seed}`);
  }
});

test('lower bound: three simultaneous tasks for two people leave at least one open', () => {
  const staff = db(person('S1', ['Q1']), person('S2', ['Q1', 'Q2']));
  const tasks = [mk('a', 9, 0, 10, 0, 'Q1'), mk('b', 9, 30, 10, 30, 'Q1'), mk('c', 9, 45, 10, 15, 'Q2')];
  const lb = unassignedLowerBound(tasks, staff, DATE, WIN);
  assert.equal(lb.bound, 1);
  assert.equal(open(fullRun(tasks, staff)), 1);
});

test('LNS stays inside its time budget and keeps frozen work in place', () => {
  const { tasks, staff } = randomInstance(99);
  const base = improveAssignment(runOptimizer(tasks, staff, DATE, null, WIN), staff, DATE, null, WIN).tasks;
  const t0 = Date.now();
  const r = lnsImprove(base, staff, DATE, null, WIN, { timeBudgetMs: 150, frozenBefore: D(12), seed: 3 });
  assert.ok(Date.now() - t0 < 1500);
  for (const t of base) if (t.start < D(12)) assert.equal(empOf(r.tasks, t.id), t.employee);
});

test('data quality report flags what makes tasks unassignable', () => {
  const tasks = [
    mk('ok', 9, 0, 9, 30, 'Q1'),
    { ...mk('huge', 9, 0, 9, 30, 'Q1'), end: new Date(D(9).getTime() + 100 * 3600000) },
    mk('rare', 9, 0, 9, 30, 'Q_RARE'),
    { ...mk('nextday', 9, 0, 9, 30, 'Q1'), date: '2026-01-02' },
  ];
  const rep = dataQualityReport({ tasks, staffDB: db(person('S1', ['Q1']), person('S0', [])), fullRoster: [] });
  assert.deepEqual(rep.longTasks.map(t => t.id), ['huge']);
  assert.deepEqual(rep.qualsNobodyHolds.map(q => q.qual), ['Q_RARE']);
  assert.deepEqual(rep.datesWithoutShifts, ['2026-01-02']);
  assert.deepEqual(rep.staffWithoutQuals, ['S0']);
});

test('batch update: a single delay does not reshuffle unrelated assignments', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const { tasks, staff } = randomInstance(seed);
    const base = improveAssignment(runOptimizer(tasks, staff, DATE, null, WIN), staff, DATE, null, WIN).tasks;
    const target = base.find(t => t.employee !== OPEN && t.start >= D(11));
    if (!target) continue;
    const out = applyChanges(base, staff, DATE, null, WIN, [
      { id: target.id, start: new Date(target.start.getTime() + 20 * 60000), end: new Date(target.end.getTime() + 20 * 60000) },
    ], { now: D(9) });
    const moved = out.tasks.filter(t => t.id !== target.id && empOf(base, t.id) !== t.employee && empOf(base, t.id) !== OPEN);
    assert.ok(moved.length <= 3, `seed ${seed}: ${moved.length} unrelated tasks moved`);
    assert.deepEqual(validatePlan(out.tasks, staff, DATE, null, WIN), []);
    // with no price on moves the same update may reshuffle freely — the price is what keeps it calm
    const free = applyChanges(base, staff, DATE, null, WIN, [
      { id: target.id, start: new Date(target.start.getTime() + 20 * 60000), end: new Date(target.end.getTime() + 20 * 60000) },
    ], { now: D(9), stability: 0 });
    assert.deepEqual(validatePlan(free.tasks, staff, DATE, null, WIN), []);
  }
});

test('batch update: corrections inside the frozen hour are applied and repaired, nothing else there moves', () => {
  for (let seed = 30; seed <= 40; seed++) {
    const { tasks, staff } = randomInstance(seed);
    const base = improveAssignment(runOptimizer(tasks, staff, DATE, null, WIN), staff, DATE, null, WIN).tasks;
    const now = D(10);
    const near = base.filter(t => t.employee !== OPEN && t.start >= now && t.start < D(11));
    if (near.length < 2) continue;
    const changes = near.slice(0, 2).map(t => ({ id: t.id, start: new Date(t.start.getTime() + 15 * 60000), end: new Date(t.end.getTime() + 15 * 60000) }));
    const out = applyChanges(base, staff, DATE, null, WIN, changes, { now });
    assert.deepEqual(validatePlan(out.tasks, staff, DATE, null, WIN), []);
    for (const c of changes) assert.equal(out.tasks.find(t => t.id === c.id).start.getTime(), c.start.getTime());
    // inside the frozen hour, only tasks that the corrections actually broke may move
    const repaired = new Set(out.repairs.map(r => r.taskId));
    for (const t of base) {
      if (t.start < now || t.start >= D(11) || changes.some(c => c.id === t.id) || repaired.has(t.id)) continue;
      const after = out.tasks.find(x => x.id === t.id);
      if (after) assert.equal(after.employee, t.employee, `seed ${seed}: frozen ${t.id} moved`);
    }
  }
});
