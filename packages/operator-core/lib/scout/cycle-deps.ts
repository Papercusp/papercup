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
  buildFederatedMapLane,
  synthesizeStateOfHive,
  type StateOfHiveReaders,
  type SynthesizeOptions,
  type FederatedMapEliteRow,
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
import { activeWorkspaceId } from '../workspace-registry';
import { getOwnerSteering } from '../owner-steering';
import { resolveFederatedPrimingConfig, type FederatedPrimingConfig } from './federated-priming';

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
  /** Called when a deterministic Scout side rail authors a new draft plan that needs Queen review. */
  onScoutDraftCreated?: (draft: { slug: string; title: string }) => Promise<void>;
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

type FederatedArchiveSqlRow = {
  niche_key: string;
  candidate_id: string;
  scope: string;
  domain: string;
  risk: string;
  fitness: number;
  rationale: string | null;
  source_hive: string | null;
  novelty_gift: boolean | null;
};

type FederatedSeedView = {
  ref: string;
  nicheKey: string;
  fitness: number;
  rationale: string | null;
  sourceHive: string;
  scope: string;
  domain: string;
  risk: string;
  adjacentLocalNiche?: string;
  noveltyGift: boolean;
};

function changedGymDims(
  a: { scope: string; domain: string; risk: string },
  b: { scope: string; domain: string; risk: string },
): number {
  return Number(a.scope !== b.scope) + Number(a.domain !== b.domain) + Number(a.risk !== b.risk);
}

function buildNicheMapPriming(
  nicheMap: readonly { summary: string; ref: string }[],
  cfg: FederatedPrimingConfig,
): string | undefined {
  if (cfg.crowded <= 0 && cfg.empty <= 0) return undefined;
  const crowded = nicheMap.filter((p) => p.ref.startsWith('niche:v1:crowded:')).slice(0, cfg.crowded);
  const empty = nicheMap.filter((p) => p.ref.startsWith('niche:v1:empty:')).slice(0, cfg.empty);
  if (crowded.length === 0 && empty.length === 0) return undefined;
  const lines = [
    'AVOID crowded niches and TARGET empty niches when you choose what to mutate next.',
  ];
  if (crowded.length > 0) {
    lines.push('', 'Crowded niches to avoid:');
    for (const item of crowded) lines.push(`- ${item.summary} (ref: ${item.ref})`);
  }
  if (empty.length > 0) {
    lines.push('', 'Empty niches to target:');
    for (const item of empty) lines.push(`- ${item.summary} (ref: ${item.ref})`);
  }
  return lines.join('\n');
}

function buildFederatedSeedPriming(
  seeds: readonly FederatedSeedView[],
  cfg: FederatedPrimingConfig,
): string | undefined {
  if (cfg.foreignElites <= 0) return undefined;
  const picked = seeds.slice(0, cfg.foreignElites);
  if (picked.length === 0) return undefined;
  const lines = [
    '## Federated mutation seeds',
    'These won in a distant context. Recombine their mechanism with local friction; do not clone them verbatim. If you adapt one, cite it in `seededByRefs`.',
  ];
  for (const seed of picked) {
    const where = `${seed.scope}|${seed.domain}|${seed.risk}`;
    const adjacency = seed.adjacentLocalNiche ? `; one-step from local ${seed.adjacentLocalNiche}` : '';
    const novelty = seed.noveltyGift ? '; novelty gift' : '';
    lines.push(
      `- [${seed.sourceHive}] ${where} (fitness ${seed.fitness.toFixed(2)}, ref: ${seed.ref}${adjacency}${novelty})` +
        (seed.rationale ? ` — ${seed.rationale}` : ''),
    );
  }
  return lines.join('\n');
}

/**
 * Production search-first novelty corpus: prior plans (what's been designed) +
 * their ratified decisions (settled judgments) + routed-ledger idea titles (what
 * the Hive already generated and routed, with its won/lost outcome — P-008,
 * su-ideate-learning-substrate-2026-07-10) — the substrate the novelty critic
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
    // Routed-ledger idea titles (P-008): every idea the Hive already routed — the
    // outcome CACHE maps onto the corpus's decided-state vocabulary so a lost
    // idea reads as an already-tried prior ('dropped' ⇒ the alreadyTried penalty
    // + the "already tried, failed" priorArt signal) and a won one as 'shipped'.
    // Bounded: most recently routed first.
    const ideas = await sql<{ routed_ref: string; title: string | null; outcome: string | null }[]>`
      SELECT routed_ref, title, outcome
        FROM harness_shared.scout_routed_ideas
       WHERE title IS NOT NULL
       ORDER BY routed_at DESC
       LIMIT 500`;
    for (const r of ideas) {
      const text = r.title?.trim();
      if (!text) continue;
      const state = r.outcome === 'won' ? 'shipped' : r.outcome === 'lost' ? 'dropped' : undefined;
      out.push({ ref: r.routed_ref, kind: 'idea', text, ...(state ? { state } : {}) });
    }
  } catch (err) {
     
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
  const baseFederatedPriming = scoutConfig.federatedPriming;

  async function readFederatedPriming(): Promise<FederatedPrimingConfig> {
    try {
      const steering = await getOwnerSteering(activeWorkspaceId(), opts.harnessSlug);
      return resolveFederatedPrimingConfig(steering.federatedPriming ?? baseFederatedPriming);
    } catch {
      return { ...baseFederatedPriming };
    }
  }

  async function readFederatedArchive(): Promise<{
    merged: FederatedMapEliteRow[];
    foreignSeeds: FederatedSeedView[];
  }> {
    try {
      const { sql } = getOrgPg();
      const rows = (await sql<FederatedArchiveSqlRow[]>`
        SELECT
          niche_key,
          candidate_id,
          scope,
          domain,
          risk,
          fitness,
          rationale,
          NULL::text AS source_hive,
          NULL::boolean AS novelty_gift
        FROM harness_shared.gym_qd_archive
        WHERE workspace_id = ${activeWorkspaceId()}
          AND harness_slug = ${opts.harnessSlug}

        UNION ALL

        SELECT
          niche_key,
          candidate_id,
          scope,
          domain,
          risk,
          fitness,
          rationale,
          source_hive,
          novelty_gift
        FROM harness_shared.gym_qd_foreign_elites
        WHERE workspace_id = ${activeWorkspaceId()}
          AND harness_slug = ${opts.harnessSlug}
      `) as FederatedArchiveSqlRow[];

      const local = rows
        .filter((row) => !row.source_hive)
        .map((row) => ({
          nicheKey: row.niche_key,
          scope: row.scope,
          domain: row.domain,
          risk: row.risk,
        }));

      const foreignSeeds = rows
        .filter((row) => !!row.source_hive)
        .map<FederatedSeedView>((row) => {
          const adjacentLocal = local
            .filter((candidate) => changedGymDims(candidate, row) === 1)
            .map((candidate) => candidate.nicheKey)
            .sort()[0];
          return {
            ref: `elite:${row.source_hive}:${row.niche_key}:${row.candidate_id}`,
            nicheKey: row.niche_key,
            fitness: Number(row.fitness),
            rationale: row.rationale,
            sourceHive: row.source_hive!,
            scope: row.scope,
            domain: row.domain,
            risk: row.risk,
            ...(adjacentLocal ? { adjacentLocalNiche: adjacentLocal } : {}),
            noveltyGift: row.novelty_gift === true,
          };
        })
        .sort(
          (a, b) =>
            Number(!!b.adjacentLocalNiche) - Number(!!a.adjacentLocalNiche) ||
            Number(b.noveltyGift) - Number(a.noveltyGift) ||
            b.fitness - a.fitness ||
            a.nicheKey.localeCompare(b.nicheKey) ||
            a.sourceHive.localeCompare(b.sourceHive),
        );

      return {
        merged: rows.map((row) => ({
          nicheKey: row.niche_key,
          fitness: Number(row.fitness),
          sourceHive: row.source_hive,
          scope: row.scope,
          domain: row.domain,
          risk: row.risk,
          noveltyGift: row.novelty_gift,
        })),
        foreignSeeds,
      };
    } catch {
      return { merged: [], foreignSeeds: [] };
    }
  }

  return {
    llmCall: opts.llmCall,
    limits: opts.limits,
    cycleId: opts.cycleId,
    ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
    readCorpus: async () => {
      const federatedPriming = await readFederatedPriming();
      const digest = await synthesizeStateOfHive(readers, opts.digestOptions);
      // L1c (queen-memory-hybrid): fold live standing facts (harness + workspace
      // scopes) into the digest as a pattern lane so ideation is grounded in the
      // fleet's deterministic conclusions. Fail-soft — a facts outage never
      // disturbs the digest or the cycle.
      try {
        const { foldFacts } = await import('../agent-facts/store');
        const facts = await foldFacts(
          [{ scope: 'workspace' }, { scope: 'harness', scopeRef: opts.harnessSlug }],
          {},
        );
        if (facts.length > 0) {
          digest.standingFacts = facts.map((f) => ({
            summary: f.body,
            ref: `fact:${f.scope}${f.scopeRef ? `:${f.scopeRef}` : ''}:${f.key}`,
            ...(f.sourceRef ? { detail: `src ${f.sourceRef}` } : {}),
          }));
        }
      } catch {
        /* best-effort */
      }
      // NOV-1 (gym-unwedge-scout-novelty): the QD NICHE MAP lane — occupied
      // gym_qd_archive niches (behavior space: scope × domain × risk) so the
      // ideators actively steer toward UNEXPLORED territory (quality-diversity
      // novelty search). Fail-soft; an empty archive adds nothing.
      try {
        const { merged } = await readFederatedArchive();
        const nicheMap = buildFederatedMapLane(merged, {
          crowdedLimit: federatedPriming.crowded,
          emptyLimit: federatedPriming.empty,
        });
        if (nicheMap.length > 0) digest.nicheMap = nicheMap;
      } catch {
        /* best-effort */
      }
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
            const { createScoutPlanDraft } = await import('./scout-plan-draft');
            await authorRubricGapPlans(
              digest.rubricGaps,
              { harnessSlug: opts.harnessSlug },
              opts.onScoutDraftCreated
                ? {
                    createDraft: async (input) => {
                      const res = await createScoutPlanDraft(input);
                      if (res.created) {
                        try {
                          await opts.onScoutDraftCreated?.({ slug: res.slug, title: input.title });
                        } catch {
                          /* best-effort — a notify never breaks rubric authoring */
                        }
                      }
                      return res;
                    },
                  }
                : undefined,
            );
          }
        }
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] rubric-rail author failed (cycle unaffected):',
          err instanceof Error ? err.message : err,
        );
      }
      // DELTA-FIRST substrate (blender-self-learning-2026-07-12 P-003 /
      // WI-4319): diff this digest against the previous fired cycle's persisted
      // snapshot — read the previous refs, persist the CLEAN fresh digest as
      // the new snapshot, then stamp `previousCycleRefs` so renderDigest leads
      // the ideator prompt with "NEW since your last cycle". Best-effort by
      // contract: a snapshot outage never disturbs the digest or the cycle,
      // and no stamp = the legacy whole-digest rendering.
      try {
        const { readPreviousSnapshotRefs, persistDigestSnapshot } = await import(
          './digest-snapshots'
        );
        const prevRefs = await readPreviousSnapshotRefs();
        await persistDigestSnapshot({
          digest,
          installSlug: opts.harnessSlug,
          cycleId: opts.cycleId ?? null,
        });
        if (prevRefs.size > 0) digest.previousCycleRefs = [...prevRefs];
      } catch (err) {
        console.warn(
          '[scout/cycle-deps] digest-snapshot leg failed (cycle unaffected):',
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
      const federatedPriming = await readFederatedPriming();
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
      const { foreignSeeds } = await readFederatedArchive();
      const nicheMapPriming = buildNicheMapPriming(digest.nicheMap ?? [], federatedPriming);
      const federatedSeedPriming = buildFederatedSeedPriming(foreignSeeds, federatedPriming);
      const primingBlocks = [
        ...(federatedSeedPriming ? [federatedSeedPriming] : []),
        ...(stones.length ? [priming] : []),
        ...(grader.priming ? [grader.priming] : []),
      ];
      const ideated = await runIdeators(digest, {
        llmCall: ctx.llmCall,
        ...roster,
        ...weighting,
        ...(primingBlocks.length ? { priming: primingBlocks.join('\n\n') } : {}),
        ...(nicheMapPriming ? { nicheMapPriming } : {}),
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
