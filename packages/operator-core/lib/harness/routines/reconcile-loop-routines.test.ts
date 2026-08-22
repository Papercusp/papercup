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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { parseUsageReset } from '@papercusp/papercusp-shared/agent';
import { reconcileLoopRoutines, classifyLoopLifecycleTurn, defaultEscalateLifecycleDeath } from './reconcile-loop-routines';

// EI-18668025239634541 recurrence guard: mocked so the test below can assert on the
// `meta.subjectSignature` (conditionKey) `defaultEscalateLifecycleDeath` passes through —
// the exact field that was missing and caused every provider-kill occurrence to leak a
// fresh permanently-open escalation instead of coalescing onto one row.
vi.mock('../../agent-tools/coordination/escalations', () => ({
  openEscalation: vi.fn(async () => undefined),
}));
import { openEscalation } from '../../agent-tools/coordination/escalations';

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

describe('reconcileLoopRoutines — stale pure-loop parked snapshot cannot overwrite a re-arm (EI-21122026530854360)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it('skips the stale completion UPDATE after loop:arm has installed a fresh finite schedule', async () => {
    const statements: string[] = [];
    // The SELECT snapshot says the pure loop is parked, but loop:arm won the race afterward
    // and the live row now has a fresh finite next_fire_at. An unguarded LEAST UPDATE would
    // match this state and regress that schedule to the stale completion + interval value.
    const sql = ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
      const query = strings.join(' ? ');
      if (/^\s*UPDATE/i.test(query)) {
        statements.push(query);
        const hasPureLoopParkGuard =
          query.includes("jsonb_exists(trigger_config, 'cron')") &&
          query.includes("next_fire_at = 'infinity'::timestamptz");
        // Simulate the live row's WHERE evaluation: it is finite now, so the fixed guard
        // yields zero rows. The pre-fix statement would report one matched row here.
        return Promise.resolve(hasPureLoopParkGuard ? [] : [{ id: 'rt-race' }]);
      }
      return Promise.resolve([
        {
          id: 'rt-race',
          target_owner_id: 'su-race',
          interval_sec: 60,
          parked: true,
          is_cron: false,
          install_slug: 'papercusp',
          name: 'loop-su-race',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: pgString(T0 + 5_000),
          presence_last_active_at: null,
        },
      ]);
    }) as unknown as Sql;

    const res = await reconcile({
      sql,
      nowMs: T0 + 10_000,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("jsonb_exists(trigger_config, 'cron')");
    expect(statements[0]).toContain("next_fire_at = 'infinity'::timestamptz");
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

  it('releases a never-fired cold loop only after a carry-note newer than the arm settles it', async () => {
    const updates: unknown[][] = [];
    const armedAt = T0 + 1_000;
    const noteAt = T0 + 5_000; // the long arming turn checkpoints after the nominal first-fire time
    const sql = fakeSql(
      [
        coldRow({
          last_fired_at: null,
          armed_at: pgString(armedAt),
          note_updated_ts: String(noteAt),
        }),
      ],
      updates,
    );

    const res = await reconcile({ sql, nowMs: T0 + 10_000 });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({
      id: 'rt-1',
      completedAt: noteAt,
      nextFireAt: noteAt + 60_000,
      via: 'initial-cold-note-refresh',
    });
    expect(updates).toHaveLength(1);
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

describe('reconcileLoopRoutines — turn-journal completion signal (WI-6069)', () => {
  // Root cause: `lifecycle-report.sh` (the kind='lifecycle' 'ended' marker) is wired in
  // ~/.claude/settings.json ONLY to SessionStart/SessionEnd, never to Stop — so it only ever
  // fires at a genuine session restart, never at an ordinary turn boundary. A warm session
  // driven entirely by push wakes (events:await / a loop re-wake) never restarts, so before
  // this fix it never got a completion signal from layer 1 and (absent quiescence) silently
  // degraded to the ~30min stuck-park backstop every fire, regardless of the configured
  // interval. `session_turn_journal` (P-012's per-CLI Stop-hook journal write) DOES fire at
  // the end of every ordinary turn — this is the new layer-1.5 signal that closes the gap.
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
  const warmRow = (over: Record<string, unknown>) => ({
    id: 'rt-1',
    target_owner_id: 'su-test',
    interval_sec: 60,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-test',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: null,
    lifecycle_started_at: null,
    presence_last_active_at: null,
    ...over,
  });

  it("re-arms via 'turn-journal' off a per-turn Stop-hook journal write, with NO lifecycle marker and NO presence-quiescence quiet-gap needed", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [warmRow({ turn_journal_completed_at: pgString(T0 + 5_000) })],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    // Only 6s after the fire — well short of FALLBACK_QUIET_MS (60s) — so presence-quiescence
    // could never have settled this; turn-journal is the ONLY signal that can.
    const res = await reconcile({ sql, nowMs: T0 + 6_000, recordFire });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-1', via: 'turn-journal' });
    expect(res.loops[0].nextFireAt).toBe(T0 + 5_000 + 60_000); // completed + interval
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-test', expect.stringContaining('turn-journal'), 'ok');
  });

  it('the lifecycle marker still wins when BOTH signals are present (no behavior change for a session that DOES restart)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          lifecycle_completed_at: pgString(T0 + 3_000),
          turn_journal_completed_at: pgString(T0 + 5_000),
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle');
    expect(res.loops[0].completedAt).toBe(T0 + 3_000);
  });

  it("a turn-journal settle whose turn text is a provider-kill signature is reclassified as 'error' (EI-13818 coverage extended to this via)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          turn_journal_completed_at: pgString(T0 + 5_000),
          last_assistant_text_after_fire: 'You have exceeded your usage limit · resets 5:40am',
        }),
      ],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({ sql, nowMs: T0 + 6_000, recordFire });
    expect(res.rearmed).toBe(1);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-test',
      expect.stringContaining('loop-lifecycle-death'),
      'error',
    );
  });

  it('a COLD loop does NOT consult turn_journal_completed_at (it has its own two-signal ladder) — an otherwise-signal-less cold fire is left in flight', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          carry: 'cold',
          note_updated_ts: null,
          turn_journal_completed_at: pgString(T0 + 5_000), // present, but must be ignored for cold
          presence_last_active_at: pgString(T0 + 5_000), // active since fire → not stuck either
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0);
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

describe('reconcileLoopRoutines — stuck-backstop (no-signal) death reclassification (EI-19295537569038753)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it("a wedged session that never produces a completion SIGNAL (no lifecycle marker, no presence bump) still gets its captured text reclassified — reset-aware rearm past the bare interval, not the blind stuck-backstop interval", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic logs
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-wedged',
          target_owner_id: 'su-wedged',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-wedged',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null, // no Stop-hook 'ended' — the process never cleanly exits
          presence_last_active_at: null, // no post-fire activity AT ALL (signal === null: see completionSignal)
          // The turn's own final text DID capture the wall — a text-only reply with no tool
          // call, so presence never bumped and neither lifecycle/turn-journal/presence-quiescence
          // ever produces a `signal`. Before this fix, this field was fetched and then never read
          // on this branch.
          last_assistant_text_after_fire: "You've hit your session limit · resets 5:40am (America/New_York)",
        },
      ],
      updates,
    );
    // Past the classic stuck-park dwell (>=30min) so the backstop actually fires.
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('stuck-backstop'); // the signal classification itself is unchanged
    // The whole point: this must NOT be the bare lastFiredMs+interval a blind stuck-backstop uses.
    expect(res.loops[0].nextFireAt).toBeGreaterThan(T0 + 60_000);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-wedged',
      expect.stringContaining('lifecycle-death:usage_limit'), // not the bare 'loop-stuck-backstop' detail
      'error', // stuck-backstop always recorded 'error' — unchanged, just now correctly reset-aware
    );
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-wedged',
        targetOwnerId: 'su-wedged',
        verdict: expect.objectContaining({ reason: 'usage_limit' }),
      }),
    );
  });

  it('a stuck-backstop row with ORDINARY (or absent) captured text is unaffected — still the plain bare-interval backstop rearm (no regression)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-dead',
          target_owner_id: 'su-dead',
          interval_sec: 120,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-dead',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null,
          presence_last_active_at: null,
          last_assistant_text_after_fire: null, // never delivered / no text at all — the common case
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('stuck-backstop');
    expect(res.loops[0].nextFireAt).toBe(T0 + 120_000); // byte-identical to the pre-fix math
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-dead', expect.stringContaining('stuck-backstop'), 'error');
    expect(escalateLifecycleDeath).not.toHaveBeenCalled();
  });
});

describe('classifyLoopLifecycleTurn — pure classifier (EI-13818)', () => {
  const NOW = 1_782_000_000_000;

  it('returns null for a genuine settle (no provider-kill signature)', () => {
    expect(classifyLoopLifecycleTurn('Fixed the bug, tests green, work item complete.', 60_000, NOW)).toBeNull();
  });

  it('returns null for absent/blank text (a read miss must never manufacture a death)', () => {
    expect(classifyLoopLifecycleTurn(null, 60_000, NOW)).toBeNull();
    expect(classifyLoopLifecycleTurn(undefined, 60_000, NOW)).toBeNull();
    expect(classifyLoopLifecycleTurn('   ', 60_000, NOW)).toBeNull();
  });

  it("classifies a usage_limit death and computes a reset-aware rearm delay (not the bare interval)", () => {
    const text = "You've hit your session limit · resets 5:40am (America/New_York)";
    const verdict = classifyLoopLifecycleTurn(text, 60_000, NOW);
    expect(verdict?.reason).toBe('usage_limit');
    expect(verdict?.evidence).toContain('session limit');
    // Cross-check against the SAME reset parser the verdict reuses — no independent TZ math.
    const expectedReset = parseUsageReset(text, NOW);
    expect(expectedReset).toBeDefined();
    expect(verdict?.rearmDelayMs).toBe(Math.min(Math.max(expectedReset!.atMs - NOW, 60_000), 6 * 3_600_000));
    expect(verdict?.rearmDelayMs).toBeGreaterThan(60_000); // strictly more than the bare interval
  });

  // WI-6852: the cap was 1h, which BOUND on every real wall instead of acting as a sanity rail
  // (measured: 13 of 15 lifecycle-death re-arms landed on exactly 60m, i.e. every one was clipped
  // and under-waited, then re-fired into the still-active wall). Relative-duration text is used
  // here deliberately: it pins the expected value with no timezone math to get wrong.
  it('does NOT clip a multi-hour wall to the old 1h cap (WI-6852)', () => {
    const verdict = classifyLoopLifecycleTurn(
      "You've hit your session limit · resets in 3 hours",
      60_000,
      NOW,
    );
    expect(verdict?.reason).toBe('usage_limit');
    expect(verdict?.rearmDelayMs).toBe(3 * 3_600_000);
    expect(verdict?.rearmDelayMs).toBeGreaterThan(3_600_000); // the old cap would have clipped it
  });

  it('still applies a sanity ceiling so a bogus parse cannot park a loop for a day', () => {
    const verdict = classifyLoopLifecycleTurn(
      "You've hit your session limit · resets in 30 hours",
      60_000,
      NOW,
    );
    expect(verdict?.rearmDelayMs).toBe(6 * 3_600_000);
  });

  // EI-20544023385610622 — THE DEFECT, at the layer that exhibited it. EI-20542327908037306 taught
  // the parser the weekly form, but this caller then clipped the correctly-parsed ~113h hold to the
  // 6h cap tuned for DAILY walls, so a walled loop still re-fired ~4x/day into a window it already
  // knew was closed — each COLD fire burning a full context reset for zero work.
  it('holds a date-qualified WEEKLY wall in full instead of clipping it to the daily 6h cap', () => {
    // Sat Aug 15 → the following Thu Aug 20: days out, and the message NAMES the date.
    const now = Date.parse('2026-08-15T17:47:00Z');
    const text = "You've hit your weekly limit · resets Aug 20, 7am (America/New_York)";
    const verdict = classifyLoopLifecycleTurn(text, 60_000, now);
    expect(verdict?.reason).toBe('usage_limit');
    // Pinned against the same parser, so no independent TZ math can drift.
    const reset = parseUsageReset(text, now);
    expect(reset?.precision).toBe('dated');
    expect(verdict?.rearmDelayMs).toBe(reset!.atMs - now);
    // The regression this pins: the old single cap returned exactly 6h here.
    expect(verdict?.rearmDelayMs).toBeGreaterThan(6 * 3_600_000);
    expect(verdict?.rearmDelayMs).toBeGreaterThan(4 * 86_400_000);
  });

  // The other half of the same decision: widening the ceiling for a NAMED instant must not widen
  // it for an INFERRED one, or the mis-parse hazard the rail exists to prevent comes back for
  // every loop on the box.
  it('does NOT extend the ceiling for a bare-clock reset, whose day is inferred', () => {
    const now = Date.parse('2026-08-15T17:47:00Z');
    // "resets 4am" ~10h out by the next-occurrence rule — beyond 6h, and still clipped to it.
    const verdict = classifyLoopLifecycleTurn(
      "You've hit your session limit · resets 4am (America/New_York)",
      60_000,
      now,
    );
    expect(parseUsageReset('resets 4am', now)?.precision).toBe('clock');
    expect(verdict?.rearmDelayMs).toBe(6 * 3_600_000);
  });

  it('classifies an auth_wall death with the plain-interval rearm (no reset time to parse)', () => {
    const text = 'Your organization has disabled Claude subscription access for Claude Code.';
    const verdict = classifyLoopLifecycleTurn(text, 60_000, NOW);
    expect(verdict?.reason).toBe('auth_wall');
    expect(verdict?.rearmDelayMs).toBe(60_000);
  });

  it('never shortens the rearm below the loop interval', () => {
    // A reset time in the very near future (or already past — "already passed today" pushes to
    // tomorrow per parseUsageReset, but even a same-second edge case must never UNDERCUT the
    // caller's own interval floor).
    const verdict = classifyLoopLifecycleTurn("hit your usage limit · resets now", 5 * 60_000, NOW);
    expect(verdict?.rearmDelayMs).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe('reconcileLoopRoutines — lifecycle-death reclassification (EI-13818)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it("a CLEANLY-completed turn whose text is a session-limit death feeds 'error' (not a false 'ok') and re-arms past the bare interval", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-leader',
          interval_sec: 180, // the reported incident's ~3min cadence
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-leader',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: pgString(T0 + 5_000), // the Stop hook DID fire — a "clean" exit
          presence_last_active_at: null,
          last_assistant_text_after_fire: "You've hit your session limit · resets 5:40am (America/New_York)",
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle'); // the signal itself is unchanged — only the outcome is
    // The whole point: this must NOT be the bare completedAt+interval a false 'ok' would use.
    expect(res.loops[0].nextFireAt).toBeGreaterThan(T0 + 5_000 + 180_000);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-leader',
      expect.stringContaining('lifecycle-death:usage_limit'),
      'error', // NOT 'ok' — this is the exact false-positive the bug report describes
    );
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-1',
        targetOwnerId: 'su-leader',
        verdict: expect.objectContaining({ reason: 'usage_limit' }),
      }),
    );
  });

  it('a lifecycle completion with ORDINARY text is unaffected — still feeds `ok` at the bare interval', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-healthy',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-healthy',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: pgString(T0 + 5_000),
          presence_last_active_at: null,
          last_assistant_text_after_fire: 'Checkpointed and ending the turn — work continues next wake.',
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].nextFireAt).toBe(T0 + 5_000 + 60_000); // byte-identical to the pre-EI-13818 math
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-healthy', expect.stringContaining('lifecycle'), 'ok');
    expect(escalateLifecycleDeath).not.toHaveBeenCalled();
  });
});

describe('reconcileLoopRoutines — presence-quiescence death reclassification (EI-15722)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it("a presence-quiescence settle whose last turn text is a provider-kill signature feeds 'error' (not a false 'ok') and re-arms past the bare interval — the exact false-positive that let a loop fire on schedule for 22h+ with zero real turns", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-stuck',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-stuck',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          // NO lifecycle 'ended' marker — the Stop-hook report was lost (the exact reason the
          // presence-quiescence fallback exists at all: layer 2, "a detached, fail-open POST").
          lifecycle_completed_at: null,
          presence_last_active_at: pgString(T0 + 4_000), // one dispatch bumped activity, then quiet
          last_assistant_text_after_fire: "You've hit your session limit · resets 5:40am (America/New_York)",
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 70_000, // ≥ FALLBACK_QUIET_MS (60s) past the last activity, so the fallback fires
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence'); // the signal itself is unchanged — only the outcome is
    // The whole point: this must NOT be the bare completedAt+interval a false 'ok' would use.
    expect(res.loops[0].nextFireAt).toBeGreaterThan(T0 + 4_000 + 60_000);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-stuck',
      expect.stringContaining('lifecycle-death:usage_limit'),
      'error', // NOT 'ok' — previously this via recorded 'ok' unconditionally, with no text check at all
    );
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-1',
        targetOwnerId: 'su-stuck',
        verdict: expect.objectContaining({ reason: 'usage_limit' }),
      }),
    );
  });

  it('a presence-quiescence settle with ORDINARY (or absent) turn text is unaffected — still feeds `ok` at the bare interval', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-healthy',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-healthy',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null,
          presence_last_active_at: pgString(T0 + 4_000),
          last_assistant_text_after_fire: 'Claimed the next bug and fixed it — ending the turn.',
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 70_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
    expect(res.loops[0].nextFireAt).toBe(T0 + 4_000 + 60_000); // byte-identical to the pre-EI-15722 math
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-healthy', expect.stringContaining('presence-quiescence'), 'ok');
    expect(escalateLifecycleDeath).not.toHaveBeenCalled();
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
    // GENUINELY still-active: last activity 30s ago — inside FALLBACK_QUIET_MS (60s), so the
    // presence-quiescence settle path does NOT fire (that would legitimately re-arm a
    // worked-then-quiet turn, a DIFFERENT leg). completionSignal → null, so we actually reach the
    // quick-retry pre-filter, whose `presence_last_active_at > last_fired` test leaves this healthy
    // loop untouched. (A +9min/+10min fixture is 60s-quiet = exactly settled → re-arms via
    // presence-quiescence, which is NOT what this test means to assert.)
    const sql = fakeSql([parkedRow({ presence_last_active_at: pgString(T0 + 10 * 60_000 - 30_000) })], updates); // active 30s ago
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

describe('reconcileLoopRoutines — ARMED-loop reachability sweep (EI-11407)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
  const TERMINAL_WINDOW_MS = 2 * 3600_000; // DEFAULT_TERMINAL_UNREACHABLE_MS (60s interval floors to this)

  /** An ARMED (not parked, not cron) pure loop that has already fired + settled once. */
  function armedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-armed',
      target_owner_id: 'su-armed-owner',
      interval_sec: 60,
      parked: false,
      is_cron: false,
      install_slug: 'papercusp',
      name: 'loop-su-armed',
      routine_workspace_id: 'ws-papercusp',
      last_fired_at: pgString(T0),
      lifecycle_completed_at: null,
      lifecycle_started_at: null,
      presence_last_active_at: null,
      ...overrides,
    };
  }

  it('an ARMED loop well within the terminal window is left alone — the guard is never even consulted', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called' }));
    const sql = fakeSql([armedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 3600_000, // 1h — under the 2h terminal window
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    expect(guard).not.toHaveBeenCalled();
    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0); // an armed loop is never rebased — nothing to fold
    expect(updates).toHaveLength(0);
  });

  it('an ARMED loop past the terminal window with an UNREACHABLE owner is TERMINATED (not re-armed) — full WI-2339 D+E side effects fire', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const cancelInboxWake = vi.fn(async () => 1);
    const escalateDeadLoop = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'dead-owner: unreachable (armed, EI-11407)' }));
    const sql = fakeSql([armedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + TERMINAL_WINDOW_MS + 1_000, // just past the 2h terminal window
      recordFire,
      checkUnreachableTerminalGuard: guard,
      cancelInboxWake,
      escalateDeadLoop,
    });

    expect(res.terminated).toEqual([
      { id: 'rt-armed', targetOwnerId: 'su-armed-owner', reason: 'dead-owner: unreachable (armed, EI-11407)' },
    ]);
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // no rebase UPDATE — the guard's autoPause deactivated it directly
    // The guard's fire-count floor is pre-satisfied (no discrete fire-attempt streak exists for
    // an armed loop) and circuitOpen is always false on this leg.
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: 'rt-armed', targetOwnerId: 'su-armed-owner', circuitOpen: false }),
    );
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-armed', 'loop-terminal-unreachable', 'error');
    expect(cancelInboxWake).toHaveBeenCalledWith('su-armed-owner', 'ws-papercusp');
    expect(escalateDeadLoop).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: 'rt-armed', targetOwnerId: 'su-armed-owner' }),
    );
  });

  it('an ARMED loop past the terminal window whose owner IS reachable is left armed (guard declines, no termination, no rearm)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: false }));
    const sql = fakeSql([armedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + TERMINAL_WINDOW_MS + 1_000,
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    expect(guard).toHaveBeenCalled();
    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0); // armed loops are never rebased by this sweep regardless
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('dwell is measured from the LATEST known-alive evidence — recent presence activity after the fire resets the clock', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called-yet' }));
    // Activity 30min after the fire — the real dwell floor is THIS, not last_fired_at.
    const sql = fakeSql([armedRow({ presence_last_active_at: pgString(T0 + 1800_000) })], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 1800_000 + TERMINAL_WINDOW_MS - 1_000, // just under 2h since the LATEST activity
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    expect(guard).not.toHaveBeenCalled(); // still within the window measured from the later timestamp
    expect(res.terminated).toEqual([]);
  });

  it('an armed CRON+loop is UNCHANGED by this sweep — is_cron:true skips the new branch entirely', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called-for-cron' }));
    const sql = fakeSql([armedRow({ is_cron: true })], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + TERMINAL_WINDOW_MS + 1_000, // well past the window — would trip the armed-pure-loop leg
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    // Falls through to the pre-existing cron+loop handling: no completion signal and not parked
    // → looksDeadOrStuck is false (parked required) → skipped exactly as before this change.
    expect(guard).not.toHaveBeenCalled();
    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0);
  });

  it('a guard failure on the armed-loop sweep is fail-soft — the loop is left armed, never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => {
      throw new Error('probe read failed');
    });
    const sql = fakeSql([armedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + TERMINAL_WINDOW_MS + 1_000,
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0);
  });
});

/**
 * EI-18668025239634541 — recurrence guard for the loop-lifecycle-death escalation leak.
 *
 * ROOT CAUSE: `defaultEscalateLifecycleDeath` called `openEscalation` with NO conditionKey,
 * so dedup fell back to the prose SUMMARY — which embedded `~${mins}m`, a value that backs
 * off between occurrences (`rearmDelayMs`) and therefore never repeats even for the SAME
 * loop. Every reconcile pass over a loop stuck on a provider wall leaked a fresh
 * permanently-open escalation row instead of bumping repeatCount on one (measured: 10
 * leaked rows / 10 occurrences / 2.5h, 1.0x coalescing — vs 4.8x coalescing everywhere a
 * conditionKey IS supplied).
 *
 * A summary-equality assertion would NOT have caught this (the whole point of the bug is
 * that the summary DIFFERS across occurrences) — this asserts on the actual dedup key
 * (`meta.subjectSignature`) the fix introduces, exactly as the item requested.
 */
describe('defaultEscalateLifecycleDeath — stable conditionKey (EI-18668025239634541)', () => {
  const baseInfo = {
    routineId: 'rt-42',
    targetOwnerId: 'su-test',
    installSlug: 'papercusp',
    name: 'loop-su-test',
  };

  it('passes an IDENTICAL non-empty conditionKey across two calls with DIFFERENT rearmDelayMs', async () => {
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();

    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      verdict: { reason: 'usage_limit', evidence: 'e1', rearmDelayMs: 5 * 60_000 },
    });
    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      verdict: { reason: 'usage_limit', evidence: 'e2', rearmDelayMs: 47 * 60_000 },
    });

    expect(mockOpenEscalation).toHaveBeenCalledTimes(2);
    const call1 = mockOpenEscalation.mock.calls[0]?.[1] as { meta?: { subjectSignature?: string } };
    const call2 = mockOpenEscalation.mock.calls[1]?.[1] as { meta?: { subjectSignature?: string } };
    const key1 = call1?.meta?.subjectSignature;
    const key2 = call2?.meta?.subjectSignature;

    expect(key1).toBeTruthy();
    expect(key2).toBeTruthy();
    expect(key1).toBe(key2); // THE regression this guards: must NOT vary with rearmDelayMs/mins.
  });

  it('keys the conditionKey on the loop identity (installSlug + routineId), distinguishing different loops', async () => {
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();

    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      routineId: 'rt-A',
      verdict: { reason: 'usage_limit', evidence: 'e', rearmDelayMs: 60_000 },
    });
    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      routineId: 'rt-B',
      verdict: { reason: 'usage_limit', evidence: 'e', rearmDelayMs: 60_000 },
    });

    const keyA = (mockOpenEscalation.mock.calls[0]?.[1] as { meta?: { subjectSignature?: string } })?.meta
      ?.subjectSignature;
    const keyB = (mockOpenEscalation.mock.calls[1]?.[1] as { meta?: { subjectSignature?: string } })?.meta
      ?.subjectSignature;
    expect(keyA).toBeTruthy();
    expect(keyB).toBeTruthy();
    expect(keyA).not.toBe(keyB);
  });

  it('the summary itself no longer embeds the volatile duration (defense in depth for the dedup fallback)', async () => {
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();

    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      verdict: { reason: 'usage_limit', evidence: 'e', rearmDelayMs: 33 * 60_000 },
    });

    const input = mockOpenEscalation.mock.calls[0]?.[1] as { summary: string; body: string };
    expect(input.summary).not.toMatch(/~?\d+m/); // no minutes count in the dedup-relevant summary
    expect(input.body).toMatch(/~33m/); // the detail still lives in body, just not in summary
  });
});

describe('reconcileLoopRoutines — presence-quiescence defers behind the session_turns ingest watermark (WI-6852)', () => {
  const T0 = 1_782_000_000_000;
  const QUIET = 70_000; // > FALLBACK_QUIET_MS (60s)

  /** A warm loop that settles ONLY via presence-quiescence: no lifecycle marker, no turn journal. */
  const quiescentRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    target_owner_id: 'su-test',
    interval_sec: 900,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-test',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: new Date(T0),
    lifecycle_completed_at: null,
    turn_journal_completed_at: null,
    presence_last_active_at: new Date(T0 + 4_000),
    last_assistant_text_after_fire: null,
    ...over,
  });

  it('DEFERS the settle while the ingest watermark is BEHIND the quiet instant (the live 02:58 fire-into-a-wall repro)', async () => {
    const updates: unknown[][] = [];
    // The owner IS ingested (watermark present) but the ingest has not yet reached the final
    // beat, so a null assistant text is a LAG artifact — not evidence the turn ended cleanly.
    const sql = fakeSql([quiescentRow({ turns_ingest_watermark: new Date(T0 - 30_000) })], updates);
    const res = await reconcile({ sql, nowMs: T0 + QUIET, readFireState: NO_PRIOR_ERRORS });
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // stayed parked — no bare-interval re-arm into the wall
  });

  it('SETTLES normally once the watermark has REACHED the quiet instant (the absence is then real)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql([quiescentRow({ turns_ingest_watermark: new Date(T0 + 4_000) })], updates);
    const res = await reconcile({ sql, nowMs: T0 + QUIET, readFireState: NO_PRIOR_ERRORS });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });

  it('does NOT defer when the owner has NO indexed turns at all — deferring needs positive evidence of lag, so this population keeps today behavior', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql([quiescentRow({ turns_ingest_watermark: null })], updates);
    const res = await reconcile({ sql, nowMs: T0 + QUIET, readFireState: NO_PRIOR_ERRORS });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });

  it('does NOT defer when the assistant text IS present — a lagging watermark is irrelevant once the evidence itself has landed', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        quiescentRow({
          last_assistant_text_after_fire: 'ordinary turn text',
          turns_ingest_watermark: new Date(T0 - 30_000),
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + QUIET, readFireState: NO_PRIOR_ERRORS });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });

  it('a deferred loop is NOT wedged — the layer-3 stuck-park backstop still re-arms it at its dwell floor', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    // Same lagging-watermark row (so completionSignal keeps DEFERRING), now just past the
    // stuck-park dwell — stuckBackstopCadenceMs = max(default, interval*4) = 60min at 900s — so
    // the layer-3 backstop takes over. This is the safety property the defer rests on: the worst
    // case of deferring is a LATE settle, never a permanently parked loop.
    // The terminal guard is injected non-breaching so this asserts the RE-ARM, not the
    // dead-owner termination decision (which is a separate path with its own tests above).
    const sql = fakeSql([quiescentRow({ turns_ingest_watermark: new Date(T0 - 30_000) })], updates);
    const res = await reconcile({
      sql,
      nowMs: T0 + 61 * 60_000,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: async () => ({ breach: false }),
    });
    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('stuck-backstop');
  });
});

describe('reconcileLoopRoutines — a usage-limit re-arm may push next_fire_at LATER (WI-6852)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** Like `fakeSql`, but records the STATEMENT TEXT. That is the only way to tell the two re-arm
   *  branches apart: they differ in SQL SHAPE (GREATEST + a `next_fire_at <` guard vs LEAST + a
   *  `next_fire_at >` one), not in their bind values, so the shared `updates` capture cannot see it. */
  function fakeSqlCapturingText(rows: Record<string, unknown>[], statements: string[]): Sql {
    return ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
      const q = strings.join(' ? ');
      if (/^\s*UPDATE/i.test(q)) {
        statements.push(q);
        return Promise.resolve([{ id: 'rt-1' }]);
      }
      return Promise.resolve(rows);
    }) as unknown as Sql;
  }

  const walledRow = (text: string, intervalSec: number) => ({
    id: 'rt-1',
    target_owner_id: 'su-walled',
    interval_sec: intervalSec,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-walled',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: pgString(T0 + 5_000),
    presence_last_active_at: null,
    last_assistant_text_after_fire: text,
  });

  const run = async (text: string, intervalSec: number) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const statements: string[] = [];
    const sql = fakeSqlCapturingText([walledRow(text, intervalSec)], statements);
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire: vi.fn(async () => {}),
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath: vi.fn(async () => {}),
    });
    const armStmt = statements.find((s) => /UPDATE\s+harness_shared\.routines/i.test(s));
    return { res, armStmt };
  };

  it('uses the never-EARLIER (GREATEST) statement for a reset-aware usage_limit death', async () => {
    const { res, armStmt } = await run("You've hit your session limit · resets in 3 hours", 180);
    expect(res.rearmed).toBe(1);
    expect(armStmt).toBeDefined();
    // The whole defect: the ordinary statement is never-later BY CONSTRUCTION, so a blind re-arm
    // that had already set next_fire_at = now+interval made this wall-aware re-arm a silent no-op.
    expect(armStmt).toContain('GREATEST');
    expect(armStmt).toContain('next_fire_at < ');
    expect(armStmt).not.toContain('LEAST');
    // ...and the deferral must be the real multi-hour wall, not the bare interval.
    expect(res.loops[0].nextFireAt).toBe(T0 + 5_000 + 3 * 3_600_000);
  });

  it('keeps the ordinary never-LATER (LEAST) statement for a NON-usage_limit death', async () => {
    // The control that gives the assertion above its meaning: an auth_wall is still a lifecycle
    // DEATH (same code path, same escalation) — only usage_limit carries a reset instant worth
    // deferring to, so only usage_limit may push a loop's cadence out.
    const { res, armStmt } = await run(
      'Your organization has disabled Claude subscription access for Claude Code.',
      180,
    );
    expect(res.rearmed).toBe(1);
    expect(armStmt).toContain('LEAST');
    expect(armStmt).not.toContain('GREATEST');
  });

  it('keeps the ordinary statement when the parsed reset adds nothing beyond the interval', async () => {
    // interval 6h vs a 3h wall ⇒ rearmMs === intervalMs, so no reset-aware information survives
    // the interval floor and there is nothing to defer past.
    const { res, armStmt } = await run("You've hit your session limit · resets in 3 hours", 6 * 3600);
    expect(res.rearmed).toBe(1);
    expect(armStmt).toContain('LEAST');
    expect(armStmt).not.toContain('GREATEST');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WI-36792 — the gate-backoff re-arm leg.
//
// The defect these pin: a PURE LOOP is parked at next_fire_at='infinity' by
// claimDueRoutine at CLAIM time, before the fire runs. If the fire-gate then
// WITHHOLDS, no wake is sent, so no turn happens, so no completion-rebase ever
// re-arms it — and reconcile used to `continue` here on the premise that "the
// fire-gate owns its cadence". The gate cannot cause a claim, so for a parked
// loop nobody owns it: the loop is dead until a human re-arms it. Measured on a
// live session 2026-08-08: a 2h44m silent halt.
//
// FALSIFIABILITY (mutation-probe tier 1 — the subject is an imported module, so
// the controls live here permanently instead of mutating the shared tree): the
// two CONTROL cases below drive the same fixture through an ALLOWING gate and
// through a NON-parked row. If the production branch ever stops reading the gate
// verdict or the parked flag and re-arms unconditionally, those two red — while
// the positive cases stay green. A positive-only suite would pass against a
// branch that fired on every quiet-parked loop, which is the regression most
// worth catching here.
describe('reconcileLoopRoutines — gate-backoff re-arm for a parked loop (WI-36792)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** The quiet-parked fixture: fired, no completion marker, no post-fire activity —
   *  i.e. exactly the shape a withheld fire leaves behind. */
  const parkedRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-gate',
    target_owner_id: 'su-gated',
    interval_sec: 60,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-gated',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: null,
    presence_last_active_at: null,
    ...over,
  });

  /** The incident's real fire-state: 4 consecutive errors — BELOW circuitThreshold (8), so the
   *  circuit is not open; this is plain backoff.
   *  NOTE the two clocks are DIFFERENT columns in production — routines.last_fired_at (the park)
   *  vs autoloop_state.last_fired_at (the backoff clock, which a withhold deliberately does NOT
   *  advance). They sat 9s apart in the real incident. The fix consults the gate's own verdict
   *  rather than recomputing from the park time, which is why that skew is harmless; the fixture
   *  collapses them only for legibility. */
  const WITHHELD_STATE = vi.fn(async () => ({ lastFiredAt: new Date(T0), consecutiveErrors: 4 }));

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('re-arms a parked loop the REAL fire-gate is withholding, to the exact moment the backoff expires', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    // 26s after the park. Deliberately drives the REAL evaluateFireGate rather than a stub: this
    // is the calibration case that proves the wiring, so the number asserted below is the
    // production formula's own output, not a fixture asserting what it wishes were true.
    const res = await reconcile({
      sql: fakeSql([parkedRow()], updates),
      nowMs: T0 + 26_000,
      recordFire,
      readFireState: WITHHELD_STATE,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('gate-backoff');
    // backoff = base 60s * 2^(4-1) = 480s from the gate's clock; elapsed 26s ⇒ 454s remaining —
    // the exact `retry in ~454s` the live autoloop_state row recorded on 2026-08-08.
    expect(res.loops[0].nextFireAt).toBe(T0 + 480_000);
  });

  it("records NO fire outcome — an 'ok' would ERASE the streak the backoff is computed from", async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    await reconcile({
      sql: fakeSql([parkedRow()], updates),
      nowMs: T0 + 26_000,
      recordFire,
      readFireState: WITHHELD_STATE,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    // The asymmetry is load-bearing, not an oversight: this re-arm observed nothing about the
    // turn. 'ok' would reset consecutive_errors (the loop re-fires at once and reads as healthy);
    // 'error' would double-count a failure the fire path already recorded.
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('CONTROL — an ALLOWING gate re-arms nothing on this leg (proves the branch reads the verdict)', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([parkedRow()], updates),
      nowMs: T0 + 26_000,
      recordFire,
      // A clean streak ⇒ the real gate ALLOWS ⇒ nothing is being withheld ⇒ nothing to rescue.
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('CONTROL — a NON-parked row (cron+loop with a live schedule) is never pulled sooner by this leg', async () => {
    const updates: unknown[][] = [];
    const res = await reconcile({
      sql: fakeSql([parkedRow({ parked: false })], updates),
      nowMs: T0 + 26_000,
      recordFire: async () => {},
      readFireState: WITHHELD_STATE,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    // A routine with a real future next_fire_at keeps being CLAIMED on schedule, so the gate
    // genuinely IS re-consulted for it — the premise that is false only for a parked loop.
    expect(res.loops.find((l) => l.via === 'gate-backoff')).toBeUndefined();
  });

  it('INCIDENT ANCHOR (2026-08-08) — the rescue lands BEFORE the stalled-loops-guard disarm that followed', async () => {
    const updates: unknown[][] = [];
    // Real timeline: park 21:54:31Z; gate withheld 21:54:40Z (consecutive_errors=4,
    // "retry in ~454s"); stalled-loops-guard disarmed the loop 22:07:36Z; owner re-armed by
    // hand at 23:05Z. Today's code re-armed at none of those points.
    const park = Date.parse('2026-08-08T21:54:31.403Z');
    const disarm = Date.parse('2026-08-08T22:07:36.000Z');
    const res = await reconcile({
      sql: fakeSql([parkedRow({ last_fired_at: pgString(park) })], updates),
      nowMs: park + 26_000,
      recordFire: async () => {},
      readFireState: vi.fn(async () => ({ lastFiredAt: new Date(park), consecutiveErrors: 4 })),
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.loops[0].via).toBe('gate-backoff');
    // ~22:02:31Z — five minutes of margin. The loop wakes, produces a turn, and the ordinary
    // completion-rebase takes over, so the disarm never has a stalled loop to act on.
    expect(res.loops[0].nextFireAt).toBeLessThan(disarm);
  });
});
