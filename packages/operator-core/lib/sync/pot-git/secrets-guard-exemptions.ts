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

/**
 * Does `path` match any exemption entry?
 *
 * WI-5738: exact-equality was the ONLY matching rule, which made the escape
 * hatch useless against the incident class it exists for. The 2026-07-20 wedge
 * was one accidentally-committed AppImage extraction — **4,174 scanned files**
 * under a single directory. Clearing that by exact path would need thousands of
 * INSERTs enumerated by hand from a scan the operator cannot easily run, so in
 * practice the "no-restart remedy" did not apply to the very shape of accident
 * that produced it.
 *
 * Three entry forms, in order of specificity — deliberately NOT a general glob
 * engine (an exemption is a security-relevant waiver; a surprising match is a
 * silent leak, so the grammar stays small enough to be obvious on sight):
 *   - `a/b/c.js`   exact path (unchanged — every existing row keeps its meaning)
 *   - `a/b/`       directory PREFIX — everything at or below `a/b/`
 *   - `a/b/**`     the same directory prefix, spelled gitignore-style
 *
 * Note both prefix forms require the trailing separator, so `a/b/` can never
 * accidentally exempt a sibling like `a/bc.js`.
 */
export function isPathExempt(exemptions: ReadonlySet<string>, path: string): boolean {
  if (exemptions.size === 0) return false;
  if (exemptions.has(path)) return true;
  for (const entry of exemptions) {
    const prefix = entry.endsWith('/**') ? entry.slice(0, -2) : entry.endsWith('/') ? entry : null;
    if (prefix && path.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Partition findings into { blocking, exempted } using `isPathExempt`. The one
 * place this split is expressed, so the publish guard and the GitHub egress
 * guard cannot drift apart on what an exemption means (they did: before
 * WI-5738 egress consulted no exemptions at all).
 */
export function partitionExemptFindings<T extends { path: string }>(
  findings: readonly T[],
  exemptions: ReadonlySet<string>,
): { blocking: T[]; exempted: T[] } {
  if (exemptions.size === 0) return { blocking: [...findings], exempted: [] };
  const blocking: T[] = [];
  const exempted: T[] = [];
  for (const f of findings) (isPathExempt(exemptions, f.path) ? exempted : blocking).push(f);
  return { blocking, exempted };
}
