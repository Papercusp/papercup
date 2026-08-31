/**
 * derived-why-goal.test.ts — coord-derived-fields-2026-08-31 D-002 / P-001.
 *
 * Mirrors derived-plan-slug.test.ts: the policy tests are cheap; the groups
 * that matter pin the properties a future edit could silently break — the
 * ordering dependency on the `auto` stamp, explicit-wins, and fail-soft.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldDeriveWhyGoal,
  deriveWhyGoal,
  WHY_GOAL_DERIVED_PROVENANCE,
} from './derived-why-goal';

describe('shouldDeriveWhyGoal', () => {
  const agent = 'su-de6e9643-2fa0-4a4f-86f3-2f9e9c7f2e0d';

  it('derives for an agent session that supplied no why', () => {
    expect(shouldDeriveWhyGoal({ explicitWhy: undefined, auto: undefined, from: agent })).toBe(true);
  });

  it('NEVER overrides an explicit caller value', () => {
    expect(
      shouldDeriveWhyGoal({ explicitWhy: { goalRef: 'WI-1234' }, auto: undefined, from: agent }),
    ).toBe(false);
  });

  it('treats an explicitly null/empty why as a deliberate value, not an omission', () => {
    // A caller that passes null has said something; only `undefined` is silence.
    expect(shouldDeriveWhyGoal({ explicitWhy: null, auto: undefined, from: agent })).toBe(false);
  });

  it('accepts every agent-session shape', () => {
    for (const from of ['su-abc', 's-abc', 'cup-abc', 'role-leader', '0f1e2d3c-4b5a-xxxx']) {
      expect(shouldDeriveWhyGoal({ explicitWhy: undefined, auto: undefined, from })).toBe(true);
    }
  });

  it('never derives for a named machine emitter', () => {
    for (const from of [
      'git-sync-integrator',
      'service-health',
      'system:delivery-ladder',
      'claim-discipline-watch',
      'green-checkpoint',
    ]) {
      expect(shouldDeriveWhyGoal({ explicitWhy: undefined, auto: undefined, from })).toBe(false);
    }
  });

  it('never derives for the human owner or the admin UI', () => {
    for (const from of ['human', 'pc-admin-coord-ui']) {
      expect(shouldDeriveWhyGoal({ explicitWhy: undefined, auto: undefined, from })).toBe(false);
    }
  });

  // ⚠ THE ORDER-DEPENDENCE PIN (D-095). System code emitting under a borrowed
  // agent identity is only excluded via the `auto` stamp that runs FIRST at the
  // seam — this is the property that silently breaks if someone hoists the why
  // stamp above the auto stamps in messages.ts.
  it('excludes auto:true even when the sender is a real agent session', () => {
    expect(shouldDeriveWhyGoal({ explicitWhy: undefined, auto: true, from: agent })).toBe(false);
  });

  it('does not derive for a missing sender', () => {
    expect(shouldDeriveWhyGoal({ explicitWhy: undefined, auto: undefined, from: null })).toBe(false);
    expect(shouldDeriveWhyGoal({ explicitWhy: undefined, auto: undefined, from: undefined })).toBe(
      false,
    );
  });
});

describe('deriveWhyGoal (fail-soft)', () => {
  const ownerId = 'su-de6e9643-2fa0-4a4f-86f3-2f9e9c7f2e0d';

  it('returns the stamped goal ref', async () => {
    expect(await deriveWhyGoal({ ownerId, readGoalRef: () => 'WI-1234' })).toBe('WI-1234');
  });

  it('accepts a sync or async reader', async () => {
    expect(await deriveWhyGoal({ ownerId, readGoalRef: async () => 'fleet:drain-crew' })).toBe(
      'fleet:drain-crew',
    );
  });

  it('trims, and treats blank as absent', async () => {
    expect(await deriveWhyGoal({ ownerId, readGoalRef: () => '  WI-9  ' })).toBe('WI-9');
    expect(await deriveWhyGoal({ ownerId, readGoalRef: () => '   ' })).toBeNull();
  });

  it('yields null on a cold cache (null/undefined stamp)', async () => {
    expect(await deriveWhyGoal({ ownerId, readGoalRef: () => null })).toBeNull();
    expect(await deriveWhyGoal({ ownerId, readGoalRef: () => undefined })).toBeNull();
  });

  it('yields null on a non-string (never a wrong field)', async () => {
    expect(
      await deriveWhyGoal({ ownerId, readGoalRef: () => 42 as unknown as string }),
    ).toBeNull();
  });

  it('NEVER throws — a decorative stamp must not be able to fail the send', async () => {
    expect(
      await deriveWhyGoal({
        ownerId,
        readGoalRef: () => {
          throw new Error('stamp cache exploded');
        },
      }),
    ).toBeNull();
    expect(
      await deriveWhyGoal({
        ownerId,
        readGoalRef: async () => {
          throw new Error('async rehydration exploded');
        },
      }),
    ).toBeNull();
  });
});

describe('provenance constant', () => {
  it('is stable — adoption queries filter on this exact string', () => {
    expect(WHY_GOAL_DERIVED_PROVENANCE).toBe('goal-stamp-derived');
  });
});
