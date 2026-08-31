import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveObservationTarget } from './spawn-observation-writer';

/**
 * P-003 of plan `spawn-door-governor-migration-2026-08-31`.
 *
 * The writer's DB call is deliberately thin; what carries real risk is the rule
 * deciding which spawns get a persisted receipt, because P-004 computes rates
 * from exactly that population. These tests pin the rule (D-010) so a later
 * change cannot silently widen or narrow the sample without a red test.
 */
describe('resolveObservationTarget (D-010 — which row carries the receipt)', () => {
  const ids = { spawnId: 'spawn-ours', failedAttemptSpawnId: 'spawn-failed-row' };

  it('attaches an admitted spawn to our own committed row', () => {
    expect(resolveObservationTarget('admitted', ids)).toBe('spawn-ours');
  });

  it('attaches an over_cap refusal to the row fail() recorded, NOT to our spawnId', () => {
    // The corrected half of D-010. `recordFailedAttempt` mints a FRESH id, so
    // keying on our own spawnId would match zero rows and silently drop every
    // refusal — and refusals are exactly where P-004's burst shape lives, since
    // a burst is defined by the moments the ceiling was hit.
    expect(resolveObservationTarget('over_cap', ids)).toBe('spawn-failed-row');
    expect(resolveObservationTarget('over_cap', ids)).not.toBe(ids.spawnId);
  });

  it('logs rather than persists an over_cap whose failed-attempt row was not recorded', () => {
    // recordFailedAttempt is itself best-effort and returns null on failure.
    expect(resolveObservationTarget('over_cap', { spawnId: 'spawn-ours' })).toBeNull();
    expect(
      resolveObservationTarget('over_cap', { spawnId: 'spawn-ours', failedAttemptSpawnId: null }),
    ).toBeNull();
  });

  it('never attaches a duplicate: that row belongs to the ORIGINAL spawn', () => {
    // The replay's admission returns the first spawn's id, which already carries
    // its own receipt. Writing there would overwrite a different spawn's
    // counterfactual with this replay's.
    expect(resolveObservationTarget('duplicate', ids)).toBeNull();
  });

  it('never attaches an unknown outcome', () => {
    expect(resolveObservationTarget('unknown', ids)).toBeNull();
  });

  it('never targets our own spawnId for anything but an admitted spawn', () => {
    // Guards the specific mis-write the original D-010 reasoning would have
    // produced: our spawnId is only ever a valid target when we inserted it.
    for (const outcome of ['over_cap', 'duplicate', 'unknown'] as const) {
      expect(resolveObservationTarget(outcome, ids)).not.toBe(ids.spawnId);
    }
  });
});

describe('recordSpawnGovernorObservation (best-effort contract)', () => {
  afterEach(() => {
    delete process.env.PAPERCUSP_SPAWN_GOVERNOR_OBSERVATION;
    vi.resetModules();
  });

  it('is disabled by the kill switch without touching the database', async () => {
    process.env.PAPERCUSP_SPAWN_GOVERNOR_OBSERVATION = '0';
    const { recordSpawnGovernorObservation } = await import('./spawn-observation-writer');
    // A sql that throws if called at all: the kill switch must short-circuit
    // BEFORE any I/O, not merely swallow the resulting error.
    const sql = (() => {
      throw new Error('database touched while observation was disabled');
    }) as never;

    await expect(
      recordSpawnGovernorObservation({
        sql,
        workspaceId: 'ws',
        spawnId: 'spawn-1',
        doorOutcome: 'admitted',
        doorCap: 8,
        doorRoleCap: null,
        parentRole: 'operator',
        childRole: 'su',
        fleetSlug: null,
        planSlug: null,
        caller: 'test/writer-contract',
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows a database failure — an observation can never fail a spawn', async () => {
    const { recordSpawnGovernorObservation } = await import('./spawn-observation-writer');
    const sql = (() => {
      throw new Error('connection reset');
    }) as never;

    // The snapshot read will also fail here (no live pg); both paths are inside
    // the same try/catch, and the contract is that neither escapes.
    await expect(
      recordSpawnGovernorObservation({
        sql,
        workspaceId: 'ws',
        spawnId: 'spawn-1',
        doorOutcome: 'admitted',
        doorCap: 8,
        doorRoleCap: null,
        parentRole: 'operator',
        childRole: 'su',
        fleetSlug: null,
        planSlug: null,
        caller: 'test/writer-contract',
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * RECURRENCE GUARD. `duplicate` is an idempotent retry: it launches nothing and
   * the ORIGINAL spawn already carries its own receipt, so having no row of our
   * own is the CORRECT outcome, not an anomaly. Warning on it fired on every
   * dedupe — production log-noise, a false anomaly signal, and an unexpected-
   * console failure under vitest-fail-on-console that turned a previously-green
   * operator-spawn idempotency test red.
   *
   * The `unknown` case below is the CALIBRATION: without it, a snapshot read that
   * threw would make the duplicate assertion pass while measuring nothing at all.
   */
  it('does NOT log for a duplicate — an idempotent retry is an expected skip, not an anomaly', async () => {
    // The snapshot read sits INSIDE the writer's try/catch and ahead of the log
    // path, so without this mock it throws (no live pg) and the catch swallows —
    // making a "did not log" assertion pass while measuring nothing. The
    // CALIBRATION test below is what proved that, and this mock is the repair.
    vi.doMock('./state-snapshot', () => ({
      readGovernorStateSnapshot: async () => null,
    }));
    const { recordSpawnGovernorObservation } = await import('./spawn-observation-writer');
    const logFn = vi.fn();
    const sql = (() => {
      throw new Error('sql must not be touched for a duplicate');
    }) as never;

    await recordSpawnGovernorObservation(
      {
        sql,
        workspaceId: 'ws',
        spawnId: 'spawn-dup',
        doorOutcome: 'duplicate',
        doorCap: 8,
        doorRoleCap: null,
        parentRole: 'operator',
        childRole: 'su',
        fleetSlug: null,
        planSlug: null,
        caller: 'test/writer-contract',
      },
      logFn,
    );

    expect(logFn).not.toHaveBeenCalled();
  });

  it('CALIBRATION: still logs an unknown outcome, so the duplicate assertion is not vacuous', async () => {
    vi.doMock('./state-snapshot', () => ({
      readGovernorStateSnapshot: async () => null,
    }));
    const { recordSpawnGovernorObservation } = await import('./spawn-observation-writer');
    const logFn = vi.fn();
    const sql = (() => {
      throw new Error('sql must not be touched for an unknown outcome');
    }) as never;

    await recordSpawnGovernorObservation(
      {
        sql,
        workspaceId: 'ws',
        spawnId: 'spawn-unknown',
        doorOutcome: 'unknown',
        doorCap: 8,
        doorRoleCap: null,
        parentRole: 'operator',
        childRole: 'su',
        fleetSlug: null,
        planSlug: null,
        caller: 'test/writer-contract',
      },
      logFn,
    );

    expect(logFn).toHaveBeenCalledTimes(1);
    expect(logFn.mock.calls[0]?.[0]).toContain('[spawn-governor-observation]');
  });
});
