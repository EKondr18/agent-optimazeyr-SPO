// Checks of the loaded data that explain, before any optimizer run, why some
// tasks can't be assigned however good the search is — so a dispatcher sees
// "nobody holds SPO_CRJ" or "no shifts on 27.09" instead of a silent backlog.
// It only reports; nothing is corrected or excluded automatically (an
// anomalous record stays in the plan and in the counts, as recorded).
import { requiredQuals } from '../optimizer.js';

// Longer than this reads as a data error (wrong end time, glued windows), not
// a real continuous job — flagged for a look, not trimmed.
export const LONG_TASK_HOURS = 12;

export function dataQualityReport({ tasks, staffDB, fullRoster = [] }) {
  const describe = t => ({
    id: t.id, name: t.name, flight: t.flight, start: t.start,
    hours: Math.round(((t.end - t.start) / 3600000) * 10) / 10,
  });

  const badIntervals = tasks.filter(t => !(t.end > t.start)).map(describe);
  const longTasks = tasks
    .filter(t => t.end - t.start > LONG_TASK_HOURS * 3600000)
    .map(describe)
    .sort((a, b) => b.hours - a.hours);
  const tasksWithoutQuals = tasks.filter(t => requiredQuals(t).length === 0).length;

  const staffByName = new Map();
  for (const list of Object.values(staffDB || {})) {
    for (const s of list) {
      if (!staffByName.has(s.name)) staffByName.set(s.name, new Set());
      for (const q of s.quals || []) staffByName.get(s.name).add(q);
    }
  }
  const held = new Set();
  for (const quals of staffByName.values()) for (const q of quals) held.add(q);
  for (const p of fullRoster) for (const q of p.quals || []) held.add(q);

  const missing = new Map();
  for (const t of tasks) {
    for (const q of requiredQuals(t)) {
      if (!held.has(q)) missing.set(q, (missing.get(q) || 0) + 1);
    }
  }
  const qualsNobodyHolds = [...missing.entries()]
    .map(([qual, count]) => ({ qual, tasks: count }))
    .sort((a, b) => b.tasks - a.tasks);

  const taskDates = [...new Set(tasks.map(t => t.date))].sort();
  const datesWithoutShifts = taskDates.filter(d => !(staffDB?.[d]?.length > 0));

  const staffWithoutQuals = [...staffByName.entries()]
    .filter(([, quals]) => quals.size === 0)
    .map(([name]) => name)
    .sort();

  const issueCount =
    badIntervals.length + longTasks.length + qualsNobodyHolds.length +
    datesWithoutShifts.length + staffWithoutQuals.length;

  return {
    badIntervals, longTasks, tasksWithoutQuals, qualsNobodyHolds,
    datesWithoutShifts, staffWithoutQuals, issueCount,
  };
}
