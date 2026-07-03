/**
 * resource-allotments.ts — P-201 two-axis allotment store (p2p-work-distribution).
 *
 * The persistence behind the /res Resources board: a host hands its account
 * pools (remote axis) + local GPUs (local axis) to the fleets in its hive tree,
 * each with a share cap. Backed by harness_shared.resource_allotments (mig 473).
 *
 * LOCAL, per-machine (M19) — no federation: the resource is THIS machine's, so
 * unlike grant-store.ts there is no hive-slug / epoch / CDC machinery. Keyed by
 * (workspace, fleet, resource_kind, resource_ref). M11: a row's EXISTENCE is the
 * opt-in (default zero); share_pct is the cap. Caps not reservations (D-008) —
 * contention resolves at claim time (P-202), not here.
 *
 * Mirrors the grant-store PG access pattern: getOrgPg().sql + a shared
 * writer/reader workspace resolver (the WI-1564 one-helper invariant).
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { OrgSql } from '../work-items';

export type ResourceKind = 'account' | 'gpu';
export type AllotmentStatus = 'active' | 'paused';

export interface ResourceAllotment {
  workspaceId: string;
  fleetSlug: string;
  resourceKind: ResourceKind;
  resourceRef: string;
  /** Share cap as a percent (0–100). Remote axis: % of pool budget; local axis: % of GPU time/slots. */
  sharePct: number;
  /** P-201 forward seam: { dollarCapUsd, modelClassWeights, windows, allowedModels, preemptClass, slots }. */
  axis: Record<string, unknown>;
  status: AllotmentStatus;
  createdByGithubUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type AllotmentWriteResult =
  | { ok: true; allotment: ResourceAllotment }
  | { ok: false; refusal: { code: string; detail: string } };

/**
 * Resolve the workspace partition a write/read uses from the caller's resolved
 * identity workspace — the same one-helper-shared-by-writer-and-reader invariant
 * as resolveP2pGrantWorkspace. `undefined` = unresolvable (null / '*' / empty /
 * the legacy 'default' partition), which callers must refuse rather than strand.
 */
export function resolveAllotmentWorkspace(
  identWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identWorkspaceId?.trim();
  return ws && ws !== '*' && ws !== DEFAULT_COORD_WORKSPACE ? ws : undefined;
}

function isResourceKind(v: unknown): v is ResourceKind {
  return v === 'account' || v === 'gpu';
}

interface AllotmentRow {
  workspace_id: string;
  fleet_slug: string;
  resource_kind: string;
  resource_ref: string;
  share_pct: number;
  axis: Record<string, unknown> | null;
  status: string;
  created_by_github_user_id: string | number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToAllotment(r: AllotmentRow): ResourceAllotment {
  return {
    workspaceId: r.workspace_id,
    fleetSlug: r.fleet_slug,
    resourceKind: r.resource_kind as ResourceKind,
    resourceRef: r.resource_ref,
    sharePct: Number(r.share_pct),
    axis: r.axis ?? {},
    status: r.status as AllotmentStatus,
    createdByGithubUserId:
      r.created_by_github_user_id == null ? null : Number(r.created_by_github_user_id),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export interface ListAllotmentsArgs {
  /** The caller's RESOLVED identity workspace. */
  workspaceId: string | null | undefined;
  /** Restrict to one fleet (the P-202 claim-authority read). Omit for the whole board. */
  fleetSlug?: string;
  /** Include paused rows (default false — the board shows active contributions). */
  includePaused?: boolean;
}

/** Read allotments for the /res board (whole workspace) or one fleet (claim authority). */
export async function listResourceAllotments(
  args: ListAllotmentsArgs,
  sqlOverride?: OrgSql,
): Promise<ResourceAllotment[]> {
  const ws = resolveAllotmentWorkspace(args.workspaceId);
  if (!ws) return [];
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT * FROM harness_shared.resource_allotments
     WHERE workspace_id = ${ws}
       ${args.fleetSlug ? sql`AND fleet_slug = ${args.fleetSlug}` : sql``}
       ${args.includePaused ? sql`` : sql`AND status = 'active'`}
     ORDER BY fleet_slug, resource_kind, resource_ref
  `) as unknown as AllotmentRow[];
  return rows.map(rowToAllotment);
}

export interface SetAllotmentArgs {
  workspaceId: string | null | undefined;
  fleetSlug: string;
  resourceKind: ResourceKind | string;
  resourceRef: string;
  /** Share cap 0–100. Clamped-checked, not silently coerced. */
  sharePct: number;
  axis?: Record<string, unknown>;
  status?: AllotmentStatus;
  /** The setting host's numeric GitHub id (display/audit). */
  createdByGithubUserId?: number | null;
}

/** Upsert an allotment (one per (fleet, resource) on this machine). Re-allocating is an UPSERT of the cap. */
export async function setResourceAllotment(
  args: SetAllotmentArgs,
  sqlOverride?: OrgSql,
): Promise<AllotmentWriteResult> {
  const ws = resolveAllotmentWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: {
        code: 'workspace_unresolved',
        detail: `Allotment write refused: unresolvable workspace partition (got ${JSON.stringify(args.workspaceId ?? null)}).`,
      },
    };
  }
  if (!isResourceKind(args.resourceKind)) {
    return { ok: false, refusal: { code: 'invalid_resource_kind', detail: `resource_kind must be account|gpu (got '${String(args.resourceKind)}').` } };
  }
  if (!args.resourceRef?.trim()) {
    return { ok: false, refusal: { code: 'resource_required', detail: 'resourceRef is required.' } };
  }
  if (!args.fleetSlug?.trim()) {
    return { ok: false, refusal: { code: 'fleet_required', detail: 'fleetSlug is required.' } };
  }
  if (!Number.isFinite(args.sharePct) || args.sharePct < 0 || args.sharePct > 100) {
    return { ok: false, refusal: { code: 'invalid_share_pct', detail: `sharePct must be 0–100 (got ${String(args.sharePct)}).` } };
  }
  const sql = sqlOverride ?? getOrgPg().sql;
  const status: AllotmentStatus = args.status ?? 'active';
  const sharePct = Math.round(args.sharePct);
  const rows = (await sql`
    INSERT INTO harness_shared.resource_allotments
      (workspace_id, fleet_slug, resource_kind, resource_ref, share_pct, axis, status, created_by_github_user_id)
    VALUES
      (${ws}, ${args.fleetSlug}, ${args.resourceKind}, ${args.resourceRef}, ${sharePct},
       ${sql.json(args.axis ?? {})}, ${status}, ${args.createdByGithubUserId ?? null})
    ON CONFLICT (workspace_id, fleet_slug, resource_kind, resource_ref)
    DO UPDATE SET share_pct = EXCLUDED.share_pct,
                  axis = EXCLUDED.axis,
                  status = EXCLUDED.status,
                  updated_at = now()
    RETURNING *
  `) as unknown as AllotmentRow[];
  return { ok: true, allotment: rowToAllotment(rows[0]) };
}

export interface RemoveAllotmentArgs {
  workspaceId: string | null | undefined;
  fleetSlug: string;
  resourceKind: ResourceKind | string;
  resourceRef: string;
}

/** Remove an allotment (the /res chip's × — revokes the fleet's draw on this resource). Returns rows removed. */
export async function removeResourceAllotment(
  args: RemoveAllotmentArgs,
  sqlOverride?: OrgSql,
): Promise<{ ok: true; removed: number }> {
  const ws = resolveAllotmentWorkspace(args.workspaceId);
  if (!ws) return { ok: true, removed: 0 };
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    DELETE FROM harness_shared.resource_allotments
     WHERE workspace_id = ${ws}
       AND fleet_slug = ${args.fleetSlug}
       AND resource_kind = ${args.resourceKind}
       AND resource_ref = ${args.resourceRef}
    RETURNING fleet_slug
  `) as unknown as { fleet_slug: string }[];
  return { ok: true, removed: rows.length };
}
