/**
 * Bearer-token resolution → Principal.
 *
 * The bearer is looked up in `harness_shared.token_index`; the row's
 * (kind, slug, workspace_id) determines the principal. Capabilities are
 * loaded from the principal's table:
 *   - kind='harness' → harness's role config (out of scope for MCP v1;
 *     this server doesn't admit harness bearers as direct callers).
 *   - kind='system'  → harness_shared.system_principals.capabilities
 *   - kind='pi'      → harness_shared.pi_sessions.capabilities (only if
 *     ended_at IS NULL).
 *
 * In-memory cap state is keyed by (workspace_id, principal_slug). It's
 * loaded from disk into memory on first lookup; revocation events
 * (handled by the operator's permissions UI) emit a NOTIFY that the
 * server LISTENs to in order to invalidate the cache.
 */

import { createHash } from 'node:crypto';
import { getOrgPg, withWorkspace } from '@restart/db-org';
import type { Principal } from './types';

const CACHE = new Map<string, Principal>();
function cacheKey(workspaceId: string, slug: string): string {
  return `${workspaceId}:${slug}`;
}

function bearerHash(bearer: string): string {
  return createHash('sha256').update(bearer).digest('hex');
}

export async function resolveBearer(bearer: string): Promise<Principal | null> {
  if (!bearer) return null;
  // token_index lookup is admin-context — needs to read across workspaces
  // to find which workspace this bearer belongs to. RLS does not apply
  // to this query because the search itself is what derives workspace.
  // The caller (resolveBearer) is the only place that escapes RLS for
  // token resolution. We use the admin connection here intentionally;
  // the lint rule allows it because we're not inside a tx callback.
  const { sql } = getOrgPg();
  // token_index column is named `harness_slug` per the original 008 migration.
  // It holds slugs for harnesses; for system: and pi: principals (added in
  // 009) the same column stores the prefixed slug (e.g. "system:operator").
  const rows = await sql<
    Array<{ token: string; kind: string; harness_slug: string; workspace_id: string }>
  >`
    SELECT token, kind, harness_slug, workspace_id
      FROM harness_shared.token_index
     WHERE token = ${bearer}
     LIMIT 1
  `;
  if (!rows.length) return null;
  const { kind, harness_slug: slug, workspace_id: workspaceId } = rows[0];
  if (kind !== 'system' && kind !== 'pi') {
    // Harness bearers are out of scope for v1.
    return null;
  }

  // Cache check.
  const ck = cacheKey(workspaceId, slug);
  const cached = CACHE.get(ck);
  if (cached) return cached;

  const capabilities = await loadCapabilities(workspaceId, kind, slug, bearerHash(bearer));
  if (!capabilities) return null;

  const principal: Principal = { kind, slug, workspaceId, capabilities };
  CACHE.set(ck, principal);
  return principal;
}

async function loadCapabilities(
  workspaceId: string,
  kind: 'system' | 'pi',
  slug: string,
  expectedHash: string,
): Promise<ReadonlySet<string> | null> {
  return withWorkspace(workspaceId, async (tx) => {
    if (kind === 'system') {
      const name = slug.startsWith('system:') ? slug.slice('system:'.length) : slug;
      const rows = await tx<Array<{ bearer_hash: string; capabilities: unknown }>>`
        SELECT bearer_hash, capabilities
          FROM harness_shared.system_principals
         WHERE workspace_id = ${workspaceId} AND name = ${name}
         LIMIT 1
      `;
      if (!rows.length) return null;
      if (rows[0].bearer_hash !== expectedHash) return null;
      return setOf(rows[0].capabilities);
    }
    // pi
    const sessionId = slug.startsWith('pi:') ? slug.slice('pi:'.length) : slug;
    const rows = await tx<Array<{ bearer_hash: string; capabilities: unknown; ended_at: Date | null }>>`
      SELECT bearer_hash, capabilities, ended_at
        FROM harness_shared.pi_sessions
       WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
       LIMIT 1
    `;
    if (!rows.length) return null;
    if (rows[0].ended_at) return null;
    if (rows[0].bearer_hash !== expectedHash) return null;
    return setOf(rows[0].capabilities);
  });
}

function setOf(raw: unknown): ReadonlySet<string> {
  if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === 'string'));
  return new Set();
}

/** Invalidate cache entry. Called by the LISTEN handler when capabilities change. */
export function invalidate(workspaceId: string, slug: string): void {
  CACHE.delete(cacheKey(workspaceId, slug));
}

/** Test-only. */
export function _resetAuthCacheForTests(): void {
  CACHE.clear();
}
