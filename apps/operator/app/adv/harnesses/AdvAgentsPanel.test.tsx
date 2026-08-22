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
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ ...workingState, invalidate: invalidateMock }),
}));
vi.mock('@papercusp/grid-core', () => ({
  // Both sub-views render via VirtualGrid (RichGrid + an owned virtualizer); the
  // mock renders `rows` (the empty `empty` slot when there are none) so the
  // assertions key off the same row buttons.
  VirtualGrid: ({ rows, onRowClick, getRowId, empty, onEndReached }: {
    rows?: unknown[];
    onRowClick?: (r: unknown) => void; getRowId?: (r: unknown) => string; empty?: ReactNode;
    onEndReached?: () => void;
  }) => {
    const data = rows ?? [];
    if (data.length === 0 && empty) return <div data-testid="grid">{empty}</div>;
    return (
      <div data-testid="grid">
        {data.map((r, i) => {
          const id = getRowId ? getRowId(r) : String(i);
          return <button key={id} data-testid={`row-${id}`} onClick={() => onRowClick?.(r)}>{id}</button>;
        })}
        {onEndReached ? <button data-testid="grid-load-more" onClick={onEndReached}>more</button> : null}
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
  filterCountLabel: (evidence: { kind: string; count?: number; corpusTotal?: number }, noun = 'item') => {
    if (evidence.kind === 'unknown') {
      return { title: '—', summary: 'Count updating…', ariaLabel: 'Count updating…', evidence: 'unknown' };
    }
    const count = evidence.count ?? 0;
    const total = evidence.corpusTotal ?? count;
    const summary = `Showing ${count.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${noun}${total === 1 ? '' : 's'}`;
    return { title: `${count} of ${total}`, summary, ariaLabel: summary, evidence: evidence.kind };
  },
}));
let runsState: {
  agents: Array<{ running?: boolean }> | null;
  total: number | null;
  matched: number | null;
  running: number | null;
  nextCursor: string | null;
  fetching: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};
const refreshMock = vi.fn();
let seenRunsOptions: { runningOnly?: boolean; cursor?: string | null } | undefined;
vi.mock('./useHarnessData', () => ({
  useHarnessAgents: (_slug: string, options?: { runningOnly?: boolean; cursor?: string | null }) => {
    seenRunsOptions = options;
    return {
      ...runsState,
      agents: options?.runningOnly && runsState.agents
        ? runsState.agents.filter((row) => row.running)
        : runsState.agents,
    };
  },
}));

// Lexicon resolver echoes its key (t('brain') → 'brain') — isolates the routed
// kind-legend copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import AdvAgentsPanel, { mergeAgentRunPage } from './AdvAgentsPanel';
import type { WorkingAgent } from './AdvAgentsPanel';

function agent(over: Partial<WorkingAgent> & { agentId: string }): WorkingAgent {
  return {
    label: null, name: null, present: true, alive: true, heartbeatAt: null, intent: '', claims: [],
    orphaned: false, declaredUnclaimed: false, doing: null, queued: [], load: 0, agentPaneKind: 'su', driveMode: '',
    ...over,
  };
}
const WORKING: WorkingAgent[] = [
  agent({ agentId: 'a1', name: 'Ada', agentPaneKind: 'mug', doing: { id: 'WI-1', title: 'Fix bug', rank: null }, load: 2, alive: true }),
  agent({ agentId: 'a2', name: 'Bob', agentPaneKind: 'cup', intent: 'scouting', alive: false }),
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
  // total (5734) is deliberately > RUNS.length (the list read is capped at
  // RUNS_LIST_CAP, P-004) so the count-label assertion proves it reads the true
  // store total from _meta, not the loaded window length.
  runsState = {
    agents: RUNS,
    total: 5734,
    matched: 1,
    running: 1,
    nextCursor: null,
    fetching: false,
    loading: false,
    error: null,
    refresh: refreshMock,
  };
  setTitle.mockReset(); invalidateMock.mockReset(); refreshMock.mockReset();
  seenRunsOptions = undefined;
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
    renderPanel('alpha', '?akind=cup');
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
    runsState = { ...runsState, agents: null, total: null, matched: null, running: null, loading: true };
    renderPanel('alpha', '?agentsView=runs');
    expect(screen.getByText(/Loading alpha/i)).toBeTruthy();
  });
  it('shows the error state', () => {
    runsState = { ...runsState, agents: null, total: null, matched: null, running: null, loading: false, error: 'nope' };
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
  it('titles the runs view with the TRUE store total, not the capped window length', () => {
    // P-004: the list read is capped (RUNS_LIST_CAP), so only a window of rows loads
    // (RUNS has 2) but the label must report the true store total (5734 via _meta).
    renderPanel('alpha', '?agentsView=runs&agentsAll=true');
    expect(setTitle).toHaveBeenCalledWith('Agents · alpha (5734 runs)');
  });

  it('titles Running only with the exact active and corpus totals', () => {
    renderPanel('alpha', '?agentsView=runs');
    expect(setTitle).toHaveBeenCalledWith('Agents · alpha (1 running · 5734 total)');
  });

  it('renders explicit shown/total evidence for both server modes', () => {
    renderPanel('alpha', '?agentsView=runs');
    expect(seenRunsOptions?.runningOnly).toBe(true);
    expect(screen.getByTestId('agent-runs-count').textContent).toBe('Showing 1 of 1 run');
    fireEvent.click(screen.getByRole('button', { name: /Running only/i }));
    expect(seenRunsOptions?.runningOnly).toBe(false);
    expect(screen.getByTestId('agent-runs-count').textContent).toBe('Showing 2 of 5,734 runs');
  });

  it('passes the server cursor forward when the virtual grid reaches the end', async () => {
    runsState = { ...runsState, nextCursor: 'cursor-2' };
    renderPanel('alpha', '?agentsView=runs');
    fireEvent.click(screen.getByTestId('grid-load-more'));
    await waitFor(() => expect(seenRunsOptions?.cursor).toBe('cursor-2'));
  });

  it('renders the exact zero-running state without falling back to page length', () => {
    runsState = { ...runsState, agents: [], matched: 0, running: 0 };
    renderPanel('alpha', '?agentsView=runs');
    expect(screen.getByText('0 running · 5734 total')).toBeTruthy();
    expect(screen.getByTestId('agent-runs-count').textContent).toBe('Showing 0 of 0 runs');
  });
});

describe('mergeAgentRunPage', () => {
  it('replaces page one and appends cursor pages without duplicate run ids', () => {
    const first = RUNS as never[];
    expect(mergeAgentRunPage([], first, null)).toEqual(first);
    const appended = mergeAgentRunPage(first, [
      { ...RUNS[1], role: 'updated' },
      { ...RUNS[0], runId: 'r3' },
    ] as never[], 'cursor-1');
    expect(appended.map((row) => row.runId)).toEqual(['r1', 'r2', 'r3']);
    expect(appended.find((row) => row.runId === 'r2')?.role).toBe('updated');
    expect(mergeAgentRunPage(appended, [RUNS[0]] as never[], null)).toEqual([RUNS[0]]);
  });
});
