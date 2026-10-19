// Stands the walk cannot be resolved for: a hand-off rule table (no network: the
// 5 minute / 5 unit heuristic; with a network: the walk time; an island: never; a
// stand missing from the network: the heuristic again), and random scenes mixing
// known, unknown and island stands, where every entry point must give a plan the
// independent check accepts, with nothing left for the final check to reopen.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, DEFAULT_POLICY, conflictsWith, fitsShift, runOptimizer, improveAssignment, lnsImprove, planWindow,
  applyChanges, validatePlan, findConflicts,
} from '../src/optimizer.js';
import { createDistanceResolver } from '../src/utils/travelGraph.js';
import { OPEN, DATE, D, mkTask, mkPerson, dbOf, rng } from './helpers.mjs';

const WIN = [DATE];
test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

const mk = (id, a, b, pos, extra = {}) => mkTask(id, a, b, ['Q1'], { pos, ...extra });
const plus = (d, min) => new Date(d.getTime() + min * 60000);

// ── no network: the heuristic ───────────────────────────────────────────────
test('heuristic: the same stand and neighbouring numbers never need a gap', () => {
  const a = mk('a', D(9), D(10), 'S01');
  assert.equal(conflictsWith(a, mk('b', D(10), D(11), 'S01'), null), false);
  assert.equal(conflictsWith(a, mk('b', D(10), D(11), 'S04'), null), false, 'distance 3 < 5');
});

test('heuristic: stands 5 or more apart need 5 minutes, different letters count as far apart', () => {
  const a = mk('a', D(9), D(10), 'S01');
  for (const far of ['S06', 'S99', 'K01', 'ПЕРРОН']) {
    assert.equal(conflictsWith(a, mk('b', D(10, 4), D(11), far), null), true, `${far}: 4 min is not enough`);
    assert.equal(conflictsWith(a, mk('b', D(10, 5), D(11), far), null), false, `${far}: 5 min is enough`);
    assert.equal(conflictsWith(a, mk('b', D(10, 0), D(11), far), null), true, `${far}: back to back`);
    assert.equal(conflictsWith(mk('b', D(10, 4), D(11), far), a, null), true, 'the order of the pair does not matter');
  }
  assert.equal(conflictsWith(a, mk('b', D(10, 0), D(11), 'S06'), null), true, 'distance exactly 5');
  assert.equal(conflictsWith(a, mk('b', D(10, 0), D(11), 'S05'), null), false, 'distance 4');
});

test('heuristic: the exit stand of the first and the entry stand of the second decide, not the display stand', () => {
  const a = mk('a', D(9), D(10), 'S01', { exitPos: 'S20' });
  const b = mk('b', D(10), D(11), 'S01', { entryPos: 'S01' });
  assert.equal(conflictsWith(a, b, null), true, 'a ends at S20, b starts at S01');
  assert.equal(conflictsWith(a, { ...b, entryPos: 'S21' }, null), false, 'S20 to S21 is next door');
});

test('heuristic: an empty or missing stand counts as far away from every other one', () => {
  const a = mk('a', D(9), D(10), 'S01');
  for (const empty of ['', '  ', null]) {
    const b = mk('b', D(10, 0), D(11), empty, { entryPos: empty, exitPos: empty });
    assert.equal(conflictsWith(a, b, null), true, JSON.stringify(empty));
  }
});

// ── with a network ──────────────────────────────────────────────────────────
// S01, S02 one node; S03 300 m from it; S05 another 800 m on; S06+S07 an island of their own;
// S08 is not in tb_location.
const network = () => createDistanceResolver({
  locations: [['S01', 'n0'], ['S02', 'n0'], ['S03', 'n1'], ['S05', 'n2'], ['S06', 'nI'], ['S07', 'nI2']]
    .map(([internal_id, node_ref]) => ({ internal_id, node_ref })),
  travelEdges: [['n0', 'n1', 300], ['n1', 'n2', 800], ['nI', 'nI2', 100]]
    .map(([a, b, Distance]) => ({ 'Start node': a, 'End node': b, Distance })),
});
const WALK_MIN = m => (m / (5000 / 3600)) / 60; // minutes to walk m metres at 5 km/h

test('network: the gap must cover the walk (300 m = 3.6 min), 1 second short is a conflict', () => {
  const r = network();
  const a = mk('a', D(9), D(10), 'S01');
  const need = WALK_MIN(300) * 60000;
  const at = gapMs => mk('b', new Date(D(10).getTime() + gapMs), new Date(D(11).getTime() + gapMs), 'S03');
  assert.equal(conflictsWith(a, at(need), r), false, 'exactly the walk');
  assert.equal(conflictsWith(a, at(need - 1000), r), true, 'a second short');
  assert.equal(conflictsWith(a, at(0), r), true);
  // the same node needs no walk at all
  assert.equal(conflictsWith(a, mk('b', D(10), D(11), 'S02'), r), false);
  // the far stand: 1100 m = 13.2 min
  const far = gap => mk('b', plus(D(10), gap), plus(D(11), gap), 'S05');
  assert.equal(conflictsWith(a, far(13), r), true);
  assert.equal(conflictsWith(a, far(14), r), false);
});

test('network: no path between two known stands is a conflict however long the gap', () => {
  const r = network();
  const a = mk('a', D(9), D(10), 'S01');
  assert.equal(conflictsWith(a, mk('b', D(18), D(19), 'S06'), r), true, 'S01 to the island, 8 hours later');
  assert.equal(conflictsWith(mk('b', D(18), D(19), 'S06'), a, r), true, 'and the other way round');
  assert.equal(conflictsWith(mk('x', D(9), D(10), 'S06'), mk('y', D(10), D(11), 'S07'), r), true, 'inside the island: 100 m = 1.2 min, no gap');
  assert.equal(conflictsWith(mk('x', D(9), D(10), 'S06'), mk('y', D(10, 2), D(11), 'S07'), r), false, 'inside the island they do walk');
  assert.equal(conflictsWith(mk('x', D(9), D(10), 'S06'), mk('y', D(10), D(11), 'S06'), r), false);
});

test('network: a stand missing from the network falls back to the heuristic, not to "unreachable"', () => {
  const r = network();
  const a = mk('a', D(9), D(10), 'S01');
  assert.equal(conflictsWith(a, mk('b', D(10), D(11), 'S08'), r), true, 'S01 to S08: distance 7 by the heuristic, no gap');
  assert.equal(conflictsWith(a, mk('b', D(10, 5), D(11), 'S08'), r), false, 'with 5 minutes it is fine');
  assert.equal(conflictsWith(mk('u', D(9), D(10), 'S08'), mk('v', D(10), D(11), 'S08'), r), false, 'same unknown stand');
  assert.equal(conflictsWith(mk('u', D(9), D(10), 'S12'), mk('v', D(10), D(11), 'S06'), r), true, 'unknown S12 to the island S06: distance 6 by the heuristic');
});

test('network: the walk from the shift base counts for the first task, an island base reaches nothing', () => {
  const r = network();
  const person = { name: 'P', quals: ['Q1'], shiftStart: D(9), shiftEnd: D(18), basePos: 'S01' };
  assert.equal(fitsShift(person, mk('a', D(9, 3), D(10), 'S03'), r), false, '3 min is less than the 3.6 min walk');
  assert.equal(fitsShift(person, mk('a', D(9, 4), D(10), 'S03'), r), true);
  assert.equal(fitsShift({ ...person, basePos: 'S06' }, mk('a', D(15), D(16), 'S01'), r), false, 'from the island base to S01: never');
  // an unknown base is not checked at all (the heuristic only looks at hand-offs between tasks)
  assert.equal(fitsShift({ ...person, basePos: 'S08' }, mk('a', D(9, 0), D(10), 'S01'), r), true);
});

test('findConflicts lists every task of that person that clashes, not the task itself or others', () => {
  const r = network();
  const tasks = [
    mk('x', D(9), D(10), 'S01', { employee: 'P' }), mk('y', D(10), D(11), 'S06', { employee: 'P' }),
    mk('z', D(12), D(13), 'S01', { employee: 'Q' }), mk('t', D(9, 30), D(10, 30), 'S01'),
  ];
  const ids = emp => findConflicts(emp, tasks[3], tasks, r).map(t => t.id).sort();
  assert.deepEqual(ids('P'), ['x', 'y'], 'overlap with x, island walk from t to y');
  assert.deepEqual(ids('Q'), []);
  assert.deepEqual(findConflicts('P', tasks[0], tasks, r).map(t => t.id), ['y'], 'x against its own person: only y (no path S01-S06 after 0 gap)');
  assert.deepEqual(findConflicts('nobody', tasks[3], tasks, r), []);
});

// ── random scenes: known, unknown and island stands mixed ───────────────────
test('a plan with stands of every kind is valid from every entry point (200 seeds)', () => {
  const r = network();
  const stands = ['S01', 'S02', 'S03', 'S05', 'S06', 'S07', 'S08', 'S09'];
  let tasksTotal = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = rng(seed * 17 + 3);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const people = [mkPerson('P0', ['Q1', 'Q2'], 6, 24), mkPerson('P1', ['Q1', 'Q2'], 8, 22, rnd() < 0.3 ? pick(stands) : null), mkPerson('P2', ['Q1'], 10, 20)];
    const tasks = Array.from({ length: 6 + Math.floor(rnd() * 12) }, (_, i) => {
      const s = D(7 + Math.floor(rnd() * 14), Math.floor(rnd() * 12) * 5);
      const p = pick(stands);
      return mkTask('t' + i, s, plus(s, pick([20, 30, 45, 60])), [pick(['Q1', 'Q1', 'Q2'])],
        { pos: p, entryPos: rnd() < 0.2 ? pick(stands) : p, exitPos: rnd() < 0.2 ? pick(stands) : p });
    });
    tasksTotal += tasks.length;
    const staff = dbOf(...people);
    const check = (plan, label) => assert.deepEqual(validatePlan(plan, staff, DATE, r, WIN), [], `seed ${seed} ${label}`);
    for (const construction of ['regret', 'bestfit', 'greedy']) {
      check(runOptimizer(tasks, staff, DATE, r, WIN, undefined, { construction }), construction);
    }
    const base = runOptimizer(tasks, staff, DATE, r, WIN);
    check(improveAssignment(base, staff, DATE, r, WIN).tasks, 'improve');
    check(lnsImprove(base, staff, DATE, r, WIN, { maxIterations: 15 }).tasks, 'lns');
    const planned = planWindow(tasks, staff, DATE, r, WIN, { lnsIterations: 8 });
    assert.deepEqual(planned.stats.violations, [], `seed ${seed} planWindow`);
    assert.equal(planned.stats.reopenedByCheck, 0, `seed ${seed}: the search itself is right, the check reopened nothing`);
    const moved = tasks[0];
    const changed = applyChanges(planned.tasks, staff, DATE, r, WIN, [
      { id: moved.id, start: plus(moved.start, 30), end: plus(moved.end, 30) },
      mkTask('new', D(12), D(13), ['Q1'], { pos: pick(stands) }),
    ]);
    assert.deepEqual(changed.violations, [], `seed ${seed} applyChanges`);
    check(changed.tasks, 'applyChanges');
  }
  assert.ok(tasksTotal > 1000);
});

test('a task only reachable through the island is never given to someone coming from elsewhere (and an empty plan stays valid)', () => {
  const r = network();
  const staff = dbOf(mkPerson('P', ['Q1'], 6, 20));
  const tasks = [mk('a', D(8), D(9), 'S01'), mk('b', D(15), D(16), 'S06'), mk('c', D(18), D(19), 'S02')];
  const out = planWindow(tasks, staff, DATE, r, WIN, { lnsIterations: 0 });
  // P can do a and c (same node) or only the island task between them, never all three
  assert.equal(out.stats.openDay, 1);
  assert.deepEqual(out.stats.violations, []);
  assert.equal(out.tasks.filter(t => t.employee === OPEN)[0].id, 'b', 'the island task is the one left');
  assert.equal(planWindow([], staff, DATE, r, WIN, { lnsIterations: 0 }).stats.openDay, 0);
});
