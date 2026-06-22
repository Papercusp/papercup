// @vitest-environment jsdom
/**
 * AdvAgentsPanel.test.tsx — the /adv "who's working here" panel. Two sub-views
 * behind the ?agentsView toggle: WorkingView (fleetAssignments.byHarness via
 * useSyncQuery) and RunsView (run history via useHarnessAgents + a virtualizer).
 * Covers the no-slug guard, the view toggle, and — per view — loading / error /
 * empty / populated branches, the panel-title effect, the quick-search + kind
 * filters, refresh, and row-click → ?sel.
 *
 * Seams stubbed: @papercusp/sync, @papercusp/grid-core, @tanstack/react-virtual,
 * the column-filter hook/bar, Select, Tooltip, the kind pills, presence-ui, the
 * theme role style, liveness constants, and the useHarnessAgents hook. nuqs via
 * NuqsTestingAdapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';

interface SyncState { loading?: boolean; fetching?: boolean; data?: unknown; error?: { message: string } | null }
let workingState: SyncState;
const invalidateMock = vi.fn();
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...workingState, invalidate: invalidateMock }),
}));
vi.mock('@papercusp/grid-core', () => ({
  // Both sub-views render via VirtualGrid (RichGrid + an owned virtualizer); the
  // mock renders `rows` (the empty `empty` slot when there are none) so the
  // assertions key off the same row buttons.
  VirtualGrid: ({ rows, onRowClick, getRowId, empty }: {
    rows?: unknown[];
    onRowClick?: (r: unknown) => void; getRowId?: (r: unknown) => string; empty?: ReactNode;
  }) => {
    const data = rows ?? [];
    if (data.length === 0 && empty) return <div data-testid="grid">{empty}</div>;
    return (
      <div data-testid="grid">
        {data.map((r, i) => {
          const id = getRowId ? getRowId(r) : String(i);
          return <button key={id} data-testid={`row-${id}`} onClick={() => onRowClick?.(r)}>{id}</button>;
        })}
      </div>
    );
  },
  usePersistedColumnWidths: () => [{}, vi.fn()],
}));
vi.mock('@papercusp/operator-core/lib/liveness', () => ({ LIVE_MS: 60_000, STALE_MS: 300_000 }));
vi.mock('../../harness/theme', () => ({ getRoleStyle: (role: string) => ({ solid: '#000', label: role || 'SU' }) }));
vi.mock('../../harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: {
    value: string; onChange: (v: string) => void; ariaLabel?: string; options: { value: string; label: string }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));
vi.mock('../../harness/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../../harness/primitives', () => ({ AgentKindPill: ({ kind }: { kind: string }) => <span>{kind}</span>, AGENT_KIND_GLYPH: {} }));
vi.mock('../../coord/presence-ui', () => ({ LivenessDot: () => <span data-testid="liveness-dot" />, livenessFromHeartbeat: () => 'stale' }));
vi.mock('../../harness/filters', () => ({
  useColumnFilters: (_c: unknown, rows: unknown[]) => ({ rows, controller: {}, activeChips: [], hasActive: false, clearAll: vi.fn() }),
  ColumnFilterBar: () => <div data-testid="filter-bar" />,
}));
let runsState: { agents: unknown[] | null; loading: boolean; error: string | null; refresh: () => void };
const refreshMock = vi.fn();
vi.mock('./useHarnessData', () => ({ useHarnessAgents: () => runsState }));

import AdvAgentsPanel from './AdvAgentsPanel';
import type { WorkingAgent } from './AdvAgentsPanel';

function agent(over: Partial<WorkingAgent> & { agentId: string }): WorkingAgent {
  return {
    label: null, name: null, present: true, alive: true, heartbeatAt: null, intent: '', claims: [],
    orphaned: false, declaredUnclaimed: false, doing: null, queued: [], load: 0, agentPaneKind: 'su', driveMode: '',
    ...over,
  };
}
const WORKING: WorkingAgent[] = [
  agent({ agentId: 'a1', name: 'Ada', agentPaneKind: 'queen', doing: { id: 'WI-1', title: 'Fix bug', rank: null }, load: 2, alive: true }),
  agent({ agentId: 'a2', name: 'Bob', agentPaneKind: 'bee', intent: 'scouting', alive: false }),
];
const RUNS = [
  { runId: 'r1', role: 'engineer', running: true, featureId: 'F-9', sizeBytes: 2048, lastEventTs: 1000, ts: 1000 },
  { runId: 'r2', role: 'reviewer', running: false, featureId: null, sizeBytes: 0, lastEventTs: 500, ts: 500 },
];

const setTitle = vi.fn();
function renderPanel(slug = 'alpha', searchParams = '', onUrlUpdate?: (e: unknown) => void) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <AdvAgentsPanel params={{ harnessSlug: slug }} api={{ setTitle } as never} />
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => {
  workingState = { loading: false, fetching: false, data: WORKING, error: null };
  runsState = { agents: RUNS, loading: false, error: null, refresh: refreshMock };
  setTitle.mockReset(); invalidateMock.mockReset(); refreshMock.mockReset();
});
afterEach(cleanup);

describe('AdvAgentsPanel shell', () => {
  it('shows the no-slug guard when params carry no harness', () => {
    renderPanel('');
    expect(screen.getByText(/No harness slug in params/i)).toBeTruthy();
  });
  it('defaults to the working sub-view', () => {
    renderPanel();
    expect(screen.getByLabelText('Filter agents')).toBeTruthy();
  });
  it('renders the runs sub-view when ?agentsView=runs', () => {
    renderPanel('alpha', '?agentsView=runs');
    expect(screen.getByRole('button', { name: /Running only/i })).toBeTruthy();
    expect(screen.queryByLabelText('Filter agents')).toBeNull();
  });
});

describe('AdvAgentsPanel · WorkingView', () => {
  it('shows the loading state', () => {
    workingState = { loading: true, fetching: true, data: null, error: null };
    renderPanel();
    expect(screen.getByText(/Loading alpha/i)).toBeTruthy();
  });
  it('shows the error state', () => {
    workingState = { loading: false, fetching: false, data: null, error: { message: 'boom' } };
    renderPanel();
    expect(screen.getByText(/Failed: boom/i)).toBeTruthy();
  });
  it('shows the empty state and sets the title from the agent count', () => {
    workingState = { loading: false, fetching: false, data: [], error: null };
    renderPanel();
    expect(screen.getByText(/No agents working in alpha right now/i)).toBeTruthy();
    expect(setTitle).toHaveBeenCalledWith('Agents · alpha (0)');
  });
  it('renders agent rows and sets the title', () => {
    renderPanel();
    expect(screen.getByTestId('row-a1')).toBeTruthy();
    expect(screen.getByTestId('row-a2')).toBeTruthy();
    expect(setTitle).toHaveBeenCalledWith('Agents · alpha (2)');
  });
  it('applies the quick-search filter (aq)', () => {
    renderPanel('alpha', '?aq=ada');
    expect(screen.getByTestId('row-a1')).toBeTruthy();
    expect(screen.queryByTestId('row-a2')).toBeNull();
  });
  it('applies the kind filter (akind)', () => {
    renderPanel('alpha', '?akind=bee');
    expect(screen.getByTestId('row-a2')).toBeTruthy();
    expect(screen.queryByTestId('row-a1')).toBeNull();
  });
  it('invokes invalidate on refresh', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh agents' }));
    expect(invalidateMock).toHaveBeenCalledTimes(1);
  });
  it('writes agent:<id> into ?sel on row click', async () => {
    const onUrlUpdate = vi.fn();
    renderPanel('alpha', '', onUrlUpdate);
    fireEvent.click(screen.getByTestId('row-a1'));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const ev = onUrlUpdate.mock.calls.at(-1)![0] as { searchParams: URLSearchParams };
    expect(ev.searchParams.get('sel')).toBe('agent:a1');
  });
});

describe('AdvAgentsPanel · RunsView', () => {
  it('shows the loading state', () => {
    runsState = { agents: null, loading: true, error: null, refresh: refreshMock };
    renderPanel('alpha', '?agentsView=runs');
    expect(screen.getByText(/Loading alpha/i)).toBeTruthy();
  });
  it('shows the error state', () => {
    runsState = { agents: null, loading: false, error: 'nope', refresh: refreshMock };
    renderPanel('alpha', '?agentsView=runs');
    expect(screen.getByText(/Failed: nope/i)).toBeTruthy();
  });
  it('shows only running rows by default, all rows when toggled', () => {
    renderPanel('alpha', '?agentsView=runs');
    expect(screen.getByTestId('row-r1')).toBeTruthy();
    expect(screen.queryByTestId('row-r2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Running only/i }));
    expect(screen.getByTestId('row-r2')).toBeTruthy();
  });
  it('invokes refresh on the runs refresh button', () => {
    renderPanel('alpha', '?agentsView=runs');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh agent runs' }));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
  it('selects a run feature into ?sel on row click', async () => {
    const onUrlUpdate = vi.fn();
    renderPanel('alpha', '?agentsView=runs', onUrlUpdate);
    fireEvent.click(screen.getByTestId('row-r1'));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const ev = onUrlUpdate.mock.calls.at(-1)![0] as { searchParams: URLSearchParams };
    expect(ev.searchParams.get('sel')).toBe('F-9');
  });
});
