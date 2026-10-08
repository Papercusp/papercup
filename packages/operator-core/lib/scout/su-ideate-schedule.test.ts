/**
 * su-ideate-schedule — the hourly su ideate pass scheduler (plan
 * scout-su-ideate-pipeline-gaps-2026-10-08 P-007 / R-14, D-005, D-006).
 * Pure over injected deps: no Postgres, no process spawn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSuIdeatePassBrief,
  harnessFromPassLabel,
  nextSuIdeateLens,
  runSuIdeateSchedule,
  SU_IDEATE_MAX_ATTEMPTS,
  SU_IDEATE_PASS_STALE_MS,
  type SuIdeateLaunchRecord,
  type SuIdeateScheduleDeps,
} from './su-ideate-schedule';

const NOW = Date.parse('2026-10-08T15:00:00Z');
const HOUR = 60 * 60 * 1000;

interface FakeHarness {
  lastPassMs?: number | null;
  lastLens?: string | null;
  enabled?: boolean;
  observations?: number;
  queue?: { total: number; pending: number };
}

function makeDeps(harnesses: Record<string, FakeHarness>, launches: SuIdeateLaunchRecord[] = []) {
  const launch = vi.fn<SuIdeateScheduleDeps['launch']>(async () => ({ ok: true }));
  const countObservationsSince = vi.fn<SuIdeateScheduleDeps['countObservationsSince']>(
    async (_ws, h) => harnesses[h]?.observations ?? 0,
  );
  const deps: SuIdeateScheduleDeps = {
    listHarnesses: async () => Object.keys(harnesses),
    readLastPass: async (_ws, h) => ({ lastPassMs: harnesses[h]?.lastPassMs ?? null, lastLens: harnesses[h]?.lastLens ?? null }),
    learningEnabled: async (_ws, h) => harnesses[h]?.enabled ?? true,
    countObservationsSince,
    readIdeaQueue: async (_ws, h) => harnesses[h]?.queue ?? { total: 0, pending: 0 },
    listLaunches: async () => launches,
    launch,
  };
  return { deps, launch, countObservationsSince };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('su-ideate schedule — lens rotation and labels', () => {
  it('rotates risk-first → user-value-first → cost-leverage → risk-first, starting at risk-first', () => {
    expect(nextSuIdeateLens(null)).toBe('risk-first');
    expect(nextSuIdeateLens('risk-first')).toBe('user-value-first');
    expect(nextSuIdeateLens('user-value-first')).toBe('cost-leverage');
    expect(nextSuIdeateLens('cost-leverage')).toBe('risk-first');
    expect(nextSuIdeateLens('analogical')).toBe('risk-first');
  });

  it('parses the harness out of a scheduled-pass label and ignores other labels', () => {
    expect(harnessFromPassLabel('su-ideate-pass:email:never:1')).toBe('email');
    expect(harnessFromPassLabel('su-ideate-pass:sb-devboard-hive:1791470000000:2')).toBe('sb-devboard-hive');
    expect(harnessFromPassLabel('grading-audit:EI-1')).toBeNull();
    expect(harnessFromPassLabel(null)).toBeNull();
  });

  it('the brief names the harness, the lens, the pass-record close and session:end', () => {
    const brief = buildSuIdeatePassBrief({ harnessSlug: 'email', lens: 'cost-leverage', reason: '12 observations' });
    expect(brief).toContain("harness 'email'");
    expect(brief).toContain("blender:ideate-pass-record { lens: 'cost-leverage'");
    expect(brief).toContain('session:end');
    expect(brief).toContain('[lens:cost-leverage]');
  });
});

describe('su-ideate schedule — D-015 verdict per harness (R-14)', () => {
  it('launches ONE pass for the overdue harness with the next lens, its harness and a pass-epoch key', async () => {
    const { deps, launch } = makeDeps({
      email: { lastPassMs: NOW - 5 * HOUR, lastLens: 'risk-first', observations: 12 },
      portal: { lastPassMs: NOW - 3 * HOUR, observations: 40 },
    });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).toHaveBeenCalledTimes(1);
    const arg = launch.mock.calls[0][0];
    expect(arg.harnessSlug).toBe('email');
    expect(arg.lens).toBe('user-value-first');
    expect(arg.key).toBe(`su-ideate-pass:email:${NOW - 5 * HOUR}:1`);
    expect(out.launched).toEqual({ harnessSlug: 'email', lens: 'user-value-first', key: arg.key, deduped: false });
  });

  it('elapsed time alone never makes a harness overdue (D-015: observation-keyed, not calendar-keyed)', async () => {
    const { deps, launch } = makeDeps({ crm: { lastPassMs: NOW - 30 * 24 * HOUR, observations: 3 } });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).not.toHaveBeenCalled();
    expect(out.decisions).toEqual([
      expect.objectContaining({ harnessSlug: 'crm', disposition: 'not-overdue' }),
    ]);
  });

  it('a drained su-ideate idea queue is overdue even below the observation threshold', async () => {
    const { deps, launch } = makeDeps({ portal: { lastPassMs: NOW - HOUR, observations: 0, queue: { total: 4, pending: 0 } } });
    await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0].harnessSlug).toBe('portal');
  });

  it('evaluates never-passed harnesses first, then the oldest last pass, and counts observations since that pass', async () => {
    const { deps, launch, countObservationsSince } = makeDeps({
      papercusp: { lastPassMs: NOW - HOUR, observations: 9000 },
      crm: { lastPassMs: null, observations: 2 },
      email: { lastPassMs: NOW - 9 * HOUR, observations: 15 },
    });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out.decisions.map((d) => [d.harnessSlug, d.disposition])).toEqual([
      ['crm', 'not-overdue'],
      ['email', 'launched'],
    ]);
    expect(launch.mock.calls[0][0].key).toBe(`su-ideate-pass:email:${NOW - 9 * HOUR}:1`);
    expect(countObservationsSince).toHaveBeenCalledWith('ws', 'crm', null);
    expect(countObservationsSince).toHaveBeenCalledWith('ws', 'email', NOW - 9 * HOUR);
  });

  it('skips a harness whose pot has learning switched off', async () => {
    const { deps, launch } = makeDeps({
      email: { lastPassMs: null, observations: 50, enabled: false },
      portal: { lastPassMs: NOW - HOUR, observations: 50 },
    });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out.decisions[0]).toMatchObject({ harnessSlug: 'email', disposition: 'learning-disabled' });
    expect(launch.mock.calls[0][0].harnessSlug).toBe('portal');
  });
});

describe('su-ideate schedule — cost and liveness bounds (D-006)', () => {
  it('a live, fresh launch that has not yet recorded its pass blocks the whole tick', async () => {
    const { deps, launch } = makeDeps(
      { email: { lastPassMs: NOW - 5 * HOUR, observations: 50 }, portal: { lastPassMs: null, observations: 50 } },
      [{ harnessSlug: 'email', startedAtMs: NOW - 20 * 60 * 1000, live: true }],
    );
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).not.toHaveBeenCalled();
    expect(out.stopped).toBe('pass-in-flight');
    expect(out.inFlight?.harnessSlug).toBe('email');
  });

  it('a live launch that already recorded its pass, or is stale, does not block', async () => {
    const { deps, launch } = makeDeps(
      { email: { lastPassMs: NOW - 10 * 60 * 1000, observations: 0 }, portal: { lastPassMs: null, observations: 50 } },
      [
        { harnessSlug: 'email', startedAtMs: NOW - 40 * 60 * 1000, live: true }, // parked after recording
        { harnessSlug: 'crm', startedAtMs: NOW - SU_IDEATE_PASS_STALE_MS - 1, live: true }, // stale
      ],
    );
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out.stopped).toBeUndefined();
    expect(launch.mock.calls[0][0].harnessSlug).toBe('portal');
  });

  it('opens the circuit after the max attempts since the last pass and moves to the next harness', async () => {
    const dead = Array.from({ length: SU_IDEATE_MAX_ATTEMPTS }, (_, i) => ({
      harnessSlug: 'email',
      startedAtMs: NOW - (30 - i) * HOUR,
      live: false,
    }));
    const { deps, launch } = makeDeps(
      { email: { lastPassMs: NOW - 40 * HOUR, observations: 50 }, portal: { lastPassMs: NOW - HOUR, observations: 50 } },
      dead,
    );
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out.decisions[0]).toMatchObject({ harnessSlug: 'email', disposition: 'attempts-exhausted', attempts: SU_IDEATE_MAX_ATTEMPTS });
    expect(launch.mock.calls[0][0].harnessSlug).toBe('portal');
  });

  it('numbers a retry after a dead attempt into a fresh idempotency key', async () => {
    const { deps, launch } = makeDeps(
      { email: { lastPassMs: NOW - 9 * HOUR, observations: 50 } },
      [{ harnessSlug: 'email', startedAtMs: NOW - 5 * HOUR, live: false }],
    );
    await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch.mock.calls[0][0].key).toBe(`su-ideate-pass:email:${NOW - 9 * HOUR}:2`);
  });

  it('stops before any read once the rolling-24h launch budget is spent', async () => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_MAX_LAUNCHES_PER_DAY', '2');
    const { deps, launch, countObservationsSince } = makeDeps(
      { email: { lastPassMs: null, observations: 50 } },
      [
        { harnessSlug: 'portal', startedAtMs: NOW - 3 * HOUR, live: false },
        { harnessSlug: 'crm', startedAtMs: NOW - 5 * HOUR, live: false },
        { harnessSlug: 'crm', startedAtMs: NOW - 30 * HOUR, live: false }, // outside the window
      ],
    );
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out).toMatchObject({ stopped: 'daily-budget-exhausted', launchesLast24h: 2, budget: 2 });
    expect(launch).not.toHaveBeenCalled();
    expect(countObservationsSince).not.toHaveBeenCalled();
  });

  it('a refused launch ends the tick with the error, without trying the next harness', async () => {
    const { deps, launch } = makeDeps({
      email: { lastPassMs: null, observations: 50 },
      portal: { lastPassMs: NOW - HOUR, observations: 50 },
    });
    launch.mockResolvedValueOnce({ ok: false, error: 'governor refused admission' });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(out.launched).toBeUndefined();
    expect(out.decisions).toEqual([
      expect.objectContaining({ harnessSlug: 'email', disposition: 'launch-failed', error: 'governor refused admission' }),
    ]);
  });
});
