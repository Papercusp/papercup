/**
 * Zero-free named-query dispatcher — papercusp-dogfood-v5 P-022.
 *
 * Replaces the @rocicorp/zero-coupled resolver at apps/operator/lib/
 * zero-harness-resolver.ts incrementally. The legacy resolver looks
 * each name up in `@restart/zero-harness`'s registry, compiles a ZQL
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
 *   3. The 1107-line @restart/zero-harness queries.ts stays as a
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

// ─── Registry types ─────────────────────────────────────────────────

export interface QueryEntry<TArgs = unknown> {
  /** Optional zod schema for arg validation. Omitted entries accept any. */
  argsSchema?: z.ZodSchema<TArgs>;
  /** Resolver: takes validated args, returns flat row array. */
  resolve: (args: TArgs) => Promise<unknown[]>;
}

// Symbol used by callers to detect "name not in v2 registry, fall back".
export const NAME_NOT_FOUND = Symbol('sync-resolver/NAME_NOT_FOUND');
export type NameNotFound = typeof NAME_NOT_FOUND;

// ─── Migrated queries ───────────────────────────────────────────────
//
// Each entry below corresponds to one of the 51 live queryNames
// audited 2026-05-24. As each lands, the corresponding ZQL entry in
// libs/zero-harness/src/queries.ts becomes dead code (to be deleted
// at the P-022 cutover).

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
      const { listToasts } = await import('@/lib/toast-log-data');
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
      const { getOrgPg, generated } = await import('@restart/db-org');
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

  // operatorScans.byWorkspace — operator scan history.
  //   zql.operatorScans.where(workspaceId).orderBy('startedAt', 'desc').limit(limit)
  'operatorScans.byWorkspace': {
    argsSchema: z.object({
      workspaceId: z.string(),
      limit: z.number().int().positive().max(500).default(50),
    }),
    resolve: async (args) => {
      const { workspaceId, limit } = args as { workspaceId: string; limit: number };
      const { getOrgPg, generated } = await import('@restart/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.operatorScansInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.workspaceId, workspaceId))
        .orderBy(desc(t.startedAt))
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
      const { getOrgPg, generated } = await import('@restart/db-org');
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

  // operatorLastScan.byWorkspace — single-row-per-workspace last-scan snapshot.
  //   zql.operatorLastScan.where(workspaceId).limit(1)
  'operatorLastScan.byWorkspace': {
    argsSchema: z.object({ workspaceId: z.string() }),
    resolve: async (args) => {
      const { workspaceId } = args as { workspaceId: string };
      const { getOrgPg, generated } = await import('@restart/db-org');
      const { eq } = await import('drizzle-orm');
      const t = generated.operatorLastScanInHarnessShared;
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
  'harnessTextArtifact.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@restart/db-org');
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
      const { getOrgPg, generated } = await import('@restart/db-org');
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
      const { getOrgPg, generated } = await import('@restart/db-org');
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
      const { getOrgPg, generated } = await import('@restart/db-org');
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

  // harnessExperts.byHarness — experts ordered by last-updated desc.
  //   zql.harnessExperts.where('harnessSlug', s).orderBy('updatedAt', 'desc')
  'harnessExperts.byHarness': {
    argsSchema: z.object({ harnessSlug: z.string() }),
    resolve: async (args) => {
      const { harnessSlug } = args as { harnessSlug: string };
      const { getOrgPg, generated } = await import('@restart/db-org');
      const { desc, eq } = await import('drizzle-orm');
      const t = generated.harnessExpertsInHarnessShared;
      const { db } = getOrgPg();
      return (await db
        .select()
        .from(t)
        .where(eq(t.harnessSlug, harnessSlug))
        .orderBy(desc(t.updatedAt))) as unknown[];
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
      const { getOrgPg, generated } = await import('@restart/db-org');
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
} satisfies Record<string, QueryEntry<unknown>>;

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Resolve a named query against the v2 registry. Returns flat rows on
 * success, NAME_NOT_FOUND if the name isn't registered yet (callers
 * fall back to the legacy resolver). Throws on schema-validation
 * failure or downstream errors — the route handler maps to HTTP.
 */
export async function resolveNamedQueryV2(
  name: string,
  args: unknown,
): Promise<unknown[] | NameNotFound> {
  const entry = REGISTRY[name];
  if (!entry) return NAME_NOT_FOUND;

  const validated = entry.argsSchema ? entry.argsSchema.parse(args) : args;
  return entry.resolve(validated);
}

/** Test-only — enumerate which names the v2 registry currently knows. */
export function knownQueryNamesV2(): string[] {
  return Object.keys(REGISTRY).sort();
}

/** Test-only — useful for assertions in migration progress tests. */
export function isRegisteredV2(name: string): boolean {
  return name in REGISTRY;
}
