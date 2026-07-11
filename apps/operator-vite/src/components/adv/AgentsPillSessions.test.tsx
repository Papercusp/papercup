// @vitest-environment jsdom
/**
 * AgentsPillSessions — pure URL/sanitize/paging helpers behind the agents-pill
 * session search + inactive-sessions expander (agents-pill-inactive-search-
 * 2026-07-09 P-003/P-004/P-006). The heavy neighbors are mocked exactly like
 * AgentsRunningPill.test.tsx so importing the module stays cheap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [{ active: [] }] }) }));
vi.mock('@/app/coord/presence-ui', () => ({ LivenessDot: () => null }));
vi.mock('@/app/harness/AgentInspectorModal', () => ({ default: () => null }));
vi.mock('@/app/harness/AgentThinkingStream', () => ({ ThinkingDot: () => null }));

import {
  appendEndedPage,
  endedDisplayName,
  endedSessionStreamUrl,
  headlineToSafeHtml,
  searchFailureMessage,
  searchHitStreamUrl,
  searchResultResumeTarget,
  InactiveSessionsSection,
  type EndedSessionRow,
} from './AgentsPillSessions';
import type { RosterAgent } from './AgentsRunningPill';

const rosterAgent = (over: Record<string, unknown>) => over as unknown as RosterAgent;

function endedRow(over: Partial<EndedSessionRow> = {}): EndedSessionRow {
  return {
    id: 1,
    planSlug: null,
    agent: null,
    role: null,
    feature: null,
    label: null,
    coordOwnerId: null,
    sessionId: null,
    ompThreadId: null,
    startedAt: '2026-07-09T00:00:00Z',
    endedAt: '2026-07-09T01:00:00Z',
    exitCode: 0,
    ...over,
  };
}

describe('searchHitStreamUrl', () => {
  const base = { active: null, session: null };

  it('claude: session uuid + owner from the hit, find + anchorTs appended', () => {
    const url = searchHitStreamUrl(
      { ...base, sourceKind: 'claude', sessionId: 'sid-1' },
      { ts: '2026-07-09T12:00:00Z', owner: 'su-abc' },
      'red gate',
    );
    // base = inactive (active:null) ⇒ ended=1 appended (WI-3990).
    expect(url).toBe(
      '/api/adv/session/thinking?sessionId=sid-1&owner=su-abc&find=red%20gate&anchorTs=2026-07-09T12%3A00%3A00Z&ended=1',
    );
  });

  it('claude: owner falls back active.ownerId → session.coordOwnerId → omitted', () => {
    const s = { sourceKind: 'claude', sessionId: 'sid-1' };
    // ACTIVE result (a live roster agent) → transcript is live on disk, NO ended flag.
    expect(
      searchHitStreamUrl({ ...s, active: rosterAgent({ ownerId: 'su-live' }), session: null }, { ts: null, owner: null }, 'q!'),
    ).toBe('/api/adv/session/thinking?sessionId=sid-1&owner=su-live&find=q!');
    // INACTIVE result (ended session) → ended=1 so the route rematerializes / terminates.
    expect(
      searchHitStreamUrl({ ...s, active: null, session: endedRow({ coordOwnerId: 'su-dead' }) }, { ts: null, owner: null }, 'q!'),
    ).toBe('/api/adv/session/thinking?sessionId=sid-1&owner=su-dead&find=q!&ended=1');
    expect(searchHitStreamUrl({ ...s, ...base }, { ts: null, owner: null }, 'q!')).toBe(
      '/api/adv/session/thinking?sessionId=sid-1&find=q!&ended=1',
    );
  });

  it('omp keys by thread id; codex by rollout uuid (inactive ⇒ ended=1)', () => {
    expect(searchHitStreamUrl({ ...base, sourceKind: 'omp', sessionId: 'tid-9' }, { ts: null, owner: null }, 'x')).toBe(
      '/api/adv/session/thinking?ompThreadId=tid-9&find=x&ended=1',
    );
    expect(searchHitStreamUrl({ ...base, sourceKind: 'codex', sessionId: 'uuid-7' }, { ts: null, owner: null }, 'x')).toBe(
      '/api/adv/session/thinking?codexRolloutId=uuid-7&find=x&ended=1',
    );
  });

  it('agent_chat (and anything unknown) has no transcript viewer ⇒ null', () => {
    expect(searchHitStreamUrl({ ...base, sourceKind: 'agent_chat', sessionId: 'c1' }, { ts: null, owner: null }, 'x')).toBeNull();
  });
});

describe('searchResultResumeTarget (pure — Fork/Resume-button wiring, WI-3882; active+inactive 2026-07-11)', () => {
  it('active claude result → live:true, canFork:true, sessionId from the roster agent', () => {
    expect(
      searchResultResumeTarget({ active: rosterAgent({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }), session: null }),
    ).toEqual({ sessionId: 'sid-1', live: true, canFork: true });
  });
  it('inactive claude result → live:false, canFork:true (Fork now offered for inactive too)', () => {
    expect(
      searchResultResumeTarget({ active: null, session: endedRow({ agent: 'claude', sessionId: 'sid-2' }) }),
    ).toEqual({ sessionId: 'sid-2', live: false, canFork: true });
  });
  it('inactive omp result → live:false, canFork:false (Resume ok, no Fork — omp has no --fork-session)', () => {
    expect(
      searchResultResumeTarget({ active: null, session: endedRow({ agent: 'omp', ompThreadId: 'thread-1' }) }),
    ).toEqual({ sessionId: 'thread-1', live: false, canFork: false });
  });
  it('codex (active or inactive) → null, never a dead resume/fork button', () => {
    expect(
      searchResultResumeTarget({ active: rosterAgent({ agent: 'codex', sessionId: 'sid-1', ompThreadId: null }), session: null }),
    ).toBeNull();
    expect(
      searchResultResumeTarget({ active: null, session: endedRow({ agent: 'codex', sessionId: 'sid-1' }) }),
    ).toBeNull();
  });
  it('2026-07-11: active omp result → Resume offered (live:true, canFork:false), NOT null anymore', () => {
    // Retracted the WI-4009 "active omp → null" rule: a live omp session now gets
    // a Resume button (no Fork, since --fork-session is claude-only). live:true
    // tags the Resume collision-warning tooltip.
    expect(
      searchResultResumeTarget({ active: rosterAgent({ agent: 'omp', sessionId: null, ompThreadId: 'thread-1' }), session: null }),
    ).toEqual({ sessionId: 'thread-1', live: true, canFork: false });
  });
  it('neither active nor session → null', () => {
    expect(searchResultResumeTarget({ active: null, session: null })).toBeNull();
  });
});

describe('endedSessionStreamUrl', () => {
  it('claude leg: sessionId (+ owner isolation hint when recorded), always ended=1', () => {
    // Every ended-session URL carries ended=1 (WI-3990) — the session has ENDED,
    // so the thinking route must rematerialize an archived transcript or terminate,
    // never poll forever for a "first turn" that will never come.
    expect(endedSessionStreamUrl(endedRow({ sessionId: 's1', coordOwnerId: 'su-a' }))).toBe(
      '/api/adv/session/thinking?sessionId=s1&owner=su-a&ended=1',
    );
    expect(endedSessionStreamUrl(endedRow({ sessionId: 's1' }))).toBe('/api/adv/session/thinking?sessionId=s1&ended=1');
  });

  it('omp + codex legs (ended=1), and null when no handle was recorded', () => {
    expect(endedSessionStreamUrl(endedRow({ ompThreadId: 't1' }))).toBe('/api/adv/session/thinking?ompThreadId=t1&ended=1');
    expect(endedSessionStreamUrl(endedRow({ id: 42, agent: 'codex' }))).toBe(
      '/api/adv/session/thinking?codexSessionKey=42&ended=1',
    );
    expect(endedSessionStreamUrl(endedRow({ agent: 'claude' }))).toBeNull();
  });
});

describe('headlineToSafeHtml', () => {
  it('escapes transcript HTML but restores the engine <mark> tags', () => {
    expect(headlineToSafeHtml('run <mark>deploy</mark> & <script>alert(1)</script>')).toBe(
      'run <mark>deploy</mark> &amp; &lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('does not let a transcript smuggle a fake mark attribute through', () => {
    // Only the engine's bare `<mark>` survives; `<mark onx=...>` stays escaped.
    expect(headlineToSafeHtml('<mark onmouseover=alert(1)>x</mark>')).toBe(
      '&lt;mark onmouseover=alert(1)&gt;x</mark>',
    );
  });
});

describe('endedDisplayName', () => {
  it('label → short owner id → agent #id', () => {
    expect(endedDisplayName(endedRow({ label: ' builder-3 ', coordOwnerId: 'su-x' }))).toBe('builder-3');
    expect(endedDisplayName(endedRow({ coordOwnerId: 'su-ba914b41-b03b-4fdd' }))).toBe('su-ba914b41');
    expect(endedDisplayName(endedRow({ id: 12, agent: 'omp' }))).toBe('omp #12');
    expect(endedDisplayName(endedRow({ id: 12 }))).toBe('session #12');
  });
});

describe('appendEndedPage', () => {
  it('appends in order and drops ids already present (keyset shifted by a fresh ender)', () => {
    const prev = [endedRow({ id: 1 }), endedRow({ id: 2 })];
    const next = appendEndedPage(prev, [endedRow({ id: 2 }), endedRow({ id: 3 })]);
    expect(next.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(appendEndedPage([], [])).toEqual([]);
  });
});

describe('searchFailureMessage', () => {
  it('a route timeout (408 watchdog / timeout error code / gateway 503-504) names the busy server + invites retry', () => {
    expect(searchFailureMessage(408)).toMatch(/timed out.*busy.*Try again/i);
    expect(searchFailureMessage(503)).toMatch(/timed out/i);
    expect(searchFailureMessage(504)).toMatch(/timed out/i);
    // Route-stack timeout body: { error: 'timeout' } — the status may have been
    // consumed by the time the body is parsed, so the code alone must classify.
    expect(searchFailureMessage(200, 'timeout')).toMatch(/timed out/i);
  });

  it('anything else stays the generic failure (403 loopback, 500 handler_error, network throw)', () => {
    expect(searchFailureMessage(403, 'loopback_only')).toBe('Search failed.');
    expect(searchFailureMessage(500, 'handler_error')).toBe('Search failed.');
    expect(searchFailureMessage(null)).toBe('Search failed.');
  });
});

describe('InactiveSessionsSection row layout (WI-4195 r3 — name not truncated to one letter)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('gives each inactive-session row the --nocheck grid modifier (no leading checkbox column)', async () => {
    // jsdom has no IntersectionObserver; the section wires one for infinite scroll.
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        sessions: [endedRow({ id: 7, sessionId: 's-7', coordOwnerId: 'su-abcdef', label: 'a real session name', agent: 'claude' })],
        hasMore: false,
        nextBefore: null,
      }),
    })));

    render(<InactiveSessionsSection activeOwnerIds={new Set()} nowMs={Date.parse('2026-07-09T02:00:00Z')} />);
    fireEvent.click(screen.getByTestId('inactive-sessions-toggle'));

    const row = await waitFor(() => screen.getByTestId('inactive-session-7'));
    // The roster row's 5-col grid reserves col 1 for the checkbox; a checkbox-less
    // row MUST drop it via --nocheck or the name lands in the 16px glyph column
    // and truncates to one letter (the reported bug).
    expect(row.className).toContain('pc-agents-roster__row');
    expect(row.className).toContain('pc-agents-roster__row--nocheck');
    // The full name renders (its own CSS ellipsizes past 200px; it is not clipped to a letter here).
    expect(row.textContent).toContain('a real session name');
  });
});
