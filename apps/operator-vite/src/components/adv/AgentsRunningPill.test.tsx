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

const nuqs = vi.hoisted(() => ({ open: false, set: vi.fn() }));
vi.mock('nuqs', () => ({
  useQueryState: () => [nuqs.open, nuqs.set],
  parseAsBoolean: { withDefault: () => ({}) },
}));

import AgentsRunningPill, { groupByFleet, agentGlyph, shortOwner, displayName, hasThinking, thinkingStreamUrl, type RosterAgent } from './AgentsRunningPill';

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

describe('agentGlyph (pure)', () => {
  it('maps kind/role to the colony glyph, · for unknown', () => {
    expect(agentGlyph({ agentPaneKind: 'queen', role: null })).toBe('♛');
    expect(agentGlyph({ agentPaneKind: null, role: 'bee' })).toBe('🐝');
    expect(agentGlyph({ agentPaneKind: null, role: 'sentinel' })).toBe('🛡');
    expect(agentGlyph({ agentPaneKind: null, role: 'mystery' })).toBe('·');
  });
});

describe('<AgentsRunningPill>', () => {
  it('renders nothing when no non-stale agents are present', () => {
    H.active = [agent({ liveness: 'stale' })];
    const { container } = render(<Pill />);
    expect(container.innerHTML).toBe('');
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

  it('clicking an agent row pins it', () => {
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-q1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('pinned');
  });

  it('detail preview stays reachable: leaving the scroll list toward the button does NOT dismiss it', () => {
    H.active = [agent({ ownerId: 'bee1', role: 'bee', runId: 'r1', harnessSlug: 'papercusp' })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-bee1'));
    expect(screen.getByTestId('agent-detail')).toBeTruthy();
    // Moving off the row list toward the detail pane must NOT clear the preview
    // (onMouseLeave is on the whole roster, not the scroll list) — else the
    // Live-thinking button is unreachable.
    fireEvent.mouseLeave(screen.getByTestId('agents-roster-scroll'));
    expect(screen.getByTestId('agent-detail')).toBeTruthy();
    expect(screen.getByTestId('agent-inspect-btn')).toBeTruthy();
    // Leaving the ENTIRE roster does clear the hover preview.
    fireEvent.mouseLeave(screen.getByTestId('agents-roster'));
    expect(screen.queryByTestId('agent-detail')).toBeNull();
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
