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
 * In-memory cap state is keyed by (workspace_id, principal_slug). It's
 * loaded from disk into memory on first lookup; revocation events
 * (handled by the operator's permissions UI) emit a NOTIFY that the
 * server LISTENs to in order to invalidate the cache.
 */
Object.defineProperty(exports, "__esModule", { value: true });
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
const CACHE = new Map();
function cacheKey(workspaceId, slug) {
    return `${workspaceId}:${slug}`;
}
function bearerHash(bearer) {
    return (0, node_crypto_1.createHash)('sha256').update(bearer).digest('hex');
}
async function resolveBearer(bearer) {
    if (!bearer)
        return null;
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
    if (!rows.length)
        return null;
    const { kind, harness_slug: slug, workspace_id: workspaceId } = rows[0];
    if (kind !== 'system' && kind !== 'pi') {
        // Harness bearers are out of scope for v1.
        return null;
    }
    // Cache check.
    const ck = cacheKey(workspaceId, slug);
    const cached = CACHE.get(ck);
    if (cached)
        return cached;
    const capabilities = await loadCapabilities(workspaceId, kind, slug, bearerHash(bearer));
    if (!capabilities)
        return null;
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
    CACHE.set(ck, principal);
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
}
