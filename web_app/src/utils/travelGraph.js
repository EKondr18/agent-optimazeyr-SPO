// Real physical-distance resolver, built from two datasets:
//
//   tb_location — maps a POS/internal_id code (the same codes used as
//   start_loc_ref/dest_loc_ref on tb_sub_orders) to a node_ref.
//
//   VKO_TRANSPORT_cntrC_cntrV — a travel network edge list (Start node,
//   End node, Distance). Confirmed against the real export: 1574 edges,
//   647 distinct nodes, fully symmetric (every A→B pair has a matching
//   B→A edge). This is NOT a complete distance matrix — it's a sparse
//   adjacency graph of directly-connected nodes, so the distance between
//   two arbitrary POS codes is the shortest path through the graph, not a
//   direct lookup.
//
// "Distance" units aren't labeled in the source data. Values range 0–5000
// in steps of 5, consistent with meters for an airport apron — treated as
// meters below.

const WALK_SPEED_KMH = 5; // confirmed: resource movement speed is 5 km/h
// (matches tb_order_rules.csv's travel_time_velocity: 5.0 seen on most rules).
const WALK_SPEED_MPS = (WALK_SPEED_KMH * 1000) / 3600;

export function buildLocationNodeMap(locations) {
  const map = new Map();
  for (const loc of locations || []) {
    const internalId = loc.internal_id;
    const nodeRef = loc.node_ref;
    if (internalId && nodeRef) map.set(String(internalId), String(nodeRef));
  }
  return map;
}

// Accepts rows shaped either like the xlsx export (`Start node`/`End node`/
// `Distance`, capitalized with spaces) or a snake_case CSV/JSON export of
// the same columns — whichever the uploaded file actually used.
export function buildTravelGraph(edges) {
  const graph = new Map();
  function addEdge(a, b, dist) {
    if (!graph.has(a)) graph.set(a, []);
    graph.get(a).push({ to: b, dist });
  }
  for (const e of edges || []) {
    const from = e['Start node'] ?? e.start_node;
    const to = e['End node'] ?? e.end_node;
    const distRaw = e['Distance'] ?? e.distance;
    const dist = Number(distRaw);
    if (!from || !to || Number.isNaN(dist)) continue;
    const a = String(from), b = String(to);
    addEdge(a, b, dist);
    addEdge(b, a, dist); // source is already symmetric; harmless if the reverse edge is also present as its own row
  }
  return graph;
}

// Single-source Dijkstra over the (small: ~650 node) graph. O(V^2), which
// is trivial at this scale — a few hundred microseconds per call.
function dijkstraFrom(graph, source) {
  const dist = new Map([[source, 0]]);
  const visited = new Set();
  for (;;) {
    let u = null, best = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < best) { best = d; u = node; }
    }
    if (u === null) break;
    visited.add(u);
    for (const { to, dist: w } of graph.get(u) || []) {
      const alt = best + w;
      if (alt < (dist.get(to) ?? Infinity)) dist.set(to, alt);
    }
  }
  return dist;
}

// Builds a resolver exposing metersBetween(pos1, pos2) -> number | null
// (null = position(s) not resolvable in the graph — callers should fall
// back to the old string heuristic in that case) and secondsBetween, the
// same distance converted to a walk-time budget via WALK_SPEED_MPS.
// Per-source Dijkstra runs are memoized, since one optimizer run queries
// the same handful of stands repeatedly.
export function createDistanceResolver({ locations, travelEdges }) {
  const nodeMap = buildLocationNodeMap(locations);
  const graph = buildTravelGraph(travelEdges);
  const cache = new Map();

  function metersBetween(pos1, pos2) {
    const n1 = nodeMap.get(String(pos1));
    const n2 = nodeMap.get(String(pos2));
    if (!n1 || !n2) return null;
    if (n1 === n2) return 0;
    if (!cache.has(n1)) cache.set(n1, dijkstraFrom(graph, n1));
    const d = cache.get(n1).get(n2);
    return d === undefined ? null : d;
  }

  function secondsBetween(pos1, pos2) {
    const meters = metersBetween(pos1, pos2);
    return meters == null ? null : meters / WALK_SPEED_MPS;
  }

  return { metersBetween, secondsBetween, nodeMap, graph };
}
