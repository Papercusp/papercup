// @vitest-environment jsdom
/**
 * SpendTab.test — the ONE workspace-wide cost surface (plan
 * left-sidebar-order-compaction-kettle-scope-2026-07-25, P-009).
 *
 * The tab exists because Blender / Docs / Agents each hand-picked an OVERLAPPING
 * role filter and presented the result as that pane's own cost — three different,
 * all-wrong answers (owner correction 2026-07-25: "Why is the spend tab inside
 * blender? is that showing only blender related spend? It looks like not."). So the
 * regressions worth pinning here are the ones that would quietly resurrect a wrong
 * NUMBER on screen:
 *   - the displayed total comes from the resolver's `spend7dTotalUsd`, never from
 *     re-summing the per-(role, modelClass) rows in the client;
 *   - no role filtering — every row the resolver returns is shown;
 *   - the money is ordered costliest-first, because the rail is short.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  catalogResult: { data: [] as unknown[], loading: false, error: null as unknown },
  queried: [] as { queryName: string; enabled?: boolean }[],
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean }) => {
    H.queried.push({ queryName: opts.queryName, enabled: opts.enabled });
    return { ...H.catalogResult, invalidate: () => {} };
  },
}));

import SpendTab, { rankSpend, turnsLabel, usd } from './SpendTab';

type Spend = {
  role: string;
  modelClass: string | null;
  turns: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  lastSeenAt: string | null;
};

const spend = (over: Partial<Spend> = {}): Spend => ({
  role: 'worker',
  modelClass: 'sonnet',
  turns: 120,
  outputTokens: 1000,
  cacheReadTokens: 5000,
  costUsd: 1.5,
  lastSeenAt: '2026-07-25T18:00:00.000Z',
  ...over,
});

function setCatalog(over: { spend7d?: Spend[]; spend7dTotalUsd?: number } | null) {
  H.catalogResult.data = over
    ? [{ routines: [], spend7d: over.spend7d ?? [], spend7dTotalUsd: over.spend7dTotalUsd ?? 0 }]
    : [];
}

beforeEach(() => {
  H.catalogResult = { data: [], loading: false, error: null };
  H.queried = [];
});
afterEach(cleanup);

describe('usd', () => {
  it('keeps cents below $100 so a small spend is not rounded to nothing', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(1.5)).toBe('$1.50');
    expect(usd(99.994)).toBe('$99.99');
  });

  it('drops cents at $100+ where they are noise in a narrow rail', () => {
    expect(usd(100)).toBe('$100');
    expect(usd(1234.56)).toBe('$1235');
  });
});

describe('turnsLabel', () => {
  it('shows exact counts below 1k', () => {
    expect(turnsLabel(0)).toBe('0');
    expect(turnsLabel(999)).toBe('999');
  });

  it('abbreviates with one decimal from 1k to 10k', () => {
    expect(turnsLabel(1000)).toBe('1.0k');
    expect(turnsLabel(9540)).toBe('9.5k');
  });

  it('drops the decimal from 10k up, so the column cannot blow out', () => {
    expect(turnsLabel(10_000)).toBe('10k');
    expect(turnsLabel(99_400)).toBe('99k');
    expect(turnsLabel(250_000)).toBe('250k');
  });
});

describe('rankSpend', () => {
  it('orders costliest first, breaking ties by role name', () => {
    const rows = [
      spend({ role: 'cup', costUsd: 2 }),
      spend({ role: 'mug', costUsd: 9 }),
      spend({ role: 'blender', costUsd: 2 }),
    ];
    expect(rankSpend(rows).map((r) => r.role)).toEqual(['mug', 'blender', 'cup']);
  });

  it('is pure — the caller memoises on the query result, so mutating it would corrupt the cache', () => {
    const rows = [spend({ role: 'a', costUsd: 1 }), spend({ role: 'b', costUsd: 5 })];
    const before = rows.map((r) => r.role);
    rankSpend(rows);
    expect(rows.map((r) => r.role)).toEqual(before);
  });
});

describe('<SpendTab />', () => {
  it('renders nothing and does not fetch when the tab is not active', () => {
    setCatalog({ spend7d: [spend()], spend7dTotalUsd: 1.5 });
    const { container } = render(<SpendTab active={false} />);
    expect(container.innerHTML).toBe('');
    expect(H.queried.at(-1)).toEqual({ queryName: 'automation.catalog', enabled: false });
  });

  it('shows the resolver total, NOT a client re-sum of the breakdown rows', () => {
    // The rows are a per-(role, modelClass) breakdown; the server computes the
    // authoritative figure. If this ever falls back to summing, the two disagree
    // on screen — exactly the class of wrong number this tab was created to end.
    setCatalog({
      spend7d: [spend({ role: 'worker', costUsd: 1 }), spend({ role: 'mug', costUsd: 2 })],
      spend7dTotalUsd: 42.5,
    });
    render(<SpendTab active />);
    expect(screen.getByTestId('spend-total').textContent).toBe('$42.50');
  });

  it('falls back to summing the rows only when the resolver omits the total', () => {
    H.catalogResult.data = [
      { routines: [], spend7d: [spend({ role: 'worker', costUsd: 1.25 }), spend({ role: 'mug', costUsd: 2.25 })] },
    ];
    render(<SpendTab active />);
    expect(screen.getByTestId('spend-total').textContent).toBe('$3.50');
  });

  it('lists EVERY role the resolver returns — no pane-local role filter', () => {
    setCatalog({
      spend7d: [
        spend({ role: 'scout', costUsd: 3 }),
        spend({ role: 'kettle', costUsd: 7 }),
        spend({ role: 'release-fixer', costUsd: 1 }),
      ],
      spend7dTotalUsd: 11,
    });
    render(<SpendTab active />);
    for (const role of ['scout', 'kettle', 'release-fixer']) {
      expect(screen.getByTestId(`spend-role-${role}`)).toBeTruthy();
    }
  });

  it('renders rows costliest-first with compact turns', () => {
    setCatalog({
      spend7d: [spend({ role: 'cup', costUsd: 2, turns: 4200 }), spend({ role: 'mug', costUsd: 9, turns: 12 })],
      spend7dTotalUsd: 11,
    });
    render(<SpendTab active />);
    const rows = screen.getAllByTestId(/^spend-role-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['spend-role-mug', 'spend-role-cup']);
    expect(rows[1].textContent).toContain('4.2k turns');
  });

  it('says so plainly when there is no usage, instead of showing an empty section', () => {
    setCatalog({ spend7d: [], spend7dTotalUsd: 0 });
    render(<SpendTab active />);
    expect(screen.getByText(/No recorded agent usage in the last 7 days\./)).toBeTruthy();
    expect(screen.getByTestId('spend-total').textContent).toBe('$0.00');
  });

  it('keeps the ROLE-not-routine attribution caveat on screen', () => {
    // Deleting this note is how a reader starts believing the breakdown attributes
    // cost to schedules — which the data cannot do.
    setCatalog({ spend7d: [spend()], spend7dTotalUsd: 1.5 });
    render(<SpendTab active />);
    expect(screen.getByText(/Grouped by agent ROLE, not by/)).toBeTruthy();
  });

  it('surfaces a query error rather than rendering a silent zero', () => {
    H.catalogResult = { data: [], loading: false, error: 'boom' };
    render(<SpendTab active />);
    expect(screen.getByRole('alert').textContent).toContain('boom');
  });
});
