import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../operator-conversations', () => ({
  getWorkItemConversation: vi.fn(),
}));

import { getWorkItemConversation } from '../operator-conversations';
import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

const getConversation = vi.mocked(getWorkItemConversation);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('operatorConversations.byWorkItem', () => {
  it('is registered and threads the full subject key into the focused read', async () => {
    getConversation.mockResolvedValue({ id: 'conversation-42' } as never);
    expect(knownQueryNamesV2()).toContain('operatorConversations.byWorkItem');
    const rows = await resolveNamedQueryV2('operatorConversations.byWorkItem', {
      workspaceId: 'ws-a',
      harness: 'papercusp',
      workItemId: 'WI-42',
    });
    expect(getConversation).toHaveBeenCalledWith({
      workspaceId: 'ws-a',
      harnessSlug: 'papercusp',
      workItemId: 'WI-42',
    });
    expect(rows).toEqual([{ id: 'conversation-42' }]);
  });

  it('returns an empty result without creating when no binding exists', async () => {
    getConversation.mockResolvedValue(null);
    await expect(
      resolveNamedQueryV2('operatorConversations.byWorkItem', {
        workspaceId: 'ws-a',
        harness: 'papercusp',
        workItemId: 'WI-404',
      }),
    ).resolves.toEqual([]);
  });
});

