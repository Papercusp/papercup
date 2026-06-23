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
    const res = await reconcileLoopRoutines({ sql, nowMs: T0 + 31 * 60_000, recordFire });
    expect(res.rearmed).toBe(1);
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
