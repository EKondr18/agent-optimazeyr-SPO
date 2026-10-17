// What the API entry points do with input that is not what the search assumes:
// string and numeric times, missing fields, unreadable times, end not after
// start, repeated ids, and malformed change batches. Unusable tasks take no
// part in the calculation, come back open in their places and are listed;
// nothing is thrown away silently and the rest of the work still goes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, DEFAULT_POLICY, planWindow, runOptimizer, applyChanges, validatePlan,
} from '../src/optimizer.js';

const DATE = '2026-01-01';
const WIN = [DATE];
const OPEN = 'Не назначено';
const D = (h, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));
const iso = (h, m = 0) => D(h, m).toISOString();
const mk = (id, h, m, eh, em, qual, extra = {}) => ({
  id, date: DATE, name: 'T' + id, flight: 'FL' + id, pos: 'POS1', entryPos: 'POS1', exitPos: 'POS1',
  reqType: qual, reqTypes: [qual], start: D(h, m), end: D(eh, em), employee: OPEN, isLocked: false, ...extra,
});
const person = (name, quals, from = 6, to = 20) => ({ name, quals, shiftStart: D(from), shiftEnd: D(to), basePos: null });
const db = (...people) => ({ [DATE]: people });
const staff = db(person('S1', ['Q1']), person('S2', ['Q1']));
const find = (tasks, id) => tasks.find(t => t.id === id);
const snapshot = x => JSON.stringify(x);

test.beforeEach(() => setPolicy(DEFAULT_POLICY));

test('planWindow: unusable tasks are set aside, listed, open, and do not disturb the rest', () => {
  const good1 = mk('g1', 9, 0, 10, 0, 'Q1');
  const good2 = mk('g2', 12, 0, 13, 0, 'Q1');
  const tasks = [
    good1,
    { ...mk('dup', 9, 30, 10, 30, 'Q1') }, // first copy is fine
    { ...mk('dup', 9, 30, 10, 30, 'Q1'), name: 'second copy' },
    { ...mk('nan', 9, 0, 10, 0, 'Q1'), start: new Date('nonsense') },
    { ...mk('backwards', 11, 0, 10, 0, 'Q1') },
    { ...mk('zero', 11, 0, 11, 0, 'Q1') },
    { ...mk('noend', 9, 0, 10, 0, 'Q1'), end: undefined },
    { ...mk('x', 9, 0, 10, 0, 'Q1'), id: undefined },
    good2,
  ];
  const before = snapshot(tasks);
  const r = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 0 });
  assert.equal(snapshot(tasks), before, 'the input is not modified');

  assert.equal(r.tasks.length, tasks.length, 'nothing is dropped from the output');
  assert.deepEqual(r.tasks.map(t => t.id), tasks.map(t => t.id), 'and it keeps its order');
  const bad = ['nan', 'backwards', 'zero', 'noend'];
  for (const id of bad) assert.equal(find(r.tasks, id).employee, OPEN, id);
  assert.equal(r.tasks[2].employee, OPEN, 'the second copy of a repeated id stays open');
  assert.equal(r.tasks[2].name, 'second copy');
  assert.equal(r.tasks[7].employee, OPEN);
  for (const id of ['g1', 'g2', 'dup']) assert.notEqual(find(r.tasks, id).employee, OPEN, id + ' is placed');
  assert.deepEqual(r.stats.violations, []);

  const inv = r.stats.invalid;
  assert.equal(inv.count, 6);
  assert.deepEqual(inv.reasons, { DUPLICATE_ID: 1, BAD_START: 1, END_NOT_AFTER_START: 2, BAD_END: 1, NO_ID: 1 });
  assert.deepEqual(inv.items.map(x => x.reason), ['DUPLICATE_ID', 'BAD_START', 'END_NOT_AFTER_START', 'END_NOT_AFTER_START', 'BAD_END', 'NO_ID']);
  assert.equal(inv.items[0].id, 'dup');
});

test('planWindow: clean input reports no invalid tasks and gives the same plan as before', () => {
  const tasks = [mk('a', 9, 0, 10, 0, 'Q1'), mk('b', 9, 30, 10, 30, 'Q1'), mk('c', 9, 45, 10, 15, 'Q1')];
  const r = planWindow(tasks, staff, DATE, null, WIN, { lnsIterations: 0 });
  assert.deepEqual(r.stats.invalid, { count: 0, reasons: {}, items: [] });
  assert.equal(r.tasks.filter(t => t.employee === OPEN).length, 1, 'three overlapping tasks, two people');
});

test('planWindow: ISO-string and numeric times, missing employee / isLocked / date are normalized', () => {
  const raw = {
    id: 's', name: 'Ts', flight: 'F', pos: 'POS1', entryPos: 'POS1', exitPos: 'POS1', reqType: 'Q1', reqTypes: ['Q1'],
    start: iso(9), end: D(10).getTime(), baseStart: iso(9), baseEnd: iso(10),
  };
  const before = snapshot(raw);
  const r = planWindow([raw], staff, DATE, null, WIN, { lnsIterations: 0 });
  assert.equal(snapshot(raw), before);
  const t = r.tasks[0];
  assert.ok(t.start instanceof Date && t.end instanceof Date && t.baseStart instanceof Date && t.baseEnd instanceof Date);
  assert.equal(t.start.getTime(), D(9).getTime());
  assert.equal(t.end.getTime(), D(10).getTime());
  assert.equal(t.isLocked, false);
  assert.equal(t.date, DATE, 'the day comes from the start (Moscow day), as the loader gives it');
  assert.notEqual(t.employee, OPEN, 'and the task takes part in the plan');
  assert.equal(r.stats.invalid.count, 0);
});

test('a time string without a zone is Moscow wall-clock time, whatever the process timezone', () => {
  const raw = { ...mk('m', 9, 0, 10, 0, 'Q1'), start: '2026-01-01T09:00:00', end: '2026-01-01T10:00:00' };
  const r = runOptimizer([raw], db(person('S1', ['Q1'])), DATE, null, WIN);
  assert.equal(r[0].start.toISOString(), '2026-01-01T06:00:00.000Z');
  assert.equal(r[0].employee, 'S1', 'inside the 06:00-20:00 UTC shift');
});

test('runOptimizer: unusable tasks stay open in place, the rest is planned', () => {
  const tasks = [mk('a', 9, 0, 10, 0, 'Q1'), { ...mk('a', 9, 0, 10, 0, 'Q1') }, { ...mk('b', 9, 0, 10, 0, 'Q1'), end: new Date(NaN) }, mk('c', 9, 0, 10, 0, 'Q1')];
  const r = runOptimizer(tasks, staff, DATE, null, WIN);
  assert.equal(r.length, 4);
  assert.deepEqual(r.map(t => t.id), ['a', 'a', 'b', 'c']);
  assert.deepEqual(r.map(t => t.employee === OPEN), [false, true, true, false]);
  assert.deepEqual(validatePlan(r, staff, DATE, null, WIN), []);
});

test('applyChanges: a clean batch is applied in order, several changes of one id stack up', () => {
  const base = [mk('a', 9, 0, 9, 30, 'Q1', { employee: 'S1' }), mk('b', 12, 0, 12, 30, 'Q1', { employee: 'S2' })];
  const r = applyChanges(base, staff, DATE, null, WIN, [
    { id: 'n1', ...mk('n1', 14, 0, 14, 30, 'Q1') },
    { id: 'a', start: D(10), end: D(10, 30) },
    { id: 'a', start: D(11), end: D(11, 30) }, // second change of the same task wins
    { id: 'n1', end: D(15) },                 // extends the task added a moment ago
    { id: 'b', removed: true },
  ]);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.tasks.map(t => t.id), ['a', 'n1']);
  assert.equal(find(r.tasks, 'a').start.getTime(), D(11).getTime());
  assert.equal(find(r.tasks, 'n1').end.getTime(), D(15).getTime());
  assert.notEqual(find(r.tasks, 'n1').employee, OPEN);
  assert.deepEqual(r.violations, []);
});

test('applyChanges: bad entries are rejected with a reason, the others still go through', () => {
  const base = [mk('a', 9, 0, 9, 30, 'Q1', { employee: 'S1' })];
  const before = snapshot(base);
  const changes = [
    { id: 'a', start: iso(10), end: iso(10, 30) },        // string times: fine
    { id: 'a', start: new Date('nonsense') },             // unreadable
    { id: 'a', end: D(9) },                                // end before the (new) start
    { id: 'new-no-times', name: 'x' },                     // an add without times
    { id: 'ghost', start: D(11) },                         // an update of an unknown id, not enough to make a task
    { id: 'new-dup-ok', ...mk('new-dup-ok', 12, 0, 12, 30, 'Q1') },
    { start: D(9), end: D(10) },                           // no id
    null,
    'text',
    { id: 'new-nan', ...mk('new-nan', 12, 0, 12, 30, 'Q1'), end: NaN },
  ];
  const r = applyChanges(base, staff, DATE, null, WIN, changes);
  assert.equal(snapshot(base), before);
  assert.deepEqual(r.rejected.map(x => [x.id, x.reason]), [
    ['a', 'BAD_START'], ['a', 'END_NOT_AFTER_START'], ['new-no-times', 'MISSING_TIMES'], ['ghost', 'MISSING_TIMES'],
    [null, 'NO_ID'], [null, 'BAD_CHANGE'], [null, 'BAD_CHANGE'], ['new-nan', 'BAD_END'],
  ]);
  assert.ok(r.rejected.every(x => x.source === 'change'));
  assert.deepEqual(r.tasks.map(t => t.id).sort(), ['a', 'new-dup-ok'], 'no half-made task appears');
  assert.equal(find(r.tasks, 'a').start.getTime(), D(10).getTime(), 'the good change to "a" was applied');
  assert.ok(find(r.tasks, 'a').start instanceof Date);
  assert.notEqual(find(r.tasks, 'new-dup-ok').employee, OPEN);
});

test('applyChanges: changes that is not an array, or missing, does not fail the call', () => {
  const base = [mk('a', 9, 0, 9, 30, 'Q1', { employee: 'S1' })];
  for (const bad of [undefined, null, 'abc', { id: 'a' }, 42]) {
    const r = applyChanges(base, staff, DATE, null, WIN, bad);
    assert.deepEqual(r.rejected, [{ id: null, reason: 'CHANGES_NOT_ARRAY', source: 'change' }]);
    assert.deepEqual(r.tasks.map(t => [t.id, t.employee]), [['a', 'S1']]);
  }
});

test('applyChanges: now may be a Date, epoch milliseconds or an ISO string; an unreadable one applies nothing', () => {
  const base = [
    mk('past', 7, 0, 7, 30, 'Q1', { employee: 'S1' }),
    mk('later', 12, 0, 12, 30, 'Q1', { employee: 'S1' }),
  ];
  const change = [{ id: 'later', start: D(13), end: D(13, 30) }];
  const hashOf = r => r.tasks.map(t => `${t.id}:${t.employee}:${t.start.getTime()}`).join('|');
  const asDate = applyChanges(base, staff, DATE, null, WIN, change, { now: D(9) });
  const asNumber = applyChanges(base, staff, DATE, null, WIN, change, { now: D(9).getTime() });
  const asString = applyChanges(base, staff, DATE, null, WIN, change, { now: iso(9) });
  assert.equal(hashOf(asNumber), hashOf(asDate));
  assert.equal(hashOf(asString), hashOf(asDate));
  assert.deepEqual(asNumber.rejected, []);
  assert.equal(find(asNumber.tasks, 'later').start.getTime(), D(13).getTime());

  for (const bad of [{}, 'tomorrow', NaN, [1], true]) {
    const r = applyChanges(base, staff, DATE, null, WIN, change, { now: bad });
    assert.deepEqual(r.rejected, [{ id: 'later', reason: 'BAD_NOW', source: 'change' }], String(bad));
    assert.equal(find(r.tasks, 'later').start.getTime(), D(12).getTime(), 'nothing was changed without a usable "now"');
    assert.equal(find(r.tasks, 'later').employee, 'S1');
    assert.equal(r.terminationReason, 'rejected');
  }
});

test('applyChanges: an unusable task of the plan comes back open and listed; a change can repair it', () => {
  const base = [
    mk('a', 9, 0, 9, 30, 'Q1', { employee: 'S1' }),
    { ...mk('broken', 9, 0, 9, 30, 'Q1', { employee: 'S2' }), end: new Date(NaN) },
    { ...mk('a', 9, 0, 9, 30, 'Q1', { employee: 'S2' }) }, // repeated id
    { ...mk('fixme', 9, 0, 9, 30, 'Q1', { employee: 'S2' }), end: undefined },
  ];
  const r = applyChanges(base, staff, DATE, null, WIN, [{ id: 'fixme', end: D(10) }]);
  assert.deepEqual(r.tasks.map(t => t.id), ['a', 'broken', 'a', 'fixme']);
  assert.deepEqual(r.rejected.map(x => [x.id, x.reason, x.source]).sort(),
    [['a', 'DUPLICATE_ID', 'task'], ['broken', 'BAD_END', 'task']]);
  assert.equal(r.tasks[1].employee, OPEN);
  assert.equal(r.tasks[2].employee, OPEN);
  assert.equal(r.tasks[0].employee, 'S1');
  assert.notEqual(find(r.tasks, 'fixme').employee, OPEN, 'repaired by the change and planned');
  assert.deepEqual(r.violations, []);
});
