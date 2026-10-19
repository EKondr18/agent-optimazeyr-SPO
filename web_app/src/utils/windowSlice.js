// Which tasks a worker job needs, and how its answer goes back into the full
// list. A job works on a window of days; sending the whole export (tens of
// thousands of tasks) to the worker and back costs far more than the part of it
// that can matter. Pure functions, no React.
import { dayStart, addDays } from './tz.js';

const HOUR = 3600000;
// A task outside the window still matters when it keeps someone busy at the
// window's edge (see windowContext in optimizer.js: the margin there is the
// longest task plus the longest hand-off, never less than 6 h). A whole day
// each side covers that with room to spare.
export const SLICE_MARGIN_MS = 24 * HOUR;

const usable = t => t && t.id !== undefined && t.id !== null && t.id !== ''
  && t.start instanceof Date && t.end instanceof Date
  && Number.isFinite(t.start.getTime()) && Number.isFinite(t.end.getTime()) && t.end > t.start;

// The tasks to send: those dated inside the window, those whose time touches
// [window start - margin, window end + margin], those in `alwaysIds` (the ones a
// batch of changes names) and any task the core would set aside itself (no id,
// unreadable or inverted times) so that it is reported exactly as before.
// The margin grows with the longest task of the window, so a data error such as
// a 40-hour task never makes the slice smaller than the core's own context.
// Returns { sent } (original order) and `whole` — true when nothing was left out.
export function sliceForWindow(tasks, windowDates, alwaysIds = []) {
  if (!Array.isArray(tasks) || !windowDates || windowDates.length === 0) return { sent: tasks, whole: true };
  const days = [...new Set(windowDates)].sort();
  const inWindow = new Set(days);
  const from = dayStart(days[0]).getTime();
  const to = dayStart(addDays(days[days.length - 1], 1)).getTime();
  let longest = 0;
  for (const t of tasks) {
    if (!inWindow.has(t?.date) || !usable(t)) continue;
    const len = t.end.getTime() - t.start.getTime();
    if (len > longest) longest = len;
  }
  const margin = Math.max(SLICE_MARGIN_MS, longest + 12 * HOUR);
  const lo = from - margin, hi = to + margin;
  const always = new Set(alwaysIds);
  const sent = tasks.filter(t => !usable(t) || inWindow.has(t.date) || always.has(t.id)
    || (t.end.getTime() > lo && t.start.getTime() < hi));
  return { sent, whole: sent.length === tasks.length };
}

// The full list with the tasks that were sent replaced by the job's answer, in
// the same places; tasks that were not sent stay as they were. Matching is by id
// (repeated ids are taken in order). A task the job returns that the list does
// not have (or one more answer than tasks sent under an id) goes to the end.
export function mergeSlice(full, sent, answered) {
  const sentIds = new Set(sent.map(t => t.id));
  const queues = new Map();
  for (const t of answered) {
    if (!queues.has(t.id)) queues.set(t.id, []);
    queues.get(t.id).push(t);
  }
  const out = full.map(t => {
    if (!sentIds.has(t.id)) return t;
    const q = queues.get(t.id);
    return q && q.length > 0 ? q.shift() : t;
  });
  for (const q of queues.values()) out.push(...q);
  return out;
}
