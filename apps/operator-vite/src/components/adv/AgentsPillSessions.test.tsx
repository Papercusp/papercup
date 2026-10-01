// @vitest-environment jsdom
/**
 * AgentsPillSessions — pure URL/sanitize/paging helpers behind the agents-pill
 * session search + inactive-sessions expander (agents-pill-inactive-search-
 * 2026-07-09 P-003/P-004/P-006). The heavy neighbors are mocked exactly like
 * AgentsRunningPill.test.tsx so importing the module stays cheap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
import { lexiconFor } from '@papercusp/lexicon';
import {
  appendEndedPage,
  endedDisplayName,
  endedSessionStreamUrl,
  hitMatchLabel,
  idMatchLabel,
  idMatchStreamUrl,
  searchFailureMessage,
  searchHitStreamUrl,
  searchResultFocusTarget,
  searchResultResumeTarget,
  InactiveSessionsSection,
  SessionSearchResults,
  type EndedSessionRow,
  type SearchSessionResult,
} from './AgentsPillSessions';
import type { RosterAgent } from './AgentsRunningPill';

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: [{ active: [] }] }),
  onSyncBusEvent: () => () => {},
}));
vi.mock('@/app/coord/presence-ui', () => ({ LivenessDot: () => null }));
// Records the props the inspector was opened with, so the WI-6816 wiring test
// below can assert what the SEARCH results actually hand it (renders nothing,
// exactly as before — every other test in this file is unaffected).
const inspectorProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
// Reset through a helper, not a bare `inspectorProps.last = null` in the test
// body: an assignment TypeScript can see narrows the property to `null` for the
// rest of that flow, so the later `inspectorProps.last?.focusTarget` reads
// resolve against `never` and fail the operator-vite typecheck ratchet.
function resetInspectorProps() {
  inspectorProps.last = null;
}
vi.mock('@/app/harness/AgentInspectorModal', () => ({
  default: (props: Record<string, unknown>) => {
    inspectorProps.last = props;
    return null;
  },
}));
vi.mock('@/app/harness/AgentThinkingStream', () => ({ ThinkingDot: () => null }));
// SessionSearchResults (WI-4734 tests below) AND InactiveSessionsSection's
// expand toggle (WI-3881) are URL-backed via nuqs; the suite runs without a
// NuqsAdapter. Unlike AgentsRunningPill.test.tsx's single-value stub, this
// file exercises MULTIPLE independent nuqs keys at once (agentsWindow,
// agentsFacets, agentsInactiveOpen) in the same render tree, so it needs a
// real per-key keyed store — a stub that ignores `key` and returns one
// shared value would make those three collapse into each other. Unlike a
// bare `[value, setter]` stub, this ALSO needs to be reactive: clicking the
// "View inactive sessions" toggle must cause the section to actually
// re-render expanded, the same way real nuqs (backed by useSyncExternalStore
// internally) does — so this uses useSyncExternalStore itself rather than a
// plain closure variable a setter mutates silently. The store is reset in
// the top-level afterEach below so a test that expands the section doesn't
// leak that into the next (unlike real nuqs, which the URL would
// legitimately carry forward — but each `it()` here should start clean).
const nuqsStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
}));
function notifyNuqsStore() {
  for (const listener of nuqsStore.listeners) listener();
}
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { defaultValue?: unknown }) => {
    if (!(key in nuqsStore.state)) nuqsStore.state[key] = parser?.defaultValue ?? null;
    const value = useSyncExternalStore(
      (onStoreChange: () => void) => {
        nuqsStore.listeners.add(onStoreChange);
        return () => nuqsStore.listeners.delete(onStoreChange);
      },
      () => nuqsStore.state[key],
    );
    const setValue = (v: unknown) => {
      nuqsStore.state[key] = typeof v === 'function'
        ? (v as (prev: unknown) => unknown)(nuqsStore.state[key])
        : v;
      notifyNuqsStore();
      return Promise.resolve(true);
    };
    return [value, setValue];
  },
}));

afterEach(() => {
  for (const key of Object.keys(nuqsStore.state)) delete nuqsStore.state[key];
  nuqsStore.listeners.clear();
});

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

describe('searchHitStreamUrl — focusTerm anchor (P-004 exact/fuzzy tiers)', () => {
  const base = { active: null, session: null, sourceKind: 'claude', sessionId: 'sid-1' };

  it('anchors `find` on the literal the turn actually contains, not the typed (typo) query', () => {
    const url = searchHitStreamUrl(base, { ts: null, owner: null, focusTerm: 'furnishedfinder' }, 'furnisedfinder');
    expect(url).toContain('&find=furnishedfinder');
    expect(url).not.toContain('furnisedfinder');
  });

  it('falls back to the typed query when the hit carries no focusTerm (hybrid-only hit / older server)', () => {
    expect(searchHitStreamUrl(base, { ts: null, owner: null }, 'red gate')).toContain('&find=red%20gate');
    expect(searchHitStreamUrl(base, { ts: null, owner: null, focusTerm: '' }, 'red gate')).toContain('&find=red%20gate');
  });
});

describe('hitMatchLabel — fuzzy tier chip (P-004)', () => {
  it('a fuzzy hit says it is an approximate spelling match and names what the turn actually says', () => {
    const l = hitMatchLabel({
      matchedBy: 'unknown',
      tier: 'fuzzy',
      fuzzy: { token: 'furnisedfinder', word: 'furnishedfinder', similarity: 0.62 },
      highlight: 'visit <mark>furnishedfinder</mark>',
      excerpt: 'x',
    });
    expect(l?.label).toBe('fuzzy match');
    expect(l?.unhighlighted).toBe(false);
    expect(l?.title).toContain('furnisedfinder');
    expect(l?.title).toContain('furnishedfinder');
    expect(l?.title).toContain('0.62');
  });

  it('a fuzzy hit still gets the chip with no fuzzy block (older/partial payload), and an exact hit with a <mark> gets none', () => {
    expect(hitMatchLabel({ tier: 'fuzzy', highlight: '<mark>a</mark>', excerpt: 'x' })?.label).toBe('fuzzy match');
    // exact-tier hit: its <mark> IS the typed text — no chip, same as a highlighted lexical hit.
    expect(hitMatchLabel({ matchedBy: 'unknown', tier: 'exact', highlight: '<mark>a</mark>', excerpt: 'x' })).toBeNull();
  });
});

describe('searchResultResumeTarget (pure — Fork/Resume-button wiring, WI-3882; active+inactive 2026-07-11)', () => {
  it('active claude result → live:true, canFork:true, sessionId from the roster agent', () => {
    expect(
      searchResultResumeTarget({
        active: rosterAgent({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null, ownerId: 'su-live-1' }),
        session: null,
      }),
      // resume-in-gui-button-2026-08-09: an ACTIVE result's identity comes from the
      // LIVE roster row, which is also the row the HUD conversation popup resolves.
    ).toEqual({ sessionId: 'sid-1', live: true, canFork: true, guiOwnerId: 'su-live-1' });
  });
  it('inactive claude result → live:false, canFork:true (Fork now offered for inactive too)', () => {
    expect(
      searchResultResumeTarget({ active: null, session: endedRow({ agent: 'claude', sessionId: 'sid-2', coordOwnerId: 'su-ended-2' }) }),
      // …and an INACTIVE result's comes from the ended adv row. Never both: an
      // active result's ended rows are older terminals of the same agent.
    ).toEqual({ sessionId: 'sid-2', live: false, canFork: true, guiOwnerId: 'su-ended-2' });
  });
  it('inactive omp result → live:false, canFork:false (Resume ok, no Fork — omp has no --fork-session)', () => {
    expect(
      searchResultResumeTarget({ active: null, session: endedRow({ agent: 'omp', ompThreadId: 'thread-1' }) }),
      // guiOwnerId null here because the fixture carries none — and canFork:false
      // would suppress the GUI button anyway (omp resumes never route through psu).
    ).toEqual({ sessionId: 'thread-1', live: false, canFork: false, guiOwnerId: null });
  });
  // resume-in-gui-button-2026-08-09: a resumable session whose row simply has no
  // coord owner id must report null rather than undefined-by-omission — the modal
  // gates the GUI button on this value, and "no id" has to be an explicit answer.
  it('resumable session with no coord owner id → guiOwnerId:null (no GUI destination)', () => {
    expect(
      searchResultResumeTarget({ active: null, session: endedRow({ agent: 'claude', sessionId: 'sid-3' }) }),
    ).toEqual({ sessionId: 'sid-3', live: false, canFork: true, guiOwnerId: null });
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
      searchResultResumeTarget({ active: rosterAgent({ agent: 'omp', sessionId: null, ompThreadId: 'thread-1', ownerId: 'su-omp' }), session: null }),
    ).toEqual({ sessionId: 'thread-1', live: true, canFork: false, guiOwnerId: 'su-omp' });
  });
  it('neither active nor session → null', () => {
    expect(searchResultResumeTarget({ active: null, session: null })).toBeNull();
  });
});

describe('searchResultFocusTarget (pure — "Focus window" button wiring, WI-6816)', () => {
  // Owner-reported 2026-08-02: opening a session from the agents-pill SEARCH
  // results lost the "⤢ Focus window" button the ROSTER path has shown since
  // 2026-07-01 — this search view (2026-07-09) never threaded `focusTarget`
  // through to AgentInspectorModal. These lock the restored wiring.
  it('active result with an advSessionId ONLY → focusable (the real-world case: 86/135 live agents had an advSessionId and ZERO a windowId)', () => {
    expect(
      searchResultFocusTarget({ active: rosterAgent({ advSessionId: 14232, windowId: null, pid: 1624051 }) }),
    ).toEqual({ advSessionId: 14232, windowId: null, pid: 1624051 });
  });
  it('active result with a windowId ONLY → focusable', () => {
    expect(
      searchResultFocusTarget({ active: rosterAgent({ advSessionId: null, windowId: '0x1234', pid: null }) }),
    ).toEqual({ advSessionId: null, windowId: '0x1234', pid: null });
  });
  it('active result with a pid but NEITHER handle → null (every gnome-terminal shares one server pid, so a pid cannot be matched back to a window)', () => {
    expect(searchResultFocusTarget({ active: rosterAgent({ advSessionId: null, windowId: null, pid: 3711110 }) })).toBeNull();
  });
  it('missing handles entirely → null, never a dead button', () => {
    expect(searchResultFocusTarget({ active: rosterAgent({}) })).toBeNull();
  });
  it('INACTIVE result → null even when the ended row has an adv id: the window is gone, so focus would be dead', () => {
    expect(searchResultFocusTarget({ active: null })).toBeNull();
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
    // WI-41496: the omp leg carries the adv row id as `ompSessionKey`. The
    // thread id names the transcript FILE; the adv id names the per-session
    // HOME (`su-omp-homes/session-<id>/agent/sessions`) it lives in, and a
    // psu-launched omp agent never writes to the shared ~/.omp home the route
    // otherwise searches — so without it this URL opened an empty pane.
    expect(endedSessionStreamUrl(endedRow({ id: 7, ompThreadId: 't1' }))).toBe(
      '/api/adv/session/thinking?ompThreadId=t1&ompSessionKey=7&ended=1',
    );
    expect(endedSessionStreamUrl(endedRow({ id: 42, agent: 'codex' }))).toBe(
      '/api/adv/session/thinking?codexSessionKey=42&ended=1',
    );
    expect(endedSessionStreamUrl(endedRow({ agent: 'claude' }))).toBeNull();
  });
});

// `headlineToSafeHtml` moved to `apps/operator/lib/search-highlight.ts` so the
// two operator-tree search surfaces can share ONE escaper with this one
// (security-boundary-remediation-and-usability-2026-09-04 P-003). Its unit
// tests moved with it, to `apps/operator/lib/search-highlight.test.ts`.

describe('endedDisplayName', () => {
  it('label → short owner id → agent #id', () => {
    expect(endedDisplayName(endedRow({ label: ' builder-3 ', coordOwnerId: 'su-x' }))).toBe('builder-3');
    expect(endedDisplayName(endedRow({ coordOwnerId: 'su-ba914b41-b03b-4fdd' }))).toBe('su-ba914b41');
    expect(endedDisplayName(endedRow({ id: 12, agent: 'omp' }))).toBe('omp #12');
    expect(endedDisplayName(endedRow({ id: 12 }))).toBe('session #12');
  });

  it('normalizes generated legacy labels for display', () => {
    expect(endedDisplayName(
      endedRow({ label: 'overwatch · papercusp/kettle' }),
      lexiconFor('classic'),
    )).toBe('Kettle · papercusp/Kettle');
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

  it('shows an active-roster-style count on the header once expanded (owner ask 2026-07-12 — mirror the active section)', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        sessions: [
          endedRow({ id: 7, sessionId: 's-7', coordOwnerId: 'su-abcdef', label: 'session seven', agent: 'claude' }),
          endedRow({ id: 8, sessionId: 's-8', coordOwnerId: 'su-bbbbbb', label: 'session eight', agent: 'claude' }),
        ],
        hasMore: true,
        nextBefore: 'cur',
      }),
    })));

    render(<InactiveSessionsSection activeOwnerIds={new Set()} nowMs={Date.parse('2026-07-09T02:00:00Z')} />);
    // Collapsed: no count yet.
    expect(screen.queryByTestId('inactive-sessions-count')).toBeNull();
    fireEvent.click(screen.getByTestId('inactive-sessions-toggle'));

    // Expanded + loaded: the count chip mirrors the active fleet-group counts,
    // and the trailing '+' reflects hasMore (more pages beyond the loaded set).
    const count = await waitFor(() => screen.getByTestId('inactive-sessions-count'));
    expect(count.textContent).toContain('(2+)');
    // It reuses the active roster's group-count class so it looks identical.
    expect(count.className).toContain('pc-agents-roster__group-count');
  });
});

describe('InactiveSessionsSection expand persistence across a remount (WI-3881)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('stays expanded after the section is unmounted and remounted (mirrors AgentsRunningPill returning null mid live-roster-refresh)', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, sessions: [], hasMore: false, nextBefore: null }),
    })));

    const { unmount } = render(
      <InactiveSessionsSection activeOwnerIds={new Set()} nowMs={Date.parse('2026-07-09T02:00:00Z')} />,
    );
    expect(screen.getByTestId('inactive-sessions-toggle').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('inactive-sessions-toggle'));
    expect(screen.getByTestId('inactive-sessions-toggle').getAttribute('aria-expanded')).toBe('true');

    // Simulate the parent (AgentsRunningPill) unmounting the WHOLE subtree —
    // e.g. `running.length === 0` transiently during a live-roster sync
    // invalidation — and then remounting it once fresh data arrives. A plain
    // `useState` would reset `expanded` to false here; the nuqs-backed value
    // must not, because it lives in the URL, not this component instance.
    unmount();
    render(<InactiveSessionsSection activeOwnerIds={new Set()} nowMs={Date.parse('2026-07-09T02:00:01Z')} />);

    expect(screen.getByTestId('inactive-sessions-toggle').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('SessionSearchResults in-flight honesty (WI-4734 — owner-hit: a 20s search with no visible progress)', () => {
  const NOW = Date.parse('2026-07-13T12:00:00Z');

  function searchResult(over: Partial<SearchSessionResult> & { sessionId: string }): SearchSessionResult {
    return {
      sourceKind: 'claude',
      topScore: 1,
      hits: [],
      active: null,
      session: null,
      ...over,
    } as SearchSessionResult;
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the pending indicator IMMEDIATELY on render — before the debounce ever fires', () => {
    // A never-settling fetch: if the indicator only appeared when the fetch
    // fired (the old behavior: setLoading inside the debounce timer), this
    // synchronous assertion — zero timers elapsed — would fail.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<SessionSearchResults query="improvements" nowMs={NOW} />);
    expect(screen.getByTestId('search-pending').textContent).toContain('Searching…');
  });

  it('escalates the message after ~5s so a slow search is visibly alive', () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<SessionSearchResults query="improvements" nowMs={NOW} />);
    expect(screen.getByTestId('search-pending').textContent).toContain('Searching…');
    act(() => {
      vi.advanceTimersByTime(5_200); // debounce (200ms) is inside this window too
    });
    expect(screen.getByTestId('search-pending').textContent).toContain('Still searching');
  });

  it('keeps previous-query results visible but DIMMED (is-stale) while the next search runs', async () => {
    // First query resolves with one inactive-session result…
    const first = {
      ok: true,
      json: async () => ({ ok: true, sessions: [searchResult({ sessionId: 'sess-11112222' })] }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(first)
      // …the SECOND query (new keystroke) never settles.
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<SessionSearchResults query="improvements" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    const section = screen.getByText(/Inactive sessions/).closest('section');
    expect(section?.className).not.toContain('is-stale');

    rerender(<SessionSearchResults query="improvements now" nowMs={NOW} />);
    // Pending is back instantly AND the old results are visibly stale.
    expect(screen.getByTestId('search-pending')).toBeTruthy();
    expect(screen.getByText(/Inactive sessions/).closest('section')?.className).toContain('is-stale');
  });

  it('clears pending + stale dim once the search settles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, sessions: [searchResult({ sessionId: 'sess-33334444' })] }),
    })));
    render(<SessionSearchResults query="improvements" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    expect(screen.getByText(/Inactive sessions/).closest('section')?.className).not.toContain('is-stale');
  });

  // ── WI-6816: opening a session from SEARCH must hand the inspector the same
  // focusTarget the ROSTER path does, or the "⤢ Focus window" button cannot
  // render (owner-reported 2026-08-02). The pure-helper tests above cover the
  // predicate; these cover the WIRING — the regression was never a wrong
  // predicate, it was the prop simply not being passed. ─────────────────────
  const liveHit = { turnIdx: 0, ts: '2026-07-13T11:00:00Z', owner: 'su-live', excerpt: 'x', highlight: 'x', score: 1 };

  function respondWith(sessions: SearchSessionResult[]) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, sessions }) })));
  }

  it('clicking a LIVE match passes focusTarget to the inspector — the button can render', async () => {
    resetInspectorProps();
    respondWith([
      searchResult({
        sessionId: 'sid-live',
        hits: [liveHit],
        active: rosterAgent({
          ownerId: 'su-live',
          label: 'su · su-live',
          agent: 'claude',
          sessionId: 'sid-live',
          // The real-world shape: an advSessionId and NO pre-resolved windowId.
          advSessionId: 14232,
          windowId: null,
          pid: 1624051,
          intent: 'draining bugs',
        }),
      }),
    ]);
    render(<SessionSearchResults query="improvements" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    fireEvent.click(screen.getByTestId('hit-sid-live-0'));
    await waitFor(() => expect(inspectorProps.last).not.toBeNull());
    expect(inspectorProps.last?.focusTarget).toEqual({ advSessionId: 14232, windowId: null, pid: 1624051 });
  });

  it('clicking an ENDED match passes NO focusTarget — its window is gone, so no dead button', async () => {
    resetInspectorProps();
    respondWith([searchResult({ sessionId: 'sid-ended', hits: [liveHit], session: endedRow({ id: 77, agent: 'claude', sessionId: 'sid-ended' }) })]);
    render(<SessionSearchResults query="improvements" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    fireEvent.click(screen.getByTestId('hit-sid-ended-0'));
    await waitFor(() => expect(inspectorProps.last).not.toBeNull());
    expect(inspectorProps.last?.focusTarget).toBeUndefined();
    // …but Resume/Fork still wire up, so this is a focus-specific absence and
    // not "the inspector got nothing". resume-in-gui-button-2026-08-09 added
    // guiOwnerId — null here because this ended fixture carries no coordOwnerId,
    // which is exactly what suppresses the GUI button for a row with no identity.
    expect(inspectorProps.last?.resumeTarget).toEqual({ sessionId: 'sid-ended', live: false, canFork: true, guiOwnerId: null });
  });

  it('clicking a LIVE match with neither handle passes NO focusTarget (pid alone is not focusable)', async () => {
    resetInspectorProps();
    respondWith([
      searchResult({
        sessionId: 'sid-nowin',
        hits: [liveHit],
        active: rosterAgent({
          ownerId: 'su-nowin',
          label: 'su · su-nowin',
          agent: 'claude',
          sessionId: 'sid-nowin',
          advSessionId: null,
          windowId: null,
          pid: 3711110,
          intent: 'presence-only process',
        }),
      }),
    ]);
    render(<SessionSearchResults query="improvements" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    fireEvent.click(screen.getByTestId('hit-sid-nowin-0'));
    await waitFor(() => expect(inspectorProps.last).not.toBeNull());
    expect(inspectorProps.last?.focusTarget).toBeUndefined();
  });
});

// ── P-004 (semantic-search-fingerprint-coverage-2026-08-03): match labelling.
//
// Two INDEPENDENT things the rendered text cannot tell you: which leg
// retrieved the row, and whether what is shown is actually the match.
//
// ⚠ These come apart, MEASURED on the live corpus 2026-08-03 ("why did the
// gate go red", 30 hits): 9 of 10 vector-only hits DID carry <mark>, and 2 of
// 20 lexical hits carried none. ts_headline runs over the document against the
// tsquery regardless of which ranker returned the row. An earlier cut of this
// inferred one condition from the other and was wrong; these tests pin the
// four-case behaviour so it cannot regress back to the intuition. ───────────
const marked = 'a <mark>gate</mark> went red';
const unmarked = 'the turn opens with something unrelated';

describe('hitMatchLabel (pure)', () => {
  it('labels a vector-only hit that IS highlighted — the marks are not why it matched', () => {
    const l = hitMatchLabel({ matchedBy: 'semantic', semanticScore: 0.7412, highlight: marked, excerpt: 'x' });
    expect(l?.label).toBe('semantic match');
    expect(l?.unhighlighted).toBe(false);
    expect(l?.title).toContain('cosine 0.74');
    // It must NOT claim the text is the turn's head — it isn't; terms are there.
    expect(l?.title).not.toContain('start of the turn');
    expect(l?.title).toContain('not why');
  });

  it('labels a vector-only hit with NO highlight, and says the text is the turn head', () => {
    const l = hitMatchLabel({ matchedBy: 'semantic', semanticScore: 0.61, highlight: unmarked, excerpt: 'x' });
    expect(l?.label).toBe('semantic match');
    expect(l?.unhighlighted).toBe(true);
    expect(l?.title).toContain('start of the turn');
  });

  it('labels a LEXICAL hit that came back unhighlighted — the excerpt-head case P-004 names', () => {
    // No leg is claimed here: we know the text is uninformative, not that the
    // vector leg found it.
    const l = hitMatchLabel({ matchedBy: 'lexical', highlight: unmarked, excerpt: 'x' });
    expect(l?.label).toBe('no highlight');
    expect(l?.unhighlighted).toBe(true);
    expect(l?.title).not.toMatch(/semantic|meaning|MEANING/);
  });

  it('shows NOTHING for the common path — a lexical/hybrid hit with highlights', () => {
    expect(hitMatchLabel({ matchedBy: 'lexical', highlight: marked, excerpt: 'x' })).toBeNull();
    expect(hitMatchLabel({ matchedBy: 'both', highlight: marked, excerpt: 'x' })).toBeNull();
  });

  it('never claims a leg when provenance is unknown or absent (an older server)', () => {
    // Guessing "semantic" would make correct lexical results read as fallbacks.
    expect(hitMatchLabel({ matchedBy: 'unknown', highlight: marked, excerpt: 'x' })).toBeNull();
    expect(hitMatchLabel({ highlight: marked, excerpt: 'x' })).toBeNull();
    // …but an unhighlighted row is still called out, on evidence we do have.
    expect(hitMatchLabel({ highlight: unmarked, excerpt: 'x' })?.label).toBe('no highlight');
  });

  it('judges the string the row RENDERS (highlight || excerpt), not highlight alone', () => {
    // Deferred-highlight hydration can fail and leave highlight '' — the row
    // then renders the excerpt, which never carries marks.
    expect(hitMatchLabel({ matchedBy: 'lexical', highlight: '', excerpt: unmarked })?.unhighlighted).toBe(true);
    expect(hitMatchLabel({ matchedBy: 'lexical', highlight: '', excerpt: marked })).toBeNull();
  });

  it('omits the cosine — never renders NaN/undefined — when the score is absent', () => {
    const l = hitMatchLabel({ matchedBy: 'semantic', highlight: unmarked, excerpt: 'x' });
    expect(l?.title).not.toMatch(/cosine|NaN|undefined/);
  });
});

describe('SessionSearchResults renders the match label (P-004 wiring)', () => {
  const NOW = Date.parse('2026-08-03T12:00:00Z');
  const hit = (over: Partial<SearchSessionResult['hits'][number]>) => ({
    turnIdx: 0,
    ts: '2026-08-03T11:00:00Z',
    owner: 'su-x',
    excerpt: 'the turn opens with something unrelated to the query',
    highlight: 'the turn opens with something unrelated to the query',
    score: 1,
    ...over,
  });
  const result = (over: Partial<SearchSessionResult> & { sessionId: string }) =>
    ({ sourceKind: 'claude', topScore: 1, hits: [], active: null, session: null, ...over }) as SearchSessionResult;

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const respondWith = (sessions: SearchSessionResult[]) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, sessions }) })));

  it('labels a vector-only hit "semantic match" while still showing its text', async () => {
    respondWith([result({ sessionId: 'sid-sem', hits: [hit({ matchedBy: 'semantic', semanticScore: 0.61 })] })]);
    render(<SessionSearchResults query="theory of mind" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    expect(screen.getByTestId('hit-provenance').textContent).toBe('semantic match');
    // The excerpt is still shown — it is the only content there is — but the
    // row now declares what it is, and carries the verdict for styling/asserts.
    const row = screen.getByTestId('hit-sid-sem-0');
    expect(row.getAttribute('data-matched-by')).toBe('semantic');
    expect(row.textContent).toContain('the turn opens with something unrelated');
  });

  it('italicises ONLY the unhighlighted rows — a marked semantic hit is not set apart', async () => {
    respondWith([
      result({ sessionId: 'sid-a', hits: [hit({ turnIdx: 0, matchedBy: 'semantic', semanticScore: 0.74, highlight: 'a <mark>gate</mark> went red' })] }),
      result({ sessionId: 'sid-b', hits: [hit({ turnIdx: 1, matchedBy: 'semantic', semanticScore: 0.61 })] }),
    ]);
    render(<SessionSearchResults query="gate" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    // Both are semantic and both get the chip…
    expect(screen.getAllByTestId('hit-provenance')).toHaveLength(2);
    // …but only the one with nothing highlighted is set apart as a turn head.
    expect(screen.getByTestId('hit-sid-a-0').className).not.toContain('--excerpt-only');
    expect(screen.getByTestId('hit-sid-b-1').className).toContain('pc-agents-sessions__hit--excerpt-only');
  });

  it('leaves a highlighted lexical hit completely unlabelled — the common path stays quiet', async () => {
    respondWith([
      result({
        sessionId: 'sid-lex',
        hits: [hit({ matchedBy: 'lexical', lexicalScore: 0.07, highlight: 'a <mark>deploy</mark> ran' })],
      }),
    ]);
    render(<SessionSearchResults query="deploy" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    expect(screen.queryByTestId('hit-provenance')).toBeNull();
    const row = screen.getByTestId('hit-sid-lex-0');
    expect(row.className).not.toContain('--excerpt-only');
    // The <mark> survives the restructure into chip + text spans (the sanitizer
    // still runs, now on the inner span rather than the row itself).
    expect(row.querySelector('mark')?.textContent).toBe('deploy');
  });

  it('calls out an unhighlighted hit even with NO provenance field (an older server)', async () => {
    // We cannot name a leg, but "nothing here is highlighted" is still true and
    // still worth saying — it is the excerpt-head case P-004 exists for.
    respondWith([result({ sessionId: 'sid-old', hits: [hit({})] })]);
    render(<SessionSearchResults query="anything" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    expect(screen.getByTestId('hit-provenance').textContent).toBe('no highlight');
    expect(screen.getByTestId('hit-sid-old-0').getAttribute('data-matched-by')).toBeNull();
  });

  /**
   * security-boundary-remediation-and-usability-2026-09-04 P-003, under D-001.
   *
   * The escaper's own unit tests live with it in
   * `apps/operator/lib/search-highlight.test.ts`. What only a COMPONENT test can
   * catch is the wiring: that this row still routes its headline THROUGH the
   * escaper. That is the regression that actually happens — the function keeps
   * passing its unit tests while a render site quietly goes back to
   * `h.highlight`, and every unit test stays green.
   */
  it('renders transcript markup inert while keeping <mark> highlighting', async () => {
    respondWith([
      result({
        sessionId: 'sid-xss',
        hits: [
          // A marked term (must survive) beside markup (must not). `<img
          // onerror>` is the vector that matters: it fires with no <script>
          // tag, so it survives any filter that only strips <script>.
          hit({ turnIdx: 0, highlight: 'the <mark>deploy</mark> ran <img src=x onerror="alert(1)">' }),
          // highlight EMPTY → the excerpt fallback arm, which is raw document
          // head with no engine post-processing at all.
          hit({ turnIdx: 1, highlight: '', excerpt: '<script>alert(2)</script>' }),
        ],
      }),
    ]);
    render(<SessionSearchResults query="deploy" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());

    // HOSTILE PATH FAILS: neither payload became a live element.
    const marked = screen.getByTestId('hit-sid-xss-0');
    const fallback = screen.getByTestId('hit-sid-xss-1');
    expect(marked.querySelector('img')).toBeNull();
    expect(fallback.querySelector('script')).toBeNull();

    // …and both are still SHOWN, as text. Escaping must not silently eat
    // content: a transcript search that drops the markup you searched for is
    // broken in the other direction.
    expect(marked.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(fallback.textContent).toContain('<script>alert(2)</script>');

    // LEGITIMATE PATH SUCCEEDS: the engine's own <mark> is a real element.
    expect(marked.querySelectorAll('mark')).toHaveLength(1);
    expect(marked.querySelector('mark')?.textContent).toBe('deploy');
  });
});

/* ── ID search (WI-37204, owner ask 2026-08-08) ─────────────────────────────
   "fix the search in both the agents running dropdown and the hud sessions
   search to support searching both by the su id and the session id".

   The dropdown REPLACES the roster with these results at >=2 chars, and the
   engine behind them searches turn TEXT — so an id query answered nothing at
   all. Measured on the live operator before the fix:
   `?q=su-bc38a419` → `{ totalHits: 0, sessions: [] }`. */

describe('idMatchLabel (pure)', () => {
  it('names WHICH id matched, so a card with no excerpts explains itself', () => {
    expect(idMatchLabel('ownerId')).toBe('matched su id');
    expect(idMatchLabel('sessionId')).toBe('matched session id');
    expect(idMatchLabel('ompThreadId')).toBe('matched thread id');
  });
});

describe('idMatchStreamUrl (pure)', () => {
  const agent = (over: Partial<RosterAgent> = {}) =>
    ({ ownerId: 'su-bc38a419-8dc6', label: 'su · bc38a419', ...over }) as RosterAgent;

  it('opens a LIVE claude session at the head, with no find term', () => {
    const url = idMatchStreamUrl({
      sourceKind: 'claude',
      sessionId: 'sid-1',
      active: agent(),
      session: null,
    });
    expect(url).toContain('sessionId=sid-1');
    expect(url).toContain('owner=su-bc38a419-8dc6');
    /* No `find=`: an id search means "show me THIS session", not "show me where
       it says its own name". Anchoring on the id would scroll the viewer to
       whatever turn happens to mention it — usually none — so the pane would
       look like it failed to find the thing you just successfully found. */
    expect(url).not.toContain('find=');
    expect(url).not.toContain('anchorTs=');
    // A live agent's transcript is on disk; `ended=1` would make the thinking
    // route rematerialize-from-archive/terminate and cut the live stream.
    expect(url).not.toContain('ended=1');
  });

  it('opens a live omp session by its thread id', () => {
    expect(
      idMatchStreamUrl({ sourceKind: 'omp', sessionId: 'thr-1', active: agent(), session: null }),
    ).toContain('ompThreadId=thr-1');
  });

  it('falls back to the recorded row for an ENDED session, marking it ended', () => {
    const url = idMatchStreamUrl({
      sourceKind: 'claude',
      sessionId: 'sid-2',
      active: null,
      session: {
        id: 9, planSlug: null, agent: 'claude', role: null, feature: null, label: null,
        coordOwnerId: 'su-dead0000', sessionId: 'sid-2', ompThreadId: null,
        startedAt: '2026-08-01T00:00:00Z', endedAt: '2026-08-01T01:00:00Z', exitCode: 0,
      } satisfies EndedSessionRow,
    });
    expect(url).toContain('sessionId=sid-2');
    expect(url).toContain('ended=1');
  });

  it('routes a CODEX row through the recorded-row path, which is the only one that can open it', () => {
    // searchHitStreamUrl keys codex by ROLLOUT id; the ended-row path keys it by
    // the adv row id (its per-session CODEX_HOME). Only the latter is derivable
    // from an id match, which is why this prefers `session` over a hit URL.
    const url = idMatchStreamUrl({
      sourceKind: 'codex',
      sessionId: 'su-abc12345',
      active: null,
      session: {
        id: 11, planSlug: null, agent: 'codex', role: null, feature: null, label: null,
        coordOwnerId: 'su-abc12345', sessionId: null, ompThreadId: null,
        startedAt: '2026-08-01T00:00:00Z', endedAt: null, exitCode: null,
      } satisfies EndedSessionRow,
    });
    expect(url).toContain('codexSessionKey=11');
  });

  it('returns null when nothing knows how to open it — never a dead click', () => {
    expect(
      idMatchStreamUrl({ sourceKind: 'session', sessionId: 'su-x', active: null, session: null }),
    ).toBeNull();
  });
});

describe('SessionSearchResults — id matches (WI-37204)', () => {
  const NOW = Date.parse('2026-08-08T12:00:00Z');
  const agent = (over: Partial<RosterAgent> = {}) =>
    ({
      ownerId: 'su-bc38a419-8dc6-4040-a63e-2dc0515e42be',
      label: 'su · bc38a419',
      agent: 'claude',
      role: null,
      intent: 'greening the gate',
      feature: null,
      currentPlanSlug: null,
      liveness: 'live',
      heartbeatAt: '2026-08-08T11:59:59Z',
      lastActiveAt: '2026-08-08T11:59:59Z',
      sessionId: '073c5a1e-d280-4c37-866c-fedcaf096c9e',
      ...over,
    }) as RosterAgent;

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const respondWith = (sessions: SearchSessionResult[], idToken?: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, sessions, idToken }) })),
    );

  const instant = (over: Partial<SearchSessionResult> = {}): SearchSessionResult => ({
    sourceKind: 'claude',
    sessionId: '073c5a1e-d280-4c37-866c-fedcaf096c9e',
    topScore: 0,
    hits: [],
    active: agent(),
    session: null,
    idMatch: 'ownerId',
    ...over,
  });

  it('renders the caller’s instant id match IMMEDIATELY, before the server answers', async () => {
    // A never-resolving fetch: whatever renders here owes nothing to the server.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(
      <SessionSearchResults query="su-bc38a419" nowMs={NOW} instantIdMatches={[instant()]} />,
    );
    expect(screen.getByTestId('search-pending')).toBeTruthy();
    expect(screen.getByTestId('id-match-chip').textContent).toBe('matched su id');
  });

  it('shows the active result’s genuine last-turn age with an exact local timestamp', async () => {
    respondWith([]);
    const lastActiveAt = '2026-08-08T11:57:59Z';
    render(
      <SessionSearchResults
        query="su-bc38a419"
        nowMs={NOW}
        instantIdMatches={[instant({ active: agent({ lastActiveAt }) })]}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());

    const age = screen
      .getByTestId('session-hit-claude-073c5a1e-d280-4c37-866c-fedcaf096c9e')
      .querySelector('.pc-agents-roster__age');
    const exact = new Date(lastActiveAt).toLocaleString();
    expect(age?.tagName).toBe('TIME');
    expect(age?.textContent).toBe('2m');
    expect(age?.getAttribute('datetime')).toBe(lastActiveAt);
    expect(age?.getAttribute('aria-label')).toBe(`Last active turn ${exact} · 2m ago`);
    expect(age?.getAttribute('title')).toBe(`Last active turn ${exact} · 2m ago`);
  });

  it('does not turn a keepalive heartbeat into a last-active-turn timestamp', async () => {
    respondWith([]);
    render(
      <SessionSearchResults
        query="su-bc38a419"
        nowMs={NOW}
        instantIdMatches={[instant({ active: agent({ lastActiveAt: null, heartbeatAt: '2026-08-08T11:59:59Z' }) })]}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    const result = screen.getByTestId('session-hit-claude-073c5a1e-d280-4c37-866c-fedcaf096c9e');
    expect(result.querySelector('.pc-agents-roster__age')).toBeNull();
  });

  it('makes a hit-less id match OPENABLE — the whole point of searching an id', async () => {
    respondWith([]);
    render(<SessionSearchResults query="su-bc38a419" nowMs={NOW} instantIdMatches={[instant()]} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    const head = screen
      .getByTestId('session-hit-claude-073c5a1e-d280-4c37-866c-fedcaf096c9e')
      .querySelector('.pc-agents-sessions__result-head') as HTMLElement;
    // Before this, a result with no hits fell into the dead
    // "No transcript viewer for this source" state and could not be clicked.
    expect(head.getAttribute('role')).toBe('button');
    expect(head.className).not.toContain('is-unopenable');
    expect(head.getAttribute('title')).toBe('Open this session');
  });

  it('does NOT double-render a session the server also returns as an id match', async () => {
    respondWith([instant({ idMatch: 'ownerId' })], 'su-bc38a419');
    render(<SessionSearchResults query="su-bc38a419" nowMs={NOW} instantIdMatches={[instant()]} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    expect(screen.getAllByTestId('id-match-chip')).toHaveLength(1);
  });

  it('keeps a transcript hit for a session that ALSO matched by id', async () => {
    // Ids DO appear in transcript prose, and that hit is often exactly why the
    // id was searched — the union must not drop it.
    respondWith([
      instant({
        hits: [{
          turnIdx: 3,
          ts: '2026-08-08T11:00:00Z',
          owner: 'su-bc38a419-8dc6-4040-a63e-2dc0515e42be',
          excerpt: 'waking su-bc38a419',
          highlight: 'waking <mark>su-bc38a419</mark>',
          score: 2,
          matchedBy: 'lexical',
        }],
      }),
    ]);
    render(<SessionSearchResults query="su-bc38a419" nowMs={NOW} instantIdMatches={[instant()]} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    expect(screen.getByTestId('id-match-chip')).toBeTruthy();
    expect(screen.getByTestId('hit-073c5a1e-d280-4c37-866c-fedcaf096c9e-3').textContent)
      .toContain('waking');
  });

  it('says NO SESSION HAS THAT ID rather than the generic no-matches copy', async () => {
    respondWith([], 'su-ffffffff');
    render(<SessionSearchResults query="su-ffffffff" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    // "No matches in any session" reads as a broken search when you just pasted
    // an id you know is real; this reads as an answer.
    expect(screen.getByTestId('search-empty').textContent).toContain('su-ffffffff');
    expect(screen.getByTestId('search-empty').textContent).toContain('No session has an id');
  });

  it('keeps the generic copy for a prose query that found nothing', async () => {
    respondWith([]); // no idToken — the server judged this prose
    render(<SessionSearchResults query="theory of mind" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    expect(screen.getByTestId('search-empty').textContent).toBe('No matches in any session.');
  });

  it('leaves an ordinary text result unchipped', async () => {
    respondWith([
      {
        sourceKind: 'claude', sessionId: 'sid-text', topScore: 1, active: null, session: null,
        hits: [{ turnIdx: 0, ts: null, owner: null, excerpt: 'a <mark>deploy</mark> ran', highlight: 'a <mark>deploy</mark> ran', score: 1, matchedBy: 'lexical' }],
      },
    ]);
    render(<SessionSearchResults query="deploy" nowMs={NOW} />);
    await waitFor(() => expect(screen.queryByTestId('search-pending')).toBeNull());
    expect(screen.queryByTestId('id-match-chip')).toBeNull();
  });
});
