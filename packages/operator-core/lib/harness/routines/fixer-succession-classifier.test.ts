/**
 * Focused acceptance guard for the fixer-succession qualification boundary.
 *
 * The broader release-actions suite also exercises this pure classifier, but it
 * carries unrelated legacy pipeline-event fixtures.  Keeping the false-alarm
 * controls here gives the acceptance rubric one narrow, independently runnable
 * detector for the expensive direction: a live, unknown, or still-reserved
 * fixer must never page as dead/absent.
 */
import { describe, expect, it } from 'vitest';

import {
  FIXER_SUCCESSION_STALL_MS,
  classifyFrozenRepairFixerSuccession,
} from './release-actions';
import {
  FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
  type FrozenCandidateRepairQueue,
} from '../../release/frozen-candidate-repair-queue';

const NOW = 1_800_000_000_000;

function queue(over: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  return {
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: 'awaiting-fixer',
    candidate: 'a'.repeat(40),
    base: 'b'.repeat(40),
    repairHead: 'c'.repeat(40),
    attempts: 1,
    openedAtMs: NOW - 2 * FIXER_SUCCESSION_STALL_MS,
    updatedAtMs: NOW - FIXER_SUCCESSION_STALL_MS,
    fixerSpawnId: 'fixer-dead',
    failingTests: ['lib/broken.test.ts'],
    ...over,
  };
}

describe('classifyFrozenRepairFixerSuccession acceptance boundary', () => {
  it('qualifies a confirmed-dead fixer with attempt-scoped age and identity', () => {
    const result = classifyFrozenRepairFixerSuccession(queue(), false, NOW);

    expect(result).toMatchObject({
      state: 'dead',
      ageMs: FIXER_SUCCESSION_STALL_MS,
      spawnId: 'fixer-dead',
      attempts: 1,
    });
    expect(result?.key).toContain('fixer-dead');
    expect(result?.key).toContain(String(NOW - FIXER_SUCCESSION_STALL_MS));
  });

  it('qualifies an absent fixer only after its launch reservation expires', () => {
    const absent = queue({ fixerSpawnId: null, attempts: 0 });
    expect(classifyFrozenRepairFixerSuccession(absent, undefined, NOW)).toMatchObject({
      state: 'absent',
      spawnId: null,
      attempts: 0,
    });

    const reserved = queue({
      fixerSpawnId: null,
      attempts: 0,
      dispatchReservation: {
        token: 'launch-owner',
        claimedAtMs: NOW - 1_000,
        expiresAtMs: NOW + 60_000,
      },
    });
    expect(classifyFrozenRepairFixerSuccession(reserved, undefined, NOW)).toBeNull();

    const expired = queue({
      fixerSpawnId: null,
      attempts: 0,
      dispatchReservation: {
        token: 'expired-owner',
        claimedAtMs: NOW - 120_000,
        expiresAtMs: NOW - 1,
      },
    });
    expect(classifyFrozenRepairFixerSuccession(expired, undefined, NOW)).toMatchObject({
      state: 'absent',
    });
  });

  it('fails closed against false alarms for live, unknown, and non-awaiting fixers', () => {
    expect(classifyFrozenRepairFixerSuccession(queue(), true, NOW)).toBeNull();
    expect(classifyFrozenRepairFixerSuccession(queue(), null, NOW)).toBeNull();
    expect(
      classifyFrozenRepairFixerSuccession(queue({ phase: 'ready-to-verify' }), false, NOW),
    ).toBeNull();
  });

  it('changes identity for a successor attempt so its first rung is not suppressed', () => {
    const first = classifyFrozenRepairFixerSuccession(queue(), false, NOW);
    const successor = classifyFrozenRepairFixerSuccession(
      queue({
        attempts: 2,
        updatedAtMs: NOW - FIXER_SUCCESSION_STALL_MS,
        fixerSpawnId: 'fixer-2',
      }),
      false,
      NOW,
    );

    expect(first?.key).not.toBe(successor?.key);
    expect(successor?.key).toContain('fixer-2');
  });
});
