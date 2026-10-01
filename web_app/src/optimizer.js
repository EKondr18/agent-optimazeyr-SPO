import { getPosDistance } from './utils/posDistance.js';

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
// Per the corporate spec ("22.05. Учет расстояний сети передвижения..."),
// the reference points aren't just each task's generic POS: the employee's
// actual EXIT point from the earlier task is its clearup_loc_ref, falling
// back to dest_loc_ref (task.exitPos below), and their ENTRY point into the
// later task is its setup_loc_ref, falling back to start_loc_ref
// (task.entryPos) — using plain start-position for both ends, as before,
// would get the exit side wrong for any task with a distinct closing
// procedure. With a real distance resolver loaded, this compares the
// actual gap against how long that walk would take (see travelGraph.js's
// WALK_SPEED_MPS); without one, it falls back to the old fixed
// distance-units/time-window heuristic.
function hasInsufficientGap(a, b, resolver) {
  const earlier = a.start <= b.start ? a : b;
  const later = a.start <= b.start ? b : a;
  if (later.start < earlier.end) return false; // overlap is handled by tasksOverlap
  const gapMs = later.start - earlier.end;
  const exitPos = earlier.exitPos ?? earlier.pos;
  const entryPos = later.entryPos ?? later.pos;

  const neededSeconds = resolver ? resolver.secondsBetween(exitPos, entryPos) : null;
  if (neededSeconds != null) {
    return gapMs < neededSeconds * 1000;
  }
  return gapMs < MIN_TRANSITION_MS && getPosDistance(exitPos, entryPos) >= MIN_TRANSITION_POS_DIST;
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

// Every conflicting task if `task` were assigned to `employeeName` (empty =
// no conflict). Exported so every manual-assignment entry point (backlog
// select+button, Gantt drag-and-drop) checks the exact same rule instead of
// each keeping its own copy — a past duplicate of this logic drifted out of
// sync with the optimizer's and caused a real double-booking bug.
export function findConflicts(employeeName, task, tasks, resolver) {
  const empTasks = tasks.filter(t => t.employee === employeeName && t.id !== task.id);
  return empTasks.filter(et => conflictsWith(et, task, resolver));
}

// Where the employee actually ends up after their last task before the new
// one — the exit point (clearup_loc_ref / dest_loc_ref), not the generic POS.
function getLastTaskExitPos(empTasks, beforeTime) {
  const prior = empTasks
    .filter(t => t.end <= beforeTime)
    .sort((a, b) => b.end - a.end);
  return prior.length > 0 ? (prior[0].exitPos ?? prior[0].pos) : null;
}

// Mirror of the above, looking forward: where the employee needs to be for
// their next task after this one — needed for the insertion-cost scoring
// below, which cares about both neighbours of a slot, not just the one
// before it.
function getNextTaskEntryPos(empTasks, afterTime) {
  const next = empTasks
    .filter(t => t.start >= afterTime)
    .sort((a, b) => a.start - b.start);
  return next.length > 0 ? (next[0].entryPos ?? next[0].pos) : null;
}

function posDist(posA, posB, resolver) {
  const meters = resolver ? resolver.metersBetween(posA, posB) : null;
  return meters != null ? meters : getPosDistance(posA, posB);
}

// Per the corporate spec: inserting a task between two others already on a
// shift changes the travel cost of BOTH the new task and whichever task
// follows it — scoring by "distance from the previous task" alone (as this
// used to) only sees half of that. This uses the classic cheapest-insertion
// cost instead: dist(before, task) + dist(task, after) - dist(before, after)
// — the actual marginal distance this task adds to the employee's day, given
// where they already are before and after it, not just a one-sided look-back.
//
// When there's no real predecessor task yet (this would be the first task
// of the employee's day, or the first one before whatever's already
// scheduled), the shift's own base location (staff.basePos) stands in as
// the virtual predecessor — the same reference point the spec uses for a
// shift's very first task, not a special case needing separate handling.
function scoreEmployee(staff, assignedTasks, task, resolver) {
  const empTasks = assignedTasks[staff.name] || [];
  const lastExitPos = getLastTaskExitPos(empTasks, task.start) ?? staff.basePos ?? null;
  const nextEntryPos = getNextTaskEntryPos(empTasks, task.end);
  const entryPos = task.entryPos ?? task.pos;
  const exitPos = task.exitPos ?? task.pos;
  const hasSameFlightDiffTask = empTasks.some(t =>
    t.flight === task.flight && task.flight !== 'Рейс не указ.' && t.name !== task.name
  );
  let dist;
  if (hasSameFlightDiffTask) {
    dist = 0;
  } else if (lastExitPos && nextEntryPos) {
    const distBefore = posDist(lastExitPos, entryPos, resolver);
    const distAfter = posDist(exitPos, nextEntryPos, resolver);
    const distDirect = posDist(lastExitPos, nextEntryPos, resolver);
    dist = Math.max(0, distBefore + distAfter - distDirect);
  } else if (lastExitPos) {
    dist = posDist(lastExitPos, entryPos, resolver);
  } else if (nextEntryPos) {
    dist = posDist(exitPos, nextEntryPos, resolver);
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

// Staff pool merged across a window of dates (the planning window, e.g.
// selectedDate ±1 day), de-duplicated by (name, shiftStart) since a shift
// crossing midnight is bucketed under more than one date.
function mergeStaffWindow(staffDB, dates) {
  const map = new Map();
  for (const d of dates) {
    for (const s of staffDB[d] || []) {
      const key = `${s.name}__${s.shiftStart.getTime()}`;
      if (!map.has(key)) map.set(key, s);
    }
  }
  return [...map.values()];
}

// Recursively searches for SOME way to place `task` onto a qualified,
// in-shift employee — directly if someone's free, or by chaining through
// as many bumps as it takes (displacing one person's own non-locked
// conflicting task onto someone else, whose own conflict may itself need
// bumping, and so on) rather than giving up after a single hop. Not capped
// at "3 people" or any fixed hop count — it keeps going through whoever's
// left in the pool as long as it's still making progress. `visited` guards
// against cycles AND against re-exploring: an employee already "opened up"
// anywhere in this search — whether that attempt worked or not — is skipped
// rather than revisited (the classic augmenting-path rule). The visited set is
// never un-marked on backtrack: doing that made the search exponential once
// many tasks were stuck, since every dead end got re-explored through each
// different route. Now each employee is opened at most once per search, so it
// always terminates, in polynomial time, however long the chain gets.
//
// Returns { assigned, migrations } on success (an updated assignment map
// plus the ordered list of {task, to} moves that produced it) or null if no
// placement exists anywhere in the chain.
//
// `isBumpable` says which already-placed tasks may be displaced — by default
// anything not locked, but callers that also freeze work by time (already
// started / outside the repair window) must say so, or a chain could move a
// task that must stay put.
function findChainPlacement(task, staffByLoad, assigned, resolver, visited, isBumpable = t => !t.isLocked) {
  for (const s of staffByLoad) {
    if (visited.has(s.name)) continue;
    if (!hasAllQuals(s.quals, task)) continue;
    if (s.shiftStart > task.start || task.end > s.shiftEnd) continue;

    const empTasks = assigned[s.name] || [];
    const conflicts = empTasks.filter(ct => conflictsWith(ct, task, resolver));

    if (conflicts.length === 0) {
      return { assigned: { ...assigned, [s.name]: [...empTasks, task] }, migrations: [{ task, to: s.name }] };
    }
    if (conflicts.some(ct => !isBumpable(ct))) continue;

    visited.add(s.name);
    let working = { ...assigned, [s.name]: empTasks.filter(t => !conflicts.includes(t)) };
    const chainMigrations = [];
    let ok = true;
    for (const conflict of conflicts) {
      const sub = findChainPlacement(conflict, staffByLoad, working, resolver, visited, isBumpable);
      if (!sub) { ok = false; break; }
      working = sub.assigned;
      chainMigrations.push(...sub.migrations);
    }

    if (ok) {
      working = { ...working, [s.name]: [...(working[s.name] || []), task] };
      chainMigrations.push({ task, to: s.name });
      return { assigned: working, migrations: chainMigrations };
    }
  }
  return null;
}

// Minimal-disruption repair for a near-term "stability window" — a
// dispatcher shouldn't see someone's near-future assignment change just
// because a FULL re-optimization found a marginally nicer fit somewhere.
// Unlike runOptimizer (which resets and re-searches everything in scope),
// this only ever touches a task that is ACTUALLY broken right now — one
// that genuinely overlaps/collides with another task of the same employee
// — and relocates just that one task, leaving every other assignment in
// [scopeStart, scopeEnd) exactly as it was. Same scoring/fallback logic
// runOptimizer's own passes use, just applied to a single task instead of
// the whole pool.
export function patchConflicts(tasks, staffDB, selectedDate, resolver, windowDates, scopeStart, scopeEnd) {
  const result = tasks.map(t => ({ ...t }));
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const staff = mergeStaffWindow(staffDB, dates);
  if (staff.length === 0) return { tasks: result, changes: [] };

  let assignedTasks = {};
  for (const s of staff) assignedTasks[s.name] = [];
  for (const t of result) {
    if (dates.includes(t.date) && t.employee !== 'Не назначено') {
      if (!assignedTasks[t.employee]) assignedTasks[t.employee] = [];
      assignedTasks[t.employee].push(t);
    }
  }

  const inScope = t =>
    dates.includes(t.date) && !t.isLocked && t.start >= scopeStart && t.start < scopeEnd;
  const changes = [];

  for (const task of result) {
    if (!inScope(task) || task.employee === 'Не назначено') continue;

    const currentEmp = task.employee;
    const empTasks = (assignedTasks[currentEmp] || []).filter(t => t.id !== task.id);
    if (!empTasks.some(t => conflictsWith(t, task, resolver))) continue;

    assignedTasks[currentEmp] = empTasks;

    // Pass A: best-scoring qualified employee, in shift, no conflicts.
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

    // Pass Bump: no one is free outright, but the task MUST land somewhere
    // rather than fall to the backlog — chain through as many displacements
    // as it takes (see findChainPlacement), not just one hop. Tried before
    // relaxing the shift-end boundary below, same precedence as
    // runOptimizer's own PASS 2 vs PASS 3.
    let viaChain = false;
    if (!bestStaff) {
      const staffByLoad = [...staff].sort(
        (a, b) => (assignedTasks[a.name] || []).length - (assignedTasks[b.name] || []).length
      );
      const chain = findChainPlacement(
        task, staffByLoad, assignedTasks, resolver, new Set(),
        t => !t.isLocked && t.start >= scopeStart
      );
      if (chain) {
        // chain.assigned already reflects the FULL outcome (the broken
        // task included) — the shared commit below must only update
        // `result`/`changes` for it, not push into assignedTasks again.
        assignedTasks = chain.assigned;
        // Every migration except the last one (the broken task itself,
        // handled by the shared commit below) is a knock-on displacement.
        for (const { task: mt, to } of chain.migrations.slice(0, -1)) {
          const midx = result.findIndex(t => t.id === mt.id);
          const from = result[midx].employee;
          result[midx] = { ...result[midx], employee: to };
          changes.push({ taskId: mt.id, taskName: mt.name, from, to, backlog: false, viaBump: true });
        }
        bestStaff = { name: chain.migrations[chain.migrations.length - 1].to };
        viaChain = true;
      }
    }

    // Pass B: relax only the shift END boundary, same as runOptimizer's own.
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
      if (!viaChain) {
        if (!assignedTasks[bestStaff.name]) assignedTasks[bestStaff.name] = [];
        assignedTasks[bestStaff.name].push(result[idx]);
      }
      // A chain can resolve by bumping everyone ELSE out of the way and
      // leaving the originally-broken task right where it was — a real
      // outcome, but "moved from S1 to S1" would be a confusing thing to
      // show the dispatcher, so only log an actual move.
      if (bestStaff.name !== currentEmp) {
        changes.push({ taskId: task.id, taskName: task.name, from: currentEmp, to: bestStaff.name, backlog: false });
      }
    } else {
      result[idx] = { ...result[idx], employee: 'Не назначено' };
      changes.push({ taskId: task.id, taskName: task.name, from: currentEmp, to: null, backlog: true });
    }
  }

  return { tasks: result, changes };
}

// ── Cost model ──────────────────────────────────────────────────────────────
// What "better" means for the construction (regret) and the improvement
// search: one weighted sum rather than "load strictly outranks everything",
// so the trade-offs can be tuned. Units: `load` per unit of Σ(tasks per
// employee)², `walk` per metre (or per heuristic unit when no travel network
// is loaded), `slack` per minute of missing buffer between hand-offs,
// `overtime` per minute worked past shift end. The defaults keep load
// balancing dominant, as the greedy passes do.
export const DEFAULT_WEIGHTS = { load: 100, walk: 1, slack: 3, overtime: 5 };

// A hand-off between two consecutive tasks is "tight" when it leaves less
// spare time than this beyond the walk itself. Flights slip; a schedule with
// no margin turns every small delay into a re-plan.
const TARGET_SLACK_MS = 15 * 60000;

export function resolveWeights(weights) {
  return { ...DEFAULT_WEIGHTS, ...(weights || {}) };
}

// How long the walk between two points takes, on the same basis
// hasInsufficientGap uses (real network when loaded, else the heuristic).
function transitMs(exitPos, entryPos, resolver) {
  const seconds = resolver ? resolver.secondsBetween(exitPos, entryPos) : null;
  if (seconds != null) return seconds * 1000;
  return getPosDistance(exitPos, entryPos) >= MIN_TRANSITION_POS_DIST ? MIN_TRANSITION_MS : 0;
}

// One employee's day, measured: walking (shift base point → first task, then
// each exit point → next entry point), minutes of buffer missing below the
// target on each hand-off, and minutes worked past the end of the shift their
// tasks belong to. Overlapping (complementary same-flight) tasks need no
// travel between them, same convention MetricsSummary uses. `sorted` must
// already be ordered by start — the improvement search keeps every
// employee's list that way (see insertSorted) so this never has to sort.
function routeStats(shifts, sorted, resolver) {
  const basePos = shifts?.[0]?.basePos ?? null;
  let walk = 0, slackShort = 0, prev = null;
  for (const t of sorted) {
    const entry = t.entryPos ?? t.pos;
    if (prev === null) {
      if (basePos) walk += posDist(basePos, entry, resolver);
    } else if (t.start >= prev.end) {
      const exit = prev.exitPos ?? prev.pos;
      walk += posDist(exit, entry, resolver);
      const spare = (t.start - prev.end) - transitMs(exit, entry, resolver);
      slackShort += Math.max(0, TARGET_SLACK_MS - spare) / 60000;
    }
    prev = t;
  }
  let overtime = 0;
  for (const s of shifts || []) {
    let maxEnd = null;
    for (const t of sorted) {
      if (t.start >= s.shiftStart && t.start <= s.shiftEnd && (maxEnd === null || t.end > maxEnd)) maxEnd = t.end;
    }
    if (maxEnd && maxEnd > s.shiftEnd) overtime += (maxEnd - s.shiftEnd) / 60000;
  }
  return { walk, slackShort, overtime };
}

// A copy of `list` (ordered by start) with `task` added in its place.
function insertSorted(list, task) {
  let i = list.length;
  while (i > 0 && list[i - 1].start > task.start) i--;
  return [...list.slice(0, i), task, ...list.slice(i)];
}

function employeeCost(W, shifts, sortedTasks, resolver) {
  const r = routeStats(shifts, sortedTasks, resolver);
  return W.load * sortedTasks.length ** 2 + W.walk * r.walk + W.slack * r.slackShort + W.overtime * r.overtime;
}

// Improvement pass, run AFTER the constructive passes have produced a valid
// assignment. The construction commits each task once and never looks back;
// this goes back over what it built and keeps applying whichever single move
// lowers the total weighted cost most — until none does:
//   • place a still-unassigned task (directly where it fits cheapest, else by
//     chaining displacements — a placement always beats leaving it open),
//   • relocate one task to another employee,
//   • swap two tasks between two employees.
// Every candidate is checked with the construction's own rules
// (qualifications, shift bounds, conflicts incl. travel feasibility), so the
// result is always another valid assignment. Each accepted move strictly
// lowers (open tasks, total cost), so the search ends on its own — no time or
// iteration cap.
//
// options:
//   weights          — cost weights (see DEFAULT_WEIGHTS)
//   frozenBefore     — Date; tasks starting earlier (and locked ones) never
//                      move, though they still count for conflicts/cost
//   priorityUntil    — Date; tasks starting before it are searched to
//                      convergence first, then the rest of the movable pool
//   scopeEmployees   — iterable of names; only their tasks are moved at the
//                      start. Any employee a move touches joins the scope, so
//                      a change ripples outward as far as it actually helps
//                      and no further — the incremental mode
//   scopeTaskIds     — iterable of ids; only these unassigned tasks are placed
//                      (even inside the frozen window)
//   pinnedEmployees  — iterable of names whose tasks must not move (they may
//                      still receive tasks)
export function improveAssignment(tasks, staffDB, selectedDate, resolver, windowDates, options = {}) {
  const { frozenBefore, priorityUntil, weights } = options;
  const W = resolveWeights(weights);
  const scope = options.scopeEmployees ? new Set(options.scopeEmployees) : null;
  const scopeTaskIds = options.scopeTaskIds ? new Set(options.scopeTaskIds) : null;
  const pinned = options.pinnedEmployees ? new Set(options.pinnedEmployees) : null;

  const result = tasks.map(t => ({ ...t }));
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const staff = mergeStaffWindow(staffDB, dates);
  const touchedList = () => (scope ? [...scope] : []);
  if (staff.length === 0) return { tasks: result, moves: 0, touched: touchedList() };

  const shiftsByName = new Map();
  for (const s of staff) {
    if (!shiftsByName.has(s.name)) shiftsByName.set(s.name, []);
    shiftsByName.get(s.name).push(s);
  }
  const indexById = new Map(result.map((t, i) => [t.id, i]));

  let byEmp = {};
  const costCache = new Map();
  const gainCache = new Map();
  const rebuildByEmp = () => {
    byEmp = {};
    for (const name of shiftsByName.keys()) byEmp[name] = [];
    for (const t of result) {
      if (dates.includes(t.date) && t.employee !== 'Не назначено') {
        if (!byEmp[t.employee]) byEmp[t.employee] = [];
        byEmp[t.employee].push(t);
      }
    }
    for (const list of Object.values(byEmp)) list.sort((a, b) => a.start - b.start);
    costCache.clear();
    gainCache.clear();
  };
  rebuildByEmp();

  const isMovable = t =>
    dates.includes(t.date) && !t.isLocked && t.employee !== 'Не назначено' &&
    !(pinned && pinned.has(t.employee)) && (!frozenBefore || t.start >= frozenBefore);
  const inScope = name => !scope || scope.has(name);
  const phases = priorityUntil
    ? [t => isMovable(t) && t.start < priorityUntil, isMovable]
    : [isMovable];

  // Qualification + shift-bounds half of "does this task fit this employee" —
  // independent of what else they have, so memoized; the cheap test that
  // rules most (task, employee) pairs out before any cost is computed.
  const staticMemo = new Map();
  const staticFits = (name, task) => {
    const key = name + '\u0000' + task.id;
    let ok = staticMemo.get(key);
    if (ok === undefined) {
      const shifts = shiftsByName.get(name);
      ok = !!shifts && shifts.some(s =>
        hasAllQuals(s.quals, task) && s.shiftStart <= task.start && task.end <= s.shiftEnd
      );
      staticMemo.set(key, ok);
    }
    return ok;
  };
  // `empTasks` = what the employee would already have, WITHOUT this task.
  const fits = (name, task, empTasks) =>
    staticFits(name, task) && !hasConflict(empTasks, task, resolver);
  const costOf = (name, empTasks) => employeeCost(W, shiftsByName.get(name), empTasks, resolver);
  const curCost = name => {
    if (!costCache.has(name)) costCache.set(name, costOf(name, byEmp[name] || []));
    return costCache.get(name);
  };
  const invalidate = name => { costCache.delete(name); gainCache.delete(name); };
  // How much the employee's walking/slack/overtime cost would drop if this one
  // task were taken off them (the load term is handled separately). Used only
  // to rule out hopeless candidates: inserting a task anywhere never costs
  // less than nothing, so if removing it frees up less than a move would add,
  // that move can't help and isn't worth evaluating.
  const walkGain = (name, task) => {
    let m = gainCache.get(name);
    if (!m) { m = new Map(); gainCache.set(name, m); }
    let g = m.get(task.id);
    if (g === undefined) {
      const list = byEmp[name];
      const rest = list.filter(t => t.id !== task.id);
      g = (costOf(name, list) - W.load * list.length ** 2) - (costOf(name, rest) - W.load * rest.length ** 2);
      m.set(task.id, g);
    }
    return g;
  };
  const EPS = 1e-6;
  const reassign = (id, to) => {
    const i = indexById.get(id);
    result[i] = { ...result[i], employee: to };
    return result[i];
  };

  // Place still-unassigned tasks: cheapest direct fit, else a displacement chain.
  const insertBacklog = () => {
    let inserted = 0;
    const pool = result.filter(t =>
      dates.includes(t.date) && !t.isLocked && t.employee === 'Не назначено' &&
      // Tasks the caller names explicitly (a changed task) are placed even
      // inside the frozen window: leaving them open there would be worse.
      (scopeTaskIds ? scopeTaskIds.has(t.id) : (!frozenBefore || t.start >= frozenBefore))
    );
    for (const task of pool) {
      let best = null;
      for (const name of shiftsByName.keys()) {
        const emp = byEmp[name];
        if (!fits(name, task, emp)) continue;
        const delta = costOf(name, insertSorted(emp, task)) - curCost(name);
        if (!best || delta < best.delta) best = { name, delta };
      }
      if (best) {
        const moved = reassign(task.id, best.name);
        byEmp[best.name] = insertSorted(byEmp[best.name], moved);
        invalidate(best.name);
        if (scope) scope.add(best.name);
        inserted++;
        continue;
      }
      const staffByLoad = [...staff].sort(
        (a, b) => (byEmp[a.name] || []).length - (byEmp[b.name] || []).length
      );
      const chain = findChainPlacement(task, staffByLoad, byEmp, resolver, new Set(), isMovable);
      if (!chain) continue;
      for (const { task: mt, to } of chain.migrations) {
        const idx = indexById.get(mt.id);
        if (scope) {
          scope.add(to);
          if (result[idx].employee !== 'Не назначено') scope.add(result[idx].employee);
        }
        result[idx] = { ...result[idx], employee: to };
      }
      rebuildByEmp();
      inserted++;
    }
    return inserted;
  };

  let moves = 0;
  let progress = true;
  // Evaluating every (task, candidate) pair is the expensive part, so the
  // first rounds skip pairs that provably can't improve (see walkGain). That
  // bound is exact except for a rare quirk — a task overlapping a neighbour
  // (complementary same-flight work) can make an insertion cost LESS than
  // nothing — so once the pruned search stops, one more full, unpruned round
  // runs to confirm it's a true local optimum, continuing if it isn't.
  let prune = true;
  while (progress) {
    progress = false;

    const inserted = insertBacklog();
    if (inserted > 0) { moves += inserted; progress = true; }

    for (const isMover of phases) {
      let improved = true;
      while (improved) {
        improved = false;
        const movers = result.filter(t => isMover(t) && inScope(t.employee));
        for (const stale of movers) {
          const task = result[indexById.get(stale.id)];
          if (!isMover(task) || !inScope(task.employee)) continue;
          const A = task.employee;
          const aTasks = byEmp[A];
          const aRest = aTasks.filter(t => t.id !== task.id);
          const costA = curCost(A);
          const costARest = costOf(A, aRest);
          const gainA = walkGain(A, task);

          let best = null;

          // Relocate `task` to another employee.
          for (const B of shiftsByName.keys()) {
            if (B === A) continue;
            const bTasks = byEmp[B];
            // Lower bound on the delta: B's extra load cost minus what A saves.
            if (prune && -gainA + 2 * W.load * (bTasks.length - aTasks.length + 1) >= -EPS) continue;
            if (!fits(B, task, bTasks)) continue;
            const delta = costARest + costOf(B, insertSorted(bTasks, task)) - costA - curCost(B);
            if (delta < -EPS && (!best || delta < best.delta)) best = { kind: 'relocate', B, delta };
          }

          // Swap `task` with a movable task of another employee.
          for (const other of result) {
            if (other.employee === A || !isMovable(other) || !byEmp[other.employee]) continue;
            const B = other.employee;
            if (prune && gainA + walkGain(B, other) <= EPS) continue;
            if (!staticFits(B, task) || !staticFits(A, other)) continue;
            const bTasks = byEmp[B];
            const bRest = bTasks.filter(t => t.id !== other.id);
            if (hasConflict(bRest, task, resolver) || hasConflict(aRest, other, resolver)) continue;
            const delta = costOf(A, insertSorted(aRest, other)) + costOf(B, insertSorted(bRest, task)) - costA - curCost(B);
            if (delta < -EPS && (!best || delta < best.delta)) best = { kind: 'swap', B, other, delta };
          }

          if (!best) continue;
          if (best.kind === 'relocate') {
            const moved = reassign(task.id, best.B);
            byEmp[A] = aRest;
            byEmp[best.B] = insertSorted(byEmp[best.B], moved);
          } else {
            const bRest = byEmp[best.B].filter(t => t.id !== best.other.id);
            const movedTask = reassign(task.id, best.B);
            const movedOther = reassign(best.other.id, A);
            byEmp[A] = insertSorted(aRest, movedOther);
            byEmp[best.B] = insertSorted(bRest, movedTask);
          }
          invalidate(A);
          invalidate(best.B);
          if (scope) scope.add(best.B);
          moves++;
          improved = true;
          progress = true;
        }
      }
    }
    if (!progress && prune) { prune = false; progress = true; }
  }

  return { tasks: result, moves, touched: touchedList() };
}

// Regret-2 construction (replaces the hardest-first order of PASS 1).
// "Hardest first" only counts how many people are qualified at all; it can't
// see that one of them is far better for this task than the rest, or that a
// colleague needs that same person. Regret does: for every open task, take
// its cheapest feasible employee (c1) and second cheapest (c2); regret =
// c2 − c1, i.e. what it costs if the best slot goes to someone else (a task
// with only one feasible employee has infinite regret). Place the task with
// the biggest regret at its best slot, re-cost the employee who just got a
// task, repeat. A placement's cost is the weighted marginal cost: the load it
// adds (2n+1 for an employee already at n) plus the insertion walking
// distance. Returns the tasks nobody could take, for the later passes.
function constructRegret(toAssign, staff, assignedTasks, result, resolver, W) {
  const costFor = (task, s) => {
    if (!hasAllQuals(s.quals, task)) return null;
    if (s.shiftStart > task.start || task.end > s.shiftEnd) return null;
    const emp = assignedTasks[s.name] || [];
    if (hasConflict(emp, task, resolver)) return null;
    return W.load * (2 * emp.length + 1) + W.walk * scoreEmployee(s, assignedTasks, task, resolver).dist;
  };

  const table = new Map(toAssign.map(t => [t.id, staff.map(s => costFor(t, s))]));
  const remaining = new Map(toAssign.map(t => [t.id, t]));
  const backlog = [];

  while (remaining.size > 0) {
    let pick = null;
    for (const [id, task] of remaining) {
      let c1 = null, c2 = null, i1 = -1;
      const costs = table.get(id);
      for (let i = 0; i < costs.length; i++) {
        const c = costs[i];
        if (c === null) continue;
        if (c1 === null || c < c1) { c2 = c1; c1 = c; i1 = i; }
        else if (c2 === null || c < c2) c2 = c;
      }
      if (c1 === null) { backlog.push(task); remaining.delete(id); continue; }
      const regret = c2 === null ? Infinity : c2 - c1;
      if (!pick || regret > pick.regret || (regret === pick.regret && c1 < pick.c1)) {
        pick = { task, i1, regret, c1 };
      }
    }
    if (!pick) break;

    const chosen = staff[pick.i1];
    commit(result, assignedTasks, pick.task.id, chosen.name);
    remaining.delete(pick.task.id);
    // Only the employee who just received a task changed — re-cost that column.
    for (const [id, task] of remaining) {
      const costs = table.get(id);
      staff.forEach((s, i) => { if (s.name === chosen.name) costs[i] = costFor(task, s); });
    }
  }
  return backlog;
}

// windowDates: the planning window (e.g. selectedDate ±1 day) — tasks and
// staff shifts from any date in this window are assignable together, since
// shifts and tasks both routinely cross midnight. Defaults to just
// selectedDate if no window is given.
//
// freezeBeforeTime (optional Date): tasks starting before this instant are
// treated as effectively locked for this run regardless of their own
// isLocked flag — already-started/already-done work never gets swept up
// and reassigned just because something later in the day changed. Only
// tasks at or after this instant are reset and re-searched for a better
// assignment. Omit it to reset/reassign the whole window as before (the
// "Запустить оптимизатор" button's behavior).
//
// options.construction: 'regret' (default) places first whichever task would
// lose most if it missed its best employee (see constructRegret); 'greedy'
// places tasks one by one, hardest first. On the real demo tasks with a
// generated roster, regret starts from far better assignments and, when staff
// is short, leaves noticeably fewer tasks unassigned (27 vs 35 at 16 people),
// while with plenty of staff the two end up about equal after the improvement
// pass. options.weights: cost weights for 'regret' (see DEFAULT_WEIGHTS).
export function runOptimizer(tasks, staffDB, selectedDate, resolver, windowDates, freezeBeforeTime, options = {}) {
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const isFrozen = t => t.isLocked || (freezeBeforeTime && t.start < freezeBeforeTime);

  let result = tasks.map(t =>
    dates.includes(t.date) && !isFrozen(t)
      ? { ...t, employee: 'Не назначено' }
      : { ...t }
  );

  const staff = mergeStaffWindow(staffDB, dates);
  if (staff.length === 0) return result;

  let assignedTasks = {};
  for (const s of staff) assignedTasks[s.name] = [];

  // Pre-load frozen (locked, or already-started) tasks into the assignment
  // map so the passes below treat their time slots as taken.
  for (const t of result) {
    if (dates.includes(t.date) && isFrozen(t) && t.employee !== 'Не назначено') {
      if (!assignedTasks[t.employee]) assignedTasks[t.employee] = [];
      assignedTasks[t.employee].push(t);
    }
  }

  const toAssign = result.filter(t => dates.includes(t.date) && !isFrozen(t));

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
  if ((options.construction ?? 'regret') === 'regret') {
    backlog = constructRegret(toAssign, staff, assignedTasks, result, resolver, resolveWeights(options.weights));
  } else {
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
  }

  // ── PASS 2: Rotation – relocate conflicting tasks to free up a slot ──────
  // Chains through as many displacements as it takes (see
  // findChainPlacement below), not just one hop — a task only falls
  // through to PASS 3 if genuinely nobody in the pool, however rearranged,
  // can fit it. Least-loaded staff tried first (recomputed per task, since
  // assignments shift as tasks get placed) so whoever comes first
  // alphabetically/positionally doesn't soak up every task that falls
  // through to this pass.
  let remaining = [];
  for (const task of backlog) {
    const staffByLoad = [...staff].sort(
      (a, b) => (assignedTasks[a.name] || []).length - (assignedTasks[b.name] || []).length
    );
    const chain = findChainPlacement(task, staffByLoad, assignedTasks, resolver, new Set(), t => !isFrozen(t));
    if (chain) {
      assignedTasks = chain.assigned;
      for (const { task: mt, to } of chain.migrations) {
        const idx = result.findIndex(t => t.id === mt.id);
        result[idx] = { ...result[idx], employee: to };
      }
    } else {
      remaining.push(task);
    }
  }

  // ── PASS 3: Relax shift constraint (finish slightly late) ─────────────────
  // A qualified employee exists but the task runs a bit past their shift end.
  // Only the END boundary is relaxed — the task must still START during the
  // employee's shift, so this is "stay a little late to finish", never
  // "show up hours after your shift ended". Assign to the least-loaded
  // qualified employee who has no time conflict.
  //
  // There used to be a PASS 4 here that force-assigned whatever was left,
  // ignoring conflicts entirely as a "guarantee zero backlog" last resort —
  // that's exactly what put two overlapping, different-stand tasks on the
  // same employee. A task nobody can take without a real double-booking now
  // stays in the backlog instead, for a dispatcher to resolve manually
  // (including a deliberate forced override, if that's genuinely wanted).
  for (const task of remaining) {
    let bestStaff = null, bestLoad = Infinity;
    for (const s of staff) {
      if (!hasAllQuals(s.quals, task)) continue;
      if (s.shiftStart > task.start || task.start > s.shiftEnd) continue;
      if (hasConflict(assignedTasks[s.name] || [], task, resolver)) continue;
      const load = (assignedTasks[s.name] || []).length;
      if (load < bestLoad) { bestLoad = load; bestStaff = s; }
    }
    if (bestStaff) commit(result, assignedTasks, task.id, bestStaff.name);
    // Otherwise the task stays unassigned — no qualified, on-shift, conflict-free employee exists.
  }

  return result;
}

const MIN_DATE = new Date(-8.64e15);
const MAX_DATE = new Date(8.64e15);

// Incremental update for a batch of task changes — the entry point a backend
// calls when the task generator sends, say, 20 new/changed/cancelled tasks.
// Re-solving the whole window for that would be wasteful and would also churn
// assignments nobody asked to touch; this repairs only what the batch
// affects and lets the effect spread exactly as far as it actually helps.
//
//   changes — task objects to add or update (matched by `id`; for an existing
//             task only the supplied fields change, its assignment and lock
//             are kept), or { id, removed: true } to drop one.
//
// Steps: apply the changes → unassign changed tasks their employee can no
// longer take (qualification / shift) → repair conflicts they caused (chains
// of displacements, nothing before `now` is touched) → place the open
// changed tasks and run the improvement search starting from the affected
// employees only; every employee a move touches joins the search, so the
// change ripples outward until nothing more improves.
//
// options:
//   now                — Date: tasks starting before now + frozenWindowMs are
//                        hard-frozen for the improvement search (only the
//                        conflict repair may touch them, when genuinely
//                        broken); omit for no freeze
//   frozenWindowMs     — default 1 h
//   stabilityWindowMs  — default 3 h; the improvement search settles tasks
//                        before now + this first, then the rest
//   farReshuffle       — true: also fully re-optimize everything beyond the
//                        stability window and search the whole pool (what the
//                        frontend's delay module does). Default false: purely
//                        incremental.
//   escalate           — default true. If a changed task is still without an
//                        employee after the incremental repair (the local
//                        chains weren't deep enough), fall back to a fuller
//                        re-optimization and keep it only if it leaves fewer
//                        tasks open. With `now` given this rebuilds only what
//                        starts beyond the stability window — the near term
//                        is never churned for it; without `now` there is no
//                        horizon, so it rebuilds the whole window (and can
//                        move a lot to place one task)
//   weights, construction — see improveAssignment / runOptimizer
//
// Returns { tasks, touched, changedIds, unplaced, repairs, escalated }:
// `unplaced` are changed tasks that still have no employee; `repairs`
// describes each task the conflict repair moved or dropped.
export function applyChanges(tasks, staffDB, selectedDate, resolver, windowDates, changes, options = {}) {
  const {
    now, frozenWindowMs = 3600000, stabilityWindowMs = 3 * 3600000,
    farReshuffle = false, escalate = true, weights, construction,
  } = options;
  const dates = windowDates && windowDates.length > 0 ? windowDates : [selectedDate];
  const frozenBefore = now ? new Date(now.getTime() + frozenWindowMs) : undefined;
  const stabilityEnd = now ? new Date(now.getTime() + stabilityWindowMs) : undefined;

  // 1. Apply the changes; remember which employees they touch.
  const byId = new Map(tasks.map(t => [t.id, t]));
  const touched = new Set();
  const changedIds = new Set();
  for (const c of changes) {
    const old = byId.get(c.id);
    if (old && old.employee !== 'Не назначено') touched.add(old.employee);
    if (c.removed) { byId.delete(c.id); continue; }
    byId.set(c.id, old
      ? { ...old, ...c }
      : { employee: 'Не назначено', isLocked: false, baseStart: c.start, baseEnd: c.end, ...c });
    changedIds.add(c.id);
  }
  let result = [...byId.values()];

  // 2. A changed task its employee can no longer take goes back to open.
  const shiftsByName = new Map();
  for (const sh of mergeStaffWindow(staffDB, dates)) {
    if (!shiftsByName.has(sh.name)) shiftsByName.set(sh.name, []);
    shiftsByName.get(sh.name).push(sh);
  }
  result = result.map(t => {
    if (!changedIds.has(t.id) || t.employee === 'Не назначено' || t.isLocked) return t;
    const ok = (shiftsByName.get(t.employee) || []).some(sh =>
      hasAllQuals(sh.quals, t) && sh.shiftStart <= t.start && t.start <= sh.shiftEnd
    );
    return ok ? t : { ...t, employee: 'Не назначено' };
  });

  // 3. (Optional) full free re-optimization beyond the stability window.
  if (farReshuffle) {
    result = runOptimizer(result, staffDB, selectedDate, resolver, dates, stabilityEnd, { weights, construction });
  }

  // 4. Repair conflicts the changes caused. Nothing before `now` moves.
  const repair = patchConflicts(result, staffDB, selectedDate, resolver, dates, now ?? MIN_DATE, MAX_DATE);
  result = repair.tasks;
  const placeIds = new Set(changedIds);
  for (const c of repair.changes) {
    if (c.from) touched.add(c.from);
    if (c.to) touched.add(c.to);
    if (c.backlog) placeIds.add(c.taskId);
  }
  for (const id of changedIds) {
    const t = result.find(x => x.id === id);
    if (t && t.employee !== 'Не назначено') touched.add(t.employee);
  }

  // 5. Place what's still open and improve from the affected employees outward.
  const improved = improveAssignment(result, staffDB, selectedDate, resolver, dates, {
    weights, frozenBefore, priorityUntil: stabilityEnd,
    scopeEmployees: farReshuffle ? undefined : touched,
    scopeTaskIds: farReshuffle ? undefined : placeIds,
  });

  const openIn = ts => ts.filter(t => dates.includes(t.date) && t.employee === 'Не назначено').length;
  const unplacedOf = ts => ts
    .filter(t => placeIds.has(t.id) && t.employee === 'Не назначено')
    .map(t => t.id);

  let finalTasks = improved.tasks;
  let escalated = false;
  if (escalate && !farReshuffle && unplacedOf(finalTasks).length > 0) {
    const rebuilt = runOptimizer(finalTasks, staffDB, selectedDate, resolver, dates, stabilityEnd, { weights, construction });
    const polished = improveAssignment(rebuilt, staffDB, selectedDate, resolver, dates, {
      weights, frozenBefore, priorityUntil: stabilityEnd,
    }).tasks;
    if (openIn(polished) < openIn(finalTasks)) { finalTasks = polished; escalated = true; }
  }

  return {
    tasks: finalTasks,
    touched: farReshuffle || escalated ? [] : improved.touched,
    changedIds: [...changedIds],
    unplaced: unplacedOf(finalTasks),
    repairs: repair.changes,
    escalated,
  };
}
