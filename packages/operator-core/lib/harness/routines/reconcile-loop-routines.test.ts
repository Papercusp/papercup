/**
 * Unit regression test for EI-2549 — the fleet-wide loop re-arm wedge.
 *
 * ROOT CAUSE: the operator's pooled `getOrgPg()` connection runs `prepare: false`, so
 * postgres-js returns `timestamptz` columns as STRINGS, not `Date`s. The original code called
 * `row.last_fired_at.getTime()`, which threw `getTime is not a function` on the FIRST row of
 * every reconcile pass — silently aborting the whole pass (caught by reconcileAndGovern's
 * best-effort try) so EVERY loop parked at infinity forever after one fire. The integration
 * tests used a direct, type-parsing connection (Date columns) and so never reproduced it — a
 * real test gap this closes by driving reconcileLoopRoutines with STRING-typed rows.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import { reconcileLoopRoutines } from './reconcile-loop-routines';

/** Never-breach terminal-guard stub for tests that only care about the pre-existing
 *  stuck-backstop re-arm behavior (WI-1399 added a guard check ahead of every stuck-backstop
 *  re-arm — these tests pin it to "no breach" so the original re-arm assertions still hold). */
const NEVER_BREACH_GUARD = vi.fn(async () => ({ breach: false }) as { breach: boolean; reason?: string });
/** No prior error streak, by default, for tests that don't care about the stuck-fire count. */
const NO_PRIOR_ERRORS = vi.fn(async () => null);

/** A minimal tagged-template stub mimicking postgres-js: the SELECT returns the seeded loop
 *  rows; any UPDATE records its params + reports one matched row. */
function fakeSql(rows: Record<string, unknown>[], updates: unknown[][]): Sql {
  return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join(' ? ');
    if (/UPDATE/i.test(q)) {
      updates.push(vals);
      return Promise.resolve([{ id: 'rt-1' }]);
    }
    return Promise.resolve(rows);
  }) as unknown as Sql;
}

describe('reconcileLoopRoutines — string-typed timestamptz columns (pooled prepare:false connection, EI-2549)', () => {
  const T0 = 1_782_000_000_000;
  // The exact shape postgres-js yields on a prepare:false connection: a raw PG timestamp string.
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it('re-arms a parked loop whose timestamptz columns arrive as STRINGS (the bug repro)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-test',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-test',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0), // STRING, not Date — `.getTime()` would throw here
          lifecycle_completed_at: pgString(T0 + 5_000), // STRING — the PRIMARY settle signal
          presence_last_active_at: null,
        },
      ],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 10_000, recordFire });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-1', via: 'lifecycle' });
    expect(res.loops[0].nextFireAt).toBe(T0 + 5_000 + 60_000); // completed + interval, from the string ts
    expect(updates).toHaveLength(1); // the re-arm UPDATE actually executed (pass not aborted)
    // P0b: a COMPLETED turn feeds the circuit with 'ok' (resets the failure streak).
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-test', expect.stringContaining('lifecycle'), 'ok');
  });

  it('string presence-quiescence fallback also re-arms (no lifecycle marker)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-test',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-test',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null,
          presence_last_active_at: pgString(T0 + 4_000), // STRING; quiet ≥60s by nowMs below
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 70_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });
});

describe('reconcileLoopRoutines — circuit feed (loop-wake-rate-limit-robustness P0b)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it("a stuck-park backstop re-arm feeds the circuit with 'error' (channel-agnostic dead-turn signal)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // the stuck-park backstop logs (expected)
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-stuck',
          target_owner_id: 'su-dead',
          interval_sec: 120,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-dead',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0), // fired long ago…
          lifecycle_completed_at: null, // …no completion marker (turn died / never delivered)…
          presence_last_active_at: null, // …and no post-fire activity.
        },
      ],
      updates,
    );
    // nowMs is well past max(30min, 4×interval) since the fire → the stuck-park backstop fires.
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.terminated).toEqual([]);
    expect(res.loops[0].via).toBe('stuck-backstop');
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-dead', expect.stringContaining('stuck-backstop'), 'error');
  });

  it('a still-in-flight loop (no signal, not yet stuck) re-arms NOTHING and feeds NOTHING', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-inflight',
          target_owner_id: 'su-busy',
          interval_sec: 120,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-busy',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null,
          presence_last_active_at: pgString(T0 + 1_000), // active AFTER the fire → a live long turn
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 5_000, recordFire });
    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalled();
  });
});

describe('reconcileLoopRoutines — dead-owner terminal guard (WI-1399)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  function stuckRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-dead',
      target_owner_id: 'su-permanently-gone',
      interval_sec: 120,
      parked: true,
      install_slug: 'papercusp',
      name: 'loop-su-gone',
      routine_workspace_id: 'ws-papercusp',
      last_fired_at: pgString(T0),
      lifecycle_completed_at: null,
      presence_last_active_at: null,
      ...overrides,
    };
  }

  it('a stuck-backstop fire whose terminal guard BREACHES is TERMINATED, not re-armed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 2 }));
    const checkUnreachableTerminalGuard = vi.fn(async () => ({ breach: true, reason: 'dead-owner: unreachable, WI-1399' }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
    });

    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(res.terminated).toEqual([
      { id: 'rt-dead', targetOwnerId: 'su-permanently-gone', reason: 'dead-owner: unreachable, WI-1399' },
    ]);
    expect(updates).toHaveLength(0); // no re-arm UPDATE fired — the guard's own autoPause already deactivated it
    // stuckFireCount passed to the guard is (prior consecutiveErrors=2) + 1 = 3 for THIS fire.
    expect(checkUnreachableTerminalGuard).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: 'rt-dead', targetOwnerId: 'su-permanently-gone', stuckFireCount: 3 }),
    );
    // Still recorded to the fire history (autoloop_state), per the terminal-guard contract.
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-gone', 'loop-terminal-unreachable', 'error');
  });

  it('a stuck-backstop fire whose terminal guard does NOT breach re-arms exactly as before (backward-compat)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => null); // no prior errors → stuckFireCount = 1
    const checkUnreachableTerminalGuard = vi.fn(async () => ({ breach: false }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-dead', via: 'stuck-backstop' });
    expect(checkUnreachableTerminalGuard).toHaveBeenCalledWith(expect.objectContaining({ stuckFireCount: 1 }));
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-gone', expect.stringContaining('stuck-backstop'), 'error');
  });

  it('a terminal-guard check failure is fail-soft — falls back to the normal stuck-backstop re-arm', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => null);
    const checkUnreachableTerminalGuard = vi.fn(async () => {
      throw new Error('probe read failed');
    });

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(1); // never blocked / never threw — the row was still re-armed to retry
  });

  it('a readFireState failure is fail-soft — treated as zero prior errors, guard still consulted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => {
      throw new Error('pg read failed');
    });
    const checkUnreachableTerminalGuard = vi.fn(async () => ({ breach: false }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
    });

    expect(res.rearmed).toBe(1);
    expect(checkUnreachableTerminalGuard).toHaveBeenCalledWith(expect.objectContaining({ stuckFireCount: 1 }));
  });
});
