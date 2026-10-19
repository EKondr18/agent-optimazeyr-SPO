// Overtime of the day's assignments, counted once per person-shift.
// A person can have more than one shift in the day's list (a night shift that
// began the day before and the day's own one): looking a person up by name alone
// compared every task with whichever shift came last, and a task of the earlier
// shift then counted as many hours of overtime against the later one (1358 "min
// on average" after a call-in plan was applied).

const distanceToShift = (t, s) => {
  const a = t.start.getTime(), b = s.shiftStart.getTime(), e = s.shiftEnd.getTime();
  return a < b ? b - a : a >= e ? a - e + 1 : 0;
};

// The shift a task belongs to: the one it starts in, else the nearest one.
function shiftOf(task, shifts) {
  let best = null, bestDist = Infinity;
  for (const s of shifts) {
    const dist = distanceToShift(task, s);
    if (dist < bestDist) { best = s; bestDist = dist; }
  }
  return best;
}

// assignedTasks: tasks with an employee; staffList: the shifts of the day.
// Returns one entry per person-shift that runs past its end:
// [{ name, shiftEnd, minutes }] — minutes between the shift's end and the end of
// the latest task of THAT shift (when they actually leave, not a sum over tasks).
export function overtimeByShift(assignedTasks, staffList) {
  const shiftsByName = new Map();
  for (const s of staffList) {
    if (!shiftsByName.has(s.name)) shiftsByName.set(s.name, new Map());
    shiftsByName.get(s.name).set(s.shiftStart.getTime(), s); // one entry per (name, start)
  }
  const latest = new Map(); // shift -> latest task end
  for (const t of assignedTasks) {
    const shifts = shiftsByName.get(t.employee);
    if (!shifts) continue;
    const s = shiftOf(t, [...shifts.values()]);
    const end = t.end.getTime();
    if (!latest.has(s) || end > latest.get(s)) latest.set(s, end);
  }
  const out = [];
  for (const [s, end] of latest) {
    if (end > s.shiftEnd.getTime()) out.push({ name: s.name, shiftEnd: s.shiftEnd, minutes: (end - s.shiftEnd.getTime()) / 60000 });
  }
  return out;
}
