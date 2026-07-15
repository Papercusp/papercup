/**
 * voice:say push-time chat persistence (WI-4838 / multi-window-chat-coherence
 * P-006): the spoken line lands in the shared conversation AT PUSH — the one
 * seam every drain path shares — tagged source 'voice_tts', and the chat pane
 * is invalidated so it live-renders. A persist failure must never fail the
 * speak itself (the FIFO push already happened).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../sentinel-output-buffer', () => ({
  pushSentinelSay: vi.fn(async () => {}),
}));
vi.mock('../../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(),
  appendTurn: vi.fn(),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

import sayTool from './say';
import { pushSentinelSay } from '../../sentinel-output-buffer';
import { getOrCreateActiveConversation, appendTurn } from '../../operator-conversations';
import { notifySyncInvalidate } from '../../sync-sse';

const push = vi.mocked(pushSentinelSay);
const getConv = vi.mocked(getOrCreateActiveConversation);
const append = vi.mocked(appendTurn);
const invalidate = vi.mocked(notifySyncInvalidate);

const handler = (sayTool as unknown as { handler: (a: never, c: never) => Promise<unknown> }).handler;

beforeEach(() => {
  vi.clearAllMocks();
  getConv.mockResolvedValue({ id: 'conv-9' } as never);
  append.mockResolvedValue({ seq: 3 } as never);
});

describe('voice:say', () => {
  it('pushes the line AND persists it as an assistant voice_tts turn', async () => {
    await handler({ text: 'Paris.' } as never, {} as never);
    expect(push).toHaveBeenCalledWith('Paris.');
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toMatchObject({
      conversationId: 'conv-9',
      role: 'assistant',
      text: 'Paris.',
      source: 'voice_tts',
    });
    expect(invalidate).toHaveBeenCalledWith('operatorTurns.byConversation', {
      conversationId: 'conv-9',
    });
  });

  it('still succeeds (line was pushed) when the chat persist fails', async () => {
    append.mockRejectedValueOnce(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = (await handler({ text: 'hello' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    expect(push).toHaveBeenCalledWith('hello');
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
