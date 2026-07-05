/**
 * EI-7517 — resolve an omitted `scopeRef` from the CALLER's ctx for the
 * self-scoped fact scopes (owner=me, harness=this harness, role=my role), so an
 * agent asserting / listing / retracting a fact about "just me" needn't look up
 * and pass its own id (the recurring "scope 'owner' requires scope_ref"
 * structural error, watchdog-flagged).
 *
 * Identity is resolved ONLY when a default is actually needed — an explicit
 * scopeRef, or a scope with no ctx default (workspace / work_item), skips the
 * resolve entirely, so a read caller that passes an explicit ref is never
 * forced through attribution (resolveAgentIdentity throws on an unattributable
 * ctx). facts:assert resolves identity anyway (for createdBy) and calls the
 * pure {@link resolveFactScopeRef} directly.
 */
import { resolveFactScopeRef, type FactScope } from '../../agent-facts/store';
import type { ResolveIdentityCtx } from '../coordination/identity';

export async function resolveScopeRefFromCtx(
  scope: FactScope,
  scopeRef: string | null | undefined,
  ctx: ResolveIdentityCtx,
): Promise<string | null | undefined> {
  const needsDefault =
    !(scopeRef ?? '').trim() && (scope === 'owner' || scope === 'harness' || scope === 'role');
  if (!needsDefault) return scopeRef;
  const { resolveAgentIdentity, deriveAgentRole } = await import('../coordination/identity');
  const identity = resolveAgentIdentity(ctx);
  return resolveFactScopeRef(scope, scopeRef, {
    ownerId: identity.ownerId,
    harnessSlug: ctx.harnessSlug,
    role: deriveAgentRole(identity),
  });
}
