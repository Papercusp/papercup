/**
 * Unit tests for EI-19408412473830336 — the loop-death / loop-lifecycle-death watchdog
 * auto-resolve leg (reconcile-loop-routines.ts). Both watchdogs used to open an escalation
 * via `openEscalation` and never resolve one — this exercises the fix: `parseLoopWatchdogSignature`
 * (the shared subjectSignature codec) and the two `reconcile*Escalations` functions, entirely
 * via their injection seams (`listOpen`/`resolve`/`sql`/`readFireState`) so no module mocking
 * of the escalations surface is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { EscalationRecord } from '../../agent-tools/coordination/escalations';
import {
  parseLoopWatchdogSignature,
  reconcileDeadLoopEscalations,
  reconcileLoopLifecycleDeathEscalations,
  LOOP_DEATH_SIGNATURE_PREFIX,
  LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX,
} from './reconcile-loop-routines';

function rec(msg_id: string, subjectSignature: string): EscalationRecord {
  return {
    ts: new Date().toISOString(),
    msg_id,
    from: 'system:test',
    to: ['human'],
    kind: 'escalation',
    severity: 'advisory',
    summary: 'test',
    resolved: null,
    subjectSignature,
  } as unknown as EscalationRecord;
}

/** A minimal tagged-template stub returning `rows` for any SELECT (matches the existing
 *  fakeSql idiom in reconcile-loop-routines.test.ts). */
function fakeSql(rows: Record<string, unknown>[]): Sql {
  return (async () => rows) as unknown as Sql;
}

describe('parseLoopWatchdogSignature', () => {
  it('parses a well-formed <prefix>:<installSlug>:<routineId> signature', () => {
    expect(parseLoopWatchdogSignature('loop-death:papercusp:rt-42', 'loop-death')).toEqual({
      installSlug: 'papercusp',
      routineId: 'rt-42',
    });
  });

  it('takes the FINAL colon-delimited segment as routineId, even if installSlug contains one', () => {
    expect(parseLoopWatchdogSignature('loop-death:pape:rcusp:rt-42', 'loop-death')).toEqual({
      installSlug: 'pape:rcusp',
      routineId: 'rt-42',
    });
  });

  it('returns null for a signature carrying the WRONG prefix', () => {
    expect(parseLoopWatchdogSignature('loop-lifecycle-death:papercusp:rt-42', 'loop-death')).toBeNull();
  });

  it('returns null for a malformed signature (no routineId segment)', () => {
    expect(parseLoopWatchdogSignature('loop-death:papercusp', 'loop-death')).toBeNull();
    expect(parseLoopWatchdogSignature('loop-death:papercusp:', 'loop-death')).toBeNull();
  });
});

describe('reconcileDeadLoopEscalations (loop-death watchdog)', () => {
  it('resolves an escalation whose routine is ACTIVE again (a human re-armed it)', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileDeadLoopEscalations({
      sql: fakeSql([{ id: 'rt-1', active: true }]),
      listOpen: async () => [rec('m1', `${LOOP_DEATH_SIGNATURE_PREFIX}:papercusp:rt-1`)],
      resolve,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe('m1');
    expect(result).toMatchObject({ scanned: 1, resolved: 1, stillOpen: 0, unparseable: 0 });
  });

  it('resolves an escalation whose routine no longer exists (deleted)', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileDeadLoopEscalations({
      sql: fakeSql([]), // no matching row → routine deleted
      listOpen: async () => [rec('m1', `${LOOP_DEATH_SIGNATURE_PREFIX}:papercusp:rt-gone`)],
      resolve,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.resolved).toBe(1);
  });

  it('LEAVES an escalation open when the routine is still paused exactly as the watchdog left it', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileDeadLoopEscalations({
      sql: fakeSql([{ id: 'rt-1', active: false }]),
      listOpen: async () => [rec('m1', `${LOOP_DEATH_SIGNATURE_PREFIX}:papercusp:rt-1`)],
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, resolved: 0, stillOpen: 1, unparseable: 0 });
  });

  it('leaves a row with no parseable subjectSignature untouched (legacy row)', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileDeadLoopEscalations({
      sql: fakeSql([]),
      listOpen: async () => [rec('m1', '')], // empty/absent signature -> unparseable
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result.unparseable).toBe(1);
  });

  it('a resolveEscalation no-op sentinel (already_resolved) counts as stillOpen, not resolved', async () => {
    const resolve = vi.fn(async () => 'already_resolved' as const);
    const result = await reconcileDeadLoopEscalations({
      sql: fakeSql([{ id: 'rt-1', active: true }]),
      listOpen: async () => [rec('m1', `${LOOP_DEATH_SIGNATURE_PREFIX}:papercusp:rt-1`)],
      resolve,
    });
    expect(result).toMatchObject({ resolved: 0, stillOpen: 1 });
  });

  it('a listOpen failure fails soft to an empty (never-scanned) result, never throws', async () => {
    const result = await reconcileDeadLoopEscalations({
      sql: fakeSql([]),
      listOpen: async () => {
        throw new Error('boom');
      },
    });
    expect(result).toEqual({ scanned: 0, resolved: 0, stillOpen: 0, unparseable: 0 });
  });

  it('a routine-table read failure leaves every parsed row open rather than resolving blind', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileDeadLoopEscalations({
      sql: (async () => {
        throw new Error('pg down');
      }) as unknown as Sql,
      listOpen: async () => [rec('m1', `${LOOP_DEATH_SIGNATURE_PREFIX}:papercusp:rt-1`)],
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result.stillOpen).toBe(1);
  });
});

describe('reconcileLoopLifecycleDeathEscalations (loop-lifecycle-death watchdog)', () => {
  const routineRow = { id: 'rt-1', active: true, install_slug: 'papercusp', name: 'loop-su-test' };

  it('resolves when a LATER fire recorded ok (consecutive_errors reset to 0)', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileLoopLifecycleDeathEscalations({
      sql: fakeSql([routineRow]),
      listOpen: async () => [rec('m1', `${LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX}:papercusp:rt-1`)],
      resolve,
      readFireState: async () => ({ lastFiredAt: new Date(), consecutiveErrors: 0 }),
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.resolved).toBe(1);
  });

  it('LEAVES it open while the loop is still accruing consecutive errors', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileLoopLifecycleDeathEscalations({
      sql: fakeSql([routineRow]),
      listOpen: async () => [rec('m1', `${LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX}:papercusp:rt-1`)],
      resolve,
      readFireState: async () => ({ lastFiredAt: new Date(), consecutiveErrors: 2 }),
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result.stillOpen).toBe(1);
  });

  it('resolves when the routine was SUBSEQUENTLY auto-paused by the loop-death watchdog', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const readFireState = vi.fn(async () => ({ lastFiredAt: new Date(), consecutiveErrors: 5 }));
    const result = await reconcileLoopLifecycleDeathEscalations({
      sql: fakeSql([{ ...routineRow, active: false }]),
      listOpen: async () => [rec('m1', `${LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX}:papercusp:rt-1`)],
      resolve,
      readFireState,
    });
    // superseded-by-pause short-circuits before even consulting fire state
    expect(readFireState).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.resolved).toBe(1);
  });

  it('resolves when the routine no longer exists', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileLoopLifecycleDeathEscalations({
      sql: fakeSql([]),
      listOpen: async () => [rec('m1', `${LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX}:papercusp:rt-gone`)],
      resolve,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.resolved).toBe(1);
  });

  it('a null fire-state read (never fired under this identity) is treated as recovered, not stuck', async () => {
    const resolve = vi.fn(async () => ({}) as unknown);
    const result = await reconcileLoopLifecycleDeathEscalations({
      sql: fakeSql([routineRow]),
      listOpen: async () => [rec('m1', `${LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX}:papercusp:rt-1`)],
      resolve,
      readFireState: async () => null,
    });
    expect(result.resolved).toBe(1);
  });
});
