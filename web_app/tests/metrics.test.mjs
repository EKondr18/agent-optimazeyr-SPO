// planMetrics against hand-computed numbers, and the `stats` of planWindow: what
// each field must say on small scenes whose answers can be worked out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, getPolicy, DEFAULT_POLICY, planMetrics, planWindow, assignmentCost, validatePlan,
} from '../src/optimizer.js';
import { createDistanceResolver } from '../src/utils/travelGraph.js';
import { OPEN, DATE, D, mkTask, mkPerson, dbOf, addDays, at } from './helpers.mjs';

const WIN = [DATE];
test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

// ── planMetrics ─────────────────────────────────────────────────────────────
function metricScene() {
  const staff = dbOf(mkPerson('P', ['Q1'], 8, 16, 'S01'), mkPerson('Q', ['Q1'], 8, 16));
  const tasks = [
    mkTask('a', D(8, 30), D(9, 0), ['Q1'], { pos: 'S01', employee: 'P' }),
    mkTask('b', D(9, 10), D(9, 40), ['Q1'], { pos: 'S07', employee: 'P' }),
    mkTask('c', D(15, 30), D(16, 30), ['Q1'], { pos: 'S07', employee: 'P' }),
    mkTask('d', D(10, 0), D(11, 0), ['Q1'], { pos: 'S02', employee: 'Q' }),
    mkTask('e', D(12, 0), D(13, 0), ['Q1'], { pos: 'S02' }),
    mkTask('next', D(9, 0), D(10, 0), ['Q1'], { pos: 'S02', date: addDays(DATE, 1), employee: 'Q' }),
  ];
  return { staff, tasks };
}

test('planMetrics: open, assigned, walk, missing slack, overtime, people, busiest, work spread (no network)', () => {
  const { staff, tasks } = metricScene();
  // P: base S01 -> a (0) -> b (S01 to S07: 6 units) -> c (0); a-b gap 10 min, 5 needed, 15 wanted: 10 short;
  //    c ends 30 min after the shift. work 30+30+60 = 120. Q: one hour. mean 90, sd 30.
  assert.deepEqual(planMetrics(tasks, staff, DATE, null, WIN), {
    open: 1, assigned: 4, walkM: 6, slackShortMin: 10, overtimeMin: 30, peopleUsed: 2, maxTasks: 3,
    workMinMean: 90, workMinSd: 30,
  });
});

test('planMetrics: only the window\'s days count; the window defaults to the selected day', () => {
  const { staff, tasks } = metricScene();
  const two = planMetrics(tasks, { ...staff, [addDays(DATE, 1)]: staff[DATE] }, DATE, null, [DATE, addDays(DATE, 1)]);
  assert.equal(two.assigned, 5);
  assert.equal(two.open, 1);
  assert.deepEqual(planMetrics(tasks, staff, DATE, null, undefined), planMetrics(tasks, staff, DATE, null, WIN));
  assert.deepEqual(planMetrics(tasks, staff, DATE, null, []), planMetrics(tasks, staff, DATE, null, WIN));
});

test('planMetrics: nothing assigned is all zeros, no division by zero', () => {
  assert.deepEqual(planMetrics([mkTask('x', D(9), D(10), ['Q1'])], dbOf(), DATE, null, WIN), {
    open: 1, assigned: 0, walkM: 0, slackShortMin: 0, overtimeMin: 0, peopleUsed: 0, maxTasks: 0, workMinMean: 0, workMinSd: 0,
  });
  assert.deepEqual(planMetrics([], dbOf(), DATE, null, WIN).open, 0);
});

test('planMetrics: with a network the walk is in metres, a hand-off with no path counts as a long walk', () => {
  const resolver = createDistanceResolver({
    locations: [['S01', 'n0'], ['S03', 'n1'], ['S06', 'nI']].map(([internal_id, node_ref]) => ({ internal_id, node_ref })),
    travelEdges: [{ 'Start node': 'n0', 'End node': 'n1', Distance: 300 }],
  });
  const staff = dbOf(mkPerson('P', ['Q1'], 8, 16));
  const plan = [
    mkTask('a', D(9), D(10), ['Q1'], { pos: 'S01', employee: 'P' }),
    mkTask('b', D(10, 30), D(11), ['Q1'], { pos: 'S03', employee: 'P' }),
  ];
  const m = planMetrics(plan, staff, DATE, resolver, WIN);
  assert.equal(m.walkM, 300);
  // gap 30 min, the walk takes 3.6 min, 15 min of spare wanted: 26.4 min spare, nothing short
  assert.equal(m.slackShortMin, 0);
  const tight = [plan[0], { ...plan[1], start: D(10, 4) }];
  assert.equal(planMetrics(tight, staff, DATE, resolver, WIN).slackShortMin, 15, '4 min gap, 3.6 walk: 0.4 spare, 14.6 short (rounded)');
  const island = [plan[0], { ...plan[1], pos: 'S06', entryPos: 'S06', exitPos: 'S06' }];
  assert.equal(planMetrics(island, staff, DATE, resolver, WIN).walkM, 10000, 'the stand-in for "no path"');
});

test('planMetrics: overtime counts once per shift (the latest end), not per task', () => {
  const staff = dbOf(mkPerson('P', ['Q1'], 8, 12));
  const plan = [
    mkTask('a', D(11), D(12, 20), ['Q1'], { employee: 'P' }),
    mkTask('b', D(11, 30), D(12, 40), ['Q1'], { employee: 'P' }),
  ];
  assert.equal(planMetrics(plan, staff, DATE, null, WIN).overtimeMin, 40);
});

// ── planWindow stats ────────────────────────────────────────────────────────
const people = () => [mkPerson('P1', ['Q1'], 6, 20), mkPerson('P2', ['Q1', 'Q2'], 6, 20)];
const day = () => [
  mkTask('t1', D(9), D(10), ['Q1']), mkTask('t2', D(9, 30), D(10, 30), ['Q1']), mkTask('t3', D(10, 0), D(11, 0), ['Q2']),
];

test('stats: the shape and the stage order of a clean run', () => {
  const r = planWindow(day(), dbOf(...people()), DATE, null, WIN, { lnsIterations: 10 });
  const s = r.stats;
  assert.deepEqual(Object.keys(s).sort(), [
    'construction', 'cost', 'improveTermination', 'invalid', 'lns', 'lowerBound', 'ms', 'open', 'openDay', 'reopenedByCheck',
    'terminationReason', 'timeCut', 'tasksDay', 'violations', 'waived',
  ].sort());
  assert.equal(s.tasksDay, 3);
  assert.equal(s.openDay, 0);
  assert.deepEqual(s.open, { build: 0, improve: 0, lns: 0, final: 0 });
  assert.equal(r.tasks.length, 3);
  for (const k of ['build', 'improve', 'lns', 'check']) assert.ok(Number.isFinite(s.ms[k]) && s.ms[k] >= 0, `ms.${k}`);
  assert.ok(['regret', 'bestfit'].includes(s.construction));
  assert.equal(s.timeCut, false);
  assert.equal(s.terminationReason, 'completed');
  assert.equal(s.improveTermination, 'converged');
  assert.equal(s.reopenedByCheck, 0);
  assert.equal(s.waived, 0);
  assert.deepEqual(s.violations, []);
  assert.deepEqual(s.invalid, { count: 0, reasons: {}, items: [] });
  assert.deepEqual(s.lowerBound, { bound: 0, noEligible: 0, peak: null, bottlenecks: [] });
  assert.equal(s.cost, assignmentCost(r.tasks, dbOf(...people()), DATE, null, WIN));
  assert.ok(Number.isFinite(s.cost) && s.cost > 0);
});

test('stats: the open count never grows from build to improve to LNS; the final check can only add', () => {
  for (let n = 3; n <= 9; n += 3) {
    const staff = dbOf(mkPerson('P1', ['Q1'], 9, 12), mkPerson('P2', ['Q1', 'Q2'], 9, 11));
    const tasks = Array.from({ length: n + 3 }, (_, i) => mkTask('t' + i, D(9 + (i % 3)), D(10 + (i % 3)), [i % 4 === 0 ? 'Q2' : 'Q1']));
    const o = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 20 }).stats.open;
    assert.ok(o.build >= o.improve && o.improve >= o.lns && o.final >= o.lns, JSON.stringify(o));
  }
});

test('stats: lnsIterations 0 skips the LNS and says so; a number runs at most that many attempts', () => {
  const none = planWindow(day(), dbOf(...people()), DATE, null, WIN, { lnsIterations: 0 }).stats;
  assert.deepEqual(none.lns, { iterations: 0, accepted: 0, terminationReason: 'skipped' });
  const some = planWindow(day(), dbOf(...people()), DATE, null, WIN, { lnsIterations: 7 }).stats;
  assert.ok(some.lns.iterations > 0 && some.lns.iterations <= 7, `iterations ${some.lns.iterations}`);
  const off = planWindow(day(), dbOf(...people()), DATE, null, WIN, { lnsBudgetMs: 0 }).stats;
  assert.equal(off.lns.terminationReason, 'skipped');
});

test('stats: an explicit construction is reported as asked, auto picks one of the two, a tie goes to regret', () => {
  for (const c of ['regret', 'bestfit', 'greedy']) {
    assert.equal(planWindow(day(), dbOf(...people()), DATE, null, WIN, { construction: c, lnsIterations: 0 }).stats.construction, c);
  }
  // one task, one person: both constructions leave 0 open, a tie
  const tie = planWindow([mkTask('only', D(9), D(10), ['Q1'])], dbOf(mkPerson('P1', ['Q1'], 6, 20)), DATE, null, WIN, { lnsIterations: 0 });
  assert.equal(tie.stats.construction, 'regret', 'same open count: regret');
  assert.equal(planWindow(day(), dbOf(...people()), DATE, null, WIN, { lnsIterations: 0 }).stats.openDay, 0);
});

test('stats: openDay and tasksDay are the selected day\'s; open.* is the whole window', () => {
  const next = addDays(DATE, 1);
  const staff = dbOf(mkPerson('P1', ['Q1'], 6, 20));          // nobody on shift the next day
  const tasks = [mkTask('today', D(9), D(10), ['Q1']), mkTask('tomorrow', at(next, 9), at(next, 10), ['Q1'], { date: next }),
    mkTask('tomorrow2', at(next, 11), at(next, 12), ['Q1'], { date: next })];
  const s = planWindow(tasks, staff, DATE, null, [DATE, next], { lnsIterations: 0 }).stats;
  assert.equal(s.tasksDay, 1);
  assert.equal(s.openDay, 0);
  assert.equal(s.open.final, 2);
  assert.equal(s.lowerBound.bound, 0, 'the bound is the day\'s own');
});

test('stats: a task nobody can do is counted in noEligible and in the bound, and stays open', () => {
  const tasks = [...day(), mkTask('rare', D(12), D(13), ['Q9'])];
  const s = planWindow(tasks, dbOf(...people()), DATE, null, WIN, { lnsIterations: 5 }).stats;
  assert.equal(s.openDay, 1);
  assert.equal(s.lowerBound.noEligible, 1);
  assert.equal(s.lowerBound.bound, 1);
  assert.ok(s.openDay >= s.lowerBound.bound);
});

test('stats: bottlenecks — three tasks at once for two people leave one open, and the bound says one', () => {
  const tasks = [0, 1, 2].map(i => mkTask('x' + i, D(9, i * 5), D(10, i * 5), ['Q1']));
  const s = planWindow(tasks, dbOf(...people()), DATE, null, WIN, { lnsIterations: 5 }).stats;
  assert.equal(s.openDay, 1);
  assert.equal(s.lowerBound.bound, 1);
  assert.equal(s.lowerBound.bottlenecks.length, 1);
  assert.deepEqual([s.lowerBound.peak.active, s.lowerBound.peak.coverable], [3, 2]);
  assert.equal(s.lowerBound.peak.at.getTime(), D(9, 10).getTime(), 'at the moment all three run');
});

test('stats: unusable input is listed under invalid and comes back open in place', () => {
  const tasks = [...day(), { ...day()[0] }, mkTask('bad', D(9), D(9), ['Q1'])];
  const r = planWindow(tasks, dbOf(...people()), DATE, null, WIN, { lnsIterations: 0 });
  assert.equal(r.stats.invalid.count, 2);
  assert.deepEqual(r.stats.invalid.reasons, { DUPLICATE_ID: 1, END_NOT_AFTER_START: 1 });
  assert.deepEqual(r.stats.invalid.items.map(x => x.id).sort(), ['bad', 't1']);
  assert.equal(r.tasks.length, 5, 'every input task comes back');
  assert.equal(r.tasks[3].employee, OPEN);
  assert.equal(r.tasks[4].employee, OPEN);
});

test('stats: a locked clash the search must not undo is reported as a violation, nothing is reopened', () => {
  const tasks = [
    mkTask('l1', D(9), D(10), ['Q1'], { employee: 'P1', isLocked: true }), mkTask('l2', D(9, 30), D(10, 30), ['Q1'], { employee: 'P1', isLocked: true }),
  ];
  const r = planWindow(tasks, dbOf(...people()), DATE, null, WIN, { lnsIterations: 0 });
  assert.deepEqual(r.stats.violations.map(v => [v.taskId, v.code]), [['l2', 'OVERLAP']]);
  assert.equal(r.stats.reopenedByCheck, 0);
  assert.equal(r.tasks.every(t => t.employee === 'P1'), true);
});

test('stats: waived counts the assignments made without a waived qualification', () => {
  const tasks = [mkTask('y1', D(9), D(10), ['Q1', 'Q7']), mkTask('y2', D(11), D(12), ['Q1', 'Q7'])];
  const strict = planWindow(tasks, dbOf(...people()), DATE, null, WIN, { lnsIterations: 0 }).stats;
  assert.equal(strict.openDay, 2);
  assert.equal(strict.waived, 0);
  const waived = planWindow(tasks, dbOf(...people()), DATE, null, WIN, { lnsIterations: 0, policy: { waivedQuals: ['Q7'] } }).stats;
  assert.equal(waived.openDay, 0);
  assert.equal(waived.waived, 2);
  assert.deepEqual(waived.violations, []);
});

test('stats: sameFlightOverlap makes the bound null (parallel work is allowed), the rest of the result stays valid', () => {
  const t = [
    { ...mkTask('a', D(9), D(10), ['Q1']), flight: 'SU1', name: 'OUT_1' }, { ...mkTask('b', D(9), D(10), ['Q1']), flight: 'SU1', name: 'OUT_2' },
  ];
  const staff = dbOf(mkPerson('P1', ['Q1'], 6, 20));
  const r = planWindow(t, staff, DATE, null, WIN, { lnsIterations: 0, policy: { sameFlightOverlap: true } });
  assert.deepEqual(r.stats.lowerBound, { bound: null, noEligible: null, peak: null, bottlenecks: [] });
  assert.equal(r.stats.openDay, 0);
  assert.equal(getPolicy().sameFlightOverlap, false, 'the policy of the call is gone again');
  assert.equal(validatePlan(r.tasks, staff, DATE, null, WIN).length, 1, 'under the default policy the pair is an overlap');
});
