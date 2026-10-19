// Call-in plan, the rules that bound a proposal: nobody is called in over their own shift,
// an extension never exceeds 4 hours, and every proposal covers a task it was made for
// (checked on 1500 seeded small days).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy, DEFAULT_POLICY } from '../src/optimizer.js';
import { resolveStaffingWithCallIns } from '../src/utils/staffingGap.js';
import { DATE, D, mkTask, mkPerson, dbOf, rng, OPEN } from './helpers.mjs';

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

const H = 3600000;
const shiftsOf = people => new Map(people.map(p => [p.name, [{ shiftStart: p.shiftStart, shiftEnd: p.shiftEnd }]]));
const run = (tasks, working, roster, shifts) => resolveStaffingWithCallIns({
  tasksDB: tasks, staffDB: dbOf(...working), targetDate: DATE, windowDates: [DATE],
  fullRoster: roster, allShiftsByPerson: shifts, distanceResolver: null,
});

test('a person is not called in for a stretch that overlaps their own shift', () => {
  // R has a shift 07-12 that the staff table of the day does not list (say, filed elsewhere); the task at 08:00 lies inside it
  const shift = { name: 'R', shiftStart: D(7), shiftEnd: D(12) };
  const r = run([mkTask('x', D(8), D(8, 30), ['Q1'])], [], [{ name: 'R', quals: ['Q1'] }], new Map([['R', [shift]]]));
  assert.deepEqual(r.actions, []);
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.tasks.find(t => t.id === 'x').employee, OPEN);
});

test('an extension never goes past 4 hours: 5 hours late is a call-in or nothing, not a long extension', () => {
  const p = mkPerson('P', ['Q1'], 6, 14);
  for (const startH of [17, 18, 19]) {                      // the task ends 4.5, 5.5 and 6.5 hours after the shift
    const r = run([mkTask('x', D(startH, 30), D(startH + 1), ['Q1'])], [p], [{ name: 'P', quals: ['Q1'] }], shiftsOf([p]));
    for (const a of r.actions.filter(x => x.type === 'extend')) {
      assert.ok((a.shiftEnd - a.originalEnd) + (a.originalStart - a.shiftStart) <= 4 * H, `task at ${startH}:30, extension ${(a.shiftEnd - a.originalEnd) / H} h`);
    }
  }
  // exactly 4 hours is allowed: the task ends at 18:00
  const ok = run([mkTask('y', D(17), D(18), ['Q1'])], [p], [{ name: 'P', quals: ['Q1'] }], shiftsOf([p]));
  assert.deepEqual(ok.actions.map(a => a.type), ['extend']);
  assert.equal(ok.actions[0].shiftEnd.getTime(), D(18).getTime());
});

test('property: every proposal is a real interval that holds a task of its person, in 1500 seeded days', () => {
  let proposals = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const rnd = rng(seed * 13 + 1);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const working = [0, 1, 2, 3, 4].map(i => mkPerson('W' + i, [pick(['Q1', 'Q2']), 'Q1'].slice(0, 1 + Math.floor(rnd() * 2)), pick([6, 8, 10]), pick([14, 16, 18])));
    const roster = [...working.map(p => ({ name: p.name, quals: p.quals })), ...[0, 1, 2].map(i => ({ name: 'R' + i, quals: ['Q1', 'Q2'].slice(0, 1 + (i % 2)) }))];
    const tasks = Array.from({ length: 8 + Math.floor(rnd() * 18) }, (_, i) => {
      const s = D(6 + Math.floor(rnd() * 12), Math.floor(rnd() * 4) * 15);
      return mkTask('t' + i, s, new Date(s.getTime() + pick([30, 60, 90]) * 60000), [pick(['Q1', 'Q2'])]);
    });
    const r = run(tasks, working, roster, shiftsOf(working));
    for (const a of r.actions) {
      proposals++;
      assert.ok(Number.isFinite(a.shiftStart.getTime()) && Number.isFinite(a.shiftEnd.getTime()) && a.shiftEnd > a.shiftStart, `seed ${seed}: ${a.type} has an unusable interval`);
      const inside = r.tasks.filter(t => t.employee === a.name && t.start >= a.shiftStart && t.start < a.shiftEnd);
      assert.ok(inside.length > 0, `seed ${seed}: a proposal (${a.type}, ${a.name}) that holds no task`);
      if (a.type === 'extend') assert.ok((a.shiftEnd - a.originalEnd) + (a.originalStart - a.shiftStart) <= 4 * H, `seed ${seed}: extension over 4 h`);
      if (a.type === 'callin') assert.ok(a.shiftEnd - a.shiftStart >= 4 * H, `seed ${seed}: call-in under the 4 h minimum`);
    }
  }
  assert.ok(proposals > 1000, `the seeds produce proposals (${proposals})`);
});
