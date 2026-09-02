import { getPosDistance } from './utils/posDistance';

const MIN_TRANSITION_MS = 5 * 60000;
const MIN_TRANSITION_POS_DIST = 5;

function tasksOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// A staff member is eligible for a task only if they hold EVERY qualification
// the task requires (AND, not OR) — a task's req_qual_vector can list more
// than one required qualification (e.g. aircraft type + SV), and all of them
// must be present in the employee/shift's quals.
export function hasAllQuals(staffQuals, task) {
  const required = task.reqTypes || (task.reqType ? [task.reqType] : []);
  return required.every(q => staffQuals.includes(q));
}

// True when two POS codes are the same physical stand. Prefers the real
// travel-network resolver (same graph node) when one is loaded; falls back
// to the plain string heuristic otherwise.
function samePosition(pos1, pos2, resolver) {
  if (resolver) {
    const m = resolver.metersBetween(pos1, pos2);
    if (m != null) return m === 0;
  }
  return getPosDistance(pos1, pos2) === 0;
}

// Back-to-back tasks at meaningfully different positions need walking/driving
// time between them — without it the assignment isn't physically realistic.
// With a real distance resolver loaded, this compares the actual gap against
// how long the walk would take (see travelGraph.js's WALK_SPEED_MPS); without
// one, it falls back to the old fixed distance-units/time-window heuristic.
function hasInsufficientGap(a, b, resolver) {
  const earlier = a.start <= b.start ? a : b;
  const later = a.start <= b.start ? b : a;
  if (later.start < earlier.end) return false; // overlap is handled by tasksOverlap
  const gapMs = later.start - earlier.end;

  const neededSeconds = resolver ? resolver.secondsBetween(earlier.pos, later.pos) : null;
  if (neededSeconds != null) {
    return gapMs < neededSeconds * 1000;
  }
  return gapMs < MIN_TRANSITION_MS && getPosDistance(earlier.pos, later.pos) >= MIN_TRANSITION_POS_DIST;
}

// Exported so BacklogPanel's manual-assignment conflict check uses the exact
// same rule as the optimizer instead of maintaining its own copy — the two
// diverging once already caused a real double-booking bug.
export function conflictsWith(a, b, resolver) {
  // Same flight + same stand + different task name = complementary roles on
  // the same physical aircraft turn → overlap allowed for one employee.
  // Same flight + same task name = 2 identical tasks → need 2 different
  // people, NO exemption. The same-stand check matters: two unrelated
  // orders can share a flight_ref (e.g. arrival/departure legs of different
  // turns linking to the same flight entity) while sitting at completely
  // different stands — that's two jobs a person can't physically do at
  // once, not a complementary pair, so it must still count as a conflict.
  if (a.flight === b.flight && a.flight !== 'Рейс не указ.' && a.name !== b.name &&
      samePosition(a.pos, b.pos, resolver)) {
    return false;
  }
  return tasksOverlap(a, b) || hasInsufficientGap(a, b, resolver);
}

function hasConflict(empTasks, newTask, resolver) {
  return empTasks.some(t => conflictsWith(t, newTask, resolver));
}

function getLastTaskPos(empTasks, beforeTime) {
  const prior = empTasks
    .filter(t => t.end <= beforeTime)
    .sort((a, b) => b.end - a.end);
  return prior.length > 0 ? prior[0].pos : null;
}

function scoreEmployee(staff, assignedTasks, task, resolver) {
  const empTasks = assignedTasks[staff.name] || [];
  const lastPos = getLastTaskPos(empTasks, task.start);
  const hasSameFlightDiffTask = empTasks.some(t =>
    t.flight === task.flight && task.flight !== 'Рейс не указ.' && t.name !== task.name
  );
  let dist;
  if (hasSameFlightDiffTask) {
    dist = 0;
  } else if (lastPos) {
    const meters = resolver ? resolver.metersBetween(lastPos, task.pos) : null;
    dist = meters != null ? meters : getPosDistance(lastPos, task.pos);
  } else {
    dist = 10;
  }
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
export function reassignDelayedConflicts(tasks, staffDB, selectedDate, delayedTaskIds, resolver) {
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
    const conflictsWithLocked = empTasks.some(t => t.isLocked && conflictsWith(t, task, resolver));
    if (!conflictsWithLocked) continue;

    assignedTasks[currentEmp] = empTasks;

    // Pass A: best-scoring qualified employee, in shift, no conflicts.
    // Load is compared first so tasks spread across everyone qualified
    // instead of piling onto whoever happens to be positionally closest —
    // distance only breaks ties between similarly-loaded candidates.
    let bestStaff = null, bestScore = null;
    for (const s of staff) {
      if (s.name === currentEmp) continue;
      if (!hasAllQuals(s.quals, task)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;
      if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
      const score = scoreEmployee(s, assignedTasks, task, resolver);
      if (!bestScore || score.load < bestScore.load ||
          (score.load === bestScore.load && score.dist < bestScore.dist)) {
        bestScore = score; bestStaff = s;
      }
    }

    // Pass B: relax only the shift END boundary (stay a little late to
    // finish) — still requires the task to START during the shift, and
    // still no conflicts.
    if (!bestStaff) {
      let bestLoad = Infinity;
      for (const s of staff) {
        if (s.name === currentEmp) continue;
        if (!hasAllQuals(s.quals, task)) continue;
        if (s.shiftStart > task.start || task.start > s.shiftEnd) continue;
        if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
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

export function runOptimizer(tasks, staffDB, selectedDate, resolver) {
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
        hasAllQuals(s.quals, t) &&
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
  // Load is compared before distance so work spreads across everyone
  // qualified instead of piling onto whoever happens to be positionally
  // closest each time — without this, an employee whose last task ends near
  // the next one keeps winning indefinitely while equally-qualified staff
  // sit idle (distance only breaks ties between similarly-loaded people).
  let backlog = [];
  for (const task of toAssign) {
    let bestStaff = null, bestScore = null;
    for (const s of staff) {
      if (!hasAllQuals(s.quals, task)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;
      if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
      const score = scoreEmployee(s, assignedTasks, task, resolver);
      if (!bestScore || score.load < bestScore.load ||
          (score.load === bestScore.load && score.dist < bestScore.dist)) {
        bestScore = score; bestStaff = s;
      }
    }
    bestStaff ? commit(result, assignedTasks, task.id, bestStaff.name) : backlog.push(task);
  }

  // ── PASS 2: Rotation – relocate conflicting tasks to free up a slot ──────
  // Try least-loaded staff first (recomputed per task, since assignments
  // shift as tasks get placed) — the previous fixed staff-array order let
  // whoever came first alphabetically/positionally soak up every task that
  // fell through to this pass.
  let remaining = [];
  for (const task of backlog) {
    let resolved = false;
    const staffByLoad = [...staff].sort(
      (a, b) => (assignedTasks[a.name] || []).length - (assignedTasks[b.name] || []).length
    );
    for (const s of staffByLoad) {
      if (resolved) break;
      if (!hasAllQuals(s.quals, task)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;

      const empTasks = assignedTasks[s.name] || [];
      const conflicts = empTasks.filter(ct => conflictsWith(ct, task, resolver));

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
        for (const alt of staffByLoad) {
          if (alt.name === s.name) continue;
          if (!hasAllQuals(alt.quals, conflict)) continue;
          if (alt.shiftStart > conflict.start || conflict.end > alt.shiftEnd) continue;
          if (!hasConflict(tempAssigned[alt.name] || [], conflict, resolver)) {
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

  // ── PASS 3: Relax shift constraint (finish slightly late) ─────────────────
  // A qualified employee exists but the task runs a bit past their shift end.
  // Only the END boundary is relaxed — the task must still START during the
  // employee's shift, so this is "stay a little late to finish", never
  // "show up hours after your shift ended". Assign to the least-loaded
  // qualified employee who has no time conflict.
  let forced = [];
  for (const task of remaining) {
    let bestStaff = null, bestLoad = Infinity;
    for (const s of staff) {
      if (!hasAllQuals(s.quals, task)) continue;
      if (s.shiftStart > task.start || task.start > s.shiftEnd) continue;
      if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
      const load = (assignedTasks[s.name] || []).length;
      if (load < bestLoad) { bestLoad = load; bestStaff = s; }
    }
    bestStaff ? commit(result, assignedTasks, task.id, bestStaff.name) : forced.push(task);
  }

  // ── PASS 4: Force assign – last resort, ignore only conflicts ─────────────
  // Assign to the least-loaded employee who has the required qualification
  // AND is actually on shift when the task starts — this ignores conflicts
  // with other assigned tasks (ODO-222-style genuine last resort) but still
  // never sends someone to a task hours outside their working hours. If no
  // one is on shift for it, the task stays in the backlog instead.
  for (const task of forced) {
    const qualified = staff
      .filter(s => hasAllQuals(s.quals, task) && s.shiftStart <= task.start && task.start <= s.shiftEnd)
      .sort((a, b) => (assignedTasks[a.name] || []).length - (assignedTasks[b.name] || []).length);
    if (qualified.length > 0) {
      commit(result, assignedTasks, task.id, qualified[0].name);
    }
    // If truly no staff is on shift when the task starts, it stays unassigned
  }

  return result;
}
