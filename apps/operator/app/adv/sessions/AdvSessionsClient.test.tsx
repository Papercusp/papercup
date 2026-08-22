// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const row = (id: number, planSlug = 'bulk-plan') => ({
    id,
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    planSlug,
    agent: 'codex' as const,
    role: 'engineer',
    feature: null,
    mode: 'console' as const,
    terminalBin: 'bash',
    pid: null,
    windowId: null,
    ompThreadId: null,
    label: `session-${id}`,
    startedAt: `2026-08-22T07:${String(id).padStart(2, '0')}:00.000Z`,
    endedAt: '2026-08-22T08:00:00.000Z',
    exitCode: 0,
    summary: null,
  });
  const firstPage = [
    { ...row(3), _meta: { nextCursor: 'cursor-2', hasMore: true } },
    row(2),
  ];
  const secondPage = [
    { ...row(1), _meta: { nextCursor: null, hasMore: false } },
  ];
  const summary = {
    total: 15_050,
    matched: 15_050,
    facets: [
      {
        key: 'plan',
        label: 'Plan',
        values: [
          { value: 'bulk-plan', count: 12_000, meta: { active: 23 } },
          { value: '__no_plan__', count: 3_050, meta: { active: 0 } },
        ],
        hiddenValueCount: 0,
        distinctCount: 2,
      },
      {
        key: 'harness',
        label: 'Harness',
        values: [
          { value: 'papercusp', count: 314 },
          { value: 'another-pot', count: 14_736 },
        ],
        hiddenValueCount: 0,
        distinctCount: 2,
      },
    ],
  };
  const invalidateRows = vi.fn();
  const invalidateSummary = vi.fn();
  const useSyncQuery = vi.fn(
    ({ queryName, args }: { queryName: string; args?: { cursor?: string; harnessSlugs?: string[] } }) => {
      const harness = args?.harnessSlugs?.[0];
      if (queryName === 'advSessions.summary') {
        const data = harness === 'missing-pot'
          ? [{
              ...summary,
              matched: 0,
              facets: summary.facets.map((facet) =>
                facet.key === 'harness'
                  ? {
                      ...facet,
                      values: [
                        ...facet.values,
                        { value: 'missing-pot', count: 0 },
                      ],
                    }
                  : { ...facet, values: [] },
              ),
            }]
          : harness === 'papercusp'
            ? [{ ...summary, matched: 314 }]
            : [summary];
        return {
          data,
          loading: false,
          fetching: false,
          error: null,
          invalidate: invalidateSummary,
        };
      }
      return {
        data:
          harness === 'missing-pot'
            ? []
            : args?.cursor
              ? secondPage
              : firstPage,
        loading: false,
        fetching: false,
        error: null,
        invalidate: invalidateRows,
      };
    },
  );
  return { firstPage, secondPage, summary, useSyncQuery };
});

vi.mock('@papercusp/sync', () => ({ useSyncQuery: h.useSyncQuery }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({
  launchAgent: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../admin/plans/plans-api', () => ({
  usePlanList: () => ({ data: { plans: [] }, loading: false }),
}));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean }) =>
    key === 'pot' ? (opts?.plural ? 'pots' : 'pot') : key,
}));
vi.mock('@/app/harness/Combobox', () => ({
  Combobox: ({ ariaLabel, value }: { ariaLabel?: string; value: string }) => (
    <select aria-label={ariaLabel} value={value} onChange={() => {}}>
      <option value={value}>{value}</option>
    </select>
  ),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    ariaLabel,
    value,
    onChange,
    options,
  }: {
    ariaLabel?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import AdvSessionsClient, {
  mergeAdvSessionPage,
  type SessionRow,
} from './AdvSessionsClient';

function renderClient(searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <AdvSessionsClient />
    </NuqsTestingAdapter>,
  );
}

afterEach(() => {
  cleanup();
  h.useSyncQuery.mockClear();
});

describe('AdvSessionsClient corpus evidence', () => {
  it('uses paired server queries, exact group facets, and cursor-appended shown/total copy', async () => {
    renderClient();

    await waitFor(() => {
      expect(screen.getByTestId('sessions-history-count').textContent).toBe(
        'Showing 2 of 15,050 sessions',
      );
    });
    expect(
      screen.getByLabelText('12,000 sessions in the bulk-plan plan group'),
    ).toBeTruthy();
    expect(screen.getByText('23 active')).toBeTruthy();
    expect(
      screen.getByRole('option', { name: 'papercusp · 314 sessions' }),
    ).toBeTruthy();
    expect(h.useSyncQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryName: 'advSessions.list',
        args: { limit: 100 },
      }),
    );
    expect(h.useSyncQuery).toHaveBeenCalledWith({
      queryName: 'advSessions.summary',
      args: {},
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
    await waitFor(() => {
      expect(screen.getByTestId('sessions-history-count').textContent).toBe(
        'Showing 3 of 15,050 sessions',
      );
    });
    expect(h.useSyncQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryName: 'advSessions.list',
        args: { limit: 100, cursor: 'cursor-2' },
      }),
    );
  });

  it('renders an exact zero-match state with a one-click filter reset', async () => {
    renderClient('?h=missing-pot');

    await waitFor(() => {
      expect(screen.getByText('No sessions match missing-pot.')).toBeTruthy();
    });
    expect(screen.getByTestId('sessions-history-count').textContent).toBe(
      'Showing 0 of 0 sessions · 0 of 15,050 match in workspace history',
    );
    expect(h.useSyncQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryName: 'advSessions.summary',
        args: { harnessSlugs: ['missing-pot'] },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show all sessions' }));
    await waitFor(() => {
      expect(screen.getByTestId('sessions-history-count').textContent).toBe(
        'Showing 2 of 15,050 sessions',
      );
    });
  });
});

describe('mergeAdvSessionPage', () => {
  it('replaces page one and appends cursor pages without duplicate ledger ids', () => {
    const first = h.firstPage as unknown as SessionRow[];
    expect(mergeAdvSessionPage([], first, null)).toEqual(first);
    const merged = mergeAdvSessionPage(
      first,
      [
        { ...first[1]!, label: 'updated' },
        h.secondPage[0] as unknown as SessionRow,
      ],
      'cursor-2',
    );
    expect(merged.map((row) => row.id)).toEqual([3, 2, 1]);
    expect(merged[1]?.label).toBe('updated');
  });
});
