// Estimates how many additional qualified staff would cover the currently
// unassigned ("backlog") tasks, broken down by required qualification and
// time interval (using the same person-based channel counting as the load
// chart, not raw task-overlap counting — see staffDemand.js), plus, when a
// full roster is available, which REAL named employees could be called in
// to cover the gap and which task(s)/qualification(s) they'd be covering
// at what time.
import { hasAllQuals } from '../optimizer';
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
// for a single 20-minute task — so once someone is called in, later
// backlog tasks they're qualified for get bundled onto them first, up to
// this cap, before anyone new is called in at all.
const MAX_CALLIN_SPAN_MS = 6 * 3600000;
// An employee can be called in only if they have no shift starting or
// ending within this many hours of the gap on either side, per the
// corporate rule this mirrors.
const CALLIN_BUFFER_MS = 12 * 3600000;

function isEligibleForCallIn(person, gapStart, gapEnd, allShiftsByPerson) {
  const shifts = allShiftsByPerson?.get(person.name) || [];
  const bufferedStart = new Date(gapStart.getTime() - CALLIN_BUFFER_MS);
  const bufferedEnd = new Date(gapEnd.getTime() + CALLIN_BUFFER_MS);
  return shifts.every(s => !(s.shiftStart < bufferedEnd && s.shiftEnd > bufferedStart));
}

// Greedily assigns backlog tasks to as FEW real, call-in-eligible employees
// as possible: a task first tries to land on an already-called-in person
// (if they're qualified, free at that time, and it keeps their total
// engagement under the cap) before a new person is called in at all. This
// is a greedy heuristic (chronological first-fit), not a guaranteed-minimum
// solve — same spirit as the optimizer's own pass-based heuristic.
export function planCallIns(backlogTasks, fullRoster = [], allShiftsByPerson = new Map(), scheduledNames = new Set()) {
  const sorted = [...backlogTasks].sort((a, b) => a.start - b.start);
  const callIns = [];
  const unresolved = [];

  for (const t of sorted) {
    let target = callIns.find(c =>
      c.lastEnd <= t.start &&
      (t.end - c.start) <= MAX_CALLIN_SPAN_MS &&
      hasAllQuals(c.person.quals, t)
    );

    if (!target) {
      const candidate = fullRoster.find(p =>
        !scheduledNames.has(p.name) &&
        !callIns.some(c => c.person.name === p.name) &&
        hasAllQuals(p.quals, t) &&
        isEligibleForCallIn(p, t.start, t.end, allShiftsByPerson)
      );
      if (!candidate) { unresolved.push(t); continue; }
      target = { person: candidate, tasks: [], start: t.start, lastEnd: -Infinity, end: t.end };
      callIns.push(target);
    }

    target.tasks.push(t);
    target.lastEnd = t.end;
    target.end = t.end;
  }

  return { callIns, unresolved };
}
