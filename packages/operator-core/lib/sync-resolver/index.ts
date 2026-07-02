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
// Flat-row sync reads carry page metadata (e.g. the true total) on row[0]._meta;
// attachListMeta is the one place that convention lives. See ./list-meta.
import { attachListMeta } from './list-meta';

// CLAMP, don't REJECT (clamp-not-reject, plan coordination-unification-data-sync-hardening
// P-001 / D-002): a client-sent pagination `limit` must never make the resolver throw on
// a client/server version skew (a newer UI bundle asking for more than an older deployed
// resolver allowed → the panel-breaking "Too big" error workItems.byHarness had). A bare
// Zod `.max()` REJECTS; these CLAMP via `.transform()` (the framework parses argsSchema and
// passes the transformed value to resolve — query-registry.ts:57-58 — so args.limit is
// already bounded in the body). `clampedLimit` has a default; `clampedLimitOpt` stays
// optional (absent → undefined, the body's own `?? N` applies).
const clampedLimit = (cap: number, def: number) =>
  z.number().int().positive().default(def).transform((v) => Math.min(v, cap));
const clampedLimitOpt = (cap: number) =>
  z.number().int().positive().transform((v) => Math.min(v, cap)).optional();

// Coerce any top-level BigInt field on each row to a Number so the rows survive the
// rest-query-batch serializer (a plain JSON.stringify, which THROWS on a BigInt → a 500
// whenever the resolver returns rows). A bigserial({ mode: 'bigint' }) PK (user_actions.id
// and ~34 other tables) is the common source; ids are well within 2^53. This mirrors the
// explicit `typeof v === 'bigint' ? Number(v)` convention in harness-core / agent-chats-data
// / projects-data. Returns the original row object untouched when it has no BigInt (no
// allocation on the hot path). Exported for the unit guard. (data-sync-push-completion
// D-010: found live on :3170 verifying the P-006 userActions.recent resolver — byHarness/
// byKind shared the latent 500, masked by the sparse user_actions table.)
export function jsonSafeRows(rows: unknown[]): unknown[] {
  return rows.map((r) => {
    if (!r || typeof r !== 'object') return r;
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (typeof v === 'bigint') (out ??= { ...(r as Record<string, unknown>) })[k] = Number(v);
    }
    return out ?? r;
  });
}

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
async function resolveRunsWithOutcome(harnessSlug: string, workspaceId?: string, limit?: number): Promise<unknown[]> {
  const { getOrgPg, generated } = await import('@papercusp/db-org');
  const { and, desc, eq, sql } = await import('drizzle-orm');
  const t = generated.agentRunsConsolidatedInHarnessShared;
  const s = generated.spawnedAgentsInHarnessShared;
  const { db } = getOrgPg();
  // EI-1763 (helper-form): harness_slug is per-workspace-unique and getOrgPg bypasses
  // RLS, so a slug-only filter cross-leaks runs across workspaces sharing a slug. Both
  // stores (agent_runs_consolidated, spawned_agents) carry workspace_id. The block-grained
  // coverage guard CANNOT see this leak (the `eq(s.harnessSlug,…)` is on an alias in this
  // shared helper, outside any resolver block), so it is fixed here by hand. `workspaceId`
  // is OPTIONAL (threaded from the caller's argsSchema) → unset preserves today's behavior.
  const spawn = db
    .selectDistinctOn([s.harnessSlug, s.runId], {
      harnessSlug: s.harnessSlug,
      workspaceId: s.workspaceId,
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
    .where(
      workspaceId != null
        ? and(eq(s.harnessSlug, harnessSlug), eq(s.workspaceId, workspaceId))
        : eq(s.harnessSlug, harnessSlug),
    )
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
    .where(
      // Scope the FULL-OUTER union by workspace too (EI-1763). The spawn subquery is
      // already workspace-filtered; the coalesce here additionally scopes the LEGACY
      // (`t`-only) rows — coalescing the two stores' workspace_id mirrors the harness_slug
      // coalesce above so a legacy-only or live-only row is judged by whichever side exists.
      workspaceId != null
        ? and(
            sql`coalesce(${t.harnessSlug}, ${spawn.harnessSlug}) = ${harnessSlug}`,
            sql`coalesce(${t.workspaceId}, ${spawn.workspaceId}) = ${workspaceId}`,
          )
        : sql`coalesce(${t.harnessSlug}, ${spawn.harnessSlug}) = ${harnessSlug}`,
    )
    .orderBy(desc(tsExpr));
  return (limit != null ? await q.limit(limit) : await q) as unknown[];
}

async function resolveDesignFeatures(args: { harnessSlug: string; workspaceId: string }): Promise<unknown[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { harnessSlug, workspaceId } = args;
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT
      feature_id, title, summary, status, needs_design,
      design_status, design_spec_id, discarded_design_work, updated_ts
    FROM harness_shared.harness_features_consolidated
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND needs_design = TRUE
    ORDER BY updated_ts DESC NULLS LAST
    LIMIT 500
  `;
  return rows.map((r) => ({
    featureId: r.feature_id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    needsDesign: r.needs_design,
    designStatus: r.design_status,
    designSpecId: r.design_spec_id,
    discardedDesignWork: r.discarded_design_work,
    updatedTs: r.updated_ts == null ? null : Number(r.updated_ts),
  })) as unknown[];
}

async function resolveDesignSketches(args: { harnessSlug: string; featureId: string; workspaceId: string }): Promise<unknown[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { harnessSlug, featureId, workspaceId } = args;
  const { sql } = getOrgPg();
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return await tx`
      SELECT id, payload, metadata, created_ts
        FROM harness_shared.harness_design_artifacts
       WHERE harness_slug = ${harnessSlug}
         AND feature_id   = ${featureId}
         AND kind         = 'sketch'
       ORDER BY created_ts DESC
       LIMIT 100
    `;
  });
  return rows.map((r) => ({
    id: r.id,
    label: (r.payload as { label?: string } | null)?.label ?? null,
    png: (r.payload as { png?: string } | null)?.png ?? null,
    createdTs: r.created_ts == null ? null : Number(r.created_ts),
    metadata: r.metadata ?? {},
  })) as unknown[];
}

async function resolveDesignRegressions(): Promise<unknown[]> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  const roots = {
    baseline: 'lostpixel-baseline',
    current: 'lostpixel-current',
    diff: 'lostpixel-diff',
  } as const;
  type Bucket = keyof typeof roots;
  async function listDir(absDir: string) {
    try {
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      const out = new Map<string, { mtime: number; size: number }>();
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.png')) continue;
        const stat = await fs.stat(join(absDir, e.name));
        out.set(e.name, { mtime: stat.mtimeMs, size: stat.size });
      }
      return out;
    } catch {
      return new Map<string, { mtime: number; size: number }>();
    }
  }
  const cwd = process.cwd();
  const buckets: Record<Bucket, Awaited<ReturnType<typeof listDir>>> = {
    baseline: await listDir(join(cwd, roots.baseline)),
    current: await listDir(join(cwd, roots.current)),
    diff: await listDir(join(cwd, roots.diff)),
  };
  const allNames = new Set<string>();
  for (const m of Object.values(buckets)) for (const n of m.keys()) allNames.add(n);
  const items = [...allNames].sort().map((name) => {
    const b = buckets.baseline.get(name);
    const c = buckets.current.get(name);
    const d = buckets.diff.get(name);
    return {
      name,
      hasBaseline: !!b,
      hasCurrent: !!c,
      hasDiff: !!d,
      baselineMtime: b?.mtime ?? null,
      currentMtime: c?.mtime ?? null,
      diffMtime: d?.mtime ?? null,
      baselineSize: b?.size ?? null,
      currentSize: c?.size ?? null,
      diffSize: d?.size ?? null,
      hasRegression: !!d && d.size > 200,
    };
  });
  return [{
    counts: {
      baseline: buckets.baseline.size,
      current: buckets.current.size,
      diff: buckets.diff.size,
      regressions: items.filter((i) => i.hasRegression).length,
    },
    items,
  }];
}

async function resolveDesignMemos(args: { status?: string }): Promise<unknown[]> {
  const { promises: fs } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const dir = resolve(process.cwd(), 'apps/operator-docs/src/content/docs/design');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const file of entries) {
    if (!file.endsWith('.mdx')) continue;
    const slug = file.slice(0, -4);
    const raw = await fs.readFile(join(dir, file), 'utf-8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? '';
    const title = /^title:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, '') || slug;
    const status = /^status:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, '') || 'open';
    if (args.status && args.status !== 'any' && status !== args.status) continue;
    out.push({ slug, title, status, source: join(dir, file) });
  }
  return out;
}

async function resolveDesignRegistry(args: { ecosystem?: string; query?: string }): Promise<unknown[]> {
  const { makeReactTailwindRegistry } = await import('../design-adapter-react-tailwind/registry');
  const ecosystem = args.ecosystem || 'react-tailwind';
  if (ecosystem !== 'react-tailwind') return [];
  const query = (args.query || '').trim().toLowerCase();
  const registry = makeReactTailwindRegistry({ sourcePaths: ['apps/operator/app/harness', 'libs/generic/papergrid/grid-core/src'] });
  const entries = await registry.listPrimitives();
  if (!query) return entries as unknown[];
  return entries.filter((entry) => {
    const haystack = [
      entry.id,
      entry.summary,
      ...(entry.inputs ?? []).map((input) => `${input.name} ${input.type}`),
      ...(entry.variants ?? []),
      ...(entry.states ?? []),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  }) as unknown[];
}

async function resolveDesignTokens(args: { category?: string }): Promise<unknown[]> {
  const { promises: fs } = await import('node:fs');
  const { resolve } = await import('node:path');
  const doc = JSON.parse(await fs.readFile(resolve(process.cwd(), 'design/tokens/base.json'), 'utf-8')) as unknown;
  const out: Array<{ id: string; type: string; value: unknown; description: string | null; group: string | null }> = [];
  function walk(node: unknown, prefix: string[]): void {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith('$')) continue;
      if (value && typeof value === 'object' && '$type' in value && '$value' in value) {
        const leaf = value as { $type: string; $value: unknown; $description?: string };
        out.push({
          id: [...prefix, key].join('.'),
          type: leaf.$type,
          value: leaf.$value,
          description: leaf.$description ?? null,
          group: prefix.join('.') || null,
        });
      } else {
        walk(value, [...prefix, key]);
      }
    }
  }
  walk(doc, []);
  const category = args.category?.toLowerCase();
  return category
    ? out.filter((token) => token.id.toLowerCase().startsWith(`${category}.`) || token.type === category)
    : out;
}

/**
 * Resolve a shared hive's member-harness SLUGS for the cross-member browse reads
 * (WI-259 P-006, D-010). The member set is the hive home plus every locally-
 * registered harness whose `hive_slug` points at the home (joining a hive
 * registers each member harness with that stamp — discovery/join-hive). Mirrors
 * the `learning.improvements` hive-scope resolution; returns BARE slugs (strips the
 * `harness:` scope prefix `hiveMemberHarnessScopes` adds) for a `WHERE harness_slug
 * IN (...)` content read. Best-effort: a registry read failure degrades to just
 * `[hiveHomeSlug]` (the rollup still shows the home's own content) rather than
 * throwing — a federation read must never 500 the tab.
 */
async function resolveHiveMemberSlugs(hiveHomeSlug: string, workspaceId?: string): Promise<string[]> {
  try {
    const { loadHarnessRegistry, hiveMemberHarnessScopes } = await import('../harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    const slugs = hiveMemberHarnessScopes(reg.projects, hiveHomeSlug).map((s) => s.replace(/^harness:/, ''));
    // hiveMemberHarnessScopes always includes the home, so this is non-empty; guard anyway.
    return slugs.length > 0 ? slugs : [hiveHomeSlug];
  } catch (err) {
    console.warn(
      '[sync-resolver] hive member-slug resolution failed:',
      err instanceof Error ? err.message : err,
    );
    return [hiveHomeSlug];
  }
}

const REGISTRY: Record<string, QueryEntry<unknown>> = {
  // storage.usage — live storage usage by category for Settings → Storage
  // (storage-settings-page-2026-06-15 P-003). Reuses the audit introspection
  // (pg table sizes + age distribution + on-disk du). No args.
  'storage.usage': {
    resolve: async () => {
      const { computeStorageUsage } = await import('../storage/usage');
      return computeStorageUsage();
    },
  },

  // toastLog.recent — first migration. Mirrors the original ZQL:
  //   zql.toastLog.orderBy('createdAt', 'desc').limit(limit)
  // The flat-row return matches what useSyncQuery's SSEAdapter
  // expects in `data`.
  'toastLog.recent': {
    argsSchema: z.object({
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const { listToasts } = await import('../toast-log-data');
      const { limit } = args as { limit: number };
      const { toasts } = await listToasts({ limit });
      return toasts;
    },
  },

  // design.* — Design tab reads. These are query data and therefore ride
  // @papercusp/sync; byte/image fetches and sketch writes stay on explicit
  // HTTP endpoints.
  'designFeatures.byHarness': {
    argsSchema: z.object({
      harnessSlug: z.string().min(1),
      workspaceId: z.string().default('default'),
    }),
    resolve: async (args) => resolveDesignFeatures(args as { harnessSlug: string; workspaceId: string }),
  },
  'designSketches.byFeature': {
    argsSchema: z.object({
      harnessSlug: z.string().min(1),
      featureId: z.string().min(1),
      workspaceId: z.string().default('default'),
    }),
    resolve: async (args) => resolveDesignSketches(args as { harnessSlug: string; featureId: string; workspaceId: string }),
  },
  'designRegressions.list': {
    resolve: async () => resolveDesignRegressions(),
  },
  'designMemos.list': {
    argsSchema: z.object({ status: z.string().optional() }).optional(),
    resolve: async (args) => resolveDesignMemos((args ?? {}) as { status?: string }),
  },
  'designRegistry.search': {
    argsSchema: z.object({
      ecosystem: z.string().default('react-tailwind'),
      query: z.string().optional(),
    }),
    resolve: async (args) => resolveDesignRegistry(args as { ecosystem?: string; query?: string }),
  },
  'designTokens.list': {
    argsSchema: z.object({ category: z.string().optional() }).optional(),
    resolve: async (args) => resolveDesignTokens((args ?? {}) as { category?: string }),
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
      limit: clampedLimit(500, 20),
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
    argsSchema: z.object({ includeHiveHomes: z.boolean().optional() }).optional(),
    resolve: async (args) => {
      const { buildProjectsLitePayload } = await import('../harness/projects-lite');
      // Bypass the 1s TTL cache: an invalidation-triggered refetch must not
      // serve a payload built just BEFORE the write it's reacting to.
      const payload = await buildProjectsLitePayload({
        bypassCache: true,
        includeHiveHomes: (args as { includeHiveHomes?: boolean } | undefined)?.includeHiveHomes === true,
      });
      return payload.projects as unknown[];
    },
  },

  // harnessWorkspaces.byHarness — workspace memberships for the /adv Workspaces popover.
  // Registry writes invalidate via harness_shared.harness_registry.changed.
  'harnessWorkspaces.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { workspacesForHarness } = await import('../harness-membership');
      return (await workspacesForHarness(harnessSlug)).map((workspaceId) => ({ workspaceId }));
    },
  },

  // contributors.byHarness — Contributors tab rows, live via contributors and
  // tier-source table invalidations. Mirrors /harness/:slug/contributors.
  'contributors.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg } = await import('@papercusp/db-org');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { statsAggregateForStatus } = await import('../identity/binding-verifier-types');
      const ws = workspaceId ?? activeWorkspaceId();
      const { sql } = getOrgPg();
      const rows = (await sql<{
        github_user_id: number;
        github_username: string;
        display_name: string | null;
        avatar_url: string | null;
        joined_at: Date | string;
        last_seen_at: Date | string | null;
        binding_status: string;
        binding_last_checked_at: Date | string | null;
        device_attestations: unknown;
        prs_merged: string | number | null;
        features_shipped: string | number | null;
        activity_events: string | number | null;
      }[]>`
        SELECT
          c.github_user_id,
          c.github_username,
          c.display_name,
          c.avatar_url,
          c.joined_at,
          c.last_seen_at,
          c.binding_status,
          c.binding_last_checked_at,
          c.device_attestations,
          (
            SELECT COUNT(*) FROM harness_shared.auto_review_audit a
            WHERE a.workspace_id = c.workspace_id
              AND a.harness_slug = c.harness_slug
              AND a.author_github_id = c.github_user_id
              AND a.action IN ('auto_merge', 'manual_merge')
          ) AS prs_merged,
          (
            SELECT COUNT(*) FROM harness_shared.harness_features_consolidated f
            WHERE f.workspace_id = c.workspace_id
              AND f.harness_slug = c.harness_slug
              AND f.status = 'shipped'
              AND f.taken_by = c.github_user_id::text
          ) AS features_shipped,
          (
            SELECT COUNT(*) FROM harness_shared.contributor_usage_events e
            WHERE e.harness_slug = c.harness_slug
              AND e.github_user_id = c.github_user_id
          ) AS activity_events
        FROM harness_shared.contributors c
        WHERE c.workspace_id = ${ws}
          AND c.harness_slug = ${harnessSlug}
        ORDER BY c.joined_at DESC
      `);
      const toMs = (v: Date | string | null): number | null => {
        if (v === null) return null;
        if (v instanceof Date) return v.getTime();
        return new Date(v).getTime();
      };
      const toCount = (v: string | number | null | undefined): number => {
        if (v == null) return 0;
        const n = typeof v === 'string' ? Number(v) : v;
        return Number.isFinite(n) ? n : 0;
      };
      return rows.map((r) => {
        const aggregate = statsAggregateForStatus(r.binding_status as never);
        return {
          github_user_id: r.github_user_id,
          github_username: r.github_username,
          display_name: r.display_name,
          avatar_url: r.avatar_url,
          joined_at: toMs(r.joined_at) ?? 0,
          last_seen_at: toMs(r.last_seen_at),
          binding_status: r.binding_status,
          binding_last_checked_at: toMs(r.binding_last_checked_at),
          device_count: Array.isArray(r.device_attestations) ? r.device_attestations.length : 0,
          prs_merged: aggregate ? toCount(r.prs_merged) : 0,
          features_shipped: aggregate ? toCount(r.features_shipped) : 0,
          activity_events: aggregate ? toCount(r.activity_events) : 0,
        };
      });
    },
  },

  // advSessions.list — /adv Sessions roster rows with OMP summaries attached.
  // Replaces the UI's 3s `/api/adv/sessions` poll; adv_sessions writes push via
  // the table bridge.
  'advSessions.list': {
    argsSchema: z.object({ limit: clampedLimit(500, 200).optional() }).optional(),
    resolve: async (args) => {
      const limit = ((args as { limit?: number } | undefined)?.limit ?? 200);
      const { listAdvSessions } = await import('../adv-sessions');
      const { getOmpSessionRowSummary } = await import('../omp-sessions');
      const rows = await listAdvSessions(limit);
      const STARTUP_GRACE_MS = 60_000;
      const now = Date.now();
      const withSummary = await Promise.all(
        rows.map(async (row) => {
          if (row.mode !== 'omp') return { row, summary: null };
          const summary = row.ompThreadId ? getOmpSessionRowSummary({ id: row.ompThreadId }) : null;
          return { row, summary };
        }),
      );
      return withSummary
        .filter(({ row, summary }) => {
          if (row.mode !== 'omp') return true;
          if (summary && summary.userMessages > 0) return true;
          if (summary !== null && summary.userMessages === 0) {
            const startedMs = Date.parse(row.startedAt);
            return Number.isFinite(startedMs) && now - startedMs < STARTUP_GRACE_MS;
          }
          return true;
        })
        .map(({ row, summary }) => ({ ...row, summary }));
    },
  },

  // agentDetail.byOwner — Tier-3 dossier detail for the selected Sessions agent.
  'agentDetail.byOwner': {
    argsSchema: z.object({ ownerId: z.string().min(1) }),
    resolve: async (args) => {
      const { ownerId } = args as { ownerId: string };
      const { getAgentDetail } = await import('../adv-agent-detail');
      return [await getAgentDetail(ownerId)];
    },
  },

  // advRoster.list — shared Sessions roster context, formerly a 4s
  // `/api/adv/roster` poll. Shape matches the route payload.
  'advRoster.list': {
    argsSchema: z.object({
      workspaceId: z.string().nullable().optional(),
      endedLimit: clampedLimit(200, 50).optional(),
    }).optional(),
    resolve: async (args) => {
      const { workspaceId = null, endedLimit = 50 } = (args ?? {}) as {
        workspaceId?: string | null;
        endedLimit?: number;
      };
      const os = await import('node:os');
      const {
        mergeRosterWithAssignments,
        dedupeEndedAgainstActive,
        pendingLaunchesToRosterEntries,
      } = await import('../adv-roster');
      const {
        listEndedAdvSessions,
        listPendingWorkbenchLaunches,
      } = await import('../adv-sessions');
      const [{ active, orphanedClaims }, endedAll, pendingRows] = await Promise.all([
        mergeRosterWithAssignments({ workspaceId }),
        listEndedAdvSessions({ workspaceId, limit: endedLimit }),
        listPendingWorkbenchLaunches({ workspaceId }),
      ]);
      return [{
        active,
        ended: dedupeEndedAgainstActive(endedAll, active),
        orphanedClaims,
        pending: pendingLaunchesToRosterEntries(pendingRows, os.hostname()),
      }];
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
    // EI-1763: workspaceId scopes the read to the caller's tenant. harness_slug is
    // per-workspace-unique (NOT global), and getOrgPg bypasses RLS, so a slug-only
    // read returns CROSS-WORKSPACE rows. Optional for a non-breaking rollout (a caller
    // that omits it keeps today's behavior); tighten to required once all clients pass it.
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessTextArtifactsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.relPath))) as unknown[];
    },
  },

  // harnessProjectFiles.byHarness — single-row-per-harness (SPEC.md etc bundle).
  //   zql.harnessProjectFiles.where('harnessSlug', s)  (no order)
  'harnessProjectFiles.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessProjectFilesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )) as unknown[];
    },
  },

  // harnessSkills.byHarness — skills sorted by name.
  //   zql.harnessSkills.where('harnessSlug', s).orderBy('name', 'asc')
  'harnessSkills.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessSkillsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.name))) as unknown[];
    },
  },

  // harnessDecisions.byHarness — decisions in chronological order.
  //   zql.harnessDecisions.where('harnessSlug', s).orderBy('ts', 'asc')
  'harnessDecisions.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessDecisionsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
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

  // harnessLanes.snapshot — dashboard-shaped lane snapshot for /adv chrome.
  // Replaces the legacy `/api/harness/:slug/lanes` read without forcing clients
  // to know the filesystem lanes.json shape or effective-config max-worker rule.
  'harnessLanes.snapshot': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string().optional(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId, phase } = args as {
        harnessSlug: string;
        workspaceId?: string;
        phase: string;
      };
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { resolvePhasedProject, harnessDir } = await import('../harness-core');
      const { readEffectiveHarnessConfig } = await import('../harness-effective-config');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { phasePhaseLabel } = await import('../harness-phases');
      const project = await resolvePhasedProject(harnessSlug, phasePhaseLabel(phase));
      if (!project) return [];
      const p = join(harnessDir(project), 'lanes.json');
      const nowMs = Date.now();
      const lanes: Array<{ pid: number; featureId: string; startedAt: number; elapsedSeconds: number; alive: boolean }> = [];
      if (existsSync(p)) {
        try {
          const raw = JSON.parse(readFileSync(p, 'utf8')) as { lanes?: unknown[] };
          for (const l of raw.lanes ?? []) {
            if (!l || typeof l !== 'object') continue;
            const lane = l as { pid?: unknown; feature_id?: unknown; started_at?: unknown };
            if (typeof lane.pid !== 'number' || typeof lane.feature_id !== 'string') continue;
            let alive = false;
            try {
              process.kill(lane.pid, 0);
              alive = true;
            } catch {}
            const ts = typeof lane.started_at === 'number' ? lane.started_at * 1000 : nowMs;
            lanes.push({
              pid: lane.pid,
              featureId: lane.feature_id,
              startedAt: ts,
              elapsedSeconds: Math.max(0, Math.floor((nowMs - ts) / 1000)),
              alive,
            });
          }
        } catch {
          // Match the route's tolerant behavior: malformed lanes.json degrades to empty.
        }
      }
      let max = 1;
      try {
        const cfg = await readEffectiveHarnessConfig(project.slug, workspaceId ?? activeWorkspaceId(), project.path);
        const pw = cfg?.parallelWorkers as Record<string, unknown> | undefined;
        if (typeof pw?.max === 'number' && pw.max > 0) max = pw.max;
      } catch {}
      return [{ lanes, max }];
    },
  },

  // harnessEscalations.byHarness — single escalation row per phase.
  //   zql.harnessEscalations.where(harnessSlug).where(phase).limit(1)
  'harnessEscalations.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessEscalationsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .limit(1)) as unknown[];
    },
  },

  // harnessCheckpoints.byHarness — checkpoints ordered by waiting time.
  //   zql.harnessCheckpoints.where(harnessSlug).orderBy('waitingSinceMs', 'asc')
  'harnessCheckpoints.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessCheckpointsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.waitingSinceMs))) as unknown[];
    },
  },

  // featurePrs.byHarness — feature PRs ordered by feature id.
  //   zql.harnessFeaturePrs.where(harnessSlug).orderBy('featureId', 'asc')
  'featurePrs.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness). This
    // resolver was MISSED by su-d2230's "remediated to zero" pass because the
    // coverage guard's block body bled the NEXT resolver's doc-comment (which
    // mentioned workspaceId) into this block, masking it — fixed alongside this.
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturePrsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
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

  // harnessStatus.snapshot — dashboard-shaped status snapshot for /adv panels.
  // This keeps the existing route's aggregate semantics (cost rollup, counts,
  // checkpoints, smoke failure, project path) while delivering it through sync.
  'harnessStatus.snapshot': {
    argsSchema: z.object({
      harnessSlug: z.string(),
      workspaceId: z.string().optional(),
      phase: z.string().default('staging'),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase } = args as { harnessSlug: string; phase: string };
      const { getHarnessStatusFull } = await import('../harness-core');
      const { phasePhaseLabel } = await import('../harness-phases');
      const payload = await getHarnessStatusFull(harnessSlug, phasePhaseLabel(phase));
      return payload ? [payload] : [];
    },
  },

  // harnessTests.byHarness — tests filtered by harness+phase, by name.
  //   zql.harnessTests.where(harnessSlug).where(phase).orderBy('name', 'asc')
  'harnessTests.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessTestsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .orderBy(asc(t.name))) as unknown[];
    },
  },

  // harnessArchives.byHarness — archives by harness+phase, latest first.
  //   zql.harnessArchives.where(harnessSlug).where(phase).orderBy('ts', 'desc')
  'harnessArchives.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessArchivesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessHookLogs.byHarness — most-recent 50 hook events per harness.
  //   zql.harnessHookLogs.where(harnessSlug).orderBy('ts', 'desc').limit(50)
  'harnessHookLogs.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessHookLogsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.ts))
        .limit(50)) as unknown[];
    },
  },

  // ── Batch 6: phases / smoke-test / brainstorm ─
  // (summary.byHarness retired — fs-watcher-retirement step 2; the
  //  harness_summaries mirror was a dead legacy path, dropped in migration 282.
  //  The live summary UI reads harness_text_artifacts, migration 035.)

  // harnessPhases.byHarness retired — fs-watcher-retirement step 5; the
  // harness_phases mirror was dropped (migration 285). HealthBadge reads
  // liveness from harnessLanes.byHarness; the /phases REST route recomputes
  // the rest on demand.

  // harnessSmokeTest.byHarness — single smoke-test row per harness.
  //   zql.harnessSmokeTest.where(harnessSlug).limit(1)
  'harnessSmokeTest.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const t = generated.harnessSmokeTestInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .limit(1)) as unknown[];
    },
  },

  // harnessBrainstorm.byHarness — brainstorm rows ordered by phase asc.
  //   zql.harnessBrainstorm.where(harnessSlug).orderBy('phase', 'asc')
  'harnessBrainstorm.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness) — also
    // masked from su-d2230's pass by the coverage-guard comment-bleed blind spot.
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessBrainstormInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
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
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessPendingIssuesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessScreenshots.byHarness — harness+phase, newest first.
  //   zql.harnessScreenshots.where(harnessSlug).where(phase).orderBy('ts', 'desc')
  'harnessScreenshots.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      phase: z.string().default('staging'),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, phase, workspaceId } = args as {
        harnessSlug: string;
        phase: string;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessScreenshotsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.phase, phase)),
        )
        .orderBy(desc(t.ts))) as unknown[];
    },
  },

  // harnessBranchActions.byHarnessAndBranch retired — fs-watcher-retirement
  // step 4; the harness_branch_actions mirror was unconsumed (the
  // /branch/:branch/actions REST route recomputes on demand). Table dropped
  // in migration 283.

  // agentChats.byHarness — chats ordered by updatedAt desc, capped.
  //   zql.agentChatsConsolidated.where(harnessSlug).orderBy('updatedAt', 'desc').limit(limit)
  'agentChats.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({
      harnessSlug: z.string(),
      limit: clampedLimit(500, 50),
      workspaceId: z.string().optional(),
    }),
    resolve: async (args) => {
      const { harnessSlug, limit, workspaceId } = args as {
        harnessSlug: string;
        limit: number;
        workspaceId?: string;
      };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.agentChatsConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.updatedAt))
        .limit(limit)) as unknown[];
    },
  },

  // ── Batch 8: featureNotes / featureDebugNotes / featureAudit / chunkPlans / delegates ─

  // featureNotes.byHarness — feature notes ordered by featureId asc.
  //   zql.harnessFeatureNotes.where(harnessSlug).orderBy('featureId', 'asc')
  'featureNotes.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeatureNotesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.featureId))) as unknown[];
    },
  },

  // featureDebugNotes.byHarness — debug notes ordered by featureId asc.
  //   zql.harnessFeatureDebugNotes.where(harnessSlug).orderBy('featureId', 'asc')
  'featureDebugNotes.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeatureDebugNotesInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.featureId))) as unknown[];
    },
  },

  // featureAudit.byHarness — feature audit log, newest first, cap 2000.
  //   zql.featureAuditConsolidated.where(harnessSlug).orderBy('ts', 'desc').limit(2000)
  'featureAudit.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.featureAuditConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.ts))
        .limit(2000)) as unknown[];
    },
  },

  // featureTimeline.byFeature — synthesized feature event timeline.
  // The helper mirrors /harness/:slug/features/:id/timeline; sync delivery keeps
  // PlanDetail's feature slide-over off ad-hoc REST reads.
  'featureTimeline.byFeature': {
    argsSchema: z.object({ harnessSlug: z.string(), featureId: z.string() }),
    resolve: async (args) => {
      const { harnessSlug, featureId } = args as { harnessSlug: string; featureId: string };
      const { getFeatureTimeline } = await import('../endpoint-route/routes/harness/feature-views');
      const result = await getFeatureTimeline(harnessSlug, featureId);
      return result.ok ? result.events : [];
    },
  },

  // chunkPlans.byHarness — all chunk plans for a harness, ordered.
  //   zql.harnessChunkPlans.where(harnessSlug)
  //                        .orderBy('featureId', 'asc').orderBy('chunkIndex', 'asc')
  'chunkPlans.byHarness': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessChunkPlansInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(asc(t.featureId), asc(t.chunkIndex))) as unknown[];
    },
  },

  // chunkPlans.byFeature — chunk plans filtered by harness+feature.
  //   zql.harnessChunkPlans.where(harnessSlug).where(featureId)
  //                        .orderBy('chunkIndex', 'asc')
  'chunkPlans.byFeature': {
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness) — also
    // masked from su-d2230's pass by the coverage-guard comment-bleed blind spot.
    argsSchema: z.object({ harnessSlug: z.string(), featureId: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, featureId, workspaceId } = args as { harnessSlug: string; featureId: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, asc, eq } = await import('drizzle-orm');
      const t = generated.harnessChunkPlansInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.featureId, featureId), eq(t.workspaceId, workspaceId))
            : and(eq(t.harnessSlug, harnessSlug), eq(t.featureId, featureId)),
        )
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
      // Generous bound — a local desktop app loads all of a project's revisions
      // in practice; the cap only exists so a runaway project can't blow the
      // live read. CLAMP (in the body), don't `.max()`-REJECT: a hard max turns a
      // client/server version skew into a panel-breaking error. When it IS capped
      // the carried total keeps the count honest.
      limit: z.number().int().positive().default(500),
    }),
    resolve: async (args) => {
      const { projectId, limit } = args as { projectId: string; limit: number };
      const lim = Math.min(limit, 500); // clamp server-side; never reject
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { count, desc, eq } = await import('drizzle-orm');
      const t = generated.projectSpecRevisionsInHarnessShared;
      const { db } = getOrgPg();
      const [rows, totalRows] = await Promise.all([
        db.select().from(t).where(eq(t.projectId, projectId)).orderBy(desc(t.ts)).limit(lim),
        db.select({ n: count() }).from(t).where(eq(t.projectId, projectId)),
      ]);
      // Carry the TRUE total on row[0]._meta (the flat-row sync contract has no
      // envelope) so the UI shows "N of TOTAL" instead of the capped length.
      const total = totalRows[0]?.n ?? rows.length;
      return attachListMeta(rows, { total }) as unknown[];
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
      // CLAMP, don't REJECT. A hard `.max()` makes the schema error on a client
      // that requests more than the cap — turning a client/server version skew
      // (a newer client asking for a higher limit than an older deployed resolver
      // allowed) into a panel-breaking "Too big" error instead of graceful
      // degradation. The resolver body already Math.min-clamps to
      // WORK_ITEMS_MAX_LIMIT, so an over-large request is bounded server-side.
      limit: z.number().int().positive().default(2000),
    }),
    resolve: async (args) => {
      const { harnessSlug, kind, state, limit } = args as {
        harnessSlug: string;
        kind?: string;
        state?: string;
        limit: number;
      };
      const [{ listEnrichedWorkItems }, { isWorkItemKind, countWorkItems }] = await Promise.all([
        import('../endpoint-route/routes/harness/work-items'),
        import('../work-items'),
      ]);
      const k = kind && isWorkItemKind(kind) ? kind : undefined;
      const [rows, total] = await Promise.all([
        listEnrichedWorkItems({ harness: harnessSlug, kind: k, state, limit }),
        countWorkItems({ harness: harnessSlug, kind: k, state }),
      ]);
      // Carry the TRUE total on row[0]._meta (the flat-row sync contract has no
      // envelope) so the UI shows "N of TOTAL" instead of the capped length.
      return attachListMeta(rows, { total }) as unknown[];
    },
  },

  // fleetAssignments.byHarness — "who's working here?" for the Progress tab's
  // Agents panel (progress-tab-agents-convergence-2026-06-11 P-001/P-002).
  // ⚠ DEPRECATED for NEW consumers (presence-v2 P-007): this is the "divergent"
  // bare-assignment shape (no presence identity / mig-277 scalars / Tier-1).
  // Prefer hiveRoster.byHarness — the unified projection with the SAME
  // {doing,queued,load,orphaned} work shape + agentPaneKind/driveMode stamping.
  // Kept live because AdvAgentsPanel still reads it (its migration belongs to the
  // progress-tab plan, not P-007). The MemberWorkPanel (B10) repointed to
  // hiveRoster.byHarness. Below: the
  // fleet:assignments assembly (presence + plan-item claims + work-item claims,
  // claim-primary, with each agent's ordered work-list) filtered to one harness,
  // each agent stamped with its AgentPaneKind so the desktop shares the colony
  // tab's glyph vocabulary (♛/👁/🐝/🛡/📋/🛠). Role context joins from adv_sessions
  // (queen/sentinel/planner kinds are role-keyed; su falls out of the ownerId
  // prefix). Invalidated via the table bridge from coord_presence /
  // feature_claims / claim_audit / spawned_agents.
  'fleetAssignments.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const [
        { listFleetAssignments, groupByAgent },
        { listAdvSessions },
        { classifyAgentPane },
        { activeWorkspaceId },
      ] = await Promise.all([
        import('../fleet/assignments'),
        import('../adv-sessions'),
        import('@papercusp/agent-mcp'),
        import('../workspace-registry'),
      ]);
      // Scope to THIS window's workspace (request-scoped ALS, same as the
      // sibling hiveRoster.byHarness) — without it the harness-slug filter alone
      // surfaced fleet rows from every workspace, so a window never re-scoped its
      // Agents panel on a workspace switch. listFleetAssignments admits the
      // workspace + the '*' global + the plan-store default scope (EI-295), so
      // no claim rows are dropped.
      const rows = await listFleetAssignments({
        harness: harnessSlug,
        workspaceId: activeWorkspaceId(),
      });
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

  // scheduler.running — the live-execution view (hybrid-bee-scheduler-work-stealing
  // P-001 / D-007): every live "bee run" (a bee executing a claimed work-item) in a
  // harness, with its claimed-since / lease / heartbeat / progress + the derived
  // idle-blocked reason + the claim-spec specId@revision it runs under. Projects the
  // canonical fleet_assignment work-item-claim rows + the per-bee bee_claim_specs store
  // (read off live state, not a separate store). Invalidated via the same
  // claim/presence/nursery table bridge as fleetAssignments.byHarness, plus
  // bee_claim_specs (a Queen re-steer bumps the shown revision).
  'scheduler.running': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const [{ listBeeRuns }, { activeWorkspaceId }] = await Promise.all([
        import('../scheduler/bee-runs'),
        import('../workspace-registry'),
      ]);
      return listBeeRuns({ harness: harnessSlug, workspaceId: activeWorkspaceId() });
    },
  },

  // hiveRoster.byHive — presence-v2 Phase 3 fold (presence-v2-2026-06-14 P-006):
  // the unified per-agent live-state surface for ONE Hive. Folds coord:presence
  // (identity + the mig-277 last_active_at/agent_role/hive_slug scalars + the
  // P-003 Tier-1 enrichment) with the fleet:assignments work-detail
  // ({doing,queued,load,orphaned,claims}) — one read for "who's in this hive +
  // what is each one doing". Preserves the fleet work-shape (D-009#2 / P-015) so
  // the B10 member dashboard (P-007) repoints with a query swap. Invalidated via
  // the coord_presence / feature_claims / claim_audit / spawned_agents table
  // bridge (same tables as fleetAssignments.byHarness).
  'hiveRoster.byHive': {
    argsSchema: z.object({ hiveSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { hiveSlug, workspaceId } = args as { hiveSlug: string; workspaceId?: string };
      const { listHiveRoster } = await import('../fleet/hive-roster');
      return (await listHiveRoster({ hiveSlug, workspaceId: workspaceId ?? null })) as unknown[];
    },
  },

  // hiveRoster.byHarness — presence-v2 P-007: the SAME unified hive-roster fold,
  // but keyed by a HARNESS (resolved to its home Hive via hiveHomeSlugForHarness)
  // and stamped with the SAME AgentPaneKind/driveMode as fleetAssignments.byHarness
  // — so a harness-keyed UI surface (the B10 MemberWorkPanel) reads ONE projection
  // (presence + mig-277 scalars + Tier-1 + the {doing,queued,load,orphaned} work
  // shape) with a query swap, instead of the divergent fleetAssignments.byHarness
  // shape. Falls back to the harness slug as the scope key when the harness has no
  // Hive home — listHiveRoster's includeUnattributed then surfaces the standalone /
  // SU agents (NULL hive_slug). Invalidated via the same coord_presence /
  // feature_claims / claim_audit / spawned_agents bridge.
  'hiveRoster.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const [
        { listHiveRoster },
        { hiveHomeSlugForHarness },
        { activeWorkspaceId },
        { listAdvSessions },
        { classifyAgentPane },
      ] = await Promise.all([
        import('../fleet/hive-roster'),
        import('../hive-federation'),
        import('../workspace-registry'),
        import('../adv-sessions'),
        import('@papercusp/agent-mcp'),
      ]);
      const workspaceId = activeWorkspaceId();
      const hiveSlug = (await hiveHomeSlugForHarness(workspaceId, harnessSlug)) ?? harnessSlug;
      const roster = await listHiveRoster({ hiveSlug, workspaceId });
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
      return roster.map((a) => {
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
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessFeaturesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.updatedTs))) as unknown[];
    },
  },

  // featuresConsolidated.byHive — CROSS-MEMBER browse (WI-259 P-006, D-010).
  // Features across EVERY member harness of a shared hive, latest first. Each row
  // already carries `harness_slug` = the authoring member's slug = its ORIGIN, so
  // the UI can label + drill back to that member. The per-harness reads
  // (featuresConsolidated.bySlug) are UNCHANGED — member-origin-scoped stays the
  // default; this is the EXPLICIT cross-member view a hive rollup consumes.
  //
  // Why this works with NO schema change: post-WI-259-P-002 the membership guard
  // lands each member's content locally under that member's own slug, and joining
  // a hive (discovery/join-hive) registers each member harness with `hive_slug=H`.
  // So the member-slug SET is just the registry projects whose hive_slug points at
  // the home — resolved here exactly like `learning.improvements` (loadHarnessRegistry
  // + hiveMemberHarnessScopes). Best-effort: a registry read failure degrades to the
  // hive-home-slug-only read rather than 500ing the rollup.
  'featuresConsolidated.byHive': {
    argsSchema: z.object({ hiveHomeSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { hiveHomeSlug, workspaceId } = args as { hiveHomeSlug: string; workspaceId?: string };
      const memberSlugs = await resolveHiveMemberSlugs(hiveHomeSlug, workspaceId);
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq, inArray } = await import('drizzle-orm');
      const t = generated.harnessFeaturesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      const slugFilter = inArray(t.harnessSlug, memberSlugs);
      return (await db
        .select()
        .from(t)
        .where(workspaceId != null ? and(slugFilter, eq(t.workspaceId, workspaceId)) : slugFilter)
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
    // EI-1763: workspace-scope the read (see harnessTextArtifact.byHarness).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { and, desc, eq } = await import('drizzle-orm');
      const t = generated.harnessIssuesConsolidatedInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(
          workspaceId != null
            ? and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId))
            : eq(t.harnessSlug, harnessSlug),
        )
        .orderBy(desc(t.updatedTs))) as unknown[];
    },
  },

  // agentRunsConsolidated.bySlug — agent runs for a harness, latest first.
  //   zql.agentRunsConsolidated.where(harnessSlug).orderBy('ts', 'desc')
  // Each row carries the run's OUTCOME + native resume session id joined from
  // spawned_agents (adv-harness-tab-migration P-023): spawnStatus / exitCode /
  // errorMessage / sessionId, null for pre-spawn-engine rows.
  'agentRunsConsolidated.bySlug': {
    // EI-1763: workspaceId is optional + threaded into the helper's per-workspace
    // scoping (harness_slug is per-workspace-unique on the RLS-bypassing connection).
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      return resolveRunsWithOutcome(harnessSlug, workspaceId);
    },
  },

  // agentRunsConsolidated.recent — agent runs for a harness, latest 50.
  //   zql.agentRunsConsolidated.where(harnessSlug).orderBy('ts', 'desc').limit(50)
  // Same joined outcome projection as .bySlug (P-023).
  'agentRunsConsolidated.recent': {
    // EI-1763: see .bySlug — workspaceId threaded into the helper's scoping.
    argsSchema: z.object({ harnessSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { harnessSlug, workspaceId } = args as { harnessSlug: string; workspaceId?: string };
      return resolveRunsWithOutcome(harnessSlug, workspaceId, 50);
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
      limit: clampedLimit(500, 50),
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
      return jsonSafeRows(await db
        .select()
        .from(t)
        .where(and(eq(t.harnessSlug, harnessSlug), eq(t.workspaceId, workspaceId)))
        .orderBy(desc(t.startedAt))
        .limit(limit));
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
      limit: clampedLimit(500, 50),
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
      return jsonSafeRows(await db
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
        .limit(limit));
    },
  },

  // userActions.recent — workspace-wide (NOT harness-scoped) recent action stream,
  // newest-first. Backs the Overview Activity tile's All-Pots view (no ?slug=): the
  // per-harness userActions.byHarness left that tile blank when no harness was selected
  // (data-sync-push-completion P-006 behavior shift; D-008 follow-up closes it).
  // NOTE (D-011): user_actions is mapped in TABLE_TO_QUERY_NAMES but is APPEND-HEAVY and
  // INTENTIONALLY carries NO per-row emit_change_notify trigger (COVERAGE_EXEMPT; mig 376
  // — a per-row notify on a high-write log is the notify-storm anti-pattern). So this (and
  // byHarness/byKind) does NOT SSE-push on a write today; the Activity tile keeps it live
  // with a bounded client pollIntervalMs until the append-heavy DEBOUNCED-invalidation
  // follow-up (COVERAGE_EXEMPT's P-005 TODO) lands. The bridge entry stays so that
  // follow-up wires straight through.
  //   zql.userActions.where(workspaceId).orderBy('startedAt', 'desc').limit(limit)
  'userActions.recent': {
    argsSchema: z.object({
      workspaceId: z.string(),
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const { workspaceId, limit } = args as { workspaceId: string; limit: number };
      const { getOrgPg, generated } = await import('@papercusp/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.userActionsInHarnessShared;
      const { db } = getOrgPg();
      return jsonSafeRows(await db
        .select()
        .from(t)
        .where(eq(t.workspaceId, workspaceId))
        .orderBy(desc(t.startedAt))
        .limit(limit));
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
      const plans = Array.isArray(r?.plans) ? r.plans : [];
      if (plans.length === 0) return plans;
      // B1 (shared-hive-collaboration P-001): enrich rows with resolved owner +
      // last-editor identity for the ownership badges. Additive + best-effort.
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.PLAN_ATTRIBUTION_BADGES, 'system'))) return plans;
      const { enrichPlanListRows } = await import('./plan-attribution');
      return enrichPlanListRows(plans);
    },
  },
  // plans.byHive — CROSS-MEMBER browse (WI-259 P-006, D-010). Plans across EVERY
  // member harness of a shared hive. Reuses plans.list's read with the member-slug
  // SET (callPlansRead already accepts `harness_slugs` — read-dispatch.ts), so the
  // rows are identical to the per-harness list (each carries its harness_slug =
  // member origin) + the same attribution enrichment. Member-origin-scoped reads
  // (plans.list) are UNCHANGED; this is the explicit cross-member rollup view.
  'plans.byHive': {
    argsSchema: z.object({ hiveHomeSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { hiveHomeSlug, workspaceId } = args as { hiveHomeSlug: string; workspaceId?: string };
      const memberSlugs = await resolveHiveMemberSlugs(hiveHomeSlug, workspaceId);
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('list', { harness_slugs: memberSlugs })) as {
        plans?: unknown[];
      };
      const plans = Array.isArray(r?.plans) ? r.plans : [];
      if (plans.length === 0) return plans;
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.PLAN_ATTRIBUTION_BADGES, 'system'))) return plans;
      const { enrichPlanListRows } = await import('./plan-attribution');
      return enrichPlanListRows(plans);
    },
  },
  // plans.viewer — the current viewer's plan-OWNER identity (their git email),
  // for the plans list "my / others' / all" saved views (shared-hive-collaboration
  // P-002). One row: [{ email }] (email null when unresolvable → UI degrades).
  'plans.viewer': {
    resolve: async () => {
      const { getViewerOwnerEmail } = await import('../agent-tools/plans/viewer-identity');
      const email = await getViewerOwnerEmail();
      return [{ email }];
    },
  },
  'plans.items': {
    resolve: async (args) => {
      const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
      const r = (await callPlansRead('items', (args ?? {}) as Record<string, unknown>)) as {
        items?: unknown[];
      };
      const items = Array.isArray(r?.items) ? r.items : [];
      if (items.length === 0) return items;
      // B1 (shared-hive-collaboration P-001): per-item author attribution.
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.PLAN_ATTRIBUTION_BADGES, 'system'))) return items;
      const { enrichPlanItemsRows } = await import('./plan-attribution');
      return enrichPlanItemsRows(items);
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
      // plans:get is a BULK tool — even a single-slug read returns the runBulk envelope
      // `{ ok, results:[plan], counts }` (get.ts → bulkContent). Unwrap `results[0]` to the
      // single plan so this resolver honors its documented `[PlanGetResult]` contract — the
      // SAME shape the REST `fetchPlan` path gets via `unwrapBulkGet` (routes/admin/plans.ts).
      // Without this the live consumer (PlanItemPreview) renders the envelope, not the plan,
      // AND enrichPlanDetail (below) early-returns on the envelope's missing `frontmatter`, so
      // attribution silently no-ops. A non-envelope shape (a bare `{ error }`, or a test mock)
      // passes through unchanged.
      const plan =
        r && typeof r === 'object' && Array.isArray((r as { results?: unknown }).results)
          ? (r as { results: unknown[] }).results[0]
          : r;
      if (!plan) return [];
      // B1 (shared-hive-collaboration P-001): enrich plan-level owner/last-editor
      // + per-item author for the badges. Additive + best-effort.
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      if (!(await getFlag(FLAGS.PLAN_ATTRIBUTION_BADGES, 'system'))) return [plan];
      // enrichPlanDetail derives the attribution harness from the plan payload's own stamped
      // `harness` (plans:get → row.harnessSlug) — no caller-side operator-home default (WI-374).
      const { enrichPlanDetail } = await import('./plan-attribution');
      return [await enrichPlanDetail(plan)];
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
        limit: clampedLimitOpt(500),
        // (per-hive-learning-loops P-040) the per-Hive lens: a Hive HOME slug
        // narrows the feed to that Hive's member-harness scopes (D-008). Omit ⇒
        // the whole workspace (papercusp + every harness).
        hive: z.string().max(120).optional(),
      })
      .optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as { state?: 'open' | 'resolved' | 'closed'; limit?: number; hive?: string };
      const { readImprovementItems } = await import('../harness/improvements/read-items');
      const { buildDigest } = await import('../harness/improvements/digest');
      const { applyHumanQueueRanking } = await import('../queue-ranker/human-queue');
      const { computeImprovementFlow, readWatchdogFlowTicks } = await import('../harness/improvements/flow-metrics');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { readOwnerFullAutonomyGrant } = await import('../harness/improvements/full-autonomy-grant');
      const nowMs = Date.now();
      // The OWNER FULL-AUTONOMY grant (Phase 2): this resolver IS the owner's Learning-tab
      // view of the queue — keep its auto/human split consistent with the live dispatch so
      // a protected-surface kind=bug isn't shown as "needs your decision" while the loop
      // auto-implements it once the grant is on.
      const ownerFullAutonomy = await readOwnerFullAutonomyGrant(activeWorkspaceId());
      // P-040: resolve the Hive → its member-harness scope set (the Hive is the
      // tenancy unit) so the feed only shows that Hive's improvements. Best-effort:
      // a registry read failure degrades to the unfiltered (workspace) feed rather
      // than 500ing the tab.
      let harnessScopes: string[] | undefined;
      if (a.hive) {
        try {
          const { loadHarnessRegistry, hiveMemberHarnessScopes } = await import('../harness-registry');
          const reg = await loadHarnessRegistry();
          harnessScopes = hiveMemberHarnessScopes(reg.projects, a.hive);
        } catch (err) {
          console.warn('[learning.improvements] hive scope resolution failed:', err instanceof Error ? err.message : err);
        }
      }
      const items = await readImprovementItems({ state: a.state, limit: a.limit, ...(harnessScopes ? { harnessScopes } : {}) });
      // Human lane ordered by the ONE ranker (frontier P-040; feature #1 is
      // consume-edges P-022's blocking impact) — the owner's queue leads with
      // what blocks the most, each item carrying its per-feature breakdown.
      const digest = await applyHumanQueueRanking(buildDigest(items, { nowMs, ownerFullAutonomy }), { candidates: items });
      // FB-15 (P-043): this resolver IS the owner's view of the queue (the
      // improvements:digest tool and the digest routine read elsewhere), so a
      // hit here = the queue was rendered to the owner. Record a throttled
      // queue-view exposure row — the denominator the owner preference model
      // learns "ignored despite being shown" from. Fire-and-forget: capture
      // must never affect the read.
      void import('../owner-preference/interactions')
        .then((m) => m.recordQueueExposure(digest.humanQueue.map((i) => i.id)))
        .catch(() => {});
      // Watchdog ticks are best-effort: a tick-read failure degrades the flow
      // strip to "watchdog: never" rather than 500ing the whole improvements view.
      let ticks: Awaited<ReturnType<typeof readWatchdogFlowTicks>> = [];
      try {
        ticks = await readWatchdogFlowTicks(activeWorkspaceId());
      } catch (err) {
        console.warn('[learning.improvements] watchdog tick read failed:', err instanceof Error ? err.message : err);
      }
      // Dispatch-ledger rollup (consume-edges P-010 / B-04) — same best-effort
      // rule: a ledger read failure degrades the strip's dispatch chip to "—".
      let dispatchStats: import('../harness/improvements/dispatch-ledger').DispatchStats | null = null;
      try {
        const { readRecentDispatches, computeDispatchStats } = await import('../harness/improvements/dispatch-ledger');
        dispatchStats = computeDispatchStats(await readRecentDispatches(activeWorkspaceId()), { nowMs });
      } catch (err) {
        console.warn('[learning.improvements] dispatch ledger read failed:', err instanceof Error ? err.message : err);
      }
      const flow = computeImprovementFlow(items, ticks, {
        nowMs,
        // Reuse the digest's recurrence computation (P-041) — do not re-derive.
        recurringSignatureCount: digest.recurringSignatures.length,
        dispatchStats,
      });
      return [{ ...digest, flow }];
    },
  },

  // ── insights.tokens — the Insights → Tokens subtab (B-TOK-UI / token-tracking-
  // plan-and-briefs-2026-06-20) ──
  //
  // Cache-inclusive token + cost breakdown by model / role / day for ONE harness,
  // over harness_shared.agent_usage_samples. The SIBLING of the SpendCard's single
  // headline total: loadHarnessTokens reuses load-spend's 4-token sum (input +
  // output + cache_read + cache_creation — the B-TOK-2 fix for the ~5× undercount)
  // and groups it so the owner sees WHERE the burn is (opus = 90% of spend,
  // cache-read = 82% of tokens). Workspace + harness scoped via routeWithWorkspace
  // (RLS GUC) PLUS an explicit workspace predicate. Best-effort: the loader degrades
  // a missing column/table to the empty snapshot (never a 500). NOT table-backed —
  // refreshes on mount + the Tokens view's manual invalidate().
  'insights.tokens': {
    argsSchema: z.object({
      harness: z.string().min(1).max(120),
      windowMs: z
        .number()
        .int()
        .positive()
        .max(90 * 24 * 60 * 60 * 1000)
        .optional(),
    }),
    resolve: async (args) => {
      const a = args as { harness: string; windowMs?: number };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { loadHarnessTokens } = await import('../harness-insights/load-tokens');
      const ws = activeWorkspaceId();
      return await routeWithWorkspace(async (tx) => {
        const runQuery = async <T,>(query: string, params: unknown[]): Promise<T[]> =>
          (await tx.unsafe(query, params as never)) as unknown as T[];
        const snapshot = await loadHarnessTokens({
          workspace_id: ws,
          harness_slug: a.harness,
          windowMs: a.windowMs,
          runQuery,
        });
        return [snapshot];
      });
    },
  },

  // ── insights.coordTokens — the Tokens subtab's Coordination panel + price book
  // (B-TOK-ROLL / token-tracking-plan-and-briefs-2026-06-20, B-TOK-3 + B-TOK-4) ──
  //
  // Three workspace-scoped sections from load-token-rollups: (1) the model_pricing
  // RATE book (migration 334 — per-MTok rates incl. the dominant cache-read tier);
  // (2) the COORD-COST breakdown — LLM $ by turn-trigger (deploy-gated population)
  // and by role-class (interactive=user vs fleet=coord-driven, ~96% of spend); (3)
  // the COORD-POLL volume (coord:* MCP-call counts — ≈0 LLM tokens; quantifies the
  // wake-board UI poll that is ~75% of all tool_invocations rows = the "327K
  // coord:wake-queue mystery" = cheap polling, not context-injection). Coord cost is
  // fleet-wide, so `harness` is OPTIONAL (omit → whole workspace). Each loader is
  // independently defensive → a missing column/table degrades that section, never a
  // 500. NOT table-backed — refreshes on mount + manual invalidate.
  'insights.coordTokens': {
    argsSchema: z.object({
      harness: z.string().min(1).max(120).optional(),
      windowMs: z
        .number()
        .int()
        .positive()
        .max(90 * 24 * 60 * 60 * 1000)
        .optional(),
    }),
    resolve: async (args) => {
      const a = args as { harness?: string; windowMs?: number };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { loadModelPricingBook, loadCoordTokenBreakdown, loadCoordPollVolume } = await import(
        '../harness-insights/load-token-rollups'
      );
      const ws = activeWorkspaceId();
      return await routeWithWorkspace(async (tx) => {
        const runQuery = async <T,>(query: string, params: unknown[]): Promise<T[]> =>
          (await tx.unsafe(query, params as never)) as unknown as T[];
        const [pricingBook, coordBreakdown, pollVolume] = await Promise.all([
          loadModelPricingBook(runQuery),
          loadCoordTokenBreakdown({ workspace_id: ws, harness_slug: a.harness, windowMs: a.windowMs, runQuery }),
          loadCoordPollVolume({ workspace_id: ws, windowMs: a.windowMs, runQuery }),
        ]);
        return [{ pricingBook, coordBreakdown, pollVolume }];
      });
    },
  },

  // ── learning.observations — the Observations pane's browse feed ──
  //
  // (turn-end-reflection-observations-2026-06-14 P-044 / D-005). PRE-IDEA sensor
  // readings from the turn-end reflection step, filed in the SEPARATE
  // OBSERVATION_TOPIC lane — they NEVER enter the work/triage queue (that is the
  // whole point: this is browse-only, no ranking/triage/dispatch). Newest first.
  // NOT table-backed (engineer_issues has no emit_change_notify) — refreshes on
  // mount + manual invalidate + the server-side notifySyncInvalidate
  // captureImprovement fires on a lane:observation file.
  'learning.observations': {
    argsSchema: z
      .object({
        state: z.enum(['open', 'resolved', 'closed']).optional(),
        limit: clampedLimitOpt(500),
      })
      .optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as { state?: 'open' | 'resolved' | 'closed'; limit?: number };
      const { listIssues } = await import('../issues-engineer');
      const { OBSERVATION_TOPIC } = await import('../harness/improvements/read-items');
      const issues = await listIssues({ topic: OBSERVATION_TOPIC, state: a.state, limit: a.limit ?? 200 });
      return issues
        .map((i) => {
          const p = i.payload && typeof i.payload === 'object' ? (i.payload as Record<string, unknown>) : {};
          const obs = p.observation && typeof p.observation === 'object' ? (p.observation as Record<string, unknown>) : {};
          const refs = Array.isArray(obs.refs) ? obs.refs.filter((r): r is string => typeof r === 'string') : [];
          return {
            id: i.id,
            title: i.title,
            body: i.body ?? null,
            kind: typeof obs.kind === 'string' ? obs.kind : null,
            scope: typeof obs.scope === 'string' ? obs.scope : i.scope ?? null,
            confidence: typeof obs.confidence === 'string' ? obs.confidence : null,
            refs,
            sourceRole: typeof p.sourceRole === 'string' ? p.sourceRole : null,
            createdAt: i.createdAt,
          };
        })
        .sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
    },
  },

  // ── learning.health — the composite learning-infra status chip ──
  //
  // (self-improvement-consume-edges-2026-06-12 P-003 / D-002). ONE
  // offline/degraded/ok verdict over the learning system's own infra legs —
  // LLM-spine resolvability, the runner spawn path's watchdog key, the gym fire
  // circuit — read from the snapshot the 2-min DBOS tick maintains (a stale or
  // missing snapshot triggers an on-demand evaluation; same transition +
  // notification semantics either way). Returns [] when the
  // LEARNING_INFRA_HEALTH flag is off (the chip hides). NOT table-backed —
  // refreshes on mount + manual invalidate + the server-side
  // notifySyncInvalidate the tick fires on every status change.
  'learning.health': {
    resolve: async () => {
      const { getLearningInfraHealth } = await import('../harness/improvements/learning-infra-health');
      const health = await getLearningInfraHealth();
      return health ? [health] : [];
    },
  },

  // ── health.snapshot — the whole-system Health tab snapshot ──
  //
  // (system-health-tab-2026-06-15 P-003, D-001). ONE `SystemHealth` snapshot —
  // Queen / bees / work-feed / tokens / deploy / infra / plans / escalations /
  // autonomy / observations / improvements / SU fleet — read from the per-
  // workspace cache the ~30s DBOS tick maintains (a stale/missing snapshot
  // triggers an on-demand recompute; computeSystemHealth is fail-soft per panel).
  // Returns [] when the SYSTEM_HEALTH_TAB flag is off (the tab hides). NOT
  // table-backed — refreshes on mount + the server-side notifySyncInvalidate the
  // tick fires each cycle. The SAME aggregation feeds the overwatch brief (C-1).
  'health.snapshot': {
    resolve: async () => {
      const { getSystemHealth } = await import('../system-health');
      const health = await getSystemHealth();
      return health ? [health] : [];
    },
  },

  // ── overwatch.snapshot — the Overwatch pane's current brief ──
  //
  // (overwatch-role-2026-06-15 B-08, D-006). The ACTIONABLE SUBSET of the same
  // `SystemHealth` the Health tab serves — health panels + detected anomalies +
  // suggested nudges. NOT a second aggregation: `getOverwatchSnapshot` reuses the
  // shared system-health cache and maps it via the pure B-03 mapper/detector.
  // SSE-live — `runSystemHealthTick` invalidates this name alongside
  // `health.snapshot` each ~30s tick. Always returns a 1-element array (the
  // fail-soft neutral brief when health is unreadable), so the pane has a shape.
  'overwatch.snapshot': {
    resolve: async () => {
      const { getOverwatchSnapshot } = await import('../overwatch/snapshot');
      return [await getOverwatchSnapshot()];
    },
  },

  // ── overwatch.controlState — the Overwatch pane's header (start/cadence/liveness) ──
  //
  // (overwatch-role-2026-06-15 B-08). The persisted overwatch_started bit + wake
  // cadence (B-07) + live wake liveness (B-09) + the papercusp-overwatch flag
  // (D-009). `overwatch:start` / `overwatch:pause` invalidate this name (wired in
  // B-07), so the header flips the moment the owner starts/pauses the loop.
  'overwatch.controlState': {
    resolve: async () => {
      const { getOverwatchControlState } = await import('../overwatch/snapshot');
      return [await getOverwatchControlState()];
    },
  },

  // ── overwatch.liveness — the Overwatch pane's "is-it-alive?" heartbeat strip ──
  //
  // The proof-of-life the control-state CAN'T give: it derives from the
  // `harness_shared.autoloop_state` row (role='overwatch') that EVERY actual fire
  // stamps (`recordFire`), not the one-shot `overwatch-wake` routine row (which is
  // deactivated between fires, so a healthy-between-runs loop looked identical to a
  // dead one). Returns last-run-at + status + a derived next-run estimate + an
  // ALIVE/STALE verdict (stale once the last fire is older than 2× cadence). The
  // overwatch loop's fire path (`overwatch/loop.ts`) invalidates this name after
  // each `recordFire`, so the strip's countdown + badge refresh live over SSE.
  'overwatch.liveness': {
    resolve: async () => {
      const { getOverwatchLiveness } = await import('../overwatch/snapshot');
      return [await getOverwatchLiveness()];
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
    // (per-hive-learning-loops P-041) the per-Hive lens: a Hive HOME slug
    // narrows the gym proposals + autoloops to that Hive's gym harness. The gym
    // is scoped per (workspace_id, harness_slug); the Hive home slug IS the gym
    // harness_slug, so the filter is a direct harness_slug match. Omit ⇒ the
    // cross-harness workspace rollup (unchanged default).
    argsSchema: z.object({ hive: z.string().max(120).optional() }).optional(),
    resolve: async (args) => {
      const a = (args ?? {}) as { hive?: string };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { listRecentProposalsForWorkspace, listAutoloopsForWorkspace } = await import('../gym/control-plane');
      const ws = activeWorkspaceId();
      const harnessSlug = a.hive || undefined;
      return await routeWithWorkspace(async (tx) => {
        const [proposals, autoloops] = await Promise.all([
          listRecentProposalsForWorkspace(tx, { workspaceId: ws, limit: 50, ...(harnessSlug ? { harnessSlug } : {}) }),
          listAutoloopsForWorkspace(tx, { workspaceId: ws, ...(harnessSlug ? { harnessSlug } : {}) }),
        ]);
        return [{ proposals, autoloops }];
      });
    },
  },

  // ── plans.scheduledOccurrences — the Calendar tab's events (scheduled-recurring-plans P-018/P-019/P-026) ──
  //
  // All scheduled-plan occurrences in a [rangeStartMs, rangeEndMs] window, expanded
  // server-side from each template's RRULE/cron/one-shot (the rrule lib is the single
  // source of truth; the calendar UI lib stays swappable — D-004). Workspace-scoped
  // via the active-workspace ALS; the harness_shared.harness_plans filter is by
  // workspace_id (shared table, no schema routing). Best-effort: a read error degrades
  // to [] rather than a 500, so the calendar shows its empty state.
  'plans.scheduledOccurrences': {
    argsSchema: z.object({
      rangeStartMs: z.number().int(),
      rangeEndMs: z.number().int(),
      harnessSlug: z.string().max(200).optional(),
    }),
    resolve: async (args) => {
      const a = args as { rangeStartMs: number; rangeEndMs: number; harnessSlug?: string };
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { getOrgPg } = await import('@papercusp/db-org');
        const { gatherScheduledOccurrences } = await import('../harness/routines/scheduled-occurrences');
        const { sql } = getOrgPg();
        return await gatherScheduledOccurrences(sql, {
          workspaceId: activeWorkspaceId(),
          rangeStartMs: a.rangeStartMs,
          rangeEndMs: a.rangeEndMs,
          ...(a.harnessSlug ? { harnessSlug: a.harnessSlug } : {}),
        });
      } catch (err) {
        console.warn('[plans.scheduledOccurrences] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── plans.schedule — one row per scheduled plan's RAW authored schedule (P-020 / D-020) ──
  //
  // The calendar's schedule editor pre-fills from this, and the per-occurrence
  // EXDATE/RDATE drag reads the source RRULE here. Window-independent (unlike
  // scheduledOccurrences) so a plan whose next fire is outside the calendar view
  // — or opened from the "Schedule a plan" picker — is still editable. Best-effort:
  // a read error degrades to [] so the editor opens fresh (replace-mode).
  'plans.schedule': {
    argsSchema: z.object({ harnessSlug: z.string().max(200).optional() }),
    resolve: async (args) => {
      const a = args as { harnessSlug?: string };
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { getOrgPg } = await import('@papercusp/db-org');
        const { listPlanSchedules } = await import('../harness/routines/scheduled-occurrences');
        const { sql } = getOrgPg();
        return await listPlanSchedules(sql, {
          workspaceId: activeWorkspaceId(),
          ...(a.harnessSlug ? { harnessSlug: a.harnessSlug } : {}),
        });
      } catch (err) {
        console.warn('[plans.schedule] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── plans.runHistory — the Runs tab's per-template run history + rollup (scheduled-recurring-plans P-022/P-024) ──
  //
  // Distinct from `plans.runs` (the Agents-tab flat PlanRun[] keyed on { slug }):
  // this is the enriched run history for one template (outcome, duration, trigger,
  // work-item rollup, cost) + the computed rollup (success rate, median duration,
  // regression flags) for the summary header, keyed on { planSlug }. Returns a
  // 1-element array [{ runs, rollup }] (cf. learning.apiary). Read-only — the routine
  // tick settles outcomes; this does not reconcile (no side effects on a UI read).
  // Best-effort: a read error degrades to empty so the tab shows its empty state.
  'plans.runHistory': {
    argsSchema: z.object({
      planSlug: z.string().min(1),
      harnessSlug: z.string().max(200).optional(),
    }),
    resolve: async (args) => {
      const a = args as { planSlug: string; harnessSlug?: string };
      try {
        const { listPlanRuns, computePlanRunRollup } = await import('../agent-tools/plans/runs');
        const runs = await listPlanRuns(a.planSlug, a.harnessSlug ? { harnessSlug: a.harnessSlug } : {});
        return [{ runs, rollup: computePlanRunRollup(runs) }];
      } catch (err) {
        console.warn('[plans.runs] read failed:', err instanceof Error ? err.message : err);
        return [{ runs: [], rollup: null }];
      }
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

  // ── learning.hiveEvalTrend — the Benchmark view's "Hive orchestration" trend (HE-07, P-050) ──
  //
  // The Hive-RUN evaluation scoreboard: one summary row per code generation (instance),
  // newest-first, over the hive_eval instances/runs/scores tables (migrations 264/268). The
  // SIBLING of learning.apiary — its OWN tables, so Hive-run scores never contaminate the apiary
  // instance-evolution trend (D-011). Scoped to the current rubric so incomparable scores never
  // mix. Returns a 1-element array { instances }. NOT table-backed — refreshes on mount + manual
  // invalidate (the cadence fires notifySyncInvalidate on a new generation). Best-effort: the live
  // cadence is owner-gated (P-051), so pre-baseline a missing table / PG error degrades to
  // instances:[] — the clean empty state, not a 500 (mirrors learning.apiary's P-042 degrade).
  'learning.hiveEvalTrend': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readHiveEvalInstanceSummaries } = await import('../hive-eval/trend-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => {
          const instances = await readHiveEvalInstanceSummaries(tx, { workspaceId: ws, limit: 20 });
          return [{ instances }];
        });
      } catch (err) {
        // Pre-baseline, the hive_eval tables don't exist yet: the live cadence is owner-gated
        // (P-051) and the store uses raw SQL not the generated schema (D-011/D-015), so the tables
        // boot-apply only on the next migration run. A missing table (42P01 undefined_table) is the
        // EXPECTED empty state — degrade to [] SILENTLY (no warn). Warn only on a genuine error, so
        // the structural resolver test (which runs the generated schema) stays clean.
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && !/does not exist/i.test(msg)) {
          console.warn('[learning.hiveEvalTrend] hive-eval trend read failed:', msg);
        }
        return [{ instances: [] }];
      }
    },
  },

  // ── learning.bakeoff — the Benchmark view's framework bake-off trend (plan-implementation-
  // framework-2026-06-15 P-014, activation of P-007/P-009) ──
  //
  // One trend row per framework bake-off run (a flag A/B result), newest-first, over the
  // hive_eval_bakeoff_deltas table (migration 293). The A-vs-B proof per bet: did flipping the flag
  // ON beat baseline? Returns a 1-element array { rows }. Best-effort like learning.hiveEvalTrend —
  // the first bake-off is owner-attended + the store uses raw SQL (not the generated schema), so
  // pre-baseline a missing table (42P01) degrades SILENTLY to rows:[] (the clean empty state, not a
  // 500, so the structural resolver test stays clean). runBetBakeoff fires
  // notifySyncInvalidate('learning.bakeoff') after persisting a new result.
  'learning.bakeoff': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readBakeoffTrendRows } = await import('../hive-eval/bakeoff-store');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => {
          const rows = await readBakeoffTrendRows(tx, { workspaceId: ws, limit: 50 });
          return [{ rows }];
        });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && !/does not exist/i.test(msg)) {
          console.warn('[learning.bakeoff] bake-off trend read failed:', msg);
        }
        return [{ rows: [] }];
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
  // ── autonomy.policy — the Queen autonomy policy (queen-autonomy-policy B-03) ──
  //
  // Per-category risk ceilings / locks / graduated levels for the active
  // workspace (harness_shared.autonomy_policy, migration 259), decorated by
  // decoratePolicyForView with the derived effectiveCeiling (min(ceiling,
  // graduated); locked ⇒ none) PLUS the category display metadata the owner
  // settings surface (B-15) renders — label / protected / suggestedPosture /
  // covers — so the client needs no operator-core import (categories.ts stays the
  // single source of truth, D-009). readAutonomyPolicy returns ALL 13 canonical
  // categories — stored rows overlaid on the behavior-neutral defaults — so the
  // surface always renders a complete policy, and a not-yet-applied migration
  // degrades to all-defaults (42P01 swallowed in the store, never a 500). NOT
  // table-backed: autonomy:policy_set / the B-15 write route fire
  // notifySyncInvalidate('autonomy.policy') after each write.
  'autonomy.policy': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readAutonomyPolicy } = await import('../autonomy/policy-store');
      const { decoratePolicyForView } = await import('../autonomy/policy-view');
      const rows = await readAutonomyPolicy(getOrgPg().sql, activeWorkspaceId());
      return rows.map(decoratePolicyForView);
    },
  },

  // ── autonomy.graduation — graduation-eligible standings (queen-autonomy-policy B-16 / P-082; surface P-032) ──
  //
  // Per-category trust-graduation TARGETS: the autonomy level the tripwire
  // evidence has EARNED (clamped ≤ ceiling) vs the current graduated_level, and
  // whether the owner may ratify a promotion (`shouldWrite` — target > current AND
  // not locked/protected/pinned). Recomputed from the autonomy_tripwires ledger
  // (mig 266, B-16) + the policy; categories with no evidence are OMITTED, so this
  // resolves to [] while the system is dark (nothing armed → the settings
  // graduation surface shows its nothing-eligible state, never a 500 — the store
  // swallows a not-yet-applied migration). Mirrors the autonomy:graduation_status
  // tool. Invalidated by a graduatedLevel write (the autonomy-policy-set route).
  'autonomy.graduation': {
    resolve: async () => {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readTripwireEvidence } = await import('../autonomy/tripwire/store');
      const { readAutonomyPolicy } = await import('../autonomy/policy-store');
      const { getCategory } = await import('../autonomy/categories');
      const { computeAutonomyStandings, computeCategoryGraduationTargets, DEFAULT_AUTONOMY_GRADUATION_POLICY } =
        await import('../autonomy/tripwire/graduation');
      const sql = getOrgPg().sql;
      const ws = activeWorkspaceId();
      const nowMs = Date.now();
      const rows = await readTripwireEvidence(sql, ws, { lookbackDays: 90, nowMs });
      const standings = computeAutonomyStandings(rows, DEFAULT_AUTONOMY_GRADUATION_POLICY, nowMs);
      const policies = await readAutonomyPolicy(sql, ws);
      const policyMap = new Map(policies.map((p) => [p.category, p]));
      const targets = computeCategoryGraduationTargets(standings, policyMap, DEFAULT_AUTONOMY_GRADUATION_POLICY);
      return targets.map((t) => ({ ...t, label: getCategory(t.category)?.label ?? t.category }));
    },
  },

  // ── decision.ledger — the Queen decision ledger (queen-autonomy-policy B-13 / P-113) ──
  //
  // The two-layer D-012 ledger (harness_shared.decision_ledger, migrations 260 +
  // 265): action-chokepoint rows (every governed action that ran — B-06/P-110) +
  // decider-disposition rows (the Queen's per-item choices — P-111). Filterable by
  // layer / posture / category / disposition / time. Backs the settings
  // recent-auto-decisions feed (P-031 — pass {layer:'disposition'}). A
  // not-yet-applied migration degrades to [] (the feed shows its empty state, never
  // a 500). Invalidated by recordDecisionDisposition after a disposition write (the
  // feed-relevant, low-volume layer); the high-volume action emit does NOT
  // invalidate.
  'decision.ledger': {
    argsSchema: z.object({
      layer: z.enum(['action', 'disposition']).optional(),
      posture: z.enum(['auto', 'proposed', 'gated', 'rejected']).optional(),
      category: z.string().min(1).max(60).optional(),
      disposition: z.enum(['act', 'defer', 'reject', 'route-to-research', 'no-op']).optional(),
      sinceHours: z.number().positive().max(24 * 90).optional(),
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const a = args as {
        layer?: 'action' | 'disposition';
        posture?: string;
        category?: string;
        disposition?: string;
        sinceHours?: number;
        limit: number;
      };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { readDecisionLedger } = await import('../decision-ledger/read');
      try {
        return await readDecisionLedger(activeWorkspaceId(), {
          ...(a.layer ? { layer: a.layer } : {}),
          ...(a.posture ? { posture: a.posture } : {}),
          ...(a.category ? { category: a.category } : {}),
          ...(a.disposition ? { disposition: a.disposition } : {}),
          ...(a.sinceHours != null ? { sinceMs: Date.now() - a.sinceHours * 3_600_000 } : {}),
          limit: a.limit,
        });
      } catch (err) {
        console.warn(
          '[decision.ledger] read failed (migration 260/265 pending?):',
          err instanceof Error ? err.message : err,
        );
        return [];
      }
    },
  },

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
        // Attach the memory-precision trend (relight P-033) — best-effort, and a
        // not-yet-applied migration 312 (42P01) degrades to the empty snapshot so
        // the MemoryHealthCard renders its nothing-benchmarked state, never a 500.
        try {
          const { readMemoryPrecision } = await import('../memory/bench/precision-read');
          const { activeWorkspaceId } = await import('../workspace-registry');
          memory.precision = await readMemoryPrecision(getOrgPg().sql, activeWorkspaceId());
        } catch (err) {
          if ((err as { code?: string }).code !== '42P01') {
            console.warn('[learning.knowledge] memory precision read failed:', err instanceof Error ? err.message : err);
          }
          const { EMPTY_PRECISION_SNAPSHOT } = await import('../memory/bench/precision-read');
          memory.precision = EMPTY_PRECISION_SNAPSHOT;
        }
      } catch (err) {
        console.warn('[learning.knowledge] memory health read failed:', err instanceof Error ? err.message : err);
      }
      return [{ insights, memory }];
    },
  },

  // ── learning.efficacy — the Learning tab's "is the system actually learning" panel ──
  //
  // The complement to the flow strip's THROUGHPUT (in/out/recurring/watchdog): four
  // EFFICACY metrics that say whether the learning HELD (relight-self-learning-edges
  // P-020) — auto-fix survival (matured fix-survival bets), champion score-delta vs
  // the gen-0 baseline (the beekeeper IQ-battery trend), recurrence-decay (verified
  // vs recurred lifecycle), and memory FP@5 (the P-033 bench). Every metric degrades
  // honestly (ok / warming / none) — most of this data is YOUNG. Each read is
  // best-effort and independent: one source failing leaves the others intact.
  // Returns a 1-element array (client reads data[0]); the producers fire
  // notifySyncInvalidate('learning.efficacy') as their data lands.
  'learning.efficacy': {
    resolve: async () => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const {
        EMPTY_EFFICACY,
        GEN0_BASELINE,
        readAutoFixSurvival,
        readRecurrenceDecay,
        championDeltaMetric,
        memoryFpAt5Metric,
      } = await import('../learning/efficacy-read');

      let ws: string;
      let sql: ReturnType<typeof getOrgPg>['sql'];
      try {
        ws = activeWorkspaceId();
        sql = getOrgPg().sql;
      } catch (err) {
        console.warn('[learning.efficacy] no workspace/PG:', err instanceof Error ? err.message : err);
        return [EMPTY_EFFICACY];
      }

      const result = { ...EMPTY_EFFICACY, gen0Baseline: { ...GEN0_BASELINE } };

      try {
        result.autoFixSurvival = await readAutoFixSurvival(sql, ws);
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.efficacy] auto-fix survival read failed:', err instanceof Error ? err.message : err);
        }
      }
      try {
        result.recurrenceDecay = await readRecurrenceDecay(sql, ws);
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.efficacy] recurrence-decay read failed:', err instanceof Error ? err.message : err);
        }
      }
      try {
        const { readApiaryInstanceSummaries } = await import('../iq-battery/benchmark-read');
        const { routeWithWorkspace } = await import('../route-workspace');
        const summaries = await routeWithWorkspace(async (tx) =>
          readApiaryInstanceSummaries(tx, { workspaceId: ws, limit: 20 }),
        );
        result.championDelta = championDeltaMetric(summaries, GEN0_BASELINE.composite);
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.efficacy] champion-delta read failed:', err instanceof Error ? err.message : err);
        }
      }
      try {
        const { readMemoryPrecision } = await import('../memory/bench/precision-read');
        result.memoryFpAt5 = memoryFpAt5Metric(await readMemoryPrecision(sql, ws));
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.efficacy] memory FP@5 read failed:', err instanceof Error ? err.message : err);
        }
      }

      return [result];
    },
  },

  // ── learning.demand — the Knowledge view's missing-knowledge demand panel ──
  //
  // The negative-space miner's demand map (self-learning-frontier-2026-06-12
  // P-010 / FB-04): zero-hit docs/plans/memory searches aggregated into
  // harness_shared.negative_space_demand (migration 245) by the
  // system:negative-space-mine cadence. Hottest entries + rollups; PG failure
  // OR a not-yet-applied migration degrades to the empty snapshot (the panel
  // renders its nothing-mined state, never a 500). Returns a 1-element array
  // (client reads data[0]). NOT table-backed — the miner fires
  // notifySyncInvalidate('learning.demand') after each tick.
  'learning.demand': {
    resolve: async () => {
      const { EMPTY_DEMAND_SNAPSHOT, readDemandSnapshot } = await import('../negative-space/demand-read');
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { getOrgPg } = await import('@papercusp/db-org');
        return [await readDemandSnapshot(getOrgPg().sql, activeWorkspaceId())];
      } catch (err) {
        // 42P01 (undefined table) = migration 245 not applied yet — the
        // expected pre-boot-apply state, not worth a warn.
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.demand] demand read failed:', err instanceof Error ? err.message : err);
        }
        return [EMPTY_DEMAND_SNAPSHOT];
      }
    },
  },

  // ── learning.ekg — the Benchmark view's Fleet EKG panel ──
  //
  // The Fleet EKG's shift reports + vitals (self-learning-frontier-2026-06-12
  // P-030 / FB-10): session behavioral vectors in fleet_ekg_sessions and
  // detected distribution shifts in fleet_ekg_shifts (migration 251), written
  // by the system:fleet-ekg-scan cadence. PG failure OR a not-yet-applied
  // migration degrades to the empty snapshot (the panel renders its
  // nothing-scanned state, never a 500). Returns a 1-element array (client
  // reads data[0]). NOT table-backed — the scan fires
  // notifySyncInvalidate('learning.ekg') after each tick.
  'learning.ekg': {
    resolve: async () => {
      const { EMPTY_EKG_SNAPSHOT, readEkgSnapshot } = await import('../fleet-ekg/ekg-read');
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { getOrgPg } = await import('@papercusp/db-org');
        return [await readEkgSnapshot(getOrgPg().sql, activeWorkspaceId())];
      } catch (err) {
        // 42P01 (undefined table) = migration 251 not applied yet — the
        // expected pre-boot-apply state, not worth a warn.
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.ekg] ekg read failed:', err instanceof Error ? err.message : err);
        }
        return [EMPTY_EKG_SNAPSHOT];
      }
    },
  },

  // ── learning.redQueen — the Benchmark view's MTTSH vital sign ──
  //
  // Red Queen drill vitals (self-learning-frontier-2026-06-12 P-031 / FB-20):
  // per-class mean-time-to-self-heal medians (detect → triage → fix), resolve
  // rate, triage accuracy vs planted ground truth, and the zero-leak record,
  // computed over harness_shared.red_queen_drills (migration 255). PG failure
  // OR a not-yet-applied migration degrades to the empty snapshot (the panel
  // renders its no-drills state, never a 500). Returns a 1-element array
  // (client reads data[0]). NOT table-backed — the drill cycle fires
  // notifySyncInvalidate('learning.redQueen') after each run.
  'learning.redQueen': {
    resolve: async () => {
      const { EMPTY_MTTSH_VITALS } = await import('../red-queen/mttsh');
      try {
        const { readMttshVitalsSnapshot } = await import('../red-queen/store');
        const { getOrgPg } = await import('@papercusp/db-org');
        return [await readMttshVitalsSnapshot(getOrgPg().sql)];
      } catch (err) {
        // 42P01 (undefined table) = migration 255 not applied yet — the
        // expected pre-boot-apply state, not worth a warn.
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.redQueen] vitals read failed:', err instanceof Error ? err.message : err);
        }
        return [EMPTY_MTTSH_VITALS];
      }
    },
  },

  // ── learning.queenWakeEfficiency — the Benchmark view's Queen per-wake efficiency ──
  //
  // The live Queen's per-wake prompt efficiency (queen-brief-cache-assembly-2026-06-13 B-06 /
  // P-010, D-016/D-018) over harness_shared.agent_usage_samples role='queen' (queenWakeEfficiency):
  // cache-hit ratio (Win-1 frozen-prefix cache), avg turns/wake (Win-2 round-trip elimination),
  // cachedWakes (the "cache is real" signal, P-003), and token/cost totals. Workspace-wide (all
  // Queen wakes). PG failure OR a not-yet-applied migration (272 turn_count) degrades to the empty
  // aggregate — the panel renders its no-wakes state, never a 500. Returns a 1-element array (client
  // reads data[0]). NOT table-backed — refreshes on mount + the panel's manual invalidate() (the
  // metric is sparse, mirroring learning.ekg / learning.redQueen).
  'learning.queenWakeEfficiency': {
    resolve: async () => {
      const { queenWakeEfficiency, EMPTY_QUEEN_WAKE_EFFICIENCY } = await import('../hive/queen-wake-efficiency');
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        return [await queenWakeEfficiency(activeWorkspaceId(), { limit: 50 })];
      } catch (err) {
        // 42P01 (undefined table) / 42703 ("column does not exist", pre-mig-272 turn_count) are the
        // expected pre-boot-apply states, not worth a warn — degrade silently to the empty aggregate.
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && code !== '42703' && !/does not exist/i.test(msg)) {
          console.warn('[learning.queenWakeEfficiency] read failed:', msg);
        }
        return [EMPTY_QUEEN_WAKE_EFFICIENCY];
      }
    },
  },

  // ── p2p.* — the P2P work-sharing settings surface (p2p-work-distribution P-002) ──
  //
  // `p2p.settings` is a workspace-singleton (client subscribes with NO args → the
  // p2p-settings-set write route emits NAME-ONLY notifySyncInvalidate('p2p.settings')).
  // Degrades to the baked (structurally inert) defaults on any read failure — the
  // settings page renders, never a 500.
  'p2p.settings': {
    resolve: async () => {
      const store = await import('../p2p/settings');
      try {
        return [await store.readP2pSettings()];
      } catch (err) {
        console.warn('[p2p.settings] read failed:', err instanceof Error ? err.message : String(err));
        const { activeWorkspaceId } = await import('../workspace-registry');
        const baked = store.bakedP2pDefaults();
        return [
          {
            workspaceId: activeWorkspaceId(),
            baked,
            defaultLayer: null,
            overrideLayer: null,
            effective: baked,
          },
        ];
      }
    },
  },

  // `p2p.devices` — the Identity & devices section (P-002): the LOCAL actor
  // identity (github user + device pubkey) plus, per hive membership, each
  // attested device and whether THIS device is missing from a hive's
  // attestations. Discriminated rows: one {kind:'identity'} row (always first;
  // null fields = identity unresolved → the page shows RED, never silence),
  // then {kind:'device'} rows, then a {kind:'missing'} row per hive where the
  // local device has no live attestation (grants resolve ONLY through attested
  // devices — P-001/X9 — so "missing" means P2P-inert on that hive).
  'p2p.devices': {
    resolve: async () => {
      const rows: unknown[] = [];
      try {
        const { resolveUsageActor } = await import('../harness/usage-actor');
        const actor = await resolveUsageActor().catch(() => null);
        rows.push({
          kind: 'identity',
          githubUserId: actor?.githubUserId ?? null,
          devicePubkey: actor?.devicePubkey ?? null,
        });
        if (!actor) return rows;

        const { getOrgPg } = await import('@papercusp/db-org');
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { sql } = getOrgPg();
        const members = (await sql`
          SELECT hive_home_slug, device_attestations, revoked_pubkeys
            FROM harness_shared.hive_members
           WHERE workspace_id = ${activeWorkspaceId()}
             AND github_user_id = ${actor.githubUserId}
           ORDER BY hive_home_slug`) as unknown as Array<{
          hive_home_slug: string;
          device_attestations: unknown;
          revoked_pubkeys: unknown;
        }>;
        for (const m of members) {
          const atts = Array.isArray(m.device_attestations)
            ? (m.device_attestations as Array<Record<string, unknown>>)
            : [];
          const revoked = new Set(
            Array.isArray(m.revoked_pubkeys) ? (m.revoked_pubkeys as string[]) : [],
          );
          let thisDeviceLive = false;
          for (const a of atts) {
            const pubkey = typeof a.device_pubkey === 'string' ? a.device_pubkey : '';
            const isRevoked = revoked.has(pubkey);
            const isThisDevice = pubkey === actor.devicePubkey;
            if (isThisDevice && !isRevoked) thisDeviceLive = true;
            rows.push({
              kind: 'device',
              hiveHomeSlug: m.hive_home_slug,
              devicePubkey: pubkey,
              deviceLabel: typeof a.device_label === 'string' ? a.device_label : null,
              attestedAtMs: typeof a.created_at === 'number' ? a.created_at : null,
              gistUrl: typeof a.gist_url === 'string' ? a.gist_url : null,
              revoked: isRevoked,
              isThisDevice,
            });
          }
          if (!thisDeviceLive) {
            rows.push({ kind: 'missing', hiveHomeSlug: m.hive_home_slug });
          }
        }
        return rows;
      } catch (err) {
        console.warn('[p2p.devices] read failed:', err instanceof Error ? err.message : String(err));
        // Degrade to "identity unresolved" (a RED state on the page), never a 500.
        return rows.length > 0 ? rows : [{ kind: 'identity', githubUserId: null, devicePubkey: null }];
      }
    },
  },

  // `p2p.audit` — the P-002 Audit section: p2p:*-prefixed audit_log rows
  // (kill-switch flips + starter-profile applies now; grant changes + refusal
  // receipts join as P-001/P-004 land — same prefix convention).
  'p2p.audit': {
    argsSchema: z.object({ limit: z.number().int().positive().max(200).default(50) }),
    resolve: async (args) => {
      const { limit } = args as { limit: number };
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { sql } = getOrgPg();
        return (await sql`
          SELECT id, ts, actor, action, subject, details
            FROM harness_shared.audit_log
           WHERE workspace_id = ${activeWorkspaceId()}
             AND action LIKE 'p2p:%'
           ORDER BY ts DESC
           LIMIT ${limit}`) as unknown as unknown[];
      } catch (err) {
        console.warn('[p2p.audit] read failed:', err instanceof Error ? err.message : String(err));
        return [];
      }
    },
  },

  // ── trust.list — the owner's LOCAL trusted-GitHub-user list ──
  //
  // The trust list (listTrustedUsers, ws-scoped D-004) the /settings/trust owner surface renders +
  // the admission gate (work-items-admission.ts) consults so a VERIFIED trusted author's remote work
  // auto-runs (shared-hive-trust-admission-2026-06-14 Phase 4 / P-011, Trust A4). Returns the flat
  // TrustedUser[] (client reads `data` as the array). NOT table-backed — the trust-set write route
  // fires notifySyncInvalidate('trust.list'). A not-yet-applied migration (276) degrades to [] — the
  // page renders its empty state, never a 500.
  'trust.list': {
    resolve: async () => {
      const { listTrustedUsers } = await import('../trust/user-trust-list');
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        return await listTrustedUsers(activeWorkspaceId());
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code !== '42P01' && code !== '42703' && !/does not exist/i.test(msg)) {
          console.warn('[trust.list] read failed:', msg);
        }
        return [];
      }
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
        return [{ totalRouted: 0, railCounts: [], recent: [], lastTick: null, lensWeights: null }];
      }
    },
  },

  // ── learning.experiments — the experiment_runs scoreboard (experiment-registry-
  // invocation-api P-051). Returns recent runs (flat array), RLS-scoped via
  // routeWithWorkspace; degrades to [] before the migration applies (42P01).
  'learning.experiments': {
    argsSchema: z.object({
      testId: z.string().optional(),
      limit: clampedLimitOpt(200),
    }),
    resolve: async (args) => {
      const a = (args ?? {}) as { testId?: string; limit?: number };
      try {
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { routeWithWorkspace } = await import('../route-workspace');
        const { PgExperimentLedger } = await import('../experiment/ledger');
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) =>
          new PgExperimentLedger(tx).listRecent(ws, { testId: a.testId, limit: a.limit ?? 20 }),
        );
      } catch (err) {
        if ((err as { code?: string }).code !== '42P01') {
          console.warn('[learning.experiments] read failed:', err instanceof Error ? err.message : err);
        }
        return [];
      }
    },
  },

  // ── learning.hiveThroughput — Queen-loop throughput metrics (B-11 / P-050) ──
  //
  // Per-hive throughput ticks (migration 261): latest metric cards + a recent
  // trend window + the operating-well verdict, for the Learning tab's
  // "Throughput" sub-view. Best-effort: a pre-migration substrate / read failure
  // degrades to the empty snapshot (the tab shows "no throughput recorded yet"),
  // never a 500. Pushed by recordHiveThroughputTick (the 30s routinesTick edge).
  // Returns a 1-element array (client reads data[0]).
  'learning.hiveThroughput': {
    argsSchema: z.object({ hive: z.string().max(120).optional() }),
    resolve: async (args) => {
      const hive = typeof (args as { hive?: unknown })?.hive === 'string' ? (args as { hive: string }).hive : undefined;
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { routeWithWorkspace } = await import('../route-workspace');
      const { readHiveThroughputSnapshot } = await import('./learning-hive-throughput-read');
      try {
        const ws = activeWorkspaceId();
        return await routeWithWorkspace(async (tx) => [
          await readHiveThroughputSnapshot(tx, ws, hive ? { hiveSlug: hive } : {}),
        ]);
      } catch (err) {
        console.warn('[learning.hiveThroughput] read failed:', err instanceof Error ? err.message : err);
        return [{ hives: [] }];
      }
    },
  },

  // ── learning.soakReport — machine-checkable production-readiness gate (WI-1501) ──
  //
  // One hive-soak verdict per hive: READY only when the rolling 12–24h window stays
  // healthy across bg-host stability, infra curses, bee/queen/overwatch turn success,
  // escalation backlog, green-checkpoint ratio, and deploy latency. Derived on demand
  // from existing durable signals + the local bg-host journal. Returns a 1-element array
  // (client reads data[0]). Fail-soft: an individual hive read failure is omitted rather
  // than taking the whole panel down.
  'learning.soakReport': {
    argsSchema: z.object({
      hive: z.string().max(120).optional(),
      windowHours: z.number().int().min(12).max(24).optional(),
    }),
    resolve: async (args) => {
      const hive = typeof (args as { hive?: unknown })?.hive === 'string' ? (args as { hive: string }).hive : undefined;
      const windowHours =
        typeof (args as { windowHours?: unknown })?.windowHours === 'number'
          ? (args as { windowHours: number }).windowHours
          : undefined;
      try {
        const { listHives } = await import('../agent-tools/hive/_resolve');
        const { activeWorkspaceId } = await import('../workspace-registry');
        const { readHiveSoakReport } = await import('../hive/soak-report');
        const ws = activeWorkspaceId();
        const homes = hive ? [{ slug: hive }] : await listHives(ws).catch(() => []);
        const reports = (
          await Promise.all(
            homes.map(async (home) => {
              try {
                return await readHiveSoakReport(home.slug, { windowHours });
              } catch {
                return null;
              }
            }),
          )
        ).filter((report): report is NonNullable<typeof report> => report != null);
        return [{ hives: reports }];
      } catch (err) {
        console.warn('[learning.soakReport] read failed:', err instanceof Error ? err.message : err);
        return [{ hives: [] }];
      }
    },
  },

  // ── learning.hive — one hive's shared learnings pool (learning-packs P-008) ──
  //
  // Rows + per-pack rollups + organic count for `hive:<args.hive>`, pack
  // provenance annotated (pristine/modified vs the resolvable pack). Returns a
  // 1-element array (client reads data[0]); store-unreachable degrades to the
  // `unavailable` snapshot, never a 500. Invalidated by seed/install/uninstall
  // (`learning.hive`) + the generic memory mutations fire `userMemory.list`,
  // so the view also refreshes on its manual reload.
  'learning.hive': {
    argsSchema: z.object({ hive: z.string().max(120).optional() }),
    resolve: async (args) => {
      const hive = typeof (args as { hive?: unknown })?.hive === 'string' ? (args as { hive: string }).hive : '';
      if (!hive) return [{ hive: '', rows: [], packs: [], organicCount: 0 }];
      const { readHiveLearnings } = await import('./learning-hive-read');
      const { getMemoryBackend } = await import('../memory/backend');
      const { loadLearningPack, listLearningPacks } = await import('../learning-packs/load-packs');
      const snap = await readHiveLearnings(hive, {
        listPool: async (scope) => {
          const backend = getMemoryBackend();
          const avail = await backend.available();
          if (!avail.ok) throw new Error(avail.reason);
          return backend.list({ scope });
        },
        loadPack: (id) => loadLearningPack(id),
      });
      // Decorate the rollups with enabled state (P-009) + adoptable-version
      // info (P-013) — best-effort; the bare snapshot still renders.
      try {
        const [{ disabledPacksFor }, { activeWorkspaceId }, { semverGt }, catalog] = await Promise.all([
          import('../learning-packs/manage'),
          import('../workspace-registry'),
          import('../learning-packs/pack-format'),
          listLearningPacks(),
        ]);
        const disabled = new Set(await disabledPacksFor(activeWorkspaceId(), hive));
        for (const p of snap.packs) {
          p.enabled = !disabled.has(p.packId);
          const avail = catalog.find((c) => c.id === p.packId);
          if (avail) {
            p.availableVersion = avail.version;
            p.updateAvailable = semverGt(avail.version, p.packVersion);
          }
        }
      } catch {
        /* decoration only */
      }
      return [snap];
    },
  },

  // ── learning.hiveList — the workspace's hives for the Learnings view picker ──
  //
  // kind:'hive' registry entries (slug only — display strings resolve client
  // side). Cheap operator-state read; failure degrades to [].
  'learning.hiveList': {
    resolve: async () => {
      try {
        const { loadHarnessRegistry } = await import('../harness-registry');
        const reg = await loadHarnessRegistry();
        return reg.projects
          .filter((p) => p.harness_kind === 'hive')
          .map((p) => ({ slug: p.slug, remote: p.remote_hive === true }));
      } catch (err) {
        console.warn('[learning.hiveList] registry read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── hive.overrides — a hive's per-instance customization (domain-generic-hive-architecture-2026-06-18 P-015) ──
  //
  // The settings-resident, FEDERATED per-hive override surface: the PROSE role-prompt
  // overrides (`promptOverride.<role>` — D-007) AND the STRUCTURED config deltas
  // (`localBlueprint.<section>`, e.g. a ScoutConfigOverride — D-005). Returned as a flat
  // row array (the resolver contract): one row per SET override, `kind` distinguishing
  // prompt vs config, so the /settings/hive-customization editors can reconstruct both
  // maps. The loopback write routes (hive-prompt-override-set / hive-config-set)
  // invalidate this by name. Scoped to the hive's HOME slug (the hive_settings scope
  // column); an unknown/empty hive degrades to [] (never a 500 — the picker shows the
  // empty state).
  'hive.overrides': {
    argsSchema: z.object({ hiveSlug: z.string(), workspaceId: z.string().optional() }),
    resolve: async (args) => {
      const { hiveSlug, workspaceId } = args as { hiveSlug: string; workspaceId?: string };
      try {
        const [{ activeWorkspaceId }, { listHiveInstancePromptOverrides, listHiveLocalBlueprintConfig }] =
          await Promise.all([import('../workspace-registry'), import('../hive-settings-store')]);
        const ws = workspaceId ?? activeWorkspaceId();
        const [prompts, config] = await Promise.all([
          listHiveInstancePromptOverrides(ws, hiveSlug),
          listHiveLocalBlueprintConfig(ws, hiveSlug),
        ]);
        const rows: Array<{ kind: 'prompt' | 'config'; name: string; value: unknown }> = [];
        for (const [role, md] of Object.entries(prompts)) rows.push({ kind: 'prompt', name: role, value: md });
        for (const [section, val] of Object.entries(config)) rows.push({ kind: 'config', name: section, value: val });
        return rows;
      } catch (err) {
        console.warn('[hive.overrides] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── learningPacks.list — the pack catalog (learning-packs-2026-06-11 P-006) ──
  //
  // Resolvable learning packs across the builtin + installed roots (builtin
  // wins on id clash). Backs the creation-flow pack picker and the Learning
  // tab's pack management. Rows flat (one per pack); a read failure degrades
  // to [] — the picker falls back to its default-only option, never a 500.
  // NOT table-backed (FS read); installs/uninstalls fire `learning.hive`
  // + this name explicitly.
  'learningPacks.list': {
    resolve: async () => {
      try {
        const { listLearningPacks } = await import('../learning-packs/load-packs');
        return await listLearningPacks();
      } catch (err) {
        console.warn('[learningPacks.list] read failed:', err instanceof Error ? err.message : err);
        return [];
      }
    },
  },

  // ── learningPacks.candidates — the fleet→pack review queue (consume-edges
  // P-032, B-11). Pending candidates staged by recurrence-escalation, with
  // provenance; the Learnings view renders adopt/dismiss. Stage/decide fire
  // this name explicitly (an adopt also fires learningPacks.list +
  // learning.hive — the version bump lights updateAvailable). Read failure
  // degrades to [] — the strip just disappears, never a 500.
  'learningPacks.candidates': {
    resolve: async () => {
      try {
        const { listLearningPackCandidates } = await import('../learning-packs/candidates');
        return await listLearningPackCandidates({ status: 'pending' });
      } catch (err) {
        console.warn('[learningPacks.candidates] read failed:', err instanceof Error ? err.message : err);
        return [];
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

  // dev.gitPipelineHives — per-hive-git-and-release-gate P-014: the PER-HIVE rows for the
  // /admin/git surface — every repo-backed coding hive that is green-gated (NOT the
  // operator-home, which has its own full view above). Each row: resolved green command
  // (+ owner-override flag), gate 🟩/🟥 status, staging↔main gap, last green sha, last
  // deploy. Empty until a coding hive with a repo is gated (PER_HIVE_RELEASE_GATE is
  // default-OFF during rollout — D-008).
  'dev.gitPipelineHives': {
    resolve: async () => {
      const { gitPipelineHiveRows } = await import('../git-pipeline-hives');
      return await gitPipelineHiveRows();
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
      limit: clampedLimit(200, 50),
    }),
    resolve: async (args) => {
      const { limit } = args as { limit: number };
      const { pgActiveQueries } = await import('../dev-data');
      const { queries } = await pgActiveQueries(limit);
      return queries;
    },
  },

  // dev.telemetry — per-tool invocation rollup (calls / bytes / latency p50/p95 /
  // repeat-within-spawn) over a window. Powers the Tool-usage tab's hot-tools +
  // batching-waste panels (usage-insights P-003/P-004). Flat scalar-array rows.
  'dev.telemetry': {
    argsSchema: z.object({
      hours: z.number().int().positive().max(336).default(24),
      limit: clampedLimit(500, 100),
    }),
    resolve: async (args) => {
      const { hours, limit } = args as { hours: number; limit: number };
      const { telemetryRollup } = await import('../dev-data');
      const { entries } = await telemetryRollup({ workspaceIds: null, hours, limit });
      return entries;
    },
  },

  // dev.toolFormatAdoption — served-format mix (toon/json/csv/none) on the MCP
  // transport over a window: the token-opt compact-adoption signal (P-002/D-002).
  'dev.toolFormatAdoption': {
    argsSchema: z.object({
      hours: z.number().int().positive().max(336).default(24),
    }),
    resolve: async (args) => {
      const { hours } = args as { hours: number };
      const { toolFormatAdoption } = await import('../dev-data');
      const { rows } = await toolFormatAdoption({ workspaceIds: null, hours });
      return rows;
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

  // dev.assignableMembers — the @-assign picker roster (shared-hive-collaboration
  // P-016 / offline-member assign): the LIVE coordination sessions (present,
  // addressed by ownerId — deliver-and-wake now) UNIONed with the workspace's
  // admitted hive members who are NOT currently present (offline, addressed by
  // `@user:gh:<id>`, which PARKS in slot_parked_messages until that member returns).
  // Each row carries a precomputed `assignAddress` (what AssignDialog passes to
  // coord:send's `to`) + `present`, so the dialog labels online vs offline without
  // knowing the `@user:` convention. Deduping an online member OUT of the offline
  // group is best-effort: presence carries no github id today, so the id spaces
  // only converge once gh-auth / federation lights up (actor-identity.ts).
  'dev.assignableMembers': {
    argsSchema: z.object({ workspace: z.string().optional() }),
    resolve: async (args) => {
      const { workspace } = args as { workspace?: string };
      const [{ listPresence }, { listWorkspaceMembers }, { activeWorkspaceId }] = await Promise.all([
        import('../agent-tools/coordination/presence'),
        import('../hive-membership-store'),
        import('../workspace-registry'),
      ]);
      const wsId = workspace ?? activeWorkspaceId();
      const [presence, members] = await Promise.all([
        listPresence({ workspaceId: workspace ?? null }) as Promise<
          Array<{ ownerId: string; ownerLabel: string | null; intent: string | null; userId: string | null; stale?: boolean }>
        >,
        listWorkspaceMembers(wsId).catch(() => []),
      ]);
      const live = presence.filter((p) => !p.stale);
      // Which github members are already represented by a live session? Today
      // presence carries no github id, so this matches only when a session's userId
      // is already a `gh:<id>` form (nothing on a gh-unauth box) — forward-compatible.
      const liveKeys = new Set<string>();
      for (const p of live) {
        if (p.userId) liveKeys.add(p.userId);
        liveKeys.add(p.ownerId);
      }
      const onlineRows = live.map((p) => ({
        assignAddress: p.ownerId,
        key: p.ownerId,
        label: p.ownerLabel ?? p.ownerId,
        present: true,
        intent: p.intent ?? null,
        userId: p.userId ?? null,
        githubUsername: null as string | null,
      }));
      const offlineRows = members
        .filter((m) => !liveKeys.has(`gh:${m.githubUserId}`) && !liveKeys.has(String(m.githubUserId)))
        .map((m) => ({
          assignAddress: `@user:gh:${m.githubUserId}`,
          key: `gh:${m.githubUserId}`,
          label: m.displayName ?? m.githubUsername,
          present: false,
          intent: null as string | null,
          userId: null as string | null,
          githubUsername: m.githubUsername,
        }));
      return [...onlineRows, ...offlineRows];
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
      limit: clampedLimitOpt(500),
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
      // Carry page metadata on row[0]._meta (flat-row sync contract, no envelope).
      return attachListMeta(rows, { total, byKind, nextCursor });
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
      limit: clampedLimit(200, 50),
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
  // started bit (P-004), the pending time wake, the watchdog health signal, and
  // (queen-heartbeat-2026-06-16, owner-priority) the open placements the Queen is
  // DRIVING — so a parked-but-alive Queen visibly shows she's running + what she
  // owns (the owner's "I can't tell she's alive" frustration). Live: hive:start /
  // hive:pause fire `notifySyncInvalidate('hive.controlState', {})`; the heartbeat
  // UI also periodically refetches to keep lastWakeAt / the countdown fresh.
  'hive.controlState': {
    resolve: async () => {
      const { listHives } = await import('../agent-tools/hive/_resolve');
      const { getHivePlacementStarted } = await import('../hive/started');
      const { recentWatchdogFires } = await import('../hive/watchdog');
      const { summarizeOpenPlacements, latestQueenWakeAt } = await import('../hive/placement-watchdog');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const ws = activeWorkspaceId();
      const hives = await listHives(ws).catch(() => []);
      return Promise.all(
        hives.map(async (hv) => {
          // lastWakeAt = the MORE RECENT of the recordHiveWake ledger AND the Queen's
          // REAL queen-spawn wakes. The wake-brain Queen never calls recordHiveWake, so
          // without the real-spawn read the heartbeat shows "Paused/Stalled" while she
          // is alive (the visibility regression). ISO strings sort chronologically.
          const realWake = await latestQueenWakeAt(ws, hv.slug).catch(() => null);
          const lastWakeAt = [realWake, hv.wake?.lastWakeAt ?? null].filter(Boolean).sort().at(-1) ?? null;
          return {
            slug: hv.slug,
            started: await getHivePlacementStarted(ws, hv.slug).catch(() => false),
            nextFireAt: hv.wake?.nextFireAt ?? null,
            lastWakeAt,
            watchdogFires24h: await recentWatchdogFires(ws, hv.slug).catch(() => 0),
            placements: await summarizeOpenPlacements(ws, hv.slug).catch(() => ({
              recovering: 0,
              cursed: 0,
              stranded: 0,
              workingTracked: 0,
              items: [] as Array<{ workItemId: string; status: string; failCount: number; harness: string | null }>,
            })),
          };
        }),
      );
    },
  },

  // hive.steering — the owner steering controls the 👑 Queen tab reads (queen-
  // steering-panel-2026-06-15 B-01, CONTRACT C-1). One row per Hive (mirrors
  // hive.controlState), each the decoded OwnerSteering over the owner-steering:*
  // hive_settings keys: { slug, directive, eligiblePlans, eligibleHives, pauseNewWork, pausedUntil }.
  // A single-hive UI reads data[0]; a multi-hive UI keys by slug. Invalidated
  // explicitly by hive:set-steering (notifySyncInvalidate) AND by the hive_settings
  // table→query map (covers a federated steering write from a peer Swarm).
  'hive.steering': {
    resolve: async () => {
      const { listHives } = await import('../agent-tools/hive/_resolve');
      const { getOwnerSteering, DEFAULT_OWNER_STEERING } = await import('../owner-steering');
      const { activeWorkspaceId } = await import('../workspace-registry');
      const ws = activeWorkspaceId();
      const hives = await listHives(ws).catch(() => []);
      // Throttle defaults (queen-steering-panel P-006, D-006): the SYSTEM defaults
      // the 👑-tab shows beside each session override for its default-vs-override
      // badge — so the UI never hardcodes them. Same numbers the live seams clamp
      // against (cadence = wake floor, maxBees = the spawn-concurrency ceiling).
      // Fail-soft: a read failure degrades each default to null (UI shows "—").
      const throttleDefaults = await (async () => {
        try {
          const [{ hiveWakeFloorSec }, { getCachedRateLimitConfig }, { placementConfig }] = await Promise.all([
            import('../hive/wake'),
            import('../rate-limit-config'),
            import('../hive/placement-watchdog'),
          ]);
          return {
            cadenceFloorSec: hiveWakeFloorSec(),
            maxBees: getCachedRateLimitConfig().maxSimultaneousAgents,
            // P-009 read-through (su-4d71b): the live cursed-item breaker threshold
            // the autonomy-surfacing UI shows read-only (PAPERCUSP_HIVE_PLACEMENT_BREAKER).
            breakerThreshold: placementConfig().breakerThreshold,
          };
        } catch {
          return { cadenceFloorSec: null, maxBees: null, breakerThreshold: null };
        }
      })();
      // HOME-hive stamp (2026-07-01): resolve the workspace's HOME queen the SAME way
      // the loops do (resolveHiveHomeSlug env/ctx chain → operator-home fallback) and
      // mark its row. The 👑-tab used to GUESS the home as "first project with
      // harness_kind:'hive'" — in a workspace with test hives that picked e.g.
      // sb-devboard-hive (paused, woke-never) and the panel showed a dead queen while
      // the real papercusp queen ran. The UI now prefers this stamp.
      const homeSlug = await (async () => {
        try {
          const [{ resolveHiveHomeSlug }, { operatorHomeHarnessSlug }] = await Promise.all([
            import('../hive/wake'),
            import('../harness/operator-home-harness'),
          ]);
          return resolveHiveHomeSlug(null, null) ?? operatorHomeHarnessSlug();
        } catch {
          return null;
        }
      })();
      return Promise.all(
        hives.map(async (hv) => ({
          slug: hv.slug,
          isHome: homeSlug != null && hv.slug === homeSlug,
          ...(await getOwnerSteering(ws, hv.slug).catch(() => DEFAULT_OWNER_STEERING)),
          throttleDefaults,
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

  // network.hive.beacons — the tier-4 dossier's beacon HISTORY (hive-network-
  // surface P-014 item 2 / D-007 GAP 2, migration 236): how a foreign hive's
  // self-reported status evolved, newest-first. `hiveKey` is the C-3 tier-4 row
  // key — DiscoveredHive.hiveId or its pubkey-b64, whichever the drill-in holds.
  // Live: captureBeaconSnapshot fires notifySyncInvalidate on each accepted
  // announce; plus the consumer's standard 60s safety-net refetch.
  'network.hive.beacons': {
    argsSchema: z.object({
      hiveKey: z.string(),
      limit: clampedLimit(500, 50),
    }),
    resolve: async (args) => {
      const { hiveKey, limit } = args as { hiveKey: string; limit: number };
      const { listBeaconHistory } = await import('../network-board/beacon-history-pg');
      return listBeaconHistory(hiveKey, limit);
    },
  },

  // network.hive.asks — the FULL C-1 ask log (hive-network-surface P-014
  // item 2 / D-007 GAP 2): every ledgered request both directions, all states
  // (the board row only carries pending/answered counts), newest-first,
  // optionally narrowed to one tier-4 peer. Rows are CrossHiveAsk objects
  // (incl. askedBy + reply body — the dossier's ask/answer traffic view).
  // Live: sendCrossHiveAsk + the wiring's reply-persist fire
  // notifySyncInvalidate after their writes; 60s safety-net on the consumer.
  'network.hive.asks': {
    argsSchema: z.object({
      peerPubkey: z.string().optional(),
      limit: clampedLimit(500, 100),
      workspace: z.string().optional(),
    }),
    resolve: async (args) => {
      const { peerPubkey, limit, workspace } = args as {
        peerPubkey?: string;
        limit: number;
        workspace?: string;
      };
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { resolveHiveHomeSlug } = await import('../hive/wake');
      const { PgCrossHiveAsks } = await import('../cross-hive-asks-pg');
      const ws = workspace ?? activeWorkspaceId();
      const homeSlug = resolveHiveHomeSlug();
      if (!homeSlug) return [];
      return new PgCrossHiveAsks(ws, homeSlug).list({
        ...(peerPubkey ? { peerPubkey } : {}),
        limit,
      });
    },
  },

  // network.hive.wakes — the hive-SCOPED staged-wake board (hive-network-
  // surface P-014 item 3, closing D-007 GAP 1): the pending_wakes queue
  // narrowed to owners attributed to one hive via fleet assignments, so the
  // per-hive drill-in can grow a real wake board instead of the hive-pane
  // header summary. Flat PendingWake rows (owner ASC, oldest-first — the
  // consumer groups per owner like assemble_wake_board). Live: the
  // pending-wakes writers fire notifySyncInvalidate; 60s safety-net.
  'network.hive.wakes': {
    argsSchema: z.object({
      hive: z.string(),
      workspace: z.string().optional(),
    }),
    resolve: async (args) => {
      const { hive, workspace } = args as { hive: string; workspace?: string };
      const { listHiveWakes } = await import('../network-board/hive-wakes');
      return listHiveWakes(hive, { workspaceId: workspace });
    },
  },

  // network.fleet.wakes — the FLEET-WIDE staged-wake board (EI-597 Step B):
  // every owner's pending wakes in the active workspace, the same full read the
  // pui's non-Hive scopes (fleet / queen / single-owner) used to POLL via
  // coord:wake-queue{action:list}. Moving it onto the sync rail collapses the
  // wake-board poll storm (the fleet's #1/#2 tool-call volume): the same
  // pushWakeBoard() writers that fire `network.hive.wakes` also fire this key on
  // every stage/clear, so the pui refetches on mutation (+ a 60s safety net)
  // instead of every 10s. Payload-equivalent to the old poll (listAllPendingWakes
  // is exactly what coord:wake-queue list returns); the pui keeps its existing
  // client-side filter_wake_groups for the fleet/queen/owner narrowing — so this
  // is the SAME ambient-workspace read the proven network.hive.wakes resolver
  // already relies on (listHiveWakes → listAllPendingWakes). su-dfe5e + su-cf7b0.
  'network.fleet.wakes': {
    argsSchema: z.object({
      // accepted for parity with network.hive.wakes (+ future per-scope use);
      // listAllPendingWakes scopes to the active workspace internally (F-C3).
      workspace: z.string().optional(),
    }),
    resolve: async () => {
      const { listAllPendingWakes } = await import('../agent-tools/coordination/pending-wakes');
      return listAllPendingWakes();
    },
  },

  // network.hiveDirectory — the P2P hive-directory browse list (data-sync-push-
  // completion P-009): the SAME un-muted, un-expired, non-private discovered set
  // GET /api/discovery/hives serves to the desktop WorkbenchHiveDirectoryPanel,
  // moved onto the sync rail so a withdrawn hive drops out / a new announce
  // appears WITHOUT the old 30s poll. Reuses the directory's own
  // listDiscoveredHives builder + the endpoint's exact row shape (so the panel
  // renders identically). Flat HiveRow array (the panel maps over it directly).
  // IN-MEMORY P2P state (no PG table → no table→query bridge; that would trip the
  // cache-tag-trigger-coverage test which requires a PG trigger per bridged table).
  // Live: the directory ingest path (verify→add / withdraw-tombstone in
  // hive-directory-boot's onAnnounce) + the announce/withdraw/beacon writers fire
  // notifySyncInvalidate('network.hiveDirectory') on every accepted change. The
  // 90s source-side dedupe is fine here — P2P announce/withdraw events are sparse
  // (typically >90s apart), so each invalidation delivers promptly; any miss falls
  // back to the @papercusp/sync 180s drift-repair tick.
  'network.hiveDirectory': {
    resolve: async () => {
      const { getHiveDirectory } = await import('../hive-directory-deps');
      return getHiveDirectory()
        .listDiscoveredHives({ includeExpired: false })
        .filter((h) => h.visibility !== 'private')
        .map((h) => ({
          hiveId: h.hiveId,
          title: h.title,
          description: h.description,
          owner: h.ownerGithubLogin,
          visibility: (h.visibility === 'invite' ? 'invite' : 'public') as 'public' | 'invite',
          memberTopics: h.memberTopics,
          memberLinks: h.memberLinks ?? [],
          memberCount: h.memberTopics.length,
          createdAt: h.createdAt,
          lastSeenMs: h.lastSeenMs,
          // The hive's identity pubkey (raw-32-byte base64) — parity with the
          // /discovery/hives endpoint so the Comb's ?hive= rollup can match.
          hivePubkey: h.hivePubkey ?? null,
        }));
    },
  },

  // network.federationStatus — the desktop's LIVE federation status read (data-
  // sync-push-completion P-009): the SAME { ok, substrate, hives } payload GET
  // /api/discovery/federation-status serves to the left-sidebar
  // HiveFederationStatus panel, moved onto the sync rail so the old 10s poll is
  // gone. Reuses the endpoint's exact builder (buildFederationStatus) so the
  // FedStatus shape matches precisely. Workspace-singleton, no-arg; returns a
  // FLAT one-element array per the resolver contract — the consumer reads data[0].
  // IN-MEMORY P2P + install-wide substrate state (no PG table → no table→query
  // bridge). Live: the directory ingest path + the announce/withdraw/beacon writers
  // fire notifySyncInvalidate('network.federationStatus') on every accepted change;
  // substrate/drain changes (harness boots) not covered by those fall back to the
  // 180s drift-repair tick — acceptable for a status panel (substrate is steady
  // after boot). Same 90s-dedupe reasoning as network.hiveDirectory.
  'network.federationStatus': {
    resolve: async () => {
      const { buildFederationStatus } = await import(
        '../endpoint-route/routes/discovery/build-federation-status'
      );
      return [await buildFederationStatus()];
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

  // ─── Evaluation surface — impartial benchmark suite (impartial-benchmark-suite-2026-06-15).
  // evals.suites/evals.runs are P-010 store reads over benchmark_run_result (migration 291);
  // evals.report is P-011's pass@1/CI/Pareto/delta math (buildSuiteReport) over the same rows,
  // grouped per suite (buildSuiteReport is single-suite). emitRollout() fires
  // notifySyncInvalidate('evals.runs', { runId }) + ('evals.suites', {}) after each write.
  'evals.suites': {
    argsSchema: z.object({ runId: z.string().optional() }),
    resolve: async (args) => {
      const { runId } = args as { runId?: string };
      const { listSuites } = await import('../external-bench/reproducibility/store');
      return listSuites({ runId });
    },
  },
  'evals.runs': {
    argsSchema: z.object({ runId: z.string().optional(), suite: z.string().optional() }),
    resolve: async (args) => {
      const { runId, suite } = args as { runId?: string; suite?: string };
      const { listRunResults } = await import('../external-bench/reproducibility/store');
      return listRunResults({ runId, suite });
    },
  },
  'evals.report': {
    argsSchema: z.object({ runId: z.string(), suite: z.string().optional() }),
    resolve: async (args) => {
      const { runId, suite } = args as { runId: string; suite?: string };
      const { listRunResults } = await import('../external-bench/reproducibility/store');
      const { buildSuiteReport } = await import('@papercusp/bench-metrics');
      const rows = await listRunResults({ runId, suite });
      if (rows.length === 0) return [];
      // buildSuiteReport is single-suite — group rows per suite, one report each.
      const bySuite = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = bySuite.get(r.suite) ?? [];
        list.push(r);
        bySuite.set(r.suite, list);
      }
      return [...bySuite.values()].map((suiteRows) => buildSuiteReport(suiteRows));
    },
  },
  // L2 Hive layer (Phase 5 / D-010). evals.fleet = FleetRunSummary[] (P-030
  // Throughput/Coordination subtabs feed P-011's throughputMetrics/buildHiveReport);
  // evals.coordTrace = one fleet run's CoordTrace (P-011's substrateSignalRates /
  // MAST scoring). emitFleetRun/emitCoordEvents invalidate these.
  'evals.fleet': {
    argsSchema: z.object({ runId: z.string().optional() }),
    resolve: async (args) => {
      const { runId } = args as { runId?: string };
      const { listFleetRuns } = await import('../external-bench/reproducibility/fleet');
      return listFleetRuns({ runId });
    },
  },
  'evals.coordTrace': {
    argsSchema: z.object({ fleetRunId: z.string() }),
    resolve: async (args) => {
      const { fleetRunId } = args as { fleetRunId: string };
      const { getCoordTrace } = await import('../external-bench/reproducibility/fleet');
      const trace = await getCoordTrace(fleetRunId);
      return trace ? [trace] : [];
    },
  },
  // Operational live run store (benchmark-evaluation-ui-2026-06-16 P-003 / D-001):
  // bench_runs/bench_run_tasks/bench_run_events (migration 296) — the live, MUTABLE
  // source the Evaluation UI reads for run launch/monitor/history, distinct from the
  // reproducibility cards above. run-store.ts fires notifySyncInvalidate('evals.benchRuns',
  // {}) + ('evals.benchRun', { runId }) on every write, so an in-flight run streams
  // live over desktop SSE with no polling. Detail rows carry the PreservedArmRun shape
  // the eval-viz already renders.
  'evals.benchRuns': {
    argsSchema: z.object({}),
    resolve: async () => {
      const { listBenchRuns } = await import('../external-bench/run-store');
      return listBenchRuns();
    },
  },
  'evals.benchRun': {
    argsSchema: z.object({ runId: z.string() }),
    resolve: async (args) => {
      const { runId } = args as { runId: string };
      const { getBenchRunDetail } = await import('../external-bench/run-store');
      const detail = await getBenchRunDetail(runId);
      return detail ? [detail] : [];
    },
  },
  // Live fleet state for an in-flight run (P-007/P-009) — the Queen's survival,
  // bee status counts, opus-only model-leak check, cumulative spend + wall-clock,
  // per-task progress, read from spawned_agents/agent_usage_samples scoped to the
  // run's hive. The live monitor polls this (the fleet tables aren't bridged to
  // SSE); a completed run returns the not-live shape (signals null).
  'evals.benchRunLive': {
    argsSchema: z.object({ runId: z.string() }),
    resolve: async (args) => {
      const { runId } = args as { runId: string };
      const { getBenchRunLiveState } = await import('../external-bench/live-state');
      const state = await getBenchRunLiveState(runId);
      return state ? [state] : [];
    },
  },
  'evals.benchEstimate': {
    argsSchema: z.object({ taskSetId: z.string().optional(), cap: z.number().optional() }),
    resolve: async (args) => {
      const { taskSetId, cap } = args as { taskSetId?: string; cap?: number };
      const { estimateBenchLaunch } = await import('../external-bench/estimate');
      return [estimateBenchLaunch({ taskSetId, cap })];
    },
  },
  // accounts.pool — the Queen's Claude Max account pool as a live read-model for
  // the Accounts tab (accounts-pool-tab-2026-06-15 P-001). One row per pool
  // account: the union of accounts:list + accounts:status (id/label/credentialRef/
  // boundTo/available/sustainedlyLimited/rate/liveBuckets) via accountStatus().
  // accounts:reset-rate / register / remove / link-complete fire
  // notifySyncInvalidate('accounts.pool') so the tab is live without polling.
  'accounts.pool': {
    argsSchema: z.object({ workspace: z.string().min(1).optional() }),
    resolve: async (args) => {
      const { workspace } = args as { workspace?: string };
      const { accountStatus } = await import('../deployment/account-pool-store');
      const { activeWorkspaceId } = await import('../workspace-registry');
      return accountStatus(workspace ?? activeWorkspaceId());
    },
  },
  // codeRecipes — the hive-scoped corpus of reusable code:run RECIPES for the
  // /admin/recipes dashboard (code-recipes-2026-06-21 P-009). One row per recipe
  // (the CodeRecipeRow shape: title/description/run+success counts/last_run/status/
  // tools_used/author_role/promoted_tool/...), newest-run then most-run first —
  // exactly listRecipes()'s order. Hive defaults to the operator-home hive (the
  // sharing boundary, D-005); pass `harnessSlug` to scope another hive, or
  // `allHives: true` for the whole workspace. The capture path (capture-recipe.ts),
  // recipes:sweep, and recipes:merge fire notifySyncInvalidate('codeRecipes') after
  // committing, so the tab is live over desktop SSE with no polling.
  codeRecipes: {
    argsSchema: z
      .object({
        limit: clampedLimit(2000, 1000),
      })
      .optional(),
    resolve: async (args) => {
      const { limit } = (args ?? {}) as { limit?: number };
      const lim = limit ?? 1000;
      const [{ getOrgPg }, { listRecipes, countRecipes }] = await Promise.all([
        import('@papercusp/db-org'),
        import('../code-recipes-store'),
      ]);
      const sql = getOrgPg().sql;
      // Recipes are GLOBAL (P-001): capped list + cheap COUNT (no workspace/hive
      // filter), so the dashboard can show "N of TOTAL" via attachListMeta.
      const [rows, total] = await Promise.all([
        // Admin/management view shows the FULL corpus including low-value recipes —
        // they are the sweep/merge targets here, and it keeps the listed rows consistent
        // with countRecipes' total (P-004: the AGENT-facing recipes:list hides them).
        listRecipes(sql, { limit: lim, includeTrivial: true }),
        countRecipes(sql),
      ]);
      return attachListMeta(rows, { total }) as unknown[];
    },
  },

  // recipeCandidates — the Queen's deterministic graduation worklist for the
  // /admin/recipes dashboard's Candidates section (code-recipes-2026-06-21 P-009;
  // the read behind recipes:candidates). Returns a SINGLE envelope row
  // { promoteCandidates[], mergeClusters[] } (wrapped in a 1-elem array per the
  // resolver's flat-row contract — the same shape evals.benchEstimate uses). NO
  // LLM: the rubric scoring + the merge-cluster similarity legs (embedder +
  // tool-cooccurrence) run server-side, exactly like the tool handler. Invalidated
  // alongside codeRecipes on every recipe write (a sweep/merge/capture shifts the
  // candidate set), so the dashboard's worklist stays live.
  recipeCandidates: {
    // CLAMP, don't `.max()`-REJECT (clamp-not-reject, P-001/D-002): a newer UI
    // bundle sending minRunCount/limit above an older deployed resolver's cap must
    // not 400 the /admin/recipes Candidates section on a client/server skew. Both
    // stay optional (absent → the downstream recipeCandidates() defaults apply).
    argsSchema: z
      .object({
        minRunCount: clampedLimitOpt(1000),
        limit: clampedLimitOpt(100),
      })
      .optional(),
    resolve: async (args) => {
      const { minRunCount, limit } = (args ?? {}) as {
        minRunCount?: number;
        limit?: number;
      };
      const [
        { getOrgPg },
        { recipeCandidates },
        { activeWorkspaceId },
        { buildQueryEmbedder },
        { buildRecipeCooccurrenceDep },
      ] = await Promise.all([
        import('@papercusp/db-org'),
        import('../code-recipes-candidates'),
        import('../workspace-registry'),
        import('../agent-tools/search/embedder'),
        import('../recipe-cooccurrence-leg'),
      ]);
      const workspaceId = activeWorkspaceId();
      const embedder = await buildQueryEmbedder().catch(() => null);
      // recipes are global (P-001); the co-occurrence signal is workspace-scoped telemetry.
      const toolCooccurrence = await buildRecipeCooccurrenceDep(workspaceId).catch(() => null);
      const { promoteCandidates, mergeClusters } = await recipeCandidates(
        getOrgPg().sql,
        { minRunCount, limit },
        { embedder, toolCooccurrence },
      );
      return [{ promoteCandidates, mergeClusters }] as unknown[];
    },
  },

  // agentConfig.modelTiersBaseline — the effective workspace model-tier menu
  // for the Queen sidebar's session override editor. Settings writes invalidate
  // this query, so the sidebar tracks workspace-tier edits without raw fetches.
  'agentConfig.modelTiersBaseline': {
    argsSchema: z.object({}),
    resolve: async () => {
      const [{ readAgentConfig }, { DEFAULT_MODEL_TIERS }] = await Promise.all([
        import('../agent-config'),
        import('../agent-config-constants'),
      ]);
      const cfg = await readAgentConfig();
      return (cfg.tiers && cfg.tiers.length > 0 ? cfg.tiers : DEFAULT_MODEL_TIERS) as unknown[];
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

/**
 * Test-only — return one registry entry by name (or undefined) so tests can
 * assert each entry is STRUCTURALLY well-shaped (a callable `resolve`, an
 * optional `.parse`-bearing `argsSchema`) WITHOUT executing the resolver. The
 * old breadth check dispatched every entry against real PG/FS, so its runtime
 * scaled with (entry count × I/O latency) and repeatedly tripped the green gate
 * under load (timeout bumped 10s→30s→120s, then blown past 120s at ~123 entries
 * / load-90). Structural inspection catches the same bug class — a typo'd
 * `resolves:` key leaves `resolve` undefined — in O(1) per entry, no I/O.
 */
export function getRegistryEntryV2(name: string): QueryEntry<unknown> | undefined {
  return REGISTRY[name] as QueryEntry<unknown> | undefined;
}
