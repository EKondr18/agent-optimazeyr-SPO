import Papa from 'papaparse';
export { getPosDistance } from './posDistance';

const COLOR_PALETTE = [
  '#1F77B4', '#9467BD', '#FF9900', '#E6A800', '#2CA02C',
  '#D62728', '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF',
];

const TERMINAL_KEYWORDS = ['вокзал', 'терминал', 'посадка', 'baggage', 'регистрация', 'terminal'];

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
  return new Date(year, month, day, hours, minutes, 0, 0);
}

function parseDateOnly(s) {
  if (!s || !s.trim()) return null;
  const str = s.trim();
  const parts = str.split('.');
  if (parts.length < 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  let year = parseInt(parts[2], 10);
  if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
  return new Date(year, month, day);
}

function toYMD(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
    const taskDate = toYMD(start);

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

      // Add to every date the shift spans
      const cur = new Date(minStart);
      cur.setHours(0, 0, 0, 0);
      const endDay = new Date(maxEnd);
      endDay.setHours(0, 0, 0, 0);

      while (cur <= endDay) {
        const dateKey = toYMD(cur);
        if (!staffDB[dateKey]) staffDB[dateKey] = [];
        // Avoid duplicate (same name on same date from same shift window)
        const exists = staffDB[dateKey].some(s =>
          s.name === empName &&
          s.shiftStart.getTime() === minStart.getTime()
        );
        if (!exists) staffDB[dateKey].push(staffMember);
        cur.setDate(cur.getDate() + 1);
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
// tb_sub_orders carries no res_assigned_to_ref/shift_assigned_to_ref in the
// real export — every task arrives unassigned, which is exactly the
// optimizer's input shape (nothing to pre-lock). The res_assigned_to_ref
// handling below is kept only in case a future export does carry it.
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

function parseOrders(orders, resourceMap) {
  const colorIndex = {};
  let colorCounter = 0;
  const tasks = [];

  for (const o of orders || []) {
    const start = o.start_time ? new Date(o.start_time) : null;
    const end = o.end_time ? new Date(o.end_time) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;

    const name = o.flight_event_ref || o.order_rule_ref || 'Задача';
    const reqTypes = Array.isArray(o.req_qual_vector) ? o.req_qual_vector.filter(Boolean) : [];
    const reqType = reqTypes.join(' + ');
    const pos = o.start_loc_ref || 'ПЕРРОН';
    const flight = o.flight_ref || o.outbound_flight_ref || o.inbound_flight_ref || 'Рейс не указ.';

    if (!(name in colorIndex)) {
      colorIndex[name] = COLOR_PALETTE[colorCounter % COLOR_PALETTE.length];
      colorCounter++;
    }

    const resource = o.res_assigned_to_ref ? resourceMap.get(String(o.res_assigned_to_ref)) : null;
    const employee = displayName(resource) || (o.res_assigned_to_ref ? o.res_assigned_to_ref : 'Не назначено');
    const isLocked = Boolean(o.res_assigned_to_ref);

    tasks.push({
      id: o._id,
      date: toYMD(start),
      name,
      flight,
      pos,
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

  return tasks;
}

function parseShifts(shifts, resourceMap, resourceQualMap, shiftQualMap) {
  const staffDB = {};

  for (const s of shifts || []) {
    const resource = resourceMap.get(String(s.resource_ref));
    // Only staff whose home department is SPO belong in this optimizer's pool.
    if (!resource || resource.default_department_ref !== 'SPO') continue;

    const shiftStart = s.scheduled_start ? new Date(s.scheduled_start) : null;
    const shiftEnd = s.scheduled_end ? new Date(s.scheduled_end) : null;
    if (!shiftStart || !shiftEnd) continue;

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
    };

    const cur = new Date(shiftStart);
    cur.setHours(0, 0, 0, 0);
    const endDay = new Date(shiftEnd);
    endDay.setHours(0, 0, 0, 0);

    while (cur <= endDay) {
      const dateKey = toYMD(cur);
      if (!staffDB[dateKey]) staffDB[dateKey] = [];
      const exists = staffDB[dateKey].some(m =>
        m.name === staffMember.name && m.shiftStart.getTime() === shiftStart.getTime()
      );
      if (!exists) staffDB[dateKey].push(staffMember);
      cur.setDate(cur.getDate() + 1);
    }
  }

  return staffDB;
}

export function parseJsonExport({
  orders,
  shifts,
  resources,
  resQual,
  resourceQualifications,
  shiftQualifications,
}) {
  const resourceMap = buildResourceMap(resources);
  const qualDict = buildQualDict(resQual);
  const resourceQualMap = buildResourceQualMap(resourceQualifications, qualDict);
  const shiftQualMap = buildShiftQualMap(shiftQualifications, qualDict);

  const tasks = parseOrders(orders, resourceMap);
  const staffDB = parseShifts(shifts, resourceMap, resourceQualMap, shiftQualMap);

  const colorMap = {};
  for (const t of tasks) colorMap[t.name] = t.color;

  return { tasks, staffDB, colorMap };
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
// ever carries more than one qualification for a task).
// ═══════════════════════════════════════════════════════════════════════════

function csvTextToRows(text) {
  if (!text || !text.trim()) return [];
  const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  return result.data;
}

function coerceOrderRowsFromCsv(rows) {
  return rows.map(r => ({
    ...r,
    req_qual_vector: r.req_qual_vector
      ? String(r.req_qual_vector).split(/[,;]/).map(s => s.trim()).filter(Boolean)
      : [],
  }));
}

export function parseCsvCollections({
  ordersCsv,
  shiftsCsv,
  resourcesCsv,
  resQualCsv,
  resourceQualificationsCsv,
  shiftQualificationsCsv,
}) {
  return parseJsonExport({
    orders: coerceOrderRowsFromCsv(csvTextToRows(ordersCsv)),
    shifts: csvTextToRows(shiftsCsv),
    resources: csvTextToRows(resourcesCsv),
    resQual: csvTextToRows(resQualCsv),
    resourceQualifications: csvTextToRows(resourceQualificationsCsv),
    shiftQualifications: csvTextToRows(shiftQualificationsCsv),
  });
}
