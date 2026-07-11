// @vitest-environment jsdom
/**
 * AgentsRunningPill — the workspace-wide "N agents running" header pill that
 * expands into a fleet-grouped, fleet-colored roster (agents-running-roster).
 * The advRoster.list sync query, nuqs, and LivenessDot are mocked so this
 * isolates the pill's count/guards + the pure grouping helpers. The shared
 * <Popover> needs a TooltipProvider ancestor (same as HivesRunningPill.test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

const H = vi.hoisted(() => ({
  active: [] as unknown[],
}));

vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [{ active: H.active }] }) }));
vi.mock('@/app/coord/presence-ui', () => ({
  LivenessDot: ({ liveness }: { liveness: string }) => <span data-testid={`dot-${liveness}`} />,
}));
vi.mock('@/app/harness/AgentInspectorModal', () => ({
  default: ({ runId, streamUrl }: { runId: string; streamUrl?: string }) => (
    <div data-testid="inspector-modal" data-run={runId} data-url={streamUrl} />
  ),
}));
vi.mock('@/app/harness/AgentThinkingStream', () => ({
  ThinkingDot: ({ title }: { title?: string }) => <span data-testid="thinking-dot" aria-label={title ?? 'thinking'} />,
}));

// EI-8821: this suite's own bare `parseAsString: {}` stub is exactly what let
// AgentsRunningPill.tsx wiring `parseAsString.withDefault('')` into an
// always-rendered path throw here (and 40 other tests) before the component
// switched to a plain `useQueryState(key)`. Parsers now come from the shared
// complete mock so that class of break can't recur.
const nuqs = vi.hoisted(() => ({ open: false, set: vi.fn() }));
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: () => [nuqs.open, nuqs.set],
}));

import AgentsRunningPill, { groupByFleet, agentGlyph, shortOwner, displayName, hasThinking, thinkingStreamUrl, fmtCompactAge, isLiveByActivity, LIVE_TURN_MS, distinctMachineCount, machineKey, machineTabs, canFocusWindow, resumableSessionId, canForkLive, type RosterAgent } from './AgentsRunningPill';

function agent(over: Partial<RosterAgent> = {}): RosterAgent {
  return {
    ownerId: 'o1', label: 'a1', agent: 'a1', role: 'bee', intent: 'working', feature: null,
    currentPlanSlug: null, liveness: 'live', heartbeatAt: '', fleetSlug: null, fleetColor: null, ...over,
  };
}

const Pill = () => (<TooltipProvider><AgentsRunningPill /></TooltipProvider>);

beforeEach(() => {
  H.active = [
    agent({ ownerId: 'q1', agent: 'queen', role: 'queen', fleetSlug: null }),
    agent({ ownerId: 'b1', agent: 'gizmo', role: 'bee', fleetSlug: 'atlas-fleet', fleetColor: '#d8b4fe', feature: 'F-1' }),
    agent({ ownerId: 'b2', agent: 'nova', role: 'bee', fleetSlug: 'atlas-fleet', fleetColor: '#d8b4fe', liveness: 'stale' }),
    agent({ ownerId: 's1', agent: 'sky', role: 'planner', fleetSlug: 'zzz-fleet', fleetColor: '#86efac' }),
  ];
  nuqs.open = false;
  nuqs.set = vi.fn();
});
afterEach(() => cleanup());

describe('groupByFleet (pure)', () => {
  it('groups by fleet, fleeted alphabetical, "No fleet" last', () => {
    const groups = groupByFleet([
      agent({ ownerId: 'x', fleetSlug: null }),
      agent({ ownerId: 'y', fleetSlug: 'zzz', fleetColor: '#111' }),
      agent({ ownerId: 'z', fleetSlug: 'aaa', fleetColor: '#222' }),
    ]);
    expect(groups.map((g) => g.slug)).toEqual(['aaa', 'zzz', null]);
    expect(groups[0].color).toBe('#222');
    expect(groups[2].color).toBe(null); // No-fleet group has no color
  });

  it('collects multiple agents into one fleet group', () => {
    const groups = groupByFleet([
      agent({ ownerId: 'a', fleetSlug: 'f', fleetColor: '#abc' }),
      agent({ ownerId: 'b', fleetSlug: 'f', fleetColor: '#abc' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agents.map((a) => a.ownerId)).toEqual(['a', 'b']);
  });
});

describe('displayName / shortOwner (pure — the name fix)', () => {
  it('shortOwner shortens a long owner id, keeping the prefix', () => {
    expect(shortOwner('su-5577c5df-e2a2-49d2-85a7')).toMatch(/^su-5577/);
    expect(shortOwner('short-id')).toBe('short-id'); // already short → unchanged
  });
  it('displayName prefers the human label, never the agent type', () => {
    // A real label wins (even though agent='claude' would be the type).
    expect(displayName({ label: 'su · su-5577c', ownerId: 'su-5577c5df-e2a2' })).toBe('su · su-5577c');
    // No label → a short owner id, NOT the raw long id and NOT "claude".
    expect(displayName({ label: '', ownerId: 'su-5577c5df-e2a2-49d2' })).toMatch(/^su-5577/);
  });
});

describe('fmtCompactAge (pure — last-active pill)', () => {
  const base = Date.parse('2026-07-01T12:00:00Z');
  it('formats seconds/minutes/hours/days compactly', () => {
    expect(fmtCompactAge('2026-07-01T11:59:57Z', base)).toBe('3s');
    expect(fmtCompactAge('2026-07-01T11:58:00Z', base)).toBe('2m');
    expect(fmtCompactAge('2026-07-01T08:00:00Z', base)).toBe('4h');
    expect(fmtCompactAge('2026-06-29T12:00:00Z', base)).toBe('2d');
  });
  it('empty for missing/invalid; clamps a slightly-future ts to 0s', () => {
    expect(fmtCompactAge('', base)).toBe('');
    expect(fmtCompactAge(undefined, base)).toBe('');
    expect(fmtCompactAge('nonsense', base)).toBe('');
    expect(fmtCompactAge('2026-07-01T12:00:05Z', base)).toBe('0s');
  });
});

describe('canFocusWindow (pure — focus-button guard)', () => {
  it('true with a stored windowId (direct wmctrl target)', () => {
    expect(canFocusWindow({ windowId: '0x0185e0d2' })).toBe(true);
    expect(canFocusWindow({ windowId: '0x0185e0d2', advSessionId: null })).toBe(true);
  });
  it('true with an advSessionId even when windowId is unresolved — the focus endpoint resolves the window by adv row / [adv:<id>] title (owner ask 2026-07-11)', () => {
    expect(canFocusWindow({ windowId: null, advSessionId: 42 })).toBe(true);
    expect(canFocusWindow({ windowId: undefined, advSessionId: 7 })).toBe(true);
  });
  it('false when neither a windowId nor an advSessionId is present (pid alone is NOT enough — shared server pid)', () => {
    expect(canFocusWindow({ windowId: null, advSessionId: null })).toBe(false);
    expect(canFocusWindow({ windowId: null })).toBe(false);
    expect(canFocusWindow({ windowId: undefined })).toBe(false);
  });
});

describe('resumableSessionId (pure — Fork/Resume-button guard, WI-3882)', () => {
  it('claude: returns sessionId', () => {
    expect(resumableSessionId({ agent: 'claude', sessionId: 'sess-1', ompThreadId: null })).toBe('sess-1');
  });
  it('omp: returns ompThreadId when sessionId is absent', () => {
    expect(resumableSessionId({ agent: 'omp', sessionId: null, ompThreadId: 'thread-1' })).toBe('thread-1');
  });
  it('codex: always null — rollout resume is a different mechanism than `-r`', () => {
    expect(resumableSessionId({ agent: 'codex', sessionId: 'sess-1', ompThreadId: 'thread-1' })).toBeNull();
  });
  it('null when neither id is present', () => {
    expect(resumableSessionId({ agent: 'claude', sessionId: null, ompThreadId: null })).toBeNull();
  });
});

describe('canForkLive (pure — live-Fork-button backend guard, WI-4009)', () => {
  it('claude: forkable live', () => {
    expect(canForkLive({ agent: 'claude' })).toBe(true);
  });
  it('omp: NOT forkable live — no --fork-session support, would collide in-place', () => {
    expect(canForkLive({ agent: 'omp' })).toBe(false);
  });
  it('codex: NOT forkable live', () => {
    expect(canForkLive({ agent: 'codex' })).toBe(false);
  });
  it('null/unknown agent: NOT forkable live (fail closed, never a colliding button)', () => {
    expect(canForkLive({ agent: null })).toBe(false);
  });
});

describe('agentGlyph (pure)', () => {
  it('maps kind/role to the colony glyph, · for unknown', () => {
    expect(agentGlyph({ agentPaneKind: 'queen', role: null })).toBe('🍵');
    expect(agentGlyph({ agentPaneKind: null, role: 'bee' })).toBe('☕');
    expect(agentGlyph({ agentPaneKind: null, role: 'sentinel' })).toBe('🥤');
    expect(agentGlyph({ agentPaneKind: null, role: 'mystery' })).toBe('·');
  });
});

describe('hasThinking (pure — WI-2680: transcript-resolvability veto)', () => {
  it('true for each real handle when resolvability is not vetoed', () => {
    expect(hasThinking({ runId: 'r1', harnessSlug: 'h' })).toBe(true); // bee run-log
    expect(hasThinking({ sessionId: 's1' })).toBe(true); // claude interactive
    expect(hasThinking({ agent: 'codex', advSessionId: 42 })).toBe(true); // codex rollout
    expect(hasThinking({ ompThreadId: 't1' })).toBe(true); // omp thread
  });

  it('false with no handle at all', () => {
    expect(hasThinking({ ownerId: 'su-x' } as never)).toBe(false);
    expect(hasThinking({ runId: 'r1' })).toBe(false); // runId needs harnessSlug
  });

  it('thinkingResolvable===false VETOES even a present claude session handle (the empty-pane fix)', () => {
    // A parked/ended claude agent whose transcript is gone: server stamped resolvable
    // false so the client offers the honest "unavailable" note, never an empty modal.
    expect(hasThinking({ sessionId: 's1', thinkingResolvable: false })).toBe(false);
    // The veto is unconditional across backends when explicitly false.
    expect(hasThinking({ runId: 'r1', harnessSlug: 'h', thinkingResolvable: false })).toBe(false);
  });

  it('resolvable true / undefined does NOT hide a working pane (no regression)', () => {
    expect(hasThinking({ sessionId: 's1', thinkingResolvable: true })).toBe(true);
    expect(hasThinking({ sessionId: 's1', thinkingResolvable: undefined })).toBe(true);
  });
});

describe('<AgentsRunningPill>', () => {
  it('renders nothing when no non-stale agents are present', () => {
    H.active = [agent({ liveness: 'stale' })];
    const { container } = render(<Pill />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a "thinking" count in the pill when agents are actively thinking', () => {
    H.active = [agent({ ownerId: 'a1', thinking: true }), agent({ ownerId: 'a2', thinking: false })];
    render(<Pill />);
    expect(screen.getByTestId('agents-thinking-count').textContent).toContain('1 thinking');
  });

  it('renders a pulsing thinking dot on an actively-thinking row', () => {
    H.active = [agent({ ownerId: 'a1', thinking: true })];
    nuqs.open = true;
    render(<Pill />);
    expect(screen.getAllByTestId('thinking-dot').length).toBeGreaterThan(0);
  });

  it('shows a compact last-active pill next to the liveness dot', () => {
    H.active = [agent({ ownerId: 'a1', heartbeatAt: new Date(Date.now() - 5_000).toISOString() })];
    nuqs.open = true;
    render(<Pill />);
    const row = screen.getByTestId('agent-row-a1');
    expect(row.querySelector('.pc-agents-roster__age')?.textContent).toMatch(/^\d+s$/);
  });

  it('shows the running count excluding stale rows', () => {
    render(<Pill />);
    const pill = screen.getByTestId('agents-running-pill');
    // 4 agents, one stale → 3 running.
    expect(pill.textContent).toContain('3 agents running');
  });

  it('opens the fleet-grouped roster popover with headers + rows', () => {
    nuqs.open = true;
    render(<Pill />);
    expect(screen.getByTestId('agents-running-pop')).toBeTruthy();
    // Fleet headers (alpha; No fleet last).
    expect(screen.getByText(/atlas-fleet/)).toBeTruthy();
    expect(screen.getByText(/zzz-fleet/)).toBeTruthy();
    expect(screen.getByText(/No fleet/)).toBeTruthy();
    // Rows for the running agents.
    expect(screen.getByTestId('agent-row-b1')).toBeTruthy();
    expect(screen.getByTestId('agent-row-q1')).toBeTruthy();
  });

  it('hovering an agent row previews its plan/work-item in the detail strip', () => {
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-b1'));
    const detail = screen.getByTestId('agent-detail');
    expect(detail.textContent).toContain('gizmo');
    expect(detail.textContent).toContain('F-1'); // its work item
  });

  it('keeps the detail strip mounted before hover and after leaving the roster', () => {
    nuqs.open = true;
    render(<Pill />);

    // A stable default is visible immediately, so the area above inactive
    // sessions never collapses while push-driven roster data refreshes.
    expect(screen.getByTestId('agent-detail')).toBeTruthy();

    fireEvent.mouseEnter(screen.getByTestId('agent-row-b1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('F-1');
    fireEvent.mouseLeave(screen.getByTestId('agents-roster'));

    // Moving toward the detail/inactive-session controls retains the last
    // preview instead of making the section disappear and reappear.
    expect(screen.getByTestId('agent-detail').textContent).toContain('F-1');
  });

  it('keeps the detail strip mounted when the previewed agent drops out of a live-roster refresh (WI-3881)', () => {
    nuqs.open = true;
    const { rerender } = render(<Pill />);

    // Preview a specific agent — the strip now tracks it.
    fireEvent.mouseEnter(screen.getByTestId('agent-row-b1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('gizmo');

    // A push-driven refresh where that agent's heartbeat aged to 'stale', so it
    // is filtered out of the running roster (and thus out of the strip's
    // previewed selection). Before the sticky-fallback fix this collapsed
    // `active` to null and the strip disappeared until the next push.
    H.active = [
      agent({ ownerId: 'q1', agent: 'queen', role: 'queen', fleetSlug: null }),
      agent({ ownerId: 'b2', agent: 'nova', role: 'bee', fleetSlug: 'atlas-fleet', fleetColor: '#d8b4fe', liveness: 'live', feature: 'F-9' }),
    ];
    rerender(<Pill />);

    // The strip must NOT vanish — it stays mounted, falling back to a still-present
    // agent instead of blanking (the disappear/reappear bug).
    expect(screen.getByTestId('agent-detail')).toBeTruthy();
  });

  it('clicking an agent row pins it', () => {
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-q1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('pinned');
  });

  it('the hover preview (and its inspect button) stays reachable after leaving the roster', () => {
    // Superseded expectation, WI-EI-9256: the roster used to dismiss the preview
    // on mouseleave, but that made the detail strip (and the inactive-sessions
    // section right below it) blink out while the user moved the cursor toward
    // it — see the "Keep the most recently previewed agent selected" comment on
    // AgentsRoster. There is now no onMouseLeave handler at all: hovering a row
    // sets the preview and it stays mounted (falling back to the first agent),
    // so moving from a row into the detail pane to click its button never loses
    // the preview.
    H.active = [agent({ ownerId: 'bee1', role: 'bee', runId: 'r1', harnessSlug: 'papercusp' })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-bee1'));
    expect(screen.getByTestId('agent-detail')).toBeTruthy();
    expect(screen.getByTestId('agent-inspect-btn')).toBeTruthy();
    fireEvent.mouseLeave(screen.getByTestId('agents-roster'));
    expect(screen.getByTestId('agent-detail')).toBeTruthy();
    expect(screen.getByTestId('agent-inspect-btn')).toBeTruthy();
  });

  it('shows a Live-thinking action ONLY for an agent with a resolvable run (guarded — no dead button)', () => {
    H.active = [
      agent({ ownerId: 'bee1', role: 'bee', runId: 'launch-123', harnessSlug: 'papercusp' }),
      agent({ ownerId: 'su1', role: 'su' }), // no runId → no action
    ];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-bee1'));
    expect(screen.getByTestId('agent-inspect-btn')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByTestId('agent-row-su1'));
    expect(screen.queryByTestId('agent-inspect-btn')).toBeNull();
  });

  it('an agent WITHOUT any thinking source shows an explicit unavailable note (not a silently-inert row)', () => {
    // A presence-only process with no session row / run-log / thread id — the
    // pane can't stream it. The detail strip must SAY so, so "clicking does
    // nothing" reads as a known limitation, not a broken pane.
    H.active = [agent({ ownerId: 'qx1', role: 'queen', agent: 'codex', runId: null, harnessSlug: null, sessionId: null })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-qx1'));
    const note = screen.getByTestId('agent-no-thinking-note');
    expect(note.textContent).toContain('Live thinking unavailable');
    expect(note.textContent).toContain('codex');
    expect(screen.queryByTestId('agent-inspect-btn')).toBeNull();
  });

  it('WI-2680: a claude session WHOSE TRANSCRIPT DOESN\'T RESOLVE (thinkingResolvable:false) shows the honest note, not an empty inspector', () => {
    // The reported bug: parked/ended backlog-clearance agents (loop-armed, transcript
    // gone) sort to the top of the roster; clicking one opened an EMPTY pane. The server
    // now stamps thinkingResolvable:false; the client must offer the honest note and
    // NEVER open the (empty) inspector modal.
    H.active = [agent({ ownerId: 'zx1', role: 'su', agent: 'claude', sessionId: 'stale-sess-abc', runId: null, harnessSlug: null, thinkingResolvable: false })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-zx1'));
    const note = screen.getByTestId('agent-no-thinking-note');
    expect(note.textContent).toContain('Live thinking unavailable');
    expect(note.textContent).toMatch(/ended|rotated away/); // the accurate "gone transcript" copy, not "no handle"
    expect(screen.queryByTestId('agent-inspect-btn')).toBeNull();
    // Clicking the row must NOT open the empty inspector.
    fireEvent.click(screen.getByTestId('agent-row-zx1'));
    expect(screen.queryByTestId('inspector-modal')).toBeNull();
  });

  it('WI-2680: a claude session WITH a resolvable transcript (thinkingResolvable:true) still opens the inspector (no regression)', () => {
    H.active = [agent({ ownerId: 'lv1', role: 'su', agent: 'claude', sessionId: 'live-sess-xyz', runId: null, harnessSlug: null, thinkingResolvable: true })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-lv1'));
    const modal = screen.getByTestId('inspector-modal');
    expect(modal.getAttribute('data-url')).toContain('/api/adv/session/thinking?sessionId=live-sess-xyz');
  });

  it('a CODEX session (adv row id, no claude sessionId) streams via codexSessionKey', () => {
    H.active = [agent({ ownerId: 'cq1', role: 'queen', agent: 'codex', advSessionId: 9444, runId: null, harnessSlug: null, sessionId: null })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-cq1'));
    const modal = screen.getByTestId('inspector-modal');
    expect(modal.getAttribute('data-url')).toBe('/api/adv/session/thinking?codexSessionKey=9444');
  });

  it('an OMP session (thread id) streams via ompThreadId', () => {
    H.active = [agent({ ownerId: 'om1', role: 'su', agent: 'omp', ompThreadId: '019f1de3-19b8-7000-90a3-a36f8c343ac6', runId: null, harnessSlug: null, sessionId: null })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-om1'));
    const modal = screen.getByTestId('inspector-modal');
    expect(modal.getAttribute('data-url')).toBe('/api/adv/session/thinking?ompThreadId=019f1de3-19b8-7000-90a3-a36f8c343ac6');
  });

  it('clicking Live thinking opens the inspector for that run', () => {
    H.active = [agent({ ownerId: 'bee1', role: 'bee', runId: 'launch-xyz', harnessSlug: 'papercusp' })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-bee1'));
    fireEvent.click(screen.getByTestId('agent-inspect-btn'));
    expect(screen.getByTestId('inspector-modal').getAttribute('data-run')).toBe('launch-xyz');
  });

  it('an INTERACTIVE session (sessionId, no run) also gets thinking → the transcript stream', () => {
    H.active = [agent({ ownerId: 'q1', role: 'queen', sessionId: 'sess-abc', runId: null, harnessSlug: null })];
    nuqs.open = true;
    render(<Pill />);
    // Row click opens the inspector pointed at the session-transcript endpoint.
    fireEvent.click(screen.getByTestId('agent-row-q1'));
    const modal = screen.getByTestId('inspector-modal');
    expect(modal.getAttribute('data-run')).toBe('sess-abc');
    const url = modal.getAttribute('data-url') ?? '';
    expect(url).toContain('/api/adv/session/thinking?sessionId=sess-abc');
    // The owner hint lets the backend jump straight to the session's isolation
    // dir instead of sweeping all of them (the ~3s → ms fix).
    expect(url).toContain('&owner=q1');
  });

  it('clicking the ROW opens thinking for an agent with a run; pins for one without', () => {
    H.active = [
      agent({ ownerId: 'bee1', role: 'bee', runId: 'launch-row', harnessSlug: 'papercusp' }),
      agent({ ownerId: 'su1', role: 'su' }), // no run → pin, no inspector
    ];
    nuqs.open = true;
    render(<Pill />);
    // Clicking the bee row opens the inspector directly (the user's "click → thinking").
    fireEvent.click(screen.getByTestId('agent-row-bee1'));
    expect(screen.getByTestId('inspector-modal').getAttribute('data-run')).toBe('launch-row');
    // Clicking a run-less agent pins its detail instead (no inspector).
    fireEvent.click(screen.getByTestId('agent-row-su1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('pinned');
  });
});

describe('isLiveByActivity (pure — WI-1488: live = turn in last 10m OR loop armed)', () => {
  const NOW = Date.parse('2026-07-01T12:00:00Z');
  const mk = (o: Partial<RosterAgent>): Pick<RosterAgent, 'lastActiveAt' | 'loopArmed'> => ({
    lastActiveAt: null,
    loopArmed: false,
    ...o,
  });

  it('live when a turn happened within the last 10 minutes', () => {
    expect(isLiveByActivity(mk({ lastActiveAt: new Date(NOW - 60_000).toISOString() }), NOW)).toBe(true);
    expect(isLiveByActivity(mk({ lastActiveAt: new Date(NOW - (LIVE_TURN_MS - 1_000)).toISOString() }), NOW)).toBe(true);
  });

  it('NOT live when the last turn is older than 10 minutes (no loop)', () => {
    expect(isLiveByActivity(mk({ lastActiveAt: new Date(NOW - (LIVE_TURN_MS + 1_000)).toISOString() }), NOW)).toBe(false);
  });

  it('live when a loop is armed, regardless of last-turn age', () => {
    expect(isLiveByActivity(mk({ loopArmed: true }), NOW)).toBe(true);
    expect(isLiveByActivity(mk({ loopArmed: true, lastActiveAt: new Date(NOW - 3_600_000).toISOString() }), NOW)).toBe(true);
  });

  it('NOT live with no activity and no loop (does NOT fall back to the keepalive heartbeat)', () => {
    expect(isLiveByActivity(mk({ lastActiveAt: null }), NOW)).toBe(false);
  });

  it('NOT live for an unparseable lastActiveAt', () => {
    expect(isLiveByActivity(mk({ lastActiveAt: 'not-a-date' }), NOW)).toBe(false);
  });
});

describe('machine grouping (shared-hive per-machine tabs)', () => {
  const a = (o: Partial<RosterAgent>): RosterAgent =>
    ({ ownerId: 'x', label: 'x', agent: null, role: null, intent: '', feature: null, currentPlanSlug: null, liveness: 'live', heartbeatAt: '', ...o }) as RosterAgent;

  it('distinctMachineCount counts local + each remote machine', () => {
    expect(distinctMachineCount([
      a({ isLocal: true, machineLabel: 'boxA' }),
      a({ isLocal: true, machineLabel: 'boxA' }),
      a({ isLocal: false, machineLabel: 'boxB' }),
      a({ isLocal: false, machineLabel: 'boxC' }),
    ])).toBe(3);
  });

  it('machineKey buckets unlabeled local vs remote rows', () => {
    expect(machineKey(a({ isLocal: true }))).toBe('__local__');
    expect(machineKey(a({ isLocal: false }))).toBe('__remote__');
    expect(machineKey(a({ machineLabel: 'boxB', isLocal: false }))).toBe('boxB');
  });

  it('machineTabs puts Local first, then remotes alphabetical, with counts', () => {
    const tabs = machineTabs([
      a({ isLocal: false, machineLabel: 'zeta' }),
      a({ isLocal: true, machineLabel: 'boxA' }),
      a({ isLocal: false, machineLabel: 'alpha' }),
      a({ isLocal: false, machineLabel: 'alpha' }),
    ]);
    expect(tabs.map((t) => t.label)).toEqual(['Local', 'alpha', 'zeta']);
    expect(tabs[0].isLocal).toBe(true);
    expect(tabs.find((t) => t.label === 'alpha')?.count).toBe(2);
  });
});
