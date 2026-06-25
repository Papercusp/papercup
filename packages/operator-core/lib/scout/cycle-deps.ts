/**
 * cycle-deps.ts — production wiring of the Scout cycle (hive-creative-ideation-2026-06-08).
 *
 * `buildScoutCycleDeps` assembles the concrete {@link ScoutCycleDeps} that
 * `runScoutCycle` (cycle.ts) drives — binding each injected port to its real
 * step module, mirroring `corpus-digest-deps.ts` / `router-deps.ts`. su-80be9's
 * `system:scout-cycle` action calls it: `buildScoutCycleDeps(opts) →
 * runScoutCycle(deps) → result.{routed,provenance,costUsd}`.
 *
 * THREE deps are irreducibly injected (a slug alone can't produce them in a pure
 * lib), so the action/scheduler supplies them:
 *  - `llmCall` — the real stateless LLM client (the gym:judge pattern);
 *  - `createPlanDraft` — the ctx-bound `plans:new` draft creator (plans:new needs
 *    operator ctx for the write-lock + revision + plan-event — the honest seam);
 *  - `archive` — su-8075f's gym QD `ArchivePort` for the gym rail (P-010/P-012).
 *
 * Everything else (the digest readers, the novelty corpus, the ideator/critic/
 * recombine/route wiring) is assembled here. The readers are overridable so this
 * is unit-testable without PG/LLM.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  synthesizeStateOfHive,
  type StateOfHiveReaders,
  type SynthesizeOptions,
} from './corpus-digest';
import { buildStateOfHiveReaders } from './corpus-digest-deps';
import { runIdeators, ScoutIdeatorsTransportError } from './ideators';
import { critiqueIdeas } from './critics';
import { recombineProposals } from './recombine';
import { routeProposals, makeWholeSystemInstanceOverride, type CapturePort, type RouterPorts } from './router';
import {
  buildCapturePort,
  buildGymDispatchPort,
  buildInstanceDispatchPort,
  buildPlansNewPort,
  type CapturePortOptions,
  type PlanDraftCreator,
} from './router-deps';
import { gatherSteppingStones, type ArchivePort } from './gym-bridge';
import { gatherGraderFeedbackPriming, type GradedIdeaView } from './ideator-feedback-priming';
import { getScoutLensWeights } from './routed-ledger';
import { CREATIVE_LENSES, type CreativeLens } from './types';
import { DEFAULT_SCOUT_CONFIG, type ScoutConfig } from './config';
import type { CorpusEntry } from './critique-core';
import type { ScoutCycleDeps, ScoutCycleLimits } from './cycle';
import type { ExperimentDispatchPort } from './experiment-rail';

export interface BuildScoutCycleDepsOptions {
  /** Harness this cycle runs for — scopes the concrete-rail improvement capture. */
  harnessSlug: string;
  /** Real stateless LLM client (the gym:judge pattern); the action/scheduler supplies it. */
  llmCall: ScoutCycleDeps['llmCall'];
  /** Ctx-bound `plans:new` draft creator (the broad rail) — the action supplies it. */
  createPlanDraft: PlanDraftCreator;
  /** su-8075f's gym QD archive (the testable rail's seed target, P-012/D-008). */
  archive: ArchivePort;
  /** Per-cycle limits (D-010). */
  limits?: ScoutCycleLimits;
  /** Opaque cycle id (provenance grouping). */
  cycleId?: string;
  /** Best-effort phase reporter used by scheduler timeout diagnostics. */
  onPhase?: ScoutCycleDeps['onPhase'];
  /** Override the state-of-Hive digest readers (tests). Default: prod `buildStateOfHiveReaders()`. */
  stateOfHiveReaders?: StateOfHiveReaders;
  /** Options forwarded to `synthesizeStateOfHive` (e.g. `nowMs`/`perCategory`). */
  digestOptions?: SynthesizeOptions;
  /** Override the search-first novelty corpus reader (tests). Default: prod plans + decisions. */
  noveltyCorpus?: () => Promise<CorpusEntry[]>;
  /** Capture-port options for the concrete rail (default scope = `harness:<slug>`, filed as the Queen). */
  captureOptions?: CapturePortOptions;
  /**
   * Override the concrete rail's capture port entirely (tests / the live-LLM quality
   * lane, which routes to inert sinks — real LLM, no live improvement writes). Default:
   * the production `buildCapturePort` over the real `captureImprovement`.
   */
  capturePort?: CapturePort;
  /**
   * Override the graded-ledger read behind the C-4 grader-feedback priming
   * (tests). Default: prod `readRoutedIdeas` (B-02's reader), harness-scoped.
   */
  graderFeedbackReader?: () => Promise<GradedIdeaView[]>;
  /** Override the dark experiment-rail dispatch port (tests). Default: the dry-run-only
   *  buildExperimentDispatchPort. Only consulted when SCOUT_EXPERIMENT_RAIL is ON. */
  experimentDispatch?: ExperimentDispatchPort;
  /**
   * Per-blueprint Scout tuning (P-009 scout-config seam): the ideator lens roster, the
   * search-first novelty knobs, the verdict-bucket thresholds, and the routing default +
   * whole-system marker vocabulary. Defaults to {@link DEFAULT_SCOUT_CONFIG} (byte-identical
   * to the previous hardcoded constants); the runner resolves it from the blueprint `scout` block.
   */
  scoutConfig?: ScoutConfig;
}

/**
 * Map a per-cycle ideator budget to an ideator roster. A budget below the lens
 * count runs only the first N lenses (one ideator each); at/above it, the default
 * one-per-lens roster runs. Never silences below one lens (D-004 floor).
 */
export function rosterForBudget(
  maxIdeators?: number,
  lenses: readonly CreativeLens[] = CREATIVE_LENSES,
): { lenses?: readonly CreativeLens[] } {
  if (maxIdeators == null || maxIdeators >= lenses.length) {
    // Full roster. Return {} ONLY for the engine-default lenses, so the default path keeps
    // deferring to the ideators' default roster + the meta-learned lens weighting
    // (behavior-neutral). A custom blueprint roster is passed explicitly (the weighting is
    // keyed to the default lenses, so it does not apply to a custom roster). (P-009)
    return lenses === CREATIVE_LENSES ? {} : { lenses: [...lenses] };
  }
  return { lenses: lenses.slice(0, Math.max(1, Math.floor(maxIdeators))) };
}

/**
 * Production search-first novelty corpus: prior plans (what's been designed) +
 * their ratified decisions (settled judgments) — the substrate the novelty critic
 * dedupes a fresh idea against (D-005, "reject the already-tried"). Defensive: a
 * failed query yields an empty corpus (the critic then leans on the LLM skeptic),
 * never a crashed cycle. Workspace-global on purpose — an idea must be novel vs the
 * whole Hive's history (D-003), not just one harness's.
 */
export async function readNoveltyCorpus(): Promise<CorpusEntry[]> {
  const out: CorpusEntry[] = [];
  try {
    const { sql } = getOrgPg();
    const plans = await sql<{ plan_slug: string; title: string | null; status: string | null }[]>`
      SELECT plan_slug, title, status
        FROM harness_shared.harness_plans
       WHERE archived = false
       ORDER BY updated DESC NULLS LAST
       LIMIT 500`;
    for (const p of plans) {
      out.push({
        ref: `plan:${p.plan_slug}`,
        kind: 'plan',
        text: p.title?.trim() || p.plan_slug.replace(/-/g, ' '),
        ...(p.status ? { state: p.status } : {}),
      });
    }
    const decisions = await sql<{ plan_slug: string; id: string | null; title: string | null }[]>`
      SELECT p.plan_slug, d->>'id' AS id, d->>'title' AS title
        FROM harness_shared.harness_plans p,
             jsonb_array_elements(COALESCE(p.decisions, '[]'::jsonb)) AS d
       WHERE d->>'title' IS NOT NULL
       LIMIT 1000`;
    for (const r of decisions) {
      if (!r.title) continue;
      out.push({ ref: `${r.plan_slug}#${r.id ?? ''}`, kind: 'decision', text: r.title });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[scout/cycle-deps] readNoveltyCorpus failed:', err instanceof Error ? err.message : err);
  }
  return out;
}

/**
 * Assemble the production {@link ScoutCycleDeps}. The router's three dispatch
 * ports are wired from `router-deps` (the broad rail through the injected ctx-bound
 * creator; the testable rail through su-8075f's archive; the concrete rail through
 * the real `captureImprovement`, harness-scoped). Each LLM step takes the
 * recorder-wrapped call `runScoutCycle` passes in.
 */
export function buildScoutCycleDeps(opts: BuildScoutCycleDepsOptions): ScoutCycleDeps {
  const routerPorts: RouterPorts = {
    plansNew: buildPlansNewPort(opts.createPlanDraft),
    gymDispatch: buildGymDispatchPort(opts.archive),
    capture:
      opts.capturePort ?? buildCapturePort({ scope: `harness:${opts.harnessSlug}`, ...opts.captureOptions }),
    // whole-system → InstanceSubject (reconciliation P-005). Acknowledge-only until the
    // apiary's intake queue is built — the routed-idea ledger (rail='instance') is the
    // pending-candidate record the apiary reads.
    instanceDispatch: buildInstanceDispatchPort(),
  };

  const readers = opts.stateOfHiveReaders ?? buildStateOfHiveReaders();
  const noveltyCorpus = opts.noveltyCorpus ?? readNoveltyCorpus;
  const scoutConfig = opts.scoutConfig ?? DEFAULT_SCOUT_CONFIG;

  return {
    llmCall: opts.llmCall,
    limits: opts.limits,
    cycleId: opts.cycleId,
    ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
    readCorpus: async () => {
      const digest = await synthesizeStateOfHive(readers, opts.digestOptions);
      // Scout `rubric` rail (plan-templates-and-rubric-v2 P-009, SCOUT_RUBRIC_RAIL,
      // default OFF): on a detected RUBRIC GAP (digest.rubricGaps, P-008) AUTHOR a
      // `template: rubric` DRAFT plan → the existing queen↔scout loop ratifies it into
      // an active rubric. Forked HERE (not the `route` port) because this is the seam
      // that holds the full StateOfHiveDigest (rubricGaps lives off the digest, not the
      // proposal flow). Best-effort + idempotent (a stable per-gap slug no-ops on
      // re-run): a failure or missing PG NEVER disturbs the digest or the cycle.
      try {
        if (digest.rubricGaps.length > 0) {
          const { getFlag } = await import('@papercusp/flags/server');
          const { FLAGS } = await import('@papercusp/flags');
          if (await getFlag(FLAGS.SCOUT_RUBRIC_RAIL, 'scout-rubric-rail')) {
            const { authorRubricGapPlans } = await import('./rubric-rail');
            await authorRubricGapPlans(digest.rubricGaps, { harnessSlug: opts.harnessSlug });
          }
        }
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] rubric-rail author failed (cycle unaffected):',
          err instanceof Error ? err.message : err,
        );
      }
      return digest;
    },
    readNoveltyCorpus: noveltyCorpus,
    // D-009 closure (P-013 → P-004 meta-learning): bias the EXTRA ideators toward
    // the lenses that have been winning, read from the PERSISTED scout_lens_weights
    // table (written by refreshScoutOutcomes after each cycle — P-033). Uniform at
    // cold start / on a PG hiccup, and the sampling floor (≥15% of uniform per lens)
    // keeps every lens alive (D-004). BUT when the per-cycle budget clamps
    // the roster (D-010), the cap wins — skip the meta-learned extras so the cycle
    // never over-spends (extraIdeatorBudget would otherwise add ideators past the cap).
    ideate: async (digest, ctx) => {
      const roster = rosterForBudget(ctx.maxIdeators, scoutConfig.lenses);
      const weighting = roster.lenses ? {} : await getScoutLensWeights({ harnessSlug: opts.harnessSlug });
      // P-012 archive→Scout FEED: prime the ideators with the gym QD archive's diverse
      // elites (stepping-stones), so Scout builds on / leaps away from what the gym has
      // found. Empty/no-op archive ⇒ no stones ⇒ no priming block (clean cold start).
      const { stones, priming } = gatherSteppingStones(opts.archive);
      // C-4 grader feedback (scout-idea-grading P-005): owner/Queen grades on recently
      // routed ideas, concatenated BELOW the stepping-stones on the same priming
      // channel. No graded rows / read failure ⇒ no block (clean cold start).
      const grader = await gatherGraderFeedbackPriming({
        harnessSlug: opts.harnessSlug,
        ...(opts.graderFeedbackReader ? { readRows: opts.graderFeedbackReader } : {}),
      });
      const primingBlocks = [...(stones.length ? [priming] : []), ...(grader.priming ? [grader.priming] : [])];
      const ideated = await runIdeators(digest, {
        llmCall: ctx.llmCall,
        ...roster,
        ...weighting,
        ...(primingBlocks.length ? { priming: primingBlocks.join('\n\n') } : {}),
        // P-010: per-blueprint ideator mission framing (default ⇒ byte-identical).
        mission: scoutConfig.framing.ideatorMission,
        model: scoutConfig.models.ideator,
      });
      // P-002 (transport-death observability): if EVERY ideator errored AND zero ideas
      // resulted, this is a TOTAL transport failure (gateway wedge / token 401 — $0 spent),
      // NOT a healthy 'no-ideas' cycle. Throw so the scheduler records an error tick + backs
      // the autoloop fire-gate off, instead of a benign 'ran/no-ideas' that hammers a dead
      // gateway every cadence. Partial failures still return their ideas (one dead ideator
      // never kills the batch — the existing defensive contract in runIdeators).
      if (
        ideated.ideas.length === 0 &&
        ideated.ideators.length > 0 &&
        ideated.ideators.every((i) => !i.ok)
      ) {
        throw new ScoutIdeatorsTransportError(
          ideated.ideators.length,
          ideated.ideators.find((i) => i.error)?.error,
        );
      }
      return ideated.ideas;
    },
    critique: async (ideas, ctx) =>
      (
        await critiqueIdeas(ideas, ctx.corpus, { llmCall: ctx.llmCall }, {
          novelty: scoutConfig.novelty,
          bucket: scoutConfig.buckets,
          // P-010: per-blueprint critic mission framing (default ⇒ byte-identical).
          critic: { mission: scoutConfig.framing.criticMission, model: scoutConfig.models.critic },
        })
      ).critiques,
    recombine: async (scored, ctx) =>
      (await recombineProposals(scored, { llmCall: ctx.llmCall }, { model: scoutConfig.models.recombine })).proposals,
    // The whole-system override realizes the P-005 split: a testable WHOLE-SYSTEM proposal
    // (genome's interacting wholes) routes to the InstanceSubject; a component idea stays on
    // the gym (HarnessSubject). plan/improvement/unhinted ideas are untouched.
    route: async (proposals) => {
      const result = await routeProposals(proposals, routerPorts, {
        override: makeWholeSystemInstanceOverride(scoutConfig.routing.wholeSystemMarkers),
        defaultRail: scoutConfig.routing.defaultRail,
      });
      // Dark Scout→experiment rail (SCOUT_EXPERIMENT_RAIL, default OFF — #2 "close the
      // loop"): ADDITIVELY express each testable (gym-rail) proposal as a DRY-RUN
      // experiment spec — proves the Scout→experiment:run loop with NO spend + NO change
      // to gym routing. Best-effort: a failure never disturbs the cycle's routing.
      try {
        const { getFlag } = await import('@papercusp/flags/server');
        const { FLAGS } = await import('@papercusp/flags');
        if (await getFlag(FLAGS.SCOUT_EXPERIMENT_RAIL, 'scout-experiment-rail')) {
          const { forkTestableToExperiments, buildExperimentDispatchPort } = await import('./experiment-rail');
          const { generateExperimentRequest } = await import('./experiment-generate');
          // Armed: LLM-generate a sharp candidate overlay + case per proposal (spends ~1
          // small LLM call each, bounded by the ≤maxGroups testable proposals/cycle),
          // falling back to the mechanical mapping on any failure. The dry-run after is $0.
          await forkTestableToExperiments(
            result.decisions,
            proposals,
            opts.experimentDispatch ?? buildExperimentDispatchPort(),
            (p) => generateExperimentRequest(p, opts.llmCall, { model: scoutConfig.models.experiment }),
          );
        }
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] experiment-rail fork failed (cycle unaffected):',
          err instanceof Error ? err.message : err,
        );
      }
      return result.decisions;
    },
  };
}
