/**
 * The extracted conversation wiring (goals-tab-improvement-2026-08-09 D-011).
 *
 * `buildSessionStreamUrl` is the reason this file exists. It carries the
 * EI-16982 archive fallback — an ended session's transcript is GC'd within ~2h
 * and the backend's rematerialize path only fires when `ended=1` is passed — and
 * that flag is invisible in every symptom: without it the transcript simply
 * comes back empty, which reads as "this agent said nothing" rather than as a
 * missing parameter. Now that a SECOND surface (the goal popup) depends on this
 * function, a silent regression here would take out both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSessionStreamUrl,
  buildOwnerHistoryPageUrl,
  fetchOwnerHistoryPage,
  deliveryFromSendResponse,
  sessionTargetFromRoster,
  resolveOwnerSession,
} from './use-owner-session-chat';

const LIVE = { source_kind: 'claude', session_id: 's-live', active: true, last_ts: null };
const ENDED = { source_kind: 'claude', session_id: 's-ended', active: false, last_ts: null };

describe('owner history without a live roster row', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('resolves Codex and OMP histories when no backend hint survives', async () => {
    for (const source_kind of ['codex', 'omp']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessions: [{ source_kind, session_id: 'native-id', last_ts: null }] }))));
      expect(await resolveOwnerSession('su-ended')).toMatchObject({ source_kind, session_id: 'native-id' });
    }
  });
  it('preserves an explicit stream key returned by owner-session resolution', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessions: [{ source_kind: 'codex', session_id: '42', stream_key: 'codexSessionKey', last_ts: null }] }))));
    expect(await resolveOwnerSession('su-ended')).toMatchObject({ stream_key: 'codexSessionKey' });
  });
});

/** Parse the query off a built url so assertions read as intent, not string-match. */
const q = (url: string | null) => new URLSearchParams((url ?? '').split('?')[1] ?? '');

describe('buildSessionStreamUrl', () => {
  it('returns null until there is both an owner and a resolved session', () => {
    // Null is the RENDERER GATE, not merely an empty value: useAgentThinkingStream
    // only skips its harness-run-log default url when streamUrl is truthy at call
    // time, so mounting the chat early opens a stream to the wrong thing.
    expect(buildSessionStreamUrl(null, LIVE)).toBeNull();
    expect(buildSessionStreamUrl('su-a', null)).toBeNull();
  });

  it('streams the resolved session for its owner', () => {
    const p = q(buildSessionStreamUrl('su-a', LIVE));
    expect(p.get('sessionId')).toBe('s-live');
    expect(p.get('owner')).toBe('su-a');
    expect(p.get('historyOwner')).toBe('su-a');
  });

  it('uses the native Codex and OMP stream keys instead of the Claude key', () => {
    const codex = { ...LIVE, source_kind: 'codex', session_id: 'rollout-1', stream_key: 'codexRolloutId' as const };
    const omp = { ...LIVE, source_kind: 'omp', session_id: 'thread-1', stream_key: 'ompThreadId' as const };
    expect(buildSessionStreamUrl('su-codex', codex)).toBe(
      '/api/adv/session/thinking?codexRolloutId=rollout-1&historyOwner=su-codex',
    );
    expect(buildSessionStreamUrl('su-omp', omp)).toBe(
      '/api/adv/session/thinking?ompThreadId=thread-1&historyOwner=su-omp',
    );
  });

  it('uses a Codex adv-row key when rollout discovery has not completed yet', () => {
    const target = sessionTargetFromRoster({
      agent: 'codex',
      advSessionId: 9444,
      nativeSession: {
        backend: 'codex',
        source: 'adv_sessions',
        ownerId: 'su-codex',
        codexHome: '/tmp/codex-home',
        rolloutId: null,
        exactResumeSupported: false,
        missingReason: 'not recorded yet',
      },
    });
    expect(buildSessionStreamUrl('su-codex', target)).toBe(
      '/api/adv/session/thinking?codexSessionKey=9444&historyOwner=su-codex',
    );
  });

  it('derives exact native targets for all three supported runtimes', () => {
    expect(sessionTargetFromRoster({
      nativeSession: {
        backend: 'claude', source: 'adv_sessions', ownerId: 'su-c', sessionId: 'claude-1',
        configDir: '/tmp/c', configDirSource: 'live-process', configDirUnresolvedReason: null,
        exactResumeSupported: true, missingReason: null,
      },
    })?.stream_key).toBe('sessionId');
    expect(sessionTargetFromRoster({
      nativeSession: {
        backend: 'omp', source: 'adv_sessions', ownerId: 'su-o', ompThreadId: 'omp-1',
        agentHome: '/tmp/o', exactResumeSupported: true, missingReason: null,
      },
    })?.stream_key).toBe('ompThreadId');
  });

  it('does NOT set ended=1 for a live session', () => {
    expect(q(buildSessionStreamUrl('su-a', LIVE)).get('ended')).toBeNull();
  });

  it('sets ended=1 for an ended session — the EI-16982 archive fallback', () => {
    expect(q(buildSessionStreamUrl('su-a', ENDED)).get('ended')).toBe('1');
  });

  it('sets ended=1 when a deep-link targets an EARLIER session, even though the resolved one is live', () => {
    /* The subtle case, and the one a naive `resolved.active` check gets wrong:
       `resolved` describes the LATEST session and says active:true, but the link
       points at an earlier rung of the respawn chain, which is by definition
       ended. Reading liveness off the wrong subject loses the fallback exactly
       when it is needed. */
    const p = q(buildSessionStreamUrl('su-a', LIVE, { focusSessionId: 's-older' }));
    expect(p.get('sessionId')).toBe('s-older');
    expect(p.get('ended')).toBe('1');
    expect(p.get('historyOwner')).toBeNull();
  });

  /* popup-agent-state-coverage-2026-08-18 P-012 — the THIRD route to the same
     fallback, and the one the roster path could not otherwise reach. */
  it('sets ended=1 when the ROSTER says the transcript does not resolve, even on a session it calls live', () => {
    /* This is the case `resolved.active` structurally cannot cover on the roster
       path: `sessionTargetFromRoster` stamps `active: true` for every claude
       native handle, so a session whose on-disk transcript was rotated away
       looks live here and never requested the archive fallback — the empty
       inspector of WI-2680. The roster already probed it; carry that verdict. */
    const p = q(buildSessionStreamUrl('su-a', LIVE, {}, { thinkingResolvable: false }));
    expect(p.get('sessionId')).toBe('s-live');
    expect(p.get('ended')).toBe('1');
  });

  it('leaves ended alone when the roster says the transcript RESOLVES, or says nothing', () => {
    // Absent must not act: an older operator's payload carries no flag, and
    // reading that as "unresolvable" would send every live session to the
    // archive path.
    expect(q(buildSessionStreamUrl('su-a', LIVE, {}, { thinkingResolvable: true })).get('ended')).toBeNull();
    expect(q(buildSessionStreamUrl('su-a', LIVE, {}, {})).get('ended')).toBeNull();
  });

  it('omits the search params entirely when there is no deep-link', () => {
    // Their absence is what leaves an ordinary open on the tail backfill.
    const p = q(buildSessionStreamUrl('su-a', LIVE));
    expect(p.get('find')).toBeNull();
    expect(p.get('anchorTs')).toBeNull();
  });

  it('passes the search deep-link through when there IS one', () => {
    const p = q(buildSessionStreamUrl('su-a', LIVE, { focusTerm: 'red gate', focusAnchorTs: '2026-08-09T00:00:00Z' }));
    expect(p.get('find')).toBe('red gate');
    expect(p.get('anchorTs')).toBe('2026-08-09T00:00:00Z');
  });
});

describe('owner history page loading', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds a same-route JSON page URL only from an owner-scoped stream', () => {
    expect(buildOwnerHistoryPageUrl(
      '/api/adv/session/thinking?codexRolloutId=current&historyOwner=su-a',
      'opaque cursor',
    )).toBe('/api/adv/session/thinking?historyPage=1&historyOwner=su-a&historyCursor=opaque+cursor');
    expect(buildOwnerHistoryPageUrl('/api/adv/session/thinking?codexRolloutId=current', 'cursor')).toBeNull();
    expect(buildOwnerHistoryPageUrl('/api/adv/session/thinking?historyOwner=su-a', null)).toBeNull();
  });

  it('fetches and validates an older timeline page', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [{ kind: 'prompt', text: 'prior epoch' }],
      hasMore: false,
      cursor: null,
    })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOwnerHistoryPage(
      '/api/adv/session/thinking?sessionId=current&historyOwner=su-a',
      'page-2',
    )).resolves.toEqual({
      entries: [{ kind: 'prompt', text: 'prior epoch' }],
      hasMore: false,
      cursor: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/adv/session/thinking?historyPage=1&historyOwner=su-a&historyCursor=page-2',
      { headers: { accept: 'application/json' } },
    );
  });
});

describe('deliveryFromSendResponse', () => {
  /* P-002: the point of this function is that it never over-claims. "Sent — the
     agent is woken if it's live" was false in two routine states, and both
     reported as unqualified success. */
  it('reports a real wake as woken, with the count', () => {
    expect(deliveryFromSendResponse({ results: [{ wake: { woken: 2 } }] })).toEqual({ kind: 'woken', count: 2 });
  });

  it('reports a MANUAL-mode staged wake as staged, never as woken', () => {
    expect(deliveryFromSendResponse({ results: [{ wake: { staged: true } }] })).toEqual({ kind: 'staged' });
    expect(deliveryFromSendResponse({ results: [{ staged: true }] })).toEqual({ kind: 'staged' });
  });

  it('reports an absent recipient rather than claiming delivery', () => {
    expect(deliveryFromSendResponse({ results: [{ recipient_absent: true }] })).toEqual({ kind: 'absent' });
  });

  it('degrades to queued — the weakest honest claim — when nothing characterises it', () => {
    expect(deliveryFromSendResponse({ results: [{}] })).toEqual({ kind: 'queued' });
    expect(deliveryFromSendResponse({})).toEqual({ kind: 'queued' });
    expect(deliveryFromSendResponse(null)).toEqual({ kind: 'queued' });
  });

  it('does not read woken:0 as a wake', () => {
    // The regression this guards: `if (wake.woken)` would be falsy here and fall
    // through correctly, but `typeof === 'number'` alone would not — 0 woken is
    // precisely the "reached nobody" case that must NOT read as success.
    expect(deliveryFromSendResponse({ results: [{ wake: { woken: 0 } }] })).toEqual({ kind: 'queued' });
  });
});
