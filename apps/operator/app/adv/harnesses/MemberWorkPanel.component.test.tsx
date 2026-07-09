// @vitest-environment jsdom
/**
 * MemberWorkPanel (adv:member-work) — the per-user work dashboard for a shared hive
 * (shared-hive-collaboration-2026-06-14 P-010, Brief B10). Reads the live
 * `hiveRoster.byHarness` roster and groups it by HIVE MEMBER (a federated github
 * participant, or this machine), showing each member's agents + head-of-line work + load +
 * liveness. The component + its `groupByMember` bucketing landed under D-004 (su-2ab53);
 * this is the missing component-render test (the brief's "tests" criterion) — it drives a
 * mocked `useSyncQuery` over the contracted {doing, queued, load, orphaned} shape and
 * asserts the rendered surface + the empty/filter states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
// The app shell mounts the Radix TooltipProvider once at the route root; the panel's
// refresh-button Tooltip needs it in the test too.
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import type { WorkingAgent } from './AdvAgentsPanel';

const { syncResults, syncCalls } = vi.hoisted(() => ({
  syncResults: {} as Record<string, unknown[]>,
  syncCalls: [] as Array<{ queryName: string; enabled?: boolean; args?: unknown }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: unknown }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    return {
      data: enabled ? (syncResults[opts.queryName] ?? []) : [],
      loading: false,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));

import MemberWorkPanel from './MemberWorkPanel';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(syncResults)) delete syncResults[k];
  syncCalls.length = 0;
});

const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 10 * 60_000).toISOString();

function agent(over: Partial<WorkingAgent> & Pick<WorkingAgent, 'agentId'>): WorkingAgent {
  return {
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: NOW,
    intent: '',
    claims: [],
    orphaned: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    agentPaneKind: 'su',
    driveMode: 'auto',
    ...over,
  };
}

// Two members: LOCAL ("This machine") with a working + an idle agent, and a FEDERATED
// github member (agentId `fed:<userKey>@<host>`) reviewing a PR.
const ROSTER: WorkingAgent[] = [
  agent({ agentId: 'su-local-1', name: 'Worker A', load: 2, claims: [{ id: 'P-010', type: 'plan-item', detail: '' }], doing: { id: 'P-010', title: 'per-user dashboard', rank: null } }),
  agent({ agentId: 'su-local-2', name: 'Worker B', alive: false, heartbeatAt: OLD, agentPaneKind: 'cup', doing: null, intent: '' }),
  agent({ agentId: 'fed:279242982@laptop-x', label: 'gh:279242982 · laptop-x', name: 'Remote One', load: 1, agentPaneKind: 'mug', claims: [{ id: 'F-1', type: 'feature', detail: '' }], doing: { id: 'F-1', title: 'review the PR', rank: null } }),
];

const api = { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() } as unknown as React.ComponentProps<typeof MemberWorkPanel>['api'];
// PanelComponentProps requires panelId + panelType; MemberWorkPanel ignores them (reads params/api).
const PANEL = { panelId: 'test-panel', panelType: 'adv:member-work' } as const;

function renderPanel(searchParams = '', roster: WorkingAgent[] | undefined = ROSTER) {
  if (roster) syncResults['hiveRoster.byHarness'] = roster;
  return render(
    <TooltipProvider>
      <NuqsTestingAdapter searchParams={searchParams}>
        <MemberWorkPanel {...PANEL} params={{ harnessSlug: 'demo-hive' }} api={api} />
      </NuqsTestingAdapter>
    </TooltipProvider>,
  );
}

describe('MemberWorkPanel (adv:member-work)', () => {
  it('groups the roster by member: local "you" + a federated github member, each with their work', async () => {
    renderPanel();

    // Both members render.
    await waitFor(() => screen.getByText('This machine'));
    expect(screen.getByText('gh:279242982')).toBeTruthy();
    // The local member carries the "you" badge; the federated one carries its host.
    expect(screen.getByText('you')).toBeTruthy();
    expect(screen.getAllByText('laptop-x').length).toBeGreaterThan(0);

    // Head-of-line work renders per agent (item id + title).
    expect(screen.getByText('per-user dashboard')).toBeTruthy();
    expect(screen.getByText('P-010')).toBeTruthy();
    expect(screen.getByText('review the PR')).toBeTruthy();
    expect(screen.getByText('Worker A')).toBeTruthy();
    expect(screen.getByText('Remote One')).toBeTruthy();

    // An agent with no `doing` shows the idle affordance.
    expect(screen.getByText('Worker B')).toBeTruthy();
    expect(screen.getAllByText('idle').length).toBeGreaterThan(0);

    // The data source is the contracted hiveRoster.byHarness query, enabled for the slug.
    expect(syncCalls.some((c) => c.queryName === 'hiveRoster.byHarness' && c.enabled === true)).toBe(true);
  });

  it('shows the empty affordance when no members are working in the hive', async () => {
    renderPanel('', []);
    await waitFor(() => screen.getByText(/No members working in demo-hive/i));
  });

  it('filters by the ?mwq query — narrows to matching members/agents, else the "no match" empty state', async () => {
    // Filter matches Remote One's work ("review the PR") → only the federated member shows.
    renderPanel('?mwq=review');
    await waitFor(() => screen.getByText('Remote One'));
    expect(screen.queryByText('Worker A')).toBeNull();
    expect(screen.getByText('gh:279242982')).toBeTruthy();
    expect(screen.queryByText('This machine')).toBeNull();

    cleanup();
    // A non-matching filter → the "no members match" empty state.
    renderPanel('?mwq=zzz-no-such-thing');
    await waitFor(() => screen.getByText(/No members match the filter/i));
  });

  it('disables the query when there is no harness slug', async () => {
    render(
      <NuqsTestingAdapter searchParams="">
        <MemberWorkPanel {...PANEL} params={{}} api={api} />
      </NuqsTestingAdapter>,
    );
    await waitFor(() => screen.getByText(/No harness slug/i));
    // enabled:false (Boolean('') === false) → no fetch fired for the roster.
    expect(syncCalls.some((c) => c.queryName === 'hiveRoster.byHarness' && c.enabled === false)).toBe(true);
  });
});
