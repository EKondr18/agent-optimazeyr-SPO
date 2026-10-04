// Estimates how many additional qualified staff would cover the currently
// unassigned ("backlog") tasks, broken down by required qualification and
// time interval (using the same person-based channel counting as the load
// chart, not raw task-overlap counting — see staffDemand.js), plus, when a
// full roster is available, a concrete plan of REAL named employees to call
// in or extend, arrived at by actually re-running the optimizer with them
// added — so the dispatcher sees a proposal that accounts for reshuffling
// the whole day, not just a literal one-task-at-a-time patch.
import { hasAllQuals, runOptimizer, improveAssignment, unassignedLowerBound } from '../optimizer.js';
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
const MAX_ACTIONS = 80;
// A call-in is trimmed afterwards to the tasks it actually took, but never
// to less than this paid stretch.
const MIN_CALLIN_MS = 4 * 3600000;
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

// Price of an option, in hours, for choosing between them: the extra hours
// themselves, plus a fixed price for bringing in someone who is off duty
// (the call, the trip, a minimum paid stretch), plus a price per relaxation
// tier. Choosing by price rather than by tier first is what lets a
// 2 h 10 min earlier start of an existing day shift beat calling in a new
// person for six hours — on 31.08 the tier-first rule called in 11 people
// 07:50–13:50 for a two-hour shift-change gap.
const CALLOUT_PRICE_H = 3;
const TIER_PRICE_H = { normal: 0, tight: 2, forced: 6 };
const H = 3600000;

// Every way to cover `target` (extending someone already on shift, earlier
// or later, or calling in someone off duty), each at the first tier whose
// rest rule it satisfies, and returns the cheapest — or null when nobody in
// `workingStaff` ∪ `fullRoster` can take it at all.
function findCoverage(target, workingStaff, fullRoster, usedNames, allShiftsByPerson, resolver) {
  let best = null;
  // Starting earlier for a task means starting early enough to walk to it
  // from the shift's start point, or the task still can't be placed.
  const walkMs = s => {
    if (!s.basePos || !resolver) return 0;
    const sec = resolver.secondsBetween(s.basePos, target.entryPos ?? target.pos);
    return sec == null ? 0 : sec * 1000;
  };
  const offer = o => { if (!best || o.price < best.price) best = o; };
  for (const s of workingStaff) {
    if (!hasAllQuals(s.quals, target)) continue;
    // Their other shifts as planned plus anything this plan already gave
    // them (a call-in, another extended shift) — an extension clears all.
    const others = new Map([[s.name, [
      ...(allShiftsByPerson?.get(s.name) || []),
      ...workingStaff.filter(w => w.name === s.name && w !== s),
    ]]]);
    // Measured against the shift as originally planned, so repeated
    // extensions of one person never add up past the cap.
    const baseStart = s.originalStart ?? s.shiftStart, baseEnd = s.originalEnd ?? s.shiftEnd;
    // The cap is on the extension as a whole, both ends together.
    const earlier = baseStart - s.shiftStart, later = s.shiftEnd - baseEnd;
    for (const { tier, extendMs, bufferMs } of RELAX_TIERS) {
      // also a task that starts inside the shift and runs past its end —
      // exactly what straddles a shift change
      if (target.end > s.shiftEnd && target.start >= s.shiftStart && earlier + (target.end - baseEnd) <= extendMs &&
          extensionClear(s, s.shiftStart, target.end, others, bufferMs)) {
        offer({ type: 'extend', tier, staff: s, direction: 'end', newBound: target.end,
          price: (target.end - s.shiftEnd) / H + TIER_PRICE_H[tier] });
        break;
      }
    }
    // (rounded down: a fractional millisecond would be dropped by Date and land
    // the start a hair too late for the check)
    const newStart = new Date(Math.floor(target.start.getTime() - walkMs(s)));
    for (const { tier, extendMs, bufferMs } of RELAX_TIERS) {
      if (newStart < s.shiftStart && target.end <= s.shiftEnd && (baseStart - newStart) + later <= extendMs &&
          extensionClear(s, newStart, s.shiftEnd, others, bufferMs)) {
        offer({ type: 'extend', tier, staff: s, direction: 'start', newBound: newStart,
          price: (s.shiftStart - newStart) / H + TIER_PRICE_H[tier] });
        break;
      }
    }
  }
  for (const p of fullRoster) {
    if (usedNames.has(p.name) || !hasAllQuals(p.quals, target)) continue;
    // Someone with a shift earlier or later that day can still be called in
    // for another stretch — whether that leaves enough rest is exactly what
    // the tiers' rest rule checks, against their shifts as planned AND as
    // already extended in this plan.
    const theirs = [
      ...(allShiftsByPerson?.get(p.name) || []),
      ...workingStaff.filter(w => w.name === p.name),
    ];
    for (const { tier, bufferMs } of RELAX_TIERS) {
      const window = callInWindow(p, target, new Map([[p.name, theirs]]), bufferMs);
      if (window) {
        offer({ type: 'callin', tier, candidate: p, window,
          price: MIN_CALLIN_MS / H + CALLOUT_PRICE_H + TIER_PRICE_H[tier] });
        break;
      }
    }
  }
  return best;
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

  // People already called in by this plan (each at most once).
  const usedNames = new Set();
  const skipIds = new Set();
  const actions = [];
  const actionOf = new Map(); // working shift object -> its action

  for (let iter = 0; iter < MAX_ITERATIONS && actions.length < MAX_ACTIONS; iter++) {
    const backlog = currentTasks
      .filter(t => dates.includes(t.date) && t.employee === 'Не назначено' && !skipIds.has(t.id))
      .sort((a, b) => a.start - b.start);
    const target = backlog[0];
    if (!target) break;

    const picked = findCoverage(target, workingStaff, fullRoster, usedNames, allShiftsByPerson, distanceResolver);
    if (!picked) { skipIds.add(target.id); continue; }

    if (picked.type === 'extend') {
      const s = picked.staff;
      const preStart = s.shiftStart, preEnd = s.shiftEnd;
      s.originalStart ??= preStart;
      s.originalEnd ??= preEnd;
      if (picked.direction === 'end') s.shiftEnd = new Date(Math.max(s.shiftEnd.getTime(), picked.newBound.getTime()));
      else s.shiftStart = new Date(Math.min(s.shiftStart.getTime(), picked.newBound.getTime()));

      // A later, further-out task can trigger a second extension of the
      // SAME shift — one already extended, or a call-in whose window now
      // needs to stretch. Either way, widen that shift's one existing action.
      // Matched by the shift itself, not the name: one person can have both
      // their own shift extended and a separate call-in, and merging those by
      // name once glued two different shifts into one impossible row.
      const existing = actionOf.get(s);
      if (existing) {
        existing.shiftStart = s.shiftStart;
        existing.shiftEnd = s.shiftEnd;
        if (TIER_ORDER.indexOf(picked.tier) > TIER_ORDER.indexOf(existing.tier)) existing.tier = picked.tier;
      } else {
        const action = {
          type: 'extend', tier: picked.tier, name: s.name,
          originalStart: preStart, originalEnd: preEnd,
          shiftStart: s.shiftStart, shiftEnd: s.shiftEnd,
        };
        actions.push(action);
        actionOf.set(s, action);
      }
    } else {
      const { candidate, window } = picked;
      const { shiftStart, shiftEnd } = window;
      const newStaff = { name: candidate.name, quals: candidate.quals, shiftStart, shiftEnd, basePos: null };
      workingStaff.push(newStaff);
      usedNames.add(candidate.name);
      const action = { type: 'callin', tier: picked.tier, name: candidate.name, shiftStart, shiftEnd };
      actions.push(action);
      actionOf.set(newStaff, action);
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

  trimActions(actions, currentTasks, dates, workingStaff, distanceResolver);

  const unresolved = currentTasks.filter(t => dates.includes(t.date) && t.employee === 'Не назначено');
  // The least extra staff the day needs at once, whatever is proposed: at
  // each separate bottleneck, how many more simultaneous tasks there are
  // than people on shift who can take them (see unassignedLowerBound).
  // Tasks nobody anywhere (on shift or in the roster) is qualified for are
  // counted apart — no extra person helps with those.
  const qualifiedSomewhere = t =>
    (staffDB[targetDate] || []).some(s => hasAllQuals(s.quals, t)) || fullRoster.some(p => hasAllQuals(p.quals, t));
  const dayTasks = baselineTasks.filter(t => t.date === targetDate);
  const bound = unassignedLowerBound(dayTasks.filter(qualifiedSomewhere), staffDB, targetDate, [targetDate], { keepUncovered: true });
  const minExtra = (bound.bottlenecks || []).map(b => ({ at: b.at, people: b.deficit, active: b.active }));
  const noEligible = dayTasks.filter(t => !qualifiedSomewhere(t)).length;
  // Why each task is still open, so nothing is left unexplained:
  //   NO_QUAL     nobody on shift or in the roster holds what it needs
  //   TOO_LONG    longer than any shift plus the legal 4 h — a data error
  //               or work that has to be split between people
  //   NO_CAPACITY qualified people exist, but every one of them is busy then
  //               or can't take it within the rest and extension rules
  const longestShift = Math.max(0, ...(staffDB[targetDate] || []).map(s => s.shiftEnd - s.shiftStart));
  const reasonOf = t => {
    if (!qualifiedSomewhere(t)) return 'NO_QUAL';
    if (t.end - t.start > Math.max(longestShift, CALLIN_WINDOW_MS) + LEGAL_MAX_EXTENSION_MS) return 'TOO_LONG';
    return 'NO_CAPACITY';
  };
  const unresolvedReasons = Object.fromEntries(unresolved.map(t => [t.id, reasonOf(t)]));
  return { actions, tasks: currentTasks, unresolved, unresolvedReasons, baselineTasks, minExtra, noEligible };
}

// Shrinks every proposal to what it is actually used for once the plan is
// final: a call-in to the span of the tasks it took (at least the minimum
// paid stretch, never beyond the window it was offered), an extension back
// towards the original shift wherever the extra time took no task — and a
// proposal that took nothing at all is dropped. Assignments stay valid: each
// remaining interval still covers every task placed in it.
function trimActions(actions, tasks, dates, workingStaff, resolver) {
  // An earlier start must still leave the walk from the shift's start point
  // to the first task (the same hard check fitsShift applies).
  // (A person can have two shifts on one date with different start points —
  // the walk is measured from the shift being extended.)
  const walkMs = (a, task) => {
    const s = workingStaff.find(x => x.name === a.name &&
      (x.originalStart ?? x.shiftStart).getTime() === a.originalStart.getTime());
    if (!s?.basePos || !resolver) return 0;
    const sec = resolver.secondsBetween(s.basePos, task.entryPos ?? task.pos);
    return sec == null ? 0 : sec * 1000;
  };
  const byName = new Map();
  for (const t of tasks) {
    if (!dates.includes(t.date) || t.employee === 'Не назначено') continue;
    if (!byName.has(t.employee)) byName.set(t.employee, []);
    byName.get(t.employee).push(t);
  }
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    const inside = (byName.get(a.name) || []).filter(t => t.start >= a.shiftStart && t.end <= a.shiftEnd);
    if (a.type === 'callin') {
      if (inside.length === 0) { actions.splice(i, 1); continue; }
      const first = Math.min(...inside.map(t => t.start.getTime()));
      const last = Math.max(...inside.map(t => t.end.getTime()));
      const start = Math.max(a.shiftStart.getTime(), first);
      const end = Math.min(a.shiftEnd.getTime(), Math.max(last, start + MIN_CALLIN_MS));
      a.shiftStart = new Date(start);
      a.shiftEnd = new Date(end);
    } else {
      const after = inside.filter(t => t.end > a.originalEnd);
      // The start must leave the walk to the first task — even one that starts
      // after the original start but too soon after it to walk there.
      const need = inside.length
        ? Math.floor(Math.min(...inside.map(t => t.start.getTime() - walkMs(a, t))))
        : Infinity;
      const start = need < a.originalStart.getTime()
        ? Math.max(a.shiftStart.getTime(), need)
        : a.originalStart.getTime();
      const end = after.length ? Math.max(...after.map(t => t.end.getTime())) : a.originalEnd.getTime();
      if (start >= a.originalStart.getTime() && end <= a.originalEnd.getTime()) { actions.splice(i, 1); continue; }
      a.shiftStart = new Date(Math.min(start, a.originalStart.getTime()));
      a.shiftEnd = new Date(Math.max(end, a.originalEnd.getTime()));
    }
  }
}
