/**
 * overwatch/snapshot.test — B-08 read surface (overwatch-role-2026-06-15).
 *
 * Verifies the WIRING the pane's two resolvers rest on: `getOverwatchSnapshot`
 * reuses the shared SystemHealth cache (D-006 — no second aggregation) + maps via
 * the B-03 mapper, recomputes on a stale/cold cache, and fail-softs to the neutral
 * brief; `getOverwatchControlState` projects the started bit + cadence + flag +
 * liveness (with ms→ISO). The mapping/anomaly logic itself is covered by
 * compute-brief.test.ts — here we mock the mapper to a sentinel and assert the
 * glue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolveSystemHealth: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'ws-1'),
  resolvePotHomeSlug: vi.fn((): string | null => 'papercup-hive'),
  getOverwatchStarted: vi.fn(),
  getOverwatchCadenceSec: vi.fn(),
  listStartedOverwatches: vi.fn(async () => [] as Array<{ workspaceId: string; installSlug: string }>),
  /** The registry home-pot fallback (owner bug 2026-07-25) — see the describe below. */
  resolveHomePotSlug: vi.fn(async (): Promise<string | null> => null),
  overwatchLivenessCheck: vi.fn(),
  getFlag: vi.fn(),
  mapSystemHealthToBrief: vi.fn(),
  withAnomalies: vi.fn(),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));

vi.mock('../system-health', () => ({
  resolveSystemHealth: h.resolveSystemHealth,
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: h.activeWorkspaceId }));
vi.mock('../pot/wake', () => ({ resolvePotHomeSlug: h.resolvePotHomeSlug }));
vi.mock('../agent-tools/pot/_resolve', () => ({ resolveHomePotSlug: h.resolveHomePotSlug }));
vi.mock('./control-state', () => ({
  getOverwatchStarted: h.getOverwatchStarted,
  getOverwatchCadenceSec: h.getOverwatchCadenceSec,
  listStartedOverwatches: h.listStartedOverwatches,
  DEFAULT_OVERWATCH_CADENCE_SEC: 600,
}));
vi.mock('./liveness', () => ({
  overwatchLivenessCheck: h.overwatchLivenessCheck,
  OVERWATCH_ROLE: 'kettle',
  OVERWATCH_INVOKE_TIMEOUT_MS: 480_000,
  OVERWATCH_SCORECARD_DEADLINE_GRACE_MS: 15_000,
}));
vi.mock('./compute-brief', () => ({
  mapSystemHealthToBrief: h.mapSystemHealthToBrief,
  withAnomalies: h.withAnomalies,
}));
vi.mock('@papercusp/flags', () => ({ FLAGS: { OVERWATCH: 'papercusp-overwatch' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: h.getOrgPg }));

import {
  deriveOverwatchLiveness,
  getOverwatchSnapshot,
  getOverwatchControlState,
} from './snapshot';

/** A minimal SystemHealth — the mapper is mocked, so only the slug-resolution
 *  path (panels.queen.data.potSlug) + evaluatedAt are read here. */
function healthFixture(potSlug: string | null, evaluatedAt: number) {
  return { evaluatedAt, panels: { queen: { data: potSlug ? { potSlug } : null } } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.activeWorkspaceId.mockReturnValue('ws-1');
  h.resolvePotHomeSlug.mockReturnValue('papercup-hive');
  h.listStartedOverwatches.mockResolvedValue([]);
  h.mapSystemHealthToBrief.mockReturnValue({ mapped: true });
  h.withAnomalies.mockImplementation((b: unknown) => ({ ...(b as object), anomalies: [] }));
});

describe('getOverwatchSnapshot', () => {
  // D-006 (one aggregation, two consumers) + the SWR/cold/shared-snapshot cache
  // logic now live in `resolveSystemHealth` (system-health/compute) and are covered
  // by compute.test.ts (`resolveSystemHealth` describe). Here we assert only the
  // BRIEF GLUE: map whatever health the shared resolver returns, and fail-soft to
  // the neutral empty brief when it returns null / throws.
  it('maps the SystemHealth returned by resolveSystemHealth via the B-03 mapper', async () => {
    const health = healthFixture('hive-x', Date.now());
    h.resolveSystemHealth.mockResolvedValue(health);

    const out = await getOverwatchSnapshot();

    expect(h.resolveSystemHealth).toHaveBeenCalledWith('ws-1', expect.any(Number));
    expect(h.mapSystemHealthToBrief).toHaveBeenCalledWith(health, 'hive-x');
    expect(h.withAnomalies).toHaveBeenCalledWith({ mapped: true });
    expect(out).toEqual({ mapped: true, anomalies: [] });
  });

  it('fail-softs to the neutral empty brief when resolveSystemHealth returns null', async () => {
    h.resolveSystemHealth.mockResolvedValue(null);

    const out = await getOverwatchSnapshot();

    expect(h.mapSystemHealthToBrief).not.toHaveBeenCalled();
    // emptyOverwatchBrief('papercup-hive') — the env home slug, since no health.
    expect(out).toMatchObject({ potSlug: 'papercup-hive', anomalies: [] });
  });

  it('fail-softs to the neutral empty brief when resolveSystemHealth throws (unreadable health)', async () => {
    h.resolveSystemHealth.mockRejectedValue(new Error('boom'));

    const out = await getOverwatchSnapshot();

    expect(h.mapSystemHealthToBrief).not.toHaveBeenCalled();
    expect(out).toMatchObject({ potSlug: 'papercup-hive', anomalies: [] });
  });
});

describe('getOverwatchControlState', () => {
  it('projects started/cadence/flag/liveness with ms→ISO for a resolvable hive', async () => {
    h.getFlag.mockResolvedValue(true);
    h.getOverwatchStarted.mockResolvedValue(true);
    h.getOverwatchCadenceSec.mockResolvedValue(600);
    h.overwatchLivenessCheck.mockResolvedValue({
      armed: true,
      nextFireAt: new Date('2026-06-15T10:00:00.000Z'),
      lastFiredAt: new Date('2026-06-15T09:00:00.000Z'),
      staleForMs: 3_600_000,
    });

    const out = await getOverwatchControlState();

    expect(out).toEqual({
      potSlug: 'papercup-hive',
      started: true,
      cadenceSec: 600,
      flagEnabled: true,
      armed: true,
      nextWakeAt: '2026-06-15T10:00:00.000Z',
      lastWakeAt: '2026-06-15T09:00:00.000Z',
      staleForMs: 3_600_000,
    });
  });

  it('returns the zeroed default (no hive) when no home slug is resolvable', async () => {
    h.resolvePotHomeSlug.mockReturnValue(null);
    h.listStartedOverwatches.mockResolvedValue([]);
    h.resolveHomePotSlug.mockResolvedValue(null);
    h.getFlag.mockResolvedValue(false);

    const out = await getOverwatchControlState();

    expect(out).toEqual({
      potSlug: null,
      started: false,
      cadenceSec: 600,
      flagEnabled: false,
      armed: false,
      nextWakeAt: null,
      lastWakeAt: null,
      staleForMs: null,
    });
    expect(h.getOverwatchStarted).not.toHaveBeenCalled();
  });

  /**
   * REGRESSION — the server half of the owner's 2026-07-25 report ("if I click
   * pause or start the state doesn't update"). Every slug source above is empty in
   * precisely the state where the pane most needs one:
   *   - resolvePotHomeSlug() is ENV-ONLY and PAPERCUSP_POT_HOME_SLUG is unset on
   *     the dev/green operator hosts (verified in /proc/<pid>/environ), and
   *   - listStartedOverwatches() is by definition empty while the Kettle is PAUSED.
   * So controlState reported potSlug:null the moment you paused, the sidebar
   * derives its Start argument from that field, and Start then called kettle:start
   * with no harness → `no_home_harness`. The owner clicked Start and nothing
   * happened. Same defect + same fix as mug-steering-panel GAP 1 (2026-06-17).
   */
  describe('home-pot registry fallback (owner bug 2026-07-25)', () => {
    it('still reports a potSlug while PAUSED, so the pane can send a harness to kettle:start', async () => {
      h.resolvePotHomeSlug.mockReturnValue(null); // env unset, as on the real hosts
      h.listStartedOverwatches.mockResolvedValue([]); // paused ⇒ nothing started
      h.resolveHomePotSlug.mockResolvedValue('papercusp'); // registry knows the home pot
      h.getFlag.mockResolvedValue(true);
      h.getOverwatchStarted.mockResolvedValue(false);
      h.getOverwatchCadenceSec.mockResolvedValue(600);
      h.overwatchLivenessCheck.mockResolvedValue({
        armed: false,
        nextFireAt: null,
        lastFiredAt: null,
        staleForMs: null,
      });

      const out = await getOverwatchControlState();

      expect(out.potSlug).toBe('papercusp');
      expect(out.started).toBe(false);
      // It must READ that pot's state, not skip to the zeroed default.
      expect(h.getOverwatchStarted).toHaveBeenCalledWith('ws-1', 'papercusp');
    });

    it('prefers a STARTED overwatch over the registry default', async () => {
      h.resolvePotHomeSlug.mockReturnValue(null);
      h.listStartedOverwatches.mockResolvedValue([{ workspaceId: 'ws-1', installSlug: 'running-pot' }]);
      h.resolveHomePotSlug.mockResolvedValue('papercusp');
      h.getFlag.mockResolvedValue(true);
      h.getOverwatchStarted.mockResolvedValue(true);
      h.getOverwatchCadenceSec.mockResolvedValue(600);
      h.overwatchLivenessCheck.mockResolvedValue({
        armed: true,
        nextFireAt: null,
        lastFiredAt: null,
        staleForMs: null,
      });

      const out = await getOverwatchControlState();

      // A loop that is actually RUNNING is the authoritative answer to "which pot
      // is this supervising"; the registry default is only the paused-state floor.
      expect(out.potSlug).toBe('running-pot');
      expect(h.resolveHomePotSlug).not.toHaveBeenCalled();
    });
  });
});

describe('deriveOverwatchLiveness', () => {
  const firedAt = new Date('2026-07-13T20:23:40.000Z');

  it('keeps a firing turn in-flight through the launcher timeout even when a short cadence is stale', () => {
    const out = deriveOverwatchLiveness({
      potSlug: 'papercusp',
      started: true,
      flagEnabled: true,
      cadenceSec: 120,
      fire: { lastFiredAt: firedAt, lastStatus: 'firing', consecutiveErrors: 0 },
      now: firedAt.getTime() + 300_000,
    });

    expect(out.stale).toBe(true);
    expect(out.inFlight).toBe(true);
  });

  it('expires the in-flight state after the launcher timeout and scorecard grace', () => {
    const out = deriveOverwatchLiveness({
      potSlug: 'papercusp',
      started: true,
      flagEnabled: true,
      cadenceSec: 120,
      fire: { lastFiredAt: firedAt, lastStatus: 'firing', consecutiveErrors: 0 },
      now: firedAt.getTime() + 495_001,
    });

    expect(out.inFlight).toBe(false);
    expect(out.stale).toBe(true);
  });
});
