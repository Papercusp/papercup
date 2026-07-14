import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transfer, refresh } = vi.hoisted(() => ({
  transfer: vi.fn(),
  refresh: vi.fn(async () => ({ generation: 1 })),
}));
vi.mock('../../harness/routines/loop', () => ({ transferLoopOwnership: transfer }));
vi.mock('../coordination/control-anchor', () => ({ refreshControlAnchorAfterMutation: refresh }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-me', ownerLabel: 'su · me', workspaceId: 'ws', source: 'omp-hook-session', userId: null }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));

import tool from './transfer';

describe('loop:transfer', () => {
  beforeEach(() => { transfer.mockReset(); refresh.mockClear(); });

  it('transfers from the caller by default and refreshes both CTRL anchors', async () => {
    transfer.mockResolvedValue({ transferred: true, routineId: 'loop-1' });
    const result = await tool.handler({ toOwnerId: 'su-next' }, { clientId: 'su-me', workspaceId: 'ws' } as never) as {
      content: Array<{ text: string }>;
    };
    expect(transfer).toHaveBeenCalledWith('su-me', 'su-next');
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, fromOwnerId: 'su-me', toOwnerId: 'su-next' });
  });

  it('returns an error instead of merging into an existing destination loop', async () => {
    transfer.mockResolvedValue({ transferred: false, routineId: null });
    const result = await tool.handler({ fromOwnerId: 'su-old', toOwnerId: 'su-next' }, { clientId: 'su-me', workspaceId: 'ws' } as never) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});
