/**
 * git-sync-stall-watchdog — the sibling of green-stall-watchdog, for the OTHER silent
 * pipeline failure: git-sync FIRING but not COMMITTING.
 *
 * THE GAP (2026-06-30 incident): the papercusp git-sync routine kept firing every 3 min, but
 * its DBOS fires got STUCK ("routineFire produced no DBOS operation output; executor reaper
 * cancelled the stuck fire and requeued") — so no commit ever landed. Auto-commit of the main
 * staging tree died at 15:00 and NOTHING alarmed for ~6h while ~100 source files stranded
 * uncommitted (and thus un-deployable — a deploy ships only committed HEAD). The green-stall-
 * watchdog is blind to this: it only watches `system:green-checkpoint`. git-sync RECORDS its
 * health on the routine metadata (`head_sha` / `last_status` / `last_error`, set by
 * recordOutcome) — but nothing READ it. This does.
 *
 * Process-level (NOT a DBOS routine) for the same reason as green-stall-watchdog: a routine-based
 * watchdog queues on the very engine that wedges, so it can't fire when most needed.
 *
 * DETECTION — three signals, most-robust first:
 *   1. commit-staleness (PRIMARY) — the tree HEAD (`metadata.head_sha`) has not advanced in
 *      HEAD_STALE_MS while the routine is active. This is the robust signal: `last_error` is
 *      NOISY (git-sync NULLS it on any healthy/`nothing` tick, so it flips null between reaps —
 *      it was null when we first checked the live stall), but a FROZEN head directly means "no
 *      commit is landing." The watchdog tracks head movement itself (`wd_head_sha` /
 *      `wd_head_since_ms`), resetting the clock whenever head advances.
 *   2. fire-staleness — an ACTIVE routine whose `last_fired_at` is older than FIRE_STALE_MS
 *      (cron every 3 min, so 3h ⇒ the scheduler isn't running it).
 *   3. error persistence — `last_error` is non-null across ≥2 CONSECUTIVE watchdog sweeps
 *      (`wd_error_sweeps`, watchdog-tracked like the head clock). git-sync NULLS last_error on
 *      any healthy tick, so two 15-min sweeps both catching a fault ⇒ ~10 consecutive failed
 *      3-min runs — a real fault streak, not a blip. A SINGLE observed error never alarms:
 *      on 2026-07-02 a lone 240s submodule push timeout (self-recovered in 6 min) urgently
 *      paged the owner + broadcast "code is stranding" to the whole fleet — pure alarm noise.
 *
 * On alarm: an urgent owner `notifyAttention` + a durable `harness_escalations` row (its OWN
 * phase) + a fleet BROADCAST (severe-event-broadcast — every running agent sees it next turn,
 * inject-only, so someone claims it). Recovery (head advances again / routine fires) clears the
 * flag + escalation idempotently.
 *
 * Kill-switch: PAPERCUSP_GITSYNC_STALL_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolved } from '../severe-event-broadcast';
import { readRoutineEngineLiveness } from './routine-engine-liveness';

/** Tree HEAD unchanged this long while the routine is active ⇒ commits aren't landing. git-sync
 *  runs every 3 min, so on an active box 2h of no new commit is a strong stall signal. Tunable;
 *  the tradeoff is a genuinely idle tree (no edits) could alarm — low harm (a claimable
 *  broadcast, not a page) and rare on an active dev box. */
const DEFAULT_HEAD_STALE_MS = 2 * 60 * 60 * 1000; // 2h
/** An ACTIVE git-sync that hasn't FIRED in this long ⇒ the scheduler isn't running it. */
const DEFAULT_FIRE_STALE_MS = 3 * 60 * 60 * 1000; // 3h
/** WI-1416: this many CONSECUTIVE executor-reaper cancels (`metadata.reaped_count` —
 *  incremented per reap, reset by a completed fire) ⇒ the fire loop is thrashing:
 *  fires start (`fire_started_at` advances) but never complete a commit. Sturdier
 *  than last_error (which flips null on any healthy tick) for the WI-1415 loop. */
const DEFAULT_PERSISTENT_REAP_MIN = 3;
/** A fault must be observed on this many CONSECUTIVE watchdog sweeps before error-stall alarms
 *  (`wd_error_sweeps`). At the 15-min sweep cadence over a 3-min git-sync, 2 sweeps ⇒ the fault
 *  survived ~10 runs — persistent, not a transient push/fetch blip. */
const DEFAULT_ERROR_STALL_MIN_SWEEPS = 2;
/** How often the watchdog sweeps. git-sync is every 3 min; 15m is ample + matches green-stall. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // 15 min

const WATCHDOG_PHASE = 'git-sync-watchdog';
const WATCHDOG_KIND = 'git-sync-watchdog';

export interface GitSyncStallThresholds {
  headStaleMs?: number;
  fireStaleMs?: number;
  /** WI-1416: consecutive reaps that count as a persistent reap-loop (default 3). */
  persistentReapMin?: number;
  /** consecutive watchdog sweeps a fault must persist before error-stall alarms (default 2). */
  errorStallMinSweeps?: number;
}

/** The bits of one git-sync routine the verdict is computed from. */
export interface GitSyncStallSnapshot {
  /** epoch ms of the routine's last fire (`last_fired_at`), or null if never fired. */
  lastFiredMs: number | null;
  /** ms the tree HEAD has been UNCHANGED (watchdog-tracked), or null if it just moved / first
   *  observation (⇒ never commit-stale this pass). */
  headUnchangedMs: number | null;
  /** last recorded error/reap message (`metadata.last_error`) — NULL on a healthy tick. */
  lastError: string | null;
  /** consecutive watchdog sweeps (INCLUDING this one) that observed a fault
   *  (`metadata.wd_error_sweeps`, maintained by checkGitSyncStall). Absent with a
   *  present lastError reads as 1 — a first observation, below the alarm bar. */
  errorSweeps?: number;
  /** The routine's last recorded sync status ('synced' | 'nothing' | 'skipped' | 'error' | …).
   *  'nothing' = clean tree ⇒ HEAD-staleness is healthy idle, never a stall.
   *  'skipped' = the eligibility gate no-opped the fire (no_path / hive_home / …) ⇒ a
   *  commit was never attemptable, so HEAD-staleness is likewise never a stall. */
  lastStatus?: string | null;
  /** the watchdog's own dedup flag (`metadata.watchdog_alerted`). */
  watchdogAlerted: boolean;
  /** WI-1416: consecutive executor-reaper cancels since the last COMPLETED fire
   *  (`metadata.reaped_count`; the reaper increments it, recordOutcome resets it).
   *  Optional — absent reads as 0. */
  reapedCount?: number;
  /** The root routine engine is stale; infra-liveness owns this root-cause alarm. */
  routineEngineStale?: boolean;
}

export interface GitSyncStallVerdict {
  stalled: boolean;
  /** the tree HEAD has not advanced in headStaleMs while the routine is active (PRIMARY). */
  commitStale: boolean;
  /** the routine is active but hasn't fired in fireStaleMs (the scheduler is wedged). */
  fireStale: boolean;
  /** git-sync recorded a fault on ≥ errorStallMinSweeps CONSECUTIVE sweeps (a persistent fault
   *  streak — a single observed error is transient and never alarms). */
  errorStall: boolean;
  /** WI-1416: the executor reaper has cancelled ≥ persistentReapMin consecutive fires —
   *  fires start but never complete (the WI-1415 reap→requeue→restart loop). */
  persistentReap: boolean;
  /** human reason for the alarm body, or null when not stalled. */
  reason: string | null;
}

const hrs = (ms: number): number => Math.round(ms / 3_600_000);

/**
 * Pure: decide whether one ACTIVE git-sync routine is in a silent stall. Exported for unit
 * testing (the DB wiring + head-movement tracking is in checkGitSyncStall / integration-covered).
 *
 * A never-fired routine (`lastFiredMs === null`) is a fresh seed — never alarms on fire-staleness.
 */
export function evaluateGitSyncStall(
  s: GitSyncStallSnapshot,
  now: number,
  opts: GitSyncStallThresholds = {},
): GitSyncStallVerdict {
  const headStaleMs = opts.headStaleMs ?? DEFAULT_HEAD_STALE_MS;
  const fireStaleMs = opts.fireStaleMs ?? DEFAULT_FIRE_STALE_MS;
  const persistentReapMin = opts.persistentReapMin ?? DEFAULT_PERSISTENT_REAP_MIN;
  const errorStallMinSweeps = opts.errorStallMinSweeps ?? DEFAULT_ERROR_STALL_MIN_SWEEPS;

  // FALSE-ALARM FIX (2026-07-02): an idle hive legitimately never moves HEAD — its
  // git-sync fires and records status 'nothing' (clean tree, nothing to commit).
  // Alarming "commits are NOT landing; code is stranding" on a CLEAN tree cried wolf
  // on 5 stopped hives simultaneously (hiveloop/hive-canary/shared-hive-test/
  // hello-world/spoon-knife, each 12×'nothing'/2h, working trees verified clean).
  // A head-stale verdict now requires evidence of WORK: the last sync status must
  // NOT be the clean-tree 'nothing'. Fire-stale / error / reap stalls are
  // status-independent and unchanged (a dead engine can't report anything).
  //
  // FALSE-ALARM FIX (2026-07-03, same class via 'skipped'): a fire the P-008
  // eligibility gate SKIPS (no_path / hive_home / remote_hive_view / …) never
  // even runs the pipeline, so HEAD frozen across skips is definitional, not a
  // stall. Live incident: a federation test rig teardown deleted the
  // hello-world/spoon-knife lane clones; their routines kept firing 'skipped'/
  // no_path and the frozen HEAD urgently paged "code is stranding" for checkouts
  // that no longer EXISTED. Commit-staleness therefore requires a status where a
  // commit was ATTEMPTABLE — not clean-idle 'nothing', not gated 'skipped' (the
  // skip stays loud in metadata.last_skip_reason / schedule:inventory).
  // EI-2994: if routinesTick itself is stale, git-sync fire/commit staleness is
  // a downstream symptom of the background engine freeze. The request-path
  // infra-liveness alarm owns the single root-cause escalation and auto-resolve;
  // this watchdog should not add a second "git-sync failing" page/broadcast for
  // the same incident. Unknown liveness is fail-open.
  const rootEngineStale = s.routineEngineStale === true;
  const commitNotAttemptable = s.lastStatus === 'nothing' || s.lastStatus === 'skipped';
  const commitStale = !rootEngineStale && !commitNotAttemptable && s.headUnchangedMs != null && s.headUnchangedMs > headStaleMs;
  const fireStale = !rootEngineStale && s.lastFiredMs != null && now - s.lastFiredMs > fireStaleMs;
  // FALSE-ALARM FIX (2026-07-02, second class): a fault observed on a SINGLE sweep is
  // transient (a push/fetch blip git-sync clears on its next healthy 3-min tick) — it must
  // persist across consecutive sweeps before it alarms. commitStale stays the backstop for
  // faults that genuinely freeze HEAD (2026-07-02 hiveloop: 2.5h frozen head still alarms).
  const hasError = typeof s.lastError === 'string' && s.lastError.trim().length > 0;
  const errorSweeps = hasError ? (s.errorSweeps ?? 1) : 0;
  const errorStall = !rootEngineStale && errorSweeps >= errorStallMinSweeps;
  const persistentReap = !rootEngineStale && (s.reapedCount ?? 0) >= persistentReapMin;
  const stalled = commitStale || fireStale || errorStall || persistentReap;

  let reason: string | null = null;
  if (stalled) {
    const parts: string[] = [];
    if (commitStale && s.headUnchangedMs != null) {
      parts.push(
        `the tree HEAD has not advanced in ~${hrs(s.headUnchangedMs)}h while the routine is active — commits are NOT landing (code strands uncommitted + un-deployable)`,
      );
    }
    if (fireStale && s.lastFiredMs != null) {
      parts.push(`the routine has not FIRED in ~${hrs(now - s.lastFiredMs)}h (active, cron every 3 min) — the scheduler/engine is not running it`);
    }
    if (persistentReap) {
      parts.push(
        `the DBOS executor reaper has cancelled ${s.reapedCount} consecutive git-sync fire(s) — fires start but never complete a commit (reap→requeue→restart loop; WI-1415)`,
      );
    }
    if (errorStall) {
      parts.push(
        `git-sync has recorded a FAULT on ${errorSweeps} consecutive watchdog sweeps (persistent, not a blip): "${s.lastError!.slice(0, 200)}"`,
      );
    }
    reason = parts.join('; ');
  }
  return { stalled, commitStale, fireStale, errorStall, persistentReap, reason };
}

/** Pure: the `harness_escalations` body for a watchdog-detected git-sync stall (testable). */
export function gitSyncStallEscalationBody(opts: {
  installSlug: string;
  verdict: GitSyncStallVerdict;
  lastFiredMs: number | null;
  headUnchangedMs: number | null;
  lastStatus: string | null;
  nowMs: number;
}): string {
  return JSON.stringify({
    kind: WATCHDOG_KIND,
    harness_slug: opts.installSlug,
    commitStale: opts.verdict.commitStale,
    fireStale: opts.verdict.fireStale,
    errorStall: opts.verdict.errorStall,
    persistentReap: opts.verdict.persistentReap,
    lastFiredAt: opts.lastFiredMs != null ? new Date(opts.lastFiredMs).toISOString() : null,
    headUnchangedHrs: opts.headUnchangedMs != null ? hrs(opts.headUnchangedMs) : null,
    lastStatus: opts.lastStatus,
    emitted_at: opts.nowMs,
    detail:
      `git-sync silent stall (watchdog): ${opts.verdict.reason}. The auto-commit of this checkout ` +
      `is not landing, so edits strand uncommitted and CANNOT deploy (a deploy ships only committed ` +
      `HEAD). Common root: a DBOS executor reaping stuck git-sync fires (bg-host/engine wedge — a ` +
      `lock/restart won't fix it). First moves: check metadata.last_error on the routine; rescue-` +
      `commit the stranded tree if urgent.`,
  });
}

export interface GitSyncStallWatchdogResult {
  alarmed: string[];
  recovered: string[];
}

/**
 * One watchdog pass: scan every ACTIVE git-sync routine, maintain the head-movement clock, alarm
 * once per stall transition (cross-process exactly-once via a conditional flag flip), broadcast
 * to the fleet, and clear the flag + escalation on recovery. Never throws.
 */
export async function checkGitSyncStall(
  sql: Sql,
  opts: GitSyncStallThresholds = {},
): Promise<GitSyncStallWatchdogResult> {
  const out: GitSyncStallWatchdogResult = { alarmed: [], recovered: [] };
  try {
    const rows = await sql<
      {
        install_slug: string;
        workspace_id: string;
        last_fired_ms: string | number | null;
        head_sha: string | null;
        wd_head_sha: string | null;
        wd_head_since_ms: string | number | null;
        last_status: string | null;
        last_error: string | null;
        watchdog_alerted: boolean | null;
        reaped_count: number | null;
        wd_error_sweeps: number | null;
      }[]
    >`
      SELECT install_slug,
             workspace_id,
             extract(epoch from last_fired_at) * 1000 AS last_fired_ms,
             metadata->>'head_sha' AS head_sha,
             metadata->>'wd_head_sha' AS wd_head_sha,
             (metadata->>'wd_head_since_ms')::bigint AS wd_head_since_ms,
             metadata->>'last_status' AS last_status,
             metadata->>'last_error' AS last_error,
             COALESCE((metadata->>'watchdog_alerted')::boolean, false) AS watchdog_alerted,
             COALESCE((metadata->>'reaped_count')::int, 0) AS reaped_count,
             COALESCE((metadata->>'wd_error_sweeps')::int, 0) AS wd_error_sweeps
        FROM harness_shared.routines
       WHERE target_role = 'system:git-sync'
         AND active = true`;

    const now = Date.now();
    const routineEngine = await readRoutineEngineLiveness(sql, { nowMs: now });
    for (const row of rows) {
      const lastFiredMs = row.last_fired_ms != null ? Number(row.last_fired_ms) : null;
      const wdHeadSinceMs = row.wd_head_since_ms != null ? Number(row.wd_head_since_ms) : null;
      const watchdogAlerted = row.watchdog_alerted ?? false;

      // ── Head-movement clock: reset when HEAD advances (or first observation). ──
      let headUnchangedMs: number | null;
      if (row.head_sha == null) {
        headUnchangedMs = null; // no head recorded yet ⇒ can't judge commit-staleness
      } else if (row.wd_head_sha !== row.head_sha || wdHeadSinceMs == null) {
        // HEAD advanced (or first time we've seen it) ⇒ record it + (re)start the clock.
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('wd_head_sha', ${row.head_sha}::text, 'wd_head_since_ms', ${now}::bigint),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:git-sync'`;
        headUnchangedMs = 0; // just moved ⇒ not commit-stale this pass
      } else {
        headUnchangedMs = now - wdHeadSinceMs;
      }

      // ── Fault-persistence streak: consecutive sweeps observing a fault (incl. this one).
      // git-sync NULLS last_error on any healthy tick, so a fault still present a full sweep
      // interval later has survived ~5+ runs — persistent. Reset to 0 the moment it clears.
      const hasError = typeof row.last_error === 'string' && row.last_error.trim().length > 0;
      const prevErrorSweeps = row.wd_error_sweeps != null ? Number(row.wd_error_sweeps) : 0;
      const errorSweeps = hasError ? prevErrorSweeps + 1 : 0;
      if (errorSweeps !== prevErrorSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('wd_error_sweeps', ${errorSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:git-sync'`;
      }

      const verdict = evaluateGitSyncStall(
        {
          lastFiredMs,
          headUnchangedMs,
          lastError: row.last_error,
          errorSweeps,
          lastStatus: row.last_status,
          watchdogAlerted,
          reapedCount: row.reaped_count != null ? Number(row.reaped_count) : 0,
          routineEngineStale: routineEngine.stale,
        },
        now,
        opts,
      );

      if (verdict.stalled) {
        if (watchdogAlerted) continue; // already alarmed; one-shot until recovery
        // Cross-process exactly-once: only the writer that flips watchdog_alerted false→true alarms.
        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"watchdog_alerted":true}'::jsonb,
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:git-sync'
             AND COALESCE((metadata->>'watchdog_alerted')::boolean, false) = false`;
        if (flip.count !== 1) continue; // another process won the flip

        // Say what the verdict actually is: a frozen-HEAD/fire/reap stall strands code; a pure
        // persistent-fault streak means commits MAY not be landing (HEAD may still advance).
        const summary =
          verdict.commitStale || verdict.fireStale || verdict.persistentReap
            ? `git-sync STALLED on ${row.install_slug} — firing but NOT committing; code is stranding uncommitted + un-deployable.`
            : `git-sync FAULTING on ${row.install_slug} — a fault has persisted across consecutive watchdog sweeps; commits may not be landing.`;
        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'git-sync STALLED — commits not landing, code stranding',
            body: `git-sync (${row.install_slug}) silent stall: ${verdict.reason}. Edits strand uncommitted + can't deploy. See routine metadata.last_error; rescue-commit if urgent.`,
            importance: 'urgent',
            workspaceId: row.workspace_id,
            data: { commitStale: verdict.commitStale, fireStale: verdict.fireStale, errorStall: verdict.errorStall, persistentReap: verdict.persistentReap },
          });
        } catch (e) {
          console.warn(`[git-sync-stall-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }
        // Fleet broadcast (owner-requested): inject-only (wake=false) so every running agent sees
        // it next turn and someone can claim it, without a wake storm.
        await broadcastSevereEvent({
          summary,
          body:
            `${verdict.reason}\n\nWhy it matters: a deploy ships only COMMITTED HEAD, so stranded edits ` +
            `can't reach :3070 until git-sync commits them. Likely a DBOS executor reaping stuck git-sync ` +
            `fires (engine wedge — a lock/restart won't fix it). Claim it: inspect metadata.last_error on ` +
            `the ${row.install_slug} git-sync routine, and rescue-commit the tree if the strand is urgent.`,
          category: 'severe-event',
          // WI-1444 condition lifecycle: recovery below broadcasts the matching
          // resolution, so late inbox readers see this alarm annotated resolved.
          conditionKey: `git-sync-stall:${row.install_slug}`,
        });
        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${row.install_slug}, ${WATCHDOG_PHASE}, ${gitSyncStallEscalationBody({
              installSlug: row.install_slug,
              verdict,
              lastFiredMs,
              headUnchangedMs,
              lastStatus: row.last_status,
              nowMs: now,
            })}, ${now}, ${row.workspace_id})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[git-sync-stall-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(row.install_slug);
        console.warn(`[git-sync-stall-watchdog] ALARM ${row.install_slug}: ${verdict.reason}`);
      } else {
        // Healthy. ALWAYS converge the escalation row — not only when OUR flag is set.
        // Multiple hosts run this watchdog concurrently (bg-host / staging / release
        // bootstraps), on DIFFERENT code versions during the staging→release lag; a
        // raced or wiped `watchdog_alerted` flag used to strand a non-null escalation
        // forever (observed live 2026-07-02: shared-hive-test carried a 4h-old cleared-
        // alarm escalation with alerted=false — the `else if (alerted)` gate meant no
        // healthy sweep could ever null it). The UPDATE is idempotent + row-scoped, so
        // running it on every healthy sweep is a no-op unless something is stranded.
        const cleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${row.install_slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (watchdogAlerted) {
          // Recovered from OUR alarm: clear the flag + supersede the fleet broadcast.
          await sql`
            UPDATE harness_shared.routines
               SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"watchdog_alerted":false}'::jsonb,
                   updated_at = now()
             WHERE install_slug = ${row.install_slug}
               AND target_role = 'system:git-sync'`;
          // WI-1444: supersede the fleet alarm — coord:inbox annotates every prior
          // `git-sync-stall:<slug>` broadcast resolved, so a late reader never
          // investigates a condition that already cleared. Fail-soft by design.
          await broadcastSevereEventResolved({
            conditionKey: `git-sync-stall:${row.install_slug}`,
            summary: `git-sync RECOVERED on ${row.install_slug} — commits are landing again; the earlier stall alarm is stale.`,
          });
          out.recovered.push(row.install_slug);
        } else if (cleared.count > 0) {
          console.warn(
            `[git-sync-stall-watchdog] cleared a STRANDED escalation for ${row.install_slug} (alerted flag was already false — flag/escalation divergence, likely a multi-host race)`,
          );
        }
      }
    }
    return out;
  } catch (e) {
    console.warn(`[git-sync-stall-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep. Idempotent.
 * Kill-switch: PAPERCUSP_GITSYNC_STALL_WATCHDOG='0'.
 */
export function startGitSyncStallWatchdog(
  sql: Sql,
  opts: GitSyncStallThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_GITSYNC_STALL_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const run = (): void => {
    void checkGitSyncStall(sql, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[git-sync-stall-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
    });
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('git-sync-stall-watchdog', intervalMs, run, { category: 'watchdog' });
}
