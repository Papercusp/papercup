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
  /** Per-queryName invalidate spies — the pane must refresh its OWN reads. */
  invalidated: [] as string[],
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    const setter = (H.nuqsSetters[key] ??= vi.fn((v: unknown) => {
      H.nuqsState[key] = v;
    }));
    return [H.nuqsState[key], setter];
  },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string }) => ({
    ...(opts.queryName === 'overwatch.snapshot' ? H.snapshotResult : H.controlResult),
    invalidate: () => H.invalidated.push(opts.queryName),
  }),
}));
vi.mock('@/lib/useLexicon', async () => {
  const { lexiconFor } = await vi.importActual<typeof import('@papercusp/lexicon')>('@papercusp/lexicon');
  return { useLexicon: () => lexiconFor('classic') };
});

import OverwatchTab from './OverwatchTab';

const brief = {
  potSlug: 'papercup-hive',
  queen: { lastWakeAt: '2026-06-15T09:00:00.000Z', stalled: true, cadenceOk: false, workingTracked: 2, nextFireAt: '2026-06-15T10:00:00.000Z', coordOwner: null },
  bees: { running: 3, completed: 0, churning: 1, deadClaims: 0 },
  workFeed: { frontier: 5, autoEligibleStuck: 0, deadRoutines: 1, blockedStranded: 2 },
  tokens: { pausedBuckets: ['opus'], gatewayFailovers: 0, gw429s: 0, accountsAvailable: 0, gatewayWedged: false, gatewaySustainedThrottle: false },
  plans: { active: 4, stalledItems: 1, agingEscalations: 2 },
  observations: { laneCount: 7, recentByRole: { queen: 3, worker: 4 } },
  crossMonitor: { queenAlive: true, overwatchAlive: false },
  anomalies: [
    { kind: 'queen-stalled', severity: 'critical', subject: 'mug', detail: 'Queen stalled past cadence.', suggestedAction: { type: 'nudge', target: 'mug', message: 'wake up' } },
    { kind: 'token-paused', severity: 'warning', subject: 'token buckets', detail: 'opus paused.', suggestedAction: { type: 'observe', message: 'watching' } },
  ],
};

const control = {
  potSlug: 'papercup-hive',
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
  H.invalidated = [];
});
afterEach(cleanup);

describe('OverwatchTab (sidebar)', () => {
  it('renders the running header + anomaly→action list (kind + verb, most-severe-first)', () => {
    render(<OverwatchTab active />);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('queen-stalled')).toBeTruthy();
    expect(screen.getByText('token-paused')).toBeTruthy();
    expect(screen.getByText('NUDGE mug')).toBeTruthy();
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

  it('renders a Pause button when started + fires kettle:pause on click', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OverwatchTab active />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause Kettle' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/agent-mcp/run-tool');
    const sent = JSON.parse(init.body) as { name: string; args: { harness?: string } };
    expect(sent.name).toBe('kettle:pause');
    expect(sent.args.harness).toBe('papercup-hive');
    vi.unstubAllGlobals();
  });

  it('shows a Start button + header even when paused (started=false, no brief)', () => {
    H.controlResult = { data: [{ ...control, started: false }], loading: false, error: null };
    H.snapshotResult = { data: [], loading: false, error: null };
    render(<OverwatchTab active />);
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start Kettle' })).toBeTruthy();
  });

  // ── The owner's 2026-07-25 report: "if I click pause or start the state doesn't
  //    update until I click away and switch back." Two independent causes; these
  //    pin the CLIENT half. (The server half — controlState reporting potSlug:null
  //    once paused, so Start fired with no harness — is pinned in
  //    packages/operator-core/lib/overwatch/snapshot.test.ts.)
  describe('control toggle reflects immediately (owner bug 2026-07-25)', () => {
    /** A fetch that never settles, so we can observe the pre-response UI. */
    function pendingFetch() {
      const mock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal('fetch', mock);
      return mock;
    }

    it('flips the header optimistically BEFORE the write resolves', () => {
      const fetchMock = pendingFetch();
      render(<OverwatchTab active />);
      expect(screen.getByText('Running')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Pause Kettle' }));

      // The server row is untouched (started still true) and the request has NOT
      // come back — yet the header must already read Paused. Before the fix this
      // stayed "Running" until a remount refetched, which is exactly what the
      // owner saw as "only updates when I switch tabs".
      expect(fetchMock).toHaveBeenCalled();
      expect((H.controlResult.data[0] as { started: boolean }).started).toBe(true);
      expect(screen.getByText('Paused')).toBeTruthy();
      expect(screen.queryByText('Running')).toBeNull();
      vi.unstubAllGlobals();
    });

    it('invalidates its OWN reads after the write instead of waiting for the server push', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<OverwatchTab active />);
      fireEvent.click(screen.getByRole('button', { name: 'Pause Kettle' }));

      await waitFor(() => expect(H.invalidated).toContain('overwatch.controlState'));
      // All three reads derive from the started bit, so all three must refresh:
      // the header, the brief that only exists while running, and the wake strip.
      expect(H.invalidated).toContain('overwatch.snapshot');
      expect(H.invalidated).toContain('overwatch.liveness');
      vi.unstubAllGlobals();
    });

    it('rolls the optimistic flip back when the tool refuses', async () => {
      // The exact refusal the server-side bug produced: no home harness resolved.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            content: [{ text: JSON.stringify({ ok: false, error: 'no_home_harness', message: 'Pass `harness`' }) }],
          },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);
      H.controlResult = { data: [{ ...control, started: false }], loading: false, error: null };
      H.snapshotResult = { data: [], loading: false, error: null };
      render(<OverwatchTab active />);

      fireEvent.click(screen.getByRole('button', { name: 'Start Kettle' }));
      // A refused write must NOT leave the header claiming a state the server
      // never accepted — it reverts and surfaces the reason.
      await waitFor(() => expect(screen.getByText(/Pass .harness./)).toBeTruthy());
      expect(screen.getByText('Paused')).toBeTruthy();
      vi.unstubAllGlobals();
    });
  });

  // Owner question 2026-07-25: "there are pot labels on these interfaces — what do
  // those pot labels mean if they should be operating at the workspace level?"
  // The chip must state the SCOPE; the home-pot slug is provenance in the tooltip.
  it('labels the header chip with the workspace scope, not the anchor pot slug', () => {
    render(<OverwatchTab active />);
    const chip = screen.getByTestId('overwatch-scope');
    expect(chip.textContent).toBe('workspace');
    expect(chip.textContent).not.toContain('papercup-hive');
  });
});
