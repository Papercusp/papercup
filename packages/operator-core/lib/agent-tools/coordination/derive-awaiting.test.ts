/**
 * derive-awaiting.test.ts — coord-derived-fields-2026-08-31 P-004.
 *
 * The module is mostly two bounded SQL reads; what a unit test can and must pin
 * is the fail-soft contract (a decorative stamp must never fail a send) and the
 * guards that keep it from ever fabricating.
 */
import { describe, it, expect } from 'vitest';
import { deriveAwaiting, AWAITING_DERIVED_PROVENANCE, AWAITING_MAX_ENTRIES } from './derive-awaiting';

describe('deriveAwaiting (fail-soft)', () => {
  it('returns [] for a missing ownerId or workspaceId — never guesses a scope', async () => {
    expect(await deriveAwaiting({ ownerId: '', workspaceId: 'ws' })).toEqual([]);
    expect(await deriveAwaiting({ ownerId: 'su-x', workspaceId: '' })).toEqual([]);
  });

  it('returns [] (never throws) when the database is unreachable', async () => {
    // In the unit environment getOrgPg either throws or cannot connect; either
    // path must degrade to "no field", not a failed send.
    await expect(
      deriveAwaiting({ ownerId: 'su-nonexistent', workspaceId: 'unit-test-no-db' }),
    ).resolves.toEqual([]);
  });
});

describe('constants', () => {
  it('provenance token is stable — adoption queries filter on it', () => {
    expect(AWAITING_DERIVED_PROVENANCE).toBe('session-derived');
  });
  it('cap stays a pointer set, not a transcript', () => {
    expect(AWAITING_MAX_ENTRIES).toBeLessThanOrEqual(8);
  });
});
