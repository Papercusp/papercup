/**
 * WI-2971: work_items:claim_next must not bypass an active scheduler claim-spec.
 *
 * Fleet members are steered through scheduler:set_claim_spec, but some launch briefs and
 * older habits still call work_items:claim_next. The wrapper must route through the same
 * getNextForBee selector while SCHEDULER_SPEC_CLAIM is on, so a member cannot pull an
 * out-of-lane item from the raw oldest-first claim path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'su-me', workspaceId: 'ws-1' }));
const flag = vi.hoisted(() => ({ schedulerSpecClaim: true }));

vi.mock('@papercusp/flags', () => ({
  FLAGS: { SCHEDULER_SPEC_CLAIM: 'scheduler.spec.claim' },
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(async () => flag.schedulerSpecClaim),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => identity,
}));

vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: vi.fn(() => false),
  leaseClaimedWorkItem: vi.fn(),
}));

vi.mock('../../work-item-redundancy', () => ({
  workItemRedundancyEnabled: vi.fn(() => false),
}));

vi.mock('../../fleet/swarm-identity', () => ({
  localSwarmId: vi.fn(() => 'swarm-1'),
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-1'),
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn((ws: string | null | undefined) => ws ?? undefined),
}));

vi.mock('../../work-items', () => ({
  CLAIM_STATES_ALLOWLIST: ['todo', 'open', 'failing'],
  claimNextWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  diagnoseClaimNextMiss: vi.fn(),
}));

import { getNextForBee } from '../../scheduler/claim-spec-store';
import { claimNextWorkItem, diagnoseClaimNextMiss } from '../../work-items';

const getNextForBeeM = vi.mocked(getNextForBee);
const claimNextM = vi.mocked(claimNextWorkItem);
const diagnoseM = vi.mocked(diagnoseClaimNextMiss);
const tool = (await import('./claim_next')).default;

async function body(args: unknown) {
  const out = (await tool.handler(args as never, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'su-me';
  identity.workspaceId = 'ws-1';
  flag.schedulerSpecClaim = true;
  getNextForBeeM.mockResolvedValue({
    workItem: { id: 'WI-lane', assignee: 'su-me' } as never,
    claimedUnder: { specId: 'fleet-bugs', revision: 3 },
  });
  claimNextM.mockResolvedValue({ id: 'WI-raw', assignee: 'su-me' } as never);
  diagnoseM.mockResolvedValue({ drained: true, pendingUnclaimed: 0, readyUnclaimed: 0 });
});

describe('work_items:claim_next claim-spec bridge (WI-2971)', () => {
  it('uses getNextForBee while the scheduler claim-spec flag is on', async () => {
    const b = await body({ harness: 'papercusp', states: ['open'] });

    expect(b).toMatchObject({
      ok: true,
      workItem: { id: 'WI-lane' },
      claimedUnder: { specId: 'fleet-bugs', revision: 3 },
    });
    expect(getNextForBeeM).toHaveBeenCalledWith({
      cupId: 'su-me',
      workspaceId: 'ws-1',
      harness: 'papercusp',
      states: ['open'],
      swarmId: undefined,
      excludeRedundant: false,
      rigAvailable: undefined,
    });
    expect(claimNextM).not.toHaveBeenCalled();
  });

  it('uses the explicit assignee as the scheduler bee id', async () => {
    await body({ harness: 'papercusp', assignee: 'su-other' });

    expect(getNextForBeeM).toHaveBeenCalledWith(expect.objectContaining({ cupId: 'su-other' }));
    expect(claimNextM).not.toHaveBeenCalled();
  });

  it('does not fall back to the raw claim path on a spec miss', async () => {
    getNextForBeeM.mockResolvedValue(null);

    const b = await body({ harness: 'papercusp' });

    expect(b).toMatchObject({
      ok: false,
      drained: true,
      pendingUnclaimed: 0,
      readyUnclaimed: 0,
    });
    expect(claimNextM).not.toHaveBeenCalled();
  });

  it('keeps the legacy raw claim path when SCHEDULER_SPEC_CLAIM is off', async () => {
    flag.schedulerSpecClaim = false;

    const b = await body({ harness: 'papercusp' });

    expect(b).toMatchObject({ ok: true, workItem: { id: 'WI-raw' } });
    expect(claimNextM).toHaveBeenCalledWith({
      harness: 'papercusp',
      assignee: 'su-me',
      kind: undefined,
      states: undefined,
      swarmId: undefined,
      excludeRedundant: false,
      rigAvailable: undefined,
    });
    expect(getNextForBeeM).not.toHaveBeenCalled();
  });
});
