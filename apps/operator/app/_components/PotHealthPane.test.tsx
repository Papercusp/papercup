// @vitest-environment jsdom
// PotHealthPane — WI-4778 (frozen v2 mockup): the full-height "what the Mug +
// Kettle decide from" view that replaces the chat body while 🫖 is on. Pins:
// the three reused sync queries (floorView + snapshot + liveness — no parallel
// data path), the chips digest, the ☕ Mug cards (frontier / cups / placements
// & capacity / escalations & steering incl. the WI-4778 carryNote + capacity
// floor-view extension), the 🌡 Kettle cards (health panels / anomalies→action
// / cross-monitor / observations), and the honest empty/loading states.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queries: {} as Record<string, { data?: unknown[] }>,
  queryNames: [] as string[],
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string }) => {
    h.queryNames.push(opts.queryName);
    return { data: h.queries[opts.queryName]?.data };
  },
}));

import { PotHealthPane } from './PotHealthPane';

const NOW = Date.now();

function seedSnapshot(overrides: Record<string, unknown> = {}) {
  h.queries['overwatch.snapshot'] = {
    data: [
      {
        potSlug: 'papercusp',
        wokeBy: 'timer',
        queen: {
          started: true,
          lastWakeAt: new Date(NOW - 2 * 60_000).toISOString(),
          stalled: false,
          cadenceOk: true,
          workingTracked: 2,
          nextFireAt: null,
          coordOwner: null,
          consecutiveZeroTokenWakes: 0,
        },
        bees: { running: 3, completed: 7, churning: 0, deadClaims: 0, invalidModelFailures: 0 },
        workFeed: { frontier: 5, autoEligibleStuck: 0, deadRoutines: 0, blockedStranded: 0 },
        tokens: {
          pausedBuckets: [],
          gatewayFailovers: 0,
          gw429s: 0,
          accountsAvailable: 4,
          gatewayWedged: false,
          gatewaySustainedThrottle: false,
          gatewayAdmissionStarved: false,
        },
        plans: { active: 2, stalledItems: 0, agingEscalations: 1 },
        observations: { laneCount: 3, recentByRole: { queen: 1, worker: 2 } },
        crossMonitor: { queenAlive: true, overwatchAlive: true },
        ownerSteering: { pauseNewWork: false, pausedUntil: null, eligiblePlans: [] },
        anomalies: [
          {
            kind: 'gateway-throttle',
            severity: 'warning',
            subject: 'gateway',
            detail: '4 accounts at their 7-day wall',
            suggestedAction: { type: 'escalate' },
          },
        ],
        ...overrides,
      },
    ],
  };
  h.queries['overwatch.liveness'] = {
    data: [{ lastRunAt: new Date(NOW - 40_000).toISOString(), alive: true }],
  };
}

function seedFloor(overrides: Record<string, unknown> = {}) {
  h.queries['mugBrief.floorView'] = {
    data: [
      {
        potSlug: 'papercusp',
        computedAt: NOW,
        cups: [
          { id: 'cup-a49e', doing: 'WI-4662 fleet-spec live e2e verify', load: 2, alive: true },
          { id: 'cup-12d7', doing: null, load: 0, alive: false },
        ],
        frontier: [
          { id: 'WI-4665', title: 'Durable CTRL anchor', view: 'work-item', harness: 'papercusp' },
        ],
        frontierTotal: 3,
        frontierBlocked: 2,
        frontierQuarantined: 1,
        openPlacements: { recovering: 1, stranded: 0, workingTracked: 2 },
        escalations: [{ id: 'escalation:m1', severity: 'critical', summary: 'WI-4655 stranded' }],
        steering: {
          directive: 'Focus the sidebar revival',
          pauseNewWork: false,
          pausedUntil: null,
          eligiblePlans: ['operator-chat-sidebar-revival'],
        },
        capacity: {
          factor: 0.62,
          dispatchBudget: 5,
          utilizationPct: 38,
          paused: false,
          advice: 'place broadly',
        },
        carryNote: { at: NOW - 5 * 60_000, note: 'resume major-bug lane after canary' },
        ...overrides,
      },
    ],
  };
}

describe('PotHealthPane (WI-4778)', () => {
  beforeEach(() => {
    h.queries = {};
    h.queryNames = [];
    // Pin the clock to the fixture's NOW (WI-5506): compactAge() defaults to
    // the REAL Date.now() at render time, not a mocked clock — under a fast
    // run the gap between module-load NOW and this test's render/assert stays
    // under a rounding boundary (e.g. 40s->41s), but under heavy fleet load
    // enough wall-clock time can pass to tip a relative-age assertion over
    // that boundary and flake. Freezing time removes the whole class of
    // wall-clock-vs-fixed-NOW flakes for every relative-age assertion here.
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('reads the three REUSED sync queries — no parallel data path', () => {
    seedSnapshot();
    seedFloor();
    render(<PotHealthPane />);
    expect(h.queryNames).toContain('mugBrief.floorView');
    expect(h.queryNames).toContain('overwatch.snapshot');
    expect(h.queryNames).toContain('overwatch.liveness');
  });

  it('renders a loading placeholder while every query is cold', () => {
    render(<PotHealthPane />);
    expect(screen.getByText('Loading pot health…')).toBeTruthy();
  });

  it('chips digest: Mug/Kettle ages, working, ready, accounts, need-you', () => {
    seedSnapshot();
    seedFloor();
    render(<PotHealthPane />);
    expect(screen.getByText('Mug 2m')).toBeTruthy();
    expect(screen.getByText('Kettle 40s')).toBeTruthy();
    expect(screen.getByText('3 working')).toBeTruthy();
    expect(screen.getByText('5 ready')).toBeTruthy();
    // Appears in the chips AND the kettle tokens kv — both are correct.
    expect(screen.getAllByText('4 accounts up').length).toBeGreaterThan(0);
    // 1 warning anomaly + 1 aging escalation + 1 open floor escalation = 3.
    expect(screen.getByText('3 need you')).toBeTruthy();
  });

  it('☕ Mug section (below the Kettle — owner order 2026-07-14) renders her REAL floor: frontier, cups, placements & capacity, escalations & steering + carry-note', () => {
    seedSnapshot();
    seedFloor();
    render(<PotHealthPane />);
    // Section rubric.
    expect(screen.getByText('What the Mug looks at')).toBeTruthy();
    // Frontier card: rows + honest counts.
    expect(screen.getByText('WI-4665')).toBeTruthy();
    expect(screen.getByText('3 ready · 2 blocked · 1 quarantined')).toBeTruthy();
    expect(screen.getByText('+2 more in rank order')).toBeTruthy();
    // Cups card.
    expect(screen.getByText('cup-a49e')).toBeTruthy();
    expect(screen.getByText('idle')).toBeTruthy();
    // Placements & capacity (the WI-4778 floor-view extension).
    expect(screen.getByText('2 working · 1 recovering · 0 stranded')).toBeTruthy();
    expect(screen.getByText('62% headroom · 38% used')).toBeTruthy();
    expect(screen.getByText('5 spare cup slots')).toBeTruthy();
    expect(screen.getByText('place broadly')).toBeTruthy();
    // Escalations & steering + the carry-note.
    expect(screen.getByText(/WI-4655 stranded/)).toBeTruthy();
    expect(screen.getByText(/Focus the sidebar revival/)).toBeTruthy();
    expect(screen.getByText(/resume major-bug lane after canary/)).toBeTruthy();
  });

  it('a dark gateway renders the honest no-capacity line, never a fake meter', () => {
    seedSnapshot();
    seedFloor({ capacity: null, carryNote: null });
    render(<PotHealthPane />);
    expect(screen.getByText('no capacity read (gateway unreachable)')).toBeTruthy();
    expect(screen.queryByText(/carry-note:/)).toBeNull();
  });

  it('🌡 Kettle section renders its REAL brief: health panels, anomalies→action, cross-monitor, observations', () => {
    seedSnapshot();
    seedFloor();
    render(<PotHealthPane />);
    expect(screen.getByText('What the Kettle looks at')).toBeTruthy();
    // Health panels (kv rows off the real brief fields).
    expect(screen.getByText(/on cadence · woke 2m ago · driving 2/)).toBeTruthy();
    expect(screen.getByText('3 running · 7 completed · 0 churning · 0 dead claims')).toBeTruthy();
    expect(screen.getByText('5 ready · 0 stuck · 0 dead routines · 0 stranded')).toBeTruthy();
    expect(screen.getAllByText('4 accounts up').length).toBeGreaterThan(0);
    expect(screen.getByText('2 active · 0 stalled items · 1 aging escalations')).toBeTruthy();
    // Anomalies with the suggested-action chip.
    expect(screen.getByText(/4 accounts at their 7-day wall/)).toBeTruthy();
    expect(screen.getByText('ESCALATE')).toBeTruthy();
    // Cross-monitor & wake.
    expect(screen.getByText(/yes · last run 40s ago/)).toBeTruthy();
    expect(screen.getByText('timer')).toBeTruthy();
    expect(screen.getByText('new work allowed')).toBeTruthy();
    // Observations by role.
    expect(screen.getByText('3 recorded')).toBeTruthy();
    expect(screen.getByText('queen')).toBeTruthy();
  });

  it('anomaly-free kettle renders the healthy empty state', () => {
    seedSnapshot({ anomalies: [] });
    seedFloor({ escalations: [] });
    render(<PotHealthPane />);
    expect(screen.getByText('none — system healthy')).toBeTruthy();
    expect(screen.getByText('no open escalations')).toBeTruthy();
  });
});
