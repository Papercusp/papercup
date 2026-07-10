/**
 * urgent-wake.test.ts — the URGENT-enqueue brain bypass (swarm-coordination
 * P-006 / D-005): fire-now outside the wake floor, coalesce-to-boundary inside
 * it (only-advance), no-op without a home slug, and never-throw fail-soft.
 *
 * The PG-touching pot fns (readPotWakeState / recordPotWake / declarePotTimeWake /
 * getPotTimeWake) and the blueprint launch are mocked at their module seams; the
 * pure floor math (withinWakeFloor / potWakeFloorSec / clampWakeAt) runs REAL —
 * it is the substrate under test's branching and already unit-covered in
 * pot/wake.test.ts.
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

const readPotWakeState = vi.fn<() => Promise<{ subscriptions: never[]; lastWakeAt?: number }>>();
const recordPotWake = vi.fn(async () => {});
const declarePotTimeWake = vi.fn(async (_sql: unknown, opts: { at: Date }) => ({ at: opts.at, clamped: false }));
const getPotTimeWake =
  vi.fn<() => Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null>>();
vi.mock('./wake', async (importOriginal) => {
  const real = await importOriginal<typeof import('./wake')>();
  return {
    ...real,
    readPotWakeState: (...a: unknown[]) => readPotWakeState(...(a as [])),
    recordPotWake: (...a: unknown[]) => recordPotWake(...(a as [])),
    declarePotTimeWake: (...a: unknown[]) => declarePotTimeWake(...(a as [unknown, { at: Date }])),
    getPotTimeWake: (...a: unknown[]) => getPotTimeWake(...(a as [])),
  };
});
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-urgent-test' }));

import { requestUrgentPotWake } from './urgent-wake';

const NOW = Date.parse('2026-06-07T12:00:00Z');
const FLOOR_MS = 60_000; // potWakeFloorSec() default, hard-min 60 in tests (env cleared)

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_POT_HOME_SLUG;
  delete process.env.PAPERCUSP_POT_WAKE_FLOOR_SEC;
});
afterEach(() => {
  delete process.env.PAPERCUSP_POT_HOME_SLUG;
});

describe('requestUrgentPotWake', () => {
  it('no resolvable home slug → skipped, nothing fired or scheduled', async () => {
    const res = await requestUrgentPotWake({ reason: 'WI-1 urgent', now: NOW });
    expect(res).toEqual({ fired: false, coalesced: false, skipped: 'no_home_harness' });
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
    expect(declarePotTimeWake).not.toHaveBeenCalled();
  });

  it('outside the floor → fires the pot launch NOW with the urgent kickoff + records the wake', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [] }); // no prior wake
    // The integration checkout has completed the papercup→papercusp rename; the
    // wake path canonicalizes retired slugs before launching the pot brain.
    const res = await requestUrgentPotWake({ reason: 'urgent work_item WI-7 enqueued: prod fire', harness: 'papercup', now: NOW });
    expect(res).toEqual({ fired: true, coalesced: false });
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
    const [bpId, input] = fireLaunchBlueprint.mock.calls[0] as unknown as [string, { installSlug: string; kickoff: string }];
    expect(bpId).toBe('coding');
    expect(input.installSlug).toBe('papercusp');
    expect(input.kickoff).toContain('Wake (urgent)');
    expect(input.kickoff).toContain('WI-7');
    expect(recordPotWake).toHaveBeenCalledTimes(1);
    expect(declarePotTimeWake).not.toHaveBeenCalled();
  });

  it('inside the floor → coalesces to a floor-boundary one-shot time wake (no immediate launch)', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - 10_000 });
    getPotTimeWake.mockResolvedValue(null); // nothing scheduled
    const res = await requestUrgentPotWake({ reason: 'WI-8 urgent', harness: 'papercup', now: NOW });
    expect(res.fired).toBe(false);
    expect(res.coalesced).toBe(true);
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
    expect(declarePotTimeWake).toHaveBeenCalledTimes(1);
    const declared = declarePotTimeWake.mock.calls[0][1] as { at: Date; kickoff?: string };
    // boundary = lastWake + floor (NOW+50s), clamped to ≥ NOW + floor → NOW+60s.
    expect(declared.at.getTime()).toBe(NOW + FLOOR_MS);
    expect(declared.kickoff).toContain('Wake (urgent)');
    expect(res.at).toBe(new Date(NOW + FLOOR_MS).toISOString());
  });

  it('inside the floor with an ALREADY-SOONER scheduled wake → only-advance leaves it alone', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - 30_000 });
    const soon = new Date(NOW + 20_000); // sooner than the NOW+60s target
    getPotTimeWake.mockResolvedValue({ active: true, nextFireAt: soon, lastFiredAt: null });
    const res = await requestUrgentPotWake({ reason: 'WI-9 urgent', harness: 'papercup', now: NOW });
    expect(res).toEqual({
      fired: false,
      coalesced: true,
      at: soon.toISOString(),
      skipped: 'already_scheduled_sooner',
    });
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });

  it('inside the floor with a LATER scheduled wake → pulls it in to the boundary', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [], lastWakeAt: NOW - 30_000 });
    getPotTimeWake.mockResolvedValue({
      active: true,
      nextFireAt: new Date(NOW + 30 * 60_000), // the slow cadence, 30 min out
      lastFiredAt: null,
    });
    const res = await requestUrgentPotWake({ reason: 'WI-10 urgent', harness: 'papercup', now: NOW });
    expect(res.coalesced).toBe(true);
    expect(declarePotTimeWake).toHaveBeenCalledTimes(1);
    expect((declarePotTimeWake.mock.calls[0][1] as { at: Date }).at.getTime()).toBe(NOW + FLOOR_MS);
  });

  it('honours PAPERCUSP_POT_HOME_SLUG as the slug fallback', async () => {
    process.env.PAPERCUSP_POT_HOME_SLUG = 'env-home';
    readPotWakeState.mockResolvedValue({ subscriptions: [] });
    const res = await requestUrgentPotWake({ reason: 'WI-11 urgent', now: NOW });
    expect(res.fired).toBe(true);
    expect((fireLaunchBlueprint.mock.calls[0] as unknown as [string, { installSlug: string }])[1].installSlug).toBe('env-home');
  });

  it('never throws — a launch failure is returned as { error }', async () => {
    readPotWakeState.mockResolvedValue({ subscriptions: [] });
    fireLaunchBlueprint.mockRejectedValueOnce(new Error('invoke route down'));
    const res = await requestUrgentPotWake({ reason: 'WI-12 urgent', harness: 'papercup', now: NOW });
    expect(res.fired).toBe(false);
    expect(res.error).toContain('invoke route down');
  });
});
