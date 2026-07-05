/**
 * capability-envelope-overrides — live-configurability-audit-2026-06-20 P-009.
 *
 * Covers the two pieces of genuinely new logic:
 *  (1) the D-010 flag-gated SYNC cache — OFF ⇒ the getters return empty even after a write
 *      (byte-identical envelope resolution), ON ⇒ writes surface on the sync hot path;
 *  (2) the tighten-only `protectedAdditions` evaluator extension — additions deny, the baked
 *      floor is never removable, and absent additions are byte-identical to the baseline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state (vi.hoisted so the vi.mock factories may reference it).
const h = vi.hoisted(() => ({ flagOn: false, store: new Map<string, unknown>() }));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => h.flagOn,
  onFlagChange: () => {},
}));
vi.mock('./flag-distinct-id', () => ({ systemDistinctId: () => 'system' }));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async (key: string) => h.store.get(key),
  writeOperatorState: async (key: string, value: unknown) => {
    h.store.set(key, value);
  },
}));

import {
  envelopeRoleOverrides,
  envelopeProtectedAdditions,
  refreshCapabilityEnvelopeOverrides,
  setRoleEnvelope,
  addProtectedGlobs,
  readEnvelopeOverrides,
  resetEnvelopeOverrides,
} from './capability-envelope-overrides';
import { evaluateCapabilityEnvelope } from './capability-envelope/policy';

const beeCtx = { role: 'cup', isSuperuser: false, isPowerUser: false } as const;

beforeEach(async () => {
  h.store.clear();
  h.flagOn = false;
  await refreshCapabilityEnvelopeOverrides();
});

describe('capability-envelope-overrides — D-010 flag-gated sync cache', () => {
  it('flag OFF ⇒ getters stay empty even after a write (byte-identical), but the store still persists', async () => {
    h.flagOn = false;
    await setRoleEnvelope('cup', { denyCapabilities: ['capability:bash'] });
    expect(envelopeRoleOverrides()).toEqual({});
    expect(envelopeProtectedAdditions()).toEqual([]);
    // the durable store DID record it — only the hot-path cache is gated off.
    expect((await readEnvelopeOverrides()).roleEnvelopes).toEqual({
      cup: { denyCapabilities: ['capability:bash'] },
    });
  });

  it('flag ON ⇒ a role override surfaces synchronously after the write (same-process immediacy)', async () => {
    h.flagOn = true;
    await refreshCapabilityEnvelopeOverrides();
    await setRoleEnvelope('cup', { denyCapabilities: ['capability:bash'] });
    expect(envelopeRoleOverrides()).toEqual({ cup: { denyCapabilities: ['capability:bash'] } });
  });

  it('clear (env=null) removes only that role', async () => {
    h.flagOn = true;
    await setRoleEnvelope('cup', { denyCapabilities: ['x'] });
    await setRoleEnvelope('kettle', { denyCapabilities: ['y'] });
    await setRoleEnvelope('cup', null);
    expect(envelopeRoleOverrides()).toEqual({ kettle: { denyCapabilities: ['y'] } });
  });

  it('addProtectedGlobs is tighten-only and deduped (union, never removes)', async () => {
    h.flagOn = true;
    await addProtectedGlobs(['capability:fs-write']);
    await addProtectedGlobs(['capability:fs-write', 'danger:*']);
    expect([...envelopeProtectedAdditions()].sort()).toEqual(['capability:fs-write', 'danger:*']);
  });

  it('resetEnvelopeOverrides clears everything', async () => {
    h.flagOn = true;
    await setRoleEnvelope('cup', { denyCapabilities: ['x'] });
    await addProtectedGlobs(['danger:*']);
    await resetEnvelopeOverrides();
    expect(envelopeRoleOverrides()).toEqual({});
    expect(envelopeProtectedAdditions()).toEqual([]);
    expect(await readEnvelopeOverrides()).toEqual({});
  });
});

describe('evaluateCapabilityEnvelope — tighten-only protectedAdditions (P-009)', () => {
  it('a capability matching a runtime addition is denied for a fleet role', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'some:tool',
      capabilities: ['danger:run'],
      ctx: beeCtx,
      protectedAdditions: ['danger:*'],
    });
    expect(d.applied).toBe(true);
    expect(d.withinEnvelope).toBe(false);
  });

  it('absent additions ⇒ byte-identical baseline (the same cap is allowed)', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'some:tool',
      capabilities: ['danger:run'],
      ctx: beeCtx,
    });
    expect(d.withinEnvelope).toBe(true);
  });

  it('the baked never-auto floor still applies regardless of additions', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'some:tool',
      capabilities: ['secrets:read:foo'],
      ctx: beeCtx,
      protectedAdditions: ['danger:*'],
    });
    expect(d.withinEnvelope).toBe(false);
  });

  it('SU / power-user callers are exempt even with additions present (D-002)', () => {
    const d = evaluateCapabilityEnvelope({
      toolName: 'some:tool',
      capabilities: ['danger:run'],
      ctx: { role: 'operator', isSuperuser: true, isPowerUser: false },
      protectedAdditions: ['danger:*'],
    });
    expect(d.applied).toBe(false);
    expect(d.withinEnvelope).toBe(true);
  });
});
