import { getPosDistance } from './utils/posDistance';

function tasksOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function hasConflict(empTasks, newTask) {
  for (const t of empTasks) {
    // Same flight + DIFFERENT task name = working same plane with different role → allow overlap
    // Same flight + SAME task name = 2 identical tasks need 2 different people → do NOT exempt
    if (t.flight === newTask.flight && t.flight !== 'Рейс не указ.' && t.name !== newTask.name) continue;
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
  // Bonus distance only when employee has a DIFFERENT task on same flight (complementary roles)
  const hasSameFlightDiffTask = empTasks.some(t =>
    t.flight === task.flight && task.flight !== 'Рейс не указ.' && t.name !== task.name
  );
  const dist = hasSameFlightDiffTask ? 0 : (lastPos ? getPosDistance(lastPos, task.pos) : 10);
  const load = empTasks.length;
  return { dist, load };
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

  for (const t of result) {
    if (t.date === selectedDate && t.isLocked && t.employee !== 'Не назначено') {
      if (!assignedTasks[t.employee]) assignedTasks[t.employee] = [];
      assignedTasks[t.employee].push(t);
    }
  }

  const toAssign = result
    .filter(t => t.date === selectedDate && !t.isLocked)
    .sort((a, b) => a.start - b.start);

  const backlog = [];

  // ── PASS 1: Greedy assignment ──────────────────────────────────────────────
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

  // ── PASS 2: Rotation for backlog tasks ────────────────────────────────────
  for (const task of backlog) {
    let resolved = false;

    for (const s of staff) {
      if (resolved) break;
      if (!s.quals.includes(task.reqType)) continue;
      if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;

      const empTasks = assignedTasks[s.name] || [];
      const conflicts = empTasks.filter(ct => {
        if (ct.flight === task.flight && task.flight !== 'Рейс не указ.' && ct.name !== task.name) return false;
        return tasksOverlap(ct, task);
      });

      if (conflicts.length === 0) {
        const idx = result.findIndex(t => t.id === task.id);
        result[idx] = { ...result[idx], employee: s.name };
        if (!assignedTasks[s.name]) assignedTasks[s.name] = [];
        assignedTasks[s.name].push(result[idx]);
        resolved = true;
        break;
      }

      if (conflicts.some(ct => ct.isLocked)) continue;

      const migrations = [];
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
        for (const { task: mt, from, to } of migrations) {
          const idx = result.findIndex(t => t.id === mt.id);
          result[idx] = { ...result[idx], employee: to };
          assignedTasks[from] = (assignedTasks[from] || []).filter(t => t.id !== mt.id);
          if (!assignedTasks[to]) assignedTasks[to] = [];
          assignedTasks[to].push(result[idx]);
        }
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
