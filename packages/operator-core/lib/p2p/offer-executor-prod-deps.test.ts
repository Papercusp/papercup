/**
 * WI-1937 unit tests for offer-executor-prod-deps.ts's `applyCapabilityEnvelope`
 * guard. Pins the resolved deny-all mechanism (`denyCapabilities: ['*']`, NOT an
 * empty `allowCapabilities`) and the fail-closed-until-step-7 sequencing: this
 * MUST throw today (ROLE_ENVELOPES carries no 'foreign-session' entry yet), and
 * a future entry only satisfies it if it is a genuine deny-all shape.
 */
import { describe, expect, it } from 'vitest';
import { applyCapabilityEnvelopeForForeignSession, foreignSessionExecutorDeps } from './offer-executor-prod-deps';
import { ROLE_ENVELOPES } from '../capability-envelope/policy';

const spec = {
  sessionRole: 'foreign-session' as const,
  offerId: 'offer-1',
  workspaceId: 'ws-1',
  fleetSlug: 'fleet-a',
};

describe('applyCapabilityEnvelopeForForeignSession (WI-1937 C2 fail-closed guard)', () => {
  it('throws TODAY — ROLE_ENVELOPES has no foreign-session entry yet (step 7 not landed)', async () => {
    // Documents current reality; also protects against silently reading a
    // pre-populated envelope some OTHER test file mutated onto the shared map.
    expect(ROLE_ENVELOPES['foreign-session']).toBeUndefined();
    await expect(applyCapabilityEnvelopeForForeignSession(spec)).rejects.toThrow(/does not resolve to a deny-all/);
  });

  it("an empty allowCapabilities:[] entry does NOT satisfy the guard (the exact gotcha this WI resolved)", async () => {
    const saved = ROLE_ENVELOPES['foreign-session'];
    (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = { allowCapabilities: [] };
    try {
      await expect(applyCapabilityEnvelopeForForeignSession(spec)).rejects.toThrow(/does not resolve to a deny-all/);
    } finally {
      if (saved === undefined) delete (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'];
      else (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = saved;
    }
  });

  it("denyCapabilities:['*'] DOES satisfy the guard — the correct future step-7 shape", async () => {
    const saved = ROLE_ENVELOPES['foreign-session'];
    (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = { denyCapabilities: ['*'] };
    try {
      await expect(applyCapabilityEnvelopeForForeignSession(spec)).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'];
      else (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = saved;
    }
  });

  it("a narrow denyCapabilities (not '*') does NOT satisfy the guard — must be genuinely all-denying", async () => {
    const saved = ROLE_ENVELOPES['foreign-session'];
    (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = { denyCapabilities: ['capability:bash'] };
    try {
      await expect(applyCapabilityEnvelopeForForeignSession(spec)).rejects.toThrow(/does not resolve to a deny-all/);
    } finally {
      if (saved === undefined) delete (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'];
      else (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = saved;
    }
  });

  it('foreignSessionExecutorDeps() composes ONLY applyCapabilityEnvelope — launchSession is deliberately absent', () => {
    const deps = foreignSessionExecutorDeps();
    expect(deps.applyCapabilityEnvelope).toBe(applyCapabilityEnvelopeForForeignSession);
    expect('launchSession' in deps).toBe(false);
  });
});
