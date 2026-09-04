/**
 * Regression for the conversation:recent handler passing `conv.conversationId`.
 * ConversationRow exposes its persisted identifier as `id`; the old property
 * was undefined and reached the handler query as an empty conversation id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(),
  listTurnsRecent: vi.fn(),
}));

import recentTool from './recent';
import { getOrCreateActiveConversation, listTurnsRecent } from '../../operator-conversations';

const getConv = vi.mocked(getOrCreateActiveConversation);
const listRecent = vi.mocked(listTurnsRecent);

const call = (args: Record<string, unknown> = {}) =>
  (recentTool as { handler: (a: never, c: never) => Promise<unknown> }).handler(args as never, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  getConv.mockResolvedValue({ id: 'conv-1' } as never);
  listRecent.mockResolvedValue({ turns: [], hasMoreEarlier: false });
});

describe('conversation:recent', () => {
  it('passes the defined ConversationRow.id to listTurnsRecent', async () => {
    await call();

    expect(listRecent).toHaveBeenCalledWith({ conversationId: 'conv-1', limit: 20 });
    expect(listRecent.mock.calls[0]?.[0].conversationId).toBeDefined();
  });

  it('honors a caller-provided limit', async () => {
    await call({ limit: 7 });

    expect(listRecent).toHaveBeenCalledWith({ conversationId: 'conv-1', limit: 7 });
  });
});
