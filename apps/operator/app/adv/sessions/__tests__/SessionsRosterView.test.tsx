/**
 * @vitest-environment jsdom
 *
 * SessionsRosterView (P-006) — the grouped rich-row live roster. Verifies the
 * grouping rule (plan / No-plan / presence-only with D-005 always-show) and that
 * the rendered rows carry the liveness dot, client/role/feature, intent, and
 * file chips, fed by a mocked /api/adv/roster.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import SessionsRosterView, { groupRoster, type RosterEntry } from '../SessionsRosterView';

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

describe('SessionsRosterView', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
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
      }),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('renders the plan group, presence-only group, intent + file chips, and the ended section', async () => {
    const { findByText, getByText } = render(<SessionsRosterView planFilters={[]} workspaceId="ws1" />);
    await findByText('dbos-retire'); // plan group header
    expect(getByText('worker')).toBeTruthy(); // role chip
    expect(getByText('F-012')).toBeTruthy(); // feature chip
    expect(getByText('refactoring attempt-claim')).toBeTruthy(); // intent line
    expect(getByText('attempt-claim.ts')).toBeTruthy(); // file basename chip
    expect(getByText('Other active agents (presence-only)')).toBeTruthy();
    expect(getByText('(no declared intent)')).toBeTruthy(); // the idle agent with no intent
    expect(getByText('Recently ended')).toBeTruthy();
  });

  it('scopes the fetch URL to the workspace', async () => {
    render(<SessionsRosterView planFilters={[]} workspaceId="ws9" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/adv/roster?workspace=ws9');
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
    // The dossier lazy-fetches /api/adv/roster/agent — branch the mock by URL.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/adv/roster/agent')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ownerId: 'a',
            locks: { held: [], waiting: [], error: null },
            coord: { lastMessage: null, unreadCount: 0, openHandoffs: [], openEscalations: [], error: null },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          active: [entry({ ownerId: 'a', label: 'worker-188', intent: 'doing X' })],
          ended: [],
        }),
      });
    });
    const { container, findByLabelText } = render(
      <SessionsRosterView planFilters={[]} selectedAgent="a" onSelectAgent={vi.fn()} />,
    );
    expect(await findByLabelText('Agent detail')).toBeTruthy();
    await waitFor(() =>
      expect(container.querySelector('[data-selected]')).toBeTruthy(),
    );
  });
});
