// @vitest-environment jsdom
// PotStatusStrip — operator-chat-sidebar-revival-2026-07-13 P-018 (variant A),
// slimmed by WI-4778: the strip is the ambient one-line digest ONLY (snapshot +
// liveness); its click opens the full-height Pot Health view (?opcv=pot — the
// fold-out panel and its mugBrief.floorView fetch are gone; PotHealthPane owns
// the detail surface and its own tests).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setView: vi.fn(),
  queries: {} as Record<string, { data?: unknown[]; enabled?: boolean }>,
  queryNames: [] as string[],
}));

vi.mock('nuqs', () => ({
  useQueryState: () => ['chat', h.setView],
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; enabled?: boolean }) => {
    h.queryNames.push(opts.queryName);
    if (opts.enabled === false) return { data: undefined };
    return { data: h.queries[opts.queryName]?.data };
  },
}));

import { PotStatusStrip, compactAge, compactCount, splitLeadingWi } from './PotStatusStrip';

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

describe('PotStatusStrip (P-018 variant A, WI-4778 strip-only)', () => {
  beforeEach(() => {
    h.setView.mockClear();
    h.queries = {};
    h.queryNames = [];
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
    expect(screen.getByRole('button', { name: /269 need you/ })).toBeTruthy();
  });

  it('renders nothing while both overwatch queries are cold', () => {
    const { container } = render(<PotStatusStrip />);
    expect(container.innerHTML).toBe('');
  });

  it('does NOT fetch mugBrief.floorView at all (WI-4778 — the fold-out panel is gone)', () => {
    seedSnapshot();
    render(<PotStatusStrip />);
    expect(h.queryNames).not.toContain('mugBrief.floorView');
  });

  it('clicking the strip opens the Pot Health view (?opcv=pot — the 🫖 target, WI-4778)', () => {
    seedSnapshot();
    render(<PotStatusStrip />);
    fireEvent.click(screen.getByRole('button', { name: /pot status/i }));
    expect(h.setView).toHaveBeenCalledWith('pot');
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

describe('splitLeadingWi', () => {
  it('splits a leading work-item id off a doing line, passthrough otherwise', () => {
    expect(splitLeadingWi('WI-4662 fleet-spec live e2e verify')).toEqual({
      wi: 'WI-4662',
      rest: 'fleet-spec live e2e verify',
    });
    expect(splitLeadingWi('idle sweep')).toEqual({ wi: null, rest: 'idle sweep' });
  });
});
