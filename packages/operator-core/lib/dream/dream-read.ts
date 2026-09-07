/** Bounded Analyze projections over the existing Dream ledger. No model calls. */
import type { Sql } from 'postgres';
import { z } from 'zod';
import { getDreamRun, type DreamRun } from './dream-run-store';
import { dreamCapabilityRun, dreamRunAssessments } from './dream-run-provenance';
import { CapabilityProposalSchema } from './capability-pass';
import type { CapabilityReviewResult } from './capability-review';
import type { DreamMetricsScope } from './dream-metrics';

export interface DreamRunSummary {
  runId: string;
  cycleId: string;
  potSlug: string;
  mode: DreamRun['mode'];
  status: DreamRun['status'];
  startedAt: string;
  costUsd: number;
  title: string | null;
  routedRef: string | null;
  version: string | null;
}
export interface DreamHistory {
  scope: DreamMetricsScope;
  runs: DreamRunSummary[];
  nextCursor: string | null;
}
const cursorSchema = z.tuple([z.string().datetime(), z.string().min(1).max(500)]);

/** Keep packet excerpts out of the list; the single-run read supplies them on expansion. */
export async function readDreamHistory(
  sql: Sql,
  scope: DreamMetricsScope,
  cursor?: string,
): Promise<DreamHistory> {
  const since = Date.parse(scope.since), until = Date.parse(scope.until);
  if (!scope.workspaceId.trim() || !scope.potSlug.trim() || !Number.isFinite(since) ||
      !Number.isFinite(until) || until <= since || until - since > 31 * 86_400_000)
    throw new RangeError('Dream history needs a scoped window of at most 31 days');
  const before = cursor ? cursorSchema.parse(JSON.parse(cursor)) : null;
  const rows = await sql`
    SELECT run_id, cycle_id, pot_slug, mode, status, started_at, cost_usd, routed_ref,
           left(COALESCE(outcome->'insight'->>'text', outcome->'insight'->>'mergedIdea'), 500) AS title,
           outcome->'capabilityRun'->>'schemaVersion' AS version
      FROM harness_shared.dream_runs
     WHERE workspace_id = ${scope.workspaceId} AND pot_slug = ${scope.potSlug}
       AND started_at >= ${scope.since}::timestamptz AND started_at < ${scope.until}::timestamptz
       ${before ? sql`AND (started_at, run_id) < (${before[0]}::timestamptz, ${before[1]})` : sql``}
     ORDER BY started_at DESC, run_id DESC LIMIT 21`;
  const runs = rows.slice(0, 20).map((r): DreamRunSummary => ({
    runId: String(r.run_id), cycleId: String(r.cycle_id), potSlug: String(r.pot_slug),
    mode: r.mode as DreamRun['mode'], status: r.status as DreamRun['status'],
    startedAt: new Date(r.started_at).toISOString(), costUsd: Number(r.cost_usd),
    title: r.title == null ? null : String(r.title),
    routedRef: r.routed_ref == null ? null : String(r.routed_ref),
    version: r.version == null ? null : String(r.version),
  }));
  const last = runs.at(-1);
  return { scope, runs, nextCursor: rows.length > 20 && last ? JSON.stringify([last.startedAt, last.runId]) : null };
}

export function projectDreamDetail(run: DreamRun) {
  const provenance = dreamCapabilityRun(run);
  const insight = run.outcome?.insight as Record<string, unknown> | undefined;
  const parsed = CapabilityProposalSchema.safeParse(insight?.capability);
  if (provenance && insight?.capability && !parsed.success)
    throw new Error('Stored Dream proposal is invalid');
  return {
    run,
    provenance,
    proposal: parsed.success ? parsed.data : null,
    capabilityReview: run.review?.schemaVersion === 'dream-capability-review-v1'
      ? run.review as unknown as CapabilityReviewResult : null,
    assessments: dreamRunAssessments(run),
    // Captured source hashes describe the run. Reading history does not re-verify disk.
    currentSourceFreshness: 'not-rechecked' as const,
  };
}
export type DreamDetail = ReturnType<typeof projectDreamDetail>;

export async function readDreamDetail(sql: Sql, scope: { workspaceId: string; potSlug: string; runId: string }) {
  if (!scope.workspaceId.trim() || !scope.potSlug.trim() || !scope.runId.trim())
    throw new RangeError('Dream detail requires a workspace, pot and run');
  const run = await getDreamRun(sql, scope);
  return run?.potSlug === scope.potSlug ? projectDreamDetail(run) : null;
}
