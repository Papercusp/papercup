/**
 * pot-scope.ts — the ONE way a learning writer resolves the pot its row belongs to.
 *
 * Plan `pot-scope-all-learnings-2026-07-26`, P-002.
 * [owner:Avi 2026-07-25 interactive, verbatim] "THERE SHOULD BE NO WORKSPACE
 * SCOPED LEARNINGS. FIX THAT. ALL LEARNINGS SHOULD BE SCOPED TO A POT."
 *
 * ## Why this exists as a shared seam rather than inline in each store
 *
 * The learning stores were pot-less in three different ways, and each had its own
 * ad-hoc idea of scope: some carried `workspace_id` only, `code_recipes` carried
 * NOTHING, and the governor keyed its budgets by workspace (`blender:<workspace>`).
 * Measured 2026-07-25: `calibration_predictions` had 601 rows and 0 with a pot,
 * `scout_ticks` 208/2271, `code_recipe_runs` 2176/7371 — i.e. even where the column
 * already existed the writers mostly did not populate it. Eight call sites each
 * re-deriving "which pot is this?" is exactly how that drift happened, so the
 * derivation lives here once and the stores call it.
 *
 * ## The resolution order (deliberate)
 *
 *   1. An EXPLICIT `potSlug` from the caller — it knows best; never second-guessed.
 *   2. The pot that OWNS the given harness (`potHomeSlugForHarness`) — the harness
 *      is the member sub-grain, the pot/hive is the tenancy unit (owner's model).
 *   3. The process's home pot env (`PAPERCUSP_POT_HOME_SLUG`) — set for pot-scoped
 *      hosts and agent subprocesses.
 *   4. `null` — and null is a REAL answer, not a failure to paper over.
 *
 * ## Why null is returned rather than a fallback slug
 *
 * The tempting fourth step is "…else the home pot". That is precisely the bug class
 * this plan exists to remove: a wrong-but-plausible default is indistinguishable
 * from a correct attribution once written, and it silently re-creates cross-tenant
 * data (WI-5809: a read-side version of the same instinct showed one pot's gym
 * experiments under another pot's lens). A genuinely context-less system writer
 * should record `null` and be EXCLUDED from every pot lens (D-002, owner-ratified),
 * not be misfiled into someone's pot.
 */
import { potHomeSlugForHarness } from '../hive-federation';

export interface LearningPotScopeInput {
  workspaceId: string;
  /** An explicit pot/hive slug from the caller — wins outright when present. */
  potSlug?: string | null;
  /** The harness the work ran under; resolved to its owning pot when no explicit slug. */
  harnessSlug?: string | null;
  /** Forwarded to the registry read for a correctness-critical cross-process resolve. */
  fresh?: boolean;
}

/** Trim to a non-empty slug, or undefined. */
function clean(v: string | null | undefined): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : undefined;
}

/**
 * Resolve the pot a learning row belongs to. Returns `null` when the caller has no
 * resolvable pot — see the module doc for why that is a real answer and not a bug.
 * Never throws: a registry read failure degrades to the env/home step, because a
 * learning write must not be lost to a scope lookup.
 */
export async function resolveLearningPotSlug(input: LearningPotScopeInput): Promise<string | null> {
  const explicit = clean(input.potSlug);
  if (explicit) return explicit;

  const harness = clean(input.harnessSlug);
  if (harness) {
    try {
      const owner = clean(
        await potHomeSlugForHarness(
          input.workspaceId,
          harness,
          input.fresh ? { fresh: true } : undefined,
        ),
      );
      if (owner) return owner;
    } catch {
      // Registry unavailable (sidecar/test process with no org-PG) — fall through.
    }
    // A harness that resolves to no pot IS its own scope when it is itself a pot;
    // callers pass hive home slugs here routinely.
    return harness;
  }

  return clean(process.env.PAPERCUSP_POT_HOME_SLUG) ?? null;
}

/**
 * P-006's runtime companion: the tables that MUST carry a pot once P-002 is live.
 * The guard test asserts every one of these has the column AND that new rows carry
 * it, so a future writer cannot quietly reintroduce a workspace-scoped learning.
 */
export const POT_SCOPED_LEARNING_TABLES = [
  'harness_shared.transfer_lessons',
  'harness_shared.prompt_ablation_runs',
  'harness_shared.code_recipes',
  'harness_shared.code_recipe_runs',
  'harness_shared.calibration_predictions',
  'harness_shared.scout_ticks',
  'harness_shared.learning_governor_loops',
  'harness_shared.learning_spend_events',
] as const;
