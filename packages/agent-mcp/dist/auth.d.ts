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
import type { Principal } from '@papercusp/tooldef';
/**
 * NOTIFY channel for principal capability changes. Emitters live in
 * provisioning.ts (the single capability write site) — `pg_notify` inside the
 * write tx, so the signal is delivered on commit and dropped on rollback.
 * Payload: JSON `{ workspace_id, slug }` (slug as stored in token_index,
 * e.g. "system:operator" / "pi:<session_id>").
 */
export declare const PRINCIPAL_INVALIDATE_CHANNEL = "agent_mcp_principal_invalidate";
export declare function resolveBearer(bearer: string): Promise<Principal | null>;
/** Invalidate cache entry. Called by the LISTEN handler when capabilities change. */
export declare function invalidate(workspaceId: string, slug: string): void;
/** Test-only. */
export declare function _resetAuthCacheForTests(): void;
/** Test-only — TTL/bound constants for the cache tests. */
export declare const _authCacheTuning: {
    readonly ttlMs: 60000;
    readonly negativeTtlMs: 15000;
    readonly max: 512;
};
