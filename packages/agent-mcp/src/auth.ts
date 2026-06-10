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
 * In-memory cap state is keyed by (workspace_id, principal_slug) in a
 * bounded TTL+LRU cache (negative results included). Capability writes
 * (provisioning.ts) emit a NOTIFY on PRINCIPAL_INVALIDATE_CHANNEL that
 * this module LISTENs to in order to invalidate eagerly; the TTL bounds
 * staleness if the LISTEN is unavailable.
 */

import { createHash } from 'node:crypto';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import type { Principal } from '@papercusp/tooldef';
import { BRAIN_PRINCIPAL_ROLE } from './role-config';

/**
 * The RBAC `roles` a resolved principal carries (the fail-closed `requireRoles`
 * dispatch axis). Derived from the principal's verified identity — NEVER
 * caller-asserted. Today only the operator's own system principal is "the brain"
 * (unify-agent-spawn-chokepoint P-006); a spawned worker/scoper/etc. carries none,
 * so a `requireRoles:[BRAIN_PRINCIPAL_ROLE]` tool admits only the brain (+ superuser).
 */
function rolesForPrincipal(kind: 'system' | 'pi', slug: string): ReadonlySet<string> | undefined {
  if (kind === 'system' && (slug === 'system:operator' || slug === 'operator')) {
    return new Set([BRAIN_PRINCIPAL_ROLE]);
  }
  return undefined;
}

/**
 * NOTIFY channel for principal capability changes. Emitters live in
 * provisioning.ts (the single capability write site) — `pg_notify` inside the
 * write tx, so the signal is delivered on commit and dropped on rollback.
 * Payload: JSON `{ workspace_id, slug }` (slug as stored in token_index,
 * e.g. "system:operator" / "pi:<session_id>").
 */
export const PRINCIPAL_INVALIDATE_CHANNEL = 'agent_mcp_principal_invalidate';

/** Positive entries: revocation lag is bounded by this even if LISTEN is down. */
const CACHE_TTL_MS = 60_000;
/** Negative entries (ended session / missing row / hash mismatch): short, so a
 *  just-provisioned principal racing a probe isn't blocked for long. */
const NEGATIVE_TTL_MS = 15_000;
/** LRU bound — pi sessions accumulate one entry each (EI-79 contributor). */
const CACHE_MAX = 512;

type CacheEntry = { principal: Principal | null; expiresAt: number };
const CACHE = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, slug: string): string {
  return `${workspaceId}:${slug}`;
}

function cacheGet(ck: string): CacheEntry | undefined {
  const entry = CACHE.get(ck);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    CACHE.delete(ck);
    return undefined;
  }
  // Refresh LRU recency — Map iterates in insertion order, so re-inserting
  // moves the entry to the tail and eviction below always takes the head.
  CACHE.delete(ck);
  CACHE.set(ck, entry);
  return entry;
}

function cacheSet(ck: string, principal: Principal | null): void {
  if (!CACHE.has(ck) && CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.delete(ck);
  CACHE.set(ck, {
    principal,
    expiresAt: Date.now() + (principal ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

let listenerStarted = false;
let listenerWarned = false;

/**
 * Start the LISTEN that makes `invalidate()` fire on capability writes.
 * Lazy (first resolveBearer) + idempotent; fails open — without it the TTL
 * still bounds revocation lag at CACHE_TTL_MS instead of "until restart".
 */
function ensureInvalidationListener(): void {
  if (listenerStarted) return;
  listenerStarted = true;
  const { sql } = getOrgPg();
  // Unit tests (and any non-postgres-js stand-in) mock sql as a bare tagged
  // template without .listen — skip silently there.
  const listen = (sql as unknown as { listen?: unknown }).listen;
  if (typeof listen !== 'function') return;
  void sql
    .listen(PRINCIPAL_INVALIDATE_CHANNEL, (payload: string) => {
      try {
        const parsed = JSON.parse(payload) as { workspace_id?: unknown; slug?: unknown };
        if (typeof parsed.workspace_id === 'string' && typeof parsed.slug === 'string') {
          invalidate(parsed.workspace_id, parsed.slug);
          return;
        }
      } catch {
        // fall through to the safe fallback
      }
      CACHE.clear();
    })
    .catch((err: unknown) => {
      listenerStarted = false; // retry on a later resolve
      if (!listenerWarned) {
        listenerWarned = true;
        console.warn(
          '[agent-mcp auth] principal-invalidate LISTEN failed (TTL still bounds staleness):',
          err,
        );
      }
    });
}

function bearerHash(bearer: string): string {
  return createHash('sha256').update(bearer).digest('hex');
}

export async function resolveBearer(bearer: string): Promise<Principal | null> {
  if (!bearer) return null;
  // token_index lookup is admin-context — needs to read across workspaces
  // to find which workspace this bearer belongs to. RLS bypass is handled
  // at the role level: harness_admin has BYPASSRLS (per
  // sql/010-workspace-scoping-rls.sql's documented intent and the
  // matching `ALTER ROLE harness_admin BYPASSRLS` granted at provisioning
  // time). Without that grant the policy `workspace_id =
  // current_setting('app.workspace_id', true)` would filter out every
  // row because the GUC is unset outside withWorkspace.
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

  ensureInvalidationListener();

  // Cache check — negative entries (ended sessions etc.) are cached too, so a
  // dead bearer hammering the server doesn't re-load capabilities every call.
  const ck = cacheKey(workspaceId, slug);
  const cached = cacheGet(ck);
  if (cached) return cached.principal;

  const capabilities = await loadCapabilities(workspaceId, kind, slug, bearerHash(bearer));
  if (!capabilities) {
    cacheSet(ck, null);
    return null;
  }

  // Bearer-token-resolved principals are 'trusted' — the bearer hash was
  // verified against the row in PG. authMethod stays 'bearer-token'
  // for both 'system' (operator self / superuser shell) and 'pi' kinds.
  const roles = rolesForPrincipal(kind, slug);
  const principal: Principal = {
    kind,
    slug,
    workspaceId,
    capabilities,
    authMethod: 'bearer-token',
    trust: 'trusted',
    ...(roles ? { roles } : {}),
  };
  cacheSet(ck, principal);
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
  listenerStarted = false;
  listenerWarned = false;
}

/** Test-only — TTL/bound constants for the cache tests. */
export const _authCacheTuning = {
  ttlMs: CACHE_TTL_MS,
  negativeTtlMs: NEGATIVE_TTL_MS,
  max: CACHE_MAX,
} as const;
