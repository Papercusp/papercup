/** Tests for the PURE dead-credential decision helper (#5 PART A). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyCredential401Streak, DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD } from './credential-health';

test('classifyCredential401Streak — fires EXACTLY at the crossing tick (streak === threshold)', () => {
  assert.equal(classifyCredential401Streak(3, 3), true);
});

test('classifyCredential401Streak — stays quiet BELOW the threshold (stale-cached tolerance)', () => {
  assert.equal(classifyCredential401Streak(1, 3), false);
  assert.equal(classifyCredential401Streak(2, 3), false);
});

test('classifyCredential401Streak — stays quiet ABOVE the threshold (alert once per episode, no re-alert)', () => {
  assert.equal(classifyCredential401Streak(4, 3), false);
  assert.equal(classifyCredential401Streak(100, 3), false);
});

test('classifyCredential401Streak — exercising the full streak alerts on exactly ONE tick', () => {
  const threshold = DEFAULT_CREDENTIAL_401_DEAD_THRESHOLD;
  let alerts = 0;
  for (let streak = 1; streak <= threshold + 5; streak++) {
    if (classifyCredential401Streak(streak, threshold)) alerts++;
  }
  assert.equal(alerts, 1, 'a dead-credential episode alerts exactly once across a climbing streak');
});

test('classifyCredential401Streak — a reset (streak back to 0..threshold) RE-ARMS the next crossing', () => {
  const threshold = 3;
  // First episode: climbs to the crossing → alert once.
  assert.equal(classifyCredential401Streak(3, threshold), true);
  // A successful auth resets the streak to 0 in the gateway; the next episode climbs again.
  assert.equal(classifyCredential401Streak(1, threshold), false);
  assert.equal(classifyCredential401Streak(2, threshold), false);
  assert.equal(classifyCredential401Streak(3, threshold), true, 'the next dead episode re-alerts at its own crossing');
});

test('classifyCredential401Streak — a non-positive threshold disables alerting', () => {
  assert.equal(classifyCredential401Streak(5, 0), false);
  assert.equal(classifyCredential401Streak(5, -1), false);
});

test('classifyCredential401Streak — non-finite inputs never alert (defensive)', () => {
  assert.equal(classifyCredential401Streak(NaN, 3), false);
  assert.equal(classifyCredential401Streak(3, NaN), false);
  assert.equal(classifyCredential401Streak(Infinity, 3), false);
});
