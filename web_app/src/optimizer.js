import { getPosDistance } from './utils/posDistance';

const MIN_TRANSITION_MS = 5 * 60000;
const MIN_TRANSITION_POS_DIST = 5;

function tasksOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// Back-to-back tasks at meaningfully different positions need walking/driving
// time between them — without it the assignment isn't physically realistic.
function hasInsufficientGap(a, b) {
  const earlier = a.start <= b.start ? a : b;
  const later = a.start <= b.start ? b : a;
  if (later.start < earlier.end) return false; // overlap is handled by tasksOverlap
  const gap = later.start - earlier.end;
  return gap < MIN_TRANSITION_MS && getPosDistance(earlier.pos, later.pos) >= MIN_TRANSITION_POS_DIST;
}

function conflictsWith(a, b) {
  // Same flight + different task name = complementary roles on same plane → overlap allowed
  // Same flight + same task name = 2 identical tasks → need 2 different people, NO exemption
  if (a.flight === b.flight && a.flight !== 'Рейс не указ.' && a.name !== b.name) return false;
  return tasksOverlap(a, b) || hasInsufficientGap(a, b);
}

function hasConflict(empTasks, newTask) {
  return empTasks.some(t => conflictsWith(t, newTask));
}

function getLastTaskPos(empTasks, beforeTime) {
  const prior = empTasks
    .filter(t => t.end <= beforeTime)
    .sort((a, b) => b.end - a.end);
  return prior.length > 0 ? prior[0].pos : null;
}

function scoreEmployee(staff, assignedTasks, task) {
  const empTasks = assignedTasks[staff.name] || [];
  const lastPos = getLastTaskPos(empTasks, task.start);
  const hasSameFlightDiffTask = empTasks.some(t =>
    t.flight === task.flight && task.flight !== 'Рейс не указ.' && t.name !== task.name
  );
  const dist = hasSameFlightDiffTask ? 0 : (lastPos ? getPosDistance(lastPos, task.pos) : 10);
  return { dist, load: empTasks.length };
}

function commit(result, assignedTasks, taskId, employeeName) {
  const idx = result.findIndex(t => t.id === taskId);
  result[idx] = { ...result[idx], employee: employeeName };
  if (!assignedTasks[employeeName]) assignedTasks[employeeName] = [];
  assignedTasks[employeeName].push(result[idx]);
}

// A delay just shifted some tasks' times. If a delayed task is locked to an
// employee and now overlaps another locked task of that same employee, the
// dispatcher's manual pin can no longer be honoured as-is — relocate the
// delayed task to a different qualified employee, same scoring/fallback
// logic the optimizer uses for unassigned ("Свободно") tasks. Untouched
// locked tasks (not delayed) are left alone, since their conflicts — if
// any — were a deliberate dispatcher override (force-assign).
export function reassignDelayedConflicts(tasks, staffDB, selectedDate, delayedTaskIds) {
  const result = tasks.map(t => ({ ...t }));
  if (!delayedTaskIds || delayedTaskIds.length === 0) return { tasks: result, changes: [] };

  const staff = staffDB[selectedDate] || [];
  if (staff.length === 0) return { tasks: result, changes: [] };

  const assignedTasks = {};
  for (const s of staff) assignedTasks[s.name] = [];
  for (const t of result) {
    if (t.date === selectedDate && t.employee !== 'Не назначено') {
      if (!assignedTasks[t.employee]) assignedTasks[t.employee] = [];
      assignedTasks[t.employee].push(t);
    }
  }

  const delayedSet = new Set(delayedTaskIds);
  const changes = [];

  for (const task of result) {
    if (task.date !== selectedDate || !task.isLocked || !delayedSet.has(task.id)) continue;
    if (task.employee === 'Не назначено') continue;

    const currentEmp = task.employee;
    const empTasks = (assignedTasks[currentEmp] || []).filter(t => t.id !== task.id);
    const conflictsWithLocked = empTasks.some(t => t.isLocked && conflictsWith(t, task));
    if (!conflictsWithLocked) continue;

    assignedTasks[currentEmp] = empTasks;

    // Pass A: best-scoring qualified employee, in shift, no conflicts
    let bestStaff = null, bestScore = null;
    for (const s of staff) {
      if (s.name === currentEmp) continue;
      if (!s.quals.includes(task.reqType)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;
      if (hasConflict(assignedTasks[s.name] || [], task)) continue;
      const score = scoreEmployee(s, assignedTasks, task);
      if (!bestScore || score.dist < bestScore.dist ||
          (score.dist === bestScore.dist && score.load < bestScore.load)) {
        bestScore = score; bestStaff = s;
      }
    }

    // Pass B: relax shift constraint (overtime), still no conflicts
    if (!bestStaff) {
      let bestLoad = Infinity;
      for (const s of staff) {
        if (s.name === currentEmp) continue;
        if (!s.quals.includes(task.reqType)) continue;
        if (hasConflict(assignedTasks[s.name] || [], task)) continue;
        const load = (assignedTasks[s.name] || []).length;
        if (load < bestLoad) { bestLoad = load; bestStaff = s; }
      }
    }

    const idx = result.findIndex(t => t.id === task.id);
    if (bestStaff) {
      result[idx] = { ...result[idx], employee: bestStaff.name };
      if (!assignedTasks[bestStaff.name]) assignedTasks[bestStaff.name] = [];
      assignedTasks[bestStaff.name].push(result[idx]);
      changes.push({ taskId: task.id, taskName: task.name, from: currentEmp, to: bestStaff.name, backlog: false });
    } else {
      result[idx] = { ...result[idx], employee: 'Не назначено', isLocked: false };
      changes.push({ taskId: task.id, taskName: task.name, from: currentEmp, to: null, backlog: true });
    }
  }

  return { tasks: result, changes };
}

export function runOptimizer(tasks, staffDB, selectedDate) {
  let result = tasks.map(t =>
    t.date === selectedDate && !t.isLocked
      ? { ...t, employee: 'Не назначено' }
      : { ...t }
  );

  const staff = staffDB[selectedDate] || [];
  if (staff.length === 0) return result;

  const assignedTasks = {};
  for (const s of staff) assignedTasks[s.name] = [];

  // Pre-load locked tasks into the assignment map
  for (const t of result) {
    if (t.date === selectedDate && t.isLocked && t.employee !== 'Не назначено') {
      if (!assignedTasks[t.employee]) assignedTasks[t.employee] = [];
      assignedTasks[t.employee].push(t);
    }
  }

  const toAssign = result.filter(t => t.date === selectedDate && !t.isLocked);

  // Sort by difficulty: tasks with fewer eligible employees go first
  // so rare/constrained tasks get first pick of available staff
  const difficulty = new Map(
    toAssign.map(t => [
      t.id,
      staff.filter(s =>
        s.quals.includes(t.reqType) &&
        s.shiftStart <= t.start &&
        t.end <= s.shiftEnd
      ).length,
    ])
  );
  toAssign.sort((a, b) => {
    const diff = difficulty.get(a.id) - difficulty.get(b.id);
    return diff !== 0 ? diff : a.start - b.start;
  });

  // ── PASS 1: Greedy – best-scoring employee within shift ──────────────────
  let backlog = [];
  for (const task of toAssign) {
    let bestStaff = null, bestScore = null;
    for (const s of staff) {
      if (!s.quals.includes(task.reqType)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;
      if (hasConflict(assignedTasks[s.name] || [], task)) continue;
      const score = scoreEmployee(s, assignedTasks, task);
      if (!bestScore || score.dist < bestScore.dist ||
          (score.dist === bestScore.dist && score.load < bestScore.load)) {
        bestScore = score; bestStaff = s;
      }
    }
    bestStaff ? commit(result, assignedTasks, task.id, bestStaff.name) : backlog.push(task);
  }

  // ── PASS 2: Rotation – relocate conflicting tasks to free up a slot ──────
  let remaining = [];
  for (const task of backlog) {
    let resolved = false;
    for (const s of staff) {
      if (resolved) break;
      if (!s.quals.includes(task.reqType)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;

      const empTasks = assignedTasks[s.name] || [];
      const conflicts = empTasks.filter(ct => conflictsWith(ct, task));

      if (conflicts.length === 0) {
        commit(result, assignedTasks, task.id, s.name);
        resolved = true; break;
      }
      if (conflicts.some(ct => ct.isLocked)) continue;

      // Try to move every conflict to an alternate employee
      const migrations = [];
      let allMoved = true;
      const tempAssigned = Object.fromEntries(
        Object.entries(assignedTasks).map(([k, v]) => [k, [...v]])
      );
      for (const conflict of conflicts) {
        let moved = false;
        for (const alt of staff) {
          if (alt.name === s.name) continue;
          if (!alt.quals.includes(conflict.reqType)) continue;
          if (alt.shiftStart > conflict.start || conflict.end > alt.shiftEnd) continue;
          if (!hasConflict(tempAssigned[alt.name] || [], conflict)) {
            migrations.push({ task: conflict, from: s.name, to: alt.name });
            tempAssigned[s.name] = tempAssigned[s.name].filter(t => t.id !== conflict.id);
            if (!tempAssigned[alt.name]) tempAssigned[alt.name] = [];
            tempAssigned[alt.name].push(conflict);
            moved = true; break;
          }
        }
        if (!moved) { allMoved = false; break; }
      }
      if (allMoved) {
        for (const { task: mt, from, to } of migrations) {
          const idx = result.findIndex(t => t.id === mt.id);
          result[idx] = { ...result[idx], employee: to };
          assignedTasks[from] = assignedTasks[from].filter(t => t.id !== mt.id);
          if (!assignedTasks[to]) assignedTasks[to] = [];
          assignedTasks[to].push(result[idx]);
        }
        commit(result, assignedTasks, task.id, s.name);
        resolved = true;
      }
    }
    if (!resolved) remaining.push(task);
  }

  // ── PASS 3: Relax shift constraint (overtime / boundary extension) ────────
  // A qualified employee exists but the task falls slightly outside their shift.
  // Assign to the least-loaded qualified employee who has no time conflict.
  let forced = [];
  for (const task of remaining) {
    let bestStaff = null, bestLoad = Infinity;
    for (const s of staff) {
      if (!s.quals.includes(task.reqType)) continue;
      // Shift check removed intentionally — allow overtime assignment
      if (hasConflict(assignedTasks[s.name] || [], task)) continue;
      const load = (assignedTasks[s.name] || []).length;
      if (load < bestLoad) { bestLoad = load; bestStaff = s; }
    }
    bestStaff ? commit(result, assignedTasks, task.id, bestStaff.name) : forced.push(task);
  }

  // ── PASS 4: Force assign – last resort, ignore all time conflicts ─────────
  // Assign to the least-loaded employee who has the required qualification.
  // This guarantees zero backlog as long as any qualified staff exists.
  for (const task of forced) {
    const qualified = staff
      .filter(s => s.quals.includes(task.reqType))
      .sort((a, b) => (assignedTasks[a.name] || []).length - (assignedTasks[b.name] || []).length);
    if (qualified.length > 0) {
      commit(result, assignedTasks, task.id, qualified[0].name);
    }
    // If truly no qualified staff exists, the task stays unassigned
  }

  return result;
}
