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
import type { Principal } from './types';
export declare function resolveBearer(bearer: string): Promise<Principal | null>;
/** Invalidate cache entry. Called by the LISTEN handler when capabilities change. */
export declare function invalidate(workspaceId: string, slug: string): void;
/** Test-only. */
export declare function _resetAuthCacheForTests(): void;
