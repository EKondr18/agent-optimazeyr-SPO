// The overtime allowance (policy.maxOvertimeMin: how far past the end of the
// shift a task that STARTS in it may run) works in the whole search, not only in
// the construction's last pass: the improvement, the displacement chains and the
// LNS repair may use it too, and the cost (W.overtime) charges for it. Before,
// a plan that needed "+10 minutes" for one person to free another was never found.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, DEFAULT_POLICY, planWindow, improveAssignment, lnsImprove, runOptimizer, validatePlan,
  planMetrics, hasAllQuals, fitsShift, conflictsWith,
} from '../src/optimizer.js';

const OPEN = 'Не назначено';
const DATE = '2026-01-01';
const WIN = [DATE];
const D = (h, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));
const mk = (id, sh, sm, eh, em, quals, extra = {}) => ({
  id, date: DATE, name: 'T' + id, flight: 'FL' + id, pos: 'S01', entryPos: 'S01', exitPos: 'S01',
  reqType: quals.join(' + '), reqTypes: quals, start: D(sh, sm), end: D(eh, em), employee: OPEN, isLocked: false, ...extra,
});
const person = (name, quals, from, to) => ({ name, quals, shiftStart: D(from), shiftEnd: D(to), basePos: null });
const empOf = (tasks, id) => tasks.find(t => t.id === id).employee;

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

// P01 [Q2] works 06-14, P02 [Q1,Q2] 07-17. A [Q2] 13:10-14:10 and B [Q1,Q2] 13:30-14:15
// overlap. B can only be done by P02, so A has to go to P01 — who is on shift when A
// starts and finishes 10 minutes after the end of the shift.
function example() {
  const staff = { [DATE]: [person('P01', ['Q2'], 6, 14), person('P02', ['Q1', 'Q2'], 7, 17)] };
  const tasks = [mk('A', 13, 10, 14, 10, ['Q2']), mk('B', 13, 30, 14, 15, ['Q1', 'Q2'])];
  return { staff, tasks };
}

test('the 10 minutes of overtime that free the only person for B are used when the allowance covers them', () => {
  const { staff, tasks } = example();
  for (const [allowance, open] of [[0, 1], [5, 1], [10, 0], [30, 0], [60, 0], [240, 0]]) {
    const r = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 0, policy: { maxOvertimeMin: allowance } });
    assert.equal(r.stats.openDay, open, `allowance ${allowance} min`);
    assert.deepEqual(r.stats.violations, [], `allowance ${allowance} min`);
    if (open === 0) {
      assert.equal(empOf(r.tasks, 'A'), 'P01');
      assert.equal(empOf(r.tasks, 'B'), 'P02');
      assert.equal(planMetrics(r.tasks, staff, DATE, null, WIN).overtimeMin, 10);
    }
  }
});

test('the improvement search and the LNS use the allowance by themselves, starting from a plan without it', () => {
  const { staff, tasks } = example();
  setPolicy({ maxOvertimeMin: 60 });
  // the worse plan: A with P02, B open
  const start = tasks.map(t => (t.id === 'A' ? { ...t, employee: 'P02' } : t));
  const improved = improveAssignment(start, staff, DATE, null, WIN);
  assert.equal(empOf(improved.tasks, 'B'), 'P02');
  assert.equal(empOf(improved.tasks, 'A'), 'P01');
  assert.deepEqual(validatePlan(improved.tasks, staff, DATE, null, WIN), []);
  const lns = lnsImprove(start, staff, DATE, null, WIN, { maxIterations: 40 });
  assert.equal(lns.tasks.filter(t => t.employee === OPEN).length, 0);
  assert.deepEqual(validatePlan(lns.tasks, staff, DATE, null, WIN), []);
});

test('overtime is still limited: a task that starts after the shift, or runs past the allowance, stays open', () => {
  const staff = { [DATE]: [person('P', ['Q1'], 6, 14)] };
  setPolicy({ maxOvertimeMin: 30 });
  const late = mk('late', 14, 0, 14, 20, ['Q1']);        // starts when the shift ends
  const long = mk('long', 13, 0, 14, 45, ['Q1']);        // 45 min over
  const ok = mk('ok', 13, 0, 14, 30, ['Q1']);            // exactly the allowance
  for (const t of [late, long]) {
    const r = planWindow([t], staff, DATE, null, WIN, { lnsIterations: 0 });
    assert.equal(empOf(r.tasks, t.id), OPEN, t.id);
  }
  assert.equal(empOf(planWindow([ok], staff, DATE, null, WIN, { lnsIterations: 0 }).tasks, 'ok'), 'P');
});

// ── Against the exact optimum on small inputs ───────────────────────────────
function tiny(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const quals = ['Q1', 'Q2', 'Q3'];
  const nP = 2 + Math.floor(rnd() * 3), nT = 4 + Math.floor(rnd() * 4);
  const people = Array.from({ length: nP }, (_, i) => {
    const qs = quals.filter(() => rnd() < 0.6);
    const from = 6 + Math.floor(rnd() * 3);
    return { name: 'P' + i, quals: qs.length ? qs : ['Q1'], shiftStart: D(from), shiftEnd: D(from + 6 + Math.floor(rnd() * 4)), basePos: null };
  });
  const tasks = Array.from({ length: nT }, (_, i) => {
    const start = D(8 + Math.floor(rnd() * 8), Math.floor(rnd() * 4) * 15);
    const end = new Date(start.getTime() + (30 + Math.floor(rnd() * 5) * 15) * 60000);
    const q = [quals[Math.floor(rnd() * 3)]];
    if (rnd() < 0.25) q.push(quals[Math.floor(rnd() * 3)]);
    const pos = 'S0' + (1 + Math.floor(rnd() * 8));
    return {
      id: 't' + i, date: DATE, name: 'N' + i, flight: 'F' + (i >> 1), pos, entryPos: pos, exitPos: pos,
      reqType: [...new Set(q)].join(' + '), reqTypes: [...new Set(q)], start, end, employee: OPEN, isLocked: false,
    };
  });
  return { tasks, staff: { [DATE]: people } };
}
// The fewest open tasks any assignment can have under the current policy (every
// task to a qualified person on shift, allowance included, nobody double-booked).
function optimum(tasks, people) {
  const n = tasks.length;
  const ok = tasks.map(t => people.map(p => hasAllQuals(p.quals, t) && fitsShift(p, t, null, true)));
  let best = n;
  const lists = people.map(() => []);
  const rec = (i, open) => {
    if (open >= best) return;
    if (i === n) { best = open; return; }
    for (let p = 0; p < people.length; p++) {
      if (!ok[i][p] || lists[p].some(x => conflictsWith(x, tasks[i], null))) continue;
      lists[p].push(tasks[i]); rec(i + 1, open); lists[p].pop();
    }
    rec(i + 1, open + 1);
  };
  rec(0, 0);
  return best;
}

test('small inputs: as few open tasks as the exact optimum, with a 30 and a 60 minute allowance', () => {
  // seeds on which the plan was one or two tasks short of the optimum before the allowance reached the improvement
  const cases = [[30, [234, 291, 294, 300, 304, 310]], [60, [61, 172, 234, 291, 294, 302, 304]]];
  for (const [allowance, seeds] of cases) {
    for (const seed of seeds) {
      const { tasks, staff } = tiny(seed);
      setPolicy({ maxOvertimeMin: allowance });
      const r = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 0 });
      assert.equal(r.stats.openDay, optimum(tasks, staff[DATE]), `seed ${seed}, allowance ${allowance}`);
      assert.deepEqual(r.stats.violations, []);
    }
  }
});

test('the plan never has more open tasks than the allowance-free one would on the same input', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const { tasks, staff } = tiny(seed);
    const strict = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 0, policy: { maxOvertimeMin: 0 } });
    const relaxed = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 0, policy: { maxOvertimeMin: 60 } });
    assert.ok(relaxed.stats.openDay <= strict.stats.openDay + 1, `seed ${seed}: ${relaxed.stats.openDay} vs ${strict.stats.openDay}`);
    assert.deepEqual(relaxed.stats.violations, []);
  }
});
