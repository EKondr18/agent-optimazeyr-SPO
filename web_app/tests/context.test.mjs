// Work of the days around the planning window. A task dated outside the window
// still keeps its person busy when it comes within reach of the window's time
// (a locked one running past midnight, or simply yesterday's / tomorrow's
// plan): every entry point must treat it as time that is taken, never move it,
// and leave it out of the window's load. Without that, planning day D and then
// day D+1 left overlaps and impossible hand-offs exactly where the windows join.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, DEFAULT_POLICY, planWindow, applyChanges, runOptimizer, improveAssignment, lnsImprove,
  patchConflicts, validatePlan, certifyPlan,
} from '../src/optimizer.js';

const OPEN = 'Не назначено';
const D1 = '2026-01-01', D2 = '2026-01-02', D3 = '2026-01-03', D4 = '2026-01-04';
const T = (day, h, m = 0) => new Date(Date.UTC(2026, 0, day, h, m));
const mk = (id, date, start, end, qual, extra = {}) => ({
  id, date, name: 'T' + id, flight: 'FL' + id, pos: 'A1', entryPos: 'A1', exitPos: 'A1',
  reqType: qual, reqTypes: [qual], start, end, employee: OPEN, isLocked: false, ...extra,
});
const person = (name, quals, start, end) => ({ name, quals, shiftStart: start, shiftEnd: end, basePos: null });
// A shift is filed under every (UTC) date it touches, as the loader does.
function dbOf(...people) {
  const db = {};
  for (const p of people) {
    for (let d = Date.UTC(p.shiftStart.getUTCFullYear(), p.shiftStart.getUTCMonth(), p.shiftStart.getUTCDate());
      d <= p.shiftEnd.getTime(); d += 86400000) {
      (db[new Date(d).toISOString().slice(0, 10)] ??= []).push(p);
    }
  }
  return db;
}
const empOf = (tasks, id) => tasks.find(t => t.id === id).employee;

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

// P is the only one who can do Q1, on a night shift across midnight. X (day 1) is
// locked on P until 02:00 on day 2; Y (day 2) wants P from 01:00.
function overnight() {
  const p = person('P', ['Q1'], T(1, 20), T(2, 8));
  const other = person('O', ['Q2'], T(1, 20), T(2, 8));
  const db = dbOf(p, other);
  const x = mk('X', D1, T(1, 22), T(2, 2), 'Q1', { employee: 'P', isLocked: true });
  const y = mk('Y', D2, T(2, 1), T(2, 2), 'Q1');
  return { db, x, y };
}
const wideCheck = (tasks, db, resolver = null) => validatePlan(tasks, db, D2, resolver, [D1, D2]);

test('runOptimizer / improveAssignment / lnsImprove / planWindow never overlap a task of the day before', () => {
  const { db, x, y } = overnight();
  const input = [x, y];
  const built = runOptimizer(input, db, D2, null, [D2]);
  assert.equal(empOf(built, 'Y'), OPEN, 'construction');
  const improved = improveAssignment(built, db, D2, null, [D2]);
  assert.equal(empOf(improved.tasks, 'Y'), OPEN, 'improvement');
  const lns = lnsImprove(improved.tasks, db, D2, null, [D2], { maxIterations: 30 });
  assert.equal(empOf(lns.tasks, 'Y'), OPEN, 'LNS');
  const planned = planWindow(input, db, D2, null, [D2], { lnsIterations: 30 });
  assert.equal(empOf(planned.tasks, 'Y'), OPEN, 'planWindow');
  assert.deepEqual(wideCheck(planned.tasks, db), [], 'the wider check agrees');
  // yesterday's task is returned exactly as it was
  for (const out of [built, improved.tasks, lns.tasks, planned.tasks]) {
    const xo = out.find(t => t.id === 'X');
    assert.equal(xo.employee, 'P');
    assert.equal(xo.isLocked, true);
    assert.equal(xo.start.getTime(), x.start.getTime());
  }
});

test('a hand-off too tight for the walk to a task of the next day is not created either', () => {
  const p = person('P', ['Q1'], T(2, 18), T(3, 6));
  const db = dbOf(p);
  // A1 -> A9 is 8 stand-numbers apart (the heuristic wants 5 minutes between them); 2 minutes are left
  const next = mk('N', D3, T(3, 0), T(3, 1), 'Q1', { employee: 'P', isLocked: true, pos: 'A1', entryPos: 'A1', exitPos: 'A1' });
  const late = mk('L', D2, T(2, 22, 58), T(2, 23, 58), 'Q1', { pos: 'A9', entryPos: 'A9', exitPos: 'A9' });
  const planned = planWindow([next, late], db, D2, null, [D2], { lnsIterations: 0 });
  assert.equal(empOf(planned.tasks, 'L'), OPEN);
  assert.deepEqual(validatePlan(planned.tasks, db, D2, null, [D2, D3]), []);
});

test('patchConflicts moves a window task that collides with a task of the day before, and leaves that one alone', () => {
  const p = person('P', ['Q1'], T(1, 20), T(2, 8));
  const q = person('Q', ['Q1'], T(1, 20), T(2, 8));
  const db = dbOf(p, q);
  const x = mk('X', D1, T(1, 22), T(2, 2), 'Q1', { employee: 'P', isLocked: true });
  const y = mk('Y', D2, T(2, 1), T(2, 2), 'Q1', { employee: 'P' });
  const r = patchConflicts([x, y], db, D2, null, [D2], new Date(0), new Date(8.64e15));
  assert.equal(empOf(r.tasks, 'Y'), 'Q');
  assert.deepEqual(r.changes.map(c => c.taskId), ['Y']);
  assert.equal(empOf(r.tasks, 'X'), 'P');
});

test('applyChanges: a task moved into the time of yesterday\'s task is not left with that person', () => {
  const p = person('P', ['Q1'], T(1, 20), T(2, 8));
  const db = dbOf(p);
  const x = mk('X', D1, T(1, 22), T(2, 2), 'Q1', { employee: 'P', isLocked: true });
  const z = mk('Z', D2, T(2, 3), T(2, 4), 'Q1', { employee: 'P' });
  const out = applyChanges([x, z], db, D2, null, [D2], [{ id: 'Z', start: T(2, 1), end: T(2, 2) }]);
  assert.equal(empOf(out.tasks, 'Z'), OPEN);
  assert.equal(empOf(out.tasks, 'X'), 'P');
  assert.deepEqual(out.violations, []);
  assert.deepEqual(wideCheck(out.tasks, db), []);
});

test('validatePlan reports the window task, not the neighbouring day\'s, and certifyPlan reopens only the window task', () => {
  const p = person('P', ['Q1'], T(1, 20), T(3, 2));
  const db = dbOf(p);
  // context is EARLIER than the window task
  const x = mk('X', D1, T(1, 22), T(2, 2), 'Q1', { employee: 'P' });
  const y = mk('Y', D2, T(2, 1), T(2, 2), 'Q1', { employee: 'P' });
  // ...and LATER than it
  const v = mk('V', D2, T(2, 22, 30), T(2, 23, 30), 'Q1', { employee: 'P' });
  const w = mk('W', D3, T(2, 23), T(3, 1), 'Q1', { employee: 'P' });
  const found = validatePlan([x, y, v, w], db, D2, null, [D2]);
  assert.deepEqual(found.map(f => [f.taskId, f.code, f.detail]).sort(), [['V', 'OVERLAP', 'W'], ['Y', 'OVERLAP', 'X']]);
  const cert = certifyPlan([x, y, v, w], db, D2, null, [D2]);
  assert.deepEqual([...cert.reopened].sort(), ['V', 'Y']);
  assert.equal(empOf(cert.tasks, 'X'), 'P');
  assert.equal(empOf(cert.tasks, 'W'), 'P');
  // two tasks of other days that clash with each other are nobody's business here
  const a = mk('a', D1, T(1, 23), T(2, 1), 'Q1', { employee: 'P' });
  const b = mk('b', D1, T(1, 23, 30), T(2, 1, 30), 'Q1', { employee: 'P' });
  assert.deepEqual(validatePlan([a, b], db, D2, null, [D2]), []);
});

test('the other days\' tasks are not load: with a tie in the window, the person with more of them is not passed over', () => {
  const p = person('P', ['Q1'], T(1, 20), T(2, 8));
  const q = person('Q', ['Q1'], T(1, 20), T(2, 8));
  const db = dbOf(p, q);
  const c1 = mk('c1', D1, T(1, 22), T(1, 22, 20), 'Q1', { employee: 'P' });
  const c2 = mk('c2', D1, T(1, 23), T(1, 23, 20), 'Q1', { employee: 'P' });
  const y = mk('Y', D2, T(2, 1), T(2, 2), 'Q1');
  const built = runOptimizer([c1, c2, y], db, D2, null, [D2]);
  assert.equal(empOf(built, 'Y'), 'P');
  assert.equal(empOf(built, 'c1'), 'P');
  assert.equal(empOf(built, 'c2'), 'P');
});

// ── Planning day after day ──────────────────────────────────────────────────
// A small airport: night and day shifts across midnight, 40 tasks a day of
// 30-120 minutes on a few stands. Plan day 2, then day 3 on top of the result
// (each with its own window), and check the union of all the dates.
function airport(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const quals = ['Q1', 'Q2'];
  const people = [];
  for (let i = 0; i < 9; i++) {
    const qs = quals.filter(() => rnd() < 0.7);
    for (let day = 1; day <= 4; day++) {
      // each person works either nights (20:00-08:00) or days (06:00-18:00) on alternate days
      if ((day + i) % 2 === 0) continue;
      const night = i % 3 === 0;
      people.push(person('P' + i, qs.length ? qs : ['Q1'], night ? T(day, 20) : T(day, 6), night ? T(day + 1, 8) : T(day, 18)));
    }
  }
  const tasks = [];
  for (let day = 1; day <= 4; day++) {
    for (let k = 0; k < 40; k++) {
      const start = new Date(T(day, 0).getTime() + Math.floor(rnd() * 24 * 4) * 15 * 60000);
      const end = new Date(start.getTime() + (30 + Math.floor(rnd() * 7) * 15) * 60000);
      const pos = 'A' + (1 + Math.floor(rnd() * 9));
      tasks.push(mk(`d${day}_${k}`, '2026-01-0' + day, start, end, quals[Math.floor(rnd() * 2)], { pos, entryPos: pos, exitPos: pos }));
    }
  }
  return { tasks, db: dbOf(...people) };
}

test('planning day 2, then day 3, leaves no clash where the windows join', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { tasks, db } = airport(seed);
    const first = planWindow(tasks, db, D2, null, [D1, D2, D3], { lnsIterations: 20 });
    const second = planWindow(first.tasks, db, D3, null, [D2, D3, D4], { lnsIterations: 20 });
    assert.deepEqual(validatePlan(second.tasks, db, D2, null, [D1, D2, D3, D4]), [], `seed ${seed}`);
    assert.deepEqual(second.stats.violations, [], `seed ${seed}: the window's own check`);
    // what lies outside the second window is not touched by it
    const before = new Map(first.tasks.map(t => [t.id, t.employee]));
    for (const t of second.tasks) if (t.date === D1) assert.equal(t.employee, before.get(t.id), `seed ${seed}: ${t.id}`);
  }
});

test('a task beyond reach of the window\'s time is not context (and costs nothing)', () => {
  const p = person('P', ['Q1'], T(1, 0), T(4, 0));
  const db = dbOf(p);
  const far = mk('far', D1, T(1, 3), T(1, 4), 'Q1', { employee: 'P' });
  const y = mk('Y', D3, T(3, 12), T(3, 13), 'Q1');
  const out = runOptimizer([far, y], db, D3, null, [D3]);
  assert.equal(empOf(out, 'Y'), 'P');
  assert.equal(empOf(out, 'far'), 'P');
});
