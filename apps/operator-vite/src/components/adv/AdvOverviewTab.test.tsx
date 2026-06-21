// @vitest-environment jsdom
//
// AdvOverviewTab mount coverage — Brief 23's Overview dashboard (the /adv
// default landing surface, overview-dashboard-2026-06-05). The pure selectors
// (planProgress / selectActivePlans / selectDecisions / countAlerts /
// selectLiveAgents / OVERVIEW_TILE_TARGETS) are pinned in
// __tests__/adv-overview-logic.test.ts; THIS file mounts the tab against
// mocked usePlanList/usePlanAttention + stubbed roster/activity fetches
// (useSyncQuery-family + nuqs mocked, the pinned sibling pattern — see
// AdvConversationsTab.test.tsx) and asserts the four tiles, the alerts badge,
// empty/error states, and the tile→tab click-through wiring.
// FleetRateControl is covered by its own test file and stubbed out here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// nuqs: writers only (tab / inboxTier). Stable per-key setter spies so the
// click-through wiring is assertable.
const nuqsState: Record<string, unknown> = { tab: null, inboxTier: null };
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

import AdvOverviewTab, { type OverviewRosterEntry } from './AdvOverviewTab';
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

const rosterEntry = (over: Partial<OverviewRosterEntry>): OverviewRosterEntry => ({
  ownerId: `o-${Math.random()}`,
  label: 'agent',
  intent: '',
  currentFiles: [],
  liveness: 'live',
  currentPlanSlug: null,
  role: null,
  agent: null,
  ...over,
});

describe('AdvOverviewTab component', () => {
  function stubOverviewFetch(opts: {
    roster?: unknown;
    activity?: unknown;
    rosterFail?: boolean;
  } = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/adv/roster')) {
          if (opts.rosterFail) return { ok: false, status: 500, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => (opts.roster ?? { active: [] }) };
        }
        if (String(url).includes('/api/agent-tools/activity/recent')) {
          return { ok: true, status: 200, json: async () => (opts.activity ?? { rows: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );
  }

  beforeEach(() => {
    nuqsState.tab = null;
    nuqsState.inboxTier = null;
    for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
    planListResult = { data: { plans: [] }, loading: false, error: null, refresh: vi.fn() };
    attentionResult = { data: { groups: [] }, loading: false, error: null, refresh: vi.fn() };
    stubOverviewFetch();
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
    await waitFor(() => expect(screen.getByText('No live agents')).toBeTruthy());
    expect(screen.getByText('No recent activity')).toBeTruthy();
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

  it('renders live roster agents and recent activity from the polled endpoints', async () => {
    stubOverviewFetch({
      roster: {
        active: [
          rosterEntry({ ownerId: 'o1', intent: 'wiring the sync query', role: 'worker' }),
          rosterEntry({ ownerId: 'o2', label: 'architect-1', intent: '', liveness: 'idle' }),
          rosterEntry({ ownerId: 'o3', intent: 'gone', liveness: 'stale' }),
        ],
      },
      activity: {
        rows: [
          {
            id: 'act1',
            agent: 'worker',
            harness_slug: 'papercup',
            kind: 'tool',
            tool_name: 'plans:list',
            summary: 'listed the plans',
            status: 'ok',
            created_at: '2026-06-10T00:00:00Z',
          },
        ],
      },
    });
    render(<AdvOverviewTab />);
    expect(await screen.findByText('wiring the sync query')).toBeTruthy();
    expect(screen.getByText('architect-1')).toBeTruthy(); // label fallback when no intent
    expect(screen.queryByText('gone')).toBeNull(); // stale filtered out
    // 'worker' appears as both the roster role tag and the activity actor
    expect(screen.getAllByText('worker').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('listed the plans')).toBeTruthy();
  });

  it('accepts the alternate activity result envelope ({ result: [...] })', async () => {
    stubOverviewFetch({
      activity: {
        result: [
          {
            id: 'act2',
            agent: 'queen',
            harness_slug: null,
            kind: 'lifecycle',
            tool_name: null,
            summary: 'woke up',
            status: null,
            created_at: '2026-06-10T00:00:00Z',
          },
        ],
      },
    });
    render(<AdvOverviewTab />);
    expect(await screen.findByText('woke up')).toBeTruthy();
  });

  it('shows a roster fetch failure in the Agents tile body', async () => {
    stubOverviewFetch({ rosterFail: true });
    render(<AdvOverviewTab />);
    expect(await screen.findByText('HTTP 500')).toBeTruthy();
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
