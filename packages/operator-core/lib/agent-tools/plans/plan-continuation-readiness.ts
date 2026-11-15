/**
 * Revision-keyed reuse of the plan CONTINUATION readiness verdict (WI-6554700010049220).
 *
 * Every plan-bound implementation call (a native pre-tool hook or an MCP write) used to
 * re-run the complete start-readiness bundle — start gate, spec quality, critique,
 * admission, activation and audit — for the same unchanged plan revision. Measured on
 * :3170 (2026-11-15 03:40-03:48Z, `[tool-guard-timing]`), that bundle took 7-60s per call
 * while the native pre-tool hook wall is 1.5s, so every plan-bound codex write was
 * refused fail-closed even though the plan was started and executable.
 *
 * What stays FRESH on every call (the caller still performs these reads):
 *   - the owner's binding census and the canonical binding identity;
 *   - the execution start proof (`readPlanExecutionStart`), which is the revocation fence
 *     for a voided or stale start;
 *   - the revision fence read here (harness, content hash, start revision seq), which is
 *     part of the cache key, so any plan edit or restart misses the cache.
 *
 * What is REUSED: only a POSITIVE continuation verdict for that exact fence, shared across
 * every owner bound to the plan, for at most `READINESS_HARD_TTL_MS`. After
 * `READINESS_SOFT_TTL_MS` the entry is served once more while one background rebuild
 * re-runs the full bundle (single-flight). A refusal is never cached: it is re-evaluated
 * on the next call, so a repaired plan is admitted without waiting for any TTL.
 *
 * Staleness bound: plan audits and spec clauses are fingerprinted into the key (see
 * `ReadinessFence.inputs`), and a rubric amend voids the start. The residual is the
 * conversation-keyed inputs (critique consults, scorecards): a revocation through them
 * reaches a plan-bound writer within the hard TTL.
 * Reuses the operator cache (`cachedRead`: single-flight, SWR, hard TTL, kill-switch).
 *
 * Bounded admission (EI-28849154189042602). A COLD rebuild (first call after a restart, a
 * plan edit, or more than the hard TTL since the last plan-bound write) runs the full
 * bundle: 12.2s unloaded (measured 2026-11-15), and long enough under server load that it
 * exhausted the ~55s dispatch deadline inside kernel enforcement, so `capability:write` /
 * `capability:edit` were cancelled with no reason at all. The evaluation is now bounded by
 * `READINESS_EVALUATION_BUDGET_MS`. Past it the caller gets the typed, retryable
 * `PLAN_READINESS_PENDING` refusal (fail-closed: nothing is granted) while the single-flight
 * build keeps running and warms the cache, so the retry is admitted from the warm entry. A
 * build that settles as a refusal after its caller timed out is held once for the next
 * caller of the same fence, so a refused plan still reports its real blockers.
 */
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import { cachedRead, stableKey } from '../../cache/cached-read';
import type { ExecutionPlanBinding, PlanExecutionTimingObserver } from './plan-execution-guard';

export const READINESS_SOFT_TTL_MS = 30_000;
export const READINESS_HARD_TTL_MS = 90_000;
export const CONTINUATION_READINESS_CACHE_TOOL = 'plan-execution-guard:continuation-readiness';
/** Admission budget for one readiness evaluation; well below the ~55s dispatch deadline. */
export const READINESS_EVALUATION_BUDGET_MS = 20_000;
/** Suggested retry delay after a pending verdict; the background build keeps warming. */
export const READINESS_PENDING_RETRY_AFTER_MS = 10_000;
/** The only blocker returned when the budget elapsed before a verdict was known. */
export const PLAN_READINESS_PENDING = 'plan_readiness_pending';
/** How long a background-settled refusal is held for the retrying caller. */
export const READINESS_SETTLED_REFUSAL_TTL_MS = 60_000;

/** Refusals that settled after their caller's budget elapsed, keyed by workspace + fence. */
const settledRefusals = pinModuleState('@papercusp/operator-core.plan-continuation-readiness.settled-refusals',
  () => new Map<string, { blockers: string[]; at: number }>());

function rememberSettledRefusal(key: string, blockers: string[]): void {
  const now = Date.now();
  // Expired entries carry no meaning any more; dropping them keeps the map at the live set.
  for (const [k, v] of settledRefusals) if (now - v.at > READINESS_SETTLED_REFUSAL_TTL_MS) settledRefusals.delete(k);
  settledRefusals.set(key, { blockers: [...blockers], at: now });
}

function takeSettledRefusal(key: string): string[] | null {
  const entry = settledRefusals.get(key);
  if (!entry) return null;
  settledRefusals.delete(key);
  return Date.now() - entry.at <= READINESS_SETTLED_REFUSAL_TTL_MS ? entry.blockers : null;
}

/** Test seam: clear background-settled refusals between cases. */
export function resetSettledReadinessRefusalsForTests(): void { settledRefusals.clear(); }

/**
 * `inputs` fingerprints the plan-keyed policy rows the continuation bundle reads that do
 * NOT void the execution start (migration 1620 already clears the start seq for the plan
 * row, its lifecycle, plan-line work items and dependency edges): every plan_audits row
 * (activation, discovery, per-item code-truth) and the plan's compiled spec clauses. A new
 * or revised row changes the key, so a revocation through them is never masked.
 */
export interface ReadinessFence { harnessSlug: string; contentHash: string; startSeq: number; inputs: string }

export type ReadinessEvaluator = (binding: ExecutionPlanBinding, workspaceId: string,
  observe?: PlanExecutionTimingObserver) => Promise<string[]>;

export interface ContinuationReadinessDeps {
  readFence: (binding: ExecutionPlanBinding, workspaceId: string) => Promise<ReadinessFence | null>;
  evaluate: ReadinessEvaluator;
  /** Admission budget override (tests); defaults to `READINESS_EVALUATION_BUDGET_MS`. */
  budgetMs?: number;
}

/** One indexed row read: the exact revision the cached verdict may be reused for. */
export async function readReadinessFence(binding: ExecutionPlanBinding, workspaceId: string): Promise<ReadinessFence | null> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ harness_slug: string; content_hash: string;
    execution_start_revision_seq: number | string | null; inputs: string | null }>>`
    SELECT p.harness_slug, p.content_hash, p.execution_start_revision_seq,
           concat_ws(':',
             (SELECT concat_ws('/', count(*), max(a.audit_seq)) FROM harness_shared.plan_audits a
               WHERE a.workspace_id=p.workspace_id AND a.harness_slug=p.harness_slug AND a.plan_slug=p.plan_slug),
             (SELECT concat_ws('/', count(*), max(c.updated_at)) FROM harness_shared.plan_spec_clauses c
               WHERE c.workspace_id=p.workspace_id AND c.harness_slug=p.harness_slug AND c.plan_slug=p.plan_slug)) AS inputs
      FROM harness_shared.harness_plans p
     WHERE p.workspace_id=${workspaceId} AND p.plan_slug=${binding.planSlug}
       AND (${binding.harnessSlug}::text IS NULL OR p.harness_slug=${binding.harnessSlug})`;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.execution_start_revision_seq == null || !row.content_hash) return null;
  return { harnessSlug: row.harness_slug, contentHash: row.content_hash,
    startSeq: Number(row.execution_start_revision_seq), inputs: row.inputs ?? '' };
}

function note(observe: PlanExecutionTimingObserver | undefined, stage: string): void {
  try { observe?.({ stage, durationMs: 0 }); } catch { /* diagnostics only */ }
}

/**
 * The continuation verdict for `binding`: `[]` when executable, otherwise the blockers.
 * An unreadable fence (missing, ambiguous or unstarted plan) is never cached; the full
 * evaluator then produces the precise refusal.
 */
export async function checkContinuationReadiness(binding: ExecutionPlanBinding, workspaceId: string,
  observe: PlanExecutionTimingObserver | undefined, deps: ContinuationReadinessDeps): Promise<string[]> {
  const fence = await deps.readFence(binding, workspaceId);
  if (!fence) return deps.evaluate(binding, workspaceId, observe);
  const key = { harness: fence.harnessSlug, plan: binding.planSlug, contentHash: fence.contentHash,
    startSeq: fence.startSeq, inputs: fence.inputs };
  const refusalKey = `${workspaceId}|${stableKey(key)}`;
  const settled = takeSettledRefusal(refusalKey);
  if (settled) {
    note(observe, 'readiness_settled_refusal');
    return settled;
  }
  // A holder object: the factory may run here, in a joined build, or (SWR) after return.
  const local: { built: string[] | null; ranHere: boolean } = { built: null, ranHere: false };
  const build = (async (): Promise<string[]> => {
    const verdict = await cachedRead<{ executable: true } | null>({ workspaceId }, {
      tool: CONTINUATION_READINESS_CACHE_TOOL,
      key,
      // Revision and plan-keyed policy rows are in the key. Conversation-keyed critique
      // consults and scorecards are bounded by the TTLs below (residual: see header).
      tags: [],
      softTtlMs: READINESS_SOFT_TTL_MS,
      hardTtlMs: READINESS_HARD_TTL_MS,
    }, async () => {
      local.ranHere = true;
      const blockers = await deps.evaluate(binding, workspaceId, observe);
      local.built = blockers;
      return blockers.length ? null : { executable: true as const };
    });
    if (verdict) {
      if (!local.ranHere) note(observe, 'readiness_reused');
      return [];
    }
    // A refusal is never stored in the cache. A caller that joined another caller's refused
    // build re-evaluates itself, so its blockers are its own, current reading.
    return local.built ?? deps.evaluate(binding, workspaceId, observe);
  })();
  const budgetMs = Math.max(1, deps.budgetMs ?? READINESS_EVALUATION_BUDGET_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), budgetMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const result = await Promise.race([build, elapsed]);
    if (result !== null) return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Budget elapsed: refuse now (fail-closed) and let the build finish in the background.
  // A positive verdict lands in the cache for the retry; a refusal is held for one caller.
  note(observe, 'readiness_pending');
  build.then(blockers => { if (blockers.length) rememberSettledRefusal(refusalKey, blockers); },
    () => { /* the next caller re-evaluates and reports its own failure */ });
  return [PLAN_READINESS_PENDING];
}
