/**
 * D-007 — the event-key → program-blueprint trigger resolution (the seam the
 * event-reaction system fires through).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveCoordOpTrigger, coordOpTriggerMap, resetCoordOpTriggerMap } from './trigger.js';

test('resolves the built-in program-blueprint trigger keys', () => {
  resetCoordOpTriggerMap();
  assert.equal(resolveCoordOpTrigger('coordination-op:vote'), 'vote');
  assert.equal(resolveCoordOpTrigger('coordination-op:deliberate'), 'deliberate');
});

test('unknown event key → null', () => {
  assert.equal(resolveCoordOpTrigger('coordination-op:nope'), null);
});

test('the trigger map covers exactly the declared keys', () => {
  resetCoordOpTriggerMap();
  const map = coordOpTriggerMap();
  assert.deepEqual(map, {
    'coordination-op:vote': 'vote',
    'coordination-op:deliberate': 'deliberate',
  });
});
