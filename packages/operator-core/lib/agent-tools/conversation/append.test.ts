/**
 * EI-2905 regression: conversation:append returned `UNDEFINED_VALUE: Undefined values are not
 * allowed` on 100% of calls because the handler read `conv.conversationId` — a field that does
 * NOT exist on ConversationRow (its id field is `id`) — so `undefined` flowed into appendTurn's
 * INSERT `$1`. This pins that the handler passes a DEFINED conversation id (conv.id).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(),
  appendTurn: vi.fn(),
}));

import appendTool from './append';
import { getOrCreateActiveConversation, appendTurn } from '../../operator-conversations';

const getConv = vi.mocked(getOrCreateActiveConversation);
const append = vi.mocked(appendTurn);

beforeEach(() => {
  vi.clearAllMocks();
  // ConversationRow's id field is `id` (NOT `conversationId`).
  getConv.mockResolvedValue({ id: 'conv-1' } as never);
  append.mockResolvedValue({ seq: 7 } as never);
});

describe('conversation:append (EI-2905 — pass conv.id, never the nonexistent conv.conversationId)', () => {
  it('passes a DEFINED conversation id (conv.id) into appendTurn — the regression was undefined', async () => {
    await (appendTool as { handler: (a: never, c: never) => Promise<unknown> }).handler(
      { role: 'user', text: 'hello' } as never,
      {} as never,
    );
    expect(append).toHaveBeenCalledTimes(1);
    const arg = append.mock.calls[0][0];
    expect(arg.conversationId).toBe('conv-1'); // === conv.id
    expect(arg.conversationId).toBeDefined(); // the EI-2905 bug: this was undefined
  });

  it('defaults source by role (user→voice_stt, assistant→voice_tts)', async () => {
    await (appendTool as { handler: (a: never, c: never) => Promise<unknown> }).handler(
      { role: 'assistant', text: 'hi there' } as never,
      {} as never,
    );
    expect(append.mock.calls[0][0].source).toBe('voice_tts');
  });
});
