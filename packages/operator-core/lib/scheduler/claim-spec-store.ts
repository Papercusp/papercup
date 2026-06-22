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

/** The claim-spec head (specId@revision) a bee is running under — the live-execution view's
 *  per-run spec column (P-001). */
export interface ClaimSpecHead {
  specId: string;
  revision: number;
}

/**
 * Batch-load the running spec HEAD (specId@revision) for a set of bees, keyed by beeId — the
 * spec-join behind the live-execution view (P-001, {@link import('./bee-runs').listBeeRuns}).
 * A bee with no stored spec is ABSENT from the map (⇒ DEFAULT ordering / no Queen-authored
 * spec). `bee_id` is globally unique (it is the claim's `taken_by`), so this joins by `bee_id`
 * regardless of workspace by default; pass `workspaceId` to scope. When a bee somehow has rows
 * in multiple workspaces, the highest revision wins.
 */
export async function getClaimSpecHeadsForBees(
  beeIds: string[],
  workspaceId?: string,
  sqlOverride?: OrgSql,
): Promise<Map<string, ClaimSpecHead>> {
  const map = new Map<string, ClaimSpecHead>();
  if (beeIds.length === 0) return map;
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT DISTINCT ON (bee_id) bee_id, spec->>'specId' AS spec_id, revision
      FROM harness_shared.bee_claim_specs
     WHERE bee_id = ANY(${beeIds})
       ${workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``}
     ORDER BY bee_id, revision DESC`) as Array<{ bee_id: string; spec_id: string | null; revision: number }>;
  for (const r of rows) {
    if (r.spec_id) map.set(r.bee_id, { specId: r.spec_id, revision: Number(r.revision) });
  }
  return map;
}
