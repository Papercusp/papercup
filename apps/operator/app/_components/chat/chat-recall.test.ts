/**
 * ↑-recall helper (Discord edit-last analog, discord-shortcuts 2026-06-06):
 * the EMPTY composer's ArrowUp recalls the last USER message — never the
 * assistant's reply, never whitespace-only turns.
 */
import { describe, expect, it } from 'vitest';
import { lastUserMessageText, type ChatMessage } from './ChatConversation';

const m = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

describe('lastUserMessageText', () => {
  it('returns the most recent user turn, skipping assistant/system replies', () => {
    expect(
      lastUserMessageText([
        m('user', 'first ask'),
        m('assistant', 'answer one'),
        m('user', 'second ask'),
        m('assistant', 'answer two'),
        m('system', 'note'),
      ]),
    ).toBe('second ask');
  });

  it('skips whitespace-only user turns', () => {
    expect(lastUserMessageText([m('user', 'real one'), m('user', '   ')])).toBe('real one');
  });

  it('returns null when no user turn exists', () => {
    expect(lastUserMessageText([m('assistant', 'hi'), m('system', 'x')])).toBeNull();
    expect(lastUserMessageText([])).toBeNull();
  });
});
