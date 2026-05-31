/**
 * Wave-advance sweep (promote-policy-and-waves-2026-05-30, P-009).
 *
 * A periodic, deterministic sweep that advances each started plan's `## Promote`
 * waves: when the current wave drains, promote the next one. The DECISION is pure
 * (`decideWaveAdvance`); this module is the orchestration + the side-effects
 * (querying started plans/features, launching the next promote, bumping the
 * cursor, surfacing a blocked wave).
 *
 * Side-effects are injected (`WaveSweepDeps`) so the tick loop is unit-testable
 * without PG or an agent launch — the real adapters (P-009b-ii) are thin.
 *
 * Idempotency: the promote is launched, THEN the cursor is set to the promoted
 * wave. The next tick sees that wave un-populated (features not created yet) →
 * `decideWaveAdvance` returns `none` (in-flight guard) → no re-promote. A promote
 * that throws does NOT advance the cursor, so it retries next tick.
 */
import { decideWaveAdvance, type WaveFeature, type WaveForAdvance } from './waves';

export interface StartedPlan {
  slug: string;
  harnessSlug: string;
  currentWave: string | null;
}

export interface WaveSweepDeps {
  /** Plans in harness_plan_status with status='started', + their current_wave. */
  listStartedPlans(): Promise<StartedPlan[]>;
  /** The plan's `## Promote` waves (id + needsItems), or null if it has no policy. */
  getPlanWaves(slug: string): Promise<WaveForAdvance[] | null>;
  /** The plan's features (consolidated, with wave/status/attempts) for the drain check. */
  getPlanFeatures(plan: StartedPlan): Promise<WaveFeature[]>;
  /** Launch the next-wave promote (the promote agent / policy-mode plans:promote). */
  promoteWave(p: { slug: string; harnessSlug: string; wave: string; needsItems: boolean }): Promise<void>;
  /** Advance the plan's current_wave cursor (after a promote is launched). */
  setCursor(p: { slug: string; harnessSlug: string; wave: string }): Promise<void>;
  /** Surface a blocked wave (a failing/stuck feature stalls the advance). */
  onBlocked(p: { slug: string; harnessSlug: string; wave: string }): Promise<void>;
  log?(msg: string): void;
}

export interface WaveTickSummary {
  promoted: number;
  blocked: number;
  waiting: number;
  /** Started plans with no `## Promote` policy (not wave-managed). */
  skipped: number;
  errors: number;
}

/**
 * One sweep tick: advance every started plan that's ready. Pure orchestration over
 * the injected deps — a plan with no `## Promote` policy is skipped (the sweep is a
 * no-op for non-policy plans). Never throws on a per-plan failure; it's counted.
 */
export async function runWaveAdvanceTick(deps: WaveSweepDeps): Promise<WaveTickSummary> {
  const s: WaveTickSummary = { promoted: 0, blocked: 0, waiting: 0, skipped: 0, errors: 0 };
  const plans = await deps.listStartedPlans();
  for (const plan of plans) {
    try {
      const waves = await deps.getPlanWaves(plan.slug);
      if (!waves) {
        s.skipped++;
        continue;
      }
      const features = await deps.getPlanFeatures(plan);
      const action = decideWaveAdvance({ waves, currentWave: plan.currentWave, features });
      if (action.kind === 'promote') {
        // Launch first, then advance the cursor (idempotency — see header).
        await deps.promoteWave({
          slug: plan.slug,
          harnessSlug: plan.harnessSlug,
          wave: action.wave,
          needsItems: action.needsItems,
        });
        await deps.setCursor({ slug: plan.slug, harnessSlug: plan.harnessSlug, wave: action.wave });
        s.promoted++;
        deps.log?.(`[wave-advance] ${plan.slug}@${plan.harnessSlug}: promoted wave "${action.wave}"`);
      } else if (action.kind === 'blocked') {
        await deps.onBlocked({ slug: plan.slug, harnessSlug: plan.harnessSlug, wave: action.wave });
        s.blocked++;
        deps.log?.(`[wave-advance] ${plan.slug}@${plan.harnessSlug}: wave "${action.wave}" BLOCKED`);
      } else {
        s.waiting++;
      }
    } catch (e) {
      s.errors++;
      deps.log?.(`[wave-advance] ${plan.slug}: tick error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return s;
}
