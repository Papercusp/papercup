"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports._authCacheTuning = exports.PRINCIPAL_INVALIDATE_CHANNEL = void 0;
exports.resolveBearer = resolveBearer;
exports.invalidate = invalidate;
exports._resetAuthCacheForTests = _resetAuthCacheForTests;
const node_crypto_1 = require("node:crypto");
const db_org_1 = require("@papercusp/db-org");
const role_config_1 = require("./role-config");
/**
 * The RBAC `roles` a resolved principal carries (the fail-closed `requireRoles`
 * dispatch axis). Derived from the principal's verified identity — NEVER
 * caller-asserted. Today only the operator's own system principal is "the brain"
 * (unify-agent-spawn-chokepoint P-006); a spawned worker/scoper/etc. carries none,
 * so a `requireRoles:[BRAIN_PRINCIPAL_ROLE]` tool admits only the brain (+ superuser).
 */
function rolesForPrincipal(kind, slug) {
    if (kind === 'system' && (slug === 'system:operator' || slug === 'operator')) {
        return new Set([role_config_1.BRAIN_PRINCIPAL_ROLE]);
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
exports.PRINCIPAL_INVALIDATE_CHANNEL = 'agent_mcp_principal_invalidate';
/** Positive entries: revocation lag is bounded by this even if LISTEN is down. */
const CACHE_TTL_MS = 60_000;
/** Negative entries (ended session / missing row / hash mismatch): short, so a
 *  just-provisioned principal racing a probe isn't blocked for long. */
const NEGATIVE_TTL_MS = 15_000;
/** LRU bound — pi sessions accumulate one entry each (EI-79 contributor). */
const CACHE_MAX = 512;
/**
 * Shared TTL+LRU read: an expired entry is deleted + reported as a miss;
 * otherwise its recency is refreshed (Map iterates in insertion order, so
 * re-inserting moves the entry to the tail and eviction always takes the head).
 * The wrapper (not the bare value) lets a cached `null` negative result be
 * distinguished from a miss.
 */
function lruGet(map, key) {
    const entry = map.get(key);
    if (!entry)
        return undefined;
    if (Date.now() >= entry.expiresAt) {
        map.delete(key);
        return undefined;
    }
    map.delete(key);
    map.set(key, entry);
    return entry;
}
/**
 * Shared TTL+LRU write: evict the insertion-order head at the cap. A falsy value
 * (a negative result — revoked / missing / out-of-scope) takes the shorter
 * negative TTL so a just-provisioned principal racing a probe isn't masked long.
 */
function lruSet(map, key, value) {
    if (!map.has(key) && map.size >= CACHE_MAX) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined)
            map.delete(oldest);
    }
    map.delete(key);
    map.set(key, { value, expiresAt: Date.now() + (value ? CACHE_TTL_MS : NEGATIVE_TTL_MS) });
}
/** (workspace_id, principal_slug) → resolved Principal capabilities. */
const CACHE = new Map();
const TOKEN_INDEX_CACHE = new Map();
function cacheKey(workspaceId, slug) {
    return `${workspaceId}:${slug}`;
}
let listenerStarted = false;
let listenerWarned = false;
/**
 * Start the LISTEN that makes `invalidate()` fire on capability writes.
 * Lazy (first resolveBearer) + idempotent; fails open — without it the TTL
 * still bounds revocation lag at CACHE_TTL_MS instead of "until restart".
 */
function ensureInvalidationListener() {
    if (listenerStarted)
        return;
    listenerStarted = true;
    const { sql } = (0, db_org_1.getOrgPg)();
    // Unit tests (and any non-postgres-js stand-in) mock sql as a bare tagged
    // template without .listen — skip silently there.
    const listen = sql.listen;
    if (typeof listen !== 'function')
        return;
    void sql
        .listen(exports.PRINCIPAL_INVALIDATE_CHANNEL, (payload) => {
        try {
            const parsed = JSON.parse(payload);
            if (typeof parsed.workspace_id === 'string' && typeof parsed.slug === 'string') {
                invalidate(parsed.workspace_id, parsed.slug);
                return;
            }
        }
        catch {
            // fall through to the safe fallback
        }
        CACHE.clear();
        TOKEN_INDEX_CACHE.clear();
    })
        .catch((err) => {
        listenerStarted = false; // retry on a later resolve
        if (!listenerWarned) {
            listenerWarned = true;
            console.warn('[agent-mcp auth] principal-invalidate LISTEN failed (TTL still bounds staleness):', err);
        }
    });
}
function bearerHash(bearer) {
    return (0, node_crypto_1.createHash)('sha256').update(bearer).digest('hex');
}
/**
 * Resolve a bearer to its token_index identity, served from TOKEN_INDEX_CACHE
 * (keyed by bearer hash). A missing row OR an out-of-scope kind (harness bearers
 * aren't admitted as direct MCP callers in v1) is cached as a negative result.
 */
async function resolveTokenIdentity(bearer, bearerHashHex) {
    const hit = lruGet(TOKEN_INDEX_CACHE, bearerHashHex);
    if (hit)
        return hit.value;
    // token_index lookup is admin-context — needs to read across workspaces
    // to find which workspace this bearer belongs to. RLS bypass is handled
    // at the role level: harness_admin has BYPASSRLS (per
    // sql/010-workspace-scoping-rls.sql's documented intent and the
    // matching `ALTER ROLE harness_admin BYPASSRLS` granted at provisioning
    // time). Without that grant the policy `workspace_id =
    // current_setting('app.workspace_id', true)` would filter out every
    // row because the GUC is unset outside withWorkspace.
    const { sql } = (0, db_org_1.getOrgPg)();
    // token_index column is named `harness_slug` per the original 008 migration.
    // It holds slugs for harnesses; for system: and pi: principals (added in
    // 009) the same column stores the prefixed slug (e.g. "system:operator").
    const rows = await sql `
    SELECT token, kind, harness_slug, workspace_id
      FROM harness_shared.token_index
     WHERE token = ${bearer}
     LIMIT 1
  `;
    const row = rows[0];
    if (!row || (row.kind !== 'system' && row.kind !== 'pi')) {
        // Missing row, or a harness bearer (out of scope for v1) — cache negatively.
        lruSet(TOKEN_INDEX_CACHE, bearerHashHex, null);
        return null;
    }
    const identity = {
        kind: row.kind,
        slug: row.harness_slug,
        workspaceId: row.workspace_id,
    };
    lruSet(TOKEN_INDEX_CACHE, bearerHashHex, identity);
    return identity;
}
async function resolveBearer(bearer) {
    if (!bearer)
        return null;
    // bearer → token_index identity, served from a per-bearer-hash cache (the
    // identity is immutable for a live token — see TOKEN_INDEX_CACHE). The hash is
    // also the capability-load credential, so compute it once here.
    const bh = bearerHash(bearer);
    const identity = await resolveTokenIdentity(bearer, bh);
    if (!identity)
        return null;
    const { kind, slug, workspaceId } = identity;
    ensureInvalidationListener();
    // Cache check — negative entries (ended sessions etc.) are cached too, so a
    // dead bearer hammering the server doesn't re-load capabilities every call.
    const ck = cacheKey(workspaceId, slug);
    const cached = lruGet(CACHE, ck);
    if (cached)
        return cached.value;
    const capabilities = await loadCapabilities(workspaceId, kind, slug, bh);
    if (!capabilities) {
        lruSet(CACHE, ck, null);
        return null;
    }
    // Bearer-token-resolved principals are 'trusted' — the bearer hash was
    // verified against the row in PG. authMethod stays 'bearer-token'
    // for both 'system' (operator self / superuser shell) and 'pi' kinds.
    const roles = rolesForPrincipal(kind, slug);
    const principal = {
        kind,
        slug,
        workspaceId,
        capabilities,
        authMethod: 'bearer-token',
        trust: 'trusted',
        ...(roles ? { roles } : {}),
    };
    lruSet(CACHE, ck, principal);
    return principal;
}
async function loadCapabilities(workspaceId, kind, slug, expectedHash) {
    return (0, db_org_1.withWorkspace)(workspaceId, async (tx) => {
        if (kind === 'system') {
            const name = slug.startsWith('system:') ? slug.slice('system:'.length) : slug;
            const rows = await tx `
        SELECT bearer_hash, capabilities
          FROM harness_shared.system_principals
         WHERE workspace_id = ${workspaceId} AND name = ${name}
         LIMIT 1
      `;
            if (!rows.length)
                return null;
            if (rows[0].bearer_hash !== expectedHash)
                return null;
            return setOf(rows[0].capabilities);
        }
        // pi
        const sessionId = slug.startsWith('pi:') ? slug.slice('pi:'.length) : slug;
        const rows = await tx `
      SELECT bearer_hash, capabilities, ended_at
        FROM harness_shared.pi_sessions
       WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
       LIMIT 1
    `;
        if (!rows.length)
            return null;
        if (rows[0].ended_at)
            return null;
        if (rows[0].bearer_hash !== expectedHash)
            return null;
        return setOf(rows[0].capabilities);
    });
}
function setOf(raw) {
    if (Array.isArray(raw))
        return new Set(raw.filter((x) => typeof x === 'string'));
    return new Set();
}
/** Invalidate cache entry. Called by the LISTEN handler when capabilities change. */
function invalidate(workspaceId, slug) {
    CACHE.delete(cacheKey(workspaceId, slug));
}
/** Test-only. */
function _resetAuthCacheForTests() {
    CACHE.clear();
    TOKEN_INDEX_CACHE.clear();
    listenerStarted = false;
    listenerWarned = false;
}
/** Test-only — TTL/bound constants for the cache tests. */
exports._authCacheTuning = {
    ttlMs: CACHE_TTL_MS,
    negativeTtlMs: NEGATIVE_TTL_MS,
    max: CACHE_MAX,
};
