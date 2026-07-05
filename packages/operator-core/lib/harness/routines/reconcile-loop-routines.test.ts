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

/** HERMETIC wrapper — do NOT call reconcileLoopRoutines bare. fakeSql intercepts the SQL,
 *  but the DEFAULT recordFire/readFireState bind getOrgPg() — the LIVE dev database — so a
 *  bare call leaks fire-state writes into dev PG (the EI-7006 time-bomb flake, 2026-07-03).
 *  Explicit injections in `o` still win (spread order). */
const reconcile = (o: NonNullable<Parameters<typeof reconcileLoopRoutines>[0]>) =>
  reconcileLoopRoutines({ recordFire: async () => {}, readFireState: async () => null, ...o });
/** No prior error streak, by default, for tests that don't care about the stuck-fire count. */
const NO_PRIOR_ERRORS = vi.fn(async () => null);

/** A minimal tagged-template stub mimicking postgres-js: the SELECT returns the seeded loop
 *  rows; any UPDATE records its params + reports one matched row. */
function fakeSql(rows: Record<string, unknown>[], updates: unknown[][]): Sql {
  return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join(' ? ');
    // Anchor on the statement HEAD: the reconcile SELECT legitimately contains the
    // substring "update" (carry_notes.updated_ts), so a bare /UPDATE/i misclassifies it.
    if (/^\s*UPDATE/i.test(q)) {
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
    const res = await reconcile({ sql, nowMs: T0 + 10_000, recordFire });
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
    const res = await reconcile({ sql, nowMs: T0 + 70_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });
});

describe('reconcileLoopRoutines — cold settle ladder (su-cold-auto 2026-07-03)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
  const coldRow = (over: Record<string, unknown>) => ({
    id: 'rt-1',
    target_owner_id: 'su-test',
    interval_sec: 60,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-test',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    presence_last_active_at: null,
    carry: 'cold',
    note_updated_ts: null,
    ...over,
  });

  it("the reset boundary (ended→started back-to-back at delivery) is NOT a settle — the 'ended' is the DYING session, not the woken turn finishing", async () => {
    // Live repro (fire #4972 → overlap #4979): cold delivery at T0+1s restarts the session —
    // old process emits 'ended' (+1000ms), new process 'started' (+1250ms). The cold turn is
    // STILL RUNNING; re-arming off that 'ended' fires the next wake mid-turn.
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          lifecycle_completed_at: pgString(T0 + 1_000),
          lifecycle_started_at: pgString(T0 + 1_250), // newest marker is 'started' → session RUNNING
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // no re-arm UPDATE — the loop stays parked until the cold turn settles
  });

  it("the cold turn's OWN Stop-hook 'ended' (newer than the boundary 'started') IS the settle", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          lifecycle_completed_at: pgString(T0 + 90_000), // the cold turn finished at +90s
          lifecycle_started_at: pgString(T0 + 1_250), // the boundary 'started' is older
        }),
      ],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({ sql, nowMs: T0 + 95_000, recordFire });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle');
    expect(res.loops[0].nextFireAt).toBe(T0 + 90_000 + 60_000); // completed + interval, off the REAL settle
  });

  it("a warm loop (no carry marker) with a post-fire 'ended' settles exactly as before", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          carry: null, // WARM loop
          lifecycle_completed_at: pgString(T0 + 5_000),
          lifecycle_started_at: null, // warm: 'started' fired at boot, outside the > last_fired window
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle');
  });

  it('the carry-note REFRESH is a cold settle (the protocol\'s own completion receipt), even with no turn-ended marker', async () => {
    // The iteration checkpointed (loop:checkpoint before turn end) but its Stop report was
    // dropped — the note refresh is authoritative evidence the iteration ran.
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          lifecycle_completed_at: pgString(T0 + 1_000),
          lifecycle_started_at: pgString(T0 + 1_250), // boundary only — no turn-ended yet
          note_updated_ts: String(T0 + 45_000), // bigint arrives as a STRING over the wire
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 50_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('note-refresh');
    expect(res.loops[0].nextFireAt).toBe(T0 + 45_000 + 60_000);
  });

  it('bare presence-quiescence is NOT a cold settle — a recycled, booted-but-idle session whose carry inject was dropped must NOT re-fire (the stale-note treadmill, wakes #5033→#5036)', async () => {
    // Live repro: the wc8 RECYCLE killed the child (ended, no started yet / boot idle),
    // presence advanced at boot then went quiet ≥60s with the iteration NEVER run. The old
    // quiescence fallback read that as settled and fired wc9 91s later into a booting host.
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          lifecycle_completed_at: pgString(T0 + 1_000), // the recycle kill's 'ended'
          lifecycle_started_at: null, // fresh child hasn't emitted 'started' (or boot idle)
          presence_last_active_at: pgString(T0 + 5_000), // boot activity, then quiet
          note_updated_ts: String(T0 - 300_000), // note is STALE (pre-fire) — iteration never ran
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 100_000 }); // 95s quiet — old code re-fired here
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // parked until real evidence (or the stuck-park backstop retries)
  });

  it('a warm loop still recovers via presence-quiescence (the fallback is unchanged for warm)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          carry: null, // WARM loop
          lifecycle_completed_at: null,
          lifecycle_started_at: null,
          presence_last_active_at: pgString(T0 + 30_000), // worked until +30s, then quiet
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 100_000 }); // 70s quiet
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
    const res = await reconcile({ sql, nowMs: T0 + 5_000, recordFire });
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

  it('a stuck-backstop fire whose terminal guard BREACHES is TERMINATED, not re-armed — AND (WI-2339 D+E) cancels the ghost inbox-wake + loudly escalates', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 2 }));
    const checkUnreachableTerminalGuard = vi.fn(async () => ({ breach: true, reason: 'dead-owner: unreachable, WI-1399' }));
    // WI-2339 fixes D + E — injected so the unit stays hermetic (the real defaults hit coord/PG).
    const cancelInboxWake = vi.fn(async () => 1);
    const escalateDeadLoop = vi.fn(async () => {});

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
      cancelInboxWake,
      escalateDeadLoop,
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
    // WI-2339 fix D — the dead owner's ghost standing inbox-wake await is cancelled so it stops
    // poisoning every OTHER wake source (called with the owner + its workspace).
    expect(cancelInboxWake).toHaveBeenCalledWith('su-permanently-gone', 'ws-papercusp');
    // WI-2339 fix E — a loud human escalation is raised (pause+escalate, not silent no-op), carrying
    // the routine/owner/harness + the guard's reason.
    expect(escalateDeadLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-dead',
        targetOwnerId: 'su-permanently-gone',
        installSlug: 'papercusp',
        name: 'loop-su-gone',
        reason: 'dead-owner: unreachable, WI-1399',
      }),
    );
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

describe('reconcileLoopRoutines — circuit-open fast path (EI-7006)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  function parkedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-dead',
      target_owner_id: 'su-permanently-gone',
      interval_sec: 120, // stuckParkMs = max(30min, 4×120s=8min) = 30min
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

  it('PROPERTY (dead-owner terminates fast): a CIRCUIT-OPEN loop is routed to the guard BEFORE the stuck-park dwell elapses, and TERMINATES', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 12 })); // ≥8 → circuit OPEN
    const guard = vi.fn(async () => ({ breach: true, reason: 'dead-owner circuit-open, WI-1399 / EI-7006' }));

    // nowMs is only 2 min past the fire — WELL UNDER stuckParkMs(120s)=30min. The OLD code would
    // never consult the guard here (stuck-park branch not entered); the fix routes it via circuitOpen.
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 2 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
      cancelInboxWake: async () => 0, // WI-2339 D/E: hermetic no-ops (real defaults hit coord/PG)
      escalateDeadLoop: async () => {},
    });

    expect(res.terminated).toEqual([
      { id: 'rt-dead', targetOwnerId: 'su-permanently-gone', reason: 'dead-owner circuit-open, WI-1399 / EI-7006' },
    ]);
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // never re-armed — the guard's own autoPause deactivated it
    // Routed WITH the circuit-open flag + stuckFireCount == consecutiveErrors (NOT +1).
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ circuitOpen: true, stuckFireCount: 12 }));
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-gone', 'loop-terminal-unreachable', 'error');
  });

  it('a CIRCUIT-OPEN but still-REACHABLE loop (guard declines) is neither terminated nor re-armed — the fire-gate owns cadence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 12 }));
    const guard = vi.fn(async () => ({ breach: false })); // reachable → guard declines

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 2 * 60_000, // under the stuck-park dwell
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0); // NOT stuck-park-elapsed → NOT re-armed (don't fight the circuit backoff)
    expect(updates).toHaveLength(0);
    expect(recordFire).not.toHaveBeenCalled(); // no error recorded — left to the fire-gate
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ circuitOpen: true }));
  });

  it('PROPERTY (healthy long turn NEVER terminates): a loop with activity AFTER the fire — even past the stuck-park dwell — is skipped for free (guard + fire-state never consulted)', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    // Would be circuit-open (99≥8) and would breach IF consulted — proving the pre-filter, not the guard, protects it.
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 99 }));
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called' }));
    // Active 40min AFTER the fire (past the 30min dwell); nowMs only 30s later, so NOT presence-quiescent yet.
    const sql = fakeSql([parkedRow({ presence_last_active_at: pgString(T0 + 40 * 60_000) })], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 40 * 60_000 + 30_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0);
    expect(guard).not.toHaveBeenCalled(); // never consulted — the loop looks alive
    expect(readFireState).not.toHaveBeenCalled(); // cheap pre-filter: no fire-state read for a live loop
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('a stuck-park loop that is ALSO circuit-open still terminates (both triggers true, circuitOpen wins the fast path)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 40 }));
    const guard = vi.fn(async () => ({ breach: true, reason: 'dead-owner, EI-7006' }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000, // BOTH stuck-park-elapsed AND circuit-open
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
      cancelInboxWake: async () => 0, // WI-2339 D/E: hermetic no-ops (real defaults hit coord/PG)
      escalateDeadLoop: async () => {},
    });

    expect(res.terminated).toHaveLength(1);
    expect(res.rearmed).toBe(0);
    // circuit-open takes precedence → stuckFireCount is the raw streak (40), not streak+1.
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ circuitOpen: true, stuckFireCount: 40 }));
  });
});

describe('reconcileLoopRoutines — WI-2714 quick-retry leg (recover-then-escalate, not escalate-only)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  function parkedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-parked',
      target_owner_id: 'su-parked',
      interval_sec: 60, // quickRetryParkMs = max(10min, 3×60s=3min) = 10min; stuckParkMs = max(30min,4×60s) = 30min
      parked: true,
      install_slug: 'papercusp',
      name: 'loop-su-parked',
      routine_workspace_id: 'ws-papercusp',
      last_fired_at: pgString(T0),
      lifecycle_completed_at: null,
      presence_last_active_at: null,
      ...overrides,
    };
  }

  it('a quiet-parked, REACHABLE loop retries EARLY (10min, well before the classic 30min dwell) when under the attempt cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 })); // first attempt
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called-this-early' }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10 * 60_000, // exactly the quick-retry floor, WELL under the 30min classic dwell
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.rearmed).toBe(1);
    expect(res.terminated).toEqual([]);
    expect(res.loops[0]).toMatchObject({ id: 'rt-parked', via: 'stuck-backstop', quickRetry: true });
    // The terminal guard must NEVER be consulted this early — quick-retry only ever attempts
    // another wake, never a pause (the dwell + reachability veto for TERMINATION is untouched).
    expect(guard).not.toHaveBeenCalled();
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-parked', expect.stringContaining('stuck-backstop'), 'error');
  });

  it('does NOT quick-retry before the quick-retry floor — a loop parked only 5min is left untouched', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 }));
    const sql = fakeSql([parkedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 5 * 60_000, // under BOTH the quick-retry floor (10min) and the classic dwell
      recordFire,
      readFireState,
    });

    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('quick-retry is BOUNDED — once consecutiveErrors reaches the attempt cap (3), it stops firing early and falls back to needing the classic dwell', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    // 3 prior quick-retry attempts already recorded — at the cap, so quick-retry is no longer eligible.
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 3 }));
    const sql = fakeSql([parkedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10 * 60_000, // past the quick-retry floor, but still WELL under the classic 30min dwell
      recordFire,
      readFireState,
    });

    expect(res.rearmed).toBe(0); // exhausted quick-retry, not yet at the classic dwell → left untouched
    expect(updates).toHaveLength(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('once past the classic dwell, behaves exactly as the pre-existing stuck-backstop path (quickRetry NOT flagged)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 }));
    const guard = vi.fn(async () => ({ breach: false }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000, // past the classic 30min dwell
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-parked', via: 'stuck-backstop' });
    expect(res.loops[0].quickRetry).toBeUndefined();
    expect(guard).toHaveBeenCalled(); // classic path DOES consult the terminal guard
  });

  it('a CIRCUIT-OPEN loop is never quick-retried early — routed to the terminal-guard fast path instead (no fight with the circuit backoff)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 12 })); // ≥8 → circuit OPEN
    const guard = vi.fn(async () => ({ breach: false }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10 * 60_000, // past the quick-retry floor
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    // circuitOpen routes to the (declined) terminal-guard fast path, same as EI-7006 — never the
    // quick-retry leg (quick-retry explicitly excludes circuitOpen so it never fights the backoff).
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ circuitOpen: true }));
    expect(res.rearmed).toBe(0); // guard declined AND not stuck-park-elapsed yet → left untouched
  });

  it('a HEALTHY (active-since-fire) loop is never quick-retried — the pre-filter protects it exactly as before', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 }));
    const sql = fakeSql([parkedRow({ presence_last_active_at: pgString(T0 + 9 * 60_000) })], updates); // active at +9min
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10 * 60_000, // past the quick-retry floor, but presence shows genuine post-fire activity
      recordFire,
      readFireState,
    });
    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS<=0 disables the quick-retry leg entirely (fail-soft to today\'s behavior)', async () => {
    const prev = process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS;
    process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS = '0';
    try {
      const updates: unknown[][] = [];
      const recordFire = vi.fn(async () => {});
      const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 }));
      const sql = fakeSql([parkedRow()], updates);
      const res = await reconcileLoopRoutines({
        sql,
        nowMs: T0 + 10 * 60_000, // past the quick-retry floor — would have retried if enabled
        recordFire,
        readFireState,
      });
      expect(res.rearmed).toBe(0);
      expect(recordFire).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS;
      else process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS = prev;
    }
  });
});
