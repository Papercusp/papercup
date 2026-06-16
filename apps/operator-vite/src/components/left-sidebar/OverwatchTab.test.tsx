// @vitest-environment jsdom
/**
 * OverwatchTab.test (left sidebar) — the relocated, trimmed Overwatch panel
 * (system-health-tab-2026-06-15 P-008; overwatch-role-2026-06-15 B-08).
 *
 * Asserts the UNIQUE content survived the /adv→sidebar move: the control header
 * reflects started/flag state, the anomaly→action list renders kind + verb
 * (most-severe-first), the severity filter is URL-backed (`owsev`), and the
 * empty/dark state renders. The duplicated health-panel grid is GONE (it lives
 * on the Health tab) — so we also assert those panel labels no longer render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  queen: { lastWakeAt: '2026-06-15T09:00:00.000Z', stalled: true, cadenceOk: false, workingTracked: 2, nextFireAt: '2026-06-15T10:00:00.000Z', coordOwner: null },
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

describe('OverwatchTab (sidebar)', () => {
  it('renders the running header + anomaly→action list (kind + verb, most-severe-first)', () => {
    render(<OverwatchTab active />);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('queen-stalled')).toBeTruthy();
    expect(screen.getByText('token-paused')).toBeTruthy();
    expect(screen.getByText('NUDGE queen')).toBeTruthy();
    expect(screen.getByText('OBSERVE')).toBeTruthy();
  });

  it('does NOT render the duplicated health-panel grid (moved to the Health tab)', () => {
    render(<OverwatchTab active />);
    expect(screen.queryByText('Work feed')).toBeNull();
    expect(screen.queryByText('Cross-monitor')).toBeNull();
    expect(screen.queryByText('System health')).toBeNull();
  });

  it('shows Pre-armed when started but the flag is off', () => {
    H.controlResult = { data: [{ ...control, flagEnabled: false }], loading: false, error: null };
    render(<OverwatchTab active />);
    expect(screen.getByText('Pre-armed')).toBeTruthy();
  });

  it('writes the owsev nuqs param when a severity chip is clicked', () => {
    render(<OverwatchTab active />);
    fireEvent.click(screen.getByRole('button', { name: 'critical' }));
    expect(H.nuqsSetters['owsev']).toHaveBeenCalledWith('critical');
  });

  it('renders the dark/empty state when inactive or no brief has arrived', () => {
    render(<OverwatchTab active={false} />);
    expect(screen.getByText(/Health tab/)).toBeTruthy();
  });

  it('renders a Pause button when started + fires overwatch:pause on click', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OverwatchTab active />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause overwatch' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/agent-mcp/run-tool');
    const sent = JSON.parse(init.body) as { name: string; args: { harness?: string } };
    expect(sent.name).toBe('overwatch:pause');
    expect(sent.args.harness).toBe('papercup-hive');
    vi.unstubAllGlobals();
  });

  it('shows a Start button + header even when paused (started=false, no brief)', () => {
    H.controlResult = { data: [{ ...control, started: false }], loading: false, error: null };
    H.snapshotResult = { data: [], loading: false, error: null };
    render(<OverwatchTab active />);
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start overwatch' })).toBeTruthy();
  });
});
