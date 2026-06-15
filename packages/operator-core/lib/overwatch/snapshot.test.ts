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
  lastSystemHealth: vi.fn(),
  runSystemHealthTick: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'ws-1'),
  resolveHiveHomeSlug: vi.fn((): string | null => 'papercup-hive'),
  getOverwatchStarted: vi.fn(),
  getOverwatchCadenceSec: vi.fn(),
  listStartedOverwatches: vi.fn(async () => [] as Array<{ workspaceId: string; installSlug: string }>),
  overwatchLivenessCheck: vi.fn(),
  getFlag: vi.fn(),
  mapSystemHealthToBrief: vi.fn(),
  withAnomalies: vi.fn(),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));

vi.mock('../system-health', () => ({
  lastSystemHealth: h.lastSystemHealth,
  runSystemHealthTick: h.runSystemHealthTick,
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: h.activeWorkspaceId }));
vi.mock('../hive/wake', () => ({ resolveHiveHomeSlug: h.resolveHiveHomeSlug }));
vi.mock('./control-state', () => ({
  getOverwatchStarted: h.getOverwatchStarted,
  getOverwatchCadenceSec: h.getOverwatchCadenceSec,
  listStartedOverwatches: h.listStartedOverwatches,
  DEFAULT_OVERWATCH_CADENCE_SEC: 600,
}));
vi.mock('./liveness', () => ({ overwatchLivenessCheck: h.overwatchLivenessCheck }));
vi.mock('./compute-brief', () => ({
  mapSystemHealthToBrief: h.mapSystemHealthToBrief,
  withAnomalies: h.withAnomalies,
}));
vi.mock('@papercusp/flags', () => ({ FLAGS: { OVERWATCH: 'papercusp-overwatch' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: h.getOrgPg }));

import { getOverwatchSnapshot, getOverwatchControlState } from './snapshot';

/** A minimal SystemHealth — the mapper is mocked, so only the slug-resolution
 *  path (panels.queen.data.hiveSlug) + evaluatedAt are read here. */
function healthFixture(hiveSlug: string | null, evaluatedAt: number) {
  return { evaluatedAt, panels: { queen: { data: hiveSlug ? { hiveSlug } : null } } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.activeWorkspaceId.mockReturnValue('ws-1');
  h.resolveHiveHomeSlug.mockReturnValue('papercup-hive');
  h.listStartedOverwatches.mockResolvedValue([]);
  h.mapSystemHealthToBrief.mockReturnValue({ mapped: true });
  h.withAnomalies.mockImplementation((b: unknown) => ({ ...(b as object), anomalies: [] }));
});

describe('getOverwatchSnapshot', () => {
  it('reuses a FRESH cached SystemHealth (no recompute) and maps it via the B-03 mapper', async () => {
    const health = healthFixture('hive-x', Date.now());
    h.lastSystemHealth.mockReturnValue(health);

    const out = await getOverwatchSnapshot();

    expect(h.runSystemHealthTick).not.toHaveBeenCalled();
    expect(h.mapSystemHealthToBrief).toHaveBeenCalledWith(health, 'hive-x');
    expect(h.withAnomalies).toHaveBeenCalledWith({ mapped: true });
    expect(out).toEqual({ mapped: true, anomalies: [] });
  });

  it('serves the STALE cache INSTANTLY + refreshes in the background (stale-while-revalidate)', async () => {
    const stale = healthFixture('hive-old', Date.now() - 10 * 60_000);
    h.lastSystemHealth.mockReturnValue(stale);
    h.runSystemHealthTick.mockResolvedValue(healthFixture('hive-new', Date.now()));

    const out = await getOverwatchSnapshot();

    // A background refresh is kicked (fire-and-forget; the open pane updates over SSE)…
    expect(h.runSystemHealthTick).toHaveBeenCalledTimes(1);
    // …but the brief is mapped from the STALE cache and returned WITHOUT awaiting a
    // re-aggregation — the pane opens instantly, no spinner.
    expect(h.mapSystemHealthToBrief).toHaveBeenCalledWith(stale, 'hive-old');
    expect(out).toEqual({ mapped: true, anomalies: [] });
  });

  it('blocks ONLY on a cold cache (first read after boot) — then maps the fresh tick', async () => {
    h.lastSystemHealth.mockReturnValue(null);
    const fresh = healthFixture('hive-new', Date.now());
    h.runSystemHealthTick.mockResolvedValue(fresh);

    await getOverwatchSnapshot();

    expect(h.runSystemHealthTick).toHaveBeenCalledTimes(1);
    expect(h.mapSystemHealthToBrief).toHaveBeenCalledWith(fresh, 'hive-new');
  });

  it('fail-softs to the neutral empty brief when health is unreadable (tick throws)', async () => {
    h.lastSystemHealth.mockReturnValue(null);
    h.runSystemHealthTick.mockRejectedValue(new Error('boom'));

    const out = await getOverwatchSnapshot();

    expect(h.mapSystemHealthToBrief).not.toHaveBeenCalled();
    // emptyOverwatchBrief('papercup-hive') — the env home slug, since no health.
    expect(out).toMatchObject({ hiveSlug: 'papercup-hive', anomalies: [] });
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
      hiveSlug: 'papercup-hive',
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
    h.resolveHiveHomeSlug.mockReturnValue(null);
    h.listStartedOverwatches.mockResolvedValue([]);
    h.getFlag.mockResolvedValue(false);

    const out = await getOverwatchControlState();

    expect(out).toEqual({
      hiveSlug: null,
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
});
