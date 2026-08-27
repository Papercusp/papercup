/**
 * plan_items:claim — checkpoint-at-claim regression (EI-21574679768631502).
 *
 * A resumed plan-item claim already has the linked work-item row, but the
 * surface previously returned only the conversion/enrichment fields. A prior
 * holder's checkpoint therefore disappeared at the exact hand-off where it is
 * needed to prevent duplicate implementation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'sess-A', ownerLabel: 'A' }),
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async (opts?: { harnessSlug?: string }) => ({
    workspaceId: 'default',
    harnessSlug: opts?.harnessSlug ?? 'papercup',
  })),
}));
vi.mock('../../plan-items/agent-names', () => ({
  bestEffortOwnerUser: () => 'user-A',
  resolveAdoptedName: vi.fn(async () => 'builder-1'),
}));
vi.mock('../../plan-items/liveness', () => ({ claimPlanItem: vi.fn() }));
vi.mock('../../plan-items/convert', () => ({ convertPlanItem: vi.fn() }));
vi.mock('../../claim-time-enrichment', () => ({
  buildClaimTimeEnrichment: vi.fn(async () => ({})),
}));

const getClaimTimeCheckpointHint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: (...args: unknown[]) => getClaimTimeCheckpointHint(...args),
}));

let flagOn = true;
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => flagOn),
}));

import { convertPlanItem } from '../../plan-items/convert';

const convertM = vi.mocked(convertPlanItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const one = async (args: Record<string, unknown>) =>
  (((await tool.handler(args as never, {} as never)) as Out).data).results[0];

beforeEach(() => {
  vi.clearAllMocks();
  flagOn = true;
  convertM.mockImplementation(
    async (opts) =>
      ({
        status: 'resumed',
        claim: { itemId: opts.itemId, owner: 'sess-A' },
        mode: 'availability',
        viaAssignment: false,
        workItem: {
          id: 'WI-RECLAIMED',
          kind: 'bug',
          harness: opts.harnessSlug,
          payload: { plan_item: { plan_slug: opts.planSlug, item_id: opts.itemId } },
        },
      }) as never,
  );
  getClaimTimeCheckpointHint.mockResolvedValue({
    checkpoint: 'did: focused regression; left: verify current tree',
    checkpointAgeMs: 1_234,
  });
});

describe('plan_items:claim — checkpoint hint on resumed work-item claims', () => {
  it('surfaces the prior holder checkpoint on the converted claim receipt', async () => {
    const result = await one({ plan: 'a-plan', item: 'P-001', harness: 'papercup' });

    expect(result).toMatchObject({
      ok: true,
      plan: 'a-plan',
      item: 'P-001',
      convertStatus: 'resumed',
      checkpoint: 'did: focused regression; left: verify current tree',
      checkpointAgeMs: 1_234,
    });
    expect(result.checkpointWarning).toMatch(/PRIOR holder/);
    expect(result.checkpointWarning).toMatch(/EI-529/);
    expect(getClaimTimeCheckpointHint).toHaveBeenCalledWith({
      harness: 'papercup',
      workItemId: 'WI-RECLAIMED',
      workspaceId: 'default',
    });
  });

  it('keeps the successful claim intact when checkpoint lookup fails', async () => {
    getClaimTimeCheckpointHint.mockRejectedValue(new Error('checkpoint store unavailable'));

    const result = await one({ plan: 'a-plan', item: 'P-001' });

    expect(result).toMatchObject({ ok: true, convertStatus: 'resumed', workItem: { id: 'WI-RECLAIMED' } });
    expect(result).not.toHaveProperty('checkpoint');
    expect(result).not.toHaveProperty('checkpointWarning');
  });
});
