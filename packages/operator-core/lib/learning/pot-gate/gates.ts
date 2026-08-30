/**
 * Production wirings of the per-pot learning gate
 * (plan learning-pot-scope-gate-2026-08-30, P-003 / P-004).
 *
 * The lanes take the gate as an INJECTED predicate so their unit tests stay
 * hermetic (unwired ⇒ no gate). These are the real implementations the boot
 * paths pass in — kept HERE, together, for one specific reason: the same lane
 * is wired from more than one entrypoint (Scout runs from both the
 * `system:scout-cycle` routine action and the `blender:cycle` blueprint op),
 * and a gate wired at one entrypoint but missed at the other silently no-ops.
 * That has already happened once in this exact file's neighbourhood — the P-051
 * workspace ceiling was not carried into the blueprint op and every cycle
 * passed its per-cycle cap while the aggregate cap refused nothing for months
 * (see the comment at blueprint-steps/ops/scout-cycle.ts). One shared helper is
 * cheap insurance against repeating it.
 *
 * Every helper here fails OPEN (R-5): an unreadable pot gate must not become a
 * fleet-wide learning outage. The store already fails open on a missing
 * relation; these add the same posture for any other read failure, because at
 * this layer the alternative is stopping a lane the owner never switched off.
 */
import type { Sql } from 'postgres';
import { potLearningEnabled } from './store';

/**
 * Scout's preflight (P-004): resolve the pot this install learns FOR, then ask
 * the gate. The install slug is resolved through `resolveLearningPotSlug` —
 * the ONE way a learning writer resolves its pot — rather than assumed to BE
 * the pot slug, because a Scout install can run under a member harness of a
 * pot, and gating on the raw harness slug would miss exactly those.
 *
 * An unresolvable pot (null) is NOT a disabled pot: a context-less system
 * writer belongs to no pot, so no pot switch can gate it.
 */
export async function scoutPotGate(input: {
  workspaceId: string;
  installSlug: string;
}): Promise<{ enabled: boolean }> {
  try {
    const [{ resolveLearningPotSlug }, { getOrgPg }] = await Promise.all([
      import('../pot-scope'),
      import('@papercusp/db-org'),
    ]);
    const potSlug = await resolveLearningPotSlug({
      workspaceId: input.workspaceId,
      harnessSlug: input.installSlug,
    });
    if (!potSlug) return { enabled: true };
    const { sql } = getOrgPg();
    return { enabled: await potLearningEnabled(sql, { workspaceId: input.workspaceId, potSlug }) };
  } catch (e) {
    console.warn(
      `[learning-pot-gate] scout gate read failed for ${input.installSlug} — allowing ` +
        `(fail-open, R-5): ${e instanceof Error ? e.message : e}`,
    );
    return { enabled: true };
  }
}

/**
 * Gym's tick filter (P-003): the pots switched OFF in this workspace, as a set
 * matched against `gym_autoloop_config.harness_slug`.
 *
 * Gym does NOT go through `resolveLearningPotSlug` the way Scout does, because
 * a gym autoloop row is per-hive by construction — its harness slug IS the pot
 * slug, which is the same assumption the governor mirror already makes when it
 * ledgers gym spend (`potSlug: input.ran.harnessSlug`, registrants.ts). Keeping
 * the two consistent matters: if this resolved differently, a pot's gym spend
 * would be filed under one slug and gated under another.
 */
export async function gymDisabledPots(sql: Sql, workspaceId: string): Promise<ReadonlySet<string>> {
  const { disabledPotSlugs } = await import('./store');
  return new Set(await disabledPotSlugs(sql, { workspaceId }));
}
