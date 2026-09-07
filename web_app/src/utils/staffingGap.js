// Estimates how many additional qualified staff would cover the currently
// unassigned ("backlog") tasks, broken down by required qualification and
// time interval (using the same person-based channel counting as the load
// chart, not raw task-overlap counting — see staffDemand.js), plus, when a
// full roster is available, a concrete plan of REAL named employees to call
// in or extend, arrived at by actually re-running the optimizer with them
// added — so the dispatcher sees a proposal that accounts for reshuffling
// the whole day, not just a literal one-task-at-a-time patch.
import { hasAllQuals, runOptimizer } from '../optimizer';
import { packIntoChannels, bucketizeChannels } from './staffDemand';

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
// Hard cap on how many people this proposes calling in/extending in one
// run, purely so a pathological backlog (e.g. a qualification nobody
// holds) can't spin the reoptimization loop forever.
const MAX_ACTIONS = 20;
const MAX_ITERATIONS = 500;

// Every backlog task is tried against these tiers in order, loosest rule
// first — the dispatcher wants SOMEONE proposed for every gap, not a
// polite "nobody found", but the relaxation is bounded and labeled rather
// than unconditional: it only loosens (a) how far a shift can be
// stretched and (b) how much rest a fresh call-in needs before/after,
// never the two things that must never bend — a real qualification match
// (hasAllQuals) and no actual time overlap with that person's own other
// commitments (no double-booking). "forced" picks are exactly the ones a
// dispatcher should sanity-check before accepting.
const RELAX_TIERS = [
  { tier: 'normal', extendMs: 2 * 3600000, bufferMs: 12 * 3600000 },
  { tier: 'tight', extendMs: 4 * 3600000, bufferMs: 4 * 3600000 },
  { tier: 'forced', extendMs: 8 * 3600000, bufferMs: 0 },
];

function isEligibleForCallIn(person, gapStart, gapEnd, allShiftsByPerson, bufferMs) {
  const shifts = allShiftsByPerson?.get(person.name) || [];
  const bufferedStart = new Date(gapStart.getTime() - bufferMs);
  const bufferedEnd = new Date(gapEnd.getTime() + bufferMs);
  // bufferMs can be 0 (the "forced" tier) — even then, an actual time
  // overlap with another shift of theirs still disqualifies them; only the
  // rest-buffer around it is what gets relaxed away tier by tier.
  return shifts.every(s => !(s.shiftStart < bufferedEnd && s.shiftEnd > bufferedStart));
}

// Finds the best available way to cover `target`, trying RELAX_TIERS in
// order and returning the first (tier, action) that works, or null if no
// tier can find anyone — which only happens when truly nobody in
// `workingStaff` ∪ `fullRoster` holds the required qualification at all.
function findCoverage(target, workingStaff, fullRoster, usedNames, allShiftsByPerson) {
  for (const { tier, extendMs, bufferMs } of RELAX_TIERS) {
    for (const s of workingStaff) {
      if (!hasAllQuals(s.quals, target)) continue;
      const gapAfterShift = target.start - s.shiftEnd;
      const gapBeforeShift = s.shiftStart - target.end;
      if (gapAfterShift >= 0 && gapAfterShift <= extendMs) {
        return { type: 'extend', tier, staff: s, direction: 'end', newBound: target.end };
      }
      if (gapBeforeShift >= 0 && gapBeforeShift <= extendMs) {
        return { type: 'extend', tier, staff: s, direction: 'start', newBound: target.start };
      }
    }
    const candidate = fullRoster.find(p =>
      !usedNames.has(p.name) &&
      hasAllQuals(p.quals, target) &&
      isEligibleForCallIn(p, target.start, target.end, allShiftsByPerson, bufferMs)
    );
    if (candidate) return { type: 'callin', tier, candidate };
  }
  return null;
}

// Builds a plan to resolve `targetDate`'s backlog by proposing, one at a
// time, either (a) extending an already-scheduled employee's shift to
// reach a nearby task with their existing (possibly aircraft-type)
// qualifications, or (b) freshly calling in an off-duty roster employee for
// a 6h window — and after EACH addition, actually re-running the optimizer
// for the whole date/window so already-assigned tasks can be reshuffled
// too. This is why one call-in can sometimes resolve far more than the one
// task that triggered it: once they're a real resource for that window,
// the normal optimizer passes pack their whole day, freeing up whoever was
// covering nearby tasks before.
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
      const originalStart = s.shiftStart, originalEnd = s.shiftEnd;
      if (picked.direction === 'end') s.shiftEnd = new Date(Math.max(s.shiftEnd.getTime(), picked.newBound.getTime()));
      else s.shiftStart = new Date(Math.min(s.shiftStart.getTime(), picked.newBound.getTime()));
      actions.push({
        type: 'extend', tier: picked.tier, name: s.name, direction: picked.direction,
        originalStart, originalEnd, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd,
      });
    } else {
      const { candidate } = picked;
      const shiftStart = target.start;
      const shiftEnd = new Date(target.start.getTime() + CALLIN_WINDOW_MS);
      const newStaff = { name: candidate.name, quals: candidate.quals, shiftStart, shiftEnd, basePos: null };
      workingStaff.push(newStaff);
      usedNames.add(candidate.name);
      actions.push({ type: 'callin', tier: picked.tier, name: candidate.name, shiftStart, shiftEnd });
    }

    currentStaffDB = { ...staffDB, [targetDate]: workingStaff };
    currentTasks = runOptimizer(tasksDB, currentStaffDB, targetDate, distanceResolver, dates);
  }

  const unresolved = currentTasks.filter(t => dates.includes(t.date) && t.employee === 'Не назначено');
  return { actions, tasks: currentTasks, unresolved };
}
