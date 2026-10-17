import Papa from 'papaparse';
import { dayKey, daysBetween, TZ_OFFSET_MS } from './tz.js';
export { getPosDistance } from './posDistance.js';

const COLOR_PALETTE = [
  '#1F77B4', '#9467BD', '#FF9900', '#E6A800', '#2CA02C',
  '#D62728', '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF',
];

const TERMINAL_KEYWORDS = ['вокзал', 'терминал', 'посадка', 'baggage', 'регистрация', 'terminal'];

// Wall-clock time without a zone is Moscow time (the operating timezone, see
// tz.js), never the timezone of whatever process runs this code.
function moscowWallClock(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  return new Date(Date.UTC(y, mo, d, h, mi, s, ms) - TZ_OFFSET_MS);
}

function parseDateTime(s) {
  if (!s || !s.trim()) return null;
  const str = s.trim();
  // "DD.MM.YY HH:MM" or "DD.MM.YYYY HH:MM"
  const spaceIdx = str.indexOf(' ');
  if (spaceIdx < 0) return null;
  const datePart = str.slice(0, spaceIdx);
  const timePart = str.slice(spaceIdx + 1);
  const dateSplit = datePart.split('.');
  const timeSplit = timePart.split(':');
  if (dateSplit.length < 3 || timeSplit.length < 2) return null;
  const day = parseInt(dateSplit[0], 10);
  const month = parseInt(dateSplit[1], 10) - 1;
  let year = parseInt(dateSplit[2], 10);
  if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
  const hours = parseInt(timeSplit[0], 10);
  const minutes = parseInt(timeSplit[1], 10);
  const d = moscowWallClock(year, month, day, hours, minutes);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A moment from an export field: ISO with a zone ("...Z", "+03:00") as is;
// ISO date-time with NO zone is Moscow wall-clock time (not the process's);
// anything unreadable (empty, "20.09.2026 10:00", NaN) gives null.
const ZONELESS_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?$/;
function parseInstant(v) {
  if (!v) return null;
  let d;
  if (v instanceof Date) {
    d = new Date(v.getTime());
  } else if (typeof v === 'string') {
    const str = v.trim();
    const m = ZONELESS_ISO.exec(str);
    d = m
      ? moscowWallClock(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0')))
      : new Date(str);
  } else {
    d = new Date(v);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

function inferQual(notes) {
  if (!notes || !notes.trim()) return 'GH';
  const n = notes.trim();
  if (/^\d+$/.test(n)) return 'SV';
  if (n.includes('SV')) return 'SV';
  if (n.includes('GH')) return 'GH';
  if (/\d/.test(n)) return 'SV';
  return 'GH';
}

export function parseCSV(csvText) {
  // Some exports prepend several metadata rows before the actual column-header row.
  // Find the first line that looks like the real header (contains key column names).
  const lines = csvText.split(/\r?\n/);
  let headerIdx = lines.findIndex(
    l => l.includes('Дата рейса') && l.includes('Начало задач')
  );
  if (headerIdx < 0) {
    // Fallback: also accept a line with just the most critical column
    headerIdx = lines.findIndex(l => l.includes('Начало задач'));
  }
  const cleanedText = headerIdx > 0
    ? lines.slice(headerIdx).join('\n')
    : csvText;

  const result = Papa.parse(cleanedText, {
    header: true,
    skipEmptyLines: true,
    encoding: 'UTF-8',
  });

  const rows = result.data;
  const colorIndex = {};
  let colorCounter = 0;

  const tasks = [];
  let taskIdCounter = 1000;

  for (const row of rows) {
    const rawLastName = (row['Фамилия'] || '').trim();
    const initials = (row['ИО'] || '').trim();
    const lastName = rawLastName.split('/')[0].trim();
    const fio = lastName && initials ? `${lastName} ${initials}` : (lastName || initials || 'Неизвестно');

    const startRaw = row['Начало задач'] || '';
    const endRaw = row['Окончание задач'] || '';
    const start = parseDateTime(startRaw);
    const end = parseDateTime(endRaw);
    if (!start || !end) continue;

    const description = (row['Описание'] || '').trim() || (row['Тип задачи'] || '').trim();
    const notes = (row['Примечание'] || '').trim();
    const flightNumber = (row['Номер рейса'] || '').trim() || 'Рейс не указ.';
    const pos = (row['POS'] || '').trim() || 'ПЕРРОН';

    // Use start-time date (matches original Python app behaviour:
    // a task starting at 00:02 on May 4th belongs to May 4th even if
    // "Дата рейса" says May 3rd)
    const taskDate = dayKey(start);

    // Zone
    const descLower = description.toLowerCase();
    const zone = TERMINAL_KEYWORDS.some(k => descLower.includes(k)) ? 'TERMINAL' : 'APRON';

    // reqType
    const reqTypes = [inferQual(notes)];
    const reqType = reqTypes.join(' + ');

    // Color
    if (!(description in colorIndex)) {
      colorIndex[description] = COLOR_PALETTE[colorCounter % COLOR_PALETTE.length];
      colorCounter++;
    }
    const color = colorIndex[description];

    const duration = Math.round((end - start) / 60000);

    tasks.push({
      id: `T-${taskIdCounter++}`,
      date: taskDate,
      name: description,
      flight: flightNumber,
      pos,
      // This CSV format only ever carries one POS column — no separate
      // setup/clearup segments to distinguish entry from exit.
      entryPos: pos,
      exitPos: pos,
      zone,
      baseStart: new Date(start),
      baseEnd: new Date(end),
      start: new Date(start),
      end: new Date(end),
      duration,
      color,
      reqType,
      reqTypes,
      employee: fio,
      isLocked: false,
    });
  }

  // Build staffDB by inferring shifts from task history
  // Group all tasks by employee name
  const byEmployee = {};
  for (const t of tasks) {
    if (!byEmployee[t.employee]) byEmployee[t.employee] = [];
    byEmployee[t.employee].push(t);
  }

  const staffDB = {};

  for (const [empName, empTasks] of Object.entries(byEmployee)) {
    // Sort by start
    const sorted = [...empTasks].sort((a, b) => a.start - b.start);

    // Cluster into shifts: gap > 6 hours → new shift
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const shifts = [];
    let currentShift = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = currentShift[currentShift.length - 1].end;
      const gap = sorted[i].start - prevEnd;
      if (gap > SIX_HOURS) {
        shifts.push(currentShift);
        currentShift = [sorted[i]];
      } else {
        currentShift.push(sorted[i]);
      }
    }
    shifts.push(currentShift);

    for (const shift of shifts) {
      const starts = shift.map(t => t.start);
      const ends = shift.map(t => t.end);
      const minStart = new Date(Math.min(...starts) - 60 * 60 * 1000);
      const maxEnd = new Date(Math.max(...ends) + 60 * 60 * 1000);
      const quals = [...new Set(shift.flatMap(t => t.reqTypes))];

      const staffMember = {
        name: empName,
        quals,
        zone: 'APRON',
        shiftStart: minStart,
        shiftEnd: maxEnd,
      };

      // Add to every Moscow day the shift spans
      for (const dateKey of daysBetween(dayKey(minStart), dayKey(maxEnd))) {
        if (!staffDB[dateKey]) staffDB[dateKey] = [];
        // Avoid duplicate (same name on same date from same shift window)
        const exists = staffDB[dateKey].some(s =>
          s.name === empName &&
          s.shiftStart.getTime() === minStart.getTime()
        );
        if (!exists) staffDB[dateKey].push(staffMember);
      }
    }
  }

  // Reset all task employees to "Не назначено" for optimizer
  for (const t of tasks) {
    t.employee = 'Не назначено';
    t.isLocked = false;
  }

  // Build color map
  const colorMap = {};
  for (const t of tasks) {
    colorMap[t.name] = t.color;
  }

  return { tasks, staffDB, colorMap };
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON export parser (tb_shifts / tb_resources / tb_res_qual /
// tb_relation_resource_qualification / tb_relation_shift_qualification /
// tb_sub_orders) — replaces parseCSV once the corporate system feeds the app
// directly.
//
// Qualification matching is a real id-based join, not string guessing:
//   tb_relation_resource_qualification.qualification_ref -> tb_res_qual.internal_id
//   tb_relation_shift_qualification.qualification_ref    -> tb_res_qual._id
//   tb_res_qual.name is the canonical SPO_-prefixed code, which is exactly what
//   tb_sub_orders.req_qual_vector already contains (confirmed: tb_sub_order_requirements
//   denormalizes req_resource_quals straight into the order, so no further hop
//   through tb_relation_requirement_qualification is needed on the task side).
//
// req_qual_vector can list MORE THAN ONE required qualification per task —
// eligibility is AND, not OR: a staff member/shift must hold every entry in
// the vector, not just one (see optimizer.js's hasAllQuals). Confirmed against
// a full real tb_sub_orders export: every record seen there happened to carry
// exactly one qualification, but the matching logic doesn't assume that.
//
// A shift's qualification set is the union of its resource's personal quals
// (tb_relation_resource_qualification) and the quals recorded against that
// specific shift instance (tb_relation_shift_qualification). This is a
// deliberate choice, not a confirmed rule — the meaning of
// tb_relation_shift_qualification's "not_manual" flag and of records with
// degree: null hasn't been clarified, so nothing is being excluded based on
// either field yet.
//
// tb_sub_orders.res_assigned_to_ref/shift_assigned_to_ref ARE deliberately
// ignored by parseOrders: a real export does carry them on a large share of
// records (confirmed — not an edge case), but that reflects the source
// system's own scheduling state, not a decision a dispatcher made inside
// this app. Every order always starts unassigned/unlocked here; a lock is
// only ever earned through this app's own manual assignment or optimizer
// run — otherwise the Gantt would show a pre-populated schedule before the
// optimizer is even clicked, and those pre-populated assignments would
// carry no actual conflict-checking guarantee.
//
// Still unresolved (flagged, not guessed): no flights reference table, so
// task.flight falls back to the raw flight_ref/outbound/inbound id; no
// human-readable name for flight_event_ref codes, so task.name uses the code
// as-is (confirmed acceptable for the demo — raw codes are fine).
//
// Location-based transition logic (getPosDistance / MIN_TRANSITION_POS_DIST
// in optimizer.js) already covers "prefer/require nearby locations" for the
// demo using the raw start_loc_ref/dest_loc_ref codes on each task — it does
// not yet join against tb_location. tb_location.node_ref groups genuinely
// adjacent stands (e.g. several MS_RD8 stands share one node), which is a
// more accurate proximity signal than the current letter+number heuristic;
// wiring that in is a deliberate next refinement, not done yet.
// ═══════════════════════════════════════════════════════════════════════════

function displayName(resource) {
  if (!resource) return null;
  return resource.additional_name || resource.name || resource.internal_id || null;
}

// Every join key below is run through String() on both the map and the
// lookup side. The JSON export gives tb_shifts._id as a number, while a CSV
// export of the same collection flattens it to a string — without this, a
// shift-qualification join silently returns nothing the moment one side of
// the join comes from CSV and the other from JSON.
function buildResourceMap(resources) {
  const map = new Map();
  for (const r of resources || []) {
    map.set(String(r.internal_id), r);
  }
  return map;
}

function buildQualDict(resQual) {
  const byId = new Map();
  const byInternalId = new Map();
  for (const q of resQual || []) {
    byId.set(String(q._id), q);
    byInternalId.set(String(q.internal_id), q);
  }
  return { byId, byInternalId };
}

// Resolves a qualification_ref (either a tb_res_qual._id or a tb_res_qual.internal_id,
// the two formats actually observed across the relation tables) to the canonical
// SPO_-prefixed code used everywhere else. Falls back to the raw ref if the
// dictionary doesn't contain it, rather than silently dropping the qualification.
function resolveQualCode(ref, qualDict) {
  if (!ref) return null;
  const key = String(ref);
  const rec = qualDict.byId.get(key) || qualDict.byInternalId.get(key);
  return rec ? rec.name : ref;
}

function buildResourceQualMap(resourceQualifications, qualDict) {
  const map = new Map();
  for (const rel of resourceQualifications || []) {
    const key = String(rel.resource_ref);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(resolveQualCode(rel.qualification_ref, qualDict));
  }
  return map;
}

function buildShiftQualMap(shiftQualifications, qualDict) {
  const map = new Map();
  for (const rel of shiftQualifications || []) {
    const key = String(rel.shift_ref);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(resolveQualCode(rel.qualification_ref, qualDict));
  }
  return map;
}

// "1 481" — a thousands separator that survives any locale/ICU build.
const fmtN = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// req_qual_vector arrives as an array (JSON) or as one cell (CSV: a scalar,
// comma/semicolon-joined when a task carries more than one qualification). A
// string in the JSON path used to turn into "no requirement" — which lets
// anyone take the task — so both paths split it the same way.
function qualVector(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v == null || v === '') return [];
  return String(v).split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

function parseOrders(orders) {
  const colorIndex = {};
  let colorCounter = 0;
  const tasks = [];
  const seen = new Set();
  const skipped = { badDates: 0, duplicateIds: 0, noId: 0 };

  for (const o of orders || []) {
    const start = parseInstant(o.start_time);
    const end = parseInstant(o.end_time);
    // An unreadable moment or an interval that does not run forward cannot be
    // planned (a "zombie" task: nothing fits it, nothing conflicts with it).
    if (!start || !end || !(end.getTime() > start.getTime())) { skipped.badDates++; continue; }
    // First occurrence of an id stays; the same id again is a repeated row.
    const idKey = o._id == null ? '' : String(o._id).trim();
    if (idKey === '') { skipped.noId++; continue; }
    if (seen.has(idKey)) { skipped.duplicateIds++; continue; }
    seen.add(idKey);

    const name = o.flight_event_ref || o.order_rule_ref || 'Задача';
    const reqTypes = qualVector(o.req_qual_vector);
    const reqType = reqTypes.join(' + ');
    // A task can have up to 4 location segments — entry (setup, high
    // priority) falling back to start, and exit (clearup, high priority)
    // falling back to dest. Confirmed against the corporate spec ("22.05.
    // Учет расстояний сети передвижения..."): this is exactly the pair the
    // real system uses to compute travel time to/from a task, not just
    // start_loc_ref alone. `pos` keeps the old start-based value for
    // display (POS tags, hover) since that's what a dispatcher expects to
    // see as "the task's stand"; entryPos/exitPos are what the optimizer's
    // travel-time logic actually uses.
    const entryPos = o.setup_loc_ref || o.start_loc_ref || 'ПЕРРОН';
    const exitPos = o.clearup_loc_ref || o.dest_loc_ref || 'ПЕРРОН';
    const pos = o.start_loc_ref || 'ПЕРРОН';
    const flight = o.flight_ref || o.outbound_flight_ref || o.inbound_flight_ref || 'Рейс не указ.';

    if (!(name in colorIndex)) {
      colorIndex[name] = COLOR_PALETTE[colorCounter % COLOR_PALETTE.length];
      colorCounter++;
    }

    // res_assigned_to_ref/shift_assigned_to_ref are deliberately ignored:
    // a real export does carry them (confirmed — ~2/3 of a real tb_sub_orders
    // batch had them set), but that reflects the source system's own
    // scheduling, not a decision made by a dispatcher inside this app. Every
    // order always starts unassigned/unlocked here; a lock is only ever
    // earned through this app's own manual assignment or optimizer run.
    const employee = 'Не назначено';
    const isLocked = false;

    tasks.push({
      id: o._id,
      date: dayKey(start),
      name,
      flight,
      pos,
      entryPos,
      exitPos,
      zone: 'APRON',
      baseStart: new Date(start),
      baseEnd: new Date(end),
      start: new Date(start),
      end: new Date(end),
      duration: Math.round((end - start) / 60000),
      color: colorIndex[name],
      reqType,
      reqTypes,
      employee,
      isLocked,
      setupDuration: o.setup_duration ?? null,
      clearupDuration: o.clearup_duration ?? null,
      shiftAssignedToRef: o.shift_assigned_to_ref || null,
    });
  }

  const total = (orders || []).length;
  return { tasks, report: { total, used: tasks.length, skipped } };
}

function parseShifts(shifts, resourceMap, resourceQualMap, shiftQualMap) {
  const staffDB = {};
  const skipped = { noResource: 0, otherDepartment: 0, cancelled: 0, badDates: 0 };
  let used = 0;
  let badIntervals = 0;

  for (const s of shifts || []) {
    const resource = resourceMap.get(String(s.resource_ref));
    if (!resource) { skipped.noResource++; continue; }
    // A cancelled shift is not capacity.
    if (String(s.shift_state_ref || '').toUpperCase() === 'CANCELED') { skipped.cancelled++; continue; }
    // The shift says which department the person works for that day: an SPO
    // employee on an audit shift is not in the SPO pool, someone lent from
    // another department onto an SPO shift is. The home department only
    // decides when the shift itself doesn't say (empty or '*'). Confirmed
    // against the full tb_shifts export: both mismatches occur.
    const shiftDept = s.department_ref && s.department_ref !== '*' ? s.department_ref : null;
    if ((shiftDept ?? resource.default_department_ref) !== 'SPO') { skipped.otherDepartment++; continue; }

    const shiftStart = parseInstant(s.scheduled_start);
    const shiftEnd = parseInstant(s.scheduled_end);
    if (!shiftStart || !shiftEnd) { skipped.badDates++; continue; }
    used++;
    // Kept as recorded (nothing fits it), but counted so it is visible.
    if (!(shiftEnd.getTime() > shiftStart.getTime())) badIntervals++;

    // Union of personal quals and quals recorded for this specific shift instance.
    const qualSet = new Set([
      ...(resourceQualMap.get(String(s.resource_ref)) || []),
      ...(shiftQualMap.get(String(s._id)) || []),
    ]);
    const quals = [...qualSet];

    const staffMember = {
      name: displayName(resource) || resource.internal_id,
      quals,
      zone: 'APRON',
      shiftStart,
      shiftEnd,
      // Per the corporate spec, the shift's own location_ref (not
      // default_location_ref) is what an employee's first task of the day
      // is measured against for travel time — confirmed against the real
      // export: every shift has location_ref '*', which is itself a real,
      // connected node in the travel network, not a placeholder to skip.
      basePos: s.location_ref || s.default_location_ref || null,
    };

    // The shift belongs to every Moscow day it overlaps (a night shift to
    // both), whatever the timezone of the process.
    for (const dateKey of daysBetween(dayKey(shiftStart), dayKey(shiftEnd))) {
      if (!staffDB[dateKey]) staffDB[dateKey] = [];
      const exists = staffDB[dateKey].some(m =>
        m.name === staffMember.name && m.shiftStart.getTime() === shiftStart.getTime()
      );
      if (!exists) staffDB[dateKey].push(staffMember);
    }
  }

  const total = (shifts || []).length;
  return { staffDB, report: { total, used, skipped, badIntervals } };
}

// Every SPO resource with their own held qualifications (tb_relation_resource_
// qualification), independent of whether they have a shift on any given
// date — this is the pool a dispatcher could call in on top of who's
// already scheduled. Separate from parseShifts' staffDB, which only lists
// people who already have a shift.
function buildFullRoster(resources, resourceQualMap) {
  return (resources || [])
    .filter(r => r.default_department_ref === 'SPO')
    .map(r => ({
      name: displayName(r) || r.internal_id,
      quals: [...(resourceQualMap.get(String(r.internal_id)) || [])],
    }));
}

// ── File schema ─────────────────────────────────────────────────────────────
// What each of the 6 files must carry, by what the code above reads. A file
// loaded into the wrong slot (shifts in three slots, res_qual swapped with
// resource_qualification...) used to load "fine" and produce a plan on junk;
// now it is refused with a message that says which columns are missing.
// An entry that is an array means "any one of these".
const SCHEMAS = {
  orders: { label: 'tb_sub_orders', need: ['_id', 'start_time', 'end_time', 'req_qual_vector'], empty: 'задач нет' },
  shifts: { label: 'tb_shifts', need: ['_id', 'resource_ref', 'scheduled_start', 'scheduled_end'], empty: 'смен нет, назначать некого' },
  resources: {
    label: 'tb_resources',
    need: ['internal_id', 'default_department_ref', ['name', 'additional_name']],
    empty: 'ни одна смена не будет учтена: сотрудников нет в справочнике',
  },
  resQual: {
    label: 'tb_res_qual',
    need: ['name', ['_id', 'internal_id']],
    // columns of other tables: tb_resources also has name/_id/internal_id
    foreign: ['default_department_ref', 'qualification_ref', 'resource_ref', 'shift_ref'],
    empty: 'справочник допусков пуст: допуски останутся «сырыми» ссылками, а не кодами',
  },
  resourceQualifications: {
    label: 'tb_relation_resource_qualification',
    need: ['resource_ref', 'qualification_ref'],
    empty: 'личных допусков у сотрудников нет',
  },
  shiftQualifications: {
    label: 'tb_relation_shift_qualification',
    need: ['shift_ref', 'qualification_ref'],
    empty: 'допусков, записанных на смены, нет',
  },
};
const SLOT_KEYS = Object.keys(SCHEMAS);

const missingColumns = (schema, cols) =>
  schema.need.filter(n => (Array.isArray(n) ? !n.some(c => cols.has(c)) : !cols.has(n)))
    .map(n => (Array.isArray(n) ? n.join(' или ') : n));
const foreignColumns = (schema, cols) => (schema.foreign || []).filter(c => cols.has(c));

function checkSchema(key, cols) {
  const schema = SCHEMAS[key];
  const missing = missingColumns(schema, cols);
  const foreign = foreignColumns(schema, cols);
  if (missing.length === 0 && foreign.length === 0) return;
  const lines = [];
  if (missing.length > 0) lines.push(`нет колонок ${missing.join(', ')}`);
  if (foreign.length > 0) lines.push(`есть колонки другой таблицы (${foreign.join(', ')})`);
  const other = SLOT_KEYS.find(k => k !== key && missingColumns(SCHEMAS[k], cols).length === 0 && foreignColumns(SCHEMAS[k], cols).length === 0);
  throw new Error(
    `Файл «${schema.label}»: ${lines.join('; ')} — похоже, загружен не тот файл` +
    (other ? ` (по колонкам это «${SCHEMAS[other].label}»)` : '')
  );
}

// JSON rows may omit null fields, so a column counts as present when any row
// has it. Stops reading as soon as every needed column is found.
function jsonColumns(rows, key) {
  const wanted = new Set(SCHEMAS[key].need.flat().concat(SCHEMAS[key].foreign || []));
  const cols = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const c of Object.keys(r)) cols.add(c.trim());
    if ([...wanted].every(c => cols.has(c))) break;
  }
  return cols;
}

// Shared by the JSON and CSV entry points: rows are already schema-checked.
function buildFromRows(rows, warnings) {
  for (const key of SLOT_KEYS) {
    if (rows[key].length === 0) warnings.push(`Файл «${SCHEMAS[key].label}» пуст — ${SCHEMAS[key].empty}`);
  }

  const resourceMap = buildResourceMap(rows.resources);
  const qualDict = buildQualDict(rows.resQual);
  const resourceQualMap = buildResourceQualMap(rows.resourceQualifications, qualDict);
  const shiftQualMap = buildShiftQualMap(rows.shiftQualifications, qualDict);

  const { tasks, report: ordersReport } = parseOrders(rows.orders);
  const { staffDB, report: shiftsReport } = parseShifts(rows.shifts, resourceMap, resourceQualMap, shiftQualMap);
  const fullRoster = buildFullRoster(rows.resources, resourceQualMap);

  const colorMap = {};
  for (const t of tasks) colorMap[t.name] = t.color;

  const so = ordersReport.skipped;
  const orderSkipped = so.badDates + so.duplicateIds + so.noId;
  if (orderSkipped > 0) {
    const parts = [];
    if (so.badDates > 0) parts.push(`нечитаемая дата или конец не позже начала — ${fmtN(so.badDates)}`);
    if (so.duplicateIds > 0) parts.push(`повтор id — ${fmtN(so.duplicateIds)}`);
    if (so.noId > 0) parts.push(`нет id — ${fmtN(so.noId)}`);
    warnings.push(`Пропущено ${fmtN(orderSkipped)} из ${fmtN(ordersReport.total)} задач: ${parts.join(', ')}`);
  }
  const ss = shiftsReport.skipped;
  const shiftSkipped = ss.noResource + ss.otherDepartment + ss.cancelled + ss.badDates;
  if (shiftSkipped > 0) {
    const parts = [];
    if (ss.otherDepartment > 0) parts.push(`чужой отдел — ${fmtN(ss.otherDepartment)}`);
    if (ss.cancelled > 0) parts.push(`отменены — ${fmtN(ss.cancelled)}`);
    if (ss.noResource > 0) parts.push(`ресурса нет в справочнике — ${fmtN(ss.noResource)}`);
    if (ss.badDates > 0) parts.push(`нечитаемая дата — ${fmtN(ss.badDates)}`);
    warnings.push(`Пропущено ${fmtN(shiftSkipped)} из ${fmtN(shiftsReport.total)} смен: ${parts.join(', ')}`);
  }
  if (shiftsReport.badIntervals > 0) {
    warnings.push(`Смен, где конец не позже начала: ${fmtN(shiftsReport.badIntervals)} — они никого не покрывают`);
  }
  if (shiftsReport.total > 0 && shiftsReport.used === 0) {
    warnings.push('Ни одна смена не попала в расчёт — проверьте файлы смен и ресурсов');
  }

  return { tasks, staffDB, colorMap, fullRoster, loadReport: { orders: ordersReport, shifts: shiftsReport, warnings } };
}

export function parseJsonExport({
  orders,
  shifts,
  resources,
  resQual,
  resourceQualifications,
  shiftQualifications,
}) {
  const given = { orders, shifts, resources, resQual, resourceQualifications, shiftQualifications };
  const rows = {};
  for (const key of SLOT_KEYS) {
    rows[key] = Array.isArray(given[key]) ? given[key] : [];
    if (rows[key].length > 0) checkSchema(key, jsonColumns(rows[key], key));
  }
  return buildFromRows(rows, []);
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV export of the same 6 collections (tb_sub_orders / tb_shifts /
// tb_resources / tb_res_qual / tb_relation_resource_qualification /
// tb_relation_shift_qualification) — the corporate system flattens each
// Mongo collection to a flat CSV with the exact same column names as its
// JSON export (confirmed against a real tb_sub_orders CSV export). Once
// parsed into row objects the shape matches what parseJsonExport already
// expects, with one flattening quirk to undo: req_qual_vector is a JSON
// array in the source data, but CSV can't hold an array in one cell, so it
// arrives as a single scalar column (comma/semicolon-joined if the export
// ever carries more than one qualification for a task) — see qualVector.
// ═══════════════════════════════════════════════════════════════════════════

// Rows plus the header's column names (a header-only file still has columns
// to check). Header cells are trimmed: a real export carries " time_fixate",
// and a stray space on "_id " used to leave every task without an id.
function csvTextToTable(text) {
  if (!text || !text.trim()) return { rows: [], fields: [] };
  const result = Papa.parse(text.replace(/^﻿/, '').trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  });
  return { rows: result.data, fields: result.meta.fields || [] };
}

export function parseCsvCollections({
  ordersCsv,
  shiftsCsv,
  resourcesCsv,
  resQualCsv,
  resourceQualificationsCsv,
  shiftQualificationsCsv,
}) {
  const given = {
    orders: ordersCsv,
    shifts: shiftsCsv,
    resources: resourcesCsv,
    resQual: resQualCsv,
    resourceQualifications: resourceQualificationsCsv,
    shiftQualifications: shiftQualificationsCsv,
  };
  const rows = {};
  for (const key of SLOT_KEYS) {
    const table = csvTextToTable(given[key]);
    rows[key] = table.rows;
    if (table.fields.length > 0) checkSchema(key, new Set(table.fields));
  }
  return buildFromRows(rows, []);
}
