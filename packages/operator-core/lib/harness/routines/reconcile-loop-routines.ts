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
 *  1. PRIMARY — the lifecycle 'ended' marker (above). COLD loops (payload_template
 *     carry:'cold') use a DIFFERENT ladder entirely — see completionSignal: the settle is
 *     the turn's 'ended' AFTER the boundary 'started', OR the carry-note refresh (the
 *     protocol's own completion receipt); bare presence-quiescence is NOT a cold settle
 *     (a recycle's booted-but-idle session is quiet without having run its iteration —
 *     the 2026-07-03 stale-note-treadmill live finding, wakes #5033→#5036).
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
 * Wired as its OWN `loop-rebase-sweep` step in routinesTickImpl (routines-workflow.ts),
 * FIRST after the fire loop — NOT at the tail of reconcileAndGovern where it used to
 * ride (Task-#8, 2026-07-03: the 9 serial sweeps ahead of it starved under pool
 * pressure and armed loops sat parked ~17 min between 60s wakes).
 *
 * NB on parked-Date parsing: postgres-js parses `'infinity'::timestamptz` to an INVALID
 * JS Date (d5a84's frozen-seam note). This module never relies on the JS-parsed
 * `next_fire_at` for a parked row — "parked" is computed as a SQL boolean and every
 * infinity comparison is done in SQL — so the invalid-Date trap cannot bite here.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  recordFire as defaultRecordFire,
  readFireState as defaultReadFireState,
  circuitThreshold as defaultCircuitThreshold,
  LOOP_TERMINAL_AUTO_PAUSE_STATUS,
} from '../../autoloop';
import { runWithWorkspace } from '../../workspace-als';
import { checkUnreachableTerminalGuard as defaultCheckUnreachableTerminalGuard } from './loop-unreachable-guard';
import { cancelInboxWake as defaultCancelInboxWake } from '../../events/await/inbox-wake-arm';
import { openEscalation } from '../../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

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

/**
 * QUICK-RETRY leg (WI-2714 — "recover-then-escalate, not escalate-only"). The classic
 * stuck-park backstop above only attempts its first re-fire after a generous ~30min dwell
 * (right, for the TERMINATION decision — a legitimately long turn must never be mistaken for
 * a dead owner) but that same generous dwell was also gating the RETRY itself, so a member
 * whose turn wedged on something recoverable (e.g. a stale `events:await` the wake-executor's
 * inject channel can actually unstick) sat fully idle for the whole window, and 3 separate
 * live incidents needed a leader to manually `coord:wake` it faster than the backstop would
 * have on its own (throughput loss + leader toil + noisy human escalation).
 *
 * The fix decouples "safe to ATTEMPT another wake" from "safe to conclude the owner is dead":
 * termination (checkUnreachableTerminalGuard) keeps its full dwell + reachability veto
 * UNCHANGED below — this only adds an EARLIER, BOUNDED opportunity to retry the exact same
 * re-arm-and-refire the classic path already performs, for the SAME quiet-parked candidates
 * (`looksDeadOrStuck`, i.e. zero presence activity since the fire — a genuinely busy turn is
 * never touched by either leg). Bounded by `quickRetryMaxAttempts()` consecutive errors so a
 * truly-dead owner falls through to the classic (slower, dwell-gated) path — and from there,
 * unchanged, to the reachability-vetoed terminal guard — rather than quick-retrying forever.
 */
const DEFAULT_QUICK_RETRY_PARK_MS = 10 * 60_000; // 10min — comfortably past a normal build/test/install tool call
const DEFAULT_QUICK_RETRY_MAX_ATTEMPTS = 3;

/** Floor for the quick-retry leg: env-overridable, floored at 3× the loop's own interval (same
 *  "give a short-interval loop several real cycles first" idiom as `stuckParkMs`'s 4×, one less
 *  since this is the SHORTER, earlier-firing leg). */
function quickRetryParkMs(intervalMs: number): number {
  const env = Number(process.env.PAPERCUSP_LOOP_QUICK_RETRY_MS);
  const base = Number.isFinite(env) && env > 0 ? env : DEFAULT_QUICK_RETRY_PARK_MS;
  return Math.max(base, intervalMs * 3);
}

/** How many consecutive quick-retry attempts before falling back to the classic (dwell-gated)
 *  stuck-park path. Env-overridable; <=0 disables the quick-retry leg entirely (fail-soft to
 *  today's behavior — the classic path is untouched either way). */
function quickRetryMaxAttempts(): number {
  const env = Number(process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS);
  return Number.isFinite(env) ? env : DEFAULT_QUICK_RETRY_MAX_ATTEMPTS;
}

/** WI-2339 (fix E) — the synthetic system principal the loud dead-loop escalation is attributed
 *  to, mirroring INFRA_LIVENESS_IDENTITY. Attributable + dedupable in the human inbox. */
export const LOOP_DEATH_WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'system:loop-death-watchdog',
  ownerLabel: 'system · loop-death-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Diagnostics passed to the dead-loop escalation seam. */
export interface DeadLoopInfo {
  routineId: string;
  targetOwnerId: string;
  installSlug: string;
  name: string;
  reason: string;
}

/**
 * Default loud human escalation for a durably-dead loop (WI-2339 fix E = pause+escalate, NOT
 * auto-respawn — owner policy). Advisory severity: the watchdog has ALREADY paused the loop, so
 * the human just needs to know it happened + decide whether to relaunch. `harness_slug` federates
 * the escalation to the owning harness's human inbox (WI-1375). May throw if the coord context is
 * unavailable in this worker — the CALLER swallows it (worst case: no escalation, never a crashed
 * tick), so this stays a plain await.
 */
async function defaultEscalateDeadLoop(info: DeadLoopInfo): Promise<void> {
  await openEscalation(LOOP_DEATH_WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Loop '${info.name}' auto-paused — owner session ${info.targetOwnerId} is durably dead (wakes stopped landing).`,
    body:
      `The loop death/respawn watchdog (WI-2339) confirmed loop '${info.name}' ` +
      `(routine ${info.routineId}, harness ${info.installSlug}, owner ${info.targetOwnerId}) can no longer be ` +
      `reached as a fresh turn, and AUTO-PAUSED it (active=false) instead of re-firing into a dead session forever.\n\n` +
      `Reason: ${info.reason}\n\n` +
      `This is inform-only: the watchdog does NOT auto-respawn (owner policy). To resume the work, ` +
      `relaunch the owner session and re-arm the loop (loop:arm), or reclaim its work-items.`,
    harness_slug: info.installSlug,
  });
}

export type RebaseVia = 'lifecycle' | 'note-refresh' | 'presence-quiescence' | 'stuck-backstop';

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
    /** WI-2714: true when this 'stuck-backstop' re-arm fired via the EARLY quick-retry leg
     *  (before the classic dwell window elapsed) rather than the classic dwell-gated path.
     *  Absent/false for every other via and for a classic stuck-backstop re-arm. */
    quickRetry?: boolean;
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
  /** max(agent_activity.created_at) for a kind='lifecycle' 'started' marker after the fire —
   *  the cold reset-boundary guard (see completionSignal). */
  lifecycle_started_at: Date | string | null;
  /** payload_template->>'carry' — 'cold' marks a cold loop (reset/recycle wakes), which
   *  changes what counts as a settle (see completionSignal). */
  carry: string | null;
  /** max(carry_notes.updated_ts) for the loop's scope, any workspace (epoch ms — bigint,
   *  so a STRING over the wire). A refresh AFTER the fire is the cold protocol's own
   *  "iteration done" contract (loop:checkpoint is REQUIRED before a cold turn ends). */
  note_updated_ts: string | number | null;
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
  // ── COLD loop (carry:'cold') — settle requires evidence the ITERATION RAN ────────
  // A cold wake delivers a reset/recycle that restarts the session, so the signals mean
  // different things than warm (su-cold-auto live test, 2026-07-03, wakes 7-10):
  //  - A recycle KILLS the child (emitting '■ session ended') and the fresh child's
  //    carry inject is best-effort — when it defers, the booted-but-idle session sits
  //    QUIET, which the presence-quiescence fallback read as "turn settled" and re-fired
  //    91s after the recycle, into a still-booting host (wake #5036 after #5033). Bare
  //    quiescence CANNOT distinguish "booted idle, iteration never ran" from "iteration
  //    done" — so it is NOT a cold settle signal at all.
  //  - What IS: (1) the turn's own Stop-hook 'ended' NEWER than the boundary 'started'
  //    (the session booted AND its turn finished), or (2) the carry-note REFRESH — the
  //    cold protocol's required loop:checkpoint before turn end, i.e. the iteration's
  //    own completion receipt. Take the later of the two (checkpoint-then-more-work
  //    still re-arms off the latest evidence; the pty host's clean-boundary gate defers
  //    an early-landing cold apply to the turn boundary regardless).
  //  - A dead boot / dropped iteration produces NEITHER → the loop stays parked until
  //    the stuck-park backstop re-fires it, which re-delivers the SAME note — exactly
  //    the right retry.
  if (row.carry === 'cold') {
    const lcCold = tsMs(row.lifecycle_completed_at);
    const lsCold = tsMs(row.lifecycle_started_at);
    const turnEnded = lcCold != null && lsCold != null && lcCold > lsCold ? lcCold : null;
    const rawNoteTs = row.note_updated_ts == null ? null : Number(row.note_updated_ts);
    const noteRefreshed =
      rawNoteTs != null && Number.isFinite(rawNoteTs) && rawNoteTs > lastFiredMs ? rawNoteTs : null;
    if (turnEnded != null && (noteRefreshed == null || turnEnded >= noteRefreshed)) {
      return { completedAt: turnEnded, via: 'lifecycle' };
    }
    if (noteRefreshed != null) {
      return { completedAt: noteRefreshed, via: 'note-refresh' };
    }
    return null;
  }
  // ── WARM loop — the original two-layer ladder ────────────────────────────────────
  // 1. PRIMARY: the Stop-hook lifecycle 'ended' marker (already filtered > last_fired by
  //    the SQL window). COLD-RESET-BOUNDARY GUARD (su-cold-auto 2026-07-03): a COLD
  //    reset/recycle wake restarts the session AT delivery — the dying process emits
  //    '■ session ended' and the fresh one '▶ session started' back-to-back (~250ms apart),
  //    so an 'ended' marker OLDER than the newest post-fire 'started' is the reset boundary,
  //    NOT the woken turn settling. Treating it as a settle re-armed the loop ~interval
  //    after DELIVERY and the next fire landed mid-turn (observed live: fire #4979
  //    overlapped the still-running turn of fire #4972). A settle requires the newest
  //    post-fire lifecycle marker to be the 'ended' one; while a fresh 'started' is newest,
  //    the session is RUNNING → not settled (the cold turn's own Stop hook emits the real
  //    'ended' when it finishes). Warm loops are unaffected: 'started' fires only at process
  //    boot, which precedes last_fired and falls outside the SQL window.
  const lc = tsMs(row.lifecycle_completed_at);
  const ls = tsMs(row.lifecycle_started_at);
  if (lc != null && (ls == null || ls < lc)) {
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
    /** Injected for tests; defaults to the real fire-circuit threshold read (EI-7006). */
    circuitThreshold?: typeof defaultCircuitThreshold;
    /** WI-2339 (fix E): injected loud human-escalation for a confirmed durably-dead loop. Fires
     *  ONCE per dead loop (the breach auto-pauses it → never re-scanned). Default opens an advisory
     *  coord escalation. Fail-soft at the call site. */
    escalateDeadLoop?: (info: DeadLoopInfo) => Promise<void>;
    /** WI-2339 (fix D): injected inbox-wake cancel for a confirmed durably-dead owner. Default
     *  cancelInboxWake — stops the ghost standing await from matching-without-consuming and
     *  poisoning EVERY other wake source for the dead owner. Fail-soft at the call site. */
    cancelInboxWake?: (ownerId: string, workspaceId?: string) => Promise<number>;
  } = {},
): Promise<LoopRebaseResult> {
  const db = opts.sql ?? getOrgPg().sql;
  const nowMs = opts.nowMs ?? Date.now();
  const recordFire = opts.recordFire ?? defaultRecordFire;
  const readFireState = opts.readFireState ?? defaultReadFireState;
  const checkUnreachableTerminalGuard = opts.checkUnreachableTerminalGuard ?? defaultCheckUnreachableTerminalGuard;
  const circuitThreshold = opts.circuitThreshold ?? defaultCircuitThreshold;
  const escalateDeadLoop = opts.escalateDeadLoop ?? defaultEscalateDeadLoop;
  const cancelInboxWake = opts.cancelInboxWake ?? defaultCancelInboxWake;

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
           (SELECT max(a.created_at)
              FROM harness_shared.agent_activity a
             WHERE a.owner_id = r.target_owner_id
               AND a.kind = 'lifecycle'
               AND a.summary ILIKE '%start%'
               AND a.created_at > r.last_fired_at) AS lifecycle_started_at,
           (r.payload_template->>'carry') AS carry,
           (SELECT max(cn.updated_ts)
              FROM harness_shared.carry_notes cn
             WHERE cn.scope = ('loop:' || r.install_slug || ':' || r.target_owner_id)
               AND cn.note IS NOT NULL) AS note_updated_ts,
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
      let quickRetry = false;
      const signal = completionSignal(row, lastFiredMs, nowMs);
      if (signal) {
        completedAt = signal.completedAt;
        via = signal.via;
      } else {
        // No healthy completion signal. A PARKED loop with NO post-fire activity is a
        // dead-or-stuck candidate — a legitimately long turn keeps producing activity, so its
        // last_active_at would be > last_fired and it is skipped here for free (no fire-state read).
        // Two ways such a loop needs the dead-owner terminal guard (WI-1399):
        //   • STUCK-PARK — parked past the dwell window (the original backstop trigger); OR
        //   • CIRCUIT-OPEN (EI-7006) — its fire-circuit already has ≥circuitThreshold consecutive
        //     failures. The circuit's ~hourly probe keeps refreshing last_fired, so `nowMs-last_fired`
        //     rarely reaches stuckParkMs and the stuck-park branch is STARVED; and even when reached,
        //     the 2h terminal-window floor exceeds the inter-probe gap so the guard never breaches.
        //     Routing a circuit-open loop to the guard directly (dwell window decoupled) is the fix
        //     for dead loops that otherwise climb to 55→∞ fire-circuit-open EIs and never terminate.
        const looksDeadOrStuck =
          row.parked && (tsMs(row.presence_last_active_at) ?? 0) <= lastFiredMs;
        if (!looksDeadOrStuck) {
          continue; // still in flight (has post-fire activity) / nothing to fold — leave it
        }
        // Read the fire-state ONCE (only on this quiet-parked path, so healthy loops pay nothing):
        // it drives BOTH the circuit-open decision and the stuck-fire count the guard consumes.
        // Fail-soft: a read failure is treated as zero prior errors (guard still consulted).
        const priorState = await runWithWorkspace(row.routine_workspace_id, () =>
          readFireState(row.install_slug, row.name),
        ).catch(() => null);
        const consecutiveErrors = priorState?.consecutiveErrors ?? 0;
        const circuitOpen = consecutiveErrors >= circuitThreshold();
        const stuckParkElapsed = nowMs - lastFiredMs >= stuckParkMs(intervalMs);
        // WI-2714 quick-retry leg: eligible ONLY before the classic dwell (stuckParkElapsed
        // already subsumes it), never once the circuit is open (that path is reserved for the
        // terminal guard's decoupled fast path below — quick-retrying a circuit-open loop would
        // just fight the circuit's own backoff), and only for a bounded few attempts.
        const quickRetryElapsed = nowMs - lastFiredMs >= quickRetryParkMs(intervalMs);
        const quickRetryEligible =
          quickRetryElapsed &&
          !stuckParkElapsed &&
          !circuitOpen &&
          quickRetryMaxAttempts() > 0 &&
          consecutiveErrors < quickRetryMaxAttempts();

        // Consult the dead-owner terminal guard when the loop is stuck-park OR circuit-open. Before
        // re-arming into the void yet again, check whether the owner is PERMANENTLY unreachable (no
        // injectable/resumable wake channel) — if so, auto-pause instead. Fail-soft: any probe/read
        // failure falls back to the normal stuck-backstop re-arm below (never blocks a retry on an
        // uncertain read).
        if (circuitOpen || stuckParkElapsed) {
          // stuckFireCount: on the circuit-open path the streak IS consecutiveErrors (already
          // ≥threshold); on the classic stuck-park path it is prior errors + this fire (+1),
          // preserving the original WI-1399 contract byte-for-byte when the circuit is closed.
          const stuckFireCount = circuitOpen ? consecutiveErrors : consecutiveErrors + 1;
          const guard = await checkUnreachableTerminalGuard({
            sql: db,
            routineId: row.id,
            targetOwnerId: row.target_owner_id,
            parkedForMs: nowMs - lastFiredMs,
            intervalMs,
            stuckFireCount,
            circuitOpen,
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
              recordFire(row.install_slug, row.name, LOOP_TERMINAL_AUTO_PAUSE_STATUS, 'error'),
            ).catch((e) =>
              console.warn(
                `[loop-reconcile] recordFire('error') failed for terminated loop '${row.id}': ${e instanceof Error ? e.message : e}`,
              ),
            );
            // WI-2339 fix D — stop the ghost standing inbox-wake await from matching-without-
            // consuming and poisoning EVERY other wake source for this now-confirmed-dead owner
            // (the once=false await is otherwise cancelled only on a graceful SessionEnd, which an
            // unplanned death never runs). Fail-soft: a cancel failure never blocks termination.
            await runWithWorkspace(row.routine_workspace_id, () =>
              cancelInboxWake(row.target_owner_id, row.routine_workspace_id),
            ).catch((e) =>
              console.warn(
                `[loop-reconcile] cancelInboxWake failed for dead owner '${row.target_owner_id}': ${e instanceof Error ? e.message : e}`,
              ),
            );
            // WI-2339 fix E — pause+ESCALATE (owner policy: NOT auto-respawn). Loudly tell a human
            // the watchdog auto-paused a dead loop, rather than the silent no-op it was before.
            // Fires exactly once (the loop is now active=false → never re-scanned). Fail-soft: a
            // missing coord context degrades to no escalation, never a crashed tick.
            await runWithWorkspace(row.routine_workspace_id, () =>
              escalateDeadLoop({
                routineId: row.id,
                targetOwnerId: row.target_owner_id,
                installSlug: row.install_slug,
                name: row.name,
                reason: guard.reason ?? 'unreachable dead-owner loop',
              }),
            ).catch((e) =>
              console.warn(
                `[loop-reconcile] escalateDeadLoop failed for terminated loop '${row.id}': ${e instanceof Error ? e.message : e}`,
              ),
            );
            console.warn(
              `[loop-reconcile] loop '${row.id}' (owner ${row.target_owner_id}) TERMINATED (auto-paused, not re-armed): ${guard.reason}`,
            );
            continue; // auto-paused (active=false) inside the guard — do NOT re-arm below
          }
        }

        // Not terminated. Re-arm to retry when EITHER the classic stuck-park dwell has elapsed
        // (the original backstop behavior) OR the WI-2714 quick-retry leg is eligible (a bounded
        // early attempt, well before the classic dwell — see quickRetryEligible's doc above). A
        // circuit-open-but-not-breached loop that has reached neither is left untouched — the
        // fire-gate owns its cadence; re-arming it here would only fight the circuit's backoff.
        if (!stuckParkElapsed && !quickRetryEligible) {
          continue;
        }
        completedAt = lastFiredMs;
        via = 'stuck-backstop';
        if (quickRetryEligible && !stuckParkElapsed) quickRetry = true;
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
