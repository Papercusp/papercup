/**
 * urgent-wake.test.ts — the URGENT-enqueue brain bypass (swarm-coordination
 * P-006 / D-005): fire-now outside the wake floor, coalesce-to-boundary inside
 * it (only-advance), no-op without a home slug, and never-throw fail-soft.
 *
 * The PG-touching hive fns (readHiveWakeState / recordHiveWake / declareHiveTimeWake /
 * getHiveTimeWake) and the blueprint launch are mocked at their module seams; the
 * pure floor math (withinWakeFloor / hiveWakeFloorSec / clampWakeAt) runs REAL —
 * it is the substrate under test's branching and already unit-covered in
 * hive/wake.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fireLaunchBlueprint = vi.fn(
  async (_bp: string, _input: { installSlug: string; workspaceId: string; kickoff: string }) => ({
    role: 'operator',
    kind: 'role',
  }),
);
vi.mock('../blueprint/launch-blueprint', () => ({
  fireLaunchBlueprint: (...a: Parameters<typeof fireLaunchBlueprint>) => fireLaunchBlueprint(...a),
}));

const readHiveWakeState = vi.fn<() => Promise<{ subscriptions: never[]; lastWakeAt?: number }>>();
const recordHiveWake = vi.fn(async () => {});
const declareHiveTimeWake = vi.fn(async (_sql: unknown, opts: { at: Date }) => ({ at: opts.at, clamped: false }));
const getHiveTimeWake =
  vi.fn<() => Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null>>();
vi.mock('./wake', async (importOriginal) => {
  const real = await importOriginal<typeof import('./wake')>();
  return {
    ...real,
    readHiveWakeState: (...a: unknown[]) => readHiveWakeState(...(a as [])),
    recordHiveWake: (...a: unknown[]) => recordHiveWake(...(a as [])),
    declareHiveTimeWake: (...a: unknown[]) => declareHiveTimeWake(...(a as [unknown, { at: Date }])),
    getHiveTimeWake: (...a: unknown[]) => getHiveTimeWake(...(a as [])),
  };
});
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-urgent-test' }));

import { requestUrgentHiveWake } from './urgent-wake';

const NOW = Date.parse('2026-06-07T12:00:00Z');
const FLOOR_MS = 60_000; // hiveWakeFloorSec() default, hard-min 60 in tests (env cleared)

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
  delete process.env.PAPERCUSP_HIVE_WAKE_FLOOR_SEC;
});
afterEach(() => {
  delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
});

describe('requestUrgentHiveWake', () => {
  it('no resolvable home slug → skipped, nothing fired or scheduled', async () => {
    const res = await requestUrgentHiveWake({ reason: 'WI-1 urgent', now: NOW });
    expect(res).toEqual({ fired: false, coalesced: false, skipped: 'no_home_harness' });
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
    expect(declareHiveTimeWake).not.toHaveBeenCalled();
  });

  it('outside the floor → fires the hive launch NOW with the urgent kickoff + records the wake', async () => {
    readHiveWakeState.mockResolvedValue({ subscriptions: [] }); // no prior wake
    const res = await requestUrgentHiveWake({ reason: 'urgent work_item WI-7 enqueued: prod fire', harness: 'papercup', now: NOW });
    expect(res).toEqual({ fired: true, coalesced: false });
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
    const [bpId, input] = fireLaunchBlueprint.mock.calls[0] as unknown as [string, { installSlug: string; kickoff: string }];
    expect(bpId).toBe('hive');
    expect(input.installSlug).toBe('papercup');
    expect(input.kickoff).toContain('Wake (urgent)');
    expect(input.kickoff).toContain('WI-7');
    expect(recordHiveWake).toHaveBeenCalledTimes(1);
    expect(declareHiveTimeWake).not.toHaveBeenCalled();
  });

  it('inside the floor → coalesces to a floor-boundary one-shot time wake (no immediate launch)', async () => {
    readHiveWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - 10_000 });
    getHiveTimeWake.mockResolvedValue(null); // nothing scheduled
    const res = await requestUrgentHiveWake({ reason: 'WI-8 urgent', harness: 'papercup', now: NOW });
    expect(res.fired).toBe(false);
    expect(res.coalesced).toBe(true);
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
    expect(declareHiveTimeWake).toHaveBeenCalledTimes(1);
    const declared = declareHiveTimeWake.mock.calls[0][1] as { at: Date; kickoff?: string };
    // boundary = lastWake + floor (NOW+50s), clamped to ≥ NOW + floor → NOW+60s.
    expect(declared.at.getTime()).toBe(NOW + FLOOR_MS);
    expect(declared.kickoff).toContain('Wake (urgent)');
    expect(res.at).toBe(new Date(NOW + FLOOR_MS).toISOString());
  });

  it('inside the floor with an ALREADY-SOONER scheduled wake → only-advance leaves it alone', async () => {
    readHiveWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - 30_000 });
    const soon = new Date(NOW + 20_000); // sooner than the NOW+60s target
    getHiveTimeWake.mockResolvedValue({ active: true, nextFireAt: soon, lastFiredAt: null });
    const res = await requestUrgentHiveWake({ reason: 'WI-9 urgent', harness: 'papercup', now: NOW });
    expect(res).toEqual({
      fired: false,
      coalesced: true,
      at: soon.toISOString(),
      skipped: 'already_scheduled_sooner',
    });
    expect(declareHiveTimeWake).not.toHaveBeenCalled();
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });

  it('inside the floor with a LATER scheduled wake → pulls it in to the boundary', async () => {
    readHiveWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - 30_000 });
    getHiveTimeWake.mockResolvedValue({
      active: true,
      nextFireAt: new Date(NOW + 30 * 60_000), // the slow cadence, 30 min out
      lastFiredAt: null,
    });
    const res = await requestUrgentHiveWake({ reason: 'WI-10 urgent', harness: 'papercup', now: NOW });
    expect(res.coalesced).toBe(true);
    expect(declareHiveTimeWake).toHaveBeenCalledTimes(1);
    expect((declareHiveTimeWake.mock.calls[0][1] as { at: Date }).at.getTime()).toBe(NOW + FLOOR_MS);
  });

  it('honours PAPERCUSP_HIVE_HOME_SLUG as the slug fallback', async () => {
    process.env.PAPERCUSP_HIVE_HOME_SLUG = 'env-home';
    readHiveWakeState.mockResolvedValue({ subscriptions: [] });
    const res = await requestUrgentHiveWake({ reason: 'WI-11 urgent', now: NOW });
    expect(res.fired).toBe(true);
    expect((fireLaunchBlueprint.mock.calls[0] as unknown as [string, { installSlug: string }])[1].installSlug).toBe('env-home');
  });

  it('never throws — a launch failure is returned as { error }', async () => {
    readHiveWakeState.mockResolvedValue({ subscriptions: [] });
    fireLaunchBlueprint.mockRejectedValueOnce(new Error('invoke route down'));
    const res = await requestUrgentHiveWake({ reason: 'WI-12 urgent', harness: 'papercup', now: NOW });
    expect(res.fired).toBe(false);
    expect(res.error).toContain('invoke route down');
  });
});
