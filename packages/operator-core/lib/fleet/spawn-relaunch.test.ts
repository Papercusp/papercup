import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  claimWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  spawnAgentInHarness: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: H.sql }),
}));

vi.mock('../workspace-als', () => ({
  runWithWorkspace: async (_workspaceId: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../work-items', () => ({
  claimWorkItem: H.claimWorkItem,
  releaseWorkItem: H.releaseWorkItem,
}));

vi.mock('./operator-spawn', () => ({
  spawnAgentInHarness: H.spawnAgentInHarness,
}));

import { relaunchReclaimedSpawn } from './spawn-relaunch';
import type { RelaunchableSpawn } from './spawn-reclaim';

const bee = (overrides: Partial<RelaunchableSpawn> = {}): RelaunchableSpawn => ({
  spawnId: 'dead-bee',
  workspaceId: 'ws',
  harnessSlug: 'papercusp',
  childRole: 'cup',
  parentSpawnId: 'queen-1',
  parentRole: 'mug',
  workItemId: 'WI-1',
  workItemStatus: 'todo',
  planSlug: 'plan-1',
  modelSpec: 'sonnet',
  modelTier: 'standard',
  brief: 'resume work',
  ...overrides,
});

describe('relaunchReclaimedSpawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.sql.mockResolvedValue([]);
    H.claimWorkItem.mockResolvedValue({ id: 'WI-1' });
    H.releaseWorkItem.mockResolvedValue({ id: 'WI-1' });
    H.spawnAgentInHarness.mockResolvedValue({ ok: true, spawnId: 'reserved-bee', harness: 'papercusp' });
  });

  it('clears the reclaimed holder, then claims the work item to the reserved relaunch spawn id before launching it', async () => {
    const ok = await relaunchReclaimedSpawn(bee());

    expect(ok).toBe(true);
    expect(H.sql).toHaveBeenCalledTimes(1);
    expect(H.claimWorkItem).toHaveBeenCalledTimes(1);
    expect(H.spawnAgentInHarness).toHaveBeenCalledTimes(1);

    const [[workItemId, owner, claimOpts]] = H.claimWorkItem.mock.calls;
    const [[spawnInput]] = H.spawnAgentInHarness.mock.calls;
    expect(workItemId).toBe('WI-1');
    expect(claimOpts).toEqual({ harness: 'papercusp' });
    expect(owner).toMatch(/^s-\d+-[0-9a-f]{8}$/);
    expect(spawnInput).toMatchObject({
      workspaceId: 'ws',
      harness: 'papercusp',
      role: 'cup',
      spawnId: owner,
      featureId: 'WI-1',
      itemId: 'WI-1',
      idempotencyKey: 'boot-relaunch:dead-bee',
    });
    expect(H.sql.mock.invocationCallOrder[0]).toBeLessThan(H.claimWorkItem.mock.invocationCallOrder[0]);
    expect(H.releaseWorkItem).not.toHaveBeenCalled();
  });

  it('releases the reserved work-item claim if relaunch admission fails', async () => {
    H.spawnAgentInHarness.mockResolvedValue({ ok: false, error: 'over fleet ceiling' });

    const ok = await relaunchReclaimedSpawn(bee());

    expect(ok).toBe(false);
    expect(H.releaseWorkItem).toHaveBeenCalledWith('WI-1', { harness: 'papercusp' });
  });
});
