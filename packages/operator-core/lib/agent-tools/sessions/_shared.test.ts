import { describe, expect, it, vi } from 'vitest';
import { resolveSessionTurnRefs } from './_shared';

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
