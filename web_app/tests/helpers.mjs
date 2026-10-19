// Shared helpers of the test files that need random inputs (not a test file
// itself: `npm test` runs tests/*.test.mjs only). Everything is seeded and uses
// the Moscow day through utils/tz.js, so a result does not depend on the
// timezone the tests run under. Synthetic data only.
import { dayStart, addDays } from '../src/utils/tz.js';
import { hasAllQuals, fitsShift, conflictsWith } from '../src/optimizer.js';

export const OPEN = 'Не назначено';
export const DATE = '2026-03-10';

// mulberry32: the same stream on every machine.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Moscow wall clock `h:m` of the day `ymd` (h may exceed 24: the next day).
export const at = (ymd, h, m = 0) => new Date(dayStart(ymd).getTime() + (h * 60 + m) * 60000);
export const D = (h, m = 0) => at(DATE, h, m);
export { dayStart, addDays };

export function mkTask(id, start, end, quals, extra = {}) {
  const pos = extra.pos ?? 'S01';
  return {
    id, date: extra.date ?? DATE, name: 'T' + id, flight: 'FL' + id, pos, entryPos: pos, exitPos: pos,
    reqType: quals.join(' + '), reqTypes: quals, start, end, employee: OPEN, isLocked: false, ...extra,
  };
}
export const mkPerson = (name, quals, from, to, basePos = null) =>
  ({ name, quals, shiftStart: D(from), shiftEnd: D(to), basePos });
export const dbOf = (...people) => ({ [DATE]: people });
export const empOf = (tasks, id) => tasks.find(t => t.id === id)?.employee;
export const openCount = (tasks, dates = [DATE]) => tasks.filter(t => dates.includes(t.date) && t.employee === OPEN).length;
export const assignments = tasks => tasks.map(t => `${t.id}:${t.employee}`).sort().join('|');

// ── Small random instances (one day, no network) ────────────────────────────
// up to `maxTasks` tasks and `maxPeople` people, three qualifications, stands
// S01..S08, shifts from 06-09 to 12-19.
export function tinyInstance(seed, { maxTasks = 8, maxPeople = 4 } = {}) {
  const rnd = rng(seed * 7919 + 13);
  const quals = ['Q1', 'Q2', 'Q3'];
  const nP = 2 + Math.floor(rnd() * (maxPeople - 1));
  const nT = 4 + Math.floor(rnd() * (maxTasks - 3));
  const people = Array.from({ length: nP }, (_, i) => {
    const qs = quals.filter(() => rnd() < 0.6);
    const from = 6 + Math.floor(rnd() * 4);
    return mkPerson('P' + i, qs.length ? qs : ['Q1'], from, from + 6 + Math.floor(rnd() * 4));
  });
  const tasks = Array.from({ length: nT }, (_, i) => {
    const start = D(8 + Math.floor(rnd() * 9), Math.floor(rnd() * 4) * 15);
    const end = new Date(start.getTime() + (30 + Math.floor(rnd() * 5) * 15) * 60000);
    const q = [quals[Math.floor(rnd() * 3)]];
    if (rnd() < 0.25) q.push(quals[Math.floor(rnd() * 3)]);
    const pos = 'S0' + (1 + Math.floor(rnd() * 8));
    return mkTask('t' + i, start, end, [...new Set(q)], { pos, flight: 'F' + (i >> 1) });
  });
  return { tasks, staff: { [DATE]: people }, people };
}

// The fewest open tasks any assignment can have under the CURRENT policy (every
// task to a qualified person on shift, the overtime allowance included, nobody
// double-booked, hand-offs by the resolver): full enumeration.
export function exactOptimum(tasks, people, resolver = null) {
  const n = tasks.length;
  const ok = tasks.map(t => people.map(p => hasAllQuals(p.quals, t) && fitsShift(p, t, resolver, true)));
  let best = n;
  const lists = people.map(() => []);
  const rec = (i, open) => {
    if (open >= best) return;
    if (i === n) { best = open; return; }
    for (let p = 0; p < people.length; p++) {
      if (!ok[i][p] || lists[p].some(x => conflictsWith(x, tasks[i], resolver))) continue;
      lists[p].push(tasks[i]); rec(i + 1, open); lists[p].pop();
    }
    rec(i + 1, open + 1);
  };
  rec(0, 0);
  return best;
}

// ── A mid-size day: ~`nTasks` tasks, `nPeople` people, one window of 3 days ──
export function dayInstance(seed, { nTasks = 60, nPeople = 14 } = {}) {
  const rnd = rng(seed * 104729 + 7);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = a => a[Math.floor(rnd() * a.length)];
  const quals = ['Q1', 'Q2', 'Q3', 'Q4'];
  const stands = Array.from({ length: 8 }, (_, i) => 'S0' + (i + 1));
  const prev = addDays(DATE, -1), next = addDays(DATE, 1);
  const staff = {};
  const people = [];
  for (let i = 0; i < nPeople; i++) {
    const qs = quals.filter(() => rnd() < 0.55);
    const from = pick([6, 8, 10, 14]);
    const s = { name: 'P' + String(i).padStart(2, '0'), quals: qs.length ? qs : ['Q1'], shiftStart: D(from), shiftEnd: D(from + ri(8, 12)), basePos: null };
    people.push(s);
    (staff[DATE] ??= []).push(s);
    if (s.shiftEnd > dayStart(next)) (staff[next] ??= []).push(s);
  }
  const tasks = [];
  for (let i = 0; i < nTasks; i++) {
    const start = D(ri(7, 21), ri(0, 11) * 5);
    const end = new Date(start.getTime() + pick([20, 30, 45, 60, 90]) * 60000);
    const q = [pick(quals)];
    if (rnd() < 0.2) q.push(pick(quals));
    const pos = pick(stands);
    tasks.push(mkTask('t' + String(i).padStart(3, '0'), start, end, [...new Set(q)], { pos, flight: 'F' + ri(1, nTasks >> 1) }));
  }
  return { tasks, staff, people, quals, stands, dates: [prev, DATE, next], rnd, ri, pick };
}
