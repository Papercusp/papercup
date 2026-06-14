import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(),
  appendTurn: vi.fn(),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(() => Promise.resolve()) }));

import { surfaceCuratedMessage } from './curation-surface';
import { getOrCreateActiveConversation, appendTurn } from '../operator-conversations';
import { notifySyncInvalidate } from '../sync-sse';

const mockedConvo = vi.mocked(getOrCreateActiveConversation);
const mockedAppend = vi.mocked(appendTurn);
const mockedInvalidate = vi.mocked(notifySyncInvalidate);

describe('surfaceCuratedMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedConvo.mockResolvedValue({ id: 'conv-1' } as never);
    mockedAppend.mockResolvedValue({ id: 'turn-1' } as never);
  });

  it('returns the conversation + turn ids', async () => {
    expect(await surfaceCuratedMessage('status: green')).toEqual({
      conversationId: 'conv-1',
      turnId: 'turn-1',
    });
  });

  it('appends a system-generated ASSISTANT turn (not a user turn)', async () => {
    await surfaceCuratedMessage('hello');
    expect(mockedAppend).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      role: 'assistant',
      text: 'hello',
      source: 'system',
    });
  });

  it('fires a sync-invalidate so it live-tails into the chat', async () => {
    await surfaceCuratedMessage('hello');
    expect(mockedInvalidate).toHaveBeenCalledWith('operatorTurns.byConversation', {
      conversationId: 'conv-1',
    });
  });
});
