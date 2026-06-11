/**
 * Zero-free named-query dispatcher — papercusp-dogfood-v5 P-022.
 *
 * Replaces the @rocicorp/zero-coupled resolver at apps/operator/lib/
 * zero-harness-resolver.ts incrementally. The legacy resolver looks
 * each name up in `@papercusp/zero-harness`'s registry, compiles a ZQL
 * expression to SQL via `zeroPostgresJS`, runs it. This module does
 * the same thing the dumb way: a switch-on-name table where each
 * entry runs hand-written SQL (or calls into an existing data-access
 * helper) and returns a flat row array.
 *
 * Migration strategy:
 *
 *   1. Each query name moves here one-at-a-time, in a separate
 *      commit. Adding an entry is purely additive — until callers
 *      switch to call `resolveNamedQueryV2`, the legacy resolver
 *      still serves the query.
 *
 *   2. Once all 51 live queryNames (audit run 2026-05-24) are
 *      represented here, the route handlers at
 *      apps/operator/lib/endpoint-route/routes/zero-harness/
 *      rest-query{,-batch}.ts switch from `resolveNamedQuery`
 *      to `resolveNamedQueryV2`. After verification, the legacy
 *      resolver + the @rocicorp/zero dep go.
 *
 *   3. The 1107-line @papercusp/zero-harness queries.ts stays as a
 *      structural reference (table → fields map is still useful)
 *      until P-067 — at which point both go together.
 *
 * Why hand-written instead of generic SQL compilation: we tried the
 * generic path with Zero; it works, but it pins us to the @rocicorp/zero
 * dep. The hand-written approach is ~30 LOC per query, totals ~1500
 * LOC for all 51 — equivalent in size to the queries.ts it replaces
 * minus the Zero runtime. Each entry is verifiable in isolation; no
 * runtime compilation, no Zero-specific schema duplication.
 *
 * Args validation: each registry entry brings its own zod schema (or
 * inline check). Names that take no args (e.g. some `*.recent` queries)
 * pass `args: {}`.
 *
 * Return shape: flat row array. Matches the contract `resolveNamedQuery`
 * already exposes. Some entries unwrap `{rows: [...]}` envelopes from
 * the underlying data helpers (e.g. listToasts → {toasts}); the unwrap
 * happens here so callers don't notice.
 */

import { z } from 'zod';
import { createResolver, type QueryRegistry } from '@papercusp/sync/server';

// ─── Registry types ─────────────────────────────────────────────────

export interface QueryEntry<TArgs = unknown> {
  /** Optional zod schema for arg validation. Omitted entries accept any. */
  argsSchema?: z.ZodSchema<TArgs>;
  /** Resolver: takes validated args, returns flat row array. */
  resolve: (args: TArgs) => Promise<unknown[]>;
}

// Dispatch + NAME_NOT_FOUND now come from the shared lib
// (@papercusp/sync/server). Re-exported so existing importers of
// `@/lib/sync-resolver` (the rest-query routes, tests) are unchanged.
export { NAME_NOT_FOUND, type NameNotFound } from '@papercusp/sync/server';

// ─── Migrated queries ───────────────────────────────────────────────
//
// Each entry below corresponds to one of the 51 live queryNames
// audited 2026-05-24. As each lands, the corresponding ZQL entry in
// libs/zero-harness/src/queries.ts becomes dead code (to be deleted
// at the P-022 cutover).

/**
 * Shared resolve for the `agentRunsConsolidated.*` queries
 * (adv-harness-tab-migration P-023): the run feed is the FULL OUTER union of
 * the two run stores, in the consolidated row shape —
 *
 *   - `agent_runs_consolidated` — the LEGACY store (its writer, the
 *     orchestrator run-loop, was retired 2026-06-06; rows stop 2026-06-02).
 *     Carries cost/token telemetry the spawn engine doesn't.
 *   - `spawned_agents` — the LIVE spawn engine's records. Carries the
 *     OUTCOME (`spawnStatus` running|done|failed|cancelled|reaped,
 *     `exitCode`, `errorMessage`) and the native resume `sessionId`
 *     (migration 203).
 *
 * Without the union, every post-cutover run is invisible to the Harnesses
 * tab (Recent activity / Agents panel / HealthBadge all read these names).
 * Rows present in both stores merge: telemetry from the consolidated row,
 * outcome/liveness from the spawn (the live authority).
 *
 * A run_id can map to more than one spawned_agents row (observed live:
 * restarted spawns), so the spawn side picks the LATEST row per
 * (harness_slug, run_id) via DISTINCT ON ordered by started_at DESC.
 *
 * Raw `sql` projections are cast ::float8 — drizzle's bigint→number column
 * mapping doesn't apply to sql`` columns, and the driver would otherwise
 * return bigints as strings.
 */
async function resolveRunsWithOutcome(harnessSlug: string, limit?: number): Promise<unknown[]> {
  const { getOrgPg, generated } = await import('@papercusp/db-org');
  const { and, desc, eq, sql } = await import('drizzle-orm');
  const t = generated.agentRunsConsolidatedInHarnessShared;
  const s = generated.spawnedAgentsInHarnessShared;
  const { db } = getOrgPg();
  const spawn = db
    .selectDistinctOn([s.harnessSlug, s.runId], {
      harnessSlug: s.harnessSlug,
      runId: s.runId,
      childRole: s.childRole,
      featureId: s.featureId,
      startedAt: s.startedAt,
      heartbeatAt: s.heartbeatAt,
      durationMs: s.durationMs,
      spawnStatus: s.status,
      exitCode: s.exitCode,
      errorMessage: s.errorMessage,
      sessionId: s.sessionId,
    })
    .from(s)
    .where(eq(s.harnessSlug, harnessSlug))
    .orderBy(s.harnessSlug, s.runId, desc(s.startedAt))
    .as('spawn');

  const startedMs = sql`(extract(epoch from ${spawn.startedAt}) * 1000)::bigint`;
  const heartbeatMs = sql`(extract(epoch from ${spawn.heartbeatAt}) * 1000)::bigint`;
  const tsExpr = sql<number>`(coalesce(${t.ts}, ${startedMs}))::float8`;

  const q = db
    .select({
      harnessSlug: sql<string>`coalesce(${t.harnessSlug}, ${spawn.harnessSlug})`.as('harnessSlug'),
      runId: sql<string>`coalesce(${t.runId}, ${spawn.runId})`.as('runId'),
      role: sql<string>`coalesce(${t.role}, ${spawn.childRole})`.as('role'),
      featureId: sql<string | null>`coalesce(${t.featureId}, ${spawn.featureId})`.as('featureId'),
      ts: tsExpr.as('ts'),
      sizeBytes: sql<number>`(coalesce(${t.sizeBytes}, 0))::float8`.as('sizeBytes'),
      durationMs: sql<number>`(coalesce(${t.durationMs}, ${spawn.durationMs}, 0))::float8`.as('durationMs'),
      costUsd: t.costUsd,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      // Liveness: the spawn engine is the authority when a spawn row exists
      // (a finished spawn beats a stale consolidated running=true).
      running: sql<boolean>`case
        when ${spawn.runId} is not null then ${spawn.spawnStatus} in ('running', 'restarting')
        else coalesce(${t.running}, false)
      end`.as('running'),
      lastEventTs: sql<number | null>`(coalesce(${heartbeatMs}, ${t.lastEventTs}))::float8`.as('lastEventTs'),
      createdTs: sql<number>`(coalesce(${t.createdTs}, ${startedMs}))::float8`.as('createdTs'),
      updatedTs: sql<number>`(coalesce(${t.updatedTs}, ${heartbeatMs}))::float8`.as('updatedTs'),
      backend: t.backend,
      model: t.model,
      costIsEstimate: t.costIsEstimate,
      spawnStatus: spawn.spawnStatus,
      exitCode: spawn.exitCode,
      errorMessage: spawn.errorMessage,
      sessionId: spawn.sessionId,
    })
    .from(t)
    .fullJoin(spawn, and(eq(spawn.harnessSlug, t.harnessSlug), eq(spawn.runId, t.runId)))
    .where(sql`coalesce(${t.harnessSlug}, ${spawn.harnessSlug}) = ${harnessSlug}`)
    .orderBy(desc(tsExpr));
  return (limit != null ? await q.limit(limit) : await q) as unknown[];
}

const REGISTRY: Record<string, QueryEntry<unknown>> = {
  // toastLog.recent — first migration. Mirrors the original ZQL:
  //   zql.toastLog.orderBy('createdAt', 'desc').limit(limit)
  // The flat-row return matches what useSyncQuery's SSEAdapter
  // expects in `data`.
  'toastLog.recent': {
    argsSchema: z.object({
      limit: z.number().int().positive().max(500).default(50),
    }),
    resolve: async (args) => {
      const { listToasts } = await import('../toast-log-data');
      const { limit } = args as { limit: number };
      const { toasts } = await listToasts({ limit });
      return toasts;
    },
  },

  // ── Batch 2: drizzle-backed simple selects (audit/scan/state) ────────
  //
  // Each entry queries the canonical drizzle-typed table and emits
  // camelCase rows. Mirrors the ZQL `where`/`orderBy`/`limit` chain
  // shape — drizzle's column map handles the snake_case → camelCase
  // conversion, matching what the legacy Zero resolver produced.

  // auditLog.operatorDecisions — workspace+actor-filtered audit log.
  //   zql.auditLog.where(workspaceId).where(actor='system:operator')
  //              .orderBy('ts', 'desc').limit(limit)
  'auditLog.operatorDecisions': {
    argsSchema: z.object({
      workspaceId: z.string(),
      limit: z.number().int().positive().max(500).default(20),
    }),
    resolve: async (args) => {
      const { workspaceId, limit } = args as { workspaceId: string; limit: number };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.auditLogInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.actor, 'system:operator')))
        .orderBy(desc(t.ts))
        .limit(limit)) as unknown[];
    },
  },

  // operatorBudget.byWorkspace — single-row-per-workspace budget state.
  //   zql.operatorBudget.where(workspaceId).limit(1)
  // Per the ZQL comment: limit(1) instead of .one() — feedback_zero_one_shape_mismatch.
  'operatorBudget.byWorkspace': {
    argsSchema: z.object({ workspaceId: z.string() }),
    resolve: async (args) => {
      const { workspaceId } = args as { workspaceId: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { eq } = await import('drizzle-orm');
      const t = generated.operatorBudgetInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.workspaceId, workspaceId))
        .limit(1)) as unknown[];
    },
  },

  // ── Batch 3: harnessXxx.byHarness family ─────────────────────────────
  //
  // All five follow the same pattern: filter by harness_slug, optional
  // orderBy on a per-table column. The original ZQL chain is mechanical;
  // each entry is ~15 LOC.

  // harnessTextArtifact.byHarness — text artifacts ordered by relative path.
  //   zql.harnessTextArtifacts.where('harnessSlug', s).orderBy('relPath', 'asc')
  // harnessProjects.lite — the workspace's harness registry list (the
  // /api/harness/projects/lite payload's `projects` rows; clients regroup
  // hives via the shared groupByHive). Invalidated from the registry write
  // seam in harness-registry.ts, so creates/deletes/renames from ANY
  // operator process live-update open lists (EI-206). Workspace scoping
  // rides the request's x-papercusp-workspace ALS, same as the route.
  'harnessProjects.lite': {
    resolve: async () => {
      const { buildProjectsLitePayload } = await import('../harness/projects-lite');
      // Bypass the 1s TTL cache: an invalidation-triggered refetch must not
      // serve a payload built just BEFORE the write it's reacting to.
      const payload = await buildProjectsLitePayload({ bypassCache: true });
      return payload.projects as unknown[];
    },
  },

  // hiveFromRepo.progress — REAL step transitions for the long create-from-URL
  // (hive-from-repo-hardening P-008). The composition records to the in-process
  // store + invalidates this name per step; the form subscribes with its
  // client-minted progressId BEFORE submitting. Transient UX rows, not state.
  'hiveFromRepo.progress': {
    argsSchema: z.object({ progressId: z.string().min(1).max(64) }),
    resolve: async (args) => {
      const { progressId } = args as { progressId: string };
      const { getFromRepoProgress } = await import('../harness/from-repo-progress');
      return getFromRepoProgress(progressId) as unknown[];
    },
  },

  'harnessTextArtifact.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessTextArtifactsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.relPath))) as unknown[];
    },
  },

  // harnessProjectFiles.byHarness — single-row-per-harness (SPEC.md etc bundle).
  //   zql.harnessProjectFiles.where('harnessSlug', s)  (no order)
  'harnessProjectFiles.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { eq } = await import('drizzle-orm');
      const t = generated.harnessProjectFilesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))) as unknown[];
    },
  },

  // harnessSkills.byHarness — skills sorted by name.
  //   zql.harnessSkills.where('harnessSlug', s).orderBy('name', 'asc')
  'harnessSkills.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessSkillsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.name))) as unknown[];
    },
  },

  // harnessDecisions.byHarness — decisions in chronological order.
  //   zql.harnessDecisions.where('harnessSlug', s).orderBy('ts', 'asc')
  'harnessDecisions.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessDecisionsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.ts))) as unknown[];
    },
  },

  // ── Batch 4: lanes / escalations / checkpoints / git-log / feature PRs ─
  //
  // Each filter pattern slightly different; otherwise mechanical.

  // harnessLanes.byHarness — lanes filtered by harness+workspace+phase.
  //   zql.harnessLanes.where(harnessSlug).where(workspaceId).where(phase)
  //                   .orderBy('role', 'asc')
  'harnessLanes.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessLanesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.harnessSlug, harnessSlug),
            eq(t.workspaceId, workspaceId),
            eq(t.phase, phase),
          ),
        )
        .orderBy(asc(t.role))) as unknown[];
    },
  },

  // harnessEscalations.byHarness — single escalation row per phase.
  //   zql.harnessEscalations.where(harnessSlug).where(phase).limit(1)
  'harnessEscalations.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase } = args as { harnessSlug: string; phase: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessEscalationsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)))
        .limit(1)) as unknown[];
    },
  },

  // harnessCheckpoints.byHarness — checkpoints ordered by waiting time.
  //   zql.harnessCheckpoints.where(harnessSlug).orderBy('waitingSinceMs', 'asc')
  'harnessCheckpoints.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessCheckpointsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.waitingSinceMs))) as unknown[];
    },
  },

  // harnessGitLog.byHarness — commit log ordered by ts desc, capped.
  //   zql.harnessGitLog.where(harnessSlug).orderBy('ts', 'desc').limit(limit)
  'harnessGitLog.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      limit: z.number().int().positive().max(2000).default(300),
    }),
    resolve: async (args) => {
      const { harnessSlug, limit } = args as { harnessSlug: string; limit: number };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessGitLogInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(desc(t.ts))
        .limit(limit)) as unknown[];
    },
  },

  // featurePrs.byHarness — feature PRs ordered by feature id.
  //   zql.harnessFeaturePrs.where(harnessSlug).orderBy('featureId', 'asc')
  'featurePrs.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturePrsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.featureId))) as unknown[];
    },
  },

  // ── Batch 5: status / tests / archives / hook-logs / health ─────────

  // harnessStatus.byHarness — single status row per (harness, workspace, phase).
  //   zql.harnessStatus.where(harnessSlug).where(workspaceId).where(phase).limit(1)
  'harnessStatus.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessStatusInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.harnessSlug, harnessSlug),
            eq(t.workspaceId, workspaceId),
            eq(t.phase, phase),
          ),
        )
        .limit(1)) as unknown[];
    },
  },

  // harnessTests.byHarness — tests filtered by harness+phase, by name.
  //   zql.harnessTests.where(harnessSlug).where(phase).orderBy('name', 'asc')
  'harnessTests.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase } = args as { harnessSlug: string; phase: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessTestsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)))
        .orderBy(asc(t.name))) as unknown[];
    },
  },

  // harnessArchives.byHarness — archives by harness+phase, latest first.
  //   zql.harnessArchives.where(harnessSlug).where(phase).orderBy('ts', 'desc')
  'harnessArchives.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase } = args as { harnessSlug: string; phase: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessArchivesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)))
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessHookLogs.byHarness — most-recent 50 hook events per harness.
  //   zql.harnessHookLogs.where(harnessSlug).orderBy('ts', 'desc').limit(50)
  'harnessHookLogs.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessHookLogsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(desc(t.ts))
        .limit(50)) as unknown[];
    },
  },

  // ── Batch 6: summary / phases / smoke-test / plan-review / brainstorm ─

  // summary.byHarness — single summary row per (harness, workspace, phase).
  //   zql.harnessSummaries.where(harnessSlug).where(workspaceId).where(phase).limit(1)
  // ZQL comment explains why .limit(1) instead of .one() — replication
  // returns undefined from useQuery; array works around the empty-state bug.
  'summary.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessSummariesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.harnessSlug, harnessSlug),
            eq(t.workspaceId, workspaceId),
            eq(t.phase, phase),
          ),
        )
        .limit(1)) as unknown[];
    },
  },

  // harnessPhases.byHarness — phases ordered by phase column asc.
  //   zql.harnessPhases.where(harnessSlug).orderBy('phase', 'asc')
  'harnessPhases.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessPhasesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.phase))) as unknown[];
    },
  },

  // harnessSmokeTest.byHarness — single smoke-test row per harness.
  //   zql.harnessSmokeTest.where(harnessSlug).limit(1)
  'harnessSmokeTest.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { eq } = await import('drizzle-orm');
      const t = generated.harnessSmokeTestInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .limit(1)) as unknown[];
    },
  },

  // harnessPlanReview.byHarness — single plan-review row per harness.
  //   zql.harnessPlanReview.where(harnessSlug).limit(1)
  'harnessPlanReview.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { eq } = await import('drizzle-orm');
      const t = generated.harnessPlanReviewInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .limit(1)) as unknown[];
    },
  },

  // harnessBrainstorm.byHarness — brainstorm rows ordered by phase asc.
  //   zql.harnessBrainstorm.where(harnessSlug).orderBy('phase', 'asc')
  'harnessBrainstorm.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessBrainstormInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.phase))) as unknown[];
    },
  },

  // ── Batch 7: pending-reviews / pending-issues / screenshots / branchActions / agent-chats ─

  // pendingReviews.byHarness — harness+workspace+phase; optional resolved filter.
  //   zql.pendingReviews.where(harnessSlug).where(workspaceId).where(phase)
  //                     [.where('resolved', false)]  // when !includeResolved
  //                     .orderBy('ts', 'desc')
  'pendingReviews.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
      includeResolved: z.boolean().default(false),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase, includeResolved } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
        includeResolved: boolean;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.pendingReviewsInHarnessShared;
      const { db } = getOrgPg();
      const baseConds = [
        eq(t.harnessSlug, harnessSlug),
        eq(t.workspaceId, workspaceId),
        eq(t.phase, phase),
      ];
      const conds = includeResolved ? baseConds : [...baseConds, eq(t.resolved, false)];
      return (await db
        .select()
        .from(t)
        .where(and(...conds))
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessPendingIssues.byHarness — harness+phase, newest first.
  //   zql.harnessPendingIssues.where(harnessSlug).where(phase).orderBy('ts', 'desc')
  'harnessPendingIssues.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase } = args as { harnessSlug: string; phase: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessPendingIssuesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)))
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessScreenshots.byHarness — harness+phase, newest first.
  //   zql.harnessScreenshots.where(harnessSlug).where(phase).orderBy('ts', 'desc')
  'harnessScreenshots.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase } = args as { harnessSlug: string; phase: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessScreenshotsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)))
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessBranchActions.byHarnessAndBranch — single row per (harness, branch).
  //   zql.harnessBranchActions.where(harnessSlug).where(branch).limit(1)
  'harnessBranchActions.byHarnessAndBranch': {
    argsSchema: z.object({ harnessSlug: z.string(), branch: z.string() }),
    resolve: async (args) => {
      const { harnessSlug, branch } = args as { harnessSlug: string; branch: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessBranchActionsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.branch, branch)))
        .limit(1)) as unknown[];
    },
  },

  // agentChats.byHarness — chats ordered by updatedAt desc, capped.
  //   zql.agentChatsConsolidated.where(harnessSlug).orderBy('updatedAt', 'desc').limit(limit)
  'agentChats.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      limit: z.number().int().positive().max(500).default(50),
    }),
    resolve: async (args) => {
      const { harnessSlug, limit } = args as { harnessSlug: string; limit: number };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.agentChatsConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(desc(t.updatedAt))
        .limit(limit)) as unknown[];
    },
  },

  // ── Batch 8: featureNotes / featureDebugNotes / featureAudit / chunkPlans / delegates ─

  // featureNotes.byHarness — feature notes ordered by featureId asc.
  //   zql.harnessFeatureNotes.where(harnessSlug).orderBy('featureId', 'asc')
  'featureNotes.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeatureNotesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.featureId))) as unknown[];
    },
  },

  // featureDebugNotes.byHarness — debug notes ordered by featureId asc.
  //   zql.harnessFeatureDebugNotes.where(harnessSlug).orderBy('featureId', 'asc')
  'featureDebugNotes.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeatureDebugNotesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.featureId))) as unknown[];
    },
  },

  // featureAudit.byHarness — feature audit log, newest first, cap 2000.
  //   zql.featureAuditConsolidated.where(harnessSlug).orderBy('ts', 'desc').limit(2000)
  'featureAudit.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.featureAuditConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(desc(t.ts))
        .limit(2000)) as unknown[];
    },
  },

  // chunkPlans.byHarness — all chunk plans for a harness, ordered.
  //   zql.harnessChunkPlans.where(harnessSlug)
  //                        .orderBy('featureId', 'asc').orderBy('chunkIndex', 'asc')
  'chunkPlans.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { asc, eq } = await import('drizzle-orm');
      const t = generated.harnessChunkPlansInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(asc(t.featureId), asc(t.chunkIndex))) as unknown[];
    },
  },

  // chunkPlans.byFeature — chunk plans filtered by harness+feature.
  //   zql.harnessChunkPlans.where(harnessSlug).where(featureId)
  //                        .orderBy('chunkIndex', 'asc')
  'chunkPlans.byFeature': {
    argsSchema: z.object({ harnessSlug: z.string(), featureId: z.string() }),
    resolve: async (args) => {
      const { harnessSlug, featureId } = args as { harnessSlug: string; featureId: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessChunkPlansInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.featureId, featureId)))
        .orderBy(asc(t.chunkIndex))) as unknown[];
    },
  },

  // (delegates.byWorkspace removed — collapse-delegate-into-workitems-2026-06-04:
  //  a delegate IS a work_item now; the operator panel reads delegated tasks via
  //  GET /api/agent-mcp/delegates, backed by delegated-tasks over work_items.)

  // ── Batch 9: plugins / projectSpec / org_* (first 2) ──────────────────

  // pluginConfigs.byHarness — plugin configs scoped to (harness, workspace).
  //   zql.pluginConfigs.where(harnessSlug).where(workspaceId)
  'pluginConfigs.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as {
        harnessSlug: string;
        workspaceId: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.pluginConfigsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId)))) as unknown[];
    },
  },

  // pluginEnables.byWorkspace — plugin-enable rows for a workspace.
  //   zql.pluginEnables.where(workspaceId).orderBy('updatedAt', 'desc')
  'pluginEnables.byWorkspace': {
    argsSchema: z.object({ workspaceId: z.string() }),
    resolve: async (args) => {
      const { workspaceId } = args as { workspaceId: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.pluginEnablesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.workspaceId, workspaceId))
        .orderBy(desc(t.updatedAt))) as unknown[];
    },
  },

  // projectSpecRevisions.byProject — spec revisions for one project, newest first.
  //   zql.projectSpecRevisions.where(projectId).orderBy('ts', 'desc').limit(limit)
  'projectSpecRevisions.byProject': {
    argsSchema: z.object({
      projectId: z.string(),
      limit: z.number().int().positive().max(200).default(50),
    }),
    resolve: async (args) => {
      const { projectId, limit } = args as { projectId: string; limit: number };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.projectSpecRevisionsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.projectId, projectId))
        .orderBy(desc(t.ts))
        .limit(limit)) as unknown[];
    },
  },

  // proposalsShared.byHarness — proposals filtered by (harness, workspace, phase).
  //   zql.harnessProposalsShared.where(harnessSlug).where(workspaceId).where(phase)
  //                             .orderBy('ts', 'desc')
  'proposalsShared.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId: string;
        phase: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessProposalsSharedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.harnessSlug, harnessSlug),
            eq(t.workspaceId, workspaceId),
            eq(t.phase, phase),
          ),
        )
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // ── Batch 11 (final): the four *Consolidated cross-harness queries ──
  //
  // Each ZQL `featuresConsolidated` etc. maps to drizzle's
  // `harnessFeaturesConsolidatedInHarnessShared` (the table is
  // `harness_features_consolidated` etc — the prefix mismatch is
  // historical, drizzle's canonical name wins).

  // workItems.byHarness — the UNIFIED work-items read (feature + issue families,
  // enriched route-side with plan-link + spine-position) serving WorkItemsPanel's
  // live path (blueprint-aware-harness-ui-2026-06-09 P-010 polish). Reuses the
  // route's exported assembly so this sync read and
  // GET /api/harness/:slug/work-items return identical rows. Invalidated via the
  // table bridge from harness_features_consolidated + engineer_issues (migration
  // 215) + spawned_agents (outcome flips re-fire the spine-position column).
  'workItems.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      kind: z.string().optional(),
      state: z.string().optional(),
      limit: z.number().int().positive().max(500).default(300),
    }),
    resolve: async (args) => {
      const { harnessSlug, kind, state, limit } = args as {
        harnessSlug: string;
        kind?: string;
        state?: string;
        limit: number;
      };
      const [{ listEnrichedWorkItems }, { isWorkItemKind }] = await Promise.all([
        import('../endpoint-route/routes/harness/work-items'),
        import('../work-items'),
      ]);
      return (await listEnrichedWorkItems({
        harness: harnessSlug,
        kind: kind && isWorkItemKind(kind) ? kind : undefined,
        state,
        limit,
      })) as unknown[];
    },
  },

  // fleetAssignments.byHarness — "who's working here?" for the Progress tab's
  // Agents panel (progress-tab-agents-convergence-2026-06-11 P-001/P-002): the
  // fleet:assignments assembly (presence + plan-item claims + work-item claims,
  // claim-primary, with each agent's ordered work-list) filtered to one harness,
  // each agent stamped with its AgentPaneKind so the desktop shares the colony
  // tab's glyph vocabulary (♛/🐝/🛡/📋/🛠). Role context joins from adv_sessions
  // (queen/sentinel/planner kinds are role-keyed; su falls out of the ownerId
  // prefix). Invalidated via the table bridge from coord_presence /
  // feature_claims / claim_audit / spawned_agents.
  'fleetAssignments.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const [{ listFleetAssignments, groupByAgent }, { listAdvSessions }, { classifyAgentPane }] =
        await Promise.all([
          import('../fleet/assignments'),
          import('../adv-sessions'),
          import('@papercusp/agent-mcp'),
        ]);
      const rows = await listFleetAssignments({ harness: harnessSlug });
      const roleByOwner = new Map<string, string | null>();
      try {
        for (const s of await listAdvSessions(200)) {
          if (s.coordOwnerId && !roleByOwner.has(s.coordOwnerId)) {
            roleByOwner.set(s.coordOwnerId, s.role ?? null);
          }
        }
      } catch {
        /* role enrichment is best-effort — ownerId-only classification still works */
      }
      return groupByAgent(rows).map((a) => {
        const pane = classifyAgentPane({
          role: roleByOwner.get(a.agentId) ?? null,
          ownerId: a.agentId,
        });
        return { ...a, agentPaneKind: pane.kind, driveMode: pane.driveMode } as unknown;
      });
    },
  },

  // featuresConsolidated.bySlug — features for a harness, latest first.
  //   zql.featuresConsolidated.where(harnessSlug).orderBy('updatedTs', 'desc')
  'featuresConsolidated.bySlug': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(desc(t.updatedTs))) as unknown[];
    },
  },

  // featuresConsolidated.byPlanSlug — features promoted from a specific plan,
  // across all harnesses, ordered by created_ts desc. Uses the first-class
  // source_plan_slug column added in migration 084 (indexed; fast).
  'featuresConsolidated.byPlanSlug': {
    argsSchema: z.object({ planSlug: z.string() }),
    resolve: async (args) => {
      const { planSlug } = args as { planSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select({
          featureId: t.featureId,
          harnessSlug: t.harnessSlug,
          title: t.title,
          status: t.status,
        })
        .from(t)
        .where(eq(t.sourcePlanSlug, planSlug))
        .orderBy(desc(t.createdTs))) as unknown[];
    },
  },

  // issuesConsolidated.bySlug — issues for a harness, latest first.
  //   zql.issuesConsolidated.where(harnessSlug).orderBy('updatedTs', 'desc')
  'issuesConsolidated.bySlug': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessIssuesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(desc(t.updatedTs))) as unknown[];
    },
  },

  // agentRunsConsolidated.bySlug — agent runs for a harness, latest first.
  //   zql.agentRunsConsolidated.where(harnessSlug).orderBy('ts', 'desc')
  // Each row carries the run's OUTCOME + native resume session id joined from
  // spawned_agents (adv-harness-tab-migration P-023): spawnStatus / exitCode /
  // errorMessage / sessionId, null for pre-spawn-engine rows.
  'agentRunsConsolidated.bySlug': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      return resolveRunsWithOutcome(harnessSlug);
    },
  },

  // agentRunsConsolidated.recent — agent runs for a harness, latest 50.
  //   zql.agentRunsConsolidated.where(harnessSlug).orderBy('ts', 'desc').limit(50)
  // Same joined outcome projection as .bySlug (P-023).
  'agentRunsConsolidated.recent': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      return resolveRunsWithOutcome(harnessSlug, 50);
    },
  },

  // snapshotsConsolidated.bySlug — snapshots for a harness, latest first.
  //   zql.snapshotsConsolidated.where(harnessSlug).orderBy('ts', 'desc')
  'snapshotsConsolidated.bySlug': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessSnapshotsConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // userActions.byHarness — harness+workspace-filtered action log.
  //   zql.userActions.where(harnessSlug).where(workspaceId)
  //                  .orderBy('startedAt', 'desc').limit(limit)
  'userActions.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      limit: z.number().int().positive().max(500).default(50),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, limit } = args as {
        harnessSlug: string;
        workspaceId: string;
        limit: number;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.userActionsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId)))
        .orderBy(desc(t.startedAt))
        .limit(limit)) as unknown[];
    },
  },

  // userActions.byKind — harness+workspace+kind-filtered action log.
  //   zql.userActions.where(harnessSlug).where(workspaceId).where(kind)
  //                  .orderBy('startedAt', 'desc').limit(limit)
  'userActions.byKind': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string(),
      kind: z.string(),
      limit: z.number().int().positive().max(500).default(50),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, kind, limit } = args as {
        harnessSlug: string;
        workspaceId: string;
        kind: string;
        limit: number;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.userActionsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.harnessSlug, harnessSlug),
            eq(t.workspaceId, workspaceId),
            eq(t.kind, kind),
          ),
        )
        .orderBy(desc(t.startedAt))
        .limit(limit)) as unknown[];
    },
  },

  // userMemory.list — the settings memory page's row set: the user's
  // personal pool + every harness pool, enriched with canonical audit
  // state + timestamps, newest-first (memory-settings-page-refresh P-007).
  // userId arrives as an arg because resolvers carry no session identity
  // (D-002 — acceptable in the single-owner desktop model). Writes fire
  // notifySyncInvalidate('userMemory.list') from the REST routes AND the
  // memory:* MCP verbs, so the page updates live on agent writes.
  'userMemory.list': {
    argsSchema: z.object({ userId: z.string().min(1) }),
    resolve: async (args) => {
      const { userId } = args as { userId: string };
      const { listUserMemories } = await import('../memory/list-user-memories');
      return (await listUserMemories(userId)) as unknown[];
    },
  },

  // plansDrafts.bySlug — draft plans for a harness, newest-first.
  // Used by ProposalsPanel (plan-feature-pipeline-unification P-022).
  // Reads from PG (plans went PG-canonical — plans-pg-canonical-migration-2026-06-03)
  // via readAllPlans. Returns a lightweight row per draft plan — UI uses these to
  // render proposal cards; clicking Edit navigates to /admin/plans/<slug>.
  'plansDrafts.bySlug': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { resolveHarnessPlansDir, readAllPlans } = await import(
        '../agent-tools/plans/source'
      );

      const dirs = await resolveHarnessPlansDir(harnessSlug);
      const all = await readAllPlans({ harnessSlug: dirs.harnessSlug, workspaceId: dirs.workspaceId });

      const rows: unknown[] = [];
      for (const { parsed, archived } of all) {
        if (archived) continue;
        if (parsed.isLegacy) continue;
        if (parsed.frontmatter.status !== 'draft') continue;

        const slug = parsed.frontmatter.slug ?? parsed.slug;
        const itemCount = parsed.items.length;
        // Source tag: slug prefixed with 'scoper-proposal-' → 'scoper'; else 'user'.
        const source = slug.startsWith('scoper-proposal-') ? 'scoper' : 'user';

        rows.push({
          slug,
          title: parsed.frontmatter.title ?? slug,
          status: 'draft' as const,
          nowState: parsed.now?.state ?? null,
          nowNext: parsed.now?.next ?? null,
          itemCount,
          source,
          created: parsed.frontmatter.created ?? null,
          updated: parsed.frontmatter.updated ?? null,
        });
      }

      // Newest-first by updated, then created.
      rows.sort((a, b) => {
        const ra = a as { updated: string | null; created: string | null };
        const rb = b as { updated: string | null; created: string | null };
        const ta = ra.updated ?? ra.created ?? '';
        const tb = rb.updated ?? rb.created ?? '';
        return tb.localeCompare(ta);
      });

      return rows;
    },
  },

  // ── plans.* — live queries for the Create tab (?tab=plans). ──────────
  //
  // File-backed reads dispatched through the canonical plans:* tools
  // (read-dispatch.ts), so the live-query path can't drift from the admin
  // REST path. Write-side invalidations fire from
  // apps/operator/lib/endpoint-route/routes/admin/plans.ts (coarse, no
  // args — the Create tab fans these across many filter args). No
  // argsSchema: the underlying tool validates its own args.
  //
  // Single-object reads (get/lint) return a 1-element array to fit the
  // useSyncQuery `data: T[]` contract; the client unwraps `data[0]`.
  'plans.list': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('list', (args ?? {}) as Record<string, unknown>)) as {
        plans?: unknown[];
      };
      return Array.isArray(r?.plans) ? r.plans : [];
    },
  },
  'plans.items': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('items', (args ?? {}) as Record<string, unknown>)) as {
        items?: unknown[];
      };
      return Array.isArray(r?.items) ? r.items : [];
    },
  },
  'plans.attention': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('attention', (args ?? {}) as Record<string, unknown>)) as {
        groups?: unknown[];
      };
      return Array.isArray(r?.groups) ? r.groups : [];
    },
  },
  'plans.search': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('search', (args ?? {}) as Record<string, unknown>)) as {
        hits?: unknown[];
      };
      return Array.isArray(r?.hits) ? r.hits : [];
    },
  },
  'plans.get': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = await callPlansRead('get', (args ?? {}) as Record<string, unknown>);
      return r ? [r] : [];
    },
  },
  'plans.revisions': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('revisions', (args ?? {}) as Record<string, unknown>)) as {
        revisions?: unknown[];
      };
      return Array.isArray(r?.revisions) ? r.revisions : [];
    },
  },
  'plans.runs': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('runs', (args ?? {}) as Record<string, unknown>)) as {
        runs?: unknown[];
      };
      return Array.isArray(r?.runs) ? r.runs : [];
    },
  },
  'plans.lint': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('lint', (args ?? {}) as Record<string, unknown>)) as {
        reports?: unknown[];
      };
      return Array.isArray(r?.reports) ? r.reports : [];
    },
  },

  // ── learning.improvements — the Learning tab's self-improvement feed ──
  //
  // (operator-learning-tab-2026-06-09 P-002 / D-003). Reuses the SAME read+score
  // path the `improvements:digest` tool uses (readImprovementItems + buildDigest),
  // so the tab and the tool can never drift. Returns the structured ImprovementDigest
  // — extended with a `flow` block (learning-system-audit P-041: captured-vs-resolved
  // 7d, median open age, recurrence count, watchdog liveness — flows, not stocks;
  // the digest fields themselves are untouched so the tool shape can't drift) —
  // as a 1-element array (client reads data[0]). NOT table-backed — engineer_issues
  // has no emit_change_notify trigger — so it refreshes on mount + the panel's manual
  // `invalidate()` + a server-side notifySyncInvalidate fired from captureImprovement.
  'learning.improvements': {
    argsSchema: z
      .object({
        state: z.enum(['open', 'resolved', 'closed']).optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as { state?: 'open' | 'resolved' | 'closed'; limit?: number };
      const { readImprovementItems } = await import('../harness/improvements/read-items');
      const { buildDigest } = await import('../harness/improvements/digest');
      const { computeImprovementFlow, readWatchdogFlowTicks } = await import('../harness/improvements/flow-metrics');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const nowMs = Date.now();
      const items = await readImprovementItems({ state: a.state, limit: a.limit });
      const digest = buildDigest(items, { nowMs });
      // Watchdog ticks are best-effort: a tick-read failure degrades the flow
      // strip to "watchdog: never" rather than 500ing the whole improvements view.
      let ticks: Awaited<ReturnType<typeof readWatchdogFlowTicks>> = [];
      try {
        ticks = await readWatchdogFlowTicks(activeWorkspaceId());
      } catch (err) {
        console.warn('[learning.improvements] watchdog tick read failed:', err instanceof Error ? err.message : err);
      }
      const flow = computeImprovementFlow(items, ticks, {
        nowMs,
        // Reuse the digest's recurrence computation (P-041) — do not re-derive.
        recurringSignatureCount: digest.recurringSignatures.length,
      });
      return [{ ...digest, flow }];
    },
  },

  // ── learning.gym — the Learning tab's Gym view (operator-learning-tab P-006) ──
  //
  // Cross-harness rollup of the gym control plane: recent prompt-optimization
  // proposals (pending / accepted = champions / rejected) + each gym harness's
  // autoloop config. Reuses the gym control-plane readers (single source of truth
  // with the gym:* routes). Returns a 1-element array { proposals, autoloops }.
  // NOT table-backed for PG-trigger invalidation — refreshes on mount + the panel's
  // manual `invalidate()`. Empty until a gym actually runs (graceful empty in the UI).
  'learning.gym': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { listRecentProposalsForWorkspace, listAutoloopsForWorkspace } = await import('../gym/control-plane');
      const ws = activeWorkspaceId();
      return await routeWithWorkspace(async (tx) => {
        const [proposals, autoloops] = await Promise.all([
          listRecentProposalsForWorkspace(tx, { workspaceId: ws, limit: 50 }),
          listAutoloopsForWorkspace(tx, { workspaceId: ws }),
        ]);
        return [{ proposals, autoloops }];
      });
    },
  },

  // ── learning.apiary — the Learning tab's Benchmark view (operator-learning-tab P-007) ──
  //
  // The apiary / IQ-battery scoreboard: one summary row per benchmark generation
  // (instance), newest-first, over the canonical beekeeper_instances/runs/scores tables.
  // The yardstick for "are the agents actually getting better" (D-004). Reuses the
  // readApiaryInstanceSummaries reader. Returns a 1-element array { instances }. NOT
  // table-backed for PG-trigger invalidation — refreshes on mount + manual invalidate.
  // Best-effort (learning-system-audit P-042): pre-baseline (gen-0 is owner-gated) a
  // missing table / PG error degrades to instances:[] — the clean empty state, not a 500.
  'learning.apiary': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readApiaryInstanceSummaries } = await import('../iq-battery/benchmark-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => {
          const instances = await readApiaryInstanceSummaries(tx, { workspaceId: ws, limit: 20 });
          return [{ instances }];
        });
      } catch (err) {
        console.warn('[learning.apiary] benchmark read failed:', err instanceof Error ? err.message : err);
        return [{ instances: [] }];
      }
    },
  },

  // ── learning.knowledge — the Learning tab's Knowledge view (operator-learning-tab P-008) ──
  //
  // Two best-effort halves (learning-system-audit P-042), each degrading
  // independently so one broken substrate never blanks the other (mirrors the
  // learning.improvements watchdog read):
  //   - insights: count + recent-5 agent-insight runbooks (FS read over the MDX
  //     library via readInsightsSnapshot — the SAME readInsightsDir the prelude
  //     uses). A teaser only; the tab cross-links to ?tab=insights for the library.
  //   - memory: total canonical memories + 30d feedback events (org PG). `null`
  //     when PG is unreachable — the UI shows "unavailable", never a 500.
  // Returns a 1-element array { insights, memory }. NOT table-backed — refreshes
  // on mount + the panel's manual `invalidate()`.
  'learning.knowledge': {
    resolve: async () => {
      const { readInsightsSnapshot, readMemoryHealth } = await import('../memory/knowledge-read');
      let insights: Awaited<ReturnType<typeof readInsightsSnapshot>> = { count: 0, recent: [] };
      try {
        insights = await readInsightsSnapshot();
      } catch (err) {
        console.warn('[learning.knowledge] insights read failed:', err instanceof Error ? err.message : err);
      }
      let memory: Awaited<ReturnType<typeof readMemoryHealth>> | null = null;
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        memory = await readMemoryHealth(getOrgPg().sql);
      } catch (err) {
        console.warn('[learning.knowledge] memory health read failed:', err instanceof Error ? err.message : err);
      }
      return [{ insights, memory }];
    },
  },

  // ── learning.scout — the Learning tab's Scout view (learning-system-audit P-042) ──
  //
  // Routed-ideas-by-rail over scout_routed_ideas (migration 194) + the newest
  // scout_ticks row IF that table exists (P-034 lands it separately; the reader
  // omits the tick half on undefined-table). Whole-read PG failure degrades to
  // the empty snapshot — the tab renders "Scout has not routed ideas yet", never
  // a 500. Returns a 1-element array (client reads data[0]). NOT table-backed —
  // refreshes on mount + the panel's manual `invalidate()`.
  'learning.scout': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readScoutSnapshot } = await import('./learning-scout-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => [await readScoutSnapshot(tx, ws)]);
      } catch (err) {
        console.warn('[learning.scout] scout read failed:', err instanceof Error ? err.message : err);
        return [{ totalRouted: 0, railCounts: [], lastTick: null }];
      }
    },
  },

  // ── dev.* — live-ops glances for the dev admin rail ──────────────────
  //
  // (plan dev-admin-sidebar-2026-06-05, P-005..P-008). NOT table-backed, so
  // there's no TABLE_TO_QUERY_NAMES entry — they have no PG-trigger invalidation
  // and refresh only on mount + the panel's manual `invalidate()` (like the
  // `plans.*` reads above, which dispatch a tool rather than read a table).
  // Single-snapshot reads return a 1-element array (client reads data[0]); list
  // reads return the rows flat. DEV-only by construction — the rail that calls
  // them is gated `import.meta.env.DEV` and absent from user builds.

  // dev.serviceHealth — up/down + latency probe of the dev endpoints now.
  'dev.serviceHealth': {
    resolve: async () => {
      const { probeAll } = await import('../service-health');
      const services = await probeAll();
      return [{ services }];
    },
  },

  // dev.deployState — read-only release-gate snapshot: green :3070's ref vs
  // `ready` vs `main`, how far behind, last deploy time (the #10 antidote).
  'dev.deployState': {
    resolve: async () => {
      const { devDeployState } = await import('../dev-deploy-state');
      return [await devDeployState()];
    },
  },

  // dev.gitPipeline — the whole git-sync → green-checkpoint → release pipeline
  // for the /admin Git tab: routine schedule/active, latest git-sync + resolver
  // state, any OPEN merge conflict, windowed history counts (mig 177 pipeline_events),
  // a recent timeline, and the deploy gap. Snapshot wrapped in a 1-element array.
  'dev.gitPipeline': {
    resolve: async () => {
      const { gitPipelineSnapshot } = await import('../git-pipeline-stats');
      return [await gitPipelineSnapshot()];
    },
  },

  // dev.pgHealth — pool usage snapshot (total / active / idle + version).
  'dev.pgHealth': {
    resolve: async () => {
      const { pgHealth } = await import('../dev-data');
      return [await pgHealth()];
    },
  },

  // dev.pgActiveQueries — currently-running queries, oldest first (slow /
  // idle-in-transaction wedge detection).
  'dev.pgActiveQueries': {
    argsSchema: z.object({
      limit: z.number().int().positive().max(200).default(50),
    }),
    resolve: async (args) => {
      const { limit } = args as { limit: number };
      const { pgActiveQueries } = await import('../dev-data');
      const { queries } = await pgActiveQueries(limit);
      return queries;
    },
  },

  // dev.coordPresence — LIVE coordination agents and their declared intent: who's
  // working on what right now. Filters out stale rows server-side (heartbeat >10
  // min — almost certainly ended): the roster can hold 150+ rows but only a
  // handful are live, and shipping every stale row each refresh is exactly what
  // overflowed coord:presence's token budget (233-row note in presence.ts).
  'dev.coordPresence': {
    argsSchema: z.object({
      workspace: z.string().optional(),
    }),
    resolve: async (args) => {
      const { workspace } = args as { workspace?: string };
      const { listPresence } = await import('../agent-tools/coordination/presence');
      const records = (await listPresence({ workspaceId: workspace ?? null })) as Array<{
        stale?: boolean;
      }>;
      return records.filter((r) => !r.stale);
    },
  },

  // dev.coordFeed — the WHOLE coordination firehose: every envelope across every
  // channel + every agent (messages/acks/notifies/broadcasts, handoffs,
  // escalations, plan events), newest-first with a cursor. Backs the /adv
  // Conversations "Feed" view. Same observer read as the high-tier coord:feed
  // tool. One row per envelope (the raw envelope + `surface` + `broadcast`); the
  // first row also carries `_meta` (total / by_kind / next_cursor) hidden behind
  // an underscore so the flat-row contract is preserved. The UI reads _meta off
  // row[0]; the rest are envelopes.
  'dev.coordFeed': {
    argsSchema: z.object({
      kinds: z.array(z.string()).optional(),
      owner: z.string().optional(),
      plan_slug: z.string().optional(),
      q: z.string().optional(),
      since_ts: z.string().optional(),
      before_ts: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    resolve: async (args) => {
      const a = (args ?? {}) as {
        kinds?: string[];
        owner?: string;
        plan_slug?: string;
        q?: string;
        since_ts?: string;
        before_ts?: string;
        limit?: number;
      };
      const { readCoordFeed } = await import('../agent-tools/coordination/feed');
      const { rows, nextCursor, total, byKind } = await readCoordFeed({
        kinds: a.kinds as never,
        owner: a.owner,
        plan_slug: a.plan_slug,
        q: a.q,
        since_ts: a.since_ts,
        before_ts: a.before_ts,
        limit: a.limit,
      });
      // Stash the page metadata on the first row so the flat-row sync contract
      // is preserved (no envelope wrapper). The UI reads `rows[0]?._meta`.
      const meta = { total, byKind, nextCursor };
      return rows.map((r, i) => (i === 0 ? { ...r, _meta: meta } : r));
    },
  },

  // dev.fleetGovernor — the fleet rate/cap snapshot: hard cap vs in-flight vs
  // AIMD-effective concurrency (the second half of the fleet glance, P-008).
  'dev.fleetGovernor': {
    resolve: async () => {
      const { buildFleetRateStatus } = await import('../fleet-rate-status');
      return [await buildFleetRateStatus()];
    },
  },

  // ─── Left sidebar (left-sidebar-tauri-2026-06-07) — the desktop's Hives /
  // Voice / Swarm rail, the SPA twin of the pui dock tabs. ───────────────

  // sidebar.fleetBees — the whole-fleet assignment groups (every agent's ranked
  // work-list + plan-claim slugs + liveness), the same canonical view
  // `fleet:assignments` serves. Backs the Swarm tab's fleet-wide task list and
  // the per-agent dossier filter.
  'sidebar.fleetBees': {
    argsSchema: z.object({ workspace: z.string().optional() }),
    resolve: async (args) => {
      const { workspace } = (args ?? {}) as { workspace?: string };
      const { listFleetAssignments, groupByAgent } = await import('../fleet/assignments');
      const rows = await listFleetAssignments({ workspaceId: workspace ?? null, activeOnly: true });
      return groupByAgent(rows);
    },
  },

  // sidebar.beeMail — one agent's coord inbox + outbox (the observer view the
  // bee-dossier comms section renders; `fleet:bee_mail`'s core, most-recent 50
  // per side). One row: { owner, inbox, outbox }.
  'sidebar.beeMail': {
    argsSchema: z.object({ owner: z.string().min(1).max(200) }),
    resolve: async (args) => {
      const { owner } = args as { owner: string };
      const { readInbox, readOutbox } = await import('../agent-tools/coordination/messages');
      const [inboxAll, outboxAll] = await Promise.all([readInbox(owner, {}), readOutbox(owner, {})]);
      const tail = <T,>(arr: T[]) => (arr.length > 50 ? arr.slice(arr.length - 50) : arr);
      return [{ owner, inbox: tail(inboxAll), outbox: tail(outboxAll) }];
    },
  },

  // sidebar.conversations — the whole-fleet conversation list (broadcasts +
  // multi-party threads — the all-hands channel the Swarm comms view shows
  // under the selected agent's direct mail).
  'sidebar.conversations': {
    argsSchema: z.object({
      state: z.string().optional(),
      limit: z.number().int().positive().max(200).default(50),
    }),
    resolve: async (args) => {
      const { state, limit } = args as { state?: string; limit: number };
      const { listConversations } = await import('../agent-tools/coordination/conversations');
      type Opts = NonNullable<Parameters<typeof listConversations>[0]>;
      const rows = await listConversations({ state: state as Opts['state'], limit });
      return rows;
    },
  },

  // sidebar.hives — every p2p-swarm peer (`shared_presence` — remote installs
  // whose announces the peer-log projected), INCLUDING stale ones (a hive that
  // joined but went quiet still lists, flagged). The Hives tab groups these
  // per device client-side, mirroring the pui Hives tab.
  'sidebar.hives': {
    resolve: async () => {
      const { listFederatedPresence } = await import(
        '../agent-tools/coordination/federated-presence'
      );
      // All rows, stale ones flagged (a hive that joined but went quiet still
      // lists); fail-soft empty when the org PG is unreachable.
      return listFederatedPresence({});
    },
  },

  // hive.controlState — the global Start/Pause-Hive control's read side
  // (start-hive-wake-orchestration P-006): per registered hive, the persisted
  // started bit (P-004), the pending time wake, and the watchdog health signal.
  // Live: hive:start / hive:pause fire
  // `notifySyncInvalidate('hive.controlState', {})` after the state flip.
  'hive.controlState': {
    resolve: async () => {
      const { listHives } = await import('../agent-tools/hive/_resolve');
      const { getHiveStarted } = await import('../hive/started');
      const { recentWatchdogFires } = await import('../hive/watchdog');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const ws = activeWorkspaceId();
      const hives = await listHives(ws).catch(() => []);
      return Promise.all(
        hives.map(async (hv) => ({
          slug: hv.slug,
          started: await getHiveStarted(ws, hv.slug).catch(() => false),
          nextFireAt: hv.wake?.nextFireAt ?? null,
          lastWakeAt: hv.wake?.lastWakeAt ?? null,
          watchdogFires24h: await recentWatchdogFires(ws, hv.slug).catch(() => 0),
        })),
      );
    },
  },

  // network.board — the aggregate Network-tab board (hive-network-surface
  // B-08 / P-006, CONTRACT C-3): one flat row per other-hive context across the
  // capability-tier ladder (tier 1 this Swarm · tier 2 own other hives · tier 3
  // shared-Hive peer Swarms · tier 4 foreign directory hives + beacon + grants +
  // asks). Composes the same buildNetworkBoard the `network:board` agent tool
  // serves — one composition, no drift. Flat-row contract (each row IS a
  // NetworkBoardRow). SSE-primary + 60s safety-net on the consumer (pui Network
  // pane B-09). Live: invalidated by the table→query bridge on
  // coord_presence/feature_claims writes, and by callers that
  // notifySyncInvalidate('network.board', {}) after a grant / ask / hive
  // start-pause / beacon change.
  'network.board': {
    argsSchema: z.object({ workspace: z.string().optional() }),
    resolve: async (args) => {
      const { workspace } = args as { workspace?: string };
      const { buildNetworkBoard } = await import('../network-board/build-board');
      return buildNetworkBoard({ workspaceId: workspace });
    },
  },

  // planItems.byPlan — the parsed plan items (id, text, storedStatus,
  // effectiveStatus, blockedBy, …) for one plan, for the Create-tab kanban.
  // Reads through the SAME path as `plans:get` (parses the plan's `content`
  // markdown) rather than the `harness_plans.items` jsonb column: that jsonb is
  // only re-projected on a plan WRITE, so it is stale/empty for plans not
  // re-written since the projection landed (~30 live plans had items in content
  // but an empty jsonb). Parsing content is always fresh AND carries
  // `effectiveStatus` (the issue-block overlay) for parity with the rail.
  // Keyed by `plan_slug` alone. Live: `plans:set-status` fires
  // `notifySyncInvalidate('planItems.byPlan', { planSlug })`.
  'planItems.byPlan': {
    argsSchema: z.object({ planSlug: z.string() }),
    resolve: async (args) => {
      const { planSlug } = args as { planSlug: string };
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const res = (await callPlansRead('get', { slug: planSlug })) as { items?: unknown[] };
      return Array.isArray(res?.items) ? res.items : [];
    },
  },
} satisfies Record<string, QueryEntry<unknown>>;

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Resolve a named query against the v2 registry. Returns flat rows on
 * success, NAME_NOT_FOUND if the name isn't registered yet (callers
 * fall back to the legacy resolver). Throws on schema-validation
 * failure or downstream errors — the route handler maps to HTTP.
 */
export const resolveNamedQueryV2 = createResolver(REGISTRY as unknown as QueryRegistry);

/** Test-only — enumerate which names the v2 registry currently knows. */
export function knownQueryNamesV2(): string[] {
  return Object.keys(REGISTRY).sort();
}

/** Test-only — useful for assertions in migration progress tests. */
export function isRegisteredV2(name: string): boolean {
  return name in REGISTRY;
}
