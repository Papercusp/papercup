/**
 * ctxToPlanSourceOpts — extract per-harness PlanSourceOpts from a ctx.
 *
 * P-012 of per-harness-plans-and-docs-2026-05-23. Most plans:* read
 * tools call source.ts functions (listPlanFiles / readPlanBySlug /
 * readAllPlans) which take a PlanSourceOpts override. This helper
 * derives the right opts from ctx.harnessSlug:
 *
 *   - No ctx.harnessSlug, ctx.harnessSlug === the operator-home slug
 *     (operatorHomeHarnessSlug() — PAPERCUSP_HIVE_HOME_SLUG when set,
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

import { type PlanSourceOpts } from './source';
import { PAPERCUP_HARNESS_SLUG } from '../../harness/register-papercup';
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

export async function ctxToPlanSourceOpts(ctx: unknown): Promise<CtxHarnessOpts> {
  const c = ctx as { harnessSlug?: string };
  const raw = c.harnessSlug?.trim();
  // '*' is the SU-mode wildcard set by http-projection.ts when an admin
  // request arrives with `?superuser=1` and no `?harness=`. Treat it
  // exactly like an empty ctx (no harness in scope) so /adv/plans —
  // which always operates on the operator's own plans — keeps working.
  // Under PG-canonical storage the readers resolve (workspace, harness)
  // themselves (source.ts resolvePlanScope), so this just threads the slug.
  if (!raw || raw === '*' || raw === PAPERCUP_HARNESS_SLUG) {
    return { harnessSlug: PAPERCUP_HARNESS_SLUG };
  }
  return { harnessSlug: raw };
}
