/**
 * Loop completion-rebase — re-arm an interval-loop routine N seconds AFTER the
 * woken turn it fired COMPLETES (loop-routines-interval-recurrence-2026-06-20 P-002 /
 * brief B-LOOP-2).
 *
 * A "loop" (B-LOOP-1, migration 323, owned by su-d5a84) is the third routine recurrence
 * kind: a routine carrying `reschedule_interval_sec` (+ `target_owner_id`, the warm coord
 * session it wakes) and NEITHER cron nor rrule. On each fire `claimDueRoutine` keeps a
 * PURE loop active and PARKS it at `next_fire_at = 'infinity'` (the in-flight sentinel —
 * the claim guard `next_fire_at <= now()` never matches infinity, so it is never
 * re-claimed while its turn runs). NOTHING re-arms it; this reconcile does: once the
 * woken turn SETTLES it sets `next_fire_at = completed_at + interval`, so the loop's true
 * period is (turn duration + interval) — the after-completion cadence that replaces
 * Claude /loop. A cron+loop (BOTH a cron and an interval) is recurrence, so claim
 * advances it to cron-next (never infinity); here we FOLD the loop re-arm in by taking
 * the sooner (d5a84's LEAST idiom — see the UPDATE below).
 *
 * ## The completion signal (the resolved spike — B-LOOP-2's open question)
 * A loop fire is a WARM `coord` wake (D-005) — it mints NO plan_run, so the signal is
 * NOT `plan_runs.finished_at`. It is re-sourced from the SESSION turn lifecycle:
 * Claude Code's `Stop` hook (and `SessionEnd`) is wired to `lifecycle-report.sh`, which
 * fires `activity:report {kind:'lifecycle', summary:'■ session ended'}` at the END of
 * EVERY turn into `harness_shared.agent_activity`, keyed by `owner_id = PAPERCUSP_SID =`
 * the loop's `target_owner_id`. So the most-recent such marker AFTER `last_fired_at` is
 * the woken turn's completion. This is per-turn AND immune to the mid-turn quiet-gap a
 * `coord_presence.last_active_at` quiescence read suffers from (a long SILENT Bash leaves
 * last_active_at stale mid-turn → a false "settled"). (report.ts `lifecyclePhase` keys
 * the same marker off the word "end"; matching `summary ILIKE '%end%'` over
 * kind='lifecycle' rows — whose only summaries are "▶ session started" / "■ session
 * ended" — picks the end marker exactly, since "started" has no "end".)
 *
 * ## Robustness (3 layers, each cheap)
 *  1. PRIMARY — the lifecycle 'ended' marker (above).
 *  2. FALLBACK — the lifecycle report is a DETACHED, fail-open POST (it CAN be lost). If
 *     no 'ended' marker exists after the fire but `coord_presence.last_active_at`
 *     advanced past last_fired_at AND has since gone quiet (≥ FALLBACK_QUIET_MS), the
 *     session did work then idled → rebase off last_active_at (recovers a dropped report).
 *  3. STUCK-PARK BACKSTOP — a loop parked far past the fire with NO post-fire signal at
 *     all (the wake was never delivered / the session died silently) is re-armed off
 *     `last_fired_at + interval` so the next fire RETRIES (and then flows through the
 *     fire-gate / cost-cap on the fire side, which can auto-pause a dead loop) — never
 *     wedge at infinity forever.
 *
 * ## Invariants
 *  - IDEMPOTENT + NEVER-BACKWARDS (pure loop) — `created_at > last_fired_at` excludes an
 *    older late-settling turn (rebase only off the MOST-RECENT settled turn), and the
 *    UPDATE re-arms only a row still at 'infinity' (or strictly lowers a cron+loop), so a
 *    second pass within one fire cycle is a no-op and next_fire_at never regresses.
 *  - cron+loop COMPOSITION — `LEAST(next_fire_at, completed+interval)` is the SOONER of
 *    the standing cron-next and the loop re-arm (d5a84's tip). The WHERE clause guards it
 *    to only re-arm a parked pure loop OR strictly-lower a cron+loop, so it never raises a
 *    cron fire and is idempotent.
 *
 * Caveat (by design): settle is observed on the 30s tick, so the true period is
 * interval + up-to-30s — fine for the 60s /loop floor, not sub-minute.
 *
 * Wired into `reconcileAndGovern` (reconcile-plan-runs.ts) so it rides the same 30s
 * routine tick as the scheduled-run reconcile + the watchdog sweeps.
 *
 * NB on parked-Date parsing: postgres-js parses `'infinity'::timestamptz` to an INVALID
 * JS Date (d5a84's frozen-seam note). This module never relies on the JS-parsed
 * `next_fire_at` for a parked row — "parked" is computed as a SQL boolean and every
 * infinity comparison is done in SQL — so the invalid-Date trap cannot bite here.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { recordFire as defaultRecordFire, readFireState as defaultReadFireState } from '../../autoloop';
import { runWithWorkspace } from '../../workspace-als';
import { checkUnreachableTerminalGuard as defaultCheckUnreachableTerminalGuard } from './loop-unreachable-guard';

/**
 * Coerce a `timestamptz` column to epoch ms, tolerating BOTH shapes it can arrive in:
 * a `Date` (a type-parsing connection — what the testcontainer integration tests use) OR a
 * STRING. The operator's pooled `getOrgPg()` connection runs `prepare: false`, which skips
 * postgres-js's per-column type-OID resolution, so a `timestamptz` comes back as the raw PG
 * string (`"2026-06-21 16:30:03.587133-04"`) — NOT a Date. Calling `.getTime()` on that threw
 * `getTime is not a function` on the FIRST row of every pass, which propagated out and
 * SILENTLY ABORTED the whole reconcile (caught by reconcileAndGovern's best-effort try) — so
 * every loop fleet-wide parked at infinity and was never re-armed after one fire (EI-2549).
 * The integration tests used a direct, type-parsing connection, so they never hit this — a
 * real test gap, now closed by `…string-typed timestamptz columns…`. `new Date(pgString)`
 * round-trips the PG format correctly. Returns null for null/undefined or an unparseable value.
 */
function tsMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const ms = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** A dropped lifecycle report is inferred only once the session's last GENUINE activity
 *  (coord_presence.last_active_at — NOT the keepalive heartbeat_at) has been quiet for at
 *  least this long, so we never mistake a mid-turn pause for a settle. */
const FALLBACK_QUIET_MS = 60_000;

/** Floor for the stuck-park backstop: a loop parked at least this long past its fire with
 *  NO post-fire activity is treated as a never-delivered/dead fire and re-armed to retry.
 *  Generous so a legitimately long turn (which keeps producing activity) is never
 *  force-rearmed. Per-loop the effective bound is max(this, 4×interval). */
const DEFAULT_STUCK_PARK_MS = 30 * 60_000;

function stuckParkMs(intervalMs: number): number {
  const env = Number(process.env.PAPERCUSP_LOOP_STUCK_PARK_MS);
  const base = Number.isFinite(env) && env > 0 ? env : DEFAULT_STUCK_PARK_MS;
  return Math.max(base, intervalMs * 4);
}

export type RebaseVia = 'lifecycle' | 'presence-quiescence' | 'stuck-backstop';

export interface LoopRebaseResult {
  /** Loops re-armed this pass. */
  rearmed: number;
  /** Per re-armed loop (diagnostics / tests). */
  loops: Array<{
    id: string;
    targetOwnerId: string;
    /** The completion time the re-arm was computed from (epoch ms). */
    completedAt: number;
    /** The new next_fire_at floor we pushed (epoch ms) — for a cron+loop the persisted
     *  value is LEAST(cron-next, this), so it may be sooner. */
    nextFireAt: number;
    via: RebaseVia;
  }>;
  /** Loops auto-paused this pass because their owner is permanently unreachable (WI-1399) —
   *  NOT re-armed; `active=false` was set instead. Diagnostics / tests. */
  terminated: Array<{
    id: string;
    targetOwnerId: string;
    reason: string;
  }>;
}

interface LoopRow {
  id: string;
  target_owner_id: string;
  interval_sec: number;
  parked: boolean;
  // Fire-gate key (loop-wake-rate-limit-robustness P0b): the completion-rebase feeds the
  // EXISTING autoloop circuit — recordFire(install_slug, name, …, 'ok' on completion /
  // 'error' on the stuck-park backstop) — keyed exactly as fireLoopWake/checkFireGate.
  install_slug: string;
  name: string;
  routine_workspace_id: string;
  // timestamptz columns: a `Date` on a type-parsing connection, a STRING on the operator's
  // pooled `prepare:false` connection — always read through `tsMs()`, never `.getTime()` (EI-2549).
  last_fired_at: Date | string | null;
  /** max(agent_activity.created_at) for a kind='lifecycle' 'ended' marker after the fire. */
  lifecycle_completed_at: Date | string | null;
  /** The session's most-recent genuine-activity timestamp (presence-v2, mig 277). */
  presence_last_active_at: Date | string | null;
}

/**
 * Resolve the woken turn's completion time for one loop (primary lifecycle marker, else
 * the dropped-report presence fallback). Returns null when the turn is still in flight /
 * no signal has landed yet. `lastFiredMs` bounds the window to THIS fire.
 */
function completionSignal(
  row: LoopRow,
  lastFiredMs: number,
  nowMs: number,
): { completedAt: number; via: Exclude<RebaseVia, 'stuck-backstop'> } | null {
  // 1. PRIMARY: the Stop-hook lifecycle 'ended' marker (already filtered > last_fired by
  //    the SQL window, so any value here is a genuine post-fire turn completion).
  const lc = tsMs(row.lifecycle_completed_at);
  if (lc != null) {
    return { completedAt: lc, via: 'lifecycle' };
  }
  // 2. FALLBACK: a dropped lifecycle report — the session did genuine work after the fire
  //    then went quiet. last_active_at is the genuine-activity ts (NOT keepalive).
  const la = tsMs(row.presence_last_active_at);
  if (la != null && la > lastFiredMs && nowMs - la >= FALLBACK_QUIET_MS) {
    return { completedAt: la, via: 'presence-quiescence' };
  }
  return null;
}

/**
 * Re-arm every interval-loop routine whose woken turn has settled. Pure loops (parked at
 * 'infinity') rebase to completed_at + interval; cron+loops fold the loop re-arm into
 * their cron-next by taking the sooner (LEAST). `nowMs` is injectable for deterministic
 * tests.
 */
export async function reconcileLoopRoutines(
  opts: {
    sql?: Sql;
    nowMs?: number;
    recordFire?: typeof defaultRecordFire;
    /** Injected for tests; defaults to the real autoloop_state read. */
    readFireState?: typeof defaultReadFireState;
    /** Injected for tests; defaults to the real unreachable-owner terminal guard (WI-1399). */
    checkUnreachableTerminalGuard?: typeof defaultCheckUnreachableTerminalGuard;
  } = {},
): Promise<LoopRebaseResult> {
  const db = opts.sql ?? getOrgPg().sql;
  const nowMs = opts.nowMs ?? Date.now();
  const recordFire = opts.recordFire ?? defaultRecordFire;
  const readFireState = opts.readFireState ?? defaultReadFireState;
  const checkUnreachableTerminalGuard = opts.checkUnreachableTerminalGuard ?? defaultCheckUnreachableTerminalGuard;

  // Loop routines that may need a re-arm: a PARKED pure loop (rebase off completion) or an
  // armed cron+loop (fold the sooner). A pure loop still ARMED for its FIRST fire (a real
  // future next_fire_at, no cron) matches neither and is correctly skipped — nothing to
  // rebase until it has actually fired. The partial index routines_loop_interval_idx keeps
  // this scan cheap regardless of how many cron/rrule routines exist.
  const rows = await db<LoopRow[]>`
    SELECT r.id,
           r.target_owner_id,
           r.reschedule_interval_sec AS interval_sec,
           (r.next_fire_at = 'infinity'::timestamptz) AS parked,
           r.install_slug,
           r.name,
           r.workspace_id AS routine_workspace_id,
           r.last_fired_at,
           (SELECT max(a.created_at)
              FROM harness_shared.agent_activity a
             WHERE a.owner_id = r.target_owner_id
               AND a.kind = 'lifecycle'
               AND a.summary ILIKE '%end%'
               AND a.created_at > r.last_fired_at) AS lifecycle_completed_at,
           (SELECT max(p.last_active_at)
              FROM harness_shared.coord_presence p
             WHERE p.owner_id = r.target_owner_id) AS presence_last_active_at
      FROM harness_shared.routines r
     WHERE r.active = TRUE
       AND r.reschedule_interval_sec IS NOT NULL
       AND r.target_owner_id IS NOT NULL
       AND (r.next_fire_at = 'infinity'::timestamptz OR jsonb_exists(r.trigger_config, 'cron'))
  `;

  const result: LoopRebaseResult = { rearmed: 0, loops: [], terminated: [] };

  for (const row of rows) {
    // PER-ROW ISOLATION (engine-loop re-arm hardening, EI-2549): one malformed row must NEVER
    // throw out of this loop and strand EVERY other loop's re-arm (a single bad row silently
    // wedging the whole fleet's loops is exactly the failure class this guards). Log + continue.
    try {
      // A fired loop always has last_fired_at (claim sets it on park/advance); defensively
      // skip a malformed/missing row rather than rebasing off an unbounded window. tsMs()
      // tolerates the string form the pooled connection returns (EI-2549).
      const lastFiredMs = tsMs(row.last_fired_at);
      if (lastFiredMs == null) continue;
      const intervalMs = row.interval_sec * 1000;

      // Resolve the re-arm time + provenance.
      let completedAt: number;
      let via: RebaseVia;
      const signal = completionSignal(row, lastFiredMs, nowMs);
      if (signal) {
        completedAt = signal.completedAt;
        via = signal.via;
      } else if (
        // Stuck-park backstop — a PARKED loop only: no completion signal, no post-fire
        // activity (a legitimately long turn keeps producing activity, so its
        // last_active_at would be > last_fired), and parked far past the fire.
        row.parked &&
        (tsMs(row.presence_last_active_at) ?? 0) <= lastFiredMs &&
        nowMs - lastFiredMs >= stuckParkMs(intervalMs)
      ) {
        completedAt = lastFiredMs;
        via = 'stuck-backstop';
      } else {
        continue; // still in flight / nothing to fold — leave it
      }

      // WI-1399 — dead-owner terminal guard. Only reachable via the stuck-backstop branch
      // (a genuine completion signal means the owner is obviously alive). Before re-arming
      // to retry yet again, check whether the owner has become PERMANENTLY unreachable (no
      // injectable/resumable wake channel) across a generous terminal window and a run of
      // consecutive stuck-backstop fires — if so, auto-pause instead of re-arming into the
      // void forever. Fail-soft: any probe/read failure here falls back to the normal
      // stuck-backstop re-arm below (never blocks a retry on an uncertain read).
      if (via === 'stuck-backstop') {
        const priorState = await runWithWorkspace(row.routine_workspace_id, () =>
          readFireState(row.install_slug, row.name),
        ).catch(() => null);
        const stuckFireCount = (priorState?.consecutiveErrors ?? 0) + 1;
        const guard = await checkUnreachableTerminalGuard({
          sql: db,
          routineId: row.id,
          targetOwnerId: row.target_owner_id,
          parkedForMs: nowMs - lastFiredMs,
          intervalMs,
          stuckFireCount,
        }).catch((e) => {
          console.warn(
            `[loop-reconcile] unreachable-terminal-guard check failed for '${row.id}' — falling back to stuck-backstop retry: ${e instanceof Error ? e.message : e}`,
          );
          return { breach: false } as { breach: boolean; reason?: string };
        });
        if (guard.breach) {
          result.terminated.push({
            id: row.id,
            targetOwnerId: row.target_owner_id,
            reason: guard.reason ?? 'unreachable dead-owner loop',
          });
          await runWithWorkspace(row.routine_workspace_id, () =>
            recordFire(row.install_slug, row.name, 'loop-terminal-unreachable', 'error'),
          ).catch((e) =>
            console.warn(
              `[loop-reconcile] recordFire('error') failed for terminated loop '${row.id}': ${e instanceof Error ? e.message : e}`,
            ),
          );
          console.warn(
            `[loop-reconcile] loop '${row.id}' (owner ${row.target_owner_id}) TERMINATED (auto-paused, not re-armed): ${guard.reason}`,
          );
          continue; // auto-paused (active=false) inside the guard — do NOT re-arm below
        }
      }

      // Pass an ISO STRING + explicit ::timestamptz cast, NOT a Date object: the operator's
      // pooled `prepare: false` connection rejects a Date bind param ("the string argument must
      // be … Received an instance of Date") — the write-side mirror of the string-read quirk
      // (EI-2549). A string + cast binds cleanly on BOTH that connection and a direct one.
      const reArmIso = new Date(completedAt + intervalMs).toISOString();

      // ONE statement for BOTH kinds (d5a84's LEAST tip):
      //   pure loop parked  → next_fire_at='infinity' matches → LEAST(infinity, X) = X (re-arm)
      //   cron+loop (armed) → guarded by next_fire_at > X → LEAST(cron-next, X) = X (fold sooner)
      // Idempotent + never-backwards: a re-armed loop sits at X (a finite past/future time);
      // the first disjunct (=infinity) no longer matches and the second (next_fire_at > X) is
      // false, so a re-pass is a no-op. A cron fire that is already sooner than X is left
      // untouched (the WHERE never matches), so a cron's cadence is never delayed.
      const updated = await db<{ id: string }[]>`
        UPDATE harness_shared.routines
           SET next_fire_at = LEAST(next_fire_at, ${reArmIso}::timestamptz), updated_at = now()
         WHERE id = ${row.id}
           AND reschedule_interval_sec IS NOT NULL
           AND ( next_fire_at = 'infinity'::timestamptz
                 OR next_fire_at > ${reArmIso}::timestamptz )
        RETURNING id
      `;
      if (updated.length > 0) {
        result.rearmed++;
        result.loops.push({
          id: row.id,
          targetOwnerId: row.target_owner_id,
          completedAt,
          nextFireAt: completedAt + intervalMs,
          via,
        });
        // Feed the autoloop circuit (loop-wake-rate-limit-robustness P0b). A completed turn
        // (lifecycle / presence-quiescence) is SUCCESS → recordFire('ok') resets the streak;
        // a stuck-park re-arm is a dead / never-delivered turn → recordFire('error') feeds
        // the existing backoff + circuit. CHANNEL-AGNOSTIC: this catches inject-path deaths
        // the resume-exit observer can't see, and is the durable fallback when that observer
        // is missed (operator restart between spawn and exit). Run under the loop's own
        // workspace so the (ws, install_slug, name) key matches the fire side exactly.
        const outcome: 'ok' | 'error' = via === 'stuck-backstop' ? 'error' : 'ok';
        await runWithWorkspace(row.routine_workspace_id, () =>
          recordFire(row.install_slug, row.name, `loop-${via}`, outcome),
        ).catch((e) =>
          console.warn(
            `[loop-reconcile] recordFire('${outcome}') failed for '${row.id}': ${e instanceof Error ? e.message : e}`,
          ),
        );
        if (via === 'stuck-backstop') {
          console.warn(
            `[loop-reconcile] loop '${row.id}' (owner ${row.target_owner_id}) parked ` +
              `${Math.round((nowMs - lastFiredMs) / 1000)}s with no completion signal — re-armed to retry (circuit fed 'error')`,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[loop-reconcile] row '${row.id}' (owner ${row.target_owner_id}) failed to rebase — SKIPPED ` +
          `(other loops unaffected): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
    }
  }

  return result;
}
