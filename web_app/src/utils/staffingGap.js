// Estimates how many additional qualified staff would cover the currently
// unassigned ("backlog") tasks, broken down by required qualification and
// time interval (using the same person-based channel counting as the load
// chart, not raw task-overlap counting — see staffDemand.js), plus, when a
// full roster is available, a concrete plan of REAL named employees to call
// in or extend, arrived at by actually re-running the optimizer with them
// added — so the dispatcher sees a proposal that accounts for reshuffling
// the whole day, not just a literal one-task-at-a-time patch.
import { hasAllQuals, runOptimizer, improveAssignment } from '../optimizer.js';
import { packIntoChannels, bucketizeChannels } from './staffDemand.js';

// Merges adjacent same-count buckets into a single interval, so the result
// reads as "нужно ещё 2 чел. 14:00–17:00" instead of one row per bucket.
function mergeIntervals(buckets) {
  const intervals = [];
  let i = 0;
  while (i < buckets.length) {
    if (buckets[i].count === 0) { i++; continue; }
    const count = buckets[i].count;
    const start = buckets[i].start;
    let j = i;
    while (j + 1 < buckets.length && buckets[j + 1].count === count) j++;
    intervals.push({ start, end: buckets[j].end, count });
    i = j + 1;
  }
  return intervals;
}

export function computeStaffingGaps({ backlogTasks, windowStart, windowDays, granularityMin = 60 }) {
  if (!backlogTasks.length || !windowStart) return [];

  const byReqType = {};
  for (const t of backlogTasks) {
    const key = t.reqType || '(без квалификации)';
    if (!byReqType[key]) byReqType[key] = [];
    byReqType[key].push(t);
  }

  const gaps = [];
  for (const [reqTypeLabel, tasks] of Object.entries(byReqType)) {
    // All tasks in this group share the same required qualification(s), so
    // channel-packing here reduces to plain interval-graph coloring — the
    // minimum number of people needed at once for this one skill.
    const channels = packIntoChannels(tasks);
    const buckets = bucketizeChannels(channels, windowStart, windowDays, granularityMin);
    const intervals = mergeIntervals(buckets);
    if (intervals.length === 0) continue;

    const peak = Math.max(...buckets.map(b => b.count));
    const reqTypes = tasks[0].reqTypes && tasks[0].reqTypes.length > 0 ? tasks[0].reqTypes : [reqTypeLabel];
    gaps.push({ reqTypeLabel, reqTypes, intervals, taskCount: tasks.length, peak });
  }

  gaps.sort((a, b) => b.peak - a.peak);
  return gaps;
}

// A called-in employee should do a useful stretch of work, not travel in
// for a single 20-minute task — a fresh call-in gets a window this long to
// fill via reoptimization before anyone new is called in at all.
const CALLIN_WINDOW_MS = 6 * 3600000;
// Hard cap on how many DISTINCT people this proposes calling in/extending
// in one run, purely so a pathological backlog (e.g. a qualification
// nobody holds) can't spin the reoptimization loop forever — repeatedly
// extending the SAME person for different tasks merges into their one
// existing action (see below) and doesn't count against this again.
const MAX_ACTIONS = 40;
const MAX_ITERATIONS = 1000;
const TIER_ORDER = ['normal', 'tight', 'forced'];

// Every backlog task is tried against these tiers in order, loosest rule
// first — the dispatcher wants SOMEONE proposed for every gap, not a
// polite "nobody found", but the relaxation is bounded and labeled rather
// than unconditional: it only loosens (a) how far a shift can be
// stretched and (b) how much rest a fresh call-in needs before/after,
// never the two things that must never bend — a real qualification match
// (hasAllQuals) and no actual time overlap with that person's own other
// commitments (no double-booking). "forced" picks are exactly the ones a
// dispatcher should sanity-check before accepting.
//
// Extensions never go past 4 h: that is the daily overtime ceiling of the
// Labour Code (ст. 99 ТК РФ, as amended from 1 Sept 2026) — a shortage is a
// reason to propose something for approval, not to plan beyond the law. The
// rest rule between shifts of the "forced" tier is exactly what HR must
// confirm before such a proposal is accepted.
const LEGAL_MAX_EXTENSION_MS = 4 * 3600000;
const RELAX_TIERS = [
  { tier: 'normal', extendMs: 2 * 3600000, bufferMs: 12 * 3600000 },
  { tier: 'tight', extendMs: LEGAL_MAX_EXTENSION_MS, bufferMs: 4 * 3600000 },
  { tier: 'forced', extendMs: LEGAL_MAX_EXTENSION_MS, bufferMs: 0 },
];

// The duty window a call-in for `target` would actually create: it starts
// with the task and runs CALLIN_WINDOW_MS, cut short so it keeps `bufferMs`
// of rest before the person's next own shift. It is the WHOLE window that has
// to clear their other shifts, not just the task: a 6 h call-in for an 08:00
// task overlaps a 13:00 shift even though the task itself does not.
// null = no window that still covers the task.
function callInWindow(person, target, allShiftsByPerson, bufferMs) {
  const shifts = allShiftsByPerson?.get(person.name) || [];
  const start = target.start.getTime();
  let end = start + CALLIN_WINDOW_MS;
  for (const s of shifts) {
    const ss = s.shiftStart.getTime(), se = s.shiftEnd.getTime();
    // bufferMs can be 0 (the "forced" tier) — even then, an actual time
    // overlap with another shift of theirs still disqualifies them; only the
    // rest-buffer around it is what gets relaxed away tier by tier.
    if (ss < target.end.getTime() + bufferMs && se > start - bufferMs) return null;
    if (ss >= target.end.getTime()) end = Math.min(end, ss - bufferMs);
  }
  if (end < target.end.getTime()) return null;
  return { shiftStart: new Date(start), shiftEnd: new Date(end) };
}

// An extension may not run into the same person's other shifts either.
function extensionClear(staff, newStart, newEnd, allShiftsByPerson, bufferMs) {
  const shifts = allShiftsByPerson?.get(staff.name) || [];
  return shifts.every(s => {
    if (s.shiftStart.getTime() === staff.shiftStart.getTime() && s.shiftEnd.getTime() === staff.shiftEnd.getTime()) return true;
    if (s.shiftStart < staff.shiftEnd && s.shiftEnd > staff.shiftStart) return true; // the shift being extended
    return !(s.shiftStart.getTime() < newEnd.getTime() + bufferMs && s.shiftEnd.getTime() > newStart.getTime() - bufferMs);
  });
}

// Finds the best available way to cover `target`, trying RELAX_TIERS in
// order and returning the first (tier, action) that works, or null if no
// tier can find anyone — which only happens when truly nobody in
// `workingStaff` ∪ `fullRoster` holds the required qualification at all.
function findCoverage(target, workingStaff, fullRoster, usedNames, allShiftsByPerson) {
  for (const { tier, extendMs, bufferMs } of RELAX_TIERS) {
    for (const s of workingStaff) {
      if (!hasAllQuals(s.quals, target)) continue;
      // Measured against the shift as originally planned, so repeated
      // extensions of one person never add up past the cap.
      const baseStart = s.originalStart ?? s.shiftStart, baseEnd = s.originalEnd ?? s.shiftEnd;
      const gapAfterShift = target.start - s.shiftEnd;
      const gapBeforeShift = s.shiftStart - target.end;
      if (gapAfterShift >= 0 && target.end - baseEnd <= extendMs &&
          extensionClear(s, s.shiftStart, target.end, allShiftsByPerson, bufferMs)) {
        return { type: 'extend', tier, staff: s, direction: 'end', newBound: target.end };
      }
      if (gapBeforeShift >= 0 && baseStart - target.start <= extendMs &&
          extensionClear(s, target.start, s.shiftEnd, allShiftsByPerson, bufferMs)) {
        return { type: 'extend', tier, staff: s, direction: 'start', newBound: target.start };
      }
    }
    for (const p of fullRoster) {
      if (usedNames.has(p.name) || !hasAllQuals(p.quals, target)) continue;
      const window = callInWindow(p, target, allShiftsByPerson, bufferMs);
      if (window) return { type: 'callin', tier, candidate: p, window };
    }
  }
  return null;
}

// Builds a plan to resolve `targetDate`'s backlog by proposing, one at a
// time, either (a) extending an already-scheduled employee's shift to
// reach a nearby task with their existing (possibly aircraft-type)
// qualifications, or (b) freshly calling in an off-duty roster employee for
// a 6h window — and after EACH addition, placing whatever that makes
// possible (open tasks go to whoever can take them, by chains of
// displacements if need be, and the improvement search ripples outward from
// the employees touched). This is why one call-in can sometimes resolve far
// more than the one task that triggered it: once they're a real resource
// for that window, the tasks that were stuck get placed around them.
//
// Every gap is tried at increasingly relaxed RELAX_TIERS before being
// accepted as truly unresolved, so `unresolved` in the result should only
// ever contain tasks nobody anywhere (on shift or in the full roster)
// actually holds the qualification for — not ones that merely didn't fit
// the tidy 2h/12h defaults.
//
// Greedy and bounded (MAX_ACTIONS/MAX_ITERATIONS) — a proposal for the
// dispatcher to review and accept, not a guaranteed-minimum solve.
export function resolveStaffingWithCallIns({
  tasksDB, staffDB, targetDate, windowDates, fullRoster = [], allShiftsByPerson = new Map(), distanceResolver,
}) {
  const dates = windowDates && windowDates.length > 0 ? windowDates : [targetDate];
  const workingStaff = (staffDB[targetDate] || []).map(s => ({ ...s }));
  let currentStaffDB = { ...staffDB, [targetDate]: workingStaff };
  let currentTasks = runOptimizer(tasksDB, currentStaffDB, targetDate, distanceResolver, dates);
  const baselineTasks = currentTasks; // the plain run, before any call-in/extension

  const usedNames = new Set(workingStaff.map(s => s.name));
  const skipIds = new Set();
  const actions = [];

  for (let iter = 0; iter < MAX_ITERATIONS && actions.length < MAX_ACTIONS; iter++) {
    const backlog = currentTasks
      .filter(t => dates.includes(t.date) && t.employee === 'Не назначено' && !skipIds.has(t.id))
      .sort((a, b) => a.start - b.start);
    const target = backlog[0];
    if (!target) break;

    const picked = findCoverage(target, workingStaff, fullRoster, usedNames, allShiftsByPerson);
    if (!picked) { skipIds.add(target.id); continue; }

    if (picked.type === 'extend') {
      const s = picked.staff;
      const preStart = s.shiftStart, preEnd = s.shiftEnd;
      s.originalStart ??= preStart;
      s.originalEnd ??= preEnd;
      if (picked.direction === 'end') s.shiftEnd = new Date(Math.max(s.shiftEnd.getTime(), picked.newBound.getTime()));
      else s.shiftStart = new Date(Math.min(s.shiftStart.getTime(), picked.newBound.getTime()));

      // A later, further-out task can trigger a second extension of the
      // SAME person — either someone already extended once before, or
      // someone freshly called in earlier whose engagement window now
      // needs to stretch too. Either way, widen that one existing action
      // instead of adding a duplicate row for the same name: the UI keys
      // rows by name, and two rows sharing a name would misalign the
      // label column against the chart for everyone after them.
      const existing = actions.find(a => a.name === s.name);
      if (existing) {
        existing.shiftStart = s.shiftStart;
        existing.shiftEnd = s.shiftEnd;
        if (TIER_ORDER.indexOf(picked.tier) > TIER_ORDER.indexOf(existing.tier)) existing.tier = picked.tier;
      } else {
        actions.push({
          type: 'extend', tier: picked.tier, name: s.name,
          originalStart: preStart, originalEnd: preEnd,
          shiftStart: s.shiftStart, shiftEnd: s.shiftEnd,
        });
      }
    } else {
      const { candidate, window } = picked;
      const { shiftStart, shiftEnd } = window;
      const newStaff = { name: candidate.name, quals: candidate.quals, shiftStart, shiftEnd, basePos: null };
      workingStaff.push(newStaff);
      usedNames.add(candidate.name);
      actions.push({ type: 'callin', tier: picked.tier, name: candidate.name, shiftStart, shiftEnd });
    }

    // Place what the addition makes possible without re-solving the whole
    // window each time (that was a full optimizer run per added person —
    // tens of seconds on a real day): open tasks go to whoever can take them,
    // by chains of displacements if need be, and the search ripples outward
    // only from the employees that touches.
    currentStaffDB = { ...staffDB, [targetDate]: workingStaff };
    // Tasks already known to have nobody at all who could cover them (skipIds)
    // aren't retried — that's what made every round re-search them in vain.
    const stillOpen = currentTasks
      .filter(t => dates.includes(t.date) && t.employee === 'Не назначено' && !skipIds.has(t.id))
      .map(t => t.id);
    currentTasks = improveAssignment(currentTasks, currentStaffDB, targetDate, distanceResolver, dates, {
      scopeEmployees: [],
      scopeTaskIds: stillOpen,
    }).tasks;
  }

  // Tasks set aside as hopeless along the way may have become placeable once
  // other people were added — one last sweep over everything still open.
  if (skipIds.size > 0) {
    currentTasks = improveAssignment(currentTasks, currentStaffDB, targetDate, distanceResolver, dates, {
      scopeEmployees: [],
    }).tasks;
  }

  const unresolved = currentTasks.filter(t => dates.includes(t.date) && t.employee === 'Не назначено');
  return { actions, tasks: currentTasks, unresolved, baselineTasks };
}
