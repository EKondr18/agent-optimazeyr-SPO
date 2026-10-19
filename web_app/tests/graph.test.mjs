// The walking network (shortest path, symmetry, speed, reachable / unknown) and the
// data-quality counts that do not need an optimizer run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationNodeMap, buildTravelGraph, createDistanceResolver } from '../src/utils/travelGraph.js';
import { dataQualityReport, LONG_TASK_HOURS } from '../src/utils/dataQuality.js';
import { D, mkTask, mkPerson, dbOf, DATE } from './helpers.mjs';

const loc = (id, node) => ({ internal_id: id, node_ref: node });
// a - b 300, b - c 400, a - c 1000 (the way through b is shorter: 700); d is alone; e is not in tb_location
const resolver = () => createDistanceResolver({
  locations: [loc('A', 'na'), loc('A2', 'na'), loc('B', 'nb'), loc('C', 'nc'), loc('D', 'nd')],
  travelEdges: [
    { 'Start node': 'na', 'End node': 'nb', Distance: 300 },
    { 'Start node': 'nb', 'End node': 'nc', Distance: '400' },
    { 'Start node': 'na', 'End node': 'nc', Distance: 1000 },
  ],
});

test('graph: the distance is the shortest path, the same both ways, 0 on one node', () => {
  const r = resolver();
  assert.equal(r.metersBetween('A', 'C'), 700);
  assert.equal(r.metersBetween('C', 'A'), 700, 'edges are walked both ways even when only one direction is listed');
  assert.equal(r.metersBetween('B', 'A'), 300);
  assert.equal(r.metersBetween('A', 'A2'), 0);
  assert.equal(r.metersBetween('A', 'A'), 0);
});

test('graph: the walk time is metres at 5 km/h', () => {
  const r = resolver();
  assert.ok(Math.abs(r.secondsBetween('A', 'B') - 300 / (5000 / 3600)) < 1e-9, '300 m take 216 s');
  assert.ok(Math.abs(r.secondsBetween('A', 'C') - 504) < 1e-9);
  assert.equal(r.secondsBetween('A', 'A2'), 0);
});

test('graph: a stand missing from the table is unknown (null), two stands with no path are unreachable (false)', () => {
  const r = resolver();
  assert.equal(r.metersBetween('A', 'NOWHERE'), null);
  assert.equal(r.secondsBetween('NOWHERE', 'A'), null);
  assert.equal(r.reachable('A', 'NOWHERE'), null);
  assert.equal(r.metersBetween('A', 'D'), null, 'D is in the table but nothing leads there');
  assert.equal(r.reachable('A', 'D'), false);
  assert.equal(r.reachable('D', 'A'), false);
  assert.equal(r.reachable('A', 'C'), true);
  assert.equal(r.reachable('A', 'A2'), true);
  assert.equal(r.reachable('D', 'D'), true);
});

test('graph: edge rows may be capitalized or snake_case; unusable rows are skipped; ids are compared as strings', () => {
  const g = buildTravelGraph([
    { 'Start node': 'x', 'End node': 'y', Distance: 10 },
    { start_node: 'y', end_node: 'z', distance: '20' },
    { 'Start node': '', 'End node': 'q', Distance: 5 },
    { 'Start node': 'q', 'End node': 'r', Distance: 'far' },
    null,
  ].filter(Boolean));
  assert.deepEqual([...g.keys()].sort(), ['x', 'y', 'z']);
  assert.deepEqual(g.get('y').map(e => [e.to, e.dist]).sort(), [['x', 10], ['z', 20]]);
  const map = buildLocationNodeMap([{ internal_id: 7, node_ref: 9 }, { internal_id: '', node_ref: 'n' }, { internal_id: 'k' }, undefined].filter(Boolean));
  assert.deepEqual([...map], [['7', '9']]);
  const r = createDistanceResolver({ locations: [{ internal_id: 7, node_ref: 1 }, { internal_id: 8, node_ref: 2 }], travelEdges: [{ 'Start node': 1, 'End node': 2, Distance: 50 }] });
  assert.equal(r.metersBetween(7, '8'), 50);
  assert.equal(createDistanceResolver({}).metersBetween('a', 'b'), null);
});

// ── data quality counts ─────────────────────────────────────────────────────
test('data quality: backwards and zero-length tasks, tasks over 12 hours, tasks without a requirement, people without any qualification', () => {
  assert.equal(LONG_TASK_HOURS, 12);
  const tasks = [
    mkTask('ok', D(9), D(10), ['Q1']),
    mkTask('back', D(11), D(10), ['Q1']),
    mkTask('zero', D(12), D(12), ['Q1']),
    mkTask('long', D(0), D(13, 30), ['Q1']),
    mkTask('exactly12', D(0), D(12), ['Q1']),
    mkTask('none', D(14), D(15), []),
  ];
  const staffDB = dbOf(mkPerson('A', ['Q1'], 6, 20), mkPerson('B', [], 6, 20));
  const rep = dataQualityReport({ tasks, staffDB });
  assert.deepEqual(rep.badIntervals.map(t => t.id), ['back', 'zero']);
  assert.deepEqual(rep.longTasks.map(t => [t.id, t.hours]), [['long', 13.5]], 'exactly 12 hours is not long');
  assert.equal(rep.tasksWithoutQuals, 1);
  assert.deepEqual(rep.staffWithoutQuals, ['B']);
  assert.deepEqual(rep.datesWithoutShifts, []);
  assert.equal(rep.issueCount, rep.badIntervals.length + rep.longTasks.length + rep.qualsNobodyHolds.length + rep.datesWithoutShifts.length + rep.staffWithoutQuals.length);
  const clean = dataQualityReport({ tasks: [tasks[0]], staffDB: dbOf(mkPerson('A', ['Q1'], 6, 20)) });
  assert.equal(clean.badIntervals.length, 0);
  assert.equal(clean.issueCount, 0);
});

test('data quality: a day with tasks and no shifts is listed', () => {
  const rep = dataQualityReport({ tasks: [mkTask('a', D(9), D(10), ['Q1'])], staffDB: { [DATE]: [] } });
  assert.deepEqual(rep.datesWithoutShifts, [DATE]);
  assert.ok(rep.issueCount >= 1);
});
