/**
 * WI-6581 — the per-backend ARCHIVE KEYING of the ended-session rematerialize.
 *
 * These assert the two things that made codex silently unrecoverable, both of
 * which a claude-shaped fixture would have passed while the real path stayed
 * broken (which is exactly why the item asked for a real-archive verification
 * alongside them):
 *
 *   1. a codex stream keyed by its ADV-SESSION ROW ID must go through the
 *      archive's adv_session_id index to find the rollout uuid the archive is
 *      actually keyed by — the row id is not an archive key;
 *   2. the post-restore re-resolve must look inside the root the restore wrote
 *      to (the session's own CODEX_HOME), not the global ~/.codex the by-uuid
 *      resolver defaults to.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  rematerializeTranscript,
  type RematTranscriptDeps,
} from './session-transcript-remat';

const CODEX_HOME = '/home/u/.papercusp/su-codex-homes/session-13354';
const ROLLOUT_ID = '019f713e-8fa2-7d52-9cbc-29644c273d4f';
const ROLLOUT_PATH = `${CODEX_HOME}/sessions/2026/08/01/rollout-2026-08-01T12-00-00-${ROLLOUT_ID}.jsonl`;

/** A store that only knows the ONE real codex archive, keyed the real way. */
function codexDeps(over: Partial<RematTranscriptDeps> = {}): RematTranscriptDeps {
  return {
    rematerializeSession: vi.fn(async (key) =>
      key.sourceKind === 'codex' && key.sessionId === ROLLOUT_ID
        ? { ok: true, root: CODEX_HOME }
        : { ok: false, reason: 'not_archived' },
    ),
    findArchivedSessionIdForAdv: vi.fn(async (advId) => (advId === 13354 ? ROLLOUT_ID : null)),
    resolveClaude: vi.fn(async () => null),
    resolveOmp: vi.fn(async () => null),
    // Both codex resolvers answer ONLY when pointed at the restored root — the
    // production defaults (global ~/.codex / the natural per-session home) are
    // modelled here as "anything else finds nothing".
    resolveCodexByUuid: vi.fn(async (id, root) =>
      id === ROLLOUT_ID && root === CODEX_HOME ? ROLLOUT_PATH : null,
    ),
    resolveCodexBySessionKey: vi.fn(async (k, root) =>
      k === '13354' && root === CODEX_HOME ? ROLLOUT_PATH : null,
    ),
    ...over,
  };
}

describe('rematerializeTranscript — codex archive keying (WI-6581)', () => {
  it('maps a codex ADV-ROW session key through adv_session_id to the rollout uuid', async () => {
    const deps = codexDeps();
    const r = await rematerializeTranscript({ kind: 'codex-session-key', sessionKey: '13354' }, deps);

    expect(r).toEqual({ path: ROLLOUT_PATH, reason: 'restored', root: CODEX_HOME });
    expect(deps.findArchivedSessionIdForAdv).toHaveBeenCalledWith(13354);
    // The archive was asked for the ROLLOUT uuid — never the adv row id. This
    // is the assertion a claude-shaped fixture cannot make, because for claude
    // the stream key and the archive key are the same string.
    expect(deps.rematerializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'codex', sessionId: ROLLOUT_ID }),
    );
  });

  it('re-resolves a codex rollout INSIDE the restored root, not the global ~/.codex', async () => {
    const deps = codexDeps();
    const r = await rematerializeTranscript({ kind: 'codex-rollout', rolloutId: ROLLOUT_ID }, deps);

    expect(r.path).toBe(ROLLOUT_PATH);
    expect(deps.resolveCodexByUuid).toHaveBeenCalledWith(ROLLOUT_ID, CODEX_HOME);
  });

  it('reports restored_but_unresolved when the restore lands somewhere the resolver cannot see', async () => {
    // The pre-fix behaviour of the by-uuid leg, made explicit: restore succeeds,
    // the walk looks in the wrong home, the pane stays empty.
    const deps = codexDeps({ resolveCodexByUuid: vi.fn(async () => null) });
    const r = await rematerializeTranscript({ kind: 'codex-rollout', rolloutId: ROLLOUT_ID }, deps);

    expect(r).toEqual({ path: null, reason: 'restored_but_unresolved', root: CODEX_HOME });
  });

  it('returns no_archive_key for an adv row id with no archive (never a bogus restore)', async () => {
    const deps = codexDeps();
    const r = await rematerializeTranscript({ kind: 'codex-session-key', sessionKey: '999999' }, deps);

    expect(r).toEqual({ path: null, reason: 'no_archive_key' });
    expect(deps.rematerializeSession).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric codex session key without touching the archive', async () => {
    const deps = codexDeps();
    const r = await rematerializeTranscript({ kind: 'codex-session-key', sessionKey: 'abc' }, deps);

    expect(r.reason).toBe('no_archive_key');
    expect(deps.findArchivedSessionIdForAdv).not.toHaveBeenCalled();
    expect(deps.rematerializeSession).not.toHaveBeenCalled();
  });
});

describe('rematerializeTranscript — the claude/omp legs are unchanged', () => {
  it('claude uses its session uuid directly as the archive key', async () => {
    const deps = codexDeps({
      rematerializeSession: vi.fn(async () => ({ ok: true, root: '/cfg' })),
      resolveClaude: vi.fn(async () => '/cfg/projects/p/sess-1.jsonl'),
    });
    const r = await rematerializeTranscript({ kind: 'claude', sessionId: 'sess-1', owner: 'su-1' }, deps);

    expect(r.path).toBe('/cfg/projects/p/sess-1.jsonl');
    expect(deps.rematerializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'claude', sessionId: 'sess-1' }),
    );
    // The RESTORED ROOT is passed alongside the owner hint (EI-16982) — see the
    // misattribution regression test below for why the root can't be dropped.
    expect(deps.resolveClaude).toHaveBeenCalledWith('sess-1', 'su-1', '/cfg');
  });

  it('EI-16982: re-resolves via the RESTORED ROOT when the archive owner is stale/misattributed', async () => {
    // Reproduces the live bug: session_archives.owner can name a DIFFERENT
    // coord owner than the one the caller (the UI, keyed off coord_presence /
    // psu-pty's own event ledger) asks about — e.g. a forked session whose
    // CLAUDE_CONFIG_DIR stayed pointed at its parent's isolated dir. The
    // restore still lands the bytes under the archive's OWN session_root
    // ('/session-claude/su-OTHER-OWNER'), never under the asked-about owner's
    // dir — so a resolver that trusts only `owner` reports the session
    // unrecoverable even though rematerializeSession just wrote it to disk.
    const RESTORED_ROOT = '/home/u/.papercusp/session-claude/su-actual-owner-on-disk';
    const REAL_PATH = `${RESTORED_ROOT}/projects/p/8c0f946c.jsonl`;
    const deps = codexDeps({
      rematerializeSession: vi.fn(async () => ({ ok: true, root: RESTORED_ROOT })),
      // Models the pre-fix resolver: it only ever sees `owner`, and the caller's
      // asserted owner ('su-e2982660') does NOT match where the file actually
      // lives, so an owner-only lookup would return null. Passing `root` lets
      // the resolver find it directly regardless of the owner mismatch.
      resolveClaude: vi.fn(async (_sessionId, _owner, root) => (root === RESTORED_ROOT ? REAL_PATH : null)),
    });
    const r = await rematerializeTranscript(
      { kind: 'claude', sessionId: '8c0f946c', owner: 'su-e2982660' },
      deps,
    );

    expect(r).toEqual({ path: REAL_PATH, reason: 'restored', root: RESTORED_ROOT });
    expect(deps.resolveClaude).toHaveBeenCalledWith('8c0f946c', 'su-e2982660', RESTORED_ROOT);
  });

  it('omp uses its thread id directly as the archive key', async () => {
    const deps = codexDeps({
      rematerializeSession: vi.fn(async () => ({ ok: true, root: '/omp' })),
      resolveOmp: vi.fn(async () => '/omp/cwd/ts_thread-9.jsonl'),
    });
    const r = await rematerializeTranscript({ kind: 'omp', threadId: 'thread-9' }, deps);

    expect(r.path).toBe('/omp/cwd/ts_thread-9.jsonl');
    expect(deps.rematerializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'omp', sessionId: 'thread-9' }),
    );
  });

  it('surfaces not_archived distinctly from a failed restore', async () => {
    const notArchived = await rematerializeTranscript(
      { kind: 'claude', sessionId: 'nope' },
      codexDeps({ rematerializeSession: vi.fn(async () => ({ ok: false, reason: 'not_archived' })) }),
    );
    expect(notArchived.reason).toBe('not_archived');

    const shaMismatch = await rematerializeTranscript(
      { kind: 'claude', sessionId: 'bad' },
      codexDeps({ rematerializeSession: vi.fn(async () => ({ ok: false, reason: 'sha_mismatch' })) }),
    );
    expect(shaMismatch.reason).toBe('restore_failed');
  });

  it('never throws when the archive layer blows up', async () => {
    const r = await rematerializeTranscript(
      { kind: 'claude', sessionId: 'sess-1' },
      codexDeps({
        rematerializeSession: vi.fn(async () => {
          throw new Error('zstd unavailable');
        }),
      }),
    );
    expect(r).toEqual({ path: null, reason: 'unavailable' });
  });
});
