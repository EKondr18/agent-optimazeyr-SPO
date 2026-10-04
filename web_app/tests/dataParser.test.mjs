// Loader rules checked against what the real exports actually contain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonExport } from '../src/utils/dataParser.js';

const shift = (id, resource, dept, state = 'SCHEDULED') => ({
  _id: id, resource_ref: resource, department_ref: dept, shift_state_ref: state,
  scheduled_start: '2026-09-20T05:00:00.000Z', scheduled_end: '2026-09-20T17:00:00.000Z', location_ref: '*',
});
const resources = [
  { internal_id: 'spo1', name: 'SPO One', default_department_ref: 'SPO' },
  { internal_id: 'spo2', name: 'SPO Two', default_department_ref: 'SPO' },
  { internal_id: 'aud1', name: 'Audit One', default_department_ref: 'АУДИТ' },
  { internal_id: 'spo3', name: 'SPO Three', default_department_ref: 'SPO' },
];

test('shift pool: cancelled shifts are dropped, the shift\'s own department decides', () => {
  const { staffDB } = parseJsonExport({
    orders: [], resources, resQual: [], resourceQualifications: [], shiftQualifications: [],
    shifts: [
      shift(1, 'spo1', 'SPO'),
      shift(2, 'spo2', 'SPO', 'CANCELED'),
      shift(3, 'aud1', 'SPO'),     // lent to SPO for the day
      shift(4, 'spo3', 'АУДИТ'),   // SPO employee working an audit shift
      shift(5, 'spo3', '*'),       // shift doesn't say: home department decides
    ],
  });
  const names = [...new Set(Object.values(staffDB).flat().map(s => s.name))].sort();
  assert.deepEqual(names, ['Audit One', 'SPO One', 'SPO Three']);
});
