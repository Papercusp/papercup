import { describe, expect, it, vi } from 'vitest';
import { parseSessionSelector, parseTurnRef, resolveSessionTurnRefs } from './_shared';
import { withholdRestrictedTurns } from '../../personal-vault/transcript-exclusion';

vi.mock('../../personal-vault/transcript-exclusion', () => ({
  withholdRestrictedTurns: vi.fn(async (_sql, _params, turns) => ({ kept: turns, withheld: {} })),
}));

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

  it('measures indexed text without turning an unenrolled user into authenticated owner speech', async () => {
    const ref = 'session_turn:codex:measured:2';
    const row = { ref, text: 'Keep the original scope.', speaker: 'user', owner: 'author',
      at: '2026-11-01T00:00:00Z', turn_origin: null, turn_origin_verdict: 'unenrolled-origin' };
    const sql = vi.fn(async () => [row]);
    const deps = { refresh: vi.fn(async () => ({ attempted: 0, refreshed: 0 })),
      readArchive: vi.fn(async () => null), evidenceForOwner: 'reader' };
    const [first] = await resolveSessionTurnRefs(sql as never, 'workspace-a', [ref], deps);
    expect(first).toMatchObject({ ref, ok: true, source: 'index', evidence: {
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), speaker: 'user', origin: { verdict: 'unknown' },
    } });
    row.text = 'The source changed.';
    const [changed] = await resolveSessionTurnRefs(sql as never, 'workspace-a', [ref], deps);
    expect(changed?.evidence?.fingerprint).not.toBe(first?.evidence?.fingerprint);
    expect(JSON.stringify(first)).not.toContain('Keep the original scope.');
  });

  it('measures archive-only machine turns, coalesces a session read and rejects incomplete archives', async () => {
    const refs = [7, 9].map(i => `session_turn:codex:old-session:${i}`);
    const archive = { sourceKind: 'codex' as const, errors: [] as Array<{ error: string }>, turns: [
      { turn_idx: 7, text: '⟦turn-origin:loop-fire⟧ Continue the saved lane.', speaker: 'user', owner: 'author', ts: null },
      { turn_idx: 9, text: 'An assistant observation.', speaker: 'assistant', owner: 'author', ts: null },
    ] };
    const readArchive = vi.fn(async () => archive);
    const deps = { refresh: vi.fn(async () => ({ attempted: 0, refreshed: 0 })), readArchive,
      evidenceForOwner: 'reader' };
    const sql = vi.fn(async () => []);
    const result = await resolveSessionTurnRefs(sql as never, 'workspace-a', refs, deps);
    expect(result).toMatchObject([
      { ok: true, source: 'archive', evidence: { origin: { verdict: 'agent-injected', origin: 'loop-fire' } } },
      { ok: true, source: 'archive', evidence: { origin: { verdict: 'not-user-turn' } } },
    ]);
    expect(readArchive).toHaveBeenCalledTimes(1);
    archive.errors = [{ error: 'archive sha256 mismatch' }];
    expect(await resolveSessionTurnRefs(sql as never, 'workspace-a', refs, deps))
      .toEqual(refs.map(ref => ({ ref, ok: false, reason: 'not_found' })));
  });

  it('does not fall back to the archive for a disclosure-withheld indexed turn', async () => {
    const ref = 'session_turn:codex:private:3';
    vi.mocked(withholdRestrictedTurns).mockResolvedValueOnce({ kept: [],
      withheld: { turns: 1, byReason: { 'disclosure-window': 1, unattributed: 0 } } });
    const sql = vi.fn(async () => [{ ref, text: 'private text', speaker: 'user', owner: 'other', at: null }]);
    const readArchive = vi.fn(async () => null);
    const result = await resolveSessionTurnRefs(sql as never, 'workspace-a', [ref], {
      refresh: vi.fn(async () => ({ attempted: 0, refreshed: 0 })), readArchive, evidenceForOwner: 'reader',
    });
    expect(result).toEqual([{ ref, ok: false, reason: 'not_found' }]);
    expect(readArchive).not.toHaveBeenCalled();
    expect(withholdRestrictedTurns).toHaveBeenLastCalledWith(sql, { selfOwnerIds: ['reader'] },
      expect.any(Array), expect.any(Function));
  });
});
