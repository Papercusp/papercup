// @vitest-environment jsdom
/**
 * FleetPanel.test — the dev-admin-rail "fleet / coord" glance (P-008). Reads
 * `dev.coordPresence` (list) + `dev.fleetGovernor` (snapshot → data[0].fleet).
 *
 * Covers: the fleet KV (in-flight/cap, the "· eff N" branch only when effective
 * < cap, the "· N stale" suffix); stale-row exclusion from activeAgents +
 * staleCount; the heartbeat-desc sort (hbMs handles number / ISO string / null);
 * the empty + error states; and the per-row fields (label||id, intent fallback,
 * plan-slug prefix, file-count suffix). Refresh invalidates BOTH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[] | undefined; loading: boolean; fetching: boolean; error: Error | null; invalidate: ReturnType<typeof vi.fn> }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    H.results[queryName] ?? { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() },
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import FleetPanel from './FleetPanel';

const presence = (over = {}) => ({
  ownerId: 'a1',
  ownerLabel: 'Agent One',
  intent: 'doing things',
  currentPlanSlug: null,
  currentFiles: null,
  heartbeatAt: Date.now(),
  stale: false,
  ...over,
});
const fleet = (over = {}) => ({ fleet: { cap: 8, inFlight: 3, effective: 8, floor: 1, ...over } });

function seed(queryName: string, over: Partial<(typeof H.results)[string]> = {}) {
  H.results[queryName] = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), ...over };
  return H.results[queryName];
}

beforeEach(() => {
  H.results = {};
});
afterEach(() => cleanup());

describe('<FleetPanel>', () => {
  it('renders the fleet KV with in-flight / cap (no eff suffix when effective===cap)', () => {
    seed('dev.coordPresence', { data: [presence()] });
    seed('dev.fleetGovernor', { data: [fleet({ cap: 8, inFlight: 3, effective: 8 })] });
    render(<FleetPanel active={true} />);
    expect(screen.getByText('3 / 8')).toBeTruthy();
  });

  it('adds the "· eff N" suffix only when effective < cap', () => {
    seed('dev.coordPresence', { data: [presence()] });
    seed('dev.fleetGovernor', { data: [fleet({ cap: 8, inFlight: 5, effective: 4 })] });
    render(<FleetPanel active={true} />);
    expect(screen.getByText('5 / 8 · eff 4')).toBeTruthy();
  });

  it('counts live agents and excludes/​counts stale rows', () => {
    seed('dev.coordPresence', {
      data: [
        presence({ ownerId: 'a1', stale: false }),
        presence({ ownerId: 'a2', stale: true }),
        presence({ ownerId: 'a3', stale: false }),
      ],
    });
    seed('dev.fleetGovernor', { data: [fleet()] });
    render(<FleetPanel active={true} />);
    // 2 live, 1 stale.
    expect(screen.getByText('2 · 1 stale')).toBeTruthy();
  });

  it('omits the stale suffix when there are none', () => {
    seed('dev.coordPresence', { data: [presence({ ownerId: 'a1' })] });
    seed('dev.fleetGovernor', { data: [fleet()] });
    render(<FleetPanel active={true} />);
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.queryByText(/stale/)).toBeNull();
  });

  it('sorts active agents by heartbeat desc (number + ISO string mix)', () => {
    seed('dev.coordPresence', {
      data: [
        presence({ ownerId: 'old', ownerLabel: 'Old', heartbeatAt: '2026-06-01T00:00:00Z' }),
        presence({ ownerId: 'new', ownerLabel: 'New', heartbeatAt: Date.now() }),
        presence({ ownerId: 'mid', ownerLabel: 'Mid', heartbeatAt: '2026-06-10T00:00:00Z' }),
      ],
    });
    seed('dev.fleetGovernor', { data: [fleet()] });
    render(<FleetPanel active={true} />);
    const labels = screen.getAllByText(/^(Old|New|Mid)$/).map((n) => n.textContent);
    expect(labels).toEqual(['New', 'Mid', 'Old']);
  });

  it('shows the empty state when no live agents', () => {
    seed('dev.coordPresence', { data: [presence({ stale: true })] });
    seed('dev.fleetGovernor', { data: [fleet()] });
    render(<FleetPanel active={true} />);
    expect(screen.getByText('No agents active right now.')).toBeTruthy();
  });

  it('surfaces a presence error', () => {
    seed('dev.coordPresence', { data: undefined, error: new Error('presence boom') });
    seed('dev.fleetGovernor', { data: [fleet()] });
    render(<FleetPanel active={true} />);
    expect(screen.getByText('Failed to load: presence boom')).toBeTruthy();
  });

  it('surfaces a governor error when presence has none', () => {
    seed('dev.coordPresence', { data: [presence()] });
    seed('dev.fleetGovernor', { data: undefined, error: new Error('gov boom') });
    render(<FleetPanel active={true} />);
    expect(screen.getByText('Failed to load: gov boom')).toBeTruthy();
  });

  it('renders per-row: ownerId fallback, intent fallback, plan-slug prefix + file count', () => {
    seed('dev.coordPresence', {
      data: [
        presence({ ownerId: 'noLabel', ownerLabel: '', intent: null, currentPlanSlug: 'plan-x', currentFiles: ['a.ts', 'b.ts'] }),
      ],
    });
    seed('dev.fleetGovernor', { data: [fleet()] });
    render(<FleetPanel active={true} />);
    // ownerLabel '' → falls back to ownerId
    expect(screen.getByText('noLabel')).toBeTruthy();
    // intent null → fallback text
    expect(screen.getByText('no declared intent')).toBeTruthy();
    // plan-slug prefix + 2 file(s) suffix in the sub line
    expect(screen.getByText(/plan-x ·/)).toBeTruthy();
    expect(screen.getByText(/· 2 file\(s\)/)).toBeTruthy();
  });

  it('renders no fleet KV when the governor snapshot is missing', () => {
    seed('dev.coordPresence', { data: [presence()] });
    seed('dev.fleetGovernor', { data: [] });
    render(<FleetPanel active={true} />);
    expect(screen.queryByText('in-flight / cap')).toBeNull();
    // the agent row still renders
    expect(screen.getByText('Agent One')).toBeTruthy();
  });

  it('refresh invalidates BOTH presence and governor', () => {
    const p = seed('dev.coordPresence', { data: [presence()] });
    const g = seed('dev.fleetGovernor', { data: [fleet()] });
    render(<FleetPanel active={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh fleet / coord' }));
    expect(p.invalidate).toHaveBeenCalled();
    expect(g.invalidate).toHaveBeenCalled();
  });
});
