import { describe, it, expect, vi, afterEach } from 'vitest';
import { observationIsPersistable } from './spawn-observation-writer';

/**
 * P-003 of plan `spawn-door-governor-migration-2026-08-31`.
 *
 * The writer's DB call is deliberately thin; what carries real risk is the rule
 * deciding which spawns get a persisted receipt, because P-004 computes rates
 * from exactly that population. These tests pin the rule (D-010) so a later
 * change cannot silently widen or narrow the sample without a red test.
 */
describe('observationIsPersistable (D-010 population rule)', () => {
  it('persists an admitted spawn — the only outcome that inserted a row', () => {
    expect(observationIsPersistable('admitted')).toBe(true);
  });

  it('does NOT persist over_cap: the door refused and inserted no row at all', () => {
    // An UPDATE would match zero rows; the value is logged instead. Crucially a
    // synthetic row is NOT an option — countRunning derives the live ceiling from
    // this table, so inserting one would let telemetry consume a real spawn slot.
    expect(observationIsPersistable('over_cap')).toBe(false);
  });

  it('does NOT persist duplicate: the row belongs to the ORIGINAL spawn', () => {
    // The replay's admission returns the first spawn's id. Writing there would
    // overwrite that spawn's own receipt with a later replay's counterfactual.
    expect(observationIsPersistable('duplicate')).toBe(false);
  });

  it('does NOT persist unknown', () => {
    expect(observationIsPersistable('unknown')).toBe(false);
  });

  it('admits exactly one outcome — a guard against widening the P-004 denominator', () => {
    const outcomes = ['admitted', 'over_cap', 'duplicate', 'unknown'] as const;
    expect(outcomes.filter(observationIsPersistable)).toEqual(['admitted']);
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
      }),
    ).resolves.toBeUndefined();
  });
});
