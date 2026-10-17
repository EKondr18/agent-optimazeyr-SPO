// Checks of the loaded data that explain, before any optimizer run, why some
// tasks can't be assigned however good the search is — so a dispatcher sees
// "nobody holds SPO_CRJ" or "no shifts on 27.09" instead of a silent backlog.
// It only reports; nothing is corrected or excluded automatically (an
// anomalous record stays in the plan and in the counts, as recorded).
import { requiredQuals, hasAllQuals, fitsShift } from '../optimizer.js';
import { addDays } from './tz.js';

// Longer than this reads as a data error (wrong end time, glued windows), not
// a real continuous job — flagged for a look, not trimmed.
export const LONG_TASK_HOURS = 12;

export function dataQualityReport({ tasks, staffDB, fullRoster = [], loadReport = null }) {
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
  const taskDates = [...new Set(tasks.map(t => t.date))].sort();
  const datesWithoutShifts = taskDates.filter(d => !(staffDB?.[d]?.length > 0));

  // Who is actually on shift around each day — "nobody holds SPO_X" is only
  // true for a day if nobody ON SHIFT in the window day-1..day+1 holds it
  // (a person with the qualification but no shift that week cannot take the
  // task; counting them hid CRJ on the days it was actually short). Days with
  // no shifts at all are left to datesWithoutShifts / incompleteWindowDays:
  // there "nobody holds anything" would only repeat the same fact per qual.
  const people = d => new Set((staffDB?.[d] || []).map(s => s.name)).size;
  const qualsOn = new Map();
  const qualsOnDay = d => {
    if (!qualsOn.has(d)) {
      const set = new Set();
      for (const s of staffDB?.[d] || []) for (const q of s.quals || []) set.add(q);
      qualsOn.set(d, set);
    }
    return qualsOn.get(d);
  };
  const tasksByDate = new Map();
  for (const t of tasks) {
    if (!tasksByDate.has(t.date)) tasksByDate.set(t.date, []);
    tasksByDate.get(t.date).push(t);
  }

  const missing = new Map(); // qual -> { tasks, days, totalTasks }
  for (const d of taskDates) {
    if (!(staffDB?.[d]?.length > 0)) continue;
    const held = new Set([...qualsOnDay(addDays(d, -1)), ...qualsOnDay(d), ...qualsOnDay(addDays(d, 1))]);
    const perQual = new Map();
    for (const t of tasksByDate.get(d)) {
      for (const q of new Set(requiredQuals(t))) perQual.set(q, (perQual.get(q) || 0) + 1);
    }
    for (const [q, n] of perQual) {
      if (!missing.has(q)) missing.set(q, { qual: q, tasks: 0, days: 0, totalTasks: 0 });
      const m = missing.get(q);
      m.totalTasks += n;
      if (!held.has(q)) { m.tasks += n; m.days += 1; }
    }
  }
  const qualsNobodyHolds = [...missing.values()]
    .filter(m => m.days > 0)
    .sort((a, b) => b.tasks - a.tasks);

  // Days that can't be planned reliably: no shifts on a neighbouring day (a
  // night shift or a task chain crossing midnight would be cut off) or far
  // fewer people than usual on any day of the window (median over the days
  // that have shifts).
  const counts = Object.keys(staffDB || {}).map(people).filter(n => n > 0).sort((a, b) => a - b);
  const medianPeople = counts.length === 0 ? 0
    : counts.length % 2 ? counts[(counts.length - 1) / 2]
      : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2;
  const fewBelow = medianPeople * 0.5;
  const incompleteWindowDays = [];
  for (const d of taskDates) {
    const win = [addDays(d, -1), d, addDays(d, 1)];
    const [prev, day, next] = win.map(people);
    const reasons = [];
    if (day === 0) reasons.push('NO_SHIFTS_DAY');
    if (prev === 0) reasons.push('NO_SHIFTS_PREV');
    if (next === 0) reasons.push('NO_SHIFTS_NEXT');
    if ([prev, day, next].some(n => n > 0 && n < fewBelow)) reasons.push('FEW_PEOPLE');
    if (reasons.length > 0) {
      incompleteWindowDays.push({ date: d, tasks: tasksByDate.get(d).length, people: { prev, day, next }, medianPeople, reasons });
    }
  }

  const staffWithoutQuals = [...staffByName.entries()]
    .filter(([, quals]) => quals.size === 0)
    .map(([name]) => name)
    .sort();

  const issueCount =
    badIntervals.length + longTasks.length + qualsNobodyHolds.length +
    datesWithoutShifts.length + staffWithoutQuals.length;

  // What the loader dropped (rows of orders/shifts and why), for display next
  // to the other data problems — null when no load report was passed.
  const loadSkipped = loadReport ? {
    orders: loadReport.orders,
    shifts: loadReport.shifts,
    warnings: loadReport.warnings || [],
    skippedTotal: skippedRows(loadReport.orders) + skippedRows(loadReport.shifts),
  } : null;

  return {
    badIntervals, longTasks, tasksWithoutQuals, qualsNobodyHolds,
    datesWithoutShifts, incompleteWindowDays, staffWithoutQuals, issueCount, loadSkipped,
  };
}

const skippedRows = part => Object.values(part?.skipped || {}).reduce((a, b) => a + b, 0);

// Why each still-open task of the selected day is open — the same split as
// unassignedLowerBound (skills and shifts relaxed generously: overtime
// allowance counted, walking ignored, so `resolver` is accepted for call
// symmetry but not used), over the people on shift in the planning window:
//   NO_QUAL           nobody on shift holds every required qualification
//   NO_SHIFT_AT_TIME  someone holds them, but nobody's shift covers the task
//   BUSY              someone could take it by skills and shift — they are busy
// NO_QUAL + NO_SHIFT_AT_TIME equals the lower bound's `noEligible`.
// byQual groups the same counts by the required qualification(s).
export function openTaskReasons(tasks, staffDB, selectedDate, resolver, windowDates) {
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const merged = new Map();
  for (const d of dates) {
    for (const s of staffDB?.[d] || []) {
      const key = `${s.name}__${s.shiftStart.getTime()}`;
      if (!merged.has(key)) merged.set(key, s);
    }
  }
  const staff = [...merged.values()];

  const byReason = { NO_QUAL: 0, NO_SHIFT_AT_TIME: 0, BUSY: 0 };
  const byQual = {};
  let total = 0;
  for (const t of tasks) {
    if (t.date !== selectedDate || t.employee !== 'Не назначено') continue;
    const holders = staff.filter(s => hasAllQuals(s.quals || [], t));
    const reason = holders.length === 0 ? 'NO_QUAL'
      : holders.some(s => fitsShift(s, t, null, false) || fitsShift(s, t, null, true)) ? 'BUSY'
        : 'NO_SHIFT_AT_TIME';
    total++;
    byReason[reason]++;
    const key = requiredQuals(t).join(' + ') || '—';
    if (!byQual[key]) byQual[key] = { total: 0, NO_QUAL: 0, NO_SHIFT_AT_TIME: 0, BUSY: 0 };
    byQual[key].total++;
    byQual[key][reason]++;
  }
  return { total, byReason, byQual };
}
