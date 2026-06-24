/**
 * spawn-readiness.test.ts — the deterministic gateway-readiness spawn-admission core
 * (WI-390 layer 1). Pure decision table; no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  decideSpawnAdmission,
  isGatewayReadyForSpawn,
  DEFAULT_SPAWN_DEFER_BACKOFF_MS,
  type GatewayReadinessSignals,
} from './spawn-readiness';

const sig = (over: Partial<GatewayReadinessSignals> = {}): GatewayReadinessSignals => ({
  serviceableAccounts: 3,
  admissionQueued: 0,
  admissionMaxQueued: 256,
  ...over,
});

describe('decideSpawnAdmission (WI-390 deterministic readiness gate)', () => {
  it('ADMITS when ≥1 account is serviceable and the admission queue is below the shed cap', () => {
    expect(decideSpawnAdmission(sig())).toEqual({ admit: true });
    expect(decideSpawnAdmission(sig({ serviceableAccounts: 1, admissionQueued: 255 }))).toEqual({ admit: true });
  });

  it('DEFERS with no_serviceable_account when zero accounts can serve (the dominant wedge cause)', () => {
    const d = decideSpawnAdmission(sig({ serviceableAccounts: 0 }));
    expect(d).toMatchObject({ admit: false, defer: true, reason: 'no_serviceable_account' });
    expect((d as { retryAfterMs: number }).retryAfterMs).toBe(DEFAULT_SPAWN_DEFER_BACKOFF_MS);
  });

  it('DEFERS with admission_shedding when the queue is AT or OVER the shed cap', () => {
    expect(decideSpawnAdmission(sig({ admissionQueued: 256 }))).toMatchObject({
      admit: false,
      defer: true,
      reason: 'admission_shedding',
    });
    expect(decideSpawnAdmission(sig({ admissionQueued: 9999 }))).toMatchObject({ reason: 'admission_shedding' });
  });

  it('no_serviceable_account takes priority over admission_shedding (an empty pool is the worse signal)', () => {
    expect(decideSpawnAdmission(sig({ serviceableAccounts: 0, admissionQueued: 9999 }))).toMatchObject({
      reason: 'no_serviceable_account',
    });
  });

  it('an unknown/zero shed cap disables the shedding check (don\'t gate on a cap we don\'t know)', () => {
    expect(decideSpawnAdmission(sig({ admissionMaxQueued: 0, admissionQueued: 5000 }))).toEqual({ admit: true });
  });

  it('a non-finite serviceable count is treated as not-serviceable (fail-closed on a bad read)', () => {
    expect(decideSpawnAdmission(sig({ serviceableAccounts: Number.NaN }))).toMatchObject({
      reason: 'no_serviceable_account',
    });
  });

  it('honors a custom backoff', () => {
    const d = decideSpawnAdmission(sig({ serviceableAccounts: 0 }), { backoffMs: 12_000 });
    expect((d as { retryAfterMs: number }).retryAfterMs).toBe(12_000);
  });

  it('isGatewayReadyForSpawn is the boolean projection', () => {
    expect(isGatewayReadyForSpawn(sig())).toBe(true);
    expect(isGatewayReadyForSpawn(sig({ serviceableAccounts: 0 }))).toBe(false);
    expect(isGatewayReadyForSpawn(sig({ admissionQueued: 256 }))).toBe(false);
  });
});
