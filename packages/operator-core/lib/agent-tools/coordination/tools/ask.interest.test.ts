import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openConversation: vi.fn(),
}));

vi.mock('../identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'asker-1', ownerLabel: 'Asker 1' }),
}));
vi.mock('../conversations', () => ({ openConversation: h.openConversation }));

import tool from './ask';

const handle = {
  event_keys: ['conversation:answered:conv-1'],
  await_ids: [41],
  cancel: { tool: 'events:cancel' as const, args: { await_ids: [41] } },
  handle_note: 'captured requester wake handle',
};

const call = async () => {
  const out = await (tool as any).handler(
    { question: 'Which invariant applies?', to: ['peer-1'] },
    {},
  );
  return JSON.parse(out.content[0].text);
};

beforeEach(() => {
  h.openConversation.mockReset().mockResolvedValue({
    conversation: { id: 'conv-1', scope: 'question:conv-1' },
    topics: [],
    direct_to: ['peer-1'],
    unrouted: false,
    delivered: 1,
    interestWatch: handle,
  });
});

describe('coord:ask requester interest handle (P-024)', () => {
  it('projects the question lifecycle cancel handle returned by openConversation', async () => {
    const out = await call();
    expect(out).toMatchObject({
      ok: true,
      conversation_id: 'conv-1',
      asked: ['peer-1'],
      interest_watch: handle,
    });
    expect(h.openConversation).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'asker-1' }),
      expect.objectContaining({ kind: 'question', direct_to: ['peer-1'] }),
    );
  });
});
