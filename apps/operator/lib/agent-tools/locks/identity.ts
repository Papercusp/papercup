/**
 * Resolve the calling SU agent's identity for lock ownership.
 *
 * As of agent-coordination-architecture-v2 (Phase A), L1 identity is
 * owned by the coordination layer's `resolveAgentIdentity` primitive
 * — see `apps/operator/lib/agent-tools/coordination/identity.ts`. The
 * locks subsystem uses the *same* primitive so a held lock and a
 * coordination message authored by the same agent share an `ownerId`.
 *
 * `readIdentity` here is a thin adapter that:
 *   1. Delegates to `resolveAgentIdentity`.
 *   2. Projects the result into the legacy `SuAgentIdentity` shape
 *      (the locks callers destructure `{ ownerId, ownerLabel,
 *      workspaceId }` and don't need source / userId).
 *   3. Substitutes `'default'` for a null workspaceId — the locks
 *      schema's `coordination_domain` column is NOT NULL.
 *
 * Behaviour notes vs. the historical readIdentity (pre-refactor):
 *
 *   - Labels follow the coordination convention (`omp · pus-…`,
 *     `su · sess-…`, `principal · slug`) — labels are display-only,
 *     never keyed on; this is an intentional unification.
 *
 *   - Power-user callers are now first-class. Pre-refactor they fell
 *     through to the superuser branch (ctx.isSuperuser is also true on
 *     the power-user route); post-refactor they hit the dedicated
 *     `power-user-token` branch in resolveAgentIdentity. ownerId is
 *     identical in both cases (= ctx.uiClientId = auth_session_id).
 */

import {
  resolveAgentIdentity,
  type ResolveIdentityCtx,
} from '../coordination/identity';

/**
 * Loose ctx type — read-only access to the fields we need. Wraps the
 * coordination's `ResolveIdentityCtx`; kept as a re-export so existing
 * imports (`from '@/lib/agent-tools/locks/identity'`) still compile.
 */
export type IdentityCtx = ResolveIdentityCtx;

/**
 * Default workspace id for callers whose ctx carries no workspace.
 * Matches the convention used by other operator surfaces
 * (`apps/operator/lib/dock-layouts.ts:getUserIdForLayouts`) and the
 * `coordination_domain NOT NULL` constraint on the locks schema.
 */
const DEFAULT_WORKSPACE = 'default';

export interface SuAgentIdentity {
  /** Stable durable identity — used as the `owner` column. */
  ownerId: string;
  /** Human-readable label — used as the `owner_label` column. */
  ownerLabel: string;
  /** Workspace scope from the bearer principal / power-user clamp. */
  workspaceId: string;
}

/**
 * Read identity from the agent's tool context. Adapter around
 * `resolveAgentIdentity` — see the file header.
 */
export function readIdentity(ctx: IdentityCtx): SuAgentIdentity {
  const id = resolveAgentIdentity(ctx);
  return {
    ownerId: id.ownerId,
    ownerLabel: id.ownerLabel,
    workspaceId: id.workspaceId ?? DEFAULT_WORKSPACE,
  };
}
