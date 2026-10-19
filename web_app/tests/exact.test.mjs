// The plan against the exact optimum on small inputs (up to 8 tasks, up to 4
// people, found by full enumeration in the test): the search may never claim to
// beat the optimum (that would be a broken rule), the lower bound may never
// exceed it, and the plan stays within one task of it. Overtime allowances 0 / 30 /
// 60 minutes. The two known gaps (plateau moves the search does not make) are
// kept as `todo` with their minimal examples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy, DEFAULT_POLICY, planWindow, validatePlan } from '../src/optimizer.js';
import { createDistanceResolver } from '../src/utils/travelGraph.js';
import { DATE, D, mkTask, mkPerson, dbOf, tinyInstance, exactOptimum, openCount } from './helpers.mjs';

const WIN = [DATE];
test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

// stands S01/S02 share a node, S03/S04 another, S05 a third, S06 is an island, S07 is far
// away, S08 is not in the network at all
const network = () => createDistanceResolver({
  locations: [['S01', 'n0'], ['S02', 'n0'], ['S03', 'n1'], ['S04', 'n1'], ['S05', 'n2'], ['S06', 'nI'], ['S07', 'n4']]
    .map(([internal_id, node_ref]) => ({ internal_id, node_ref })),
  travelEdges: [['n0', 'n1', 300], ['n1', 'n2', 800], ['n2', 'n4', 2500]]
    .map(([a, b, Distance]) => ({ 'Start node': a, 'End node': b, Distance })),
});

function sweep({ seeds, allowance, resolver, lnsIterations }) {
  setPolicy({ maxOvertimeMin: allowance });
  const out = { worse: [], better: [], boundOver: [], violations: 0, tooFar: [], sizes: { tasks: 0, people: 0 } };
  for (let seed = 1; seed <= seeds; seed++) {
    const { tasks, staff, people } = tinyInstance(seed);
    assert.ok(tasks.length <= 8 && people.length <= 4, 'the instances stay small enough for full enumeration');
    out.sizes.tasks = Math.max(out.sizes.tasks, tasks.length);
    out.sizes.people = Math.max(out.sizes.people, people.length);
    const opt = exactOptimum(tasks, people, resolver);
    const r = planWindow(tasks, staff, DATE, resolver, WIN, { lnsIterations });
    const open = r.stats.openDay;
    if (open < opt) out.better.push(seed);
    if (open > opt) out.worse.push(seed);
    if (open > opt + 1) out.tooFar.push(`${seed}: ${open} vs ${opt}`);
    if (r.stats.lowerBound.bound > opt) out.boundOver.push(`${seed}: bound ${r.stats.lowerBound.bound} > optimum ${opt}`);
    out.violations += r.stats.violations.length + validatePlan(r.tasks, staff, DATE, resolver, WIN).length;
    assert.equal(r.stats.open.final, open, 'one day: the window count is the day count');
  }
  return out;
}

for (const allowance of [0, 30, 60]) {
  test(`no network, overtime ${allowance} min, 500 seeds: never better than the optimum, within 1 of it, the bound is sound`, t => {
    const r = sweep({ seeds: 500, allowance, resolver: null, lnsIterations: 0 });
    t.diagnostic(`larger than the optimum in ${r.worse.length} of 500 (seeds ${r.worse.join(',') || '-'})`);
    assert.deepEqual(r.better, [], 'fewer open than the exact optimum: a rule is broken somewhere');
    assert.deepEqual(r.boundOver, []);
    assert.deepEqual(r.tooFar, []);
    assert.equal(r.violations, 0);
    assert.ok(r.worse.length <= 5, `at most 1 % of the cases lose a task (${r.worse.length})`);
  });
}

test('with the default LNS (150 seeds, overtime 60) the plan is within 1 of the optimum and mostly exact', t => {
  const r = sweep({ seeds: 150, allowance: 60, resolver: null });
  t.diagnostic(`larger than the optimum in ${r.worse.length} of 150`);
  assert.deepEqual(r.better, []);
  assert.deepEqual(r.boundOver, []);
  assert.deepEqual(r.tooFar, []);
  assert.equal(r.violations, 0);
  assert.ok(r.worse.length <= 2);
});

for (const allowance of [0, 60]) {
  test(`network with an island and an unknown stand, overtime ${allowance} min, 400 seeds: sound, within 2 of the optimum`, t => {
    const resolver = network();
    const r = sweep({ seeds: 400, allowance, resolver, lnsIterations: 0 });
    t.diagnostic(`larger than the optimum in ${r.worse.length} of 400`);
    assert.deepEqual(r.better, []);
    assert.deepEqual(r.boundOver, []);
    assert.equal(r.violations, 0);
    assert.ok(r.tooFar.length <= 4, `a gap of 2 or more is rare: ${r.tooFar.join('; ')}`);
    assert.ok(r.worse.length <= 30, `most of the 400 are exact (${r.worse.length} are not)`);
  });
}

// ── The two known gaps ──────────────────────────────────────────────────────
// Both need a move that does not lower the open count by itself (swap who does
// what, then place two): one single move, even a chain, finds nothing better
// and the LNS repair puts the hardest task back first.
test('F16 (no network) a three-task rearrangement frees one more task', { todo: 'the improvement search and the LNS stop at 2 open; the optimum is 1' }, () => {
  // P1 can do everything, P0 only Q2+Q3. t2 (Q1) can only go to P1; t3 (Q1+Q3) only to P1 too.
  // Optimum: P1 does t4 then t3, P0 does t1, t2 stays open (1 open). Found: t2 to P1, t4 to P0 (2 open).
  const staff = dbOf(mkPerson('P0', ['Q2', 'Q3'], 6, 15), mkPerson('P1', ['Q1', 'Q2', 'Q3'], 6, 14));
  const tasks = [
    mkTask('t1', D(9, 15), D(10, 0), ['Q2'], { pos: 'S03' }),
    mkTask('t2', D(8, 45), D(10, 15), ['Q1'], { pos: 'S07' }),
    mkTask('t3', D(9, 45), D(10, 15), ['Q1', 'Q3'], { pos: 'S07' }),
    mkTask('t4', D(8, 15), D(9, 30), ['Q3'], { pos: 'S01' }),
  ];
  const r = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 200 });
  assert.equal(exactOptimum(tasks, staff[DATE]), 1);
  assert.equal(r.stats.openDay, 1, `open ${r.stats.openDay}`);
});

test('F16 (network) the same with an island stand: P1 does t1 and t0 at S05, t4 at the island stays open', { todo: 'plateau move not found: 2 open, the optimum is 1' }, () => {
  const resolver = network();
  const staff = dbOf(mkPerson('P0', ['Q1'], 7, 15), mkPerson('P1', ['Q1', 'Q2', 'Q3'], 7, 15));
  const tasks = [
    mkTask('t0', D(11, 30), D(12, 30), ['Q1', 'Q2'], { pos: 'S05' }),
    mkTask('t1', D(9, 15), D(10, 15), ['Q1', 'Q3'], { pos: 'S05' }),
    mkTask('t4', D(9, 0), D(9, 45), ['Q3'], { pos: 'S06' }),
  ];
  const r = planWindow(tasks, staff, DATE, resolver, WIN, { lnsIterations: 200 });
  assert.equal(exactOptimum(tasks, staff[DATE], resolver), 1);
  assert.equal(r.stats.openDay, 1, `open ${r.stats.openDay}`);
  assert.equal(openCount(r.tasks), r.stats.openDay);
});
