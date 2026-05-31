/**
 * Resource-level authorization seam — RFC `tooldef-auth-rfc-2026-05-31`, Phase 1.
 *
 * The coarse gates already live in the dispatch stack (`dispatch-stack.ts`): the agent
 * `roleAllowlist`, the `capability` gate, `harness`, and `quota`. What the framework
 * lacks is the *fine-grained* layer: "can THIS principal act on THIS resource"
 * (ownership / ReBAC / ABAC). Today such a check has nowhere to go but a tool's handler
 * body.
 *
 * This module is that seam's CONTRACT. It is deliberately POLICY-AGNOSTIC: tooldef is
 * the PEP (enforcement point); the *decision* is supplied by the host — either as an
 * in-process closure or by delegating to an external PDP (OPA / Cedar / OpenFGA /
 * Cerbos / an AuthZEN-compliant engine). tooldef ships the contract + one trivial
 * owner-check helper and **no policy engine** (shipping one would be the
 * lowest-common-denominator trap).
 *
 * SCOPE — this is additive and changes no behavior. The dispatch-stack *enforcement*
 * step (a `DispatchStep` that runs a tool's `authorize` after the existing gates, fails
 * closed, and composes with `GateBypass`) is **Phase 1b**, gated on RFC decision **D-F**
 * (`GateBypass.policy`) and on the tooldef owner's review of where the step sits in the
 * stack. Until then, this module just lets hosts (and Restart) author `PolicyDecisionPoint`
 * implementations + `authorize`-shaped functions against a stable contract.
 *
 * Uses the CURRENT `Principal` (identity = `slug`); the generic `Principal<TKind>` /
 * `roles` / `attributes` evolution is RFC Phase 2 and orthogonal to this contract.
 */
import type { Principal, PrincipalTrust } from './types';

/**
 * An authorization query, shaped after the OpenID AuthZEN model
 * ("can {subject} do {action} on {resource}?") so an AuthZEN/OPA/Cedar/OpenFGA PDP can
 * back it without reshaping (RFC D-C — wiring an external engine is deferred; the shape
 * is chosen now so it won't need to change then).
 */
export interface AuthzQuery {
  /** The resolved caller (current `Principal`; identity is `principal.slug`). */
  principal: Principal;
  /** The operation — typically the tool name, or a finer-grained verb. */
  action: string;
  /** The thing being acted on. Omit for actions with no specific resource. */
  resource?: {
    type: string;
    id?: string;
    attributes?: Readonly<Record<string, unknown>>;
  };
  /** Extra decision inputs (request/context attributes for ABAC). */
  context?: Readonly<Record<string, unknown>>;
}

/**
 * The decision. `reason` feeds the audit trail; `obligations` carry post-allow
 * constraints a handler must apply (e.g. a row filter), à la XACML/AuthZEN obligations.
 */
export interface AuthDecision {
  allow: boolean;
  reason?: string;
  obligations?: Readonly<Record<string, unknown>>;
}

/**
 * Policy Decision Point. The host implements this in-process (a closure) or adapts it to
 * an external engine. The framework *calls* it and never ships one — it stays
 * policy-agnostic, exactly as `GateBypass` keeps the engine ignorant of *why* a caller
 * is privileged.
 */
export interface PolicyDecisionPoint {
  decide(query: AuthzQuery): Promise<AuthDecision> | AuthDecision;
}

/**
 * One authorization decision, for the audit trail. A first-class invariant of the RFC:
 * every allow AND deny is emitted (when the host wires an audit sink) — auditability is
 * one of the two hard parts of any capability/PDP system. `gate` records which layer
 * decided so denials are attributable.
 */
export interface AuthAuditEvent {
  /** epoch ms — passed in by the caller (the engine has no ambient clock). */
  ts: number;
  principal: { slug: string; kind: string; trust: PrincipalTrust };
  tool: string;
  action: string;
  resource?: { type: string; id?: string };
  decision: 'allow' | 'deny';
  /** Which layer rendered the decision. */
  gate: 'role' | 'capability' | 'harness' | 'quota' | 'authorize';
  reason?: string;
}

/**
 * The most common resource rule, as a ready-made `PolicyDecisionPoint`: allow iff the
 * principal owns the resource. `getOwnerId` extracts the owner id from the resource
 * (default: `resource.attributes.ownerId`); ownership is compared against
 * `principal.slug`. Hosts needing relationship/attribute rules supply their own PDP
 * instead — this is the floor, not the ceiling.
 */
export function ownerOnly(
  getOwnerId: (resource: NonNullable<AuthzQuery['resource']>) => string | undefined = (r) =>
    r.attributes?.ownerId as string | undefined,
): PolicyDecisionPoint {
  return {
    decide(q) {
      if (!q.resource) {
        return { allow: false, reason: 'ownerOnly: no resource to check ownership against' };
      }
      const owner = getOwnerId(q.resource);
      const allow = owner != null && owner === q.principal.slug;
      return allow
        ? { allow: true }
        : {
            allow: false,
            reason: `ownerOnly: principal "${q.principal.slug}" is not the owner (owner: ${owner ?? 'none'})`,
          };
    },
  };
}
