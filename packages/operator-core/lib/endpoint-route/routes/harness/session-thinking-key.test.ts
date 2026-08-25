/**
 * `sessionThinkingKey` — the ONE decision about which backend a conversation
 * popup request is for (WI-41496 / WI-41499).
 *
 * This used to be two independent 4-way branches over the same query params:
 * one selecting the live resolver + parser, another rebuilding a key to
 * re-resolve an ENDED session from the archive. Two copies of one decision is
 * how the omp leg came to pass its per-session home key in one place and not
 * the other — the live stream resolved the right transcript while the archive
 * path addressed a different session, and nothing failed loudly.
 *
 * Extracting it made the decision testable; these are the cases that were
 * previously only exercised by running the route.
 */

import { describe, expect, it } from 'vitest';

import { sessionThinkingKey } from './streams';

describe('sessionThinkingKey — per-backend selection', () => {
  it('codex: an adv-row session key wins, naming the per-session CODEX_HOME', () => {
    expect(sessionThinkingKey({ codexSessionKey: '18014' })).toEqual({
      kind: 'codex-session-key',
      sessionKey: '18014',
    });
  });

  it('codex: a rollout uuid is the deep-link fallback', () => {
    expect(sessionThinkingKey({ codexRolloutId: '01a03683-05ce-7001-bfde-ec00081c4aa7' })).toEqual({
      kind: 'codex-rollout',
      rolloutId: '01a03683-05ce-7001-bfde-ec00081c4aa7',
    });
  });

  it('omp: a thread id alone resolves — a deep link carries no session key', () => {
    expect(sessionThinkingKey({ ompThreadId: '01a036bd-eab0-7265-8ade-13cac5d74ae9' })).toEqual({
      kind: 'omp',
      threadId: '01a036bd-eab0-7265-8ade-13cac5d74ae9',
    });
  });

  it('omp: ompSessionKey is CARRIED onto the key when present (WI-41496)', () => {
    // The whole bug. A psu-launched omp agent writes to
    // ~/.papercusp/su-omp-homes/session-<advId>/agent/sessions and never to the
    // shared ~/.omp; without this key on the key object the resolver looked
    // only in the shared home and EVERY such popup was permanently empty —
    // measured live against a 25 KB transcript that was being appended at the
    // time.
    expect(sessionThinkingKey({ ompThreadId: 'thread-1', ompSessionKey: '18080' })).toEqual({
      kind: 'omp',
      threadId: 'thread-1',
      sessionKey: '18080',
    });
  });

  it('omp: an absent session key is OMITTED, never carried as undefined', () => {
    // The key is re-serialized for the archive re-resolve; a literal
    // `sessionKey: undefined` and an absent one are the same to the resolver
    // but not to anything that compares or hashes the key.
    const key = sessionThinkingKey({ ompThreadId: 'thread-1', ompSessionKey: '' });
    expect(key).toEqual({ kind: 'omp', threadId: 'thread-1' });
    expect(Object.hasOwn(key!, 'sessionKey')).toBe(false);
  });

  it('claude: a session id selects the interactive resolver, with owner when known', () => {
    expect(sessionThinkingKey({ sessionId: 'c0ed9f5c-2506-4375-8c97-08001014d8c0', owner: 'su-37e4986b' })).toEqual({
      kind: 'claude',
      sessionId: 'c0ed9f5c-2506-4375-8c97-08001014d8c0',
      owner: 'su-37e4986b',
    });
  });

  it('claude: owner is omitted when absent (the full-scan fallback still resolves)', () => {
    const key = sessionThinkingKey({ sessionId: 'abc' });
    expect(key).toEqual({ kind: 'claude', sessionId: 'abc' });
    expect(Object.hasOwn(key!, 'owner')).toBe(false);
  });

  it('returns null when nothing identifies a session', () => {
    // The route answers an empty backfill and closes, rather than resolving
    // some other session's transcript.
    expect(sessionThinkingKey({})).toBeNull();
    expect(sessionThinkingKey({ owner: 'su-37e4986b' })).toBeNull();
  });
});

describe('sessionThinkingKey — precedence', () => {
  // The precedence is load-bearing, not incidental: a codex or omp adv row
  // carries its rollout/thread uuid in `session_id` too, so a request can
  // legitimately arrive with BOTH a backend-specific param and a sessionId. If
  // the claude leg were tested first, every such request would resolve against
  // ~/.papercusp/session-claude, miss, and stream an empty pane — which is
  // exactly the misread WI-41497 fixed one layer up in adv-roster.
  it('codexSessionKey beats a sessionId carrying the same uuid', () => {
    expect(sessionThinkingKey({
      codexSessionKey: '18014',
      sessionId: '01a03683-05ce-7001-bfde-ec00081c4aa7',
    })).toMatchObject({ kind: 'codex-session-key' });
  });

  it('codexRolloutId beats a sessionId', () => {
    expect(sessionThinkingKey({
      codexRolloutId: '01a03683-05ce-7001-bfde-ec00081c4aa7',
      sessionId: '01a03683-05ce-7001-bfde-ec00081c4aa7',
    })).toMatchObject({ kind: 'codex-rollout' });
  });

  it('ompThreadId beats a sessionId', () => {
    expect(sessionThinkingKey({
      ompThreadId: '01a036bd-eab0-7265-8ade-13cac5d74ae9',
      sessionId: '01a036bd-eab0-7265-8ade-13cac5d74ae9',
    })).toMatchObject({ kind: 'omp' });
  });

  it('codexSessionKey beats codexRolloutId (the per-session home is where psu writes)', () => {
    expect(sessionThinkingKey({ codexSessionKey: '18014', codexRolloutId: 'uuid' }))
      .toMatchObject({ kind: 'codex-session-key' });
  });

  it('is total: any populated param set yields a key, never null', () => {
    const params = ['sessionId', 'codexSessionKey', 'codexRolloutId', 'ompThreadId'] as const;
    for (const p of params) {
      expect(sessionThinkingKey({ [p]: 'x' }), `${p} alone must resolve`).not.toBeNull();
    }
  });
});
