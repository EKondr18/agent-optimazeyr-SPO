// Runs the heavy optimizer calls off the page's main thread, so the UI stays
// responsive (spinner, scrolling) while a few-second job is computed. Plain
// message protocol: { id, kind, payload } in, { id, result } or { id, error }
// out. The distance resolver is rebuilt here from the raw rows (functions
// can't cross the thread boundary) and kept until the rows' key changes. The
// operating policy travels with every job — this thread has its own copy of
// the optimizer module, so the page's setPolicy doesn't reach it — and is handed
// to the call itself (a job without one runs under the defaults), so one job's
// rules never carry over into the next.
import { createDistanceResolver } from './utils/travelGraph.js';
import { applyChanges, planWindow, DEFAULT_POLICY } from './optimizer.js';
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
    const policy = p.policy ?? DEFAULT_POLICY;
    const r = resolverFor(p);
    let result;
    if (kind === 'run') {
      // The page still sends its "LNS seconds" setting as lnsBudgetMs. Seconds
      // must not decide when the search stops (a slow machine would get a
      // different plan), so only its "0 = no LNS" meaning is kept; the length of
      // the search is the iteration count (the default, or lnsIterations if sent).
      const lnsIterations = p.lnsIterations ?? (p.lnsBudgetMs === 0 ? 0 : undefined);
      result = planWindow(p.tasks, p.staffDB, p.selectedDate, r, p.windowDates, { weights: p.weights, lnsIterations, policy });
    } else if (kind === 'changes') {
      result = applyChanges(p.tasks, p.staffDB, p.selectedDate, r, p.windowDates, p.changes, { ...p.options, policy });
    } else if (kind === 'gap') {
      result = resolveStaffingWithCallIns({ ...p.args, distanceResolver: r, policy });
    } else {
      throw new Error('unknown job: ' + kind);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
