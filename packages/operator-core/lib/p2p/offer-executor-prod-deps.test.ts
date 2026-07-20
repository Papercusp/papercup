/**
 * WI-1937 unit tests for offer-executor-prod-deps.ts's `applyCapabilityEnvelope`
 * port. D-001 (p2p-public-release-remaining-lanes-2026-07-16, owner,
 * 2026-07-17) RETIRED the deny-all capability-envelope gate this used to
 * verify — a foreign session's only v1 security layer is now the trust chain
 * upstream of execution, not this port. These tests pin the new contract: the
 * port is a no-op that ALWAYS resolves, regardless of what (if anything)
 * `ROLE_ENVELOPES['foreign-session']` holds — the port no longer reads it at
 * all (this file no longer even imports `ROLE_ENVELOPES`).
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

describe('applyCapabilityEnvelopeForForeignSession (D-001: retired to a no-op)', () => {
  it('resolves — capability-envelope.ts no longer carries a foreign-session entry at all (D-001 HISTORY note)', () => {
    expect(ROLE_ENVELOPES['foreign-session']).toBeUndefined();
  });

  it('ALWAYS resolves regardless of ROLE_ENVELOPES.foreign-session, including the old deny-all shape', async () => {
    const saved = ROLE_ENVELOPES['foreign-session'];
    (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = { denyCapabilities: ['*'] };
    try {
      await expect(applyCapabilityEnvelopeForForeignSession(spec)).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'];
      else (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = saved;
    }
  });

  it('resolves even with no ROLE_ENVELOPES.foreign-session entry at all (today\'s actual state)', async () => {
    const saved = ROLE_ENVELOPES['foreign-session'];
    delete (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'];
    try {
      await expect(applyCapabilityEnvelopeForForeignSession(spec)).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) (ROLE_ENVELOPES as Record<string, unknown>)['foreign-session'] = saved;
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
      createdAt: 0,
      updatedAt: 0,
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
