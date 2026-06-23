/**
 * @vitest-environment jsdom
 *
 * SessionsRosterView (P-006) — the grouped rich-row live roster. Verifies the
 * grouping rule (plan / No-plan / presence-only with D-005 always-show) and that
 * the rendered rows carry the liveness dot, client/role/feature, intent, and
 * file chips, fed by a mocked advRoster.list sync query.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import {
  SessionsRosterList,
  SessionsRosterDetail,
  groupRoster,
  buildFilesInPlay,
  isZombie,
  applyRosterFilters,
  EMPTY_FILTERS,
  type RosterEntry,
} from '../SessionsRosterView';
import { SessionsRosterProvider } from '../SessionsRosterContext';

const syncState = vi.hoisted(() => ({
  roster: null as unknown,
  detail: null as unknown,
  calls: [] as Array<{ queryName: string; args?: unknown }>,
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args?: unknown; enabled?: boolean }) => {
    syncState.calls.push(opts);
    return {
      data:
        opts.enabled === false
          ? null
          : opts.queryName === 'advRoster.list'
            ? (syncState.roster ? [syncState.roster] : null)
            : opts.queryName === 'agentDetail.byOwner'
              ? (syncState.detail ? [syncState.detail] : null)
              : null,
      loading: false,
      error: null,
      fetching: false,
      invalidate: vi.fn(),
    };
  },
}));

/**
 * The roster is now a split 2-pane (list + detail) sharing one poll via the
 * provider. This thin wrapper renders both under the provider so the existing
 * single-component test cases keep exercising the full roster + dossier.
 */
function SessionsRosterView(
  props: React.ComponentProps<typeof SessionsRosterList> & { workspaceId?: string | null },
): React.JSX.Element {
  const { workspaceId = null, selectedAgent = null, onSelectAgent, ...rest } = props;
  return (
    <SessionsRosterProvider workspaceId={workspaceId}>
      <SessionsRosterList selectedAgent={selectedAgent} onSelectAgent={onSelectAgent} {...rest} />
      <SessionsRosterDetail selectedAgent={selectedAgent} onSelectAgent={onSelectAgent} />
    </SessionsRosterProvider>
  );
}

function entry(over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    ownerId: 'su-1',
    label: 'su-1',
    source: 'omp-hook-session',
    intent: 'doing X',
    currentFiles: [],
    host: 'h',
    pid: 1,
    startedAt: '2026-06-02T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    liveness: 'live',
    stale: false,
    workspaceId: 'ws1',
    userId: null,
    revoked: false,
    pidAlive: null,
    hasLaunchRecord: false,
    advSessionId: null,
    currentPlanSlug: null,
    role: null,
    feature: null,
    agent: null,
    mode: null,
    windowId: null,
    ompThreadId: null,
    cwd: null,
    launchStartedAt: null,
    ...over,
  };
}

describe('groupRoster', () => {
  it('splits into plan / no-plan / presence-only; planFilters narrows plan groups only (D-005)', () => {
    const active = [
      entry({ ownerId: 'a', currentPlanSlug: 'plan-x', hasLaunchRecord: true }),
      entry({ ownerId: 'b', currentPlanSlug: 'plan-y', hasLaunchRecord: true }),
      entry({ ownerId: 'c', currentPlanSlug: null, hasLaunchRecord: true }), // ad-hoc, has launch row
      entry({ ownerId: 'd', currentPlanSlug: null, hasLaunchRecord: false }), // pure presence
    ];
    const g = groupRoster(active, ['plan-x']);
    expect(g.planGroups.map((x) => x.slug)).toEqual(['plan-x']); // plan-y filtered out
    expect(g.noPlan.map((e) => e.ownerId)).toEqual(['c']); // always shown despite the filter
    expect(g.presenceOnly.map((e) => e.ownerId)).toEqual(['d']); // always shown despite the filter
  });

  it('empty planFilters shows every plan group, sorted', () => {
    const active = [
      entry({ ownerId: 'a', currentPlanSlug: 'p2' }),
      entry({ ownerId: 'b', currentPlanSlug: 'p1' }),
    ];
    expect(groupRoster(active, []).planGroups.map((x) => x.slug)).toEqual(['p1', 'p2']);
  });
});

describe('isZombie', () => {
  it('is a zombie only when non-stale AND pid confirmed dead', () => {
    expect(isZombie({ liveness: 'live', pidAlive: false })).toBe(true);
    expect(isZombie({ liveness: 'idle', pidAlive: false })).toBe(true);
    expect(isZombie({ liveness: 'live', pidAlive: true })).toBe(false);
    expect(isZombie({ liveness: 'live', pidAlive: null })).toBe(false); // unknown ≠ zombie
    expect(isZombie({ liveness: 'stale', pidAlive: false })).toBe(false); // already gone
  });
});

describe('buildFilesInPlay', () => {
  it('inverts to file → agents, flags contention, sorts contended first', () => {
    const active = [
      entry({ ownerId: 'a', currentFiles: ['x.ts', 'y.ts'] }),
      entry({ ownerId: 'b', currentFiles: ['x.ts'] }),
      entry({ ownerId: 'c', currentFiles: ['z.ts'] }),
    ];
    const files = buildFilesInPlay(active);
    expect(files[0].path).toBe('x.ts'); // contended → first
    expect(files[0].contended).toBe(true);
    expect(files[0].agents.map((a) => a.ownerId).sort()).toEqual(['a', 'b']);
    const yz = files.filter((f) => !f.contended).map((f) => f.path);
    expect(yz).toEqual(['y.ts', 'z.ts']); // single-agent files, path-sorted
  });

  it('de-dupes a file an agent declares twice (one agent, not contended)', () => {
    const active = [entry({ ownerId: 'a', currentFiles: ['x.ts', 'x.ts'] })];
    const files = buildFilesInPlay(active);
    expect(files).toHaveLength(1);
    expect(files[0].agents).toHaveLength(1);
    expect(files[0].contended).toBe(false);
  });
});

describe('applyRosterFilters (P-010)', () => {
  const roster = [
    entry({ ownerId: 'a', agent: 'claude', liveness: 'live', role: 'worker', currentFiles: ['x.ts'] }),
    entry({ ownerId: 'b', agent: 'codex', liveness: 'idle', role: 'architect', currentFiles: ['y.ts'] }),
    entry({ ownerId: 'c', agent: null, source: 'omp-hook-session', liveness: 'live', role: null, currentFiles: [] }),
  ];

  it('no filters = pass-through', () => {
    expect(applyRosterFilters(roster, EMPTY_FILTERS).map((e) => e.ownerId)).toEqual(['a', 'b', 'c']);
  });
  it('filters by client (derives from source when agent is null)', () => {
    expect(applyRosterFilters(roster, { ...EMPTY_FILTERS, client: 'omp' }).map((e) => e.ownerId)).toEqual(['c']);
  });
  it('filters by liveness', () => {
    expect(applyRosterFilters(roster, { ...EMPTY_FILTERS, liveness: 'live' }).map((e) => e.ownerId)).toEqual(['a', 'c']);
  });
  it('filters by role', () => {
    expect(applyRosterFilters(roster, { ...EMPTY_FILTERS, role: 'architect' }).map((e) => e.ownerId)).toEqual(['b']);
  });
  it('filters by file substring (who is editing X), case-insensitive', () => {
    expect(applyRosterFilters(roster, { ...EMPTY_FILTERS, file: 'X.TS' }).map((e) => e.ownerId)).toEqual(['a']);
  });
  it('combines facets (AND)', () => {
    expect(
      applyRosterFilters(roster, { ...EMPTY_FILTERS, client: 'claude', liveness: 'live' }).map((e) => e.ownerId),
    ).toEqual(['a']);
  });
});

describe('SessionsRosterView', () => {
  beforeEach(() => {
    syncState.calls = [];
    syncState.detail = {
      ownerId: 'a',
      locks: { held: [], waiting: [], error: null },
      coord: { lastMessage: null, unreadCount: 0, openHandoffs: [], openEscalations: [], error: null },
    };
    syncState.roster = {
        active: [
          entry({
            ownerId: 'a',
            label: 'worker-188',
            currentPlanSlug: 'dbos-retire',
            hasLaunchRecord: true,
            role: 'worker',
            feature: 'F-012',
            agent: 'claude',
            intent: 'refactoring attempt-claim',
            currentFiles: ['apps/operator/lib/orchestrator/attempt-claim.ts'],
          }),
          entry({ ownerId: 'd', label: 'omp-4471', liveness: 'idle', intent: '' }),
        ],
        ended: [
          { id: 9, label: 'old', role: null, feature: null, agent: 'omp', planSlug: null, endedAt: new Date().toISOString() },
        ],
      };
  });
  afterEach(() => {
    cleanup();
  });

  it('renders the plan group, presence-only group, intent + file chips, and the ended section', async () => {
    const { findByText, getByText, container } = render(
      <SessionsRosterView planFilters={[]} workspaceId="ws1" />,
    );
    await findByText('dbos-retire'); // plan group header
    // 'worker' also appears as a role-filter <option>; assert via the row chip.
    expect(
      [...container.querySelectorAll('.pc-roster__chip')].some((c) => c.textContent === 'worker'),
    ).toBe(true);
    expect(getByText('F-012')).toBeTruthy(); // feature chip
    expect(getByText('refactoring attempt-claim')).toBeTruthy(); // intent line
    // file basename appears in the row chip (also in the files-in-play map) →
    // assert via the row file-chip class specifically.
    expect(
      container.querySelector('.pc-roster__file-chip')?.textContent,
    ).toContain('attempt-claim.ts');
    expect(getByText('Other active agents (presence-only)')).toBeTruthy();
    expect(getByText('(no declared intent)')).toBeTruthy(); // the idle agent with no intent
    expect(getByText('Recently ended')).toBeTruthy();
  });

  it('heads each plan group with the plan title only — slug dropped (the title is enough)', async () => {
    const { findByText, container } = render(
      <SessionsRosterView
        planFilters={[]}
        workspaceId="ws1"
        planTitleBySlug={new Map([['dbos-retire', 'Retire DBOS']])}
      />,
    );
    // The group header shows the human title, not the raw slug.
    const head = await findByText('Retire DBOS');
    expect(head.className).toContain('pc-roster__group-title');
    // The slug subtitle was removed.
    expect(container.querySelector('.pc-roster__group-sub')).toBeNull();
  });

  it('scopes the roster query to the workspace', async () => {
    render(<SessionsRosterView planFilters={[]} workspaceId="ws9" />);
    await waitFor(() =>
      expect(syncState.calls.some((c) => c.queryName === 'advRoster.list')).toBe(true),
    );
    expect(syncState.calls.find((c) => c.queryName === 'advRoster.list')?.args).toEqual({
      workspaceId: 'ws9',
      endedLimit: 50,
    });
  });

  it('clicking a row calls onSelectAgent with the owner id (P-007 selection)', async () => {
    const onSelectAgent = vi.fn();
    const { findByText } = render(
      <SessionsRosterView planFilters={[]} onSelectAgent={onSelectAgent} />,
    );
    const row = (await findByText('worker-188')).closest('.pc-roster__row');
    expect(row).toBeTruthy();
    fireEvent.click(row as Element);
    expect(onSelectAgent).toHaveBeenCalledWith('a');
  });

  it('renders the dossier pane when an agent is selected', async () => {
    syncState.roster = {
      active: [entry({ ownerId: 'a', label: 'worker-188', intent: 'doing X' })],
      ended: [],
    };
    const { container, findByLabelText } = render(
      <SessionsRosterView planFilters={[]} selectedAgent="a" onSelectAgent={vi.fn()} />,
    );
    expect(await findByLabelText('Agent detail')).toBeTruthy();
    await waitFor(() =>
      expect(container.querySelector('[data-selected]')).toBeTruthy(),
    );
  });

  it('typing in the file filter emits the next filters (P-010)', async () => {
    const onFilterChange = vi.fn();
    const { findByLabelText } = render(
      <SessionsRosterView planFilters={[]} onFilterChange={onFilterChange} />,
    );
    const input = await findByLabelText("Who's editing file");
    fireEvent.change(input, { target: { value: 'attempt-claim' } });
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'attempt-claim' }),
    );
  });

  it('renders the client/liveness/role filter dropdowns + the empty dossier placeholder', async () => {
    const { findByLabelText, getByText } = render(<SessionsRosterView planFilters={[]} />);
    // The three harness <Select> triggers carry the aria-label.
    expect(await findByLabelText('Filter by client')).toBeTruthy();
    expect(await findByLabelText('Filter by liveness')).toBeTruthy();
    expect(await findByLabelText('Filter by role')).toBeTruthy();
    // The right pane persists: with nothing selected it shows the placeholder
    // (this is the "disappeared panel" fix — the pane is always rendered).
    expect(getByText('No agent selected')).toBeTruthy();
  });

  it('hides stale agents by default and surfaces a toggle (perf fix)', async () => {
    syncState.roster = {
      active: [
        entry({ ownerId: 'L', label: 'live-one', liveness: 'live' }),
        entry({ ownerId: 'S', label: 'stale-one', liveness: 'stale' }),
      ],
      ended: [],
    };
    const onToggleStale = vi.fn();
    const { findByText, queryByText } = render(
      <SessionsRosterView planFilters={[]} onToggleStale={onToggleStale} />,
    );
    await findByText('live-one');
    expect(queryByText('stale-one')).toBeNull(); // stale hidden by default
    const toggle = await findByText(/1 stale/); // the show-stale toggle carries the count
    fireEvent.click(toggle);
    expect(onToggleStale).toHaveBeenCalled();
  });

  it('shows stale agents when showStale is on', async () => {
    syncState.roster = {
      active: [
        entry({ ownerId: 'L', label: 'live-one', liveness: 'live' }),
        entry({ ownerId: 'S', label: 'stale-one', liveness: 'stale' }),
      ],
      ended: [],
    };
    const { findByText } = render(<SessionsRosterView planFilters={[]} showStale />);
    expect(await findByText('stale-one')).toBeTruthy();
  });

  it('applies passed filters to the rendered roster (P-010)', async () => {
    const { findByText, queryByText } = render(
      <SessionsRosterView
        planFilters={[]}
        filters={{ client: null, liveness: 'idle', role: null, file: '' }}
      />,
    );
    expect(await findByText('omp-4471')).toBeTruthy(); // the idle agent stays
    expect(queryByText('dbos-retire')).toBeNull(); // the live agent's plan group is filtered out
  });
});
