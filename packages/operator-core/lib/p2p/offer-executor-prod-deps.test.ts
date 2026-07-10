/**
 * WI-1937 unit tests for offer-executor-prod-deps.ts's `applyCapabilityEnvelope`
 * guard. Pins the resolved deny-all mechanism (`denyCapabilities: ['*']`, NOT an
 * empty `allowCapabilities`) and the fail-closed-until-step-7 sequencing: this
 * MUST throw today (ROLE_ENVELOPES carries no 'foreign-session' entry yet), and
 * a future entry only satisfies it if it is a genuine deny-all shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { ROLE_ENVELOPES } from '../capability-envelope/policy';
import { ephemeralForeignHarnessSlug } from '../harness-registry';
import type { ForeignLaunchSpec } from './offer-executor';

const spawnAgentInHarnessMock = vi.fn();
vi.mock('../fleet/operator-spawn', () => ({
  spawnAgentInHarness: (...args: unknown[]) => spawnAgentInHarnessMock(...args),
}));

const {
  applyCapabilityEnvelopeForForeignSession,
  foreignSessionExecutorDeps,
  launchForeignSession,
} = await import('./offer-executor-prod-deps');

const spec = {
  sessionRole: 'foreign-session' as const,
  offerId: 'offer-1',
  workspaceId: 'ws-1',
  fleetSlug: 'fleet-a',
};

describe('applyCapabilityEnvelopeForForeignSession (WI-1937 C2 fail-closed guard)', () => {
  it('RESOLVES today — ROLE_ENVELOPES.foreign-session is the landed deny-all v1 policy (step 7 landed)', async () => {
    // Pins the actual shipping shape (policy.ts) — denyCapabilities:['*'], never
    // an empty allowCapabilities (see the dedicated gotcha test below).
    expect(ROLE_ENVELOPES['foreign-session']).toEqual({ denyCapabilities: ['*'] });
    await expect(applyCapabilityEnvelopeForForeignSession(spec)).resolves.toBeUndefined();
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

  it('foreignSessionExecutorDeps() composes BOTH applyCapabilityEnvelope and launchSession (WI-1937 D-001 landed)', () => {
    const deps = foreignSessionExecutorDeps();
    expect(deps.applyCapabilityEnvelope).toBe(applyCapabilityEnvelopeForForeignSession);
    expect(deps.launchSession).toBe(launchForeignSession);
  });
});

/**
 * WI-1937 leader-required test (a): spawn resolves to the ephemeral clone
 * slug via the SAME registry-resolution chokepoint every spawn uses — never
 * the caller's local default harness. Pins the exact contract
 * `provisionForeignClone` (registerEphemeralForeignHarness) and
 * `launchForeignSession` (spawnAgentInHarness) must agree on:
 * `ephemeralForeignHarnessSlug(offerId)`.
 */
describe('launchForeignSession (WI-1937 D-001, option B)', () => {
  const launchSpec: ForeignLaunchSpec = {
    offer: {
      offerId: 'offer-42',
      fleetSlug: 'peer-fleet',
      publisherRef: 'peer-fleet:device-a',
      billedTo: 'peer-fleet',
      modelClass: 'sonnet',
      priority: 1,
    } as ForeignLaunchSpec['offer'],
    workspace: {
      workspaceId: 'ws-1',
      offerId: 'offer-42',
      fleetSlug: 'peer-fleet',
      originGithubUserId: 123,
      executorDevice: 'device-b',
      rootPath: '/tmp/foreign/offer-42',
      clonePath: '/tmp/foreign/offer-42/repo',
      sessionId: null,
      executionEpoch: 1,
      state: 'provisioning',
      parkReason: null,
      baseSha: null,
    },
    clonePath: '/tmp/foreign/offer-42/repo',
    presenceLabel: 'foreign:peer-fleet:offer-42',
    sessionRole: 'foreign-session',
  };

  it('spawns into ephemeralForeignHarnessSlug(offerId) — never a caller-default harness', async () => {
    spawnAgentInHarnessMock.mockReset();
    spawnAgentInHarnessMock.mockResolvedValue({
      ok: true,
      spawnId: 's-abc123',
      harness: ephemeralForeignHarnessSlug('offer-42'),
      projectDir: '/tmp/foreign/offer-42/repo',
      error: null,
    });
    const result = await launchForeignSession(launchSpec);
    expect(result).toEqual({ sessionId: 's-abc123' });
    expect(spawnAgentInHarnessMock).toHaveBeenCalledTimes(1);
    const callArg = spawnAgentInHarnessMock.mock.calls[0][0];
    expect(callArg.harness).toBe(ephemeralForeignHarnessSlug('offer-42'));
    expect(callArg.harness).not.toBe('papercusp'); // never the local default
    expect(callArg.role).toBe('foreign-session');
    expect(callArg.workspaceId).toBe('ws-1');
  });

  it('throws (never returns a falsy/undefined session) when spawnAgentInHarness refuses', async () => {
    spawnAgentInHarnessMock.mockReset();
    spawnAgentInHarnessMock.mockResolvedValue({
      ok: false,
      spawnId: null,
      harness: null,
      projectDir: null,
      error: 'harness "foreign-offer-42" is not a registered project',
    });
    await expect(launchForeignSession(launchSpec)).rejects.toThrow(/refused/);
  });
});
