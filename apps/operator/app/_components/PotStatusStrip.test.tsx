// @vitest-environment jsdom
// PotStatusStrip — operator-chat-sidebar-revival-2026-07-13 P-018 (variant A).
// Pins the strip/panel contract: ambient strip from overwatch.snapshot +
// overwatch.liveness; the heavier mugBrief.floorView fetched ONLY while the
// panel is expanded; panel sections render the floor projection.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  potOpen: false,
  setPotOpen: vi.fn(),
  queries: {} as Record<string, { data?: unknown[]; enabled?: boolean }>,
}));

vi.mock('nuqs', () => ({
  useQueryState: () => [h.potOpen, h.setPotOpen],
  parseAsBoolean: { withDefault: () => ({}) },
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; enabled?: boolean }) => {
    h.queries[opts.queryName] = { ...(h.queries[opts.queryName] ?? {}), enabled: opts.enabled ?? true };
    if (opts.enabled === false) return { data: undefined };
    return { data: h.queries[opts.queryName]?.data };
  },
}));

import { PotStatusStrip, compactAge, compactCount } from './PotStatusStrip';

const NOW = Date.now();

function seedSnapshot(overrides: Record<string, unknown> = {}) {
  h.queries['overwatch.snapshot'] = {
    data: [
      {
        potSlug: 'papercusp',
        queen: { lastWakeAt: new Date(NOW - 2 * 60_000).toISOString(), stalled: false },
        bees: { running: 3 },
        workFeed: { frontier: 5 },
        plans: { agingEscalations: 1 },
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

function seedFloor() {
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
      },
    ],
  };
}

describe('PotStatusStrip (P-018 variant A)', () => {
  beforeEach(() => {
    h.potOpen = false;
    h.setPotOpen.mockClear();
    h.queries = {};
  });
  afterEach(() => cleanup());

  it('renders the ambient strip: Mug/Kettle ages, working + ready counts, need-you badge', () => {
    seedSnapshot();
    render(<PotStatusStrip />);
    // Role name + age are separate spans (variant-A mockup: emphasized who,
    // mono age — WI-4726 fidelity pass).
    expect(screen.getByText('Mug')).toBeTruthy();
    expect(screen.getByText('2m')).toBeTruthy();
    expect(screen.getByText('Kettle')).toBeTruthy();
    expect(screen.getByText('40s')).toBeTruthy();
    expect(screen.getByText('3 working')).toBeTruthy();
    expect(screen.getByText('5 ready')).toBeTruthy();
    // 1 non-info anomaly + 1 aging escalation — count lives in the pill,
    // the label beside it.
    expect(screen.getByTitle('2 need you').textContent).toBe('2 need you');
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('caps the need-you badge display at 99+ but keeps the honest count in aria-label + title (WI-4724)', () => {
    // 1 non-info anomaly + 268 aging escalations = 269
    seedSnapshot({ plans: { agingEscalations: 268 } });
    render(<PotStatusStrip />);
    // The pill shows only the capped count; the wrapper title + the strip
    // aria-label carry the honest total.
    expect(screen.getByText('99+')).toBeTruthy();
    expect(screen.getByTitle('269 need you').textContent).toBe('99+ need you');
    expect(
      screen.getByRole('button', { name: /269 need you/ }),
    ).toBeTruthy();
  });

  it('renders nothing while both overwatch queries are cold', () => {
    const { container } = render(<PotStatusStrip />);
    expect(container.innerHTML).toBe('');
  });

  it('does NOT fetch mugBrief.floorView while collapsed (enabled:false)', () => {
    seedSnapshot();
    render(<PotStatusStrip />);
    expect(h.queries['mugBrief.floorView']?.enabled).toBe(false);
  });

  it('clicking the strip toggles the nuqs pot state', () => {
    seedSnapshot();
    render(<PotStatusStrip />);
    fireEvent.click(screen.getByRole('button', { name: /pot status/i }));
    expect(h.setPotOpen).toHaveBeenCalledWith(true);
  });

  it('expanded: fetches the floor and renders attention, cups, up-next, steering', () => {
    seedSnapshot();
    seedFloor();
    h.potOpen = true;
    render(<PotStatusStrip />);
    expect(h.queries['mugBrief.floorView']?.enabled).toBe(true);
    // attention: anomaly + escalation merged
    expect(screen.getByText(/4 accounts at their 7-day wall/)).toBeTruthy();
    expect(screen.getByText('WI-4655 stranded')).toBeTruthy();
    // cups roster
    expect(screen.getByText('cup-a49e')).toBeTruthy();
    expect(screen.getByText('idle')).toBeTruthy();
    // up next + honest footer (the recovering count is its own amber span —
    // WI-4726 — so assert the footer's joined text content)
    expect(screen.getByText('WI-4665')).toBeTruthy();
    const foot = document.querySelector('.op-pot-foot');
    expect(foot?.textContent).toBe('+2 more · 2 blocked · 1 quarantined · 1 recovering ↻');
    // steering (the pause verdict is a <b> inside the fact span)
    expect(screen.getByText(/Focus the sidebar revival/)).toBeTruthy();
    const facts = document.querySelector('.op-pot-steer-facts');
    expect(facts?.textContent).toContain('New work: allowed');
  });
});

describe('compactCount', () => {
  it('passes small counts through and caps above 99 (WI-4724)', () => {
    expect(compactCount(1)).toBe('1');
    expect(compactCount(99)).toBe('99');
    expect(compactCount(100)).toBe('99+');
    expect(compactCount(269)).toBe('99+');
  });
});

describe('compactAge', () => {
  it('formats seconds, minutes, hours, days and handles null', () => {
    const now = 1_000_000_000_000;
    expect(compactAge(now - 40_000, now)).toBe('40s');
    expect(compactAge(now - 2 * 60_000, now)).toBe('2m');
    expect(compactAge(now - 3 * 3_600_000, now)).toBe('3h');
    expect(compactAge(now - 5 * 86_400_000, now)).toBe('5d');
    expect(compactAge(null, now)).toBe('—');
    expect(compactAge('not-a-date', now)).toBe('—');
  });
});
