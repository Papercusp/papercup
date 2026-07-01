// @vitest-environment jsdom
/**
 * AgentsRunningPill — the workspace-wide "N agents running" header pill that
 * expands into a fleet-grouped, fleet-colored roster (agents-running-roster).
 * The advRoster.list sync query, nuqs, and LivenessDot are mocked so this
 * isolates the pill's count/guards + the pure grouping helpers. The shared
 * <Popover> needs a TooltipProvider ancestor (same as HivesRunningPill.test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';

const H = vi.hoisted(() => ({
  active: [] as unknown[],
}));

vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [{ active: H.active }] }) }));
vi.mock('@/app/coord/presence-ui', () => ({
  LivenessDot: ({ liveness }: { liveness: string }) => <span data-testid={`dot-${liveness}`} />,
}));

const nuqs = vi.hoisted(() => ({ open: false, set: vi.fn() }));
vi.mock('nuqs', () => ({
  useQueryState: () => [nuqs.open, nuqs.set],
  parseAsBoolean: { withDefault: () => ({}) },
}));

import AgentsRunningPill, { groupByFleet, agentGlyph, type RosterAgent } from './AgentsRunningPill';

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
});
