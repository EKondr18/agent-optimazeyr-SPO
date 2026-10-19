// What the loader makes of each field: tasks (stands, flight, qualification
// vector, times, colours), shifts (qualification union, base stand, days,
// duplicates, department rule), the roster, all through the CSV path the page
// uses. Synthetic data only. The report counters are in loader.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvCollections, parseJsonExport } from '../src/utils/dataParser.js';

const csv = (...lines) => lines.join('\n');
const files = (over = {}) => ({
  ordersCsv: csv(
    '_id,start_time,end_time,req_qual_vector,flight_event_ref,order_rule_ref,flight_ref,outbound_flight_ref,inbound_flight_ref,start_loc_ref,dest_loc_ref,setup_loc_ref,clearup_loc_ref,res_assigned_to_ref',
    // full row: setup/clearup differ from start/dest, an assignment from the source system
    'o1,2026-03-10T09:00:00+03:00,2026-03-10T10:30:00+03:00,SPO_A,EV_X,RULE_1,FL1,,,S10,S11,S09,S12,spo1',
    // fallbacks: no event -> rule; no flight -> outbound; no setup/clearup -> start/dest
    'o2,2026-03-10T11:00:00+03:00,2026-03-10T11:20:00+03:00,"SPO_A,SPO_B",,RULE_2,,OUT7,,S20,S21,,,',
    // fallbacks: no rule either; inbound flight; no stands at all; two quals with a semicolon
    'o3,2026-03-10T12:00:00+03:00,2026-03-10T12:45:00+03:00,SPO_A;SPO_B,,,,,IN9,,,,,',
    // no flight at all, no quals
    'o4,2026-03-10T13:00:00+03:00,2026-03-10T13:05:00+03:00,,EV_X,,,,,S30,S30,,,',
  ),
  shiftsCsv: csv(
    '_id,resource_ref,department_ref,shift_state_ref,scheduled_start,scheduled_end,location_ref,default_location_ref',
    '1,r1,SPO,SCHEDULED,2026-03-10T06:00:00+03:00,2026-03-10T14:00:00+03:00,BASE1,DEF1',
    '2,r1,SPO,SCHEDULED,2026-03-10T06:00:00+03:00,2026-03-10T14:00:00+03:00,BASE1,DEF1',   // the same person and start: one
    '3,r2,SPO,SCHEDULED,2026-03-10T21:00:00+03:00,2026-03-11T05:00:00+03:00,,DEF2',         // through midnight; base from the default
    '4,r3,*,SCHEDULED,2026-03-10T08:00:00+03:00,2026-03-10T16:00:00+03:00,,',               // home department decides (SPO)
    '5,r4,SPO,SCHEDULED,2026-03-10T08:00:00+03:00,2026-03-10T16:00:00+03:00,,',             // r4 is another department at home, but the shift says SPO
    '6,r5,*,SCHEDULED,2026-03-10T08:00:00+03:00,2026-03-10T16:00:00+03:00,,',               // r5: home department is not SPO
  ),
  resourcesCsv: csv(
    'internal_id,name,additional_name,default_department_ref',
    'r1,Plain Name,Display One,SPO', 'r2,Only Name,,SPO', 'r3,,,SPO', 'r4,Lent Person,,AUDIT', 'r5,Elsewhere,,AUDIT', 'r6,Off Duty,,SPO',
  ),
  resQualCsv: csv('_id,internal_id,name', 'qa,A,SPO_A', 'qb,B,SPO_B', 'qc,C,SPO_C'),
  resourceQualificationsCsv: csv('resource_ref,qualification_ref', 'r1,A', 'r1,qb', 'r2,C', 'r6,A', 'r6,B'),
  shiftQualificationsCsv: csv('shift_ref,qualification_ref', '1,C', '3,UNKNOWN_REF'),
  ...over,
});

const load = over => parseCsvCollections(files(over));
const byId = (tasks, id) => tasks.find(t => t.id === id);

test('tasks: the name falls back event -> rule -> "Задача", the flight flight -> outbound -> inbound -> "Рейс не указ."', () => {
  const { tasks } = load();
  assert.deepEqual(tasks.map(t => [t.id, t.name, t.flight]), [
    ['o1', 'EV_X', 'FL1'], ['o2', 'RULE_2', 'OUT7'], ['o3', 'Задача', 'IN9'], ['o4', 'EV_X', 'Рейс не указ.'],
  ]);
});

test('tasks: entry is setup then start, exit is clearup then dest, the display stand is the start stand, "ПЕРРОН" when empty', () => {
  const { tasks } = load();
  assert.deepEqual([byId(tasks, 'o1').pos, byId(tasks, 'o1').entryPos, byId(tasks, 'o1').exitPos], ['S10', 'S09', 'S12']);
  assert.deepEqual([byId(tasks, 'o2').pos, byId(tasks, 'o2').entryPos, byId(tasks, 'o2').exitPos], ['S20', 'S20', 'S21']);
  assert.deepEqual([byId(tasks, 'o3').pos, byId(tasks, 'o3').entryPos, byId(tasks, 'o3').exitPos], ['ПЕРРОН', 'ПЕРРОН', 'ПЕРРОН']);
});

test('tasks: the qualification vector splits on comma and semicolon, reqType joins with " + ", empty is no requirement', () => {
  const { tasks } = load();
  assert.deepEqual(byId(tasks, 'o1').reqTypes, ['SPO_A']);
  assert.deepEqual(byId(tasks, 'o2').reqTypes, ['SPO_A', 'SPO_B']);
  assert.equal(byId(tasks, 'o2').reqType, 'SPO_A + SPO_B');
  assert.deepEqual(byId(tasks, 'o3').reqTypes, ['SPO_A', 'SPO_B']);
  assert.deepEqual(byId(tasks, 'o4').reqTypes, []);
  assert.equal(byId(tasks, 'o4').reqType, '');
});

test('tasks: times, duration, Moscow day, never assigned or locked whatever the source says, one colour per name', () => {
  const { tasks, colorMap } = load();
  const o1 = byId(tasks, 'o1');
  assert.equal(o1.start.toISOString(), '2026-03-10T06:00:00.000Z');
  assert.equal(o1.end.toISOString(), '2026-03-10T07:30:00.000Z');
  assert.equal(o1.duration, 90);
  assert.equal(o1.date, '2026-03-10');
  assert.equal(o1.baseStart.getTime(), o1.start.getTime());
  assert.notEqual(o1.baseStart, o1.start, 'a copy, not the same object');
  for (const t of tasks) { assert.equal(t.employee, 'Не назначено'); assert.equal(t.isLocked, false); }
  assert.equal(byId(tasks, 'o1').color, byId(tasks, 'o4').color, 'the same name, the same colour');
  assert.notEqual(byId(tasks, 'o1').color, byId(tasks, 'o2').color);
  assert.equal(colorMap.EV_X, o1.color);
});

test('a task just before Moscow midnight belongs to that day, one just after to the next', () => {
  const orders = csv('_id,start_time,end_time,req_qual_vector',
    'a,2026-03-10T23:30:00+03:00,2026-03-11T00:10:00+03:00,Q', 'b,2026-03-11T00:00:00+03:00,2026-03-11T00:30:00+03:00,Q');
  const { tasks } = load({ ordersCsv: orders });
  assert.deepEqual(tasks.map(t => t.date), ['2026-03-10', '2026-03-11']);
});

test('shifts: a person\'s qualifications are their own plus the ones recorded on that shift, as codes', () => {
  const { staffDB } = load();
  const day = staffDB['2026-03-10'];
  const shift1 = day.find(s => s.name === 'Display One');
  assert.deepEqual([...shift1.quals].sort(), ['SPO_A', 'SPO_B', 'SPO_C'], 'A from the person, B by its _id, C from the shift');
  const night = day.find(s => s.name === 'Only Name');
  assert.deepEqual([...night.quals].sort(), ['SPO_C', 'UNKNOWN_REF'], 'an unknown reference stays as it is, not dropped');
});

test('shifts: the name is additional_name, else name, else the id; the base stand is the shift\'s, else the default', () => {
  const { staffDB } = load();
  const day = staffDB['2026-03-10'];
  assert.deepEqual(day.map(s => s.name).sort(), ['Display One', 'Lent Person', 'Only Name', 'r3'].sort());
  assert.equal(day.find(s => s.name === 'Display One').basePos, 'BASE1');
  assert.equal(day.find(s => s.name === 'Only Name').basePos, 'DEF2');
  assert.equal(day.find(s => s.name === 'r3').basePos, null);
});

test('shifts: a night shift is in both days, the same person and start twice is one shift, departments follow the shift', () => {
  const { staffDB, loadReport } = load();
  assert.deepEqual(Object.keys(staffDB).sort(), ['2026-03-10', '2026-03-11']);
  assert.equal(staffDB['2026-03-10'].filter(s => s.name === 'Display One').length, 1);
  assert.equal(staffDB['2026-03-11'].length, 1);
  assert.equal(staffDB['2026-03-11'][0], staffDB['2026-03-10'].find(s => s.name === 'Only Name'), 'one object in both days');
  assert.equal(staffDB['2026-03-10'].some(s => s.name === 'Lent Person'), true, 'AUDIT at home, SPO on the shift');
  assert.equal(staffDB['2026-03-10'].some(s => s.name === 'Elsewhere'), false);
  assert.equal(loadReport.shifts.skipped.otherDepartment, 1);
  assert.equal(staffDB['2026-03-10'].find(s => s.name === 'Display One').shiftEnd.toISOString(), '2026-03-10T11:00:00.000Z');
});

test('the roster lists every SPO person with their own qualifications, shift or not', () => {
  const { fullRoster } = load();
  const names = fullRoster.map(p => p.name).sort();
  assert.deepEqual(names, ['Display One', 'Off Duty', 'Only Name', 'r3'].sort());
  assert.deepEqual([...fullRoster.find(p => p.name === 'Off Duty').quals].sort(), ['SPO_A', 'SPO_B']);
  assert.deepEqual(fullRoster.find(p => p.name === 'Display One').quals.sort(), ['SPO_A', 'SPO_B'], 'personal only: no shift quals');
});

test('the JSON path joins shifts and qualifications by string, so a numeric _id matches the same id from a CSV', () => {
  const r = parseJsonExport({
    orders: [], shifts: [{ _id: 7, resource_ref: 'r1', department_ref: 'SPO', scheduled_start: '2026-03-10T06:00:00Z', scheduled_end: '2026-03-10T10:00:00Z' }],
    resources: [{ internal_id: 'r1', name: 'N', default_department_ref: 'SPO' }],
    resQual: [{ _id: 'qa', internal_id: 'A', name: 'SPO_A' }], resourceQualifications: [],
    shiftQualifications: [{ shift_ref: '7', qualification_ref: 'qa' }],
  });
  assert.deepEqual(r.staffDB['2026-03-10'][0].quals, ['SPO_A']);
});

test('a task of 0 rows loads as an empty list, not an error', () => {
  const { tasks, staffDB } = load({ ordersCsv: '', shiftsCsv: undefined });
  assert.deepEqual(tasks, []);
  assert.deepEqual(staffDB, {});
});
