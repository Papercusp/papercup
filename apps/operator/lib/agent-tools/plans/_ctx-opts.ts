/**
 * ctxToPlanSourceOpts — extract per-harness PlanSourceOpts from a ctx.
 *
 * P-012 of per-harness-plans-and-docs-2026-05-23. Most plans:* read
 * tools call source.ts functions (listPlanFiles / readPlanBySlug /
 * readAllPlans) which take a PlanSourceOpts override. This helper
 * derives the right opts from ctx.harnessSlug:
 *
 *   - No ctx.harnessSlug, OR ctx.harnessSlug === 'papercup' →
 *     return `{}`. source.ts's legacy sync cwd-walk handles the
 *     papercup-default location (`apps/operator/docs/plans/`) — same
 *     behavior as before per-harness-plans-and-docs.
 *
 *   - ctx.harnessSlug set + != 'papercup' → look up via the harness
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
  if (!raw || raw === PAPERCUP_HARNESS_SLUG) {
    return { harnessSlug: PAPERCUP_HARNESS_SLUG };
  }
  const { plans, archive } = await resolveHarnessPlansDir(raw);
  return { harnessSlug: raw, plansDir: plans, archiveDir: archive };
}
