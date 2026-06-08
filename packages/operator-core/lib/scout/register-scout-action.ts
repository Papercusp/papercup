/**
 * register-scout-action.ts — Scout P-008 boot wire: registers `system:scout-cycle`
 * with a PRODUCTION cycle runner (cb4b9's buildScoutCycleDeps + runScoutCycle),
 * supplying the three irreducibly-injected deps the action owns:
 *
 *   - llmCall — the real meridian client (lib/llm-testing/llm-client; it satisfies
 *     ScoutLlmCall directly via the gym:judge pattern). Lazily imported so a boot
 *     that only REGISTERS the action never loads the meridian graph (the gym's
 *     ab-run pattern); it loads on the first real cycle.
 *   - createPlanDraft — the system-side `plans:new` DRAFT creator (scout-plan-draft).
 *   - archive — su-8075f's gym-QD ArchivePort for the gym (testable) rail. P-012's
 *     production async→sync ArchivePort adapter (a32af's lane) is not yet landed,
 *     so a NO-OP archive is the default: the broad (plans:new) + concrete
 *     (improvements:capture) rails activate now; the gym-seed rail records nothing
 *     admitted until the real adapter replaces it via {@link setScoutArchive}.
 *
 * Side-effect import: harness/routines/register-system-actions.ts imports this so
 * the routines engine can dispatch a seeded `system:scout-cycle` routine. The
 * routine itself is seeded INACTIVE (seed-scout-routine.ts) — bring-up is
 * human-gated (D-002).
 */

import { registerScoutCycleAction, type ScoutCycleRunner } from './scout-cycle-action';
import { runScoutCycle } from './cycle';
import { buildScoutCycleDeps } from './cycle-deps';
import { createScoutPlanDraft } from './scout-plan-draft';
import { nicheKey, type ArchivePort } from './gym-bridge';

/**
 * Placeholder gym-QD archive until P-012's production async→sync ArchivePort
 * adapter (over su-8075f's Archive) lands. Reads empty + admits nothing, so the
 * gym-seed rail is a safe no-op (the broad/concrete rails are unaffected).
 */
export const noopArchive: ArchivePort = {
  listElites: () => [],
  seed: (entry) => ({ admitted: false, nicheKey: nicheKey(entry.descriptor.coords) }),
};

let activeArchive: ArchivePort = noopArchive;

/** Swap in the real gym-QD ArchivePort (P-012's adapter calls this at its boot). */
export function setScoutArchive(archive: ArchivePort): void {
  activeArchive = archive;
}

/**
 * The production Scout cycle runner the `system:scout-cycle` action invokes:
 * assembles cb4b9's cycle deps with the real llmCall + the system-side plan-draft
 * creator + the active archive, then runs one budgeted cycle.
 */
export const productionScoutRunner: ScoutCycleRunner = async ({ harnessSlug, workspaceId, budget, cycleId }) => {
  const { llmCall } = await import('../llm-testing/llm-client');
  const deps = buildScoutCycleDeps({
    harnessSlug,
    llmCall,
    createPlanDraft: (args) => createScoutPlanDraft({ ...args, harnessSlug, workspaceId }),
    archive: activeArchive,
    limits: { maxCostUsd: budget.maxCostUsd, maxIdeators: budget.maxIdeators },
    cycleId,
  });
  return runScoutCycle(deps);
};

// Self-register at module load (the *-actions.ts convention).
registerScoutCycleAction(productionScoutRunner);
