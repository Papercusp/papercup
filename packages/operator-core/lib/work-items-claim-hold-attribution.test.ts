/**
 * work-items-claim-hold-attribution.test.ts — pure unit coverage for
 * `ensureClaimHoldAttribution` (EI-18698328828208444).
 *
 * `payload._claimHold: true` can enter a work-item's payload via the caller-supplied
 * `payload` on `work_items:create` (`_create-core.ts`), completely bypassing
 * `setWorkItemClaimHold`'s attribution stamps. That leaves an ANONYMOUS hold:
 * unreviewable (no `claim_hold_by`/`held_open_by` — nobody can tell who parked it or
 * why) and unexpirable (every hold-age/audit sweep keys on `claim_hold_at`, which stays
 * null). Confirmed live as 30 papercusp items, oldest untouched ~9 days.
 *
 * `ensureClaimHoldAttribution` is the guard that closes this at the write boundary: a
 * pure function, so this stays a PG-free unit test (db-org mocked defensively, matching
 * work-items-normalize.test.ts's pattern).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: Object.assign(async () => [], { unsafe: vi.fn() }) }),
}));

const { ensureClaimHoldAttribution } = await import('./work-items');

describe('ensureClaimHoldAttribution', () => {
  it('stamps claim_hold_by/reason/at when _claimHold is set with no attribution', () => {
    const result = ensureClaimHoldAttribution({ _claimHold: true, title: 'x' }, 'su-abc123', 'auto-attributed');
    expect(result).toMatchObject({
      _claimHold: true,
      title: 'x',
      claim_hold_by: 'su-abc123',
      claim_hold_reason: 'auto-attributed',
    });
    expect(typeof result?.claim_hold_at).toBe('string');
    expect(() => new Date(result?.claim_hold_at as string).toISOString()).not.toThrow();
  });

  it('is a no-op when _claimHold is not set', () => {
    const payload = { title: 'x' };
    expect(ensureClaimHoldAttribution(payload, 'su-abc123', 'reason')).toBe(payload);
  });

  it('is a no-op when _claimHold is already attributed via claim_hold_by (durable park)', () => {
    const payload = { _claimHold: true, claim_hold_by: 'su-other', claim_hold_reason: 'deliberate' };
    expect(ensureClaimHoldAttribution(payload, 'su-abc123', 'reason')).toBe(payload);
  });

  it('is a no-op when _claimHold is already attributed via held_open_by (lease)', () => {
    const payload = { _claimHold: true, held_open_by: 'su-other', held_open_reason: 'blocked' };
    expect(ensureClaimHoldAttribution(payload, 'su-abc123', 'reason')).toBe(payload);
  });

  it('is a no-op when payload is undefined', () => {
    expect(ensureClaimHoldAttribution(undefined, 'su-abc123', 'reason')).toBeUndefined();
  });

  it('never mutates the input payload object (returns a new object when stamping)', () => {
    const payload = { _claimHold: true };
    const result = ensureClaimHoldAttribution(payload, 'su-abc123', 'reason');
    expect(result).not.toBe(payload);
    expect(payload).toEqual({ _claimHold: true });
  });

  it('treats a legacy string "true" the same as boolean true (matches isClaimHoldParked semantics)', () => {
    const result = ensureClaimHoldAttribution({ _claimHold: 'true' }, 'su-abc123', 'reason');
    expect(result?.claim_hold_by).toBe('su-abc123');
  });
});
