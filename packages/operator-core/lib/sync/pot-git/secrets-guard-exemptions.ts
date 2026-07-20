/**
 * pot-git/secrets-guard-exemptions.ts — WI-5591: the RUNTIME, no-restart
 * escape hatch for the own-head publish guard's secrets scanner.
 *
 * Root cause this closes: secrets-guard.ts's FIXTURE_FILES is a hardcoded TS
 * Set — clearing a false-positive wedge requires a human to edit that source
 * AND restart papercup-bg-host (tsx has no hot-reload there). Because
 * checkPublishGuard's guard baseline never advances past a REFUSED range
 * (own-head-publish.ts: `guardBaseline = priorSha ?? genesisBaselineSha`, and
 * priorSha only moves forward on an ADMITTED publish), the same offending
 * historical blob is rescanned and re-refused on EVERY future tick — a false
 * positive permanently freezes ALL git egress for the hive until that manual
 * fix lands (hit 3x in 2 days, EI-13924).
 *
 * This table (migration 644) is a data-driven sibling of FIXTURE_FILES:
 * INSERT a path exemption and the very next tick (no restart, no deploy)
 * treats that path as exempt from the secrets scan — same semantics, orders
 * of magnitude faster remedy. FIXTURE_FILES itself is UNCHANGED (defense in
 * depth for the scanner's own known self-referential fixtures); this module
 * is the operator/agent-facing lever for the NEXT unforeseen false positive.
 *
 * `workspaceId` is taken EXPLICITLY (not `activeWorkspaceId()`'s ambient
 * lookup) because the caller chain (git-sync-action.ts's per-tick loop)
 * already threads a concrete workspaceId through runOwnHeadPublishLeg for
 * exactly this reason — a background tick must not depend on request-scoped
 * ambient context being set correctly.
 */
import { getOrgPg } from '@papercusp/db-org';

const TABLE = 'harness_shared.secrets_guard_path_exemptions';

export interface SecretsGuardExemption {
  path: string;
  reason: string;
  createdBy: string;
  createdAt: string;
}

/** All exempted paths for `workspaceId`, as a Set for O(1) lookup. Fails
 *  CLOSED to an empty set on any error — a DB hiccup must never silently
 *  exempt more than intended (the scanner stays strict on read failure). */
export async function loadSecretsGuardPathExemptions(workspaceId: string): Promise<ReadonlySet<string>> {
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT path FROM ${sql(TABLE)} WHERE workspace_id = ${workspaceId}
    `) as Array<{ path: string }>;
    return new Set(rows.map((r) => r.path));
  } catch {
    return new Set();
  }
}

/** List exemptions with full detail (reason/who/when) — for an admin/agent view. */
export async function listSecretsGuardPathExemptions(workspaceId: string): Promise<SecretsGuardExemption[]> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT path, reason, created_by, created_at
      FROM ${sql(TABLE)}
     WHERE workspace_id = ${workspaceId}
     ORDER BY created_at DESC
  `) as Array<{ path: string; reason: string; created_by: string; created_at: string }>;
  return rows.map((r) => ({ path: r.path, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at }));
}

/** Add (or update the reason on) a path exemption — takes effect on the very
 *  next publish-guard tick, no restart required. */
export async function addSecretsGuardPathExemption(input: {
  workspaceId: string;
  path: string;
  reason: string;
  createdBy: string;
}): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO ${sql(TABLE)} (workspace_id, path, reason, created_by)
    VALUES (${input.workspaceId}, ${input.path}, ${input.reason}, ${input.createdBy})
    ON CONFLICT (workspace_id, path) DO UPDATE
      SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now()
  `;
}

/** Remove a path exemption (re-arm the scan for that path). */
export async function removeSecretsGuardPathExemption(workspaceId: string, path: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM ${sql(TABLE)} WHERE workspace_id = ${workspaceId} AND path = ${path}`;
}
