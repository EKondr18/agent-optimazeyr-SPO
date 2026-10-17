// The operating timezone helpers must give the same answer whatever timezone
// the process itself runs in (run with TZ=UTC and TZ=America/Los_Angeles too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, dayStart, addDays, wallClock, fmtHM, fmtDM, daysBetween } from '../src/utils/tz.js';

test('a moment belongs to the Moscow day, not the process day', () => {
  assert.equal(dayKey(new Date('2026-09-01T20:59:59Z')), '2026-09-01'); // 23:59 Moscow
  assert.equal(dayKey(new Date('2026-09-01T21:00:00Z')), '2026-09-02'); // 00:00 Moscow
  assert.equal(dayKey(new Date('2026-09-01T00:30:00Z')), '2026-09-01'); // 03:30 Moscow
});

test('dayStart is the Moscow midnight and round-trips through dayKey', () => {
  assert.equal(dayStart('2026-09-02').toISOString(), '2026-09-01T21:00:00.000Z');
  for (const k of ['2026-01-01', '2026-03-29', '2026-10-25', '2026-12-31']) assert.equal(dayKey(dayStart(k)), k);
});

test('addDays and daysBetween ignore month ends and leap days', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.deepEqual(daysBetween('2026-08-30', '2026-09-02'), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
});

test('wall clock and formatting are Moscow time', () => {
  const d = new Date('2026-09-01T20:05:00Z');
  assert.deepEqual(wallClock(d), { y: 2026, mo: 9, d: 1, h: 23, mi: 5 });
  assert.equal(fmtHM(d), '23:05');
  assert.equal(fmtDM(d), '01.09');
});
