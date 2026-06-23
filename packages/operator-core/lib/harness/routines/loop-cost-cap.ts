/**
 * Loop cost-cap — the one net-new guardrail a "loop" routine adds over the existing
 * routine fire path (loop-routines-interval-recurrence-2026-06-20 P-004 / D-006, B-LOOP-3).
 *
 * A loop fires a recurring WARM `coord` wake at a pinned su session (the engine-managed
 * replacement for Claude /loop). Its existing safety net is the failure-streak fire-gate
 * (`checkFireGate`, autoloop.ts). D-006 adds exactly ONE more: a per-loop COST cap — when
 * the bound session's cumulative attributed spend since the loop was armed exceeds the
 * configured cap, auto-pause the routine (the cost sibling of the failure-streak auto-pause,
 * mirroring `plan-run-cost.ts` `autoPauseOnCostBreach` — but at the ROUTINE layer, since a
 * loop mints no plan_run, D-005/D-006).
 *
 * The cap lives in the routine's `payload_template.costCapCents` (a loop's config rides the
 * payload_template, set by the B-LOOP-5 arm-verb); the schema columns are su-d5a84's frozen
 * B-LOOP-1 seam (`reschedule_interval_sec` + `target_owner_id`), which this module does NOT
 * touch.
 *
 * ── Spend attribution: owner → session_id → cost (FAIL-OPEN on uncertain data) ────────────
 * `agent_usage_samples` (mig 161/170/279) is keyed by session_id, NOT the coord ownerId, so we
 * attribute via owner → `adv_sessions.session_id` → SUM(cost_usd) keyed on `session_id`. This
 * now WORKS for a warm interactive su session (loop-wake-rate-limit-robustness P3): the
 * interactive-usage ingestion (interactive-usage/ingest-claude-transcripts.ts) previously wrote
 * the native session UUID only into `run_id`, leaving `session_id` NULL — so the join found
 * nothing and `readLoopSpendCents` always returned 0. That is fixed: the ingestion now also
 * populates `session_id` with the native UUID (= the value `adv_sessions.session_id` carries),
 * so a warm-session loop's resume-turn spend is attributable and the cap actually binds. STILL
 * fail-open on genuinely uncertain data: when the owner has no tracked session id or a read
 * errors, `readLoopSpendCents` returns 0 (a false-pause is worse than a missed cap — the
 * failure-streak gate + the wake-delivery drop visibility still bound a runaway/dead loop). The
 * cap MECHANISM (evaluate → auto-pause → fire-gate integration) is exact + fully tested.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { advSessionsByCoordOwner } from '../../adv-sessions';

/**
 * Pure cap decision: a positive cap is breached when cumulative spend strictly exceeds it.
 * A null / non-finite / non-positive cap is "no cap" → never breaches.
 */
export function evaluateLoopCostCap(input: {
  spendCents: number;
  capCents: number | null | undefined;
}): { breach: boolean } {
  const cap = input.capCents;
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return { breach: false };
  return { breach: input.spendCents > cap };
}

/**
 * Best-effort cumulative spend (cents) attributed to a loop's bound owner since `sinceMs`.
 * FAIL-OPEN: any uncertainty (no resolvable session id, read error) → 0. See the file header.
 * Injectable for tests via the `checkLoopCostCap` deps seam.
 */
export async function readLoopSpendCents(opts: {
  sql?: Sql;
  targetOwnerId: string;
  sinceMs: number;
}): Promise<number> {
  try {
    const db = opts.sql ?? getOrgPg().sql;
    // owner (coord ownerId / PAPERCUSP_SID) → the native session id its usage samples carry.
    const byOwner = await advSessionsByCoordOwner();
    const sessionId = byOwner.get(opts.targetOwnerId)?.sessionId;
    if (!sessionId) return 0; // no tracked session → can't attribute → fail-open
    const rows = await db<Array<{ usd: number }>>`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd
        FROM harness_shared.agent_usage_samples
       WHERE session_id = ${sessionId}
         AND ts >= ${opts.sinceMs}
    `;
    const usd = rows[0]?.usd ?? 0;
    return Math.max(0, Math.round(usd * 100));
  } catch {
    return 0; // fail-open — never pause a working loop because attribution is fuzzy
  }
}

/**
 * Auto-pause a loop routine on a guardrail breach: deactivate it + stamp the reason into
 * metadata (the paused state IS the notification — autoloop:status / the loop surface show
 * it inactive with the reason). Mirrors the spirit of `disarmPlanSchedule` at the routine
 * layer. `active=FALSE` stops the tick from claiming it; `next_fire_at=NULL` is tidy (an
 * inactive routine is never claimed regardless).
 */
export async function autoPauseLoopRoutine(sql: Sql, routineId: string, reason: string): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET active = FALSE,
           next_fire_at = NULL,
           metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('loop_paused_reason', ${reason}::text, 'loop_paused_at', now()::text),
           updated_at = now()
     WHERE id = ${routineId}
  `;
}

export interface LoopCostGuardDeps {
  /** Injected for tests; defaults to the real best-effort attribution read. */
  readSpend?: typeof readLoopSpendCents;
  /** Injected for tests; defaults to the real auto-pause write. */
  autoPause?: typeof autoPauseLoopRoutine;
}

export interface LoopCostCapResult {
  breach: boolean;
  spendCents: number;
  capCents: number | null;
}

/**
 * The cost-cap gate the loop fire consults BEFORE waking. No cap configured ⇒ never breaches
 * (zero reads). With a cap: window the bound owner's cumulative spend since the loop armed
 * (the routine's `created_at`) and, on breach, auto-pause the routine and report it so the
 * fire is withheld.
 */
export async function checkLoopCostCap(
  input: {
    sql?: Sql;
    routineId: string;
    targetOwnerId: string;
    capCents: number | null | undefined;
  },
  deps: LoopCostGuardDeps = {},
): Promise<LoopCostCapResult> {
  const cap = input.capCents;
  if (cap == null || !Number.isFinite(cap) || cap <= 0) {
    return { breach: false, spendCents: 0, capCents: null };
  }
  const db = input.sql ?? getOrgPg().sql;
  const readSpend = deps.readSpend ?? readLoopSpendCents;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;

  // Arm anchor = the routine's created_at (when the loop was armed). Cumulative-since-arm is
  // the "total budget" semantic; a re-armed loop keeps the original created_at, which slightly
  // over-counts but is safe (errs toward pausing sooner) and is the documented v1 behavior.
  const armed = await db<Array<{ armed_ms: string | number | null }>>`
    SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS armed_ms
      FROM harness_shared.routines
     WHERE id = ${input.routineId}
  `;
  const armedAtMs = Number(armed[0]?.armed_ms ?? 0);

  const spendCents = await readSpend({ sql: db, targetOwnerId: input.targetOwnerId, sinceMs: armedAtMs });
  const { breach } = evaluateLoopCostCap({ spendCents, capCents: cap });
  if (breach) {
    await autoPause(db, input.routineId, `cost-cap breached: ${spendCents}¢ > ${cap}¢ (cumulative since arm)`);
  }
  return { breach, spendCents, capCents: cap };
}
