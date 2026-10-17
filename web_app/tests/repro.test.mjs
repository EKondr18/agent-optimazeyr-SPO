// Reproducibility: the same input and seed give the same plan whatever the
// speed of the machine. Every search stops on a count of work (LNS attempts,
// improvement steps), and the clock is only a safety net that reports itself
// when it fires. The tests move the clock (Date.now) at different speeds to
// stand in for a fast, a slow and a stalled machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, DEFAULT_POLICY, planWindow, applyChanges, runOptimizer, improveAssignment, lnsImprove,
  validatePlan, DEFAULT_LNS_ITERATIONS, DEFAULT_IMPROVE_MAX_STEPS,
} from '../src/optimizer.js';

const DATE = '2026-01-01';
const WIN = [DATE];
const OPEN = 'Не назначено';
const D = (h, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));

// A day with more demand than staff in places, so the improvement search and
// LNS have real work: 14 people with 2-3 of 4 qualifications, 170 tasks.
function instance(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const quals = ['Q1', 'Q2', 'Q3', 'Q4'];
  const people = Array.from({ length: 14 }, (_, i) => {
    const qs = quals.filter(() => rnd() < 0.55);
    const from = 5 + Math.floor(rnd() * 5);
    return { name: 'P' + i, quals: qs.length ? qs : ['Q1'], shiftStart: D(from), shiftEnd: D(from + 7 + Math.floor(rnd() * 5)), basePos: 'POS' + Math.floor(rnd() * 30) };
  });
  const tasks = Array.from({ length: 170 }, (_, i) => {
    const start = D(6 + Math.floor(rnd() * 14), Math.floor(rnd() * 4) * 15);
    const end = new Date(start.getTime() + (15 + Math.floor(rnd() * 6) * 15) * 60000);
    const q = [quals[Math.floor(rnd() * 4)]];
    if (rnd() < 0.2) q.push(quals[Math.floor(rnd() * 4)]);
    const pos = 'POS' + Math.floor(rnd() * 30);
    return {
      id: 'r' + i, date: DATE, name: 'N' + (i % 6), flight: 'F' + Math.floor(i / 3), pos, entryPos: pos, exitPos: pos,
      reqType: [...new Set(q)].join(' + '), reqTypes: [...new Set(q)], start, end, employee: OPEN, isLocked: false,
    };
  });
  return { tasks, staff: { [DATE]: people } };
}

// `fn` with Date.now moving `step` ms on every call (0 = stopped).
function withClock(step, fn) {
  const real = Date.now;
  let t = 1.7e12;
  Date.now = () => (t += step);
  try { return fn(); } finally { Date.now = real; }
}
const assignments = tasks => tasks.map(t => `${t.id}>${t.employee}`).join('|');
// (100 ms a reading is ~100x slower than real; 200 LNS attempts still end inside the 30 s safety net)
const CLOCKS = [['real', null], ['stopped', 0], ['slow machine', 37], ['very slow machine', 100]];
const underClock = (step, fn) => (step === null ? fn() : withClock(step, fn));

test.beforeEach(() => setPolicy(DEFAULT_POLICY));

test('planWindow with the default settings gives one plan on a fast, a slow and a stopped clock', () => {
  const { tasks, staff } = instance(7);
  const runs = CLOCKS.map(([name, step]) => {
    const r = underClock(step, () => planWindow(tasks, staff, DATE, null, WIN));
    return { name, r };
  });
  const first = runs[0].r;
  assert.ok(first.stats.lns.iterations > 0, 'LNS actually ran');
  assert.equal(first.stats.timeCut, false);
  assert.equal(first.stats.terminationReason, 'completed');
  assert.ok(first.stats.lns.iterations <= DEFAULT_LNS_ITERATIONS);
  assert.deepEqual(first.stats.violations, []);
  for (const { name, r } of runs) {
    assert.equal(assignments(r.tasks), assignments(first.tasks), name);
    assert.equal(r.stats.timeCut, false, name);
    assert.equal(r.stats.lns.iterations, first.stats.lns.iterations, name);
  }
});

test('the LNS length is the iteration count: lnsIterations decides, lnsBudgetMs 0 and lnsIterations 0 switch it off', () => {
  const { tasks, staff } = instance(11);
  const few = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 5 });
  assert.equal(few.stats.lns.iterations, 5);
  assert.equal(few.stats.lns.terminationReason, 'iterations');
  const again = withClock(500, () => planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 5 }));
  assert.equal(assignments(again.tasks), assignments(few.tasks));
  for (const off of [{ lnsIterations: 0 }, { lnsBudgetMs: 0 }]) {
    const r = planWindow(tasks, staff, DATE, null, WIN, off);
    assert.equal(r.stats.lns.iterations, 0);
    assert.equal(r.stats.lns.terminationReason, 'skipped');
  }
});

test('the time safety net, when it fires, says so: timeCut and terminationReason deadline', () => {
  const { tasks, staff } = instance(7);
  // 900 ms pass per clock reading, the net is 2.5 s: the LNS is cut after a few attempts
  const r = withClock(900, () => planWindow(tasks, staff, DATE, null, WIN, { lnsBudgetMs: 2500 }));
  assert.equal(r.stats.timeCut, true);
  assert.equal(r.stats.terminationReason, 'deadline');
  assert.equal(r.stats.lns.terminationReason, 'deadline');
  assert.ok(r.stats.lns.iterations < DEFAULT_LNS_ITERATIONS);
  assert.deepEqual(r.stats.violations, [], 'a cut search still hands back a valid plan');

  const lns = withClock(900, () => lnsImprove(runOptimizer(tasks, staff, DATE, null, WIN), staff, DATE, null, WIN, { timeBudgetMs: 2500 }));
  assert.equal(lns.timeCut, true);
  assert.equal(lns.terminationReason, 'deadline');
  const full = lnsImprove(runOptimizer(tasks, staff, DATE, null, WIN), staff, DATE, null, WIN, { maxIterations: 8 });
  assert.equal(full.timeCut, false);
});

test('lnsImprove: the default stop is the iteration count, not the clock', () => {
  const { tasks, staff } = instance(3);
  const base = improveAssignment(runOptimizer(tasks, staff, DATE, null, WIN), staff, DATE, null, WIN).tasks;
  const a = lnsImprove(base, staff, DATE, null, WIN, { seed: 5 });
  const b = withClock(100, () => lnsImprove(base, staff, DATE, null, WIN, { seed: 5 }));
  assert.ok(a.iterations <= DEFAULT_LNS_ITERATIONS);
  assert.equal(b.iterations, a.iterations);
  assert.equal(assignments(b.tasks), assignments(a.tasks));
  assert.equal(b.timeCut, false);
});

test('improveAssignment: maxSteps stops at the same point on any clock, deadline is only the net', () => {
  const { tasks, staff } = instance(5);
  const built = runOptimizer(tasks, staff, DATE, null, WIN);
  const full = improveAssignment(built, staff, DATE, null, WIN);
  assert.equal(full.terminationReason, 'converged');
  assert.equal(full.timeCut, false);
  assert.ok(full.steps > 200, 'the instance gives the search enough to do');

  const limit = Math.floor(full.steps / 4);
  const a = improveAssignment(built, staff, DATE, null, WIN, { maxSteps: limit });
  const b = withClock(250, () => improveAssignment(built, staff, DATE, null, WIN, { maxSteps: limit, deadline: Date.now() + 1e9 }));
  assert.equal(a.terminationReason, 'max-steps');
  assert.equal(a.timeCut, false);
  assert.ok(a.steps <= limit);
  assert.equal(assignments(b.tasks), assignments(a.tasks));
  assert.equal(b.terminationReason, 'max-steps');
  assert.deepEqual(validatePlan(a.tasks, staff, DATE, null, WIN), [], 'cut early, still valid');

  // a limit above what it needs changes nothing
  const roomy = improveAssignment(built, staff, DATE, null, WIN, { maxSteps: full.steps * 5 });
  assert.equal(assignments(roomy.tasks), assignments(full.tasks));
  assert.equal(roomy.terminationReason, 'converged');

  // the clock cutting it is flagged
  const cut = withClock(1000, () => improveAssignment(built, staff, DATE, null, WIN, { deadline: Date.now() + 3000 }));
  assert.equal(cut.terminationReason, 'deadline');
  assert.equal(cut.timeCut, true);
});

test('applyChanges: one batch gives one result on any clock; a step limit is reported, a time cut is flagged', () => {
  const { tasks, staff } = instance(9);
  const plan = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 0 }).tasks;
  const movable = plan.filter(t => t.employee !== OPEN && t.start >= D(11)).slice(0, 24);
  const changes = [
    ...movable.slice(0, 16).map(t => ({ id: t.id, start: new Date(t.start.getTime() + 25 * 60000), end: new Date(t.end.getTime() + 25 * 60000) })),
    ...movable.slice(16, 20).map(t => ({ id: t.id, removed: true })),
    ...movable.slice(20, 24).map((t, i) => ({ ...t, id: 'new' + i, employee: OPEN, start: new Date(t.start.getTime() + 40 * 60000), end: new Date(t.end.getTime() + 40 * 60000) })),
  ];
  const run = (step, options) => underClock(step, () => applyChanges(plan, staff, DATE, null, WIN, changes, { now: D(9), ...options }));
  // (the improvement search reads the clock on every step, so its clocks tick more gently: at 8 ms a
  // reading the old 1.5 s budget would have cut this batch after ~190 steps)
  const BATCH_CLOCKS = [['real', null], ['stopped', 0], ['slow machine', 2], ['very slow machine', 8]];
  const results = BATCH_CLOCKS.map(([name, step]) => ({ name, r: run(step) }));
  const first = results[0].r;
  assert.deepEqual(first.rejected, []);
  assert.equal(first.timeCut, false);
  assert.equal(first.terminationReason, 'completed');
  assert.ok(first.work.improveSteps > 190, 'enough work for the 8 ms clock to have passed the old 1.5 s budget');
  assert.ok(first.work.improveSteps > 0 && first.work.improveSteps < DEFAULT_IMPROVE_MAX_STEPS);
  assert.deepEqual(first.violations, []);
  for (const { name, r } of results) {
    assert.equal(assignments(r.tasks), assignments(first.tasks), name);
    assert.equal(r.timeCut, false, name);
  }

  // a tight step limit: deterministic, named, and not a time cut
  const capped = BATCH_CLOCKS.map(([, step]) => run(step, { improveMaxSteps: 20 }));
  assert.equal(capped[0].improveTermination, 'max-steps');
  assert.equal(capped[0].terminationReason, 'max-steps');
  assert.equal(capped[0].timeCut, false);
  assert.ok(capped[0].work.improveSteps <= 20);
  for (const r of capped) assert.equal(assignments(r.tasks), assignments(capped[0].tasks));
  assert.deepEqual(capped[0].violations, []);

  // the safety net: a stalled-slow clock cuts the improvement and says so
  const net = run(900, { improveBudgetMs: 2000 });
  assert.equal(net.timeCut, true);
  assert.equal(net.terminationReason, 'deadline');
  assert.deepEqual(net.violations, []);
});

test('applyChanges: the escalation after a batch is bounded by attempts too', () => {
  // one person, one qualification, three overlapping tasks: the third stays
  // open and the escalation has something to try but nothing to find
  const people = [{ name: 'S1', quals: ['Q1'], shiftStart: D(6), shiftEnd: D(20), basePos: null }];
  const mkT = (id, h) => ({
    id, date: DATE, name: id, flight: id, pos: 'POS1', entryPos: 'POS1', exitPos: 'POS1', reqType: 'Q1', reqTypes: ['Q1'],
    start: D(h), end: D(h + 1), employee: OPEN, isLocked: false,
  });
  const base = [{ ...mkT('a', 9), employee: 'S1' }];
  const run = (step, options) => underClock(step, () => applyChanges(base, { [DATE]: people }, DATE, null, WIN, [mkT('b', 9)], options));
  const r1 = run(null, {});
  assert.deepEqual(r1.unplaced, ['b']);
  assert.ok(r1.work.escalateIterations > 0 && r1.work.escalateIterations <= 200);
  const r2 = run(100, {});
  assert.equal(assignments(r2.tasks), assignments(r1.tasks));
  assert.equal(r2.work.escalateIterations, r1.work.escalateIterations);
  assert.equal(r2.timeCut, false);
  const cut = run(900, { escalateBudgetMs: 1500 });
  assert.equal(cut.timeCut, true);
  assert.equal(cut.terminationReason, 'deadline');
});
