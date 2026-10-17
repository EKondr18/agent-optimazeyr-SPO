import { getPosDistance } from './utils/posDistance.js';
import { TZ_OFFSET_MS, dayKey } from './utils/tz.js';

const MIN_TRANSITION_MS = 5 * 60000;
const MIN_TRANSITION_POS_DIST = 5;
// Cost stand-in for a hand-off between stands with no path between them. Such
// a hand-off is never accepted (it is a hard conflict), but cost arithmetic
// must stay finite wherever a pair is merely being considered.
const UNREACHABLE_PENALTY_M = 10000;
// Walk times come from metres / speed and carry floating-point noise
// (748800.0000000001 ms); a gap equal to the walk up to this much is enough.
const WALK_EPS_MS = 1;

// ── Operating policy ────────────────────────────────────────────────────────
// Business rules that are a decision, not a fact of the data, kept in one
// place so every entry point (construction, repair, improvement, the manual
// Gantt assignment, the validator) applies exactly the same ones.
//   sameFlightOverlap — let one person do two overlapping tasks of the same
//                       flight at the same stand when the task names differ.
//                       Off by default: the real orders carry pairs like
//                       SPO_DP_738_OUT_1 / _OUT_2 that overlap on one flight
//                       and read as two people's work, not one.
//   maxOvertimeMin    — how far past shift end a task that STARTS within the
//                       shift may run. The only overtime the optimizer ever
//                       creates; anything longer stays open for a dispatcher.
//   waivedQuals       — qualifications a task may be assigned without (for
//                       types nobody on the roster holds yet, by an explicit
//                       decision); every such assignment is counted and shown.
//                       Empty by default: every requirement is hard.
export const DEFAULT_POLICY = { sameFlightOverlap: false, maxOvertimeMin: 60, waivedQuals: [] };
// Longest overtime allowance a caller can ask for — the same bound the
// settings form enforces, so a request cannot ask for more than the UI can.
const MAX_OVERTIME_CAP_MIN = 240;

// A policy from anywhere (a form, a JSON request, a test) reduced to the three
// known fields with usable values. Unchecked, `maxOvertimeMin: NaN` made every
// "ends later than shift end + allowance" test false — unlimited overtime — and
// `waivedQuals: null` crashed the qualification check.
function normalizePolicy(policy) {
  const src = policy && typeof policy === 'object' ? policy : {};
  let overtime = src.maxOvertimeMin;
  if (typeof overtime === 'string' && overtime.trim() !== '') overtime = Number(overtime);
  overtime = typeof overtime === 'number' && Number.isFinite(overtime)
    ? Math.min(MAX_OVERTIME_CAP_MIN, Math.max(0, overtime))
    : DEFAULT_POLICY.maxOvertimeMin;
  return {
    sameFlightOverlap: src.sameFlightOverlap === undefined ? DEFAULT_POLICY.sameFlightOverlap : Boolean(src.sameFlightOverlap),
    maxOvertimeMin: overtime,
    waivedQuals: Array.isArray(src.waivedQuals) ? src.waivedQuals.filter(q => typeof q === 'string') : [],
  };
}

let POLICY = normalizePolicy(DEFAULT_POLICY);
export function setPolicy(policy) {
  POLICY = normalizePolicy(policy);
}
export function getPolicy() {
  return POLICY;
}

// Runs `fn` under `policy` and puts the previous policy back afterwards, even
// when `fn` throws — so one request's rules never leak into the next one (the
// policy is module state, and a server handles many requests in one process).
// `fn` must be synchronous: the policy is restored when it returns, not when a
// promise it returns settles. No policy given = `fn` runs under whatever is
// current.
export function runWithPolicy(policy, fn) {
  if (policy == null) return fn();
  const saved = POLICY;
  POLICY = normalizePolicy(policy);
  try {
    return fn();
  } finally {
    POLICY = saved;
  }
}

// ── Input at the API boundary ───────────────────────────────────────────────
// What arrives from a form, a JSON request or another service is not what the
// search below assumes (real Date objects, finite times, end after start, one
// task per id). Comparisons with an Invalid Date are all false, so such a task
// "fits any shift and overlaps nothing" and slips past every hard rule; a
// repeated id makes the id-indexed lookups see only the first copy. So the
// entry points (planWindow, runOptimizer, applyChanges) make the tasks usable
// first and set aside the ones that cannot be, with a reason, instead of
// guessing: a set-aside task takes no part in the calculation and comes back
// open in its place.
const OPEN_EMPLOYEE = 'Не назначено';

// ISO date-time with NO zone is Moscow wall-clock time — the project-wide rule
// of the loader (see dataParser) — never the timezone of the process.
const ZONELESS_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?$/;
// A Date (as is), epoch milliseconds or a string -> Date; anything else, or
// anything unreadable, gives an Invalid Date.
function toInstant(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const str = v.trim();
    const m = ZONELESS_ISO.exec(str);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0'))) - TZ_OFFSET_MS);
    return str ? new Date(str) : new Date(NaN);
  }
  return new Date(NaN);
}
const isValidDate = d => d instanceof Date && Number.isFinite(d.getTime());

// Why a task cannot take part in a calculation (null = it can). First problem wins.
function taskProblem(t) {
  if (!t || typeof t !== 'object') return 'NOT_AN_OBJECT';
  if (t.id === undefined || t.id === null || t.id === '') return 'NO_ID';
  if (!isValidDate(t.start)) return 'BAD_START';
  if (!isValidDate(t.end)) return 'BAD_END';
  if (t.end.getTime() <= t.start.getTime()) return 'END_NOT_AFTER_START';
  return null;
}

// The task with its fields in the shapes the search relies on. Returns the SAME
// object when nothing needs to change (the common case: the loader's tasks are
// already in shape) and a copy otherwise — the input is never modified.
function normalizeTask(t) {
  if (!t || typeof t !== 'object') return t;
  let out = t;
  const set = (k, v) => { if (out === t) out = { ...t }; out[k] = v; };
  for (const k of ['start', 'end']) {
    const d = toInstant(t[k]);
    if (isValidDate(d) && d !== t[k]) set(k, d);
  }
  // Reference times: unreadable ones fall back to the current times.
  for (const [k, from] of [['baseStart', 'start'], ['baseEnd', 'end']]) {
    if (t[k] === undefined) continue;
    const d = toInstant(t[k]);
    if (isValidDate(d)) { if (d !== t[k]) set(k, d); } else if (isValidDate(out[from])) set(k, out[from]);
  }
  if (t.employee === undefined || t.employee === null || t.employee === '') set('employee', OPEN_EMPLOYEE);
  if (t.isLocked === undefined || t.isLocked === null) set('isLocked', false);
  // The day a task belongs to picks the planning window; one without it would
  // silently be left out of every calculation.
  if (typeof t.date !== 'string' && isValidDate(out.start)) set('date', dayKey(out.start));
  return out;
}

// All tasks normalized, in their positions, and the ones to set aside:
// `skip` = [{ index, id, reason }]. A repeated id sets aside every copy after
// the first.
function normalizeTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const out = new Array(list.length);
  const skip = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const t = normalizeTask(list[i]);
    out[i] = t;
    let reason = taskProblem(t);
    if (!reason) {
      if (seen.has(t.id)) reason = 'DUPLICATE_ID'; else seen.add(t.id);
    }
    if (reason) skip.push({ index: i, id: t && typeof t === 'object' ? t.id : undefined, reason });
  }
  return { tasks: out, skip };
}

const openCopy = t => (t && typeof t === 'object' ? { ...t, employee: OPEN_EMPLOYEE } : t);

// `computed` (tasks that took part, in any order) put back among the ones set
// aside: the original order, every set-aside task open in its own place.
function mergeSkipped(normalized, skip, computed) {
  const skipAt = new Set(skip.map(x => x.index));
  const byId = new Map(computed.map(t => [t.id, t]));
  return normalized.map((t, i) => (skipAt.has(i) ? openCopy(t) : (byId.get(t.id) ?? t)));
}

const summarizeSkipped = skip => {
  const reasons = {};
  for (const x of skip) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
  return { count: skip.length, reasons, items: skip.map(({ id, reason }) => ({ id, reason })) };
};

// Times are compared as numbers (getTime) in every check below that runs
// hundreds of thousands of times: `a.start < b.end` on two Date objects goes
// through ToPrimitive each time and cost more than the logic itself. An Invalid
// Date gives NaN either way, so every comparison with it stays false as before.
function tasksOverlap(a, b) {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

// The task's required qualifications. reqTypes is the canonical list; an
// empty list must not silently drop a requirement carried only in reqType
// (older inputs), so that is used whenever the list is empty.
export function requiredQuals(task) {
  if (Array.isArray(task.reqTypes) && task.reqTypes.length > 0) return task.reqTypes;
  if (task.reqType) return String(task.reqType).split(' + ').map(s => s.trim()).filter(Boolean);
  return [];
}

// A staff member is eligible for a task only if they hold EVERY qualification
// the task requires (AND, not OR) — a task's req_qual_vector can list more
// than one required qualification (e.g. aircraft type + SV), and all of them
// must be present in the employee/shift's quals.
export function hasAllQuals(staffQuals, task) {
  const waived = POLICY.waivedQuals;
  return requiredQuals(task).every(q => staffQuals.includes(q) || (waived.length > 0 && waived.includes(q)));
}

// Assigned tasks whose employee lacks a qualification that was waived for
// them by policy — what the dispatcher must know was assigned that way.
export function waivedAssignments(tasks, staffDB, dates) {
  if (POLICY.waivedQuals.length === 0) return [];
  const qualsByName = new Map();
  for (const d of dates) for (const s of staffDB[d] || []) {
    if (!qualsByName.has(s.name)) qualsByName.set(s.name, new Set());
    for (const q of s.quals) qualsByName.get(s.name).add(q);
  }
  return tasks.filter(t => dates.includes(t.date) && t.employee !== 'Не назначено' &&
    requiredQuals(t).some(q => POLICY.waivedQuals.includes(q) && !qualsByName.get(t.employee)?.has(q)));
}

// True when two POS codes are the same physical stand. Prefers the real
// travel-network resolver (same graph node) when one is loaded; falls back
// to the plain string heuristic otherwise.
// The travel network is immutable once built, and the optimizer asks about the
// same few stand pairs hundreds of thousands of times (every conflict check,
// every cost), so answers are cached per resolver. Nested maps rather than a
// concatenated key: no string is built on the hot path.
const pairCaches = new WeakMap();
function cachedPair(resolver, kind, a, b) {
  let c = pairCaches.get(resolver);
  if (!c) { c = { meters: new Map(), seconds: new Map(), reach: new Map() }; pairCaches.set(resolver, c); }
  const m = c[kind];
  let row = m.get(a);
  if (!row) { row = new Map(); m.set(a, row); }
  let v = row.get(b);
  if (v === undefined) {
    if (kind === 'meters') v = resolver.metersBetween(a, b);
    else if (kind === 'seconds') v = resolver.secondsBetween(a, b);
    else v = resolver.reachable ? resolver.reachable(a, b) : null;
    row.set(b, v);
  }
  return v;
}
const metersOf = (resolver, a, b) => cachedPair(resolver, 'meters', a, b);
const secondsOf = (resolver, a, b) => cachedPair(resolver, 'seconds', a, b);

// Walk time between two stands as a hard fact: seconds when the network knows
// it, Infinity when both stands are in the network but nothing connects them,
// null when it can't say (no network loaded, or a stand outside it).
function travelSeconds(resolver, a, b) {
  if (!resolver) return null;
  const s = secondsOf(resolver, a, b);
  if (s != null) return s;
  return cachedPair(resolver, 'reach', a, b) === false ? Infinity : null;
}

function samePosition(pos1, pos2, resolver) {
  if (resolver) {
    const m = metersOf(resolver, pos1, pos2);
    if (m != null) return m === 0;
  }
  return getPosDistance(pos1, pos2) === 0;
}

// Back-to-back tasks at meaningfully different positions need walking/driving
// time between them — without it the assignment isn't physically realistic.
// Per the corporate spec ("22.05. Учет расстояний сети передвижения..."),
// the reference points aren't just each task's generic POS: the employee's
// actual EXIT point from the earlier task is its clearup_loc_ref, falling
// back to dest_loc_ref (task.exitPos below), and their ENTRY point into the
// later task is its setup_loc_ref, falling back to start_loc_ref
// (task.entryPos) — using plain start-position for both ends, as before,
// would get the exit side wrong for any task with a distinct closing
// procedure. With a real distance resolver loaded, this compares the
// actual gap against how long that walk would take (see travelGraph.js's
// WALK_SPEED_MPS); without one, it falls back to the old fixed
// distance-units/time-window heuristic.
function hasInsufficientGap(a, b, resolver) {
  const aFirst = a.start.getTime() <= b.start.getTime();
  const earlier = aFirst ? a : b;
  const later = aFirst ? b : a;
  const laterStart = later.start.getTime(), earlierEnd = earlier.end.getTime();
  if (laterStart < earlierEnd) return false; // overlap is handled by tasksOverlap
  const gapMs = laterStart - earlierEnd;
  const exitPos = earlier.exitPos ?? earlier.pos;
  const entryPos = later.entryPos ?? later.pos;

  // Infinity (no path at all) makes any gap insufficient.
  const neededSeconds = travelSeconds(resolver, exitPos, entryPos);
  if (neededSeconds != null) {
    return gapMs < neededSeconds * 1000 - WALK_EPS_MS;
  }
  return gapMs < MIN_TRANSITION_MS && getPosDistance(exitPos, entryPos) >= MIN_TRANSITION_POS_DIST;
}

// Complementary roles on the same physical aircraft turn: same flight, same
// stand, different task name. Only ever exempt from the overlap rule when the
// policy says so (see DEFAULT_POLICY). Same flight + same name is always two
// people's work, and the same-stand check matters: two unrelated orders can
// share a flight_ref while sitting at completely different stands.
function sameFlightPair(a, b, resolver) {
  return POLICY.sameFlightOverlap &&
    a.flight === b.flight && a.flight !== 'Рейс не указ.' && a.name !== b.name &&
    samePosition(a.pos, b.pos, resolver);
}

// Exported so BacklogPanel's manual-assignment conflict check uses the exact
// same rule as the optimizer instead of maintaining its own copy — the two
// diverging once already caused a real double-booking bug.
export function conflictsWith(a, b, resolver) {
  if (sameFlightPair(a, b, resolver)) return false;
  return tasksOverlap(a, b) || hasInsufficientGap(a, b, resolver);
}

// Does the task fit inside this shift (time only — qualifications are
// separate)? Strictly inside, or with `allowOvertime` starting inside and
// ending no later than the policy's overtime allowance past the shift end.
// The shift starts at its base point, so a first task the person cannot walk
// to from there by its start does not fit either — checked only when the
// travel network knows the walk (unknown stays the heuristic's business).
export function fitsShift(shift, task, resolver, allowOvertime = false) {
  const ts = task.start.getTime(), te = task.end.getTime();
  const ss = shift.shiftStart.getTime(), se = shift.shiftEnd.getTime();
  if (ts < ss) return false;
  // One definition of "inside the shift" for every caller: a task that starts at
  // or after the shift's end is outside it, whatever its length — otherwise a
  // zero-length task at the end instant passed the strict test (te > se is
  // false) but not the overtime one, and the builder placed what the validator
  // then rejected. A zero-length task at the shift's START is inside.
  if (ts >= se) return false;
  if (allowOvertime) {
    if (te > se + POLICY.maxOvertimeMin * 60000) return false;
  } else if (te > se) {
    return false;
  }
  if (shift.basePos) {
    const sec = travelSeconds(resolver, shift.basePos, task.entryPos ?? task.pos);
    if (sec != null && ts - ss < sec * 1000 - WALK_EPS_MS) return false;
  }
  return true;
}

const canTake = (s, task, resolver, allowOvertime = false) =>
  hasAllQuals(s.quals, task) && fitsShift(s, task, resolver, allowOvertime);

function hasConflict(empTasks, newTask, resolver) {
  return empTasks.some(t => conflictsWith(t, newTask, resolver));
}

// Every conflicting task if `task` were assigned to `employeeName` (empty =
// no conflict). Exported so every manual-assignment entry point (backlog
// select+button, Gantt drag-and-drop) checks the exact same rule instead of
// each keeping its own copy — a past duplicate of this logic drifted out of
// sync with the optimizer's and caused a real double-booking bug.
export function findConflicts(employeeName, task, tasks, resolver) {
  const empTasks = tasks.filter(t => t.employee === employeeName && t.id !== task.id);
  return empTasks.filter(et => conflictsWith(et, task, resolver));
}

// Where the employee actually ends up after their last task before the new
// one — the exit point (clearup_loc_ref / dest_loc_ref), not the generic POS.
function getLastTaskExitPos(empTasks, beforeTime) {
  const before = beforeTime.getTime();
  const prior = empTasks
    .filter(t => t.end.getTime() <= before)
    .sort((a, b) => b.end.getTime() - a.end.getTime());
  return prior.length > 0 ? (prior[0].exitPos ?? prior[0].pos) : null;
}

// Mirror of the above, looking forward: where the employee needs to be for
// their next task after this one — needed for the insertion-cost scoring
// below, which cares about both neighbours of a slot, not just the one
// before it.
function getNextTaskEntryPos(empTasks, afterTime) {
  const after = afterTime.getTime();
  const next = empTasks
    .filter(t => t.start.getTime() >= after)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return next.length > 0 ? (next[0].entryPos ?? next[0].pos) : null;
}

// ── Tasks of the neighbouring days that still occupy a person ───────────────
// The planning window is a set of calendar dates, but work does not stop at
// midnight: a task assigned to someone and dated outside the window (a locked
// one running past 00:00, or just the day before/after being planned next) keeps
// that person busy at the window's edge. Looked at only through `date`, the
// search handed the same person an overlapping or unreachable task, and planning
// day D and then day D+1 left conflicts exactly at their join.
// Such a task is CONTEXT when its employee is in the window's shift pool and its
// time comes within a margin of the window's time span: the longest walk any
// hand-off can need plus the longest task, never less than six hours. Context
// takes part in every conflict test (it sits in the person's list), is never
// moved and never reported as changed, and stays out of the window's load and
// overtime figures — only the hand-offs next to it at the edge count in the
// walking cost, because those are real.
const CONTEXT_MIN_MARGIN_MS = 6 * 3600000;
function windowContext(tasks, dates, staff, resolver) {
  const win = [];
  let from = Infinity, to = -Infinity;
  for (const t of tasks) {
    if (!dates.includes(t.date)) continue;
    win.push(t);
    const s = t.start.getTime(), e = t.end.getTime();
    if (s < from) from = s;
    if (e > to) to = e;
  }
  const list = [];
  if (win.length > 0 && staff.length > 0) {
    const b = conflictBounds(win, resolver);
    const margin = Math.max(CONTEXT_MIN_MARGIN_MS, b.longMs + b.after);
    const pool = new Set(staff.map(s => s.name));
    for (const t of tasks) {
      if (t.employee === OPEN_EMPLOYEE || !pool.has(t.employee) || dates.includes(t.date)) continue;
      // (a NaN time fails both tests: an unreadable task is not context)
      if (t.end.getTime() > from - margin && t.start.getTime() < to + margin) list.push(t);
    }
  }
  const set = new Set(list);
  const counts = new Map();
  for (const t of list) counts.set(t.employee, (counts.get(t.employee) ?? 0) + 1);
  return {
    win, tasks: list, size: list.length,
    // the tasks conflict bounds must cover: the window's and its context
    span: list.length > 0 ? win.concat(list) : win,
    has: t => set.has(t),
    count: name => counts.get(name) ?? 0,
    // tasks of the window in `list` (an employee's tasks, context included)
    load: (name, l) => l.length - (counts.get(name) ?? 0),
  };
}
// What a caller without any context sees (every list is all window).
const NO_CONTEXT = { size: 0, has: () => false, count: () => 0, load: (name, l) => l.length };

function posDist(posA, posB, resolver) {
  const meters = resolver ? metersOf(resolver, posA, posB) : null;
  if (meters != null) return meters;
  if (resolver && cachedPair(resolver, 'reach', posA, posB) === false) return UNREACHABLE_PENALTY_M;
  return getPosDistance(posA, posB);
}

// Per the corporate spec: inserting a task between two others already on a
// shift changes the travel cost of BOTH the new task and whichever task
// follows it — scoring by "distance from the previous task" alone (as this
// used to) only sees half of that. This uses the classic cheapest-insertion
// cost instead: dist(before, task) + dist(task, after) - dist(before, after)
// — the actual marginal distance this task adds to the employee's day, given
// where they already are before and after it, not just a one-sided look-back.
//
// When there's no real predecessor task yet (this would be the first task
// of the employee's day, or the first one before whatever's already
// scheduled), the shift's own base location (staff.basePos) stands in as
// the virtual predecessor — the same reference point the spec uses for a
// shift's very first task, not a special case needing separate handling.
function scoreEmployee(staff, assignedTasks, task, resolver, ctx = NO_CONTEXT) {
  const empTasks = assignedTasks[staff.name] || [];
  const lastExitPos = getLastTaskExitPos(empTasks, task.start) ?? staff.basePos ?? null;
  const nextEntryPos = getNextTaskEntryPos(empTasks, task.end);
  const entryPos = task.entryPos ?? task.pos;
  const exitPos = task.exitPos ?? task.pos;
  const hasSameFlightDiffTask = empTasks.some(t =>
    t.flight === task.flight && task.flight !== 'Рейс не указ.' && t.name !== task.name
  );
  let dist;
  if (hasSameFlightDiffTask) {
    dist = 0;
  } else if (lastExitPos && nextEntryPos) {
    const distBefore = posDist(lastExitPos, entryPos, resolver);
    const distAfter = posDist(exitPos, nextEntryPos, resolver);
    const distDirect = posDist(lastExitPos, nextEntryPos, resolver);
    dist = Math.max(0, distBefore + distAfter - distDirect);
  } else if (lastExitPos) {
    dist = posDist(lastExitPos, entryPos, resolver);
  } else if (nextEntryPos) {
    dist = posDist(exitPos, nextEntryPos, resolver);
  } else {
    dist = 10;
  }
  return { dist, load: ctx.load(staff.name, empTasks) };
}

// id -> position in `list`, FIRST occurrence only: that is what the findIndex it
// replaces returned when an id repeats. Positions stay valid while the array
// only has elements replaced in place (never inserted or removed), which is how
// every caller below uses its `result`.
function indexFirstById(list) {
  const index = new Map();
  for (let i = 0; i < list.length; i++) if (!index.has(list[i].id)) index.set(list[i].id, i);
  return index;
}

function commit(result, index, assignedTasks, taskId, employeeName) {
  const idx = index.get(taskId);
  result[idx] = { ...result[idx], employee: employeeName };
  if (!assignedTasks[employeeName]) assignedTasks[employeeName] = [];
  assignedTasks[employeeName].push(result[idx]);
}

// Staff pool merged across a window of dates (the planning window, e.g.
// selectedDate ±1 day), de-duplicated by (name, shiftStart) since a shift
// crossing midnight is bucketed under more than one date.
function mergeStaffWindow(staffDB, dates) {
  const map = new Map();
  for (const d of dates) {
    for (const s of staffDB[d] || []) {
      const key = `${s.name}__${s.shiftStart.getTime()}`;
      if (!map.has(key)) map.set(key, s);
    }
  }
  return [...map.values()];
}

// Recursively searches for SOME way to place `task` onto a qualified,
// in-shift employee — directly if someone's free, or by chaining through
// as many bumps as it takes (displacing one person's own non-locked
// conflicting task onto someone else, whose own conflict may itself need
// bumping, and so on) rather than giving up after a single hop.
//
// Returns { assigned, migrations } on success (an updated assignment map
// plus the ordered list of {task, to} moves that produced it) or null if no
// placement exists anywhere in the chain.
//
// `isBumpable` says which already-placed tasks may be displaced — by default
// anything not locked, but callers that also freeze work by time (already
// started / outside the repair window) must say so, or a chain could move a
// task that must stay put.
//
// `visited` holds the employees on the CURRENT path only: an employee opened on
// a branch that failed is free again for the next branch. (Marking them for the
// whole search, as this once did, kept it polynomial but missed real
// placements — a person opened in vain for one task can still be exactly where
// another task of the chain fits.) What keeps it from exploding instead is an
// explicit budget: a depth limit and a cap on how many employees one search may
// open in total. Running out means "not found within the budget", not
// "impossible".
// Every task of an (unordered) list that conflicts with `task`, looking
// closely only at those near it in time: anything starting later than the
// longest walk after it ends, or ending earlier than that before it starts,
// can only conflict through a missing path — so of those, only the nearest
// one on each side is checked (as conflictsSorted does), plus anomalously
// long tasks. Same answer as filtering with conflictsWith on a valid plan.
function conflictsInWindow(list, task, resolver, bounds) {
  const out = [];
  const ts = task.start.getTime(), te = task.end.getTime();
  let before = null, after = null;
  for (const x of list) {
    const xs = x.start.getTime(), xe = x.end.getTime();
    const far = xs >= te + bounds.after || xe + bounds.after <= ts;
    if (!far || xe - xs > bounds.longMs || bounds.transitive === false) {
      if (conflictsWith(x, task, resolver)) out.push(x);
    } else if (resolver) {
      if (xs >= te) { if (!after || xs < after.start.getTime()) after = x; }
      else if (!before || xe > before.end.getTime()) before = x;
    }
  }
  for (const x of [before, after]) {
    if (x && !out.includes(x) && conflictsWith(x, task, resolver)) out.push(x);
  }
  return out;
}

const CHAIN_MAX_DEPTH = 4;
const CHAIN_NODE_BUDGET = 100;
function findChainPlacement(task, staffByLoad, assigned, resolver, visited, isBumpable = t => !t.isLocked,
  budget = { left: CHAIN_NODE_BUDGET }) {
  const found = chainSearch(task, staffByLoad, assigned, new Map(), resolver, visited, isBumpable, budget, 0);
  if (!found) return null;
  const out = { ...assigned };
  for (const [name, list] of found.over) out[name] = list;
  return { assigned: out, migrations: found.migrations };
}

// The search itself. A branch's tentative assignment is `assigned` plus an
// overlay `over` (name -> list) holding only the lists the branch changed:
// copying the whole assignment object (~300 people) at every node cost more
// than everything else here, and nearly every search ends in failure, where the
// copy is never used. The full object is built once, for a found placement.
//
// budget.trace (optional) collects what a search looked at: the tasks it tried
// to place and the people whose day it read (see improveAssignment's chainMemory).
// budget.eligibleNames (optional) = task => Set of the names with at least one
// shift that passes canTake for it: people outside it are skipped without the
// qualification and shift test (which it would fail anyway), so the answer is
// the same, only the ~300-person scan per node gets cheap.
function chainSearch(task, staffByLoad, assigned, over, resolver, visited, isBumpable, budget, depth) {
  const trace = budget.trace;
  if (trace) trace.tasks.add(task);
  const only = budget.eligibleNames ? budget.eligibleNames(task) : null;
  const listOf = (ov, name) => (ov.has(name) ? ov.get(name) : assigned[name] || []);
  const withList = (ov, name, list) => new Map(ov).set(name, list);

  // One person as the place for `task`. A branch result, or false = this person
  // does not work out (try the next), or null = the node budget is spent and the
  // whole search stops.
  const attempt = s => {
    if (trace) trace.names.add(s.name);

    const empTasks = listOf(over, s.name);
    const conflicts = budget.bounds
      ? conflictsInWindow(empTasks, task, resolver, budget.bounds)
      : empTasks.filter(ct => conflictsWith(ct, task, resolver));

    if (conflicts.length === 0) {
      return { over: withList(over, s.name, [...empTasks, task]), migrations: [{ task, to: s.name }] };
    }
    if (depth >= CHAIN_MAX_DEPTH) return false;
    if (conflicts.some(ct => !isBumpable(ct))) return false;
    if (budget.left <= 0) return null;
    budget.left--;

    visited.add(s.name);
    let working = withList(over, s.name, empTasks.filter(t => !conflicts.includes(t)));
    const chainMigrations = [];
    let ok = true;
    for (const conflict of conflicts) {
      const sub = chainSearch(conflict, staffByLoad, assigned, working, resolver, visited, isBumpable, budget, depth + 1);
      if (!sub) { ok = false; break; }
      working = sub.over;
      chainMigrations.push(...sub.migrations);
    }
    visited.delete(s.name);

    if (ok) {
      working = withList(working, s.name, [...listOf(working, s.name), task]);
      chainMigrations.push({ task, to: s.name });
      return { over: working, migrations: chainMigrations };
    }
    return false;
  };

  // People whose shift holds the task on the clock go first, in the order given
  // (least loaded first). Those who could only take it by staying past the end of
  // the shift, within the policy's overtime allowance (as the construction's last
  // pass and the validator allow), are the fallback: the plan's cost charges for
  // that overtime, and a chain that needs it beats leaving the task open.
  const overtimeOnly = [];
  for (const s of staffByLoad) {
    if (only && !only.has(s.name)) continue;
    if (visited.has(s.name)) continue;
    if (!hasAllQuals(s.quals, task)) continue;
    if (!fitsShift(s, task, resolver)) {
      if (fitsShift(s, task, resolver, true)) overtimeOnly.push(s);
      continue;
    }
    const r = attempt(s);
    if (r === null) return null;
    if (r) return r;
  }
  for (const s of overtimeOnly) {
    if (visited.has(s.name)) continue;
    const r = attempt(s);
    if (r === null) return null;
    if (r) return r;
  }
  return null;
}

// Minimal-disruption repair for a near-term "stability window" — a
// dispatcher shouldn't see someone's near-future assignment change just
// because a FULL re-optimization found a marginally nicer fit somewhere.
// Unlike runOptimizer (which resets and re-searches everything in scope),
// this only ever touches a task that is ACTUALLY broken right now — one
// that genuinely overlaps/collides with another task of the same employee
// — and relocates just that one task, leaving every other assignment in
// [scopeStart, scopeEnd) exactly as it was. Same scoring/fallback logic
// runOptimizer's own passes use, just applied to a single task instead of
// the whole pool.
//
// options.frozenBefore (Date): a displacement chain may only move tasks that
// start at or after it (and before scopeEnd). The tasks the loop below moves
// because they are themselves broken are a different matter and need no
// permission: a task broken by an edit is repaired even inside the frozen hour,
// but making room for it must not reshuffle other people's work there.
export function patchConflicts(tasks, staffDB, selectedDate, resolver, windowDates, scopeStart, scopeEnd, options = {}) {
  const result = tasks.map(t => ({ ...t }));
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const staff = mergeStaffWindow(staffDB, dates);
  if (staff.length === 0) return { tasks: result, changes: [] };
  const index = indexFirstById(result);
  const ctx = windowContext(result, dates, staff, resolver);

  let assignedTasks = {};
  for (const s of staff) assignedTasks[s.name] = [];
  for (const t of result) {
    if ((dates.includes(t.date) || ctx.has(t)) && t.employee !== 'Не назначено') {
      if (!assignedTasks[t.employee]) assignedTasks[t.employee] = [];
      assignedTasks[t.employee].push(t);
    }
  }

  const inScope = t =>
    dates.includes(t.date) && !t.isLocked && t.start >= scopeStart && t.start < scopeEnd;
  // Displaceable by a chain: in scope AND not frozen. The window test matters
  // since the other days' tasks sit in the lists as context.
  const bumpFrom = options.frozenBefore && options.frozenBefore > scopeStart ? options.frozenBefore : scopeStart;
  const isBumpable = t => inScope(t) && t.start >= bumpFrom;
  const changes = [];

  for (const task of result) {
    if (!inScope(task) || task.employee === 'Не назначено') continue;

    const currentEmp = task.employee;
    const empTasks = (assignedTasks[currentEmp] || []).filter(t => t.id !== task.id);
    if (!empTasks.some(t => conflictsWith(t, task, resolver))) continue;

    assignedTasks[currentEmp] = empTasks;

    // Pass A: best-scoring qualified employee, in shift, no conflicts.
    let bestStaff = null, bestScore = null;
    for (const s of staff) {
      if (s.name === currentEmp) continue;
      if (!canTake(s, task, resolver)) continue;
      if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
      const score = scoreEmployee(s, assignedTasks, task, resolver, ctx);
      if (!bestScore || score.load < bestScore.load ||
          (score.load === bestScore.load && score.dist < bestScore.dist)) {
        bestScore = score; bestStaff = s;
      }
    }

    // Pass Bump: no one is free outright, but the task MUST land somewhere
    // rather than fall to the backlog — chain through as many displacements
    // as it takes (see findChainPlacement), not just one hop. Tried before
    // relaxing the shift-end boundary below, same precedence as
    // runOptimizer's own PASS 2 vs PASS 3.
    let viaChain = false;
    if (!bestStaff) {
      const staffByLoad = [...staff].sort(
        (a, b) => ctx.load(a.name, assignedTasks[a.name] || []) - ctx.load(b.name, assignedTasks[b.name] || [])
      );
      const chain = findChainPlacement(task, staffByLoad, assignedTasks, resolver, new Set(), isBumpable);
      if (chain) {
        // chain.assigned already reflects the FULL outcome (the broken
        // task included) — the shared commit below must only update
        // `result`/`changes` for it, not push into assignedTasks again.
        assignedTasks = chain.assigned;
        // Every migration except the last one (the broken task itself,
        // handled by the shared commit below) is a knock-on displacement.
        for (const { task: mt, to } of chain.migrations.slice(0, -1)) {
          const midx = index.get(mt.id);
          const from = result[midx].employee;
          result[midx] = { ...result[midx], employee: to };
          changes.push({ taskId: mt.id, taskName: mt.name, from, to, backlog: false, viaBump: true });
        }
        bestStaff = { name: chain.migrations[chain.migrations.length - 1].to };
        viaChain = true;
      }
    }

    // Pass B: relax only the shift END boundary, within the policy's overtime
    // allowance, same as runOptimizer's own.
    if (!bestStaff) {
      let bestLoad = Infinity;
      for (const s of staff) {
        if (s.name === currentEmp) continue;
        if (!canTake(s, task, resolver, true)) continue;
        if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
        const load = ctx.load(s.name, assignedTasks[s.name] || []);
        if (load < bestLoad) { bestLoad = load; bestStaff = s; }
      }
    }

    const idx = index.get(task.id);
    if (bestStaff) {
      result[idx] = { ...result[idx], employee: bestStaff.name };
      if (!viaChain) {
        if (!assignedTasks[bestStaff.name]) assignedTasks[bestStaff.name] = [];
        assignedTasks[bestStaff.name].push(result[idx]);
      }
      // A chain can resolve by bumping everyone ELSE out of the way and
      // leaving the originally-broken task right where it was — a real
      // outcome, but "moved from S1 to S1" would be a confusing thing to
      // show the dispatcher, so only log an actual move.
      if (bestStaff.name !== currentEmp) {
        changes.push({ taskId: task.id, taskName: task.name, from: currentEmp, to: bestStaff.name, backlog: false });
      }
    } else {
      result[idx] = { ...result[idx], employee: 'Не назначено' };
      changes.push({ taskId: task.id, taskName: task.name, from: currentEmp, to: null, backlog: true });
    }
  }

  return { tasks: result, changes };
}

// ── Cost model ──────────────────────────────────────────────────────────────
// What "better" means for the construction (regret) and the improvement
// search: one weighted sum rather than "load strictly outranks everything",
// so the trade-offs can be tuned. Units: `load` per unit of Σ(tasks per
// employee)², `walk` per metre (or per heuristic unit when no travel network
// is loaded), `slack` per minute of missing buffer between hand-offs,
// `overtime` per minute worked past shift end. The defaults keep load
// balancing dominant, as the greedy passes do.
//
// overtime: 50 (was 5). Once the improvement search could use the allowed
// overtime, at weight 5 an hour of it cost the same as 300 m of walking and
// it was used freely. Measured on five real days (LNS off): weight 5 -> 160
// tasks open, 3185 overtime min, 125 person-shifts with overtime; weight 20
// -> 159 open, 2240 min; weight 50 -> 159 open, 1624 min, 73 person-shifts,
// walking +2 %. An hour of overtime now costs about 3 km of walking.
export const DEFAULT_WEIGHTS = { load: 100, walk: 1, slack: 3, overtime: 50 };

// A hand-off between two consecutive tasks is "tight" when it leaves less
// spare time than this beyond the walk itself. Flights slip; a schedule with
// no margin turns every small delay into a re-plan.
const TARGET_SLACK_MS = 15 * 60000;

export function resolveWeights(weights) {
  return { ...DEFAULT_WEIGHTS, ...(weights || {}) };
}

// How long the walk between two points takes, on the same basis
// hasInsufficientGap uses (real network when loaded, else the heuristic).
// (Cost only: an unreachable pair counts as a day's walk so the arithmetic
// stays finite — the hard checks never let such a hand-off into a plan.)
function transitMs(exitPos, entryPos, resolver) {
  const seconds = travelSeconds(resolver, exitPos, entryPos);
  if (seconds === Infinity) return 24 * 3600000;
  if (seconds != null) return seconds * 1000;
  return getPosDistance(exitPos, entryPos) >= MIN_TRANSITION_POS_DIST ? MIN_TRANSITION_MS : 0;
}

// One employee's day, measured: walking (shift base point → first task, then
// each exit point → next entry point), minutes of buffer missing below the
// target on each hand-off, and minutes worked past the end of the shift their
// tasks belong to. Overlapping (complementary same-flight) tasks need no
// travel between them, same convention MetricsSummary uses. `sorted` must
// already be ordered by start — the improvement search keeps every
// employee's list that way (see insertSorted) so this never has to sort.
function routeStats(shifts, sorted, resolver, ctx = NO_CONTEXT) {
  const basePos = shifts?.[0]?.basePos ?? null;
  let walk = 0, slackShort = 0, prev = null;
  for (const t of sorted) {
    const entry = t.entryPos ?? t.pos;
    if (prev === null) {
      if (basePos) walk += posDist(basePos, entry, resolver);
    } else if (t.start.getTime() >= prev.end.getTime()) {
      const exit = prev.exitPos ?? prev.pos;
      walk += posDist(exit, entry, resolver);
      const spare = (t.start.getTime() - prev.end.getTime()) - transitMs(exit, entry, resolver);
      slackShort += Math.max(0, TARGET_SLACK_MS - spare) / 60000;
    }
    prev = t;
  }
  let overtime = 0;
  for (const s of shifts || []) {
    let maxEnd = null;
    for (const t of sorted) {
      if (t.start >= s.shiftStart && t.start <= s.shiftEnd && (maxEnd === null || t.end > maxEnd) && !ctx.has(t)) maxEnd = t.end;
    }
    if (maxEnd && maxEnd > s.shiftEnd) overtime += (maxEnd - s.shiftEnd) / 60000;
  }
  return { walk, slackShort, overtime };
}

// Same answer as hasConflict, but for a list ordered by start: only tasks
// whose start can possibly matter are looked at (a binary search to the first
// one, then until their start is past the task's end plus the longest walk
// any hand-off can need). `bounds` = { before, after } in ms, computed once
// per run from the longest task and the longest walk between any two stands
// in play, so nothing that could conflict is ever skipped.
function conflictsSorted(sorted, task, resolver, bounds) {
  let lo = 0, hi = sorted.length;
  const from = task.start.getTime() - bounds.before;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].start.getTime() <= from) lo = mid + 1; else hi = mid;
  }
  // Tasks longer than the window allows for (anomalies like a 100-hour
  // record) can reach in from further back; they are rare, so they get a
  // cheap separate look instead of widening the window for everyone.
  for (let j = 0; j < lo; j++) {
    const x = sorted[j];
    if (x.end.getTime() - x.start.getTime() > bounds.longMs && conflictsWith(x, task, resolver)) return true;
  }
  const limit = task.end.getTime() + bounds.after;
  let i = lo;
  for (; i < sorted.length; i++) {
    const x = sorted[i];
    if (x.start.getTime() >= limit) break;
    if (conflictsWith(x, task, resolver)) return true;
  }
  // The window above covers every walk the network can make in finite time;
  // a stand with no path to the neighbours is a conflict however long the
  // gap, so the immediate neighbours just outside it are checked as well (all of
  // them when the network is not transitive for these stands, see conflictBounds).
  if (resolver) {
    if (bounds.transitive === false) {
      for (let j = 0; j < lo; j++) if (conflictsWith(sorted[j], task, resolver)) return true;
      for (let j = i; j < sorted.length; j++) if (conflictsWith(sorted[j], task, resolver)) return true;
    } else {
      if (lo > 0 && conflictsWith(sorted[lo - 1], task, resolver)) return true;
      if (i < sorted.length && conflictsWith(sorted[i], task, resolver)) return true;
    }
  }
  return false;
}

// 53-bit string hash (cyrb53) for the fingerprints above; a collision could
// only make a repeat search be skipped, never produce an invalid plan.
function hash53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const LONG_TASK_WINDOW_MS = 4 * 3600000;
function conflictBounds(tasks, resolver) {
  let maxDur = 0;
  const exits = new Set(), entries = new Set();
  for (const t of tasks) {
    maxDur = Math.max(maxDur, t.end - t.start);
    exits.add(t.exitPos ?? t.pos);
    entries.add(t.entryPos ?? t.pos);
  }
  let need = MIN_TRANSITION_MS;
  // `transitive`: the network knows a finite walk between every pair of stands in
  // play. Then a task far away in time can only be a problem if the nearest one
  // on its side is (walking time grows with the gap, and "reachable" is
  // transitive), which is what lets the checks below look at the neighbours
  // alone. A stand outside the network (the heuristic decides there) or a pair
  // with no path breaks that: a far task may then conflict although the nearer
  // ones do not, so every task is looked at.
  let transitive = true;
  if (resolver) {
    for (const e of exits) for (const n of entries) {
      const sec = secondsOf(resolver, e, n);
      if (sec == null || !Number.isFinite(sec)) transitive = false;
      else if (sec * 1000 > need) need = sec * 1000;
    }
  }
  const longMs = Math.min(maxDur, LONG_TASK_WINDOW_MS);
  return { before: longMs + need, after: need, longMs, transitive };
}

// A copy of `list` (ordered by start) with `task` added in its place.
function insertSorted(list, task) {
  let i = list.length;
  const ts = task.start.getTime();
  while (i > 0 && list[i - 1].start.getTime() > ts) i--;
  return [...list.slice(0, i), task, ...list.slice(i)];
}

// `load` = how many of `sortedTasks` count as the person's work in the window
// (context tasks are in the list for the hand-offs but are not load).
function employeeCost(W, shifts, sortedTasks, resolver, ctx = NO_CONTEXT, load = sortedTasks.length) {
  const r = routeStats(shifts, sortedTasks, resolver, ctx);
  return W.load * load ** 2 + W.walk * r.walk + W.slack * r.slackShort + W.overtime * r.overtime;
}

// The weighted cost of a whole assignment (what the improvement search drives
// down): sum over employees of load² · load weight + walking + hand-off margin
// + overtime. Exposed so callers and tests can compare two assignments.
export function assignmentCost(tasks, staffDB, selectedDate, resolver, windowDates, weights) {
  const W = resolveWeights(weights);
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const shifts = new Map();
  for (const s of mergeStaffWindow(staffDB, dates)) {
    if (!shifts.has(s.name)) shifts.set(s.name, []);
    shifts.get(s.name).push(s);
  }
  const by = {};
  for (const t of tasks) {
    if (dates.includes(t.date) && t.employee !== 'Не назначено') (by[t.employee] ??= []).push(t);
  }
  let total = 0;
  for (const [name, list] of Object.entries(by)) {
    list.sort((a, b) => a.start - b.start);
    total += employeeCost(W, shifts.get(name), list, resolver);
  }
  return total;
}

// The plan's measurable outcome in plain units, for comparing runs and
// configurations: open/assigned tasks in the window, metres walked, minutes
// of hand-off margin missing below the target, minutes of overtime, people
// used, the busiest person's task count and the spread of work minutes.
export function planMetrics(tasks, staffDB, selectedDate, resolver, windowDates) {
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const shifts = new Map();
  for (const s of mergeStaffWindow(staffDB, dates)) {
    if (!shifts.has(s.name)) shifts.set(s.name, []);
    shifts.get(s.name).push(s);
  }
  const by = new Map();
  let open = 0, assigned = 0;
  for (const t of tasks) {
    if (!dates.includes(t.date)) continue;
    if (t.employee === 'Не назначено') { open++; continue; }
    assigned++;
    if (!by.has(t.employee)) by.set(t.employee, []);
    by.get(t.employee).push(t);
  }
  let walkM = 0, slackShortMin = 0, overtimeMin = 0, maxTasks = 0;
  const workMin = [];
  for (const [name, list] of by) {
    list.sort((a, b) => a.start - b.start);
    const r = routeStats(shifts.get(name), list, resolver);
    walkM += r.walk; slackShortMin += r.slackShort; overtimeMin += r.overtime;
    maxTasks = Math.max(maxTasks, list.length);
    workMin.push(list.reduce((s, t) => s + (t.end - t.start) / 60000, 0));
  }
  const mean = workMin.length ? workMin.reduce((a, b) => a + b, 0) / workMin.length : 0;
  const sd = workMin.length ? Math.sqrt(workMin.reduce((a, b) => a + (b - mean) ** 2, 0) / workMin.length) : 0;
  return {
    open, assigned, walkM: Math.round(walkM), slackShortMin: Math.round(slackShortMin),
    overtimeMin: Math.round(overtimeMin), peopleUsed: by.size, maxTasks,
    workMinMean: Math.round(mean), workMinSd: Math.round(sd),
  };
}

// ── Independent plan check ──────────────────────────────────────────────────
// Re-derives every hard rule from scratch for a finished plan, without any of
// the search's incremental bookkeeping — so a slip in a delta, a stale cache
// or a manual edit can't hide behind it. One entry per (task, problem):
//   NO_SHIFT       the employee has no shift in the window at all (absent)
//   QUAL_MISSING   none of their shifts carries every required qualification
//   OUT_OF_SHIFT   the task falls outside their shift(s) beyond the allowed
//                  overtime
//   START_TRAVEL   it fits the shift on the clock, but can't be reached from
//                  the shift's base point by its start
//   OVERLAP        overlaps another task of the same person
//   TRAVEL         not enough time (or no path) to walk from the previous task
// The later-starting task of a conflicting pair carries the entry. Assigned
// tasks of the days around the window (see windowContext) count as the person's
// time: a window task that overlaps one, or cannot be reached from it, is
// reported (on the window task, whichever of the two starts later); the context
// task itself, and pairs of context tasks, are not the window's business.
export function validatePlan(tasks, staffDB, selectedDate, resolver, windowDates) {
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const shiftsByName = new Map();
  const pool = mergeStaffWindow(staffDB, dates);
  for (const s of pool) {
    if (!shiftsByName.has(s.name)) shiftsByName.set(s.name, []);
    shiftsByName.get(s.name).push(s);
  }
  const ctx = windowContext(tasks, dates, pool, resolver);
  const allowMs = POLICY.maxOvertimeMin * 60000;
  const onClock = (s, t) =>
    t.start >= s.shiftStart && t.start < s.shiftEnd &&
    (t.end <= s.shiftEnd || t.end.getTime() <= s.shiftEnd.getTime() + allowMs);

  const out = [];
  const seen = new Set();
  const add = (t, code, detail) => {
    const key = t.id + '\u0000' + code;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ taskId: t.id, employee: t.employee, code, detail });
  };

  const byEmp = new Map();
  for (const t of tasks) {
    if ((!dates.includes(t.date) && !ctx.has(t)) || t.employee === 'Не назначено') continue;
    if (!byEmp.has(t.employee)) byEmp.set(t.employee, []);
    byEmp.get(t.employee).push(t);
  }
  for (const [name, list] of byEmp) {
    const shifts = shiftsByName.get(name) || [];
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (const t of list) {
      if (ctx.has(t)) continue;
      if (shifts.length === 0) { add(t, 'NO_SHIFT'); continue; }
      const qualified = shifts.filter(s => hasAllQuals(s.quals, t));
      if (qualified.length === 0) {
        const have = new Set(shifts.flatMap(s => s.quals));
        add(t, 'QUAL_MISSING', requiredQuals(t).filter(q => !have.has(q)).join(', '));
        continue;
      }
      if (qualified.some(s => fitsShift(s, t, resolver, true))) continue;
      add(t, qualified.some(s => onClock(s, t)) ? 'START_TRAVEL' : 'OUT_OF_SHIFT');
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const aCtx = ctx.has(a), bCtx = ctx.has(b);
        if (aCtx && bCtx) continue;
        if (!conflictsWith(a, b, resolver)) continue;
        if (bCtx) add(a, tasksOverlap(a, b) ? 'OVERLAP' : 'TRAVEL', b.id);
        else add(b, tasksOverlap(a, b) ? 'OVERLAP' : 'TRAVEL', a.id);
      }
    }
  }
  return out;
}

// Brings a plan in line with validatePlan by sending every violating task
// back to the open list — except locked tasks (the dispatcher's call) and,
// with `keepBefore`, work that already started (history). Those stay as they
// are and come back in `remaining` for someone to decide on.
// `mutableIds` are tasks that may be reopened even before keepBefore (tasks
// whose own data just changed). For a conflicting pair, the later task is
// reopened when it may be, else the earlier one.
export function certifyPlan(tasks, staffDB, selectedDate, resolver, windowDates, options = {}) {
  const { keepBefore, mutableIds } = options;
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  let result = tasks;
  const reopened = [];
  for (let round = 0; round < 50; round++) {
    const violations = validatePlan(result, staffDB, selectedDate, resolver, windowDates);
    const byId = new Map(result.map(t => [t.id, t]));
    // (only the window's own tasks: the other days' work that blocks one of them
    // is what it is, not something to reopen)
    const droppable = t => t && !t.isLocked && dates.includes(t.date) &&
      (!keepBefore || t.start >= keepBefore || (mutableIds && mutableIds.has(t.id)));
    const drop = new Set();
    for (const v of violations) {
      const t = byId.get(v.taskId);
      if (droppable(t)) { drop.add(t.id); continue; }
      if (v.code === 'OVERLAP' || v.code === 'TRAVEL') {
        const other = byId.get(v.detail);
        if (droppable(other)) drop.add(other.id);
      }
    }
    if (drop.size === 0) return { tasks: result, reopened, remaining: violations };
    result = result.map(t => (drop.has(t.id) ? { ...t, employee: 'Не назначено' } : t));
    reopened.push(...drop);
  }
  return { tasks: result, reopened, remaining: validatePlan(result, staffDB, selectedDate, resolver, windowDates) };
}

// Improvement pass, run AFTER the constructive passes have produced a valid
// assignment. The construction commits each task once and never looks back;
// this goes back over what it built and keeps applying whichever single move
// lowers the total weighted cost most — until none does:
//   • place a still-unassigned task (directly where it fits cheapest, else by
//     chaining displacements — a placement always beats leaving it open),
//   • relocate one task to another employee,
//   • swap two tasks between two employees.
// Every candidate is checked with the construction's own rules
// (qualifications, shift bounds, conflicts incl. travel feasibility), so the
// result is always another valid assignment. Each accepted move strictly
// lowers (open tasks, total cost), so the search ends on its own; the limits
// below (maxSteps, deadline) are optional extras for callers with a latency budget.
//
// options:
//   weights          — cost weights (see DEFAULT_WEIGHTS)
//   frozenBefore     — Date; tasks starting earlier (and locked ones) never
//                      move, though they still count for conflicts/cost
//   priorityUntil    — Date; tasks starting before it are searched to
//                      convergence first, then the rest of the movable pool
//   scopeEmployees   — iterable of names; only their tasks are moved at the
//                      start. Any employee a move touches joins the scope, so
//                      a change ripples outward as far as it actually helps
//                      and no further — the incremental mode
//   scopeTaskIds     — iterable of ids; only these unassigned tasks are placed
//                      (even inside the frozen window)
//   pinnedEmployees  — iterable of names whose tasks must not move (they may
//                      still receive tasks)
//   maxSteps         — the deterministic limit: how many candidate tasks the
//                      search may look at in total (each task examined for a
//                      move or a swap, each open task tried for a place). The
//                      same input stops at the same point on any machine, which
//                      a clock never guarantees. Default: no limit (a full
//                      run). terminationReason says 'max-steps'.
//   deadline         — epoch ms; a safety net only: the search stops there
//                      with whatever it has (every intermediate state is a
//                      valid plan), terminationReason says 'deadline' and
//                      timeCut is true — the result then depends on how fast
//                      the machine was and is not reproducible
//   confirmRound     — default true: after the pruned search stops, one full
//                      unpruned round confirms a true local optimum. It only
//                      catches a rare case (see below) and costs as much as
//                      the rest, so batch updates on a deadline skip it
//   chainMemory      — an object the caller keeps across calls (start it as
//                      {}). A caller that calls this once per added person
//                      otherwise repeats the same hopeless displacement-chain
//                      searches in every call. For each task whose search found
//                      nothing it remembers exactly what that search looked at —
//                      which people's days (their tasks and shifts) and which
//                      tasks it tried to move — and skips the task in a later
//                      call while none of that has changed and nobody new can
//                      take any of those tasks. The search is deterministic, so
//                      a skipped search is one that would fail again: the result
//                      is the same as without the memory. Valid only while the
//                      tasks' own data (times, stands, qualifications) and the
//                      other options stay the same between the calls.
//   moveCost         — task => cost units; the price of taking an already
//                      assigned task away from the employee it had on input
//                      (moving it back refunds it). A published plan has a
//                      value of its own: without this, every batch of changes
//                      reshuffled hundreds of unrelated assignments for tiny
//                      gains. Default: no price (a full planning run).
export function improveAssignment(tasks, staffDB, selectedDate, resolver, windowDates, options = {}) {
  const { frozenBefore, priorityUntil, weights, deadline, maxSteps, moveCost, confirmRound = true, chainMemory } = options;
  const originalEmp = new Map();
  if (moveCost) for (const t of tasks) if (t.employee !== 'Не назначено') originalEmp.set(t.id, t.employee);
  // Change in the disruption price if `task` goes from `from` to `to`.
  const churn = moveCost
    ? (task, from, to) => {
      const orig = originalEmp.get(task.id);
      if (orig === undefined) return 0;
      return (to === orig ? 0 : moveCost(task)) - (from === orig ? 0 : moveCost(task));
    }
    : () => 0;
  const overDeadline = () => deadline != null && Date.now() > deadline;
  // Why the search was cut short, if it was. The step limit is checked first:
  // it is the one that makes the stop reproducible.
  let steps = 0, cutBy = null;
  const outOfBudget = () => {
    if (maxSteps != null && steps >= maxSteps) { cutBy ??= 'max-steps'; return true; }
    if (overDeadline()) { cutBy ??= 'deadline'; return true; }
    return false;
  };
  const W = resolveWeights(weights);
  const scope = options.scopeEmployees ? new Set(options.scopeEmployees) : null;
  const scopeTaskIds = options.scopeTaskIds ? new Set(options.scopeTaskIds) : null;
  const pinned = options.pinnedEmployees ? new Set(options.pinnedEmployees) : null;

  const result = tasks.map(t => ({ ...t }));
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const staff = mergeStaffWindow(staffDB, dates);
  const touchedList = () => (scope ? [...scope] : []);
  if (staff.length === 0) return { tasks: result, moves: 0, steps: 0, timeCut: false, touched: touchedList(), terminationReason: 'no-staff' };

  const shiftsByName = new Map();
  for (const s of staff) {
    if (!shiftsByName.has(s.name)) shiftsByName.set(s.name, []);
    shiftsByName.get(s.name).push(s);
  }
  const indexById = new Map(result.map((t, i) => [t.id, i]));
  // The days around the window still occupy people (see windowContext): they sit
  // in the lists below so no move creates an overlap or an impossible hand-off
  // with them, but they are not movable and not load.
  const ctx = windowContext(result, dates, staff, resolver);
  const bounds = conflictBounds(ctx.span, resolver);
  const ctxN = ctx.size > 0 ? name => ctx.count(name) : () => 0;

  let byEmp = {};
  let epoch = 0;
  const overCache = new Map();
  const gainCache = new Map();
  const printCache = new Map();
  const rebuildByEmp = () => {
    byEmp = {};
    for (const name of shiftsByName.keys()) byEmp[name] = [];
    for (const t of result) {
      if ((dates.includes(t.date) || ctx.has(t)) && t.employee !== 'Не назначено') {
        if (!byEmp[t.employee]) byEmp[t.employee] = [];
        byEmp[t.employee].push(t);
      }
    }
    for (const list of Object.values(byEmp)) list.sort((a, b) => a.start - b.start);
    gainCache.clear();
    overCache.clear();
    printCache.clear();
    epoch++;
  };
  rebuildByEmp();

  const isMovable = t =>
    dates.includes(t.date) && !t.isLocked && t.employee !== 'Не назначено' &&
    !(pinned && pinned.has(t.employee)) && (!frozenBefore || t.start >= frozenBefore);
  const inScope = name => !scope || scope.has(name);
  const phases = priorityUntil
    ? [t => isMovable(t) && t.start < priorityUntil, isMovable]
    : [isMovable];

  // Qualification + shift-bounds half of "does this task fit this employee" —
  // independent of what else they have, so memoized; the cheap test that
  // rules most (task, employee) pairs out before any cost is computed.
  // Who can take a task at all is computed once per task, as a list (to
  // iterate only real candidates) and a set (to test membership).
  const eligibleMemo = new Map();
  const eligibleOf = task => {
    let e = eligibleMemo.get(task.id);
    if (!e) {
      const names = [];
      for (const [name, shifts] of shiftsByName) {
        // (with the overtime allowance: the cost charges for it — see chainSearch)
        if (shifts.some(s => canTake(s, task, resolver, true))) names.push(name);
      }
      e = { names, set: new Set(names) };
      eligibleMemo.set(task.id, e);
    }
    return e;
  };
  const staticFits = (name, task) => eligibleOf(task).set.has(name);
  // `empTasks` = what the employee would already have, WITHOUT this task.
  const fits = (name, task, empTasks) =>
    staticFits(name, task) && !conflictsSorted(empTasks, task, resolver, bounds);
  // Incremental cost: adding or removing one task only changes the hand-offs
  // next to it (and the overtime figure), so its effect is computed from the
  // two neighbours instead of re-walking the whole day. These agree exactly
  // with employeeCost minus the load term (the tests check the search never
  // raises assignmentCost, and a scratch check confirmed move-by-move equality).
  const baseOf = name => shiftsByName.get(name)?.[0]?.basePos ?? null;
  const linkCost = (name, prev, next) => {
    if (!next) return 0;
    const entry = next.entryPos ?? next.pos;
    if (!prev) {
      const base = baseOf(name);
      return base ? W.walk * posDist(base, entry, resolver) : 0;
    }
    if (next.start.getTime() < prev.end.getTime()) return 0;
    const exit = prev.exitPos ?? prev.pos;
    const spare = (next.start.getTime() - prev.end.getTime()) - transitMs(exit, entry, resolver);
    return W.walk * posDist(exit, entry, resolver) + W.slack * Math.max(0, TARGET_SLACK_MS - spare) / 60000;
  };
  // Shift bounds as plain numbers, once.
  const shiftMs = new Map();
  for (const [name, shifts] of shiftsByName) {
    shiftMs.set(name, shifts.map(sh => ({ s: sh.shiftStart.getTime(), e: sh.shiftEnd.getTime() })));
  }
  // Minutes worked past the end of the shift(s) the list's tasks start in —
  // the same figure routeStats gives — optionally with `add` included or the
  // task `skipId` left out.
  const overtimeOf = (name, list, add, skipId) => {
    let total = 0;
    for (const { s: shS, e: shE } of shiftMs.get(name) || []) {
      let maxEnd = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (skipId !== undefined && t.id === skipId) continue;
        const ts = t.start.getTime();
        if (ts >= shS && ts <= shE && !ctx.has(t)) {
          const te = t.end.getTime();
          if (te > maxEnd) maxEnd = te;
        }
      }
      if (add) {
        const ts = add.start.getTime();
        if (ts >= shS && ts <= shE) {
          const te = add.end.getTime();
          if (te > maxEnd) maxEnd = te;
        }
      }
      if (maxEnd > shE) total += (maxEnd - shE) / 60000;
    }
    return W.overtime * total;
  };
  const overCurrent = name => {
    let v = overCache.get(name);
    if (v === undefined) { v = overtimeOf(name, byEmp[name] || []); overCache.set(name, v); }
    return v;
  };
  const insertIndex = (list, task) => {
    // first position whose start is later than the task's (inserts after equals)
    let lo = 0, hi = list.length;
    const ts = task.start.getTime();
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start.getTime() <= ts) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  // Hand-off part of the change if `task` were added to / taken off a list
  // (the neighbours' links only); overtime is handled separately because it
  // depends on the whole list.
  const linkInsert = (name, list, task) => {
    const i = insertIndex(list, task);
    const prev = list[i - 1] ?? null, next = list[i] ?? null;
    return linkCost(name, prev, task) + linkCost(name, task, next) - linkCost(name, prev, next);
  };
  const linkRemove = (name, list, task) => {
    const i = list.findIndex(t => t.id === task.id);
    const prev = list[i - 1] ?? null, next = list[i + 1] ?? null;
    return linkCost(name, prev, next) - linkCost(name, prev, task) - linkCost(name, task, next);
  };
  // Change in (walk + slack + overtime) cost if `task` were added to the list.
  const insertParts = (name, list, task) =>
    linkInsert(name, list, task) + overtimeOf(name, list, task) - overCurrent(name);
  // Change in the same if `task` were taken off the list.
  const removeParts = (name, list, task) =>
    linkRemove(name, list, task) + overtimeOf(name, list, null, task.id) - overCurrent(name);
  // Every employee's list carries a version that changes whenever it does, and
  // each task remembers the versions it was last fully evaluated against — so
  // a later round only re-examines (task, employee) pairs where something has
  // actually changed since, instead of the whole cross product again.
  const version = new Map();
  const invalidate = name => {
    gainCache.delete(name); overCache.delete(name); printCache.delete(name);
    version.set(name, (version.get(name) ?? 0) + 1);
  };
  const seenByTask = new Map();
  const unchangedSince = (task, A, B) => {
    const seen = seenByTask.get(task.id);
    return !!seen && seen.epoch === epoch && seen.A === (version.get(A) ?? 0) &&
      seen.B.get(B) === (version.get(B) ?? 0);
  };
  const markEvaluated = (task, A, B) => {
    let seen = seenByTask.get(task.id);
    if (!seen || seen.epoch !== epoch || seen.A !== (version.get(A) ?? 0)) {
      seen = { epoch, A: version.get(A) ?? 0, B: new Map() };
      seenByTask.set(task.id, seen);
    }
    seen.B.set(B, version.get(B) ?? 0);
  };
  // How much the employee's walking/slack/overtime cost would drop if this one
  // task were taken off them (the load term is handled separately). Used only
  // to rule out hopeless candidates: inserting a task anywhere never costs
  // less than nothing, so if removing it frees up less than a move would add,
  // that move can't help and isn't worth evaluating.
  const walkGain = (name, task) => {
    let m = gainCache.get(name);
    if (!m) { m = new Map(); gainCache.set(name, m); }
    let g = m.get(task.id);
    if (g === undefined) {
      g = -removeParts(name, byEmp[name], task);
      m.set(task.id, g);
    }
    return g;
  };
  const EPS = 1e-6;
  const reassign = (id, to) => {
    const i = indexById.get(id);
    result[i] = { ...result[i], employee: to };
    return result[i];
  };

  // Place still-unassigned tasks: cheapest direct fit, else a displacement chain.
  // A chain search that failed is only retried once the day of someone who
  // could take the task has changed since — retrying every round made the few
  // genuinely stuck tasks cost more than the whole rest of the search.
  const chainFailedAt = new Map();
  const chainStamp = task => {
    let s = epoch * 1e9;
    for (const n of eligibleOf(task).names) s += version.get(n) ?? 0;
    return s;
  };
  // ── Cross-call memory of failed chain searches (options.chainMemory) ──
  // A person's day as a fingerprint: their shifts and the ids of their tasks,
  // recomputed only after their list changed.
  const empPrint = name => {
    let p = printCache.get(name);
    if (p === undefined) {
      let text = name;
      for (const sh of shiftsByName.get(name) || []) text += '|' + sh.shiftStart.getTime() + '-' + sh.shiftEnd.getTime();
      text += '#';
      for (const t of byEmp[name] || []) text += t.id + ',';
      p = hash53(text);
      printCache.set(name, p);
    }
    return p;
  };
  // Who is on the roster, with what shifts and qualifications — only the
  // people whose entry differs from the one a search saw can have become able
  // to take something new. Shared between calls while nothing changed.
  let failures = null, rosterNow = null;
  const changedCache = new Map();
  if (chainMemory) {
    failures = chainMemory.failures ??= new Map();
    rosterNow = new Map();
    for (const [name, shifts] of shiftsByName) {
      let text = '';
      for (const sh of shifts) text += sh.shiftStart.getTime() + '-' + sh.shiftEnd.getTime() + '@' + (sh.basePos ?? '') + '[' + sh.quals.join(',') + ']';
      rosterNow.set(name, hash53(text));
    }
    const last = chainMemory.roster;
    if (last && last.size === rosterNow.size && [...rosterNow].every(([n, v]) => last.get(n) === v)) rosterNow = last;
    chainMemory.roster = rosterNow;
  }
  const rosterChangedSince = old => {
    let names = changedCache.get(old);
    if (!names) {
      names = [];
      for (const [name, v] of rosterNow) if (old.get(name) !== v) names.push(name);
      changedCache.set(old, names);
    }
    return names;
  };
  const knownHopeless = task => {
    const rec = failures?.get(task.id);
    if (!rec) return false;
    for (const [name, p] of rec.prints) if (empPrint(name) !== p) return false;
    if (rec.roster !== rosterNow) {
      for (const name of rosterChangedSince(rec.roster)) {
        if (rec.prints.has(name)) continue;
        const shifts = shiftsByName.get(name) || [];
        if (rec.tasks.some(q => shifts.some(sh => canTake(sh, q, resolver, true)))) return false;
      }
    }
    return true;
  };
  const rememberHopeless = (task, trace) => {
    const prints = new Map();
    for (const name of trace.names) prints.set(name, empPrint(name));
    failures.set(task.id, { prints, tasks: [...trace.tasks], roster: rosterNow });
  };

  const insertBacklog = () => {
    let inserted = 0;
    const pool = result.filter(t =>
      dates.includes(t.date) && !t.isLocked && t.employee === 'Не назначено' &&
      // Tasks the caller names explicitly (a changed task) are placed even
      // inside the frozen window: leaving them open there would be worse.
      (scopeTaskIds ? scopeTaskIds.has(t.id) : (!frozenBefore || t.start >= frozenBefore))
    );
    for (const task of pool) {
      if (outOfBudget()) break;
      steps++;
      const candidates = eligibleOf(task).names;
      if (candidates.length === 0) continue; // nobody could ever take it
      let best = null;
      for (const name of candidates) {
        const emp = byEmp[name];
        if (!fits(name, task, emp)) continue;
        const delta = W.load * (2 * (emp.length - ctxN(name)) + 1) + insertParts(name, emp, task);
        if (!best || delta < best.delta) best = { name, delta };
      }
      if (best) {
        const moved = reassign(task.id, best.name);
        byEmp[best.name] = insertSorted(byEmp[best.name], moved);
        invalidate(best.name);
        if (scope) scope.add(best.name);
        inserted++;
        continue;
      }
      if (chainFailedAt.get(task.id) === chainStamp(task)) continue;
      // Remembered from an earlier call: the same search would fail again.
      if (knownHopeless(task)) { chainFailedAt.set(task.id, chainStamp(task)); continue; }
      const staffByLoad = [...staff].sort(
        (a, b) => ctx.load(a.name, byEmp[a.name] || []) - ctx.load(b.name, byEmp[b.name] || [])
      );
      const trace = failures ? { names: new Set(), tasks: new Set() } : undefined;
      const chain = findChainPlacement(task, staffByLoad, byEmp, resolver, new Set(), isMovable, { left: CHAIN_NODE_BUDGET, bounds, trace, eligibleNames: t => eligibleOf(t).set });
      if (!chain) {
        chainFailedAt.set(task.id, chainStamp(task));
        if (trace) rememberHopeless(task, trace);
        continue;
      }
      for (const { task: mt, to } of chain.migrations) {
        const idx = indexById.get(mt.id);
        if (scope) {
          scope.add(to);
          if (result[idx].employee !== 'Не назначено') scope.add(result[idx].employee);
        }
        result[idx] = { ...result[idx], employee: to };
      }
      rebuildByEmp();
      inserted++;
    }
    return inserted;
  };

  let moves = 0;
  let progress = true;
  // Evaluating every (task, candidate) pair is the expensive part, so the
  // first rounds skip pairs that provably can't improve (see walkGain). That
  // bound is exact except for a rare quirk — a task overlapping a neighbour
  // (complementary same-flight work) can make an insertion cost LESS than
  // nothing — so once the pruned search stops, one more full, unpruned round
  // runs to confirm it's a true local optimum, continuing if it isn't.
  let prune = true;
  let stopped = false;
  while (progress && !stopped) {
    progress = false;

    const inserted = insertBacklog();
    if (inserted > 0) { moves += inserted; progress = true; }

    for (const isMover of phases) {
      let improved = true;
      while (improved && !stopped) {
        improved = false;
        const movers = result.filter(t => isMover(t) && inScope(t.employee));
        for (const stale of movers) {
          if (outOfBudget()) { stopped = true; break; }
          const task = result[indexById.get(stale.id)];
          if (!isMover(task) || !inScope(task.employee)) continue;
          steps++;
          const A = task.employee;
          const aTasks = byEmp[A];
          const aRest = aTasks.filter(t => t.id !== task.id);
          const gainA = walkGain(A, task);

          let best = null;

          // Only employees who could take this task at all are looked at, and
          // of those only the ones whose list (or A's) changed since this task
          // was last checked against them with nothing found.
          for (const B of eligibleOf(task).names) {
            if (B === A || !byEmp[B]) continue;
            if (prune && unchangedSince(task, A, B)) continue;
            const bTasks = byEmp[B];
            let foundHere = false;

            // Relocate `task` to B. Lower bound on the delta: B's extra load
            // cost minus what A saves.
            const loadDiff = bTasks.length - ctxN(B) - (aTasks.length - ctxN(A));
            if (!(prune && -gainA + 2 * W.load * (loadDiff + 1) + churn(task, A, B) >= -EPS) &&
                !conflictsSorted(bTasks, task, resolver, bounds)) {
              const delta = W.load * (2 * loadDiff + 2) - gainA + insertParts(B, bTasks, task) + churn(task, A, B);
              if (delta < -EPS) {
                foundHere = true;
                if (!best || delta < best.delta) best = { kind: 'relocate', B, delta };
              }
            }

            // Swap `task` with a movable task of B's.
            for (const other of bTasks) {
              if (!isMovable(other)) continue;
              if (prune && gainA + walkGain(B, other) - churn(task, A, B) - churn(other, B, A) <= EPS) continue;
              if (!staticFits(A, other)) continue;
              const bRest = bTasks.filter(t => t.id !== other.id);
              if (conflictsSorted(bRest, task, resolver, bounds) || conflictsSorted(aRest, other, resolver, bounds)) continue;
              const delta =
                linkRemove(A, aTasks, task) + linkInsert(A, aRest, other) + overtimeOf(A, aRest, other) - overCurrent(A) +
                linkRemove(B, bTasks, other) + linkInsert(B, bRest, task) + overtimeOf(B, bRest, task) - overCurrent(B) +
                churn(task, A, B) + churn(other, B, A);
              if (delta < -EPS) {
                foundHere = true;
                if (!best || delta < best.delta) best = { kind: 'swap', B, other, delta };
              }
            }

            if (prune && !foundHere) markEvaluated(task, A, B);
          }

          if (!best) continue;
          if (best.kind === 'relocate') {
            const moved = reassign(task.id, best.B);
            byEmp[A] = aRest;
            byEmp[best.B] = insertSorted(byEmp[best.B], moved);
          } else {
            const bRest = byEmp[best.B].filter(t => t.id !== best.other.id);
            const movedTask = reassign(task.id, best.B);
            const movedOther = reassign(best.other.id, A);
            byEmp[A] = insertSorted(aRest, movedOther);
            byEmp[best.B] = insertSorted(bRest, movedTask);
          }
          invalidate(A);
          invalidate(best.B);
          if (scope) scope.add(best.B);
          moves++;
          improved = true;
          progress = true;
        }
      }
    }
    if (!progress && prune && !stopped && confirmRound) { prune = false; seenByTask.clear(); progress = true; }
  }

  return { tasks: result, moves, steps, timeCut: cutBy === 'deadline', touched: touchedList(), terminationReason: cutBy ?? 'converged' };
}

// Regret-2 construction (replaces the hardest-first order of PASS 1).
// "Hardest first" only counts how many people are qualified at all; it can't
// see that one of them is far better for this task than the rest, or that a
// colleague needs that same person. Regret does: for every open task, take
// its cheapest feasible employee (c1) and second cheapest (c2); regret =
// c2 − c1, i.e. what it costs if the best slot goes to someone else (a task
// with only one feasible employee has infinite regret). Place the task with
// the biggest regret at its best slot, re-cost the employee who just got a
// task, repeat. A placement's cost is the weighted marginal cost: the load it
// adds (2n+1 for an employee already at n) plus the insertion walking
// distance. Returns the tasks nobody could take, for the later passes.
function constructRegret(toAssign, staff, assignedTasks, result, index, resolver, W, ctx = NO_CONTEXT) {
  const costFor = (task, s) => {
    if (!canTake(s, task, resolver)) return null;
    const emp = assignedTasks[s.name] || [];
    if (hasConflict(emp, task, resolver)) return null;
    return W.load * (2 * ctx.load(s.name, emp) + 1) + W.walk * scoreEmployee(s, assignedTasks, task, resolver).dist;
  };
  // Best and second-best options must be two different PEOPLE: one person
  // with two shifts in the window is still a single alternative, and counting
  // it twice would make a task look less urgent than it is.
  const summarize = costs => {
    let c1 = null, i1 = -1;
    for (let i = 0; i < costs.length; i++) {
      const c = costs[i];
      if (c !== null && (c1 === null || c < c1)) { c1 = c; i1 = i; }
    }
    let c2 = null, i2 = -1;
    if (i1 >= 0) {
      const name1 = staff[i1].name;
      for (let i = 0; i < costs.length; i++) {
        const c = costs[i];
        if (c !== null && staff[i].name !== name1 && (c2 === null || c < c2)) { c2 = c; i2 = i; }
      }
    }
    return { c1, i1, c2, i2 };
  };

  const bounds = conflictBounds(result, resolver);
  const colsByName = new Map();
  staff.forEach((s, i) => {
    if (!colsByName.has(s.name)) colsByName.set(s.name, []);
    colsByName.get(s.name).push(i);
  });
  const table = new Map();
  const best = new Map();
  for (const t of toAssign) {
    const costs = staff.map(s => costFor(t, s));
    table.set(t.id, costs);
    best.set(t.id, summarize(costs));
  }
  const remaining = new Map(toAssign.map(t => [t.id, t]));
  const backlog = [];

  while (remaining.size > 0) {
    let pick = null;
    for (const [id, task] of remaining) {
      const b = best.get(id);
      if (b.c1 === null) { backlog.push(task); remaining.delete(id); continue; }
      const regret = b.c2 === null ? Infinity : b.c2 - b.c1;
      if (!pick || regret > pick.regret || (regret === pick.regret && b.c1 < pick.c1)) {
        pick = { task, i1: b.i1, regret, c1: b.c1 };
      }
    }
    if (!pick) break;

    // The table is kept up to date cheaply (see below), so before committing
    // the pick is re-checked against what the employee has now — a stale
    // entry must never turn into a double-booking.
    const chosen = staff[pick.i1];
    if (costFor(pick.task, chosen) === null) {
      const costs = table.get(pick.task.id);
      costs[pick.i1] = null;
      best.set(pick.task.id, summarize(costs));
      continue;
    }
    commit(result, index, assignedTasks, pick.task.id, chosen.name);
    remaining.delete(pick.task.id);

    // Only the employee who just received a task changed. Tasks it can affect
    // (a possible conflict, or a new neighbour) are re-costed in full; for the
    // rest the only effect is one more task on that employee, a flat load
    // increase. Rankings are re-derived only where that column mattered.
    const cols = colsByName.get(chosen.name);
    const P = pick.task;
    const ps = P.start.getTime(), pe = P.end.getTime();
    const lo = ps - bounds.before, hi = pe + bounds.after;
    // A task's insertion cost also depends on who its neighbours would be: the
    // new task changes that only for tasks that now sit right after it (before
    // the next task ends) or right before it (after the previous one starts).
    let hiLast = Infinity, loNext = -Infinity;
    for (const t of assignedTasks[chosen.name]) {
      if (t.id === P.id) continue;
      const te = t.end.getTime(), ts = t.start.getTime();
      if (te > pe && te < hiLast) hiLast = te;
      if (ts < ps && ts > loNext) loNext = ts;
    }
    for (const [id, task] of remaining) {
      const costs = table.get(id);
      const b = best.get(id);
      const tS = task.start.getTime(), tE = task.end.getTime();
      const near = (tS < hi && tE > lo) || (tS >= pe && tS < hiLast) || (tE <= ps && tE > loNext);
      let touched = false;
      for (const col of cols) {
        if (costs[col] === null) continue;
        costs[col] = near ? costFor(task, staff[col]) : costs[col] + 2 * W.load;
        if (costs[col] === null || b.i1 === col || b.i2 === col || (near && costs[col] < (b.c2 ?? Infinity))) {
          touched = true;
        }
      }
      if (touched) best.set(id, summarize(costs));
    }
  }
  return backlog;
}

// Best-fit construction, aimed at covering as many tasks as possible: tasks
// in order of END time, each to the qualified person who becomes free the
// latest before it starts (the smallest idle gap), ties to the person with
// the fewest qualifications (keeping versatile people free). For
// interchangeable workers this order is the classic optimal rule for fitting
// the most fixed intervals; with qualifications and shifts it is a heuristic,
// but one that packs people's days tightly instead of spreading early tasks
// thinly and fragmenting everyone's free time — which on days short of staff
// leaves fewer tasks open than regret. Load balance is left to the
// improvement search afterwards (it never gives up a placed task).
function constructBestFit(toAssign, staff, assignedTasks, result, index, resolver) {
  const order = [...toAssign].sort((a, b) => a.end - b.end || a.start - b.start);
  const backlog = [];
  for (const task of order) {
    let best = null, bestFree = -Infinity, bestBreadth = Infinity;
    for (const s of staff) {
      if (!canTake(s, task, resolver)) continue;
      const emp = assignedTasks[s.name] || [];
      if (hasConflict(emp, task, resolver)) continue;
      let free = s.shiftStart.getTime();
      for (const t of emp) {
        const te = t.end.getTime();
        if (te <= task.start.getTime() && te > free) free = te;
      }
      const breadth = s.quals.length;
      if (free > bestFree || (free === bestFree && breadth < bestBreadth)) {
        best = s; bestFree = free; bestBreadth = breadth;
      }
    }
    if (best) commit(result, index, assignedTasks, task.id, best.name);
    else backlog.push(task);
  }
  return backlog;
}

// windowDates: the planning window (e.g. selectedDate ±1 day) — tasks and
// staff shifts from any date in this window are assignable together, since
// shifts and tasks both routinely cross midnight. Defaults to just
// selectedDate if no window is given.
//
// freezeBeforeTime (optional Date): tasks starting before this instant are
// treated as effectively locked for this run regardless of their own
// isLocked flag — already-started/already-done work never gets swept up
// and reassigned just because something later in the day changed. Only
// tasks at or after this instant are reset and re-searched for a better
// assignment. Omit it to reset/reassign the whole window as before (the
// "Запустить оптимизатор" button's behavior).
//
// options.construction: 'bestfit' — see constructBestFit.
// 'regret' (default) places first whichever task would
// lose most if it missed its best employee (see constructRegret); 'greedy'
// places tasks one by one, hardest first. On the real demo tasks with a
// generated roster, regret starts from far better assignments and, when staff
// is short, leaves noticeably fewer tasks unassigned (27 vs 35 at 16 people),
// while with plenty of staff the two end up about equal after the improvement
// pass. options.weights: cost weights for 'regret' (see DEFAULT_WEIGHTS).
export function runOptimizer(tasks, staffDB, selectedDate, resolver, windowDates, freezeBeforeTime, options = {}) {
  const { tasks: normalized, skip } = normalizeTasks(tasks);
  if (skip.length === 0) return runOptimizerCore(normalized, staffDB, selectedDate, resolver, windowDates, freezeBeforeTime, options);
  const skipAt = new Set(skip.map(x => x.index));
  const computed = runOptimizerCore(normalized.filter((_, i) => !skipAt.has(i)), staffDB, selectedDate, resolver, windowDates, freezeBeforeTime, options);
  return mergeSkipped(normalized, skip, computed);
}

// The construction itself, for tasks that are already normalized (planWindow and
// applyChanges check their input once and call this directly).
function runOptimizerCore(tasks, staffDB, selectedDate, resolver, windowDates, freezeBeforeTime, options = {}) {
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const isFrozen = t => t.isLocked || (freezeBeforeTime && t.start < freezeBeforeTime);

  let result = tasks.map(t =>
    dates.includes(t.date) && !isFrozen(t)
      ? { ...t, employee: 'Не назначено' }
      : { ...t }
  );

  const staff = mergeStaffWindow(staffDB, dates);
  if (staff.length === 0) return result;
  const index = indexFirstById(result);
  const ctx = windowContext(result, dates, staff, resolver);

  let assignedTasks = {};
  for (const s of staff) assignedTasks[s.name] = [];

  // Pre-load frozen (locked, or already-started) tasks into the assignment
  // map so the passes below treat their time slots as taken. The assigned tasks
  // of the days around the window are as frozen as those (see windowContext).
  for (const t of result) {
    if (((dates.includes(t.date) && isFrozen(t)) || ctx.has(t)) && t.employee !== 'Не назначено') {
      if (!assignedTasks[t.employee]) assignedTasks[t.employee] = [];
      assignedTasks[t.employee].push(t);
    }
  }

  const toAssign = result.filter(t => dates.includes(t.date) && !isFrozen(t));

  // Sort by difficulty: tasks with fewer eligible employees go first
  // so rare/constrained tasks get first pick of available staff
  const difficulty = new Map(
    toAssign.map(t => [
      t.id,
      staff.filter(s => canTake(s, t, resolver)).length,
    ])
  );
  toAssign.sort((a, b) => {
    const diff = difficulty.get(a.id) - difficulty.get(b.id);
    return diff !== 0 ? diff : a.start - b.start;
  });

  // ── PASS 1: Greedy – best-scoring employee within shift ──────────────────
  // Load is compared before distance so work spreads across everyone
  // qualified instead of piling onto whoever happens to be positionally
  // closest each time — without this, an employee whose last task ends near
  // the next one keeps winning indefinitely while equally-qualified staff
  // sit idle (distance only breaks ties between similarly-loaded people).
  let backlog = [];
  const construction = options.construction ?? 'regret';
  if (construction === 'regret') {
    backlog = constructRegret(toAssign, staff, assignedTasks, result, index, resolver, resolveWeights(options.weights), ctx);
  } else if (construction === 'bestfit') {
    backlog = constructBestFit(toAssign, staff, assignedTasks, result, index, resolver);
  } else {
    for (const task of toAssign) {
      let bestStaff = null, bestScore = null;
      for (const s of staff) {
        if (!canTake(s, task, resolver)) continue;
        if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
        const score = scoreEmployee(s, assignedTasks, task, resolver, ctx);
        if (!bestScore || score.load < bestScore.load ||
            (score.load === bestScore.load && score.dist < bestScore.dist)) {
          bestScore = score; bestStaff = s;
        }
      }
      bestStaff ? commit(result, index, assignedTasks, task.id, bestStaff.name) : backlog.push(task);
    }
  }

  // ── PASS 2: Rotation – relocate conflicting tasks to free up a slot ──────
  // Chains through as many displacements as it takes (see
  // findChainPlacement below), not just one hop — a task only falls
  // through to PASS 3 if genuinely nobody in the pool, however rearranged,
  // can fit it. Least-loaded staff tried first (recomputed per task, since
  // assignments shift as tasks get placed) so whoever comes first
  // alphabetically/positionally doesn't soak up every task that falls
  // through to this pass.
  let remaining = [];
  const passBounds = conflictBounds(ctx.span, resolver);
  for (const task of backlog) {
    const staffByLoad = [...staff].sort(
      (a, b) => ctx.load(a.name, assignedTasks[a.name] || []) - ctx.load(b.name, assignedTasks[b.name] || [])
    );
    const chain = findChainPlacement(task, staffByLoad, assignedTasks, resolver, new Set(), t => !isFrozen(t) && !ctx.has(t), { left: CHAIN_NODE_BUDGET, bounds: passBounds });
    if (chain) {
      assignedTasks = chain.assigned;
      for (const { task: mt, to } of chain.migrations) {
        const idx = index.get(mt.id);
        result[idx] = { ...result[idx], employee: to };
      }
    } else {
      remaining.push(task);
    }
  }

  // ── PASS 3: Relax shift constraint (finish slightly late) ─────────────────
  // A qualified employee exists but the task runs a bit past their shift end.
  // Only the END boundary is relaxed, and only by the policy's overtime
  // allowance (maxOvertimeMin) — the task must START during the shift, so
  // this is "stay a little late to finish", never "show up after your shift
  // ended" or "work an extra half-shift". Assign to the least-loaded
  // qualified employee who has no time conflict.
  //
  // There used to be a PASS 4 here that force-assigned whatever was left,
  // ignoring conflicts entirely as a "guarantee zero backlog" last resort —
  // that's exactly what put two overlapping, different-stand tasks on the
  // same employee. A task nobody can take without a real double-booking now
  // stays in the backlog instead, for a dispatcher to resolve manually
  // (including a deliberate forced override, if that's genuinely wanted).
  for (const task of remaining) {
    let bestStaff = null, bestLoad = Infinity;
    for (const s of staff) {
      if (!canTake(s, task, resolver, true)) continue;
      if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
      const load = ctx.load(s.name, assignedTasks[s.name] || []);
      if (load < bestLoad) { bestLoad = load; bestStaff = s; }
    }
    if (bestStaff) commit(result, index, assignedTasks, task.id, bestStaff.name);
    // Otherwise the task stays unassigned — no qualified, on-shift, conflict-free employee exists.
  }

  return result;
}

// ── Search limits ───────────────────────────────────────────────────────────
// An identical request must give an identical plan on a busy machine and an
// idle one, so every search stops on a COUNT of work done, never on the clock.
// Time is only a safety net against a runaway; a search the net cuts says so
// (timeCut: true, terminationReason: 'deadline') because that one result is
// not reproducible.
//
// LNS attempts in a full planning run. Measured on the three heaviest real days
// (600-700 tasks, 1700-1900 in the 3-day window): 3 s of work bought 164-232
// attempts, so 200 is about the 3 s the old fixed budget gave (2.7-3.6 s). More
// is not worth it: from 100 to 400 attempts the open tasks of each of those
// days went down by one while the time quadrupled.
export const DEFAULT_LNS_ITERATIONS = 200;
const SAFETY_NET_MS = 30000;
const LNS_SAFETY_MS = SAFETY_NET_MS;
// Escalation after a batch update: attempts. Its own stop after 25 attempts in
// a row that change nothing ended every measured batch within 45 attempts, so
// this is a cap with plenty of room (~15 ms an attempt), not a working limit.
const ESCALATE_ITERATIONS = 200;
// Candidate tasks one batch update's improvement search may examine. Measured
// on six real days, batches of 20 and 100 changes (mixed shifts, additions,
// cancellations), no limit: 300-2500 candidates for 20 changes (median ~700),
// 1800-9100 for 100 (median ~2800). 15000 is five times that median: it never
// cut a measured batch, and at 0.1-0.17 ms a candidate it bounds the search at
// about 1.5-2.5 s, the old 1.5 s budget's worth.
export const DEFAULT_IMPROVE_MAX_STEPS = 15000;
const MIN_DATE = new Date(-8.64e15);
// Default price, in cost units, of moving an already-published assignment
// during an incremental update (×3 inside the stability window). For scale:
// one step of load balance is 200–300 units, walking is 1 unit per metre.
const STABILITY_MOVE_COST = 300;
const MAX_DATE = new Date(8.64e15);

// Incremental update for a batch of task changes — the entry point a backend
// calls when the task generator sends, say, 20 new/changed/cancelled tasks.
// Re-solving the whole window for that would be wasteful and would also churn
// assignments nobody asked to touch; this repairs only what the batch
// affects and lets the effect spread exactly as far as it actually helps.
//
//   changes — task objects to add or update (matched by `id`; for an existing
//             task only the supplied fields change, its assignment and lock
//             are kept), or { id, removed: true } to drop one. Applied in
//             order, so several changes to one id in a batch stack up. Times
//             may be Dates, epoch milliseconds or ISO strings. A change that
//             cannot be applied (no id, an unreadable time, an end not after
//             the start, an unknown id without both times) is skipped and
//             reported in `rejected`; the rest of the batch still goes through.
//
// Steps: apply the changes → unassign changed tasks their employee can no
// longer take (qualification / shift) → repair conflicts they caused (chains
// of displacements, nothing before `now` is touched) → place the open
// changed tasks and run the improvement search starting from the affected
// employees only; every employee a move touches joins the search, so the
// change ripples outward until nothing more improves.
//
// options:
//   now                — Date (or epoch ms / ISO string): tasks starting before
//                        now + frozenWindowMs are hard-frozen for the
//                        improvement search (only the conflict repair may touch
//                        them, when genuinely broken); omit for no freeze. A
//                        `now` that cannot be read applies NO change (every one
//                        is rejected as BAD_NOW): without it the history would
//                        not be protected.
//   frozenWindowMs     — default 1 h
//   stabilityWindowMs  — default 3 h; the improvement search settles tasks
//                        before now + this first, then the rest
//   farReshuffle       — true: also fully re-optimize everything beyond the
//                        stability window and search the whole pool (what the
//                        frontend's delay module does). Default false: purely
//                        incremental.
//   escalate           — default true. If a changed task is still without an
//                        employee after the incremental repair, run a short
//                        coverage-only LNS around exactly those tasks
//                        (escalateIterations, default 200, and it also stops
//                        after 25 attempts in a row that change nothing) and
//                        keep it only if it places more of them. Never touches
//                        the frozen window, never reshuffles for cost.
//   improveMaxSteps    — the limit of the incremental improvement search, in
//                        candidate tasks examined (default
//                        DEFAULT_IMPROVE_MAX_STEPS); placing the changed tasks
//                        always comes first, the polishing after it is what may
//                        be cut. A count, not seconds: the same batch gives the
//                        same plan on any machine.
//   improveBudgetMs, escalateBudgetMs — safety nets in milliseconds (default
//                        30 s each), not the working limits. If one fires the
//                        result carries timeCut: true and
//                        terminationReason: 'deadline' and is not reproducible.
//   stability          — price of moving a published assignment (default
//                        300 cost units, ×3 inside the stability window);
//                        0 = no price, every improvement is taken
//   policy             — the operating policy for this call (see
//                        DEFAULT_POLICY); omitted = the current one
//   weights, construction — see improveAssignment / runOptimizer
//
// Returns { tasks, touched, changedIds, unplaced, repairs, escalated,
// needsDecision, violations, rejected, timeCut, terminationReason,
// improveTermination, work, ms }: `unplaced` are changed tasks that still have
// no employee; `repairs` describes each task the conflict repair moved or
// dropped; `work` is the amount of search done (candidate tasks examined,
// escalation attempts), for choosing the limits; `rejected` =
// [{ id, reason, source }] lists what took no part ('change' = an entry of the
// batch, 'task' = a task of the plan that is unusable and comes back open).
export function applyChanges(tasks, staffDB, selectedDate, resolver, windowDates, changes, options) {
  const opts = options || {};
  return runWithPolicy(opts.policy, () => applyChangesCore(tasks, staffDB, selectedDate, resolver, windowDates, changes, opts));
}

function applyChangesCore(tasks, staffDB, selectedDate, resolver, windowDates, changes, options) {
  const {
    frozenWindowMs = 3600000, stabilityWindowMs = 3 * 3600000,
    farReshuffle = false, escalate = true, weights, construction,
    stability = STABILITY_MOVE_COST, escalateBudgetMs = SAFETY_NET_MS, improveBudgetMs = SAFETY_NET_MS,
    escalateIterations = ESCALATE_ITERATIONS, improveMaxSteps = DEFAULT_IMPROVE_MAX_STEPS,
  } = options;
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  // Wall-clock per stage, returned for monitoring (the backend's latency budget).
  const ms = {};
  let tick = Date.now();
  const lap = name => { const t = Date.now(); ms[name] = t - tick; tick = t; };
  const rejected = [];

  let now;
  let nowUnreadable = false;
  if (options.now !== undefined && options.now !== null) {
    now = toInstant(options.now);
    if (!isValidDate(now)) { now = undefined; nowUnreadable = true; }
  }
  const frozenBefore = now ? new Date(now.getTime() + frozenWindowMs) : undefined;
  const stabilityEnd = now ? new Date(now.getTime() + stabilityWindowMs) : undefined;

  // 0. The plan as given: tasks without a usable id are set aside for good; a
  //    task with an unusable time stays in the pool — a change may repair it —
  //    and is set aside after the changes if it is still unusable.
  const { tasks: baseNorm, skip: baseSkip } = normalizeTasks(tasks);
  const aside = new Set();
  for (const x of baseSkip) {
    if (x.reason === 'NO_ID' || x.reason === 'DUPLICATE_ID' || x.reason === 'NOT_AN_OBJECT') {
      aside.add(x.index);
      rejected.push({ id: x.id, reason: x.reason, source: 'task' });
    }
  }
  const byId = new Map();
  baseNorm.forEach((t, i) => { if (!aside.has(i)) byId.set(t.id, t); });

  // The finished plan in the original order: set-aside and unusable tasks open
  // in their own places, new tasks after the old ones. (Nothing to rearrange
  // when everything was usable — the common case.)
  const removedIds = new Set();
  const assemble = (computed, unusable) => {
    if (aside.size === 0 && unusable.length === 0) return computed;
    const computedById = new Map(computed.map(t => [t.id, t]));
    const unusableById = new Map(unusable.map(t => [t.id, openCopy(t)]));
    const out = [];
    const placed = new Set();
    baseNorm.forEach((t, i) => {
      if (aside.has(i)) { if (!removedIds.has(t.id)) out.push(openCopy(t)); return; }
      const f = computedById.get(t.id) ?? unusableById.get(t.id);
      if (f) { out.push(f); placed.add(t.id); }
    });
    for (const f of computed) if (!placed.has(f.id)) out.push(f);
    return out;
  };

  if (nowUnreadable) {
    const changeList = Array.isArray(changes) ? changes : [];
    rejected.push(...changeList.map(c => ({ id: c && typeof c === 'object' ? (c.id ?? null) : null, reason: 'BAD_NOW', source: 'change' })));
    if (!Array.isArray(changes)) rejected.push({ id: null, reason: 'CHANGES_NOT_ARRAY', source: 'change' });
    const usable = [], unusable = [];
    for (const t of byId.values()) (taskProblem(t) ? unusable : usable).push(t);
    for (const t of unusable) rejected.push({ id: t.id, reason: taskProblem(t), source: 'task' });
    return {
      tasks: assemble(usable, unusable), touched: [], changedIds: [], unplaced: [], repairs: [], escalated: false,
      needsDecision: [], violations: validatePlan(usable, staffDB, selectedDate, resolver, dates), rejected,
      timeCut: false, terminationReason: 'rejected', improveTermination: 'skipped',
      work: { improveSteps: 0, escalateIterations: 0 }, ms,
    };
  }

  // 1. Apply the changes; remember which employees they touch.
  const touched = new Set();
  const changedIds = new Set();
  let batch = changes;
  if (!Array.isArray(batch)) {
    rejected.push({ id: null, reason: 'CHANGES_NOT_ARRAY', source: 'change' });
    batch = [];
  }
  const reject = (c, reason) => rejected.push({ id: c && typeof c === 'object' ? (c.id ?? null) : null, reason, source: 'change' });
  for (const c of batch) {
    if (!c || typeof c !== 'object') { reject(c, 'BAD_CHANGE'); continue; }
    if (c.id === undefined || c.id === null || c.id === '') { reject(c, 'NO_ID'); continue; }
    const old = byId.get(c.id);
    if (c.removed) {
      if (old && old.employee !== OPEN_EMPLOYEE) touched.add(old.employee);
      byId.delete(c.id);
      removedIds.add(c.id);
      continue;
    }
    // The supplied fields; one left undefined keeps the task's own value
    // (spreading `undefined` over a field used to wipe it).
    const fields = {};
    for (const [k, v] of Object.entries(c)) if (v !== undefined) fields[k] = v;
    let badTime = null;
    for (const k of ['start', 'end', 'baseStart', 'baseEnd']) {
      if (fields[k] === undefined) continue;
      const d = toInstant(fields[k]);
      if (!isValidDate(d)) { badTime = k === 'start' ? 'BAD_START' : k === 'end' ? 'BAD_END' : 'BAD_BASE_TIME'; break; }
      fields[k] = d;
    }
    if (badTime) { reject(c, badTime); continue; }
    const next = normalizeTask(old
      ? { ...old, ...fields }
      : { employee: OPEN_EMPLOYEE, isLocked: false, baseStart: fields.start, baseEnd: fields.end, ...fields });
    const problem = taskProblem(next);
    if (problem) {
      reject(c, !old && (!isValidDate(next.start) || !isValidDate(next.end)) ? 'MISSING_TIMES' : problem);
      continue;
    }
    if (old && old.employee !== OPEN_EMPLOYEE) touched.add(old.employee);
    byId.set(c.id, next);
    removedIds.delete(c.id);
    changedIds.add(c.id);
  }
  const usable = [], unusable = [];
  for (const t of byId.values()) (taskProblem(t) ? unusable : usable).push(t);
  for (const t of unusable) rejected.push({ id: t.id, reason: taskProblem(t), source: 'task' });
  let result = usable;

  // 2. An assignment its employee can no longer take goes back to open — not
  //    only for the tasks in the batch: staffDB is the current truth about who
  //    is on shift with which qualifications, so someone who called in sick,
  //    whose shift was shortened or who lost a qualification shows up here as
  //    every one of their future tasks no longer fitting. Work that already
  //    started (before `now`) is history and stays as recorded. A locked task
  //    is the dispatcher's decision and is not silently undone — it is
  //    reported back (`needsDecision`) instead.
  const shiftsByName = new Map();
  for (const sh of mergeStaffWindow(staffDB, dates)) {
    if (!shiftsByName.has(sh.name)) shiftsByName.set(sh.name, []);
    shiftsByName.get(sh.name).push(sh);
  }
  const needsDecision = [];
  result = result.map(t => {
    if (!dates.includes(t.date) || t.employee === 'Не назначено') return t;
    if (now && t.start < now && !changedIds.has(t.id)) return t;
    const ok = (shiftsByName.get(t.employee) || []).some(sh => canTake(sh, t, resolver, true));
    if (ok) return t;
    if (t.isLocked) { needsDecision.push(t.id); return t; }
    touched.add(t.employee);
    changedIds.add(t.id);
    return { ...t, employee: 'Не назначено' };
  });

  // 3. (Optional) full free re-optimization beyond the stability window.
  if (farReshuffle) {
    result = runOptimizerCore(result, staffDB, selectedDate, resolver, dates, stabilityEnd, { weights, construction });
  }

  lap('prepare');
  // 4. Repair conflicts the changes caused. Nothing before `now` moves.
  const repair = patchConflicts(result, staffDB, selectedDate, resolver, dates, now ?? MIN_DATE, MAX_DATE, { frozenBefore });
  result = repair.tasks;
  const placeIds = new Set(changedIds);
  for (const c of repair.changes) {
    if (c.from) touched.add(c.from);
    if (c.to) touched.add(c.to);
    if (c.backlog) placeIds.add(c.taskId);
  }
  const repairedIndex = indexFirstById(result);
  for (const id of changedIds) {
    const t = result[repairedIndex.get(id)];
    if (t && t.employee !== 'Не назначено') touched.add(t.employee);
  }

  lap('repair');
  // 5. Place what's still open and improve from the affected employees outward.
  //    In incremental mode every move of an already-published assignment
  //    has a price (more in the stability window), so the plan around the
  //    change only shifts where that clearly pays — not for every small gain.
  const moveCost = !farReshuffle && stability > 0
    ? t => (stabilityEnd && t.start < stabilityEnd ? 3 * stability : stability)
    : undefined;
  const improved = improveAssignment(result, staffDB, selectedDate, resolver, dates, {
    weights, frozenBefore, priorityUntil: stabilityEnd, moveCost,
    confirmRound: farReshuffle,
    maxSteps: farReshuffle ? undefined : improveMaxSteps,
    deadline: farReshuffle ? undefined : Date.now() + improveBudgetMs,
    scopeEmployees: farReshuffle ? undefined : touched,
    scopeTaskIds: farReshuffle ? undefined : placeIds,
  });

  const openIn = ts => ts.filter(t => dates.includes(t.date) && t.employee === 'Не назначено').length;
  const unplacedOf = ts => ts
    .filter(t => placeIds.has(t.id) && t.employee === 'Не назначено')
    .map(t => t.id);

  lap('improve');
  let finalTasks = improved.tasks;
  let escalated = false;
  let timeCut = improved.timeCut;
  let escalationIterations = 0;
  if (escalate && !farReshuffle && unplacedOf(finalTasks).length > 0) {
    // Targeted group moves around exactly the tasks still open, kept only
    // when they place more of them — not a rebuild of the rest of the day.
    const lns = lnsImprove(finalTasks, staffDB, selectedDate, resolver, dates, {
      weights, frozenBefore, coverageOnly: true, focusIds: unplacedOf(finalTasks),
      timeBudgetMs: escalateBudgetMs, maxIterations: escalateIterations,
      removeSizes: [4, 8, 16], destroyPeople: 4, stallIterations: 25,
    });
    escalationIterations = lns.iterations;
    if (lns.timeCut) timeCut = true;
    if (openIn(lns.tasks) < openIn(finalTasks)) { finalTasks = lns.tasks; escalated = true; }
  }

  lap('escalate');
  // 6. Nothing is handed back that the independent check rejects.
  const certified = certifyPlan(finalTasks, staffDB, selectedDate, resolver, dates, { keepBefore: now, mutableIds: changedIds });
  for (const id of certified.reopened) placeIds.add(id);
  lap('check');

  return {
    tasks: assemble(certified.tasks, unusable),
    touched: farReshuffle || escalated ? [] : improved.touched,
    changedIds: [...changedIds],
    unplaced: unplacedOf(certified.tasks),
    repairs: repair.changes,
    escalated,
    needsDecision,
    violations: certified.remaining,
    rejected,
    timeCut,
    terminationReason: timeCut ? 'deadline' : improved.terminationReason === 'max-steps' ? 'max-steps' : 'completed',
    improveTermination: improved.terminationReason,
    work: { improveSteps: improved.steps, escalateIterations: escalationIterations },
    ms,
  };
}

// ── Large neighbourhood search ──────────────────────────────────────────────
// The relocate/swap search stops at the first plan no SINGLE move improves.
// Some improvements need several tasks to move at once — say, freeing a
// rarely-qualified person by moving three of their tasks to three different
// colleagues so an open task can take their place. LNS does that: take a
// small group of related tasks off the plan (destroy), put them back plus
// whatever was open, regret-first with displacement chains as a fallback
// (repair), and keep the result only if it is better: fewer open tasks first,
// then lower weighted cost. Coverage is never traded for a nicer cost.
//
// Destroy operators (the research review's first set):
//   conflict — around an open task: the movable tasks near it in time of a
//              few people who could do it
//   related  — tasks close in time to a random one, sharing who could do them
//   random   — a few random movable tasks (control / diversity)
//
// options: maxIterations (the limit that decides when it stops; default
// DEFAULT_LNS_ITERATIONS), timeBudgetMs (a safety net only, default 30 s: a
// search that hits it is reported with timeCut and is no longer reproducible),
// seed (same seed + same input + same iterations = same result on any machine),
// frozenBefore (tasks starting earlier never move),
// weights, removeSizes (default [4, 8, 16]), destroyPeople (default 3),
// focusDates (open tasks of these dates are targeted first), coverageOnly
// (only try to place open tasks — focusIds, if given — and accept a change
// only when it places more; used to repair a batch update without
// reshuffling the plan for cost), stallIterations (stop after this many
// attempts in a row without an accepted change).
// Returns { tasks, iterations, accepted, terminationReason, timeCut }.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lnsImprove(tasks, staffDB, selectedDate, resolver, windowDates, options = {}) {
  const {
    timeBudgetMs = LNS_SAFETY_MS, maxIterations = DEFAULT_LNS_ITERATIONS, seed = 1, frozenBefore, weights,
    removeSizes = [4, 8, 16], destroyPeople = 3, focusDates, coverageOnly = false, focusIds,
    stallIterations = Infinity,
  } = options;
  const W = resolveWeights(weights);
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const staff = mergeStaffWindow(staffDB, dates);
  const result = tasks.map(t => ({ ...t }));
  if (staff.length === 0) return { tasks: result, iterations: 0, accepted: 0, terminationReason: 'no-staff', timeCut: false };

  const deadline = Date.now() + timeBudgetMs;
  const rnd = mulberry32(seed);
  const ctx = windowContext(result, dates, staff, resolver);
  const lnsBounds = conflictBounds(ctx.span, resolver);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  // A uniform shuffle from the search's own stream (Fisher-Yates). `sort(() =>
  // rnd() - 0.5)` is not one: the comparator contradicts itself, so the order
  // is biased and depends on the engine's sorting algorithm.
  const shuffled = arr => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const OPEN = 'Не назначено';
  const inWin = t => dates.includes(t.date);
  // (the days around the window are in the lists as context and never move)
  const canMove = t => inWin(t) && !t.isLocked && (!frozenBefore || t.start >= frozenBefore);

  const shiftsByName = new Map();
  for (const s of staff) {
    if (!shiftsByName.has(s.name)) shiftsByName.set(s.name, []);
    shiftsByName.get(s.name).push(s);
  }
  const eligibleMemo = new Map();
  const eligibleOf = t => {
    let e = eligibleMemo.get(t.id);
    if (!e) {
      e = [];
      for (const [name, shifts] of shiftsByName) if (shifts.some(s => canTake(s, t, resolver, true))) e.push(name);
      eligibleMemo.set(t.id, e);
    }
    return e;
  };

  // Current plan: name -> tasks ordered by start; employee costs cached.
  const byId = new Map(result.map(t => [t.id, t]));
  let lists = {};
  for (const name of shiftsByName.keys()) lists[name] = [];
  for (const t of result) {
    if ((!inWin(t) && !ctx.has(t)) || t.employee === OPEN) continue;
    (lists[t.employee] ??= []).push(t);
  }
  for (const l of Object.values(lists)) l.sort((a, b) => a.start - b.start);
  const costOf = (name, list) => employeeCost(W, shiftsByName.get(name), list, resolver, ctx, ctx.load(name, list));
  const empCost = new Map(Object.entries(lists).map(([n, l]) => [n, costOf(n, l)]));
  let openSet = new Set(result.filter(t => inWin(t) && t.employee === OPEN && canMove(t)).map(t => t.id));
  const owner = new Map();
  for (const [n, l] of Object.entries(lists)) for (const t of l) owner.set(t.id, n);

  const movableIds = () => {
    const ids = [];
    for (const [id, n] of owner) if (canMove(byId.get(id)) && shiftsByName.has(n)) ids.push(id);
    return ids;
  };

  // ── destroy ──
  const destroyConflict = k => {
    const candidates = [...openSet].filter(id =>
      eligibleOf(byId.get(id)).length > 0 && (!focusIds || focusIds.includes(id)));
    if (candidates.length === 0) return null;
    // Open tasks of the dates that matter most (the selected day) first.
    const focused = focusDates ? candidates.filter(id => focusDates.includes(byId.get(id).date)) : [];
    const target = byId.get(pick(focused.length > 0 && rnd() < 0.8 ? focused : candidates));
    const lo = target.start.getTime() - 3600000, hi = target.end.getTime() + 3600000;
    const people = shuffled(eligibleOf(target)).slice(0, destroyPeople);
    const removed = [];
    for (const n of people) {
      for (const t of lists[n] || []) {
        if (removed.length >= k) break;
        if (canMove(t) && t.end.getTime() > lo && t.start.getTime() < hi) removed.push(t.id);
      }
    }
    // open tasks around the same moment ride along as targets
    const targets = [target.id];
    for (const id of openSet) {
      if (targets.length >= 4) break;
      const t = byId.get(id);
      if (id !== target.id && t.end.getTime() > lo && t.start.getTime() < hi) targets.push(id);
    }
    return { removed, targets };
  };
  const destroyRelated = k => {
    const ids = movableIds();
    if (ids.length === 0) return null;
    const seedTask = byId.get(pick(ids));
    const seedElig = new Set(eligibleOf(seedTask));
    const scored = ids
      .map(id => byId.get(id))
      .filter(t => t.id === seedTask.id || eligibleOf(t).some(n => seedElig.has(n)))
      .map(t => ({ id: t.id, d: Math.abs(t.start - seedTask.start) + rnd() * 600000 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)
      .map(x => x.id);
    const targets = [...openSet].filter(id => {
      const t = byId.get(id);
      return Math.abs(t.start - seedTask.start) < 2 * 3600000;
    }).slice(0, 4);
    return { removed: scored, targets };
  };
  const destroyRandom = k => {
    const ids = movableIds();
    if (ids.length === 0) return null;
    const removed = new Set();
    for (let i = 0; i < k * 3 && removed.size < k; i++) removed.add(pick(ids));
    return { removed: [...removed], targets: [...openSet].slice(0, 2) };
  };

  // ── repair ── on a copy-on-write view of the lists
  const repair = (cand, toPlace) => {
    const placeOptions = t => {
      const opts = [];
      for (const n of eligibleOf(t)) {
        const l = cand[n] || [];
        if (conflictsUnsorted(l, t)) continue;
        const nl = insertSorted(l, t);
        opts.push({ n, nl, c: costOf(n, nl) - costOf(n, l) });
      }
      return opts;
    };
    const left = new Set(toPlace);
    const unplaced = [];
    while (left.size > 0) {
      let best = null;
      for (const id of left) {
        const t = byId.get(id);
        const opts = placeOptions(t);
        if (opts.length === 0) { best = { id, none: true }; break; }
        let o1 = null, o2 = null;
        for (const o of opts) {
          if (!o1 || o.c < o1.c) { o2 = o1; o1 = o; } else if (!o2 || o.c < o2.c) { o2 = o; }
        }
        const regret = o2 ? o2.c - o1.c : Infinity;
        if (!best || regret > best.regret || (regret === best.regret && o1.c < best.o.c)) best = { id, o: o1, regret };
      }
      left.delete(best.id);
      if (best.none) { unplaced.push(best.id); continue; }
      cand[best.o.n] = best.o.nl;
    }
    // what regret couldn't place: displacement chains among movable work
    const still = [];
    for (const id of unplaced) {
      const t = byId.get(id);
      const staffByLoad = [...staff].sort((a, b) => ctx.load(a.name, cand[a.name] || []) - ctx.load(b.name, cand[b.name] || []));
      const chain = findChainPlacement(t, staffByLoad, cand, resolver, new Set(), canMove, { left: 60, bounds: lnsBounds });
      if (!chain) { still.push(id); continue; }
      for (const n of Object.keys(chain.assigned)) {
        if (chain.assigned[n] !== cand[n]) cand[n] = [...chain.assigned[n]].sort((a, b) => a.start - b.start);
      }
    }
    return still;
  };
  const conflictsUnsorted = (list, t) => list.some(x => conflictsWith(x, t, resolver));

  let iterations = 0, accepted = 0, sinceAccept = 0;
  let terminationReason = 'budget';
  while (iterations < maxIterations) {
    if (Date.now() > deadline) { terminationReason = 'deadline'; break; }
    iterations++;
    const k = pick(removeSizes);
    const r = rnd();
    let d;
    if (coverageOnly) {
      d = destroyConflict(k);
      if (!d) { terminationReason = 'nothing-to-place'; break; }
    } else {
      if (openSet.size > 0 && r < 0.5) d = destroyConflict(k);
      else if (r < 0.8) d = destroyRelated(k);
      else d = destroyRandom(k);
      if (!d) d = destroyRelated(k) || destroyRandom(k);
    }
    if (!d || (d.removed.length === 0 && d.targets.length === 0)) { terminationReason = 'nothing-to-move'; break; }

    const cand = { ...lists };
    const removedSet = new Set(d.removed);
    for (const id of d.removed) {
      const n = owner.get(id);
      cand[n] = cand[n].filter(t => t.id !== id);
    }
    const toPlace = [...d.removed, ...d.targets.filter(id => !removedSet.has(id))];
    const still = repair(cand, toPlace);

    // evaluate: open count first, then cost over the employees that changed
    const changed = Object.keys(cand).filter(n => cand[n] !== lists[n]);
    const openBefore = openSet.size;
    const stillSet = new Set(still);
    const newOpen = new Set([...openSet].filter(id => !toPlace.includes(id) || stillSet.has(id)));
    for (const id of still) newOpen.add(id);
    let delta = 0;
    const newCosts = new Map();
    for (const n of changed) {
      const c = costOf(n, cand[n]);
      newCosts.set(n, c);
      delta += c - (empCost.get(n) ?? 0);
    }
    const better = newOpen.size < openBefore || (!coverageOnly && newOpen.size === openBefore && delta < -1e-6);
    if (!better) {
      if (++sinceAccept >= stallIterations) { terminationReason = 'stalled'; break; }
      continue;
    }
    sinceAccept = 0;

    accepted++;
    for (const n of changed) {
      lists[n] = cand[n];
      empCost.set(n, newCosts.get(n));
      for (const t of cand[n]) owner.set(t.id, n);
    }
    for (const id of still) owner.delete(id);
    openSet = newOpen;
  }
  if (iterations >= maxIterations && terminationReason === 'budget') terminationReason = 'iterations';

  const out = result.map(t => {
    if (!inWin(t) || !canMove(t)) return t;
    const n = owner.get(t.id);
    const emp = n ?? OPEN;
    return emp === t.employee ? t : { ...t, employee: emp };
  });
  return { tasks: out, iterations, accepted, terminationReason, timeCut: terminationReason === 'deadline' };
}

// ── Lower bound on open tasks ───────────────────────────────────────────────
// How many tasks must stay open whatever any optimizer does — so a backlog
// can be told apart as "the roster is short here" versus "the search could do
// better". At any moment the tasks running then each need a different person
// who holds their qualifications and is on shift; a maximum matching between
// them gives how many can be covered at once, and the rest can't be. Tasks
// nobody at all could take add on top. Skills and shifts are relaxed
// generously (overtime allowance counted, walking ignored), so the figure
// never overstates the minimum. Not valid when the policy lets one person do
// overlapping tasks — then `bound` is null.
// Returns { bound, noEligible, peak: { at, active, coverable } | null,
// bottlenecks: [{ at, active, coverable, deficit }] } — the separate moments
// the bound adds up, in time order.
//
// options.keepUncovered: keep tasks nobody on shift can take inside the
// moments instead of counting them apart — what "how many more people are
// needed at once" wants, since a task with no one on shift at its time is
// exactly a moment that needs one more person.
export function unassignedLowerBound(tasks, staffDB, selectedDate, windowDates, options = {}) {
  if (POLICY.sameFlightOverlap) return { bound: null, noEligible: null, peak: null, bottlenecks: [] };
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const staff = mergeStaffWindow(staffDB, dates);
  const names = [...new Set(staff.map(s => s.name))];
  const nameIdx = new Map(names.map((n, i) => [n, i]));
  const inWin = tasks.filter(t => dates.includes(t.date));

  const elig = new Map();
  let noEligible = 0;
  const pool = [];
  for (const t of inWin) {
    const set = new Set();
    for (const s of staff) {
      if (hasAllQuals(s.quals, t) && (fitsShift(s, t, null, false) || fitsShift(s, t, null, true))) set.add(nameIdx.get(s.name));
    }
    if (set.size === 0 && !options.keepUncovered) { noEligible++; continue; }
    elig.set(t.id, [...set]);
    pool.push(t);
  }

  const match = active => {
    const owner = new Map(); // person index -> task id
    const order = [...active].sort((a, b) => elig.get(a.id).length - elig.get(b.id).length);
    let matched = 0;
    for (const t of order) {
      const seen = new Set();
      const tryAssign = id => {
        for (const p of elig.get(id)) {
          if (seen.has(p)) continue;
          seen.add(p);
          const cur = owner.get(p);
          if (cur === undefined || tryAssign(cur)) { owner.set(p, id); return true; }
        }
        return false;
      };
      if (tryAssign(t.id)) matched++;
    }
    return matched;
  };

  // Only maximal sets of simultaneous tasks matter: right after the last task
  // that starts before the earliest of the running ones ends.
  const byStart = [...pool].sort((a, b) => a.start - b.start);
  let active = [];
  const short = [];
  for (let i = 0; i < byStart.length; i++) {
    const t = byStart[i];
    const now = t.start.getTime();
    active = active.filter(x => x.end.getTime() > now);
    active.push(t);
    const next = byStart[i + 1];
    const minEnd = Math.min(...active.map(x => x.end.getTime()));
    if (next && next.start.getTime() < minEnd) continue;
    const coverable = match(active);
    const deficit = active.length - coverable;
    if (deficit > 0) short.push({ at: new Date(now), active: active.length, coverable, deficit, ids: active.map(x => x.id) });
  }
  // Separate bottlenecks add up: if two moments share no task, the tasks left
  // open at one are different tasks from those left open at the other. So
  // pick moments greedily, worst first, keeping only those that share no task
  // with one already picked — any such set gives a valid bound, and adding
  // them up is far tighter than the single worst moment (which ignored, say,
  // a morning shift-change gap and a late-evening peak on the same day).
  short.sort((a, b) => b.deficit - a.deficit);
  const used = new Set();
  const picked = [];
  for (const m of short) {
    if (m.ids.some(id => used.has(id))) continue;
    for (const id of m.ids) used.add(id);
    picked.push(m);
  }
  const strip = m => (m ? { at: m.at, active: m.active, coverable: m.coverable } : null);
  return {
    bound: noEligible + picked.reduce((sum, m) => sum + m.deficit, 0),
    noEligible,
    peak: strip(short[0]),
    bottlenecks: picked.sort((a, b) => a.at - b.at).map(m => ({ ...strip(m), deficit: m.deficit })),
  };
}

// ── Full planning run ───────────────────────────────────────────────────────
// What the "Запустить оптимизатор" button does, as one function so the
// browser worker, its synchronous fallback and a future backend all run the
// same pipeline: construction → improvement → bounded LNS → independent
// check (anything it rejects goes back to the open list) → lower bound.
// options: weights, seed,
// lnsIterations — LNS attempts (default DEFAULT_LNS_ITERATIONS; 0 skips LNS):
//   the limit that decides when the search stops, so one input gives one plan
//   on any machine;
// lnsBudgetMs — a safety net in milliseconds (default 30 s), not the working
//   limit; 0 skips LNS. If it fires, stats.timeCut is true and the result is
//   not reproducible;
// construction ('auto' default: the better of 'regret' and 'bestfit' after
//   construction; or either one explicitly);
// policy — the operating policy for this call (see DEFAULT_POLICY); omitted =
//   the current one.
// Tasks that cannot be calculated (no id, an unreadable time, end not after
// start, a repeated id) take no part and come back open in their places;
// stats.invalid says which and why.
// Returns { tasks, stats } — stats has the open-task count after each stage,
// timings, why each search stopped, any violations left (locked tasks only),
// the lower bound on open tasks, timeCut / terminationReason ('deadline' when a
// time safety net cut a search, else 'completed') and invalid.
export function planWindow(tasks, staffDB, selectedDate, resolver, windowDates, options) {
  const opts = options || {};
  return runWithPolicy(opts.policy, () => planWindowCore(tasks, staffDB, selectedDate, resolver, windowDates, opts));
}

function planWindowCore(tasks, staffDB, selectedDate, resolver, windowDates, options) {
  const {
    weights, lnsIterations = DEFAULT_LNS_ITERATIONS, lnsBudgetMs = LNS_SAFETY_MS, seed = 1, lnsOptions,
    construction = 'auto',
  } = options;
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const openIn = ts => ts.filter(t => dates.includes(t.date) && t.employee === 'Не назначено').length;
  const { tasks: normalized, skip } = normalizeTasks(tasks);
  if (skip.length > 0) {
    const skipAt = new Set(skip.map(x => x.index));
    tasks = normalized.filter((_, i) => !skipAt.has(i));
  } else {
    tasks = normalized;
  }
  const ms = {};
  let t0 = Date.now();
  // 'auto': build with both constructions and carry on with the one that
  // leaves fewer of the selected day's tasks open (ties: regret, which walks
  // less). Best-fit wins clearly on days short of staff (31.08: 77 vs 93 open
  // after construction, 75 vs 85 at the end); elsewhere they are within a
  // task or two. Construction is the cheap part, so this costs about a second.
  let built, chosen = construction;
  if (construction === 'auto') {
    const openDayOf = ts => ts.filter(t => t.date === selectedDate && t.employee === 'Не назначено').length;
    const viaRegret = runOptimizerCore(tasks, staffDB, selectedDate, resolver, dates, undefined, { weights, construction: 'regret' });
    const viaBestFit = runOptimizerCore(tasks, staffDB, selectedDate, resolver, dates, undefined, { weights, construction: 'bestfit' });
    const useBestFit = openDayOf(viaBestFit) < openDayOf(viaRegret);
    built = useBestFit ? viaBestFit : viaRegret;
    chosen = useBestFit ? 'bestfit' : 'regret';
  } else {
    built = runOptimizerCore(tasks, staffDB, selectedDate, resolver, dates, undefined, { weights, construction });
  }
  ms.build = Date.now() - t0; t0 = Date.now();
  const improved = improveAssignment(built, staffDB, selectedDate, resolver, dates, { weights });
  ms.improve = Date.now() - t0; t0 = Date.now();
  const lns = lnsBudgetMs > 0 && lnsIterations > 0
    ? lnsImprove(improved.tasks, staffDB, selectedDate, resolver, dates, { weights, timeBudgetMs: lnsBudgetMs, maxIterations: lnsIterations, seed, focusDates: [selectedDate], ...lnsOptions })
    : { tasks: improved.tasks, iterations: 0, accepted: 0, terminationReason: 'skipped', timeCut: false };
  ms.lns = Date.now() - t0; t0 = Date.now();
  const certified = certifyPlan(lns.tasks, staffDB, selectedDate, resolver, dates);
  // The figures that matter are the selected day's: the neighbouring days are
  // in the window as context, and their far edges lack the shifts of the days
  // beyond, so their open counts are inflated by construction. The day's own
  // bound counts only its tasks against everyone on shift in the window.
  const dayTasks = certified.tasks.filter(t => t.date === selectedDate);
  const bound = unassignedLowerBound(dayTasks, staffDB, selectedDate, dates);
  ms.check = Date.now() - t0;
  const openDay = ts => ts.filter(t => t.date === selectedDate && t.employee === 'Не назначено').length;
  const timeCut = Boolean(improved.timeCut || lns.timeCut);
  return {
    tasks: skip.length > 0 ? mergeSkipped(normalized, skip, certified.tasks) : certified.tasks,
    stats: {
      openDay: openDay(certified.tasks),
      tasksDay: certified.tasks.filter(t => t.date === selectedDate).length,
      open: { build: openIn(built), improve: openIn(improved.tasks), lns: openIn(lns.tasks), final: openIn(certified.tasks) },
      ms,
      construction: chosen,
      improveTermination: improved.terminationReason,
      lns: { iterations: lns.iterations, accepted: lns.accepted, terminationReason: lns.terminationReason },
      timeCut,
      terminationReason: timeCut ? 'deadline' : 'completed',
      invalid: summarizeSkipped(skip),
      reopenedByCheck: certified.reopened.length,
      waived: waivedAssignments(certified.tasks, staffDB, [selectedDate]).length,
      violations: certified.remaining,
      lowerBound: bound,
      cost: assignmentCost(certified.tasks, staffDB, selectedDate, resolver, dates, weights),
    },
  };
}
