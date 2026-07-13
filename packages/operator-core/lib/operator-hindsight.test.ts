// operator-hindsight — unit contract for the TWO-delivery push
// (operator-chat-sidebar-revival-2026-07-13 P-008).
//
// Leg 1 (coord notify → voice drain) predates this test. Leg 2 is the fix this
// pins: hindsight must ALSO land as a `system` turn in the SHARED operator
// conversation, because with the native dock testing-gated dark (D-004) and
// voice off, the coord notify alone is drained by NOBODY — a settled deep-dive
// answer or handoff landing was invisible to the typed-turn sidebar user.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  appendLine: vi.fn(async () => {}),
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'conv-1' })),
  appendTurn: vi.fn(async () => ({ id: 't-1', seq: 1 })),
  notifySyncInvalidate: vi.fn(async () => {}),
}));

vi.mock('./agent-tools/coordination/log', () => ({
  coordLog: { appendLine: h.appendLine },
}));
vi.mock('./agent-tools/coordination/messages', () => ({
  readInbox: vi.fn(async () => []),
  readAckedMsgIds: vi.fn(async () => new Set()),
  appendAck: vi.fn(async () => {}),
}));
vi.mock('./operator-conversations', () => ({
  getOrCreateActiveConversation: h.getOrCreateActiveConversation,
  appendTurn: h.appendTurn,
}));
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: h.notifySyncInvalidate,
}));

import { notifyOperatorHindsight } from './operator-hindsight';

describe('notifyOperatorHindsight — two deliveries (P-008)', () => {
  beforeEach(() => {
    h.appendLine.mockClear();
    h.getOrCreateActiveConversation.mockClear();
    h.appendTurn.mockClear();
    h.notifySyncInvalidate.mockClear();
    h.appendTurn.mockImplementation(async () => ({ id: 't-1', seq: 1 }));
  });

  it('pushes the coord notify AND appends a system turn to the shared conversation', async () => {
    await notifyOperatorHindsight('Deep dive WI-123 landed: the answer.', 'deep-answer');

    // Leg 1 — coord notify (voice drain).
    expect(h.appendLine).toHaveBeenCalledTimes(1);
    const env = h.appendLine.mock.calls[0]![2] as { kind: string; summary: string };
    expect(env.kind).toBe('notify');
    expect(env.summary).toBe('Deep dive WI-123 landed: the answer.');

    // Leg 2 — shared-thread system turn, prefixed for the transcript.
    expect(h.appendTurn).toHaveBeenCalledTimes(1);
    expect(h.appendTurn.mock.calls[0]![0]).toMatchObject({
      conversationId: 'conv-1',
      role: 'system',
      source: 'system',
      text: '[While you were away] Deep dive WI-123 landed: the answer.',
    });
    // Live sidebars refresh via the same sync query they already subscribe to.
    expect(h.notifySyncInvalidate).toHaveBeenCalledWith('operatorTurns.byConversation', {
      conversationId: 'conv-1',
    });
  });

  it('a thread-append failure never loses the coord notify (fail-soft)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.appendTurn.mockImplementation(async () => {
      throw new Error('pg down');
    });

    await expect(
      notifyOperatorHindsight('Your request "x" landed (WI-9).', 'handoff-landed'),
    ).resolves.toBeUndefined();

    expect(h.appendLine).toHaveBeenCalledTimes(1); // leg 1 still delivered
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('shared-thread append failed'),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });
});
