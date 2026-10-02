// Runs the heavy optimizer calls off the page's main thread, so the UI stays
// responsive (spinner, scrolling) while a few-second job is computed. Plain
// message protocol: { id, kind, payload } in, { id, result } or { id, error }
// out. The distance resolver is rebuilt here from the raw rows (functions
// can't cross the thread boundary) and kept until the rows' key changes.
import { createDistanceResolver } from './utils/travelGraph.js';
import { runOptimizer, improveAssignment, applyChanges } from './optimizer.js';
import { resolveStaffingWithCallIns } from './utils/staffingGap.js';

let resolverKey = null;
let resolver = null;
function resolverFor(p) {
  if (!p.resolverRows) return null;
  if (resolverKey !== p.resolverKey) {
    resolver = createDistanceResolver(p.resolverRows);
    resolverKey = p.resolverKey;
  }
  return resolver;
}

self.onmessage = e => {
  const { id, kind, payload: p } = e.data;
  try {
    const r = resolverFor(p);
    let result;
    if (kind === 'run') {
      const built = runOptimizer(p.tasks, p.staffDB, p.selectedDate, r, p.windowDates, undefined, { weights: p.weights });
      result = improveAssignment(built, p.staffDB, p.selectedDate, r, p.windowDates, { weights: p.weights }).tasks;
    } else if (kind === 'changes') {
      result = applyChanges(p.tasks, p.staffDB, p.selectedDate, r, p.windowDates, p.changes, p.options);
    } else if (kind === 'gap') {
      result = resolveStaffingWithCallIns({ ...p.args, distanceResolver: r });
    } else {
      throw new Error('unknown job: ' + kind);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
