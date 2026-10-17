// A network with a stand outside it and an island: a hand-off between two stands
// that nothing connects is impossible however long the gap, and the search must
// see that even when the stand in between is unknown to the network (where the
// heuristic decides) — the nearest neighbours alone are not enough there.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setPolicy, DEFAULT_POLICY, runOptimizer, improveAssignment, planWindow, validatePlan, conflictsWith,
} from '../src/optimizer.js';
import { createDistanceResolver } from '../src/utils/travelGraph.js';

const OPEN = 'Не назначено';
const DATE = '2026-01-01';
const WIN = [DATE];
const D = (h, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));
const mk = (id, start, end, quals, pos) => ({
  id, date: DATE, name: 'T' + id, flight: 'FL' + id, pos, entryPos: pos, exitPos: pos,
  reqType: quals.join(' + '), reqTypes: quals, start, end, employee: OPEN, isLocked: false,
});

// S01 and S04 are in the network (n0 - n1), S02 is a node of its own with no edges (an island),
// S03 is not in tb_location at all.
const resolver = () => createDistanceResolver({
  locations: [
    { internal_id: 'S01', node_ref: 'n0' }, { internal_id: 'S04', node_ref: 'n1' }, { internal_id: 'S02', node_ref: 'nISL' },
  ],
  travelEdges: [{ 'Start node': 'n0', 'End node': 'n1', Distance: 200 }],
});

test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

function scene() {
  const staff = { [DATE]: [{ name: 'P', quals: ['Q4', 'Q3', 'Q2'], shiftStart: D(14), shiftEnd: new Date(Date.UTC(2026, 0, 2, 0, 0)), basePos: null }] };
  const tasks = [
    mk('t1', D(17, 5), D(18, 35), ['Q4'], 'S01'),
    mk('t2', D(20, 25), D(21, 25), ['Q4'], 'S03'),
    mk('t3', D(23, 45), new Date(Date.UTC(2026, 0, 2, 0, 0)), ['Q3', 'Q2'], 'S02'),
  ];
  return { staff, tasks };
}

test('no one is handed a task on an island they cannot walk to from their other stands', () => {
  const r = resolver();
  const { staff, tasks } = scene();
  assert.equal(conflictsWith(tasks[0], tasks[2], r), true, 'the pair itself conflicts (no path S01 - S02)');
  for (const construction of ['regret', 'bestfit', 'greedy']) {
    const out = runOptimizer(tasks, staff, DATE, r, WIN, undefined, { construction });
    assert.deepEqual(validatePlan(out, staff, DATE, r, WIN), [], construction);
    assert.equal(out.find(t => t.id === 't3').employee, OPEN, construction);
  }
  const improved = improveAssignment(runOptimizer(tasks, staff, DATE, r, WIN), staff, DATE, r, WIN);
  assert.deepEqual(validatePlan(improved.tasks, staff, DATE, r, WIN), []);
  const planned = planWindow(tasks, staff, DATE, r, WIN, { lnsIterations: 10 });
  assert.equal(planned.stats.reopenedByCheck, 0, 'the search itself is right: the final check had nothing to reopen');
  assert.deepEqual(planned.stats.violations, []);
});
