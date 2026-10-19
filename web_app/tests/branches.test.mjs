// Branches the other files do not reach: the same-flight exemption with a
// network (same node = same physical stand), and applyChanges with farReshuffle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPolicy, DEFAULT_POLICY, conflictsWith, applyChanges, validatePlan } from '../src/optimizer.js';
import { createDistanceResolver } from '../src/utils/travelGraph.js';
import { DATE, D, mkTask, mkPerson, dbOf, empOf } from './helpers.mjs';

const WIN = [DATE];
test.beforeEach(() => setPolicy(DEFAULT_POLICY));
test.after(() => setPolicy(DEFAULT_POLICY));

test('sameFlightOverlap with a network: two stands on one node are one stand, two nodes are not', () => {
  const resolver = createDistanceResolver({
    locations: [['S01', 'n0'], ['S02', 'n0'], ['S03', 'n1']].map(([internal_id, node_ref]) => ({ internal_id, node_ref })),
    travelEdges: [{ 'Start node': 'n0', 'End node': 'n1', Distance: 300 }],
  });
  const pair = (posB, extra = {}) => [
    mkTask('a', D(9), D(10), ['Q1'], { pos: 'S01', flight: 'SU1', name: 'OUT_1' }),
    mkTask('b', D(9, 30), D(10, 30), ['Q1'], { pos: posB, flight: 'SU1', name: 'OUT_2', ...extra }),
  ];
  assert.equal(conflictsWith(...pair('S02'), resolver), true, 'off by default: overlap is a conflict');
  setPolicy({ sameFlightOverlap: true });
  assert.equal(conflictsWith(...pair('S02'), resolver), false, 'S01 and S02 are one node: the same stand');
  assert.equal(conflictsWith(...pair('S03'), resolver), true, 'S03 is another node');
  assert.equal(conflictsWith(...pair('S09'), resolver), true, 'a stand outside the network is the same only when written the same');
  assert.equal(conflictsWith(...pair('S01'), resolver), false);
  assert.equal(conflictsWith(...pair('S02', { name: 'OUT_1' }), resolver), true, 'the same name is two people\'s work');
  assert.equal(conflictsWith(...pair('S02', { flight: 'SU2' }), resolver), true, 'another flight');
  assert.equal(conflictsWith(...pair('S02', { flight: 'Рейс не указ.' }).map(x => ({ ...x, flight: 'Рейс не указ.' })), resolver), true, 'no flight is not one flight');
});

test('applyChanges farReshuffle re-optimizes beyond the stability window and keeps what lies inside it', () => {
  const staff = dbOf(mkPerson('P1', ['Q1'], 6, 22), mkPerson('P2', ['Q1'], 6, 22));
  const mk = (id, h, employee) => mkTask(id, D(h), D(h + 1), ['Q1'], { employee });
  const base = [mk('early', 9, 'P1'), mk('a', 14, 'P1'), mk('b', 16, 'P1'), mk('c', 18, 'P1'), mk('d', 20, 'P1')];
  const changes = [{ id: 'd', start: D(20, 10), end: D(21, 10) }];
  const now = D(8);
  const far = applyChanges(base, staff, DATE, null, WIN, changes, { now, farReshuffle: true });
  const near = applyChanges(base, staff, DATE, null, WIN, changes, { now });
  for (const r of [far, near]) {
    assert.deepEqual(validatePlan(r.tasks, staff, DATE, null, WIN), []);
    assert.equal(empOf(r.tasks, 'early'), 'P1', 'inside the stability window (until 11:00) nothing is moved');
    assert.equal(r.tasks.length, 5);
  }
  const load = r => ['P1', 'P2'].map(p => r.tasks.filter(t => t.employee === p).length);
  assert.deepEqual(load(far).sort(), [2, 3], 'the late tasks are balanced between the two');
  assert.deepEqual(far.touched, [], 'a full reshuffle does not name the people it touched');
  assert.ok(near.touched.length > 0);
  assert.equal(far.escalated, false);
});
