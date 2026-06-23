// @vitest-environment jsdom
//
// AdvOverviewTab mount coverage — Brief 23's Overview dashboard (the /adv
// default landing surface, overview-dashboard-2026-06-05). The pure selectors
// (planProgress / selectActivePlans / selectDecisions / countAlerts /
// selectLiveAgents / OVERVIEW_TILE_TARGETS) are pinned in
// __tests__/adv-overview-logic.test.ts; THIS file mounts the tab against
// mocked usePlanList/usePlanAttention + a per-query useSyncQuery dispatcher
// (roster → dev.coordPresence, activity → userActions.byHarness; LIVE sync,
// no longer polled — data-sync-push-completion P-006) and asserts the four
// tiles, the alerts badge, empty/loading states, and the tile→tab
// click-through wiring. FleetRateControl is covered by its own test file and
// stubbed out here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// nuqs: writers (tab / inboxTier) + the `slug` reader (the selected harness,
// which scopes the activity query). Stable per-key setter spies so the
// click-through wiring is assertable.
const nuqsState: Record<string, unknown> = { tab: null, inboxTier: null, slug: null };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn(async () => {});
    return [nuqsState[key], nuqsSetters[key]];
  },
  parseAsString: {},
}));

// Brief 20's control has its own test file — stub it out so this one only
// exercises the Overview composition.
vi.mock('./FleetRateControl', () => ({
  default: () => <div data-testid="fleet-rate-control" />,
}));

let planListResult: Record<string, unknown> = { data: { plans: [] }, loading: false, error: null, refresh: vi.fn() };
let attentionResult: Record<string, unknown> = { data: { groups: [] }, loading: false, error: null, refresh: vi.fn() };
vi.mock('@/app/admin/plans/plans-api', () => ({
  usePlanList: () => planListResult,
  usePlanAttention: () => attentionResult,
}));

// Per-query sync mock — the tab subscribes to two distinct LIVE queries:
//   dev.coordPresence (roster) · userActions.byHarness (activity).
// A disabled query never resolves data (mirrors the no-fetch behaviour); the
// activity query is disabled until a harness is selected (?slug=).
let presenceResult: { data?: unknown[]; loading?: boolean } = { data: [], loading: false };
let activityResult: { data?: unknown[]; loading?: boolean } = { data: [], loading: false };
const syncEnabled: Record<string, boolean | undefined> = {};
const syncArgs: Record<string, unknown> = {};
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({
    queryName,
    args,
    enabled,
  }: {
    queryName: string;
    args?: unknown;
    enabled?: boolean;
  }) => {
    syncEnabled[queryName] = enabled;
    syncArgs[queryName] = args;
    if (enabled === false) return { data: undefined, loading: false, error: null };
    switch (queryName) {
      case 'dev.coordPresence':
        return { ...presenceResult, error: null };
      // byHarness (a harness selected) + recent (All-Pots fleet-wide) share the
      // same row shape + fixture (D-008: the All-Pots Activity fallback).
      case 'userActions.byHarness':
      case 'userActions.recent':
        return { ...activityResult, error: null };
      default:
        return { data: undefined, loading: false, error: null };
    }
  },
}));

// liveness: deterministic — derive 'live'/'idle'/'stale' from the row's
// heartbeatAt offset (the real dep is a dependency-free leaf; stub it so the
// roster mapping is assertable without wall-clock coupling).
vi.mock('@papercusp/operator-core/lib/liveness', () => ({
  deriveLiveness: (iso: string) => {
    const age = Date.now() - new Date(iso).getTime();
    if (age < 60_000) return 'live';
    if (age < 600_000) return 'idle';
    return 'stale';
  },
}));

vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  getBrowserWorkspaceId: () => 'ws-test',
}));

import AdvOverviewTab from './AdvOverviewTab';
import type { AttentionItem, PlanListRow } from '@/app/admin/plans/plans-api';

const plan = (over: Partial<PlanListRow>): PlanListRow =>
  ({
    slug: 'p',
    title: 'plan',
    status: 'active',
    startStatus: null,
    archived: false,
    updated: '2026-06-01T00:00:00Z',
    itemCounts: { todo: 1, wip: 1, blocked: 0, 'needs-human': 0, done: 2, dropped: 1 },
    ...over,
  }) as PlanListRow;

const attn = (over: Partial<AttentionItem> & { tier?: string }): AttentionItem =>
  ({
    id: `a-${Math.random()}`,
    kind: 'plan-question',
    title: 'an item',
    body: '',
    importance: 'normal',
    needsHuman: false,
    harnessSlug: null,
    ...over,
  }) as AttentionItem;

// A raw dev.coordPresence row (PresenceRecord — the fields the tab maps). The
// liveness mock derives live/idle/stale from `heartbeatAt`, so the fixtures set
// an explicit age via `agoMs`.
const presenceRow = (
  over: Partial<{
    ownerId: string;
    ownerLabel: string;
    intent: string;
    currentFiles: string[];
    currentPlanSlug: string | null;
    agentRole: string | null;
    source: string;
    agoMs: number;
    stale: boolean;
  }>,
) => {
  const { agoMs = 0, ...rest } = over;
  return {
    ownerId: `o-${Math.random()}`,
    ownerLabel: 'agent',
    intent: '',
    currentFiles: [],
    currentPlanSlug: null,
    agentRole: null,
    source: 'claude',
    heartbeatAt: new Date(Date.now() - agoMs).toISOString(),
    stale: false,
    ...rest,
  };
};

// A raw userActions.byHarness row (the harness_shared.user_actions shape).
const actionRow = (
  over: Partial<{
    id: string | number;
    harnessSlug: string;
    kind: string;
    status: string;
    summary: string | null;
    actor: string | null;
    startedAt: number;
  }>,
) => ({
  id: `act-${Math.random()}`,
  harnessSlug: 'papercup',
  kind: 'tool',
  status: 'ok',
  summary: null,
  actor: null,
  startedAt: Date.now(),
  ...over,
});

describe('AdvOverviewTab component', () => {
  beforeEach(() => {
    nuqsState.tab = null;
    nuqsState.inboxTier = null;
    nuqsState.slug = null;
    for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
    for (const k of Object.keys(syncEnabled)) delete syncEnabled[k];
    for (const k of Object.keys(syncArgs)) delete syncArgs[k];
    planListResult = { data: { plans: [] }, loading: false, error: null, refresh: vi.fn() };
    attentionResult = { data: { groups: [] }, loading: false, error: null, refresh: vi.fn() };
    presenceResult = { data: [], loading: false };
    activityResult = { data: [], loading: false };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the four tiles, the top-bar rate control, and the empty states', async () => {
    render(<AdvOverviewTab />);
    expect(screen.getByTestId('fleet-rate-control')).toBeTruthy();
    expect(screen.getByText('Plans')).toBeTruthy();
    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText('No active plans')).toBeTruthy();
    expect(screen.getByText('Nothing needs you right now')).toBeTruthy();
    expect(screen.getByText('No live agents')).toBeTruthy();
    // No harness selected (?slug= null) → the Activity tile reads the fleet-wide
    // userActions.recent feed (D-008); the empty fixture → its empty state. It is
    // NOT scoped to a harness (no userActions.byHarness call).
    expect(screen.getByText('No recent activity')).toBeTruthy();
    expect(syncArgs['userActions.recent']).toMatchObject({ workspaceId: expect.any(String) });
    expect(syncArgs['userActions.byHarness']).toBeUndefined();
  });

  it('fills the All-Pots Activity tile from the fleet-wide userActions.recent feed (D-008)', () => {
    // No harness selected (?slug= null), but the fleet-wide recent feed has rows —
    // the tile must render them instead of an empty/"select a harness" state.
    nuqsState.slug = null;
    activityResult = {
      data: [actionRow({ id: 'fleet1', actor: 'queen', kind: 'place', summary: 'placed WI-900' })],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText('placed WI-900')).toBeTruthy();
    expect(syncArgs['userActions.recent']).toMatchObject({ workspaceId: expect.any(String) });
    expect(syncArgs['userActions.byHarness']).toBeUndefined();
  });

  it('renders plan rows with the done/total fraction and the active-count badge', () => {
    planListResult = {
      data: {
        plans: [
          plan({ slug: 'auth', title: 'Auth refactor', status: 'active' }),
          plan({ slug: 'shipped', title: 'Old', status: 'shipped' }),
          plan({ slug: 'going', title: 'In flight', status: 'ready', startStatus: 'started' }),
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText('Auth refactor')).toBeTruthy();
    expect(screen.getByText('In flight')).toBeTruthy();
    expect(screen.queryByText('Old')).toBeNull();
    // both visible plans carry the same 2/4 item counts
    expect(screen.getAllByText('2/4')).toHaveLength(2);
    // count badge = active + started
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('surfaces decision-tier attention items with harness tags and the alert badge count', () => {
    attentionResult = {
      data: {
        groups: [
          {
            items: [
              attn({ id: 'd1', tier: 'decision', title: 'Approve the migration', harnessSlug: 'papercup' }),
              attn({ id: 'a1', tier: 'alert', title: 'smoke failed' }),
              attn({ id: 'a2', tier: 'alert', title: 'escalation' }),
            ],
          },
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText('Approve the migration')).toBeTruthy();
    expect(screen.getByText('papercup')).toBeTruthy();
    const alerts = screen.getByRole('button', { name: 'Open alerts' });
    expect(alerts.textContent).toContain('2');
    expect(alerts.getAttribute('data-has-alerts')).toBe('true');
  });

  it('renders live roster agents (dev.coordPresence) and recent activity (userActions.byHarness)', async () => {
    nuqsState.slug = 'pot-a';
    presenceResult = {
      data: [
        presenceRow({ ownerId: 'o1', intent: 'wiring the sync query', agentRole: 'worker', agoMs: 0 }),
        presenceRow({ ownerId: 'o2', ownerLabel: 'architect-1', intent: '', agoMs: 120_000 }), // idle
        presenceRow({ ownerId: 'o3', intent: 'gone', agoMs: 900_000 }), // stale-by-heartbeat
      ],
      loading: false,
    };
    activityResult = {
      data: [actionRow({ id: 'act1', actor: 'worker', kind: 'tool', summary: 'listed the plans' })],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(await screen.findByText('wiring the sync query')).toBeTruthy();
    expect(screen.getByText('architect-1')).toBeTruthy(); // ownerLabel fallback when no intent
    expect(screen.queryByText('gone')).toBeNull(); // stale (old heartbeat) filtered out
    // 'worker' appears as both the roster role tag (agentRole) and the activity actor.
    expect(screen.getAllByText('worker').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('listed the plans')).toBeTruthy();
    // A harness selected → the byHarness query runs, scoped to that harness + workspace
    // (and the fleet-wide recent feed is NOT used).
    expect(syncArgs['userActions.byHarness']).toMatchObject({
      harnessSlug: 'pot-a',
      workspaceId: 'ws-test',
    });
    expect(syncArgs['userActions.recent']).toBeUndefined();
  });

  it('falls back to `kind` for an activity row with no summary', async () => {
    nuqsState.slug = 'pot-a';
    activityResult = {
      data: [actionRow({ id: 'act2', actor: 'queen', kind: 'lifecycle', summary: null })],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(await screen.findByText('lifecycle')).toBeTruthy();
    expect(screen.getByText('queen')).toBeTruthy();
  });

  it('shows the Agents loading state while dev.coordPresence is in flight', () => {
    presenceResult = { data: undefined, loading: true };
    render(<AdvOverviewTab />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('clicking a tile open button writes the target tab to the URL', () => {
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Plans' }));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('plans');
    fireEvent.click(screen.getByRole('button', { name: 'Open Agents' }));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('harnesses');
  });

  it('the alerts button deep-links the inbox alert tier (sequential writes)', async () => {
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open alerts' }));
    await waitFor(() => expect(nuqsSetters.inboxTier).toHaveBeenCalledWith('alert'));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('plans');
  });

  it('the Needs-you open button deep-links the decision tier', async () => {
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Needs you' }));
    await waitFor(() => expect(nuqsSetters.inboxTier).toHaveBeenCalledWith('decision'));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('plans');
  });

  it('shows the loading state while a query is in flight without data', () => {
    planListResult = { data: undefined, loading: true, error: null, refresh: vi.fn() };
    render(<AdvOverviewTab />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows a query error in the tile body', () => {
    attentionResult = { data: undefined, loading: false, error: 'attention exploded', refresh: vi.fn() };
    render(<AdvOverviewTab />);
    expect(screen.getByText('attention exploded')).toBeTruthy();
  });
});
