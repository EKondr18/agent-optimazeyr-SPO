// The call-in plan (resolveStaffingWithCallIns) is a plan for ONE day. Only that
// day's open tasks are goals; the days around it are context. And an extension of
// a shift that started the day before has to be seen by the search, however many
// date buckets of the staff table hold that shift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy, DEFAULT_POLICY, validatePlan } from '../src/optimizer.js';
import { resolveStaffingWithCallIns } from '../src/utils/staffingGap.js';

const OPEN = 'Не назначено';
const D1 = '2026-01-01', D2 = '2026-01-02', D3 = '2026-01-03';
const T = (day, h, m = 0) => new Date(Date.UTC(2026, 0, day, h, m));
const mk = (id, date, start, end, qual, extra = {}) => ({
  id, date, name: 'T' + id, flight: 'FL' + id, pos: 'S01', entryPos: 'S01', exitPos: 'S01',
  reqType: qual, reqTypes: [qual], start, end, employee: OPEN, isLocked: false, ...extra,
});
const person = (name, quals, start, end) => ({ name, quals, shiftStart: start, shiftEnd: end, basePos: null });
// A shift is filed under every date it touches — the SAME object, as the loader does.
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
const shiftsOf = (...people) => new Map(people.map(p => [p.name, [{ shiftStart: p.shiftStart, shiftEnd: p.shiftEnd }]]));
const empOf = (tasks, id) => tasks.find(t => t.id === id).employee;
const WIN = [D1, D2, D3];

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

test('F6: a night shift of the day before is extended to reach a task of the target day', () => {
  const night = person('A', ['Q1'], T(1, 21), T(2, 5));
  const staffDB = dbOf(night);
  assert.ok(staffDB[D1].includes(night) && staffDB[D2].includes(night), 'the shift is filed under both days');
  const task = mk('x', D2, T(2, 5), T(2, 6), 'Q1');
  const r = resolveStaffingWithCallIns({
    tasksDB: [task], staffDB, targetDate: D2, windowDates: WIN,
    fullRoster: [{ name: 'A', quals: ['Q1'] }], allShiftsByPerson: shiftsOf(night), distanceResolver: null,
  });
  assert.deepEqual(r.actions.map(a => [a.type, a.name]), [['extend', 'A']]);
  assert.equal(r.actions[0].shiftEnd.getTime(), T(2, 6).getTime());
  assert.equal(r.actions[0].originalEnd.getTime(), T(2, 5).getTime());
  assert.equal(empOf(r.tasks, 'x'), 'A');
  assert.equal(r.unresolved.length, 0);
  // the input table is not touched
  assert.equal(night.shiftEnd.getTime(), T(2, 5).getTime());
});

test('F6: the extension is applied to every bucket that holds the shift (a later window sees it)', () => {
  // two tasks: one on the night shift's own side of midnight, one past its end — the second needs the extended end
  const night = person('A', ['Q1'], T(1, 21), T(2, 5));
  const staffDB = dbOf(night);
  const tasks = [mk('before', D1, T(1, 23), T(1, 23, 40), 'Q1', { employee: 'A' }), mk('x', D2, T(2, 5), T(2, 6), 'Q1')];
  const r = resolveStaffingWithCallIns({
    tasksDB: tasks, staffDB, targetDate: D2, windowDates: WIN,
    fullRoster: [{ name: 'A', quals: ['Q1'] }], allShiftsByPerson: shiftsOf(night), distanceResolver: null,
  });
  assert.equal(r.unresolved.length, 0);
  assert.equal(empOf(r.tasks, 'before'), 'A', 'the neighbouring day\'s task is left alone');
  // applying the actions the way the page does leaves a plan the validator accepts over the whole window
  const db = Object.fromEntries(Object.entries(staffDB).map(([d, list]) => [d, [...list]]));
  for (const a of r.actions) {
    for (const list of Object.values(db)) {
      const i = list.findIndex(s => s.name === a.name && s.shiftStart.getTime() === a.originalStart.getTime());
      if (i >= 0) list[i] = { ...list[i], shiftStart: a.shiftStart, shiftEnd: a.shiftEnd };
    }
  }
  assert.deepEqual(validatePlan(r.tasks, db, D2, null, WIN), []);
});

test('F5: only the selected day\'s open tasks are goals; the days around it are left as they are', () => {
  const day = person('X', ['Q1'], T(2, 10), T(2, 18));
  const staffDB = dbOf(day);
  const tasks = [
    mk('before', D1, T(1, 10), T(1, 11), 'Q1'),   // open, the day before: nobody is on shift then
    mk('target', D2, T(2, 8), T(2, 9), 'Q1'),     // open, the selected day: X can start earlier
    mk('after', D3, T(3, 10), T(3, 11), 'Q1'),    // open, the day after
  ];
  const r = resolveStaffingWithCallIns({
    tasksDB: tasks, staffDB, targetDate: D2, windowDates: WIN,
    fullRoster: [{ name: 'X', quals: ['Q1'] }, { name: 'Y', quals: ['Q1'] }], allShiftsByPerson: shiftsOf(day), distanceResolver: null,
  });
  assert.deepEqual(r.actions.map(a => [a.type, a.name]), [['extend', 'X']]);
  assert.equal(empOf(r.tasks, 'target'), 'X');
  assert.equal(empOf(r.tasks, 'before'), OPEN);
  assert.equal(empOf(r.tasks, 'after'), OPEN);
  assert.equal(r.unresolved.length, 0, 'the neighbouring days\' open tasks are not this day\'s unresolved');
  assert.deepEqual(Object.keys(r.unresolvedReasons), []);
  // the least extra staff: one more person at 08:00 for the selected day's task, nothing for the neighbours' tasks
  assert.deepEqual(r.minExtra.map(m => [m.at.getTime(), m.people]), [[T(2, 8).getTime(), 1]]);
  // every action serves a task of the selected day
  for (const a of r.actions) assert.ok(a.shiftStart >= T(2, 0) || a.shiftEnd <= T(3, 0));
});

test('F5: what is unresolved is reported for the selected day only', () => {
  const day = person('X', ['Q1'], T(2, 10), T(2, 18));
  const staffDB = dbOf(day);
  const tasks = [
    mk('noone', D2, T(2, 12), T(2, 13), 'Q9'),    // nobody holds Q9
    mk('beforeNoone', D1, T(1, 12), T(1, 13), 'Q9'),
    mk('afterNoone', D3, T(3, 12), T(3, 13), 'Q9'),
  ];
  const r = resolveStaffingWithCallIns({
    tasksDB: tasks, staffDB, targetDate: D2, windowDates: WIN,
    fullRoster: [{ name: 'X', quals: ['Q1'] }], allShiftsByPerson: shiftsOf(day), distanceResolver: null,
  });
  assert.deepEqual(r.unresolved.map(t => t.id), ['noone']);
  assert.deepEqual(r.unresolvedReasons, { noone: 'NO_QUAL' });
  assert.equal(r.noEligible, 1);
});

test('the neighbouring days\' assigned work keeps people busy: a plan never double-books against it', () => {
  // Z is on shift 10-18 and has a task on the NEXT day at 00:30 that his shift 22-02 covers (a second shift);
  // the target task wants Z at 23:45-00:45 — it overlaps the next day's task, so Z must not take it
  const first = person('Z', ['Q1'], T(2, 10), T(2, 18));
  const second = person('Z', ['Q1'], T(2, 22), T(3, 2));
  const staffDB = dbOf(first, second);
  const next = mk('next', D3, T(3, 0, 30), T(3, 1, 30), 'Q1', { employee: 'Z' });
  const target = mk('target', D2, T(2, 23, 45), T(3, 0, 45), 'Q1');
  const r = resolveStaffingWithCallIns({
    tasksDB: [next, target], staffDB, targetDate: D2, windowDates: WIN,
    fullRoster: [{ name: 'Z', quals: ['Q1'] }, { name: 'W', quals: ['Q1'] }], allShiftsByPerson: shiftsOf(first, second), distanceResolver: null,
  });
  assert.equal(empOf(r.tasks, 'next'), 'Z');
  assert.notEqual(empOf(r.tasks, 'target'), 'Z');
  const db = {};
  for (const [d, list] of Object.entries(staffDB)) db[d] = [...list];
  for (const a of r.actions) {
    if (a.type !== 'callin') continue;
    for (const d of [D2, D3]) (db[d] ??= []).push({ name: a.name, quals: ['Q1'], shiftStart: a.shiftStart, shiftEnd: a.shiftEnd, basePos: null });
  }
  assert.deepEqual(validatePlan(r.tasks, db, D2, null, WIN), []);
});

// ── The proposal must hold once applied ─────────────────────────────────────
// The search may seat a task that starts in a shift and runs into the overtime
// allowance; trimming the proposals afterwards must keep the shift long enough
// for that task to still START inside it. Applied the way the page does it, the
// plan has to pass the validator.
function smallAirport(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const quals = ['Q1', 'Q2'];
  const people = [];
  for (let i = 0; i < 5; i++) {
    const from = 6 + Math.floor(rnd() * 5);
    people.push(person('P' + i, quals.filter(() => rnd() < 0.7).concat(['Q1']).slice(0, 2), T(2, from), T(2, from + 6 + Math.floor(rnd() * 3))));
  }
  const tasks = Array.from({ length: 22 }, (_, i) => {
    const start = new Date(T(2, 5).getTime() + Math.floor(rnd() * 18 * 4) * 15 * 60000);
    const end = new Date(start.getTime() + (30 + Math.floor(rnd() * 6) * 15) * 60000);
    return mk('s' + i, D2, start, end, quals[Math.floor(rnd() * 2)]);
  });
  const roster = [...people, person('X0', ['Q1', 'Q2'], T(2, 0), T(2, 1)), person('X1', ['Q1'], T(2, 0), T(2, 1))];
  return { people, tasks, roster };
}

test('applied the way the page applies it, the plan has no violations (overtime allowance in use)', () => {
  for (const allowance of [0, 60]) {
    for (let seed = 1; seed <= 25; seed++) {
      const { people, tasks, roster } = smallAirport(seed);
      const staffDB = dbOf(...people);
      const r = resolveStaffingWithCallIns({
        tasksDB: tasks, staffDB, targetDate: D2, windowDates: WIN, policy: { maxOvertimeMin: allowance },
        fullRoster: roster.map(p => ({ name: p.name, quals: p.quals })), allShiftsByPerson: shiftsOf(...people), distanceResolver: null,
      });
      const db = {};
      for (const [d, list] of Object.entries(staffDB)) db[d] = [...list];
      for (const a of r.actions) {
        if (a.type === 'extend') {
          for (const list of Object.values(db)) {
            const i = list.findIndex(sh => sh.name === a.name && sh.shiftStart.getTime() === a.originalStart.getTime());
            if (i >= 0) list[i] = { ...list[i], shiftStart: a.shiftStart, shiftEnd: a.shiftEnd };
          }
        } else {
          const p = roster.find(x => x.name === a.name);
          for (const d of [D2, D3]) (db[d] ??= []).push({ name: a.name, quals: p.quals, shiftStart: a.shiftStart, shiftEnd: a.shiftEnd, basePos: null });
        }
      }
      setPolicy({ maxOvertimeMin: allowance });
      assert.deepEqual(validatePlan(r.tasks, db, D2, null, [D2]), [], `seed ${seed}, allowance ${allowance}`);
    }
  }
});
