// Loader: what the load report counts, what a file in the wrong slot does,
// CRLF/BOM, and that the Moscow day does not depend on the process timezone.
// All data here is synthetic. Run under several process timezones:
//   TZ=UTC npm test ; TZ=America/Los_Angeles npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseJsonExport, parseCsvCollections, parseCSV } from '../src/utils/dataParser.js';

const PARSER_URL = new URL('../src/utils/dataParser.js', import.meta.url).href;

const resources = [
  { internal_id: 'spo1', name: 'SPO One', default_department_ref: 'SPO' },
  { internal_id: 'spo2', name: 'SPO Two', default_department_ref: 'SPO' },
  { internal_id: 'aud1', name: 'Audit One', default_department_ref: 'АУДИТ' },
];
const resQual = [{ _id: 'q-a', internal_id: 'A', name: 'SPO_A' }];
const resourceQualifications = [{ resource_ref: 'spo1', qualification_ref: 'A' }];
const shiftQualifications = [{ shift_ref: 1, qualification_ref: 'q-a' }];

const shift = (id, resource, extra = {}) => ({
  _id: id, resource_ref: resource, department_ref: 'SPO', shift_state_ref: 'SCHEDULED',
  scheduled_start: '2026-09-20T05:00:00.000Z', scheduled_end: '2026-09-20T17:00:00.000Z', location_ref: '*', ...extra,
});
const order = (id, start, end, extra = {}) => ({
  _id: id, start_time: start, end_time: end, req_qual_vector: ['SPO_A'], flight_event_ref: 'EV', ...extra,
});
const parse = (over = {}) => parseJsonExport({
  orders: [], shifts: [], resources, resQual, resourceQualifications, shiftQualifications, ...over,
});

// ── load report ─────────────────────────────────────────────────────────────

test('load report: every skipped shift row is counted under its reason', () => {
  const { staffDB, loadReport } = parse({
    shifts: [
      shift(1, 'spo1'),                                   // used
      shift(2, 'spo2'),                                   // used
      shift(3, 'aud1', { department_ref: 'АУДИТ' }),       // another department
      shift(10, 'aud1'),                                  // audit person lent to SPO: used
      shift(4, 'aud1', { department_ref: '*' }),          // home department decides: not SPO
      shift(5, 'spo1', { shift_state_ref: 'canceled' }),  // cancelled (any case)
      shift(6, 'ghost'),                                  // resource not in the directory
      shift(7, '', {}),                                   // no resource at all
      shift(8, 'spo2', { scheduled_end: 'not a date' }),  // unreadable date
      shift(9, 'spo2', { scheduled_start: '' }),          // empty date
    ],
  });
  assert.deepEqual(loadReport.shifts, {
    total: 10, used: 3,
    skipped: { noResource: 2, otherDepartment: 2, cancelled: 1, badDates: 2 },
    badIntervals: 0,
  });
  const { total, used, skipped } = loadReport.shifts;
  assert.equal(used + Object.values(skipped).reduce((a, b) => a + b, 0), total);
  assert.equal(Object.values(staffDB).flat().length > 0, true);
  assert.equal(
    loadReport.warnings.find(w => w.startsWith('Пропущено')),
    'Пропущено 7 из 10 смен: чужой отдел — 2, отменены — 1, ресурса нет в справочнике — 2, нечитаемая дата — 2',
  );
});

test('load report: duplicate ids keep the first, bad dates and backwards intervals are skipped', () => {
  const { tasks, loadReport } = parse({
    orders: [
      order('o1', '2026-09-20T05:00:00Z', '2026-09-20T06:00:00Z'),
      order('o1', '2026-09-20T07:00:00Z', '2026-09-20T08:00:00Z'),   // repeated id, different times
      order('o2', '20.09.2026 10:00', '2026-09-20T11:00:00Z'),       // unreadable start
      order('o3', '2026-09-20T10:00:00Z', ''),                       // empty end
      order('o4', '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z'),   // end == start
      order('o5', '2026-09-20T11:00:00Z', '2026-09-20T10:00:00Z'),   // end < start
      order('o6', '2026-09-20T12:00:00Z', '2026-09-20T13:00:00Z'),
      order('o6', 'garbage', 'garbage'),                             // bad AND repeated: counts as bad
    ],
  });
  assert.deepEqual(tasks.map(t => t.id), ['o1', 'o6']);
  assert.equal(tasks[0].start.toISOString(), '2026-09-20T05:00:00.000Z'); // the first o1 stayed
  assert.deepEqual(loadReport.orders, {
    total: 8, used: 2, skipped: { badDates: 5, duplicateIds: 1, noId: 0 },
  });
  assert.ok(loadReport.warnings.includes(
    'Пропущено 6 из 8 задач: нечитаемая дата или конец не позже начала — 5, повтор id — 1',
  ));
});

test('load report: a clean load reports nothing skipped and no warnings', () => {
  const { loadReport } = parse({
    orders: [order('o1', '2026-09-20T05:00:00Z', '2026-09-20T06:00:00Z')],
    shifts: [shift(1, 'spo1')],
  });
  assert.deepEqual(loadReport.orders.skipped, { badDates: 0, duplicateIds: 0, noId: 0 });
  assert.deepEqual(loadReport.warnings, []);
});

test('load report: big counts are written with spaces, a shift that ends before it starts is flagged', () => {
  const rows = Array.from({ length: 1481 }, (_, i) => shift(i + 1, 'aud1', { department_ref: 'АУДИТ' }));
  const { loadReport, staffDB } = parse({
    shifts: [...rows, shift(9999, 'spo1', { scheduled_end: '2026-09-20T04:00:00Z' })],
  });
  assert.ok(loadReport.warnings.includes('Пропущено 1 481 из 1 482 смен: чужой отдел — 1 481'));
  assert.equal(loadReport.shifts.badIntervals, 1);
  assert.ok(loadReport.warnings.some(w => w.startsWith('Смен, где конец не позже начала: 1')));
  assert.equal(loadReport.shifts.used, 1); // still kept as recorded, only reported
  assert.ok(staffDB['2026-09-20']);
});

test('empty files are warnings, not errors', () => {
  const { loadReport, tasks } = parse({ resQual: [], orders: undefined, shifts: [] });
  assert.equal(tasks.length, 0);
  assert.ok(loadReport.warnings.some(w => w.includes('«tb_res_qual» пуст')));
  assert.ok(loadReport.warnings.some(w => w.includes('«tb_sub_orders» пуст')));
  assert.ok(loadReport.warnings.some(w => w.includes('«tb_shifts» пуст')));
  const csv = parseCsvCollections({});
  assert.equal(csv.tasks.length, 0);
  assert.equal(csv.loadReport.warnings.length, 6);
});

test('a required-qualification string in the JSON path is split, not erased', () => {
  const { tasks } = parse({
    orders: [order('o1', '2026-09-20T05:00:00Z', '2026-09-20T06:00:00Z', { req_qual_vector: 'SPO_A, SPO_B' })],
  });
  assert.deepEqual(tasks[0].reqTypes, ['SPO_A', 'SPO_B']);
});

// ── file schema ─────────────────────────────────────────────────────────────

const csv = (header, ...rows) => [header, ...rows].join('\r\n');
const ORDERS_CSV = csv('_id,start_time,end_time,req_qual_vector', 'o1,2026-09-20T05:00:00Z,2026-09-20T06:00:00Z,SPO_A');
const SHIFTS_CSV = csv('_id,resource_ref,department_ref,scheduled_start,scheduled_end', '1,spo1,SPO,2026-09-20T05:00:00Z,2026-09-20T17:00:00Z');
const RES_CSV = csv('internal_id,name,default_department_ref', 'spo1,SPO One,SPO');
const QUAL_CSV = csv('_id,internal_id,name', 'q-a,A,SPO_A');
const RQ_CSV = csv('_id,internal_id,qualification_ref,resource_ref', 'r1,x,A,spo1');
const SQ_CSV = csv('_id,qualification_ref,shift_ref', 's1,q-a,1');
const slots = {
  ordersCsv: ORDERS_CSV, shiftsCsv: SHIFTS_CSV, resourcesCsv: RES_CSV,
  resQualCsv: QUAL_CSV, resourceQualificationsCsv: RQ_CSV, shiftQualificationsCsv: SQ_CSV,
};

test('schema: the six right files load', () => {
  const r = parseCsvCollections(slots);
  assert.equal(r.tasks.length, 1);
  assert.deepEqual(r.staffDB['2026-09-20'][0].quals.sort(), ['SPO_A']);
  assert.deepEqual(r.loadReport.warnings, []);
});

test('schema: a file in the wrong slot is refused with the missing columns named', () => {
  assert.throws(
    () => parseCsvCollections({ ...slots, shiftsCsv: ORDERS_CSV }),
    { message: 'Файл «tb_shifts»: нет колонок resource_ref, scheduled_start, scheduled_end — похоже, загружен не тот файл (по колонкам это «tb_sub_orders»)' },
  );
  assert.throws(() => parseCsvCollections({ ...slots, ordersCsv: SHIFTS_CSV }), /Файл «tb_sub_orders»: нет колонок start_time, end_time, req_qual_vector/);
  // the two relation tables swapped
  assert.throws(() => parseCsvCollections({ ...slots, resourceQualificationsCsv: SQ_CSV }), /Файл «tb_relation_resource_qualification»: нет колонок resource_ref/);
  assert.throws(() => parseCsvCollections({ ...slots, shiftQualificationsCsv: RQ_CSV }), /Файл «tb_relation_shift_qualification»: нет колонок shift_ref/);
  // the dictionary in the resources slot and the other way round
  assert.throws(() => parseCsvCollections({ ...slots, resourcesCsv: QUAL_CSV }), /Файл «tb_resources»: нет колонок default_department_ref/);
  assert.throws(() => parseCsvCollections({ ...slots, resQualCsv: RES_CSV }), /Файл «tb_res_qual»: есть колонки другой таблицы \(default_department_ref\)/);
  assert.throws(() => parseCsvCollections({ ...slots, resQualCsv: RQ_CSV }), /Файл «tb_res_qual»: нет колонок name; есть колонки другой таблицы/);
});

test('schema: a header-only file still has its columns checked; the JSON path checks too', () => {
  assert.throws(() => parseCsvCollections({ ...slots, shiftsCsv: '_id,start_time,end_time,req_qual_vector' }), /Файл «tb_shifts»/);
  assert.throws(
    () => parseJsonExport({ orders: [{ id: 1, from: 'x', to: 'y' }] }),
    /Файл «tb_sub_orders»: нет колонок _id, start_time, end_time, req_qual_vector/,
  );
  // JSON rows may leave null fields out: a column counts if any row has it
  const ok = parse({ shifts: [{ _id: 1, resource_ref: 'spo1' }, { scheduled_start: '2026-09-20T05:00:00Z', scheduled_end: '2026-09-20T17:00:00Z' }] });
  assert.equal(ok.loadReport.shifts.total, 2);
});

// ── CRLF, BOM, header quirks ────────────────────────────────────────────────

test('CRLF line ends, a BOM and padded header cells read correctly', () => {
  const bom = '﻿';
  const r = parseCsvCollections({
    ordersCsv: bom + csv('_id ,start_time,end_time, req_qual_vector ,\ttime_fixate', 'o1,2026-09-20T05:00:00Z,2026-09-20T06:00:00Z,SPO_A,', '', 'o2,2026-09-20T07:00:00Z,2026-09-20T08:00:00Z,SPO_A,') + '\r\n',
    shiftsCsv: bom + SHIFTS_CSV,
    resourcesCsv: bom + RES_CSV,
    resQualCsv: bom + QUAL_CSV,
    resourceQualificationsCsv: bom + RQ_CSV,
    shiftQualificationsCsv: bom + SQ_CSV,
  });
  assert.deepEqual(r.tasks.map(t => t.id), ['o1', 'o2']);  // "_id " no longer leaves ids undefined
  assert.deepEqual(r.tasks[0].reqTypes, ['SPO_A']);
  assert.equal(r.loadReport.orders.used, 2);
  assert.equal(r.loadReport.shifts.used, 1);
});

// ── timezone: the day is the Moscow day ─────────────────────────────────────

test('a task belongs to the Moscow day it starts in, whatever the process timezone', () => {
  const { tasks } = parse({
    orders: [
      order('late', '2026-09-20T20:59:00Z', '2026-09-20T21:30:00Z'),   // 23:59 Moscow, 20.09
      order('after', '2026-09-20T21:00:00Z', '2026-09-20T22:00:00Z'),  // 00:00 Moscow, 21.09
      order('early', '2026-09-20T00:30:00Z', '2026-09-20T01:00:00Z'),  // 03:30 Moscow, 20.09
      order('zoned', '2026-09-20T23:30:00+03:00', '2026-09-21T00:30:00+03:00'),
      order('bare', '2026-09-20T23:30:00', '2026-09-21T00:30:00'),     // no zone = Moscow wall-clock
      order('barespace', '2026-09-21 00:10', '2026-09-21 00:40'),
    ],
  });
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  assert.equal(byId.late.date, '2026-09-20');
  assert.equal(byId.after.date, '2026-09-21');
  assert.equal(byId.early.date, '2026-09-20');
  assert.equal(byId.zoned.date, '2026-09-20');
  assert.equal(byId.bare.date, '2026-09-20');
  assert.equal(byId.bare.start.toISOString(), '2026-09-20T20:30:00.000Z');
  assert.equal(byId.barespace.date, '2026-09-21');
  assert.equal(byId.barespace.start.toISOString(), '2026-09-20T21:10:00.000Z');
});

test('a shift across Moscow midnight lands in every Moscow day it overlaps', () => {
  const { staffDB } = parse({
    shifts: [
      shift(1, 'spo1', { scheduled_start: '2026-09-20T19:00:00Z', scheduled_end: '2026-09-21T05:00:00Z' }), // 22:00 -> 08:00
      shift(2, 'spo2', { scheduled_start: '2026-09-20T05:00:00Z', scheduled_end: '2026-09-20T17:00:00Z' }), // 08:00 -> 20:00
      shift(3, 'spo2', { scheduled_start: '2026-09-21T20:00:00Z', scheduled_end: '2026-09-21T21:00:00Z' }), // ends exactly at Moscow midnight
    ],
  });
  assert.deepEqual(Object.keys(staffDB).sort(), ['2026-09-20', '2026-09-21', '2026-09-22']);
  assert.deepEqual(staffDB['2026-09-20'].map(s => s.name).sort(), ['SPO One', 'SPO Two']);
  assert.deepEqual(staffDB['2026-09-21'].map(s => s.name).sort(), ['SPO One', 'SPO Two']);
  assert.deepEqual(staffDB['2026-09-22'].map(s => s.name), ['SPO Two']);
});

test('legacy CSV: "DD.MM.YY HH:MM" is Moscow time', () => {
  const text = csv(
    'Дата рейса,Номер рейса,Начало задач,Окончание задач,Фамилия,ИО,Описание,Примечание,POS',
    '20.09.26,SU1,21.09.26 00:30,21.09.26 01:00,Иванов,И.И.,Посадка,SV,A1',
    '20.09.26,SU2,20.09.26 23:00,21.09.26 02:00,Иванов,И.И.,Уборка,GH,A2',
  );
  const { tasks, staffDB } = parseCSV(text);
  assert.equal(tasks[0].start.toISOString(), '2026-09-20T21:30:00.000Z');
  assert.equal(tasks[0].date, '2026-09-21');
  assert.equal(tasks[1].date, '2026-09-20');
  // the inferred shift (22:00 -> 03:00) is in both Moscow days
  assert.deepEqual(Object.keys(staffDB).sort(), ['2026-09-20', '2026-09-21']);
});

test('the same input gives the same days under UTC, Moscow and Los Angeles', () => {
  const script = `
    import { parseJsonExport } from ${JSON.stringify(PARSER_URL)};
    const orders = [], shifts = [];
    for (let i = 0; i < 96; i++) {
      const s = Date.UTC(2026, 8, 19, 12) + i * 40 * 60000;
      orders.push({ _id: 'o' + i, start_time: new Date(s).toISOString(), end_time: new Date(s + 25 * 60000).toISOString(), req_qual_vector: ['Q'] });
      if (i % 8 === 0) shifts.push({ _id: i, resource_ref: 'r', department_ref: 'SPO', scheduled_start: new Date(s).toISOString(), scheduled_end: new Date(s + 11 * 3600000).toISOString() });
    }
    orders.push({ _id: 'bare', start_time: '2026-09-20T23:30:00', end_time: '2026-09-21T00:00:00' });
    const r = parseJsonExport({ orders, shifts, resources: [{ internal_id: 'r', name: 'R', default_department_ref: 'SPO' }] });
    const days = {}; for (const t of r.tasks) days[t.date] = (days[t.date] || 0) + 1;
    const staff = {}; for (const [d, l] of Object.entries(r.staffDB)) staff[d] = l.length;
    console.log(JSON.stringify({ days, staff, first: r.tasks[0].start.toISOString() }));
  `;
  const run = tz => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  }));
  const msk = run('Europe/Moscow');
  assert.ok(Object.keys(msk.days).length >= 2 && Object.keys(msk.staff).length >= 2);
  assert.deepEqual(run('UTC'), msk);
  assert.deepEqual(run('America/Los_Angeles'), msk);
  assert.deepEqual(run('Asia/Kolkata'), msk);
});
