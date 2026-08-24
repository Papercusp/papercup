import { describe, expect, it, vi } from 'vitest';
import { parseSessionSelector, parseTurnRef, resolveSessionTurnRefs } from './_shared';

describe('parseSessionSelector', () => {
  it('splits a source-prefixed session id while preserving colons in the native id', () => {
    expect(parseSessionSelector('codex:rollout-123')).toEqual({
      sessionId: 'rollout-123',
      sourceKind: 'codex',
    });
    expect(parseSessionSelector('omp:thread:with:colons')).toEqual({
      sessionId: 'thread:with:colons',
      sourceKind: 'omp',
    });
  });

  it('keeps a raw id unchanged and honors an explicit source kind', () => {
    expect(parseSessionSelector('rollout:with:colons', 'codex')).toEqual({
      sessionId: 'rollout:with:colons',
      sourceKind: 'codex',
    });
    expect(parseSessionSelector('codex:rollout-123', 'codex')).toEqual({
      sessionId: 'rollout-123',
      sourceKind: 'codex',
    });
  });
});

describe('parseTurnRef', () => {
  it('narrows validated source kinds for downstream session readers', () => {
    expect(parseTurnRef('session_turn:codex:rollout-123:7')).toEqual({
      sourceKind: 'codex',
      sessionId: 'rollout-123',
      turnIdx: 7,
    });
    expect(parseTurnRef('session_turn:agent_chat:chat:with:colons:3')).toEqual({
      sourceKind: 'agent_chat',
      sessionId: 'chat:with:colons',
      turnIdx: 3,
    });
    expect(parseTurnRef('session_turn:unknown:session:0')).toBeNull();
  });
});

describe('resolveSessionTurnRefs', () => {
  it('resolves through the live index first and permanent archive second', async () => {
    const indexed = 'session_turn:codex:live-session:7';
    const archived = 'session_turn:codex:archived:session:11';
    const missing = 'session_turn:agent_chat:chat-session:3';
    const sql = vi.fn(async () => [{ ref: indexed }]);
    const refresh = vi.fn(async () => ({ attempted: 0, refreshed: 0 }));
    const readArchive = vi.fn(async (sessionId: string) =>
      sessionId === 'archived:session'
        ? { sourceKind: 'codex' as const, turns: [{ turn_idx: 11 }] }
        : null,
    );

    const result = await resolveSessionTurnRefs(
      sql as never,
      'workspace-a',
      [indexed, archived, missing, 'not-a-ref'],
      { refresh, readArchive },
    );

    expect(result).toEqual([
      { ref: indexed, ok: true, source: 'index' },
      { ref: archived, ok: true, source: 'archive' },
      { ref: missing, ok: false, reason: 'not_found' },
      { ref: 'not-a-ref', ok: false, reason: 'invalid_ref' },
    ]);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(readArchive).toHaveBeenCalledWith('archived:session', 'codex');
    expect(readArchive).not.toHaveBeenCalledWith('chat-session', expect.anything());
  });

  it('deduplicates identical refs before touching either store', async () => {
    const ref = 'session_turn:claude:same:2';
    const sql = vi.fn(async () => [{ ref }]);
    const refresh = vi.fn(async () => ({ attempted: 0, refreshed: 0 }));
    const readArchive = vi.fn(async () => null);

    await expect(resolveSessionTurnRefs(
      sql as never,
      'workspace-a',
      [ref, ref],
      { refresh, readArchive },
    )).resolves.toEqual([{ ref, ok: true, source: 'index' }]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
