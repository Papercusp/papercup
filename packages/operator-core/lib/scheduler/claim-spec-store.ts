/**
 * Per-bee claim-spec store + the get_next service entry point
 * (hybrid-bee-scheduler-work-stealing-2026-06-22 — the spec-handoff layer that makes get_next usable).
 *
 *   setClaimSpec  — the Queen validates (validateClaimSpec) + stores a bee's versioned claim spec
 *                   (mig 372 `bee_claim_specs`), upserting and bumping the revision.
 *   getClaimSpec  — loads a bee's spec; DEFAULT_CLAIM_SPEC when none is set OR a stored spec no
 *                   longer validates (tolerate a stale spec rather than wedge the bee).
 *   getNextForBee — the bee's get_next: load the bee's spec → getNextWorkItem(spec, bee, opts).
 *
 * Keyed by the bee's session/owner id (`beeId` — the identity a tool ctx resolves via actor-identity
 * and the id the Queen addresses a bee by). The store fns take an optional `sql` (dependency-injected
 * for tests); production passes getOrgPg().sql.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, type ClaimSpec } from './claim-spec';
import { getNextWorkItem, type GetNextResult } from './get-next';
import type { OrgSql } from '../work-items';

export interface SetClaimSpecResult {
  ok: boolean;
  errors: string[];
  revision?: number;
}

/** Queen: validate + store a bee's claim spec (upsert; revision bumps unless the spec carries a higher one). */
export async function setClaimSpec(
  args: { beeId: string; workspaceId?: string; spec: unknown; updatedBy?: string },
  sqlOverride?: OrgSql,
): Promise<SetClaimSpecResult> {
  const v = validateClaimSpec(args.spec);
  if (!v.ok || !v.spec) return { ok: false, errors: v.errors };
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    INSERT INTO harness_shared.bee_claim_specs (workspace_id, bee_id, spec, revision, updated_by, updated_at)
    VALUES (${ws}, ${args.beeId}, ${JSON.stringify(v.spec)}::text::jsonb, ${v.spec.revision}, ${args.updatedBy ?? null}, now())
    ON CONFLICT (workspace_id, bee_id) DO UPDATE SET
      spec = EXCLUDED.spec,
      revision = GREATEST(harness_shared.bee_claim_specs.revision + 1, EXCLUDED.revision),
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING revision`) as { revision: number }[];
  return { ok: true, errors: [], revision: rows[0]?.revision };
}

/** Load a bee's claim spec, or DEFAULT_CLAIM_SPEC when none is set / a stored spec is invalid. */
export async function getClaimSpec(
  args: { beeId: string; workspaceId?: string },
  sqlOverride?: OrgSql,
): Promise<ClaimSpec> {
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT spec FROM harness_shared.bee_claim_specs
     WHERE workspace_id = ${ws} AND bee_id = ${args.beeId} LIMIT 1`) as { spec: unknown }[];
  if (rows.length === 0) return DEFAULT_CLAIM_SPEC;
  const v = validateClaimSpec(rows[0]!.spec);
  return v.ok && v.spec ? v.spec : DEFAULT_CLAIM_SPEC;
}

/** The bee's get_next: claim the next work-item per the bee's stored spec (the global floors always apply). */
export async function getNextForBee(args: {
  beeId: string;
  workspaceId?: string;
  harness: string;
  heldPaths?: string[];
  swarmId?: string;
  excludeRedundant?: boolean;
  states?: string[];
  /** SCHEDULER_SPEC_CLAIM kill-switch: when true, ignore the bee's stored spec and use the
   *  DEFAULT ordering (== work_items:claim_next) — a no-breakage degrade. */
  ignoreStoredSpec?: boolean;
}): Promise<GetNextResult | null> {
  const spec = args.ignoreStoredSpec
    ? DEFAULT_CLAIM_SPEC
    : await getClaimSpec({ beeId: args.beeId, workspaceId: args.workspaceId });
  return getNextWorkItem(spec, { assignee: args.beeId, heldPaths: args.heldPaths }, {
    harness: args.harness,
    ...(args.swarmId ? { swarmId: args.swarmId } : {}),
    ...(args.excludeRedundant ? { excludeRedundant: true } : {}),
    ...(args.states ? { states: args.states } : {}),
  });
}

/** One currently-executing claim (the live-execution view, P-001). */
export interface RunningClaim {
  itemId: string;
  kind: string;
  status: string;
  owner: string;
  takenAt: string | null;
  lastProgressAt: string | null;
  /** The claim-spec the owning bee is running under (null ⇒ default ordering / no spec set). */
  specId: string | null;
  specRevision: number | null;
}

/**
 * The live-execution view (P-001): every in-flight (taken, non-terminal) work-item in a harness,
 * with its owning bee + WHICH claim-spec revision that bee is running under (the spec is joined by
 * bee_id = taken_by). Read-only observability over the scheduler — "what is the fleet executing now,
 * under which scheduling spec".
 */
export async function listRunningClaims(harness: string, sqlOverride?: OrgSql): Promise<RunningClaim[]> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT f.feature_id AS item_id, f.item_kind AS kind, f.status, f.taken_by AS owner,
           f.taken_at, f.last_progress_at, s.spec->>'specId' AS spec_id, s.revision AS spec_revision
      FROM harness_shared.harness_features_consolidated f
      LEFT JOIN harness_shared.bee_claim_specs s ON s.bee_id = f.taken_by
     WHERE f.harness_slug = ${harness}
       AND f.taken_by IS NOT NULL AND f.taken_by <> ''
       AND f.status NOT IN ('passed', 'deprecated')
     ORDER BY f.taken_at DESC NULLS LAST`) as Array<{
    item_id: string;
    kind: string;
    status: string;
    owner: string;
    taken_at: unknown;
    last_progress_at: unknown;
    spec_id: string | null;
    spec_revision: number | null;
  }>;
  const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | number | Date).toISOString());
  return rows.map((r) => ({
    itemId: r.item_id,
    kind: r.kind,
    status: r.status,
    owner: r.owner,
    takenAt: iso(r.taken_at),
    lastProgressAt: iso(r.last_progress_at),
    specId: r.spec_id ?? null,
    specRevision: r.spec_revision == null ? null : Number(r.spec_revision),
  }));
}
