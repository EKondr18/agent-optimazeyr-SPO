// Estimates how many additional qualified staff would cover the currently
// unassigned ("backlog") tasks, broken down by required qualification and
// time interval, plus — when a full roster is available — which employees
// hold that qualification but aren't scheduled anywhere in the window, as
// call-in candidates.
import { hasAllQuals } from '../optimizer';

function hourSlots(windowStart, windowDays) {
  const base = new Date(windowStart + 'T00:00:00');
  return Array.from({ length: windowDays * 24 }, (_, h) => {
    const start = new Date(base.getTime() + h * 3600000);
    const end = new Date(start.getTime() + 3600000);
    return { start, end };
  });
}

// Merges adjacent hour slots sharing the same non-zero count into a single
// interval, so the result reads as "нужно ещё 2 чел. 14:00–17:00" instead
// of one row per hour.
function mergeIntervals(slots, counts) {
  const intervals = [];
  let i = 0;
  while (i < counts.length) {
    if (counts[i] === 0) { i++; continue; }
    const count = counts[i];
    const start = slots[i].start;
    let j = i;
    while (j + 1 < counts.length && counts[j + 1] === count) j++;
    intervals.push({ start, end: slots[j].end, count });
    i = j + 1;
  }
  return intervals;
}

export function computeStaffingGaps({ backlogTasks, windowStart, windowDays, fullRoster = [], scheduledNames = new Set() }) {
  if (!backlogTasks.length || !windowStart) return [];
  const slots = hourSlots(windowStart, windowDays);

  const byReqType = {};
  for (const t of backlogTasks) {
    const key = t.reqType || '(без квалификации)';
    if (!byReqType[key]) {
      const reqTypes = t.reqTypes && t.reqTypes.length > 0 ? t.reqTypes : (t.reqType ? [t.reqType] : []);
      byReqType[key] = { reqTypes, tasks: [] };
    }
    byReqType[key].tasks.push(t);
  }

  const gaps = [];
  for (const [reqTypeLabel, { reqTypes, tasks }] of Object.entries(byReqType)) {
    // How many of these tasks are simultaneously active in each hour slot —
    // a simple, defensible proxy for "how many people this qualification
    // group needs at once" (not a full interval-graph min-resource solve).
    const counts = slots.map(({ start, end }) =>
      tasks.filter(t => t.start < end && start < t.end).length
    );
    const intervals = mergeIntervals(slots, counts);
    if (intervals.length === 0) continue;

    const candidates = fullRoster.filter(person =>
      hasAllQuals(person.quals, { reqTypes }) &&
      !scheduledNames.has(person.name)
    );

    const peak = Math.max(...intervals.map(iv => iv.count));
    gaps.push({ reqTypeLabel, reqTypes, intervals, candidates, taskCount: tasks.length, peak });
  }

  gaps.sort((a, b) => b.peak - a.peak);
  return gaps;
}
