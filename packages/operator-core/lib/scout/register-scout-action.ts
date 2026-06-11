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
 *   - archive — the gym-QD ArchivePort. P-012 production wire: built per cycle from
 *     su-8075f's real archive via {@link buildScoutArchivePort} (snapshot→seed→flush),
 *     so the gym (testable) rail seeds Scout's distant ideas into the MAP-Elites
 *     archive. Falls back to a NO-OP if the archive is unavailable (e.g. PG/migration
 *     193 absent) — the broad + concrete rails are unaffected.
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
import { buildScoutArchivePort, type ScoutArchivePort } from './scout-archive-port';
import { nicheKey, type ArchivePort } from './gym-bridge';

/**
 * Placeholder gym-QD archive used when the real archive can't be built (PG down /
 * migration 193 absent). Reads empty + admits nothing, so the gym-seed rail is a
 * safe no-op (the broad/concrete rails are unaffected).
 */
export const noopArchive: ScoutArchivePort = {
  listElites: () => [],
  seed: (entry) => ({ admitted: false, nicheKey: nicheKey(entry.descriptor.coords) }),
  flush: async () => {},
};

/** Builds the per-cycle ArchivePort for a harness (overridable for tests / alternate stores). */
export type ScoutArchiveBuilder = (scope: { workspaceId: string; harnessSlug: string }) => Promise<ArchivePort>;

const defaultArchiveBuilder: ScoutArchiveBuilder = (scope) => buildScoutArchivePort(scope);

let activeArchiveBuilder: ScoutArchiveBuilder = defaultArchiveBuilder;

/** Swap the archive builder (a test, or an alternate gym-QD store). */
export function setScoutArchiveBuilder(builder: ScoutArchiveBuilder): void {
  activeArchiveBuilder = builder;
}

/** Build the cycle's archive, degrading to the no-op if the real one is unavailable. */
async function resolveArchive(scope: { workspaceId: string; harnessSlug: string }): Promise<ArchivePort> {
  try {
    return await activeArchiveBuilder(scope);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[register-scout-action] archive unavailable — gym rail no-ops this cycle:', err instanceof Error ? err.message : err);
    return noopArchive;
  }
}

/**
 * The production Scout cycle runner the `system:scout-cycle` action invokes:
 * assembles cb4b9's cycle deps with the real llmCall + the system-side plan-draft
 * creator + the per-cycle archive, runs one budgeted cycle, then flushes any
 * buffered scout seeds to the archive (P-012).
 */
export const productionScoutRunner: ScoutCycleRunner = async ({ harnessSlug, workspaceId, budget, cycleId }) => {
  const { llmCall } = await import('../llm-testing/llm-client');
  const { DEFAULT_WORKSPACE_ID } = await import('../workspace-id-constant');
  const archive = await resolveArchive({ workspaceId, harnessSlug });
  const deps = buildScoutCycleDeps({
    harnessSlug,
    llmCall,
    // Draft plans are pinned to the DEFAULT workspace, NOT the routine's ctx
    // workspace: the whole plan surface (plans:* dispatch, Create tab, plan
    // projections) lives under 'default', so a draft written under the
    // routine's 'papercusp-workspace' is invisible to every plan UI/read
    // (live miss 2026-06-11 — 3 routed drafts stranded). The routed-idea
    // LEDGER row keeps the ctx workspace (learning.scout reads it there).
    createPlanDraft: (args) =>
      createScoutPlanDraft({ ...args, harnessSlug, workspaceId: DEFAULT_WORKSPACE_ID }),
    archive,
    limits: { maxCostUsd: budget.maxCostUsd, maxIdeators: budget.maxIdeators },
    cycleId,
  });
  try {
    return await runScoutCycle(deps);
  } finally {
    // Persist scout seeds (P-012) even if the cycle threw mid-route.
    if (isFlushable(archive)) {
      try {
        await archive.flush();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[register-scout-action] archive flush failed:', err instanceof Error ? err.message : err);
      }
    }
  }
};

function isFlushable(a: ArchivePort): a is ScoutArchivePort {
  return typeof (a as ScoutArchivePort).flush === 'function';
}

// Self-register at module load (the *-actions.ts convention).
registerScoutCycleAction(productionScoutRunner);
