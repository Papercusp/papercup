"use client";

/**
 * Client seam for one Plans clean-up run (cleanup-report-flows-2026-08-24
 * P-006). Run state is PG-canonical and arrives through the same
 * SSE-invalidated sync transport as the plan list; the URL's `?opcln=` value
 * chooses a historical/current run without moving ownership into component
 * state.
 */
import { useCallback, useMemo } from "react";
import { useSyncQuery } from "@papercusp/sync";
import type {
  BulkResolverLaunchProfile,
  EffectiveBulkResolverLaunch,
} from "@papercusp/operator-core/lib/agent-config-constants";
import { loadResolverLaunchProfile } from "../bulk-resolver/bulk-resolver-settings";

export type PlanCleanupPhase =
  | "pending"
  | "running"
  | "review"
  | "complete"
  | "failed";
export type PlanCleanupOutcome =
  | "pending"
  | "auto_applied"
  | "recommended"
  | "accepted"
  | "dismissed"
  | "skipped"
  | "failed";

export interface PlanCleanupRun {
  runId: string;
  phase: PlanCleanupPhase;
  runKind: "plan-cleanup";
  seedRefs: string[];
  totalItems: number;
  autoResolved: number;
  recommended: number;
  skipped: number;
  failed: number;
  error: string | null;
  /** Exact settings persisted at click time; empty only on legacy rows. */
  launchSnapshot?: Partial<EffectiveBulkResolverLaunch>;
  filterSnapshot?: Record<string, unknown>;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PlanCleanupFinding {
  runId: string;
  findingId: string;
  kind: string;
  planSlug: string;
  harnessSlug: string | null;
  itemId: string | null;
  target: string;
  from: string;
  to: string;
  confidence: "provable" | "recommended";
  evidence: Array<{ kind?: string; ref?: string; note?: string }>;
  position: number;
  outcome: PlanCleanupOutcome;
  error: string | null;
  decidedAt: string | null;
}

export interface PlanCleanupRunState {
  run: PlanCleanupRun | null;
  findings: PlanCleanupFinding[];
  recommendations: PlanCleanupFinding[];
  pending: PlanCleanupFinding[];
  isRunning: boolean;
  isReview: boolean;
  loading: boolean;
}

export interface PlanCleanupStartResult {
  ok: boolean;
  runId?: string;
  launched?: boolean;
  /** False means the deterministic pass finished the run without an LLM. */
  resolverNeeded?: boolean;
  deterministic?: {
    applied: number;
    skipped: number;
    failed: number;
  };
  launchError?: string;
  error?: string;
}

export interface PlanCleanupCounts {
  total: number;
  applied: number;
  forReview: number;
  skipped: number;
  failed: number;
  pending: number;
  decided: number;
  percent: number;
}

const ENDPOINT = "/api/admin/plan-cleanup";
export const PLAN_CLEANUP_RUN_PARAM = "opcln";

/** The click-time membership snapshot. Keep the pane's order, trim once, and
 * dedupe before POSTing; the route repeats these guards as the trust boundary. */
export function snapshotPlanSlugs(slugs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of slugs) {
    const slug = raw.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** Finding progress comes from finding rows, not the asynchronously refreshed
 * run counters. Before the manifest lands there are zero known findings and
 * the strip truthfully says it is scanning plans rather than inventing a
 * percentage from the plan count (one plan can yield many findings). */
export function derivePlanCleanupCounts(
  findings: readonly PlanCleanupFinding[],
): PlanCleanupCounts {
  let applied = 0;
  let forReview = 0;
  let skipped = 0;
  let failed = 0;
  let pending = 0;
  for (const finding of findings) {
    if (finding.outcome === "auto_applied" || finding.outcome === "accepted")
      applied += 1;
    else if (finding.outcome === "recommended") forReview += 1;
    else if (finding.outcome === "dismissed" || finding.outcome === "skipped")
      skipped += 1;
    else if (finding.outcome === "failed") failed += 1;
    else pending += 1;
  }
  const total = findings.length;
  const decided = applied + forReview + skipped + failed;
  return {
    total,
    applied,
    forReview,
    skipped,
    failed,
    pending,
    decided,
    percent: total > 0 ? Math.min(100, Math.round((decided / total) * 100)) : 0,
  };
}

async function postOp(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = json.error as { message?: string } | undefined;
    throw new Error(
      err?.message ??
        `plan clean-up ${String(body.op ?? "start")} failed (${res.status})`,
    );
  }
  return json;
}

export function usePlanCleanupRun(
  runId?: string | null,
  opts?: { enabled?: boolean },
): PlanCleanupRunState {
  const enabled = opts?.enabled !== false;
  const { data, loading } = useSyncQuery<{
    run: PlanCleanupRun | null;
    findings: PlanCleanupFinding[];
  }>({
    queryName: "plans.cleanupRun",
    args: runId ? { runId } : {},
    enabled,
  });

  const row = Array.isArray(data)
    ? data[0]
    : (data as
        | { run?: PlanCleanupRun | null; findings?: PlanCleanupFinding[] }
        | undefined);
  const run = row?.run ?? null;
  const findings = useMemo(() => row?.findings ?? [], [row]);

  return useMemo(
    () => ({
      run,
      findings,
      recommendations: findings.filter(
        (finding) => finding.outcome === "recommended",
      ),
      pending: findings.filter((finding) => finding.outcome === "pending"),
      isRunning: run?.phase === "pending" || run?.phase === "running",
      isReview: run?.phase === "review",
      loading: Boolean(loading),
    }),
    [run, findings, loading],
  );
}

export function usePlanCleanupOps(): {
  start: (
    planSlugs: readonly string[],
    filter: Record<string, unknown>,
    harness?: string | null,
    launch?: BulkResolverLaunchProfile,
  ) => Promise<PlanCleanupStartResult>;
  stop: (runId: string) => Promise<void>;
  dismiss: (runId: string) => Promise<void>;
  accept: (
    runId: string,
    findingId: string,
    note?: string | null,
  ) => Promise<{ ok: boolean; phase?: PlanCleanupPhase | null; error?: string }>;
} {
  const start = useCallback(
    async (
      rawPlanSlugs: readonly string[],
      filter: Record<string, unknown>,
      harness?: string | null,
      launch?: BulkResolverLaunchProfile,
    ): Promise<PlanCleanupStartResult> => {
      const planSlugs = snapshotPlanSlugs(rawPlanSlugs);
      try {
        const clickTimeLaunch = launch ?? await loadResolverLaunchProfile("plan-cleanup");
        const json = await postOp({
          op: "start",
          planSlugs,
          filter,
          launch: clickTimeLaunch,
          ...(harness ? { harness } : {}),
        });
        return {
          ok: true,
          runId: typeof json.runId === "string" ? json.runId : undefined,
          launched: json.launched === true,
          resolverNeeded:
            typeof json.resolverNeeded === "boolean"
              ? json.resolverNeeded
              : undefined,
          deterministic:
            json.deterministic && typeof json.deterministic === "object"
              ? {
                  applied: Number(
                    (json.deterministic as Record<string, unknown>).applied ?? 0,
                  ),
                  skipped: Number(
                    (json.deterministic as Record<string, unknown>).skipped ?? 0,
                  ),
                  failed: Number(
                    (json.deterministic as Record<string, unknown>).failed ?? 0,
                  ),
                }
              : undefined,
          launchError:
            typeof json.launchError === "string" ? json.launchError : undefined,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [],
  );

  const stop = useCallback(async (runId: string) => {
    await postOp({ op: "stop", runId });
  }, []);

  const dismiss = useCallback(async (runId: string) => {
    await postOp({ op: "dismiss", runId });
  }, []);

  const accept = useCallback(
    async (runId: string, findingId: string, note?: string | null) => {
      try {
        const result = await postOp({ op: "accept", runId, findingId, note: note ?? null });
        const phase =
          typeof result.phase === "string"
            ? (result.phase as PlanCleanupPhase)
            : result.phase === null
              ? null
              : undefined;
        return { ok: true, phase };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [],
  );

  return { start, stop, dismiss, accept };
}
