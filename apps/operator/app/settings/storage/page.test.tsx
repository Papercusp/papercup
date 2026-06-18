// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks (hoisted) ───────────────────────────────────────────────────── */
const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  doTrim: vi.fn(async () => ({
    ok: true,
    removed: 5,
    reclaimedBytes: 1234,
    reclaimEstimated: true,
    vacuumed: false,
    dryRun: false,
  })),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: h.rows, loading: false, error: null }),
  useSyncMutate: () => h.doTrim,
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock('nuqs', async () => {
  const React = await import('react');
  const useQueryState = (_key: string, parser?: { defaultValue?: unknown }) => {
    const [v, setV] = React.useState(parser && 'defaultValue' in parser ? parser.defaultValue : null);
    return [v, async (nv: unknown) => setV(nv ?? null)];
  };
  return {
    useQueryState,
    parseAsString: {},
    parseAsStringEnum: (_vals: unknown) => ({ withDefault: (d: unknown) => ({ defaultValue: d }) }),
  };
});

import StorageSettingsPage from './page';

function pgRow(over: Record<string, unknown> = {}) {
  return {
    id: 'route-invocations',
    label: 'HTTP route telemetry',
    kind: 'pg',
    federation: 'local-diagnostic',
    trimmable: true,
    bloats: false,
    totalBytes: 5_000_000,
    totalRows: 26_000_000,
    ageBuckets: [
      { olderThanDays: 30, rows: 60, bytes: 600 },
      { olderThanDays: 90, rows: 30, bytes: 375 },
      { olderThanDays: 365, rows: 10, bytes: 100 },
      { olderThanDays: null, rows: 80, bytes: 1000 },
    ],
    ageColumnType: 'timestamptz',
    description: 'route telemetry',
    ...over,
  };
}
function fedRow(over: Record<string, unknown> = {}) {
  return {
    id: 'plans',
    label: 'Plans',
    kind: 'pg',
    federation: 'federated',
    trimmable: false,
    bloats: false,
    totalBytes: 80_000_000,
    totalRows: 500,
    ageBuckets: [],
    description: 'plans federate',
    ...over,
  };
}

beforeEach(() => {
  h.rows = [pgRow(), fedRow()];
  h.doTrim.mockClear();
});
afterEach(() => cleanup());

describe('Storage settings page', () => {
  it('renders a card per category', () => {
    render(<StorageSettingsPage />);
    expect(screen.getByRole('heading', { name: 'Storage' })).toBeTruthy();
    expect(screen.getByTestId('storage-cat-route-invocations')).toBeTruthy();
    expect(screen.getByTestId('storage-cat-plans')).toBeTruthy();
  });

  it('shows trim presets for trimmable categories, read-only warning for federated', () => {
    render(<StorageSettingsPage />);
    expect(screen.getByTestId('trim-route-invocations-90')).toBeTruthy();
    expect(screen.getByTestId('trim-route-invocations-all')).toBeTruthy();
    // federated → no trim chips, a read-only warning instead.
    expect(screen.queryByTestId('trim-plans-90')).toBeNull();
    expect(screen.getByText(/Read-only — federated/i)).toBeTruthy();
  });

  it('opens a confirm dialog with the projected reclaim from the buckets', () => {
    render(<StorageSettingsPage />);
    fireEvent.click(screen.getByTestId('trim-route-invocations-90'));
    expect(screen.getByTestId('trim-dialog')).toBeTruthy();
    // 375 bytes older than 90d, 30 rows.
    expect(screen.getByTestId('trim-projection').textContent).toMatch(/375 B/);
    expect(screen.getByTestId('trim-projection').textContent).toMatch(/30 rows/);
  });

  it('confirming trims via the mutation with the chosen age', async () => {
    render(<StorageSettingsPage />);
    fireEvent.click(screen.getByTestId('trim-route-invocations-90'));
    fireEvent.click(screen.getByTestId('trim-confirm'));
    await waitFor(() =>
      expect(h.doTrim).toHaveBeenCalledWith({ category: 'route-invocations', olderThanDays: 90 }),
    );
  });

  it('"trim all" targets the null=total bucket (olderThanDays null)', async () => {
    render(<StorageSettingsPage />);
    fireEvent.click(screen.getByTestId('trim-route-invocations-all'));
    expect(screen.getByTestId('trim-projection').textContent).toMatch(/1000 B|1.0 KB|1 KB/);
    fireEvent.click(screen.getByTestId('trim-confirm'));
    await waitFor(() =>
      expect(h.doTrim).toHaveBeenCalledWith({ category: 'route-invocations', olderThanDays: null }),
    );
  });
});
