// The "who is missing" figures the dispatcher reads: how many people are needed
// at once (packIntoChannels), per time slot (bucketizeChannels) and as merged
// intervals per qualification (computeStaffingGaps). Hand-worked scenes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy, DEFAULT_POLICY } from '../src/optimizer.js';
import { packIntoChannels, bucketizeChannels, GRANULARITY_OPTIONS } from '../src/utils/staffDemand.js';
import { computeStaffingGaps } from '../src/utils/staffingGap.js';
import { DATE, D, mkTask, addDays, dayStart } from './helpers.mjs';

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
const NO_QUAL = /^\(без (допуска|квалификации)\)$/;
const t = (id, a, b, quals) => mkTask(id, D(...a), D(...b), quals);

// ── packIntoChannels ────────────────────────────────────────────────────────
test('channels: tasks that do not overlap share a person, overlapping ones need another', () => {
  const ch = packIntoChannels([t('a', [9], [10], ['Q1']), t('b', [9, 30], [10, 30], ['Q1']), t('c', [10], [11], ['Q1'])]);
  assert.equal(ch.length, 2);
  assert.deepEqual(ch.map(c => c.tasks.map(x => x.id)), [['a', 'c'], ['b']], 'c follows a (back to back), b runs next to them');
});

test('channels: without a roster a task of another qualification needs its own person', () => {
  const ch = packIntoChannels([t('a', [9], [10], ['Q1']), t('b', [10], [11], ['Q2'])]);
  assert.equal(ch.length, 2);
  assert.deepEqual(ch.map(c => c.quals), [['Q1'], ['Q2']]);
});

test('channels: with a roster, one person who holds both covers both in a row; the broadest real profile is taken', () => {
  const roster = [{ quals: ['Q1'] }, { quals: ['Q1', 'Q2'] }, { quals: ['Q2'] }];
  const ch = packIntoChannels([t('a', [9], [10], ['Q1']), t('b', [10], [11], ['Q2'])], roster);
  assert.equal(ch.length, 1);
  assert.deepEqual(ch[0].quals, ['Q1', 'Q2']);
  // nobody holds Q1+Q3: a task of both makes a channel of its own qualifications
  const lone = packIntoChannels([t('x', [9], [10], ['Q1', 'Q3'])], roster);
  assert.deepEqual(lone[0].quals, ['Q1', 'Q3']);
  // an empty requirement list uses the scalar reqType
  const scalar = packIntoChannels([{ ...t('s', [9], [10], []), reqType: 'QX' }]);
  assert.deepEqual(scalar[0].quals, ['QX']);
});

test('channels: the input order does not matter (sorted by start) and the input is not modified', () => {
  const tasks = [t('c', [10], [11], ['Q1']), t('a', [9], [10], ['Q1']), t('b', [9, 30], [10, 30], ['Q1'])];
  const ids = tasks.map(x => x.id);
  const ch = packIntoChannels(tasks);
  assert.deepEqual(tasks.map(x => x.id), ids);
  assert.equal(ch.length, 2);
  assert.deepEqual(packIntoChannels([]), []);
});

// ── bucketizeChannels ───────────────────────────────────────────────────────
test('buckets: the grid starts at the Moscow midnight, one bucket per slot over the window', () => {
  const b = bucketizeChannels([], DATE, 2, 60);
  assert.equal(b.length, 48);
  assert.equal(b[0].start.getTime(), dayStart(DATE).getTime());
  assert.equal(b[1].start.getTime() - b[0].start.getTime(), 3600000);
  assert.equal(b[47].end.getTime(), dayStart(addDays(DATE, 2)).getTime());
  assert.equal(bucketizeChannels([], DATE, 1, 15).length, 96);
  assert.equal(bucketizeChannels([], DATE, 1, 45).length, Math.ceil(24 * 60 / 45));
  assert.deepEqual(GRANULARITY_OPTIONS.map(o => o.value), [5, 15, 30, 60]);
});

test('buckets: a person counts once per slot however many tasks they do in it, and only slots the task touches', () => {
  const ch = packIntoChannels([t('a', [9], [9, 20], ['Q1']), t('b', [9, 30], [9, 50], ['Q1']), t('c', [10, 15], [10, 30], ['Q1'])]);
  assert.equal(ch.length, 1);
  const b = bucketizeChannels(ch, DATE, 1, 60);
  assert.deepEqual(b.map((x, i) => [i, x.count]).filter(([, n]) => n), [[9, 1], [10, 1]]);
  assert.equal(b[9].count, 1, 'two tasks in the 09:00 slot: one person');
  assert.equal(b[9]._seen, undefined, 'no bookkeeping left on the result');
  const fine = bucketizeChannels(ch, DATE, 1, 15);
  assert.deepEqual(fine.map((x, i) => [i, x.count]).filter(([, n]) => n), [[36, 1], [37, 1], [38, 1], [39, 1], [41, 1]], 'the gap between two tasks is idle time, not demand');
});

test('buckets: a task ending exactly on a slot border does not touch the next slot; byQual splits by requirement', () => {
  const ch = packIntoChannels([t('a', [9], [10], ['Q1']), t('b', [9, 30], [10, 30], ['Q2'])]);
  const b = bucketizeChannels(ch, DATE, 1, 60);
  assert.equal(b[10].count, 1, 'a ends at 10:00, only b is in the 10:00 slot');
  assert.deepEqual(b[9].byQual, { Q1: 1, Q2: 1 });
  assert.deepEqual(b[10].byQual, { Q2: 1 });
  assert.equal(b[11].count, 0);
  const noQ = bucketizeChannels(packIntoChannels([t('n', [9], [9, 30], [])]), DATE, 1, 60);
  // (the label of "no requirement" is being renamed by the interface work: either wording)
  assert.deepEqual(Object.values(noQ[9].byQual), [1]);
  assert.match(Object.keys(noQ[9].byQual)[0], NO_QUAL);
});

test('buckets: a task before the window start or past its end is clipped, not an error', () => {
  const early = mkTask('e', D(-3), D(1), ['Q1']);                  // 21:00 the day before to 01:00
  const late = mkTask('l', D(23), D(26), ['Q1']);                  // 23:00 to 02:00 the next day
  const b = bucketizeChannels(packIntoChannels([early, late]), DATE, 1, 60);
  assert.equal(b.length, 24);
  assert.equal(b[0].count, 1);
  assert.equal(b[23].count, 1);
  assert.equal(b.reduce((s, x) => s + x.count, 0), 2);
});

// ── computeStaffingGaps ─────────────────────────────────────────────────────
test('gaps: nothing open, or no window, is an empty list', () => {
  assert.deepEqual(computeStaffingGaps({ backlogTasks: [], windowStart: DATE, windowDays: 1 }), []);
  assert.deepEqual(computeStaffingGaps({ backlogTasks: [t('a', [9], [10], ['Q1'])], windowStart: null, windowDays: 1 }), []);
});

test('gaps: people needed at once per qualification, merged into intervals, the largest peak first', () => {
  const backlog = [
    t('a', [9], [10], ['Q1']), t('b', [9, 30], [10, 30], ['Q1']),   // two at 09-10, one at 10-11
    t('c', [12], [13], ['Q2']),
    t('d', [14], [15], ['Q2']), t('e', [14], [15], ['Q2']), t('f', [14, 30], [15, 30], ['Q2']),
  ];
  const gaps = computeStaffingGaps({ backlogTasks: backlog, windowStart: DATE, windowDays: 1, granularityMin: 60 });
  assert.deepEqual(gaps.map(g => [g.reqTypeLabel, g.taskCount, g.peak]), [['Q2', 4, 3], ['Q1', 2, 2]], 'sorted by peak');
  const q1 = gaps.find(g => g.reqTypeLabel === 'Q1');
  assert.deepEqual(q1.intervals.map(i => [i.start.getTime(), i.end.getTime(), i.count]), [
    [D(9).getTime(), D(10).getTime(), 2], [D(10).getTime(), D(11).getTime(), 1],
  ]);
  assert.deepEqual(q1.reqTypes, ['Q1']);
  const q2 = gaps.find(g => g.reqTypeLabel === 'Q2');
  assert.deepEqual(q2.intervals.map(i => [i.start.getTime(), i.end.getTime(), i.count]), [
    [D(12).getTime(), D(13).getTime(), 1], [D(14).getTime(), D(15).getTime(), 3], [D(15).getTime(), D(16).getTime(), 1],
  ], 'separate intervals when the demand drops to zero in between');
});

test('gaps: neighbouring slots with the same count are one interval; a finer grid shows the real shape', () => {
  const backlog = [t('a', [9], [11, 30], ['Q1'])];
  const hourly = computeStaffingGaps({ backlogTasks: backlog, windowStart: DATE, windowDays: 1, granularityMin: 60 })[0];
  assert.deepEqual(hourly.intervals.map(i => [i.start.getTime(), i.end.getTime()]), [[D(9).getTime(), D(12).getTime()]]);
  const fine = computeStaffingGaps({ backlogTasks: backlog, windowStart: DATE, windowDays: 1, granularityMin: 30 })[0];
  assert.deepEqual(fine.intervals.map(i => [i.start.getTime(), i.end.getTime()]), [[D(9).getTime(), D(11, 30).getTime()]]);
});

test('gaps: tasks are grouped by the exact requirement text; none at all is "(без квалификации)"', () => {
  const backlog = [t('a', [9], [10], ['Q1', 'Q2']), t('b', [9], [10], ['Q1']), t('c', [9], [10], [])];
  const gaps = computeStaffingGaps({ backlogTasks: backlog, windowStart: DATE, windowDays: 1 });
  const labels = gaps.map(g => g.reqTypeLabel).sort();
  assert.deepEqual(labels.filter(l => !NO_QUAL.test(l)), ['Q1', 'Q1 + Q2']);
  assert.equal(labels.filter(l => NO_QUAL.test(l)).length, 1);
  assert.deepEqual(gaps.find(g => g.reqTypeLabel === 'Q1 + Q2').reqTypes, ['Q1', 'Q2']);
  const none = gaps.find(g => NO_QUAL.test(g.reqTypeLabel));
  assert.deepEqual(none.reqTypes, [none.reqTypeLabel]);
});

test('gaps: the default slot is an hour; a task outside the window gives no interval and no group', () => {
  const inWindow = computeStaffingGaps({ backlogTasks: [t('a', [9], [9, 10], ['Q1'])], windowStart: DATE, windowDays: 1 });
  assert.equal(inWindow[0].intervals[0].end.getTime() - inWindow[0].intervals[0].start.getTime(), 3600000);
  const outside = computeStaffingGaps({ backlogTasks: [mkTask('o', D(30), D(31), ['Q1'])], windowStart: DATE, windowDays: 1 });
  assert.deepEqual(outside, []);
});
