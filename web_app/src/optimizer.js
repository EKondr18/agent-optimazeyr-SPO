import { getPosDistance } from './utils/posDistance';

function tasksOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function hasConflict(empTasks, newTask) {
  // Tasks on same flight are exempt from overlap check
  for (const t of empTasks) {
    if (t.flight === newTask.flight && t.flight !== 'Рейс не указ.') continue;
    if (tasksOverlap(t, newTask)) return true;
  }
  return false;
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
  // Bonus: already has task on same flight → distance = 0
  const hasSameFlight = empTasks.some(t =>
    t.flight === task.flight && task.flight !== 'Рейс не указ.'
  );
  const dist = hasSameFlight ? 0 : (lastPos ? getPosDistance(lastPos, task.pos) : 10);
  const load = empTasks.length;
  return { dist, load };
}

export function runOptimizer(tasks, staffDB, selectedDate) {
  // Shallow-copy tasks; deep-copy objects for selectedDate
  let result = tasks.map(t =>
    t.date === selectedDate && !t.isLocked
      ? { ...t, employee: 'Не назначено' }
      : { ...t }
  );

  const staff = staffDB[selectedDate] || [];
  if (staff.length === 0) return result;

  // Build working assignment map: empName → Task[]
  const assignedTasks = {};
  for (const s of staff) assignedTasks[s.name] = [];

  // Collect locked tasks into assignedTasks first
  for (const t of result) {
    if (t.date === selectedDate && t.isLocked && t.employee !== 'Не назначено') {
      if (!assignedTasks[t.employee]) assignedTasks[t.employee] = [];
      assignedTasks[t.employee].push(t);
    }
  }

  // Sort unlocked tasks on selectedDate by start time
  const toAssign = result
    .filter(t => t.date === selectedDate && !t.isLocked)
    .sort((a, b) => a.start - b.start);

  const backlog = [];

  // ── PASS 1: Greedy assignment ────────────────────────────────────────────────
  for (const task of toAssign) {
    let bestStaff = null;
    let bestScore = null;

    for (const s of staff) {
      if (!s.quals.includes(task.reqType)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;

      const empTasks = assignedTasks[s.name] || [];
      if (hasConflict(empTasks, task)) continue;

      const score = scoreEmployee(s, assignedTasks, task);
      if (
        bestScore === null ||
        score.dist < bestScore.dist ||
        (score.dist === bestScore.dist && score.load < bestScore.load)
      ) {
        bestScore = score;
        bestStaff = s;
      }
    }

    if (bestStaff) {
      const idx = result.findIndex(t => t.id === task.id);
      result[idx] = { ...result[idx], employee: bestStaff.name };
      if (!assignedTasks[bestStaff.name]) assignedTasks[bestStaff.name] = [];
      assignedTasks[bestStaff.name].push(result[idx]);
    } else {
      backlog.push(task);
    }
  }

  // ── PASS 2: Rotation for backlog tasks ───────────────────────────────────────
  for (const task of backlog) {
    let resolved = false;

    for (const s of staff) {
      if (resolved) break;
      if (!s.quals.includes(task.reqType)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;

      const empTasks = assignedTasks[s.name] || [];
      const conflicts = empTasks.filter(ct => {
        if (ct.flight === task.flight && task.flight !== 'Рейс не указ.') return false;
        return tasksOverlap(ct, task);
      });

      if (conflicts.length === 0) {
        // No conflicts — assign directly (shouldn't normally happen but handle it)
        const idx = result.findIndex(t => t.id === task.id);
        result[idx] = { ...result[idx], employee: s.name };
        if (!assignedTasks[s.name]) assignedTasks[s.name] = [];
        assignedTasks[s.name].push(result[idx]);
        resolved = true;
        break;
      }

      // Check none are locked
      if (conflicts.some(ct => ct.isLocked)) continue;

      // Try to relocate each conflict
      const migrations = []; // [{task, from, to}]
      let allMoved = true;

      const tempAssigned = Object.fromEntries(
        Object.entries(assignedTasks).map(([k, v]) => [k, [...v]])
      );

      for (const conflict of conflicts) {
        let moved = false;
        for (const altStaff of staff) {
          if (altStaff.name === s.name) continue;
          if (!altStaff.quals.includes(conflict.reqType)) continue;
          if (altStaff.shiftStart > conflict.start || conflict.end > altStaff.shiftEnd) continue;

          const altTasks = tempAssigned[altStaff.name] || [];
          if (!hasConflict(altTasks, conflict)) {
            migrations.push({ task: conflict, from: s.name, to: altStaff.name });
            // Update temp state
            tempAssigned[s.name] = (tempAssigned[s.name] || []).filter(t => t.id !== conflict.id);
            if (!tempAssigned[altStaff.name]) tempAssigned[altStaff.name] = [];
            tempAssigned[altStaff.name].push(conflict);
            moved = true;
            break;
          }
        }
        if (!moved) { allMoved = false; break; }
      }

      if (allMoved) {
        // Commit migrations
        for (const { task: mt, from, to } of migrations) {
          const idx = result.findIndex(t => t.id === mt.id);
          result[idx] = { ...result[idx], employee: to };
          assignedTasks[from] = (assignedTasks[from] || []).filter(t => t.id !== mt.id);
          if (!assignedTasks[to]) assignedTasks[to] = [];
          assignedTasks[to].push(result[idx]);
        }
        // Assign the backlog task
        const idx = result.findIndex(t => t.id === task.id);
        result[idx] = { ...result[idx], employee: s.name };
        if (!assignedTasks[s.name]) assignedTasks[s.name] = [];
        assignedTasks[s.name].push(result[idx]);
        resolved = true;
      }
    }
  }

  return result;
}
