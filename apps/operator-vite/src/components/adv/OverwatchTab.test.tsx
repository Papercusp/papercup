// @vitest-environment jsdom
/**
 * OverwatchTab.test — B-08 pane (overwatch-role-2026-06-15).
 *
 * Renders the pane off mocked `overwatch.snapshot` + `overwatch.controlState`
 * sync queries and asserts: the control header reflects the started/flag state,
 * the anomaly list renders kind + action verb, the health panels render, the
 * severity filter is URL-backed (writes the `owsev` nuqs param), and the empty
 * state renders when no brief has arrived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  snapshotResult: { data: [] as unknown[], loading: false, error: null as unknown },
  controlResult: { data: [] as unknown[], loading: false, error: null as unknown },
  nuqsState: { owsev: 'all' } as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('nuqs', () => ({
  useQueryState: (key: string) => {
    const setter = (H.nuqsSetters[key] ??= vi.fn((v: unknown) => {
      H.nuqsState[key] = v;
    }));
    return [H.nuqsState[key], setter];
  },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string }) =>
    opts.queryName === 'overwatch.snapshot' ? H.snapshotResult : H.controlResult,
}));

import OverwatchTab from './OverwatchTab';

const brief = {
  hiveSlug: 'papercup-hive',
  queen: { lastWakeAt: '2026-06-15T09:00:00.000Z', stalled: true, cadenceOk: false, workingTracked: 2, nextFireAt: '2026-06-15T10:00:00.000Z' },
  bees: { running: 3, completed: 0, churning: 1, deadClaims: 0 },
  workFeed: { frontier: 5, autoEligibleStuck: 0, deadRoutines: 1, blockedStranded: 2 },
  tokens: { pausedBuckets: ['opus'], gatewayFailovers: 0, gw429s: 0, accountsAvailable: 0 },
  plans: { active: 4, stalledItems: 1, agingEscalations: 2 },
  observations: { laneCount: 7, recentByRole: { queen: 3, worker: 4 } },
  crossMonitor: { queenAlive: true, overwatchAlive: false },
  anomalies: [
    { kind: 'queen-stalled', severity: 'critical', subject: 'queen', detail: 'Queen stalled past cadence.', suggestedAction: { type: 'nudge', target: 'queen', message: 'wake up' } },
    { kind: 'token-paused', severity: 'warning', subject: 'token buckets', detail: 'opus paused.', suggestedAction: { type: 'observe', message: 'watching' } },
  ],
};

const control = {
  hiveSlug: 'papercup-hive',
  started: true,
  cadenceSec: 600,
  flagEnabled: true,
  armed: true,
  nextWakeAt: '2026-06-15T10:00:00.000Z',
  lastWakeAt: '2026-06-15T09:00:00.000Z',
  staleForMs: 3_600_000,
};

beforeEach(() => {
  H.snapshotResult = { data: [brief], loading: false, error: null };
  H.controlResult = { data: [control], loading: false, error: null };
  H.nuqsState = { owsev: 'all' };
  H.nuqsSetters = {};
});
afterEach(cleanup);

describe('OverwatchTab', () => {
  it('renders the running header, anomalies (kind + verb), and health panels', () => {
    render(<OverwatchTab />);

    expect(screen.getByText('Overwatch running')).toBeTruthy();
    // anomalies, most-severe-first
    expect(screen.getByText('queen-stalled')).toBeTruthy();
    expect(screen.getByText('token-paused')).toBeTruthy();
    // the action verb + target off suggestedAction (D-001 nudge-not-replace)
    expect(screen.getByText('NUDGE queen')).toBeTruthy();
    expect(screen.getByText('OBSERVE')).toBeTruthy();
    // a health panel renders
    expect(screen.getByText('Work feed')).toBeTruthy();
    expect(screen.getByText('Cross-monitor')).toBeTruthy();
  });

  it('shows PRE-ARMED when started but the flag is off', () => {
    H.controlResult = { data: [{ ...control, flagEnabled: false }], loading: false, error: null };
    render(<OverwatchTab />);
    expect(screen.getByText('Pre-armed — flag off')).toBeTruthy();
  });

  it('writes the owsev nuqs param when a severity chip is clicked', () => {
    render(<OverwatchTab />);
    fireEvent.click(screen.getByRole('button', { name: 'critical' }));
    expect(H.nuqsSetters['owsev']).toHaveBeenCalledWith('critical');
  });

  it('renders the empty state when no brief has arrived', () => {
    H.snapshotResult = { data: [], loading: false, error: null };
    render(<OverwatchTab />);
    expect(screen.getByText('Overwatch is disabled.')).toBeTruthy();
  });
});
