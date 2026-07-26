/**
 * ctxToPlanSourceOpts — extract per-harness PlanSourceOpts from a ctx.
 *
 * P-012 of per-harness-plans-and-docs-2026-05-23. Most plans:* read
 * tools call source.ts functions (listPlanFiles / readPlanBySlug /
 * readAllPlans) which take a PlanSourceOpts override. This helper
 * derives the right opts from ctx.harnessSlug:
 *
 *   - No ctx.harnessSlug, ctx.harnessSlug === the operator-home slug
 *     (operatorHomeHarnessSlug() — PAPERCUSP_POT_HOME_SLUG when set,
 *     else the legacy 'papercup'), OR ctx.harnessSlug === '*' (SU
 *     wildcard from http-projection when no ?harness= is in the URL) →
 *     return `{}`. source.ts's legacy sync cwd-walk handles the
 *     operator-home-default location (`apps/operator/docs/plans/`) —
 *     same behavior as before per-harness-plans-and-docs.
 *
 *   - ctx.harnessSlug set to a real slug → look up via the harness
 *     registry (resolveHarnessPlansDir), return `{ plansDir, archiveDir }`
 *     pointing at `<harness.path>/docs/plans/`.
 *
 * Async because the registry lookup is async. Every caller that wires
 * this in becomes async (most read tool handlers already are).
 */

import { resolvePlanScope, type PlanSourceOpts } from './source';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';

export interface CtxHarnessOpts extends PlanSourceOpts {
  /** Resolved harness slug. The operator-home slug (operatorHomeHarnessSlug(), default) or the registered name. */
  harnessSlug: string;
}

/**
 * Resolve `ctx.harnessSlug` into a registered slug or `undefined`,
 * treating the SU wildcard `'*'` (set by http-projection.ts on
 * `?superuser=1` with no `?harness=`) the same as "no harness in
 * scope". Used by tool handlers that pass the slug into PG queries
 * (`listPlanRuns`, `listPlanRevisions`, etc.) — passing `'*'` through
 * unfiltered makes those queries match nothing instead of falling
 * back to the papercup default. Returns `undefined` so callers can
 * keep their `opts.harnessSlug ?? operatorHomeHarnessSlug()` defaulting logic.
 */
export function resolveCtxHarnessSlug(ctx: unknown): string | undefined {
  const c = ctx as { harnessSlug?: string };
  const raw = c.harnessSlug?.trim();
  if (!raw || raw === '*') return undefined;
  return raw;
}

/**
 * Resolve the EFFECTIVE concrete harness slug for a plan WRITE that must name a
 * single harness in PG — e.g. `clearStartedForTerminalPlan`'s `harness_slug = …`
 * match, a `harness_plans` op-status / op-priority update, or the
 * deprecate-learnings `sourceHive`. A concrete `ctx.harnessSlug` passes through;
 * the operator / superuser `'*'` (or unset) scope resolves to the operator-home
 * harness — because an operator-scope plan op operates on the operator's OWN
 * plans, which live under the operator-home harness (the same resolution
 * {@link ctxToPlanSourceOpts} applies, so the write targets the SAME partition
 * the rest of the write path wrote to).
 *
 * This is the ONE canonical home for that operator-home plan-write default
 * (workspace-data-isolation-leaks-2026-06-17 P-006 / D-003): plans handlers route
 * through it instead of inlining `resolveCtxHarnessSlug(ctx) ?? operatorHomeHarnessSlug()`
 * / `harnessSlug ?? operatorHomeHarnessSlug()` at every call site — the duplicated
 * ad-hoc default whose drift caused the WI-374 plan-attribution leak. Pass a ctx
 * that has already been through `harnessScopedCtx`, so an unresolvable scope has
 * already thrown `harness_required` and only concrete / operator scope reaches here.
 */
export function resolveEffectiveHarnessSlug(ctx: unknown): string {
  // allow-scope-default: no concrete harness in scope (operator/superuser '*' or
  // unset) = the operator's OWN plans, which live under the operator-home harness —
  // the documented, explicit operator-home default for plan writes, not a silent swallow.
  return resolveCtxHarnessSlug(ctx) ?? operatorHomeHarnessSlug();
}

export async function ctxToPlanSourceOpts(ctx: unknown): Promise<CtxHarnessOpts> {
  const c = ctx as { harnessSlug?: string };
  const raw = c.harnessSlug?.trim();
  // '*' is the SU-mode wildcard set by http-projection.ts when an admin
  // request arrives with `?superuser=1` and no `?harness=`. Treat it
  // exactly like an empty ctx (no harness in scope) so /adv/plans —
  // which always operates on the operator's own plans — keeps working.
  // Under PG-canonical storage the readers resolve (workspace, harness)
  // themselves (source.ts resolvePlanScope), so this just threads the slug.
  // The operator-home slug (operatorHomeHarnessSlug() — PAPERCUSP_POT_HOME_SLUG
  // when set, else the legacy default) is resolved here, never a hardcoded literal,
  // so this site auto-follows the home cutover (papercup→papercusp merge).
  const home = operatorHomeHarnessSlug();
  if (!raw || raw === '*' || raw === home) {
    return { harnessSlug: home };
  }
  return { harnessSlug: raw };
}

/**
 * Resolve the `(workspace_id, harness_slug)` key an operational
 * `harness_shared.harness_plans` WRITE must use — the SAME resolution the
 * READERS perform, from the SAME resolver.
 *
 * ⚠ Use this in every harness_plans writer. Do NOT re-derive the tenant with
 * `activeWorkspaceId()` (or a `DEFAULT_WORKSPACE_ID` literal), and do NOT key
 * on the raw ctx slug. That is a bug class this repo has now shipped THREE
 * generations of (WI-5125 / EI-16183 / WI-5825), each time because a writer
 * resolved its key on a second path that could disagree with the reader's:
 *
 *   gen 1 — a hardcoded `DEFAULT_WORKSPACE_ID`: matched ZERO rows for every
 *           real tenant (plans live in 'papercusp-workspace', not 'default').
 *   gen 2 — `activeWorkspaceId()`: the AMBIENT workspace (request-ALS → env →
 *           registry default), which is only right when the caller happens to
 *           be inside a browser request whose workspace matches the harness's
 *           REGISTERED one. Any agent-side tool call outside that ALS scope,
 *           or a different workspace being "current", keys a different row.
 *   gen 3 — the raw ctx harness slug: `resolvePlanScope` collapses a MEMBER
 *           harness to its Hive home (plans are Hive-scoped), so a writer that
 *           skips the collapse keys a row the reader never looks at.
 *
 * `resolvePlanScope` is the one authority: it resolves the workspace from
 * `harness_shared.projects` then the harness registry, THROWS rather than
 * silently defaulting when neither knows the harness, and applies the Hive-home
 * collapse. Passing its output through for BOTH the `withWorkspace()` scope and
 * the SQL WHERE clause removes the second, disagreeing resolution path entirely
 * — the same repair already applied to `clearStartedForTerminalPlan`.
 *
 * Callers that already hold a resolved scope (e.g. `withPlanLock`'s returned
 * `result.scope`) should thread THAT through instead of calling this again.
 */
export async function resolvePlanWriteScope(
  ctx: unknown,
): Promise<{ workspaceId: string; harnessSlug: string }> {
  return resolvePlanScope(await ctxToPlanSourceOpts(ctx));
}
