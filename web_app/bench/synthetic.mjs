// Synthetic data for the benchmark: the same SHAPE as the real exports (qualification mix,
// shifts across midnight, stands on a small walking network, a qualification nobody holds,
// a few absurdly long tasks), none of their content. Everything comes from one seed, so
// the same options give the same data on every machine; every date is a Moscow date
// built through utils/tz.js, so the process timezone does not matter.
//
//   generate({ seed, days, people, tasksPerDay })   -> data for the optimizer
//   toCsvFiles(data)                                -> the six CSV files (+ stands) as strings
//
// Change anything that changes the numbers => bump GENERATOR_VERSION: the stored baseline
// carries it, and a baseline of another version is refused instead of compared.
import { dayStart, addDays, dayKey } from '../src/utils/tz.js';
import { createDistanceResolver } from '../src/utils/travelGraph.js';

export const GENERATOR_VERSION = 1;
export const OPEN = 'Не назначено';
export const START_DATE = '2026-03-10';

// Share of tasks by required qualification (single-qualification tasks, as in the real files).
export const QUAL_SHARE = [
  ['SPO_B-737NG', 0.38], ['SPO_A-320', 0.20], ['SPO_SSJ', 0.09], ['SPO_B-737CL', 0.04],
  ['SPO_A-330', 0.03], ['SPO_SV', 0.25], ['SPO_CRJ', 0.01],
];
// How likely a person holds each aircraft-type qualification. Nobody holds SPO_CRJ.
const HOLD = { 'SPO_B-737NG': 0.55, 'SPO_A-320': 0.40, 'SPO_SSJ': 0.25, 'SPO_B-737CL': 0.15, 'SPO_A-330': 0.10 };
const SV_HOLDERS = 0.30;
// How many aircraft-type qualifications a person has (0..8 in all with SV counted by the roll above).
const COUNT_WEIGHTS = [[0, 3], [1, 20], [2, 22], [3, 20], [4, 15], [5, 10], [6, 5], [7, 3], [8, 2]];
const SHIFT_TYPES = [
  { code: 'day', from: 10, hours: 13, share: 0.45 },     // 10:00-23:00
  { code: 'early', from: 8, hours: 9, share: 0.25 },     // 08:00-17:00
  { code: 'night', from: 20, hours: 13, share: 0.30 },   // 20:00-09:00 next day
];
const HOUR_WEIGHT = [0.6, 0.5, 0.5, 0.5, 0.6, 0.9, 1.5, 1.7, 1.6, 1.4, 1.1, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.4, 1.6, 1.6, 1.5, 1.4, 1.1, 0.8];
const DURATIONS = [[10, 8], [15, 10], [20, 10], [30, 25], [45, 15], [60, 18], [90, 8], [120, 4], [180, 2]];

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
const weighted = (rnd, pairs) => {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let x = rnd() * total;
  for (const [v, w] of pairs) { if ((x -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
};

const at = (ymd, h, m = 0) => new Date(dayStart(ymd).getTime() + (h * 60 + m) * 60000);
const pad = (n, w = 2) => String(n).padStart(w, '0');

// ── Stands and the walking network ──────────────────────────────────────────
// 54 stands P01..P54, two to a node on a 6x5 grid (nodes n0..n26), 'HUB' (where shifts start)
// at the corner, 6 stands P55..P60 missing from the location table (as in the real one).
// With `island`, P53 and P54 sit on a node without any edge.
export function makeNetwork(rnd, { island = false } = {}) {
  const stands = Array.from({ length: 60 }, (_, i) => 'P' + pad(i + 1));
  const locations = [{ internal_id: 'HUB', node_ref: 'nH' }];
  const nodeOf = i => (island && i >= 52 ? 'nI' : 'n' + Math.floor(i / 2));
  for (let i = 0; i < 54; i++) locations.push({ internal_id: stands[i], node_ref: nodeOf(i) });
  const travelEdges = [];
  const edge = (a, b) => travelEdges.push({ 'Start node': a, 'End node': b, Distance: 80 + Math.floor(rnd() * 74) * 5 });
  const cols = 6;
  const nodes = 27;
  for (let n = 0; n < nodes; n++) {
    if (n % cols < cols - 1 && n + 1 < nodes) edge('n' + n, 'n' + (n + 1));
    if (n + cols < nodes) edge('n' + n, 'n' + (n + cols));
  }
  edge('nH', 'n0');
  return { stands, locations, travelEdges, resolver: createDistanceResolver({ locations, travelEdges }) };
}

// ── The roster ──────────────────────────────────────────────────────────────
function makeRoster(rnd, size) {
  const types = Object.keys(HOLD);
  return Array.from({ length: size }, (_, i) => {
    const k = weighted(rnd, COUNT_WEIGHTS);
    const quals = [];
    const pool = types.map(t => [t, HOLD[t]]);
    for (let j = 0; j < k && pool.length > 0; j++) {
      const t = weighted(rnd, pool);
      quals.push(t);
      pool.splice(pool.findIndex(([x]) => x === t), 1);
    }
    if (rnd() < SV_HOLDERS) quals.push('SPO_SV');
    return {
      name: 'Person ' + pad(i + 1, 3), id: 'r' + pad(i + 1, 3), quals,
      shiftType: weighted(rnd, SHIFT_TYPES.map(s => [s, s.share])),
    };
  });
}

// ── Tasks of one day ────────────────────────────────────────────────────────
function makeDayTasks(rnd, ymd, dayIdx, count, stands, multiQualShare, anomalyShare) {
  const tasks = [];
  const typeShare = QUAL_SHARE.filter(([q]) => q !== 'SPO_SV');
  const svShare = QUAL_SHARE.find(([q]) => q === 'SPO_SV')[1];
  const hourPairs = HOUR_WEIGHT.map((w, h) => [h, w]);
  let flightNo = 0;
  while (tasks.length < count) {
    flightNo++;
    const hour = weighted(rnd, hourPairs);
    const t0 = hour * 60 + Math.floor(rnd() * 12) * 5;
    const stand = stands[Math.floor(Math.pow(rnd(), 1.4) * stands.length)];
    const type = weighted(rnd, typeShare);
    const nTasks = 1 + Math.floor(rnd() * 3.2);
    for (let j = 0; j < nTasks && tasks.length < count; j++) {
      const startMin = t0 + Math.floor(rnd() * 13) * 5;
      let dur = weighted(rnd, DURATIONS);
      if (rnd() < anomalyShare) dur = (13 + Math.floor(rnd() * 28)) * 60;
      const qual = rnd() < svShare / (1 - 0.01) ? 'SPO_SV' : type;
      const quals = [qual];
      if (rnd() < multiQualShare) {
        const other = qual === 'SPO_SV' ? 'SPO_B-737NG' : 'SPO_SV';
        quals.push(other);
      }
      const start = at(ymd, 0, startMin);
      const end = new Date(start.getTime() + dur * 60000);
      const near = () => stands[Math.min(stands.length - 1, Math.max(0, stands.indexOf(stand) + (rnd() < 0.5 ? -1 : 1)))];
      tasks.push({
        id: `T${pad(dayIdx, 2)}-${pad(tasks.length + 1, 4)}`,
        date: dayKey(start), name: `OP_${type.slice(4)}_${j + 1}`, flight: 'FL' + pad(dayIdx, 2) + pad(flightNo, 4),
        pos: stand, entryPos: rnd() < 0.15 ? near() : stand, exitPos: rnd() < 0.15 ? near() : stand,
        zone: 'APRON', baseStart: new Date(start), baseEnd: new Date(end), start, end,
        duration: dur, color: '#888888', reqType: quals.join(' + '), reqTypes: quals,
        employee: OPEN, isLocked: false,
      });
    }
  }
  return tasks;
}

// ── Everything ──────────────────────────────────────────────────────────────
// options: seed (1), days (3: the days that are measured), people (100: on shift on a day),
// tasksMin/tasksMax (400/700 a day), startDate, island (false), multiQualShare (0.02),
// anomalyShare (0.01: tasks longer than 12 h).
// The data covers one day before the first and one after the last measured day too, so every
// measured day has its neighbours (the planning window is the day and one day each side).
export function generate(options = {}) {
  const {
    seed = 1, days = 3, people = 100, tasksMin = 400, tasksMax = 700, startDate = START_DATE,
    island = false, multiQualShare = 0.02, anomalyShare = 0.01,
  } = options;
  const rnd = rng(seed * 7919 + 17);
  const net = makeNetwork(rnd, { island });
  const rosterSize = Math.round(people / 0.62);
  const roster = makeRoster(rnd, rosterSize);

  const allDates = [];
  for (let d = -1; d <= days; d++) allDates.push(addDays(startDate, d));
  const dates = allDates.slice(1, 1 + days);

  const staffDB = {};
  const tasks = [];
  let shiftId = 0;
  allDates.forEach((ymd, dayIdx) => {
    for (const p of roster) {
      if (rnd() >= 0.62) continue;
      const type = rnd() < 0.85 ? p.shiftType : weighted(rnd, SHIFT_TYPES.map(s => [s, s.share]));
      const shiftStart = at(ymd, type.from);
      const shiftEnd = new Date(shiftStart.getTime() + type.hours * 3600000);
      const shift = { name: p.name, quals: [...p.quals], zone: 'APRON', shiftStart, shiftEnd, basePos: 'HUB', shiftId: ++shiftId, resource: p.id };
      for (let k = dayKey(shiftStart); k <= dayKey(shiftEnd); k = addDays(k, 1)) (staffDB[k] ??= []).push(shift);
    }
    const count = tasksMin + Math.floor(rnd() * (tasksMax - tasksMin + 1));
    tasks.push(...makeDayTasks(rnd, ymd, dayIdx, count, net.stands.slice(0, 60), multiQualShare, anomalyShare));
  });
  return {
    meta: { generator: GENERATOR_VERSION, seed, days, people, tasksMin, tasksMax, startDate, island, multiQualShare, anomalyShare },
    dates, allDates, tasks, staffDB, roster, ...net,
  };
}

// ── CSV (what the page loads) ───────────────────────────────────────────────
const MSK = ms => {
  const d = new Date(ms + 3 * 3600000).toISOString();            // Moscow wall clock
  return d.slice(0, 19) + '+03:00';
};
const csvCell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (cols, rows) => [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';

// The six files of "Загрузить CSV вручную" plus the stand table (tb_locations) and the walking
// network as CSV. Qualifications are recorded on the person (tb_relation_resource_qualification);
// the shift-qualification file carries one row so that it is not empty.
export function toCsvFiles(data, { dates } = {}) {
  const use = dates ? new Set(dates) : null;
  const tasks = use ? data.tasks.filter(t => use.has(t.date)) : data.tasks;
  const orders = tasks.map(t => ({
    _id: t.id, start_time: MSK(t.start.getTime()), end_time: MSK(t.end.getTime()), req_qual_vector: t.reqTypes.join(','),
    flight_event_ref: t.name, flight_ref: t.flight, start_loc_ref: t.pos, dest_loc_ref: t.pos,
    setup_loc_ref: t.entryPos, clearup_loc_ref: t.exitPos, order_state_ref: 'PLANNED',
  }));
  const seen = new Set();
  const shifts = [];
  for (const list of Object.values(data.staffDB)) for (const s of list) {
    if (seen.has(s.shiftId)) continue;
    seen.add(s.shiftId);
    if (use && ![...use].some(d => d >= dayKey(s.shiftStart) && d <= dayKey(s.shiftEnd))) continue;
    shifts.push({
      _id: s.shiftId, resource_ref: s.resource, department_ref: 'SPO', shift_state_ref: 'SCHEDULED',
      scheduled_start: MSK(s.shiftStart.getTime()), scheduled_end: MSK(s.shiftEnd.getTime()), location_ref: s.basePos,
    });
  }
  const quals = [...new Set(QUAL_SHARE.map(([q]) => q))];
  const qualId = q => 'q_' + q.replace(/[^A-Za-z0-9]/g, '');
  return {
    'tb_sub_orders.csv': toCsv(['_id', 'start_time', 'end_time', 'req_qual_vector', 'flight_event_ref', 'flight_ref', 'start_loc_ref', 'dest_loc_ref', 'setup_loc_ref', 'clearup_loc_ref', 'order_state_ref'], orders),
    'tb_shifts.csv': toCsv(['_id', 'resource_ref', 'department_ref', 'shift_state_ref', 'scheduled_start', 'scheduled_end', 'location_ref'], shifts),
    'tb_resources.csv': toCsv(['internal_id', 'name', 'additional_name', 'default_department_ref'],
      data.roster.map(p => ({ internal_id: p.id, name: p.id, additional_name: p.name, default_department_ref: 'SPO' }))),
    'tb_res_qual.csv': toCsv(['_id', 'internal_id', 'name'], quals.map(q => ({ _id: qualId(q), internal_id: qualId(q).slice(2), name: q }))),
    'tb_relation_resource_qualification.csv': toCsv(['resource_ref', 'qualification_ref'],
      data.roster.flatMap(p => p.quals.map(q => ({ resource_ref: p.id, qualification_ref: qualId(q).slice(2) })))),
    'tb_relation_shift_qualification.csv': toCsv(['shift_ref', 'qualification_ref'],
      [{ shift_ref: shifts[0]?._id ?? 1, qualification_ref: qualId('SPO_SV').slice(2) }]),
    'tb_locations.csv': toCsv(['internal_id', 'node_ref'], data.locations),
    'travel_network.csv': toCsv(['Start node', 'End node', 'Distance'], data.travelEdges.map(e => e)),
  };
}
