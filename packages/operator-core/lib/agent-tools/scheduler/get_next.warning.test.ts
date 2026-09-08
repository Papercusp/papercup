import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getNextForBee: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn(),
  workItemClaimLeaseEnabled: vi.fn(() => false),
  leaseClaimedWorkItem: vi.fn(async () => true),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: mocks.getFlag,
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: mocks.resolveAgentIdentity,
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: mocks.getNextForBee,
  resolveClaimSpecWorkspace: mocks.resolveClaimSpecWorkspace,
}));

// WI-39730 bridged scheduler:get_next onto the per-Hive claim lease, so every claim now runs
// through leaseClaimedWorkItem — a REAL PG write the unit-test guard refuses. This file is about
// the DEFAULT_CLAIM_SPEC warning, not the lease, so the seam is stubbed with the lease DISABLED:
// `leaseOn === false` short-circuits arbitrateSchedulerClaim before either PG call, leaving the
// exact claim path these assertions were written against. get_next.test.ts owns the lease's own
// coverage (it drives the lease-lost release). BOTH exports must be supplied — get_next imports
// them together, so a factory missing one fails collection, not just the call.
vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: mocks.workItemClaimLeaseEnabled,
  leaseClaimedWorkItem: mocks.leaseClaimedWorkItem,
}));
vi.mock('../../work-scope-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-scope-policy')>()),
  gateWorkScope: vi.fn(async () => ({ allowed: true })),
}));
// This file asserts the default-spec warning after a successful claim. Keep the
// newly widened coordination preflight hermetic so it cannot reach the live org
// database before the mocked claim path runs.
vi.mock('../coordination/context-pressure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/context-pressure')>()),
  fetchContextPressure: vi.fn(async () => new Map()),
  resolveContextPressureRecoveryPath: vi.fn(async () => null),
}));
vi.mock('../locks/live-lock-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/live-lock-paths')>()),
  liveLockedPaths: vi.fn(async () => []),
}));
vi.mock('../../scheduler/fleet-scope-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/fleet-scope-admission')>()),
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: null, quarantinedIds: [] })),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  getPresence: vi.fn(async () => null),
  writePresence: vi.fn(async () => undefined),
}));

import getNextTool from './get_next';

type ToolDef = {
  handler: (args: unknown, ctx?: unknown) => Promise<{
    content?: Array<{ text: string }>;
    data?: Record<string, unknown>;
  }>;
};

async function callGetNext(args: Record<string, unknown> = { harness: 'papercusp' }) {
  const res = await (getNextTool as unknown as ToolDef).handler(args, {});
  return (res.data ?? JSON.parse(res.content![0].text)) as Record<string, unknown>;
}

describe('scheduler:get_next default-spec warning (EI-8579)', () => {
  beforeEach(() => {
    mocks.getFlag.mockResolvedValue(true);
    mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-no-spec', workspaceId: 'ws-test' });
    mocks.resolveClaimSpecWorkspace.mockReturnValue('ws-test');
    mocks.getNextForBee.mockReset();
  });

  it('warns when a self-puller falls back to DEFAULT_CLAIM_SPEC', async () => {
    mocks.getNextForBee.mockResolvedValue({
      workItem: { id: 'EI-8489', state: 'open' },
      claimedUnder: { specId: 'default-fixed-ordering', revision: 0 },
      specSource: 'default',
    });

    const out = await callGetNext();

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.warning).toContain('DEFAULT_CLAIM_SPEC');
    expect(out.warning).toContain('scheduler:set_claim_spec');
  });

  it('does not warn when the claim came from a bee or inherited fleet spec', async () => {
    for (const specSource of ['cup', 'fleet']) {
      mocks.getNextForBee.mockResolvedValueOnce({
        workItem: { id: `WI-${specSource}`, state: 'todo' },
        claimedUnder: { specId: `${specSource}-spec`, revision: 1 },
        specSource,
      });

      const out = await callGetNext();

      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(out.warning).toBeUndefined();
    }
  });
});
