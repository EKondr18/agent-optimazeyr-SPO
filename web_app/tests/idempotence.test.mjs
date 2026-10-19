// Repeating a batch: a backend may deliver the same batch of changes twice (a
// retry after a timeout). Applied again to its own result, the same batch should
// change nothing. A single change is idempotent today; a batch of 20 is not
// always and a batch of 100 almost never is (unrelated assignments get shuffled
// on the second pass). The strict form of the rule is `todo` below; the green
// tests pin what already holds (the task set, the hard rules, one change) and
// how far from the rule the measured shares are, so they cannot get worse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy, DEFAULT_POLICY, planWindow, applyChanges, validatePlan } from '../src/optimizer.js';
import { DATE, D, mkTask, mkPerson, dbOf, dayInstance, rng, assignments } from './helpers.mjs';

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

// A batch of `k` changes in the future of `now` (08:00): new tasks (as the task
// generator sends them: no assignment fields), shifted times, removals, new requirements.
function makeBatch(inst, base, k, rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const future = base.filter(t => t.start >= D(9) && t.start < D(21));
  const changes = [];
  const used = new Set();
  let added = 0;
  for (let i = 0; i < k; i++) {
    const kind = pick(['add', 'add', 'update', 'update', 'update', 'remove', 'qual']);
    if (kind === 'add' || future.length === 0) {
      const start = D(9 + Math.floor(rnd() * 12), Math.floor(rnd() * 12) * 5);
      const q = [pick(inst.quals)];
      const { employee, isLocked, ...fresh } = mkTask('n' + (added++), start, new Date(start.getTime() + pick([20, 30, 45, 60]) * 60000), q, { pos: pick(inst.stands) });
      changes.push(fresh);
      continue;
    }
    const t = pick(future);
    if (used.has(t.id)) continue;
    used.add(t.id);
    if (kind === 'remove') changes.push({ id: t.id, removed: true });
    else if (kind === 'update') {
      const d = pick([15, 30, 60, -15]) * 60000;
      changes.push({ id: t.id, start: new Date(t.start.getTime() + d), end: new Date(t.end.getTime() + d) });
    } else {
      const q = [pick(inst.quals)];
      changes.push({ id: t.id, reqTypes: q, reqType: q.join(' + ') });
    }
  }
  return changes;
}

// first pass, second pass (the same batch on the result of the first), tasks that differ
const memo = new Map();
function twice(seed, k, withNow) {
  const key = `${seed}/${k}/${withNow}`;
  if (!memo.has(key)) memo.set(key, twiceUncached(seed, k, withNow));
  return memo.get(key);
}
function twiceUncached(seed, k, withNow) {
  const inst = dayInstance(seed, { nTasks: k >= 100 ? 200 : 70, nPeople: k >= 100 ? 30 : 14 });
  const base = planWindow(inst.tasks, inst.staff, DATE, null, inst.dates, { lnsIterations: 0 }).tasks;
  const changes = makeBatch(inst, base, k, rng(seed * 31 + k));
  const options = withNow ? { now: D(8) } : {};
  const r1 = applyChanges(base, inst.staff, DATE, null, inst.dates, changes, options);
  const r2 = applyChanges(r1.tasks, inst.staff, DATE, null, inst.dates, changes, options);
  const first = new Map(r1.tasks.map(t => [t.id, t.employee]));
  const differ = r2.tasks.filter(t => first.get(t.id) !== t.employee).map(t => t.id);
  return { inst, r1, r2, differ, base, changes };
}

test('a repeated batch keeps the task set and the hard rules (sizes 1, 20, 100)', () => {
  for (const [k, seeds] of [[1, 10], [20, 8], [100, 3]]) {
    for (let seed = 1; seed <= seeds; seed++) {
      for (const withNow of [false, true]) {
        const { inst, r1, r2 } = twice(seed, k, withNow);
        const label = `batch ${k}, seed ${seed}, now ${withNow}`;
        assert.deepEqual(r2.tasks.map(t => t.id).sort(), r1.tasks.map(t => t.id).sort(), label);
        assert.deepEqual(validatePlan(r2.tasks, inst.staff, DATE, null, inst.dates), [], label);
        assert.deepEqual(r2.rejected, [], label);
      }
    }
  }
});

test('one change repeated on its own result changes nothing (25 seeds, with and without now)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    for (const withNow of [false, true]) {
      const { differ } = twice(seed, 1, withNow);
      assert.deepEqual(differ, [], `seed ${seed}, now ${withNow}`);
    }
  }
});

test('measured: a repeated batch of 20 moves something in at most 4 of 30 seeds, of 100 in at most 7 of 8', t => {
  let d20 = 0, d100 = 0, moved100 = 0;
  for (let seed = 1; seed <= 30; seed++) if (twice(seed, 20, seed % 2 === 1).differ.length) d20++;
  for (let seed = 1; seed <= 8; seed++) {
    const { differ } = twice(seed, 100, seed % 2 === 1);
    if (differ.length) d100++;
    moved100 += differ.length;
  }
  t.diagnostic(`batch 20: ${d20}/30 differ; batch 100: ${d100}/8 differ, ${moved100} assignments moved`);
  assert.ok(d20 <= 4, `batch 20: ${d20} of 30`);
  assert.ok(d100 <= 7, `batch 100: ${d100} of 8`);
});

test('F3 a repeated batch is a no-op, batch of 20 (30 seeds)', { todo: 'about 2 of 40 seeds change assignments on the second pass' }, () => {
  const bad = [];
  for (let seed = 1; seed <= 30; seed++) {
    const { differ } = twice(seed, 20, seed % 2 === 1);
    if (differ.length) bad.push(`${seed}:${differ.length}`);
  }
  assert.deepEqual(bad, []);
});

test('F3 a repeated batch is a no-op, batch of 100 (8 seeds)', { todo: 'about 16 of 40 seeds, 1 to 15 assignments each' }, () => {
  const bad = [];
  for (let seed = 1; seed <= 8; seed++) {
    const { differ } = twice(seed, 100, seed % 2 === 1);
    if (differ.length) bad.push(`${seed}:${differ.length}`);
  }
  assert.deepEqual(bad, []);
});

// The smallest case found: one task moved by 1 hour. Nothing about the batch is
// new on the second pass, yet two tasks that the batch does not mention swap people.
// (t000/t013/t019/t010 start assigned to people who are not on the roster, so
// they are placed by the first pass; the second one still finds a cheaper plan.)
test('F3 minimal: one task moved by an hour, the second pass swaps two unrelated tasks', { todo: 't000 and t030 swap P05/P04 on the second pass' }, () => {
  const staff = dbOf(
    mkPerson('P04', ['Q3', 'Q4'], 8, 19),
    mkPerson('P05', ['Q1', 'Q2', 'Q3', 'Q4'], 14, 25),
    mkPerson('P07', ['Q1', 'Q2', 'Q3'], 14, 26),
  );
  const T = (id, q, a, b, pos, employee) => mkTask(id, D(...a), D(...b), q, { pos, employee });
  const base = [
    T('t000', ['Q4'], [17, 5], [18, 35], 'S05', 'P03'), T('t008', ['Q3', 'Q1'], [20, 45], [22, 15], 'S04', 'P07'),
    T('t010', ['Q4'], [21, 25], [22, 55], 'S04', 'P00'), T('t012', ['Q3', 'Q1'], [18, 40], [20, 10], 'S05', 'P07'),
    T('t013', ['Q4'], [19, 10], [19, 55], 'S08', 'P03'), T('t019', ['Q1'], [19, 5], [20, 35], 'S08', 'P13'),
    T('t030', ['Q4', 'Q3'], [18, 30], [19, 15], 'S05', 'P04'),
  ];
  const changes = [{ id: 't012', start: D(19, 40), end: D(21, 10) }];
  const options = { now: D(8) };
  const r1 = applyChanges(base, staff, DATE, null, [DATE], changes, options);
  const r2 = applyChanges(r1.tasks, staff, DATE, null, [DATE], changes, options);
  assert.equal(assignments(r2.tasks), assignments(r1.tasks));
});

// A changed task that lies before `now` (an old task corrected afterwards) is
// left without a person by the first pass although someone free can take it:
// the second pass places it.
test('F3 a corrected task that lies before now is left open though a free qualified person exists', { todo: 'first pass: a is open (unplaced), second pass: a goes to P04' }, () => {
  const staff = dbOf(mkPerson('P04', ['Q1', 'Q3', 'Q4'], 6, 15), mkPerson('P09', ['Q2', 'Q3'], 6, 15));
  const base = [
    mkTask('a', D(7, 0), D(7, 30), ['Q3'], { pos: 'S05', employee: 'P09' }),
    mkTask('b', D(7, 45), D(8, 15), ['Q2'], { pos: 'S06', employee: 'P09' }),
  ];
  const changes = [{ id: 'a', start: D(7, 30), end: D(8, 0) }];   // now overlaps b
  const r1 = applyChanges(base, staff, DATE, null, [DATE], changes, { now: D(12) });
  assert.equal(r1.tasks.find(t => t.id === 'a').employee, 'P04', `after the first pass: ${r1.tasks.find(t => t.id === 'a').employee}`);
});
