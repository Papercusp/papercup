/**
 * ctxToPlanSourceOpts — extract per-harness PlanSourceOpts from a ctx.
 *
 * P-012 of per-harness-plans-and-docs-2026-05-23. Most plans:* read
 * tools call source.ts functions (listPlanFiles / readPlanBySlug /
 * readAllPlans) which take a PlanSourceOpts override. This helper
 * derives the right opts from ctx.harnessSlug:
 *
 *   - No ctx.harnessSlug, ctx.harnessSlug === 'papercup', OR
 *     ctx.harnessSlug === '*' (SU wildcard from http-projection when
 *     no ?harness= is in the URL) → return `{}`. source.ts's legacy
 *     sync cwd-walk handles the papercup-default location
 *     (`apps/operator/docs/plans/`) — same behavior as before
 *     per-harness-plans-and-docs.
 *
 *   - ctx.harnessSlug set to a real slug → look up via the harness
 *     registry (resolveHarnessPlansDir), return `{ plansDir, archiveDir }`
 *     pointing at `<harness.path>/docs/plans/`.
 *
 * Async because the registry lookup is async. Every caller that wires
 * this in becomes async (most read tool handlers already are).
 */

import { resolveHarnessPlansDir, type PlanSourceOpts } from './source';
import { PAPERCUP_HARNESS_SLUG } from '@/lib/harness/register-papercup';

export interface CtxHarnessOpts extends PlanSourceOpts {
  /** Resolved harness slug. 'papercup' (default) or the registered name. */
  harnessSlug: string;
}

export async function ctxToPlanSourceOpts(ctx: unknown): Promise<CtxHarnessOpts> {
  const c = ctx as { harnessSlug?: string };
  const raw = c.harnessSlug?.trim();
  // '*' is the SU-mode wildcard set by http-projection.ts when an admin
  // request arrives with `?superuser=1` and no `?harness=`. Treat it
  // exactly like an empty ctx (no harness in scope) so /adv/plans —
  // which always operates on the operator's own plans dir — keeps
  // working after papercusp-dogfood Phase 4 renamed the registered
  // harness from 'papercup' → 'papercup-org'. The cwd-walk in
  // source.ts always lands at apps/operator/docs/plans regardless of
  // registry state.
  if (!raw || raw === '*' || raw === PAPERCUP_HARNESS_SLUG) {
    return { harnessSlug: PAPERCUP_HARNESS_SLUG };
  }
  const { plans, archive } = await resolveHarnessPlansDir(raw);
  return { harnessSlug: raw, plansDir: plans, archiveDir: archive };
}
