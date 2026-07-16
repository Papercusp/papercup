/**
 * release-profile.ts — the papercusp WIRING for the generic composite release-profile
 * evaluator (`@papercusp/release-profile`; rubric-system-and-auto-loop-release-profile-
 * 2026-07-15 P-006).
 *
 * The generic lib knows nothing about rubrics, scorecards, or git — it only combines
 * `ComponentSpec.check()` results into one GO/NO-GO, applying staleness + lineage
 * policy uniformly. This module supplies the two concrete component KINDS the plan
 * calls for:
 *
 *   - a RUBRIC component — the latest COMPLETE scorecard for an ACTIVE, releaseGating
 *     rubric, reduced to a worst-case pass/fail/unknown verdict (reuses the existing
 *     `rubrics`/`scorecards` read paths — no new rubric machinery);
 *   - a hard OPERATIONAL GATE component — deploy-pin staleness, reusing the already-
 *     written (but previously unwired) `evaluateDeployStaleness` pure decision + the
 *     `git-ops` primitives this package already ships.
 *
 * `buildPapercuspReleaseProfile` assembles every ACTIVE `releaseGating` rubric plus the
 * deploy-staleness gate into one `ReleaseProfileSpec`, stamped with the RUNNING
 * generation as `expectedLineage` (EI-12147's sha/hostStartedAt identity) so a
 * scorecard graded against a stale/different generation is refused as
 * 'lineage-mismatch', not silently accepted. `evaluatePapercuspReleaseProfile` runs it
 * through the generic evaluator. This is the CORE artifact WI-3548's GO/NO-GO synthesis
 * consumes — P-007/P-008 add the missing component rubrics and the strict live gates
 * this composes; this module's job is the reusable schema/evaluator + a REAL, proven
 * wiring of at least one of each component kind.
 */
import {
  evaluateReleaseProfile,
  type ComponentCheckResult,
  type ComponentRawVerdict,
  type ComponentSpec,
  type EvaluateReleaseProfileOpts,
  type ReleaseProfileSpec,
  type ReleaseProfileVerdict,
} from '@papercusp/release-profile';
import { getRubric as defaultGetRubric, listRubrics as defaultListRubrics } from '@papercusp/operator-core/lib/rubrics';
import { listScorecards as defaultListScorecards, type ScorecardRow } from '@papercusp/operator-core/lib/scorecards';
import { readRunningGeneration as defaultReadRunningGeneration } from '@papercusp/operator-core/lib/scout/generation-watermark';
import { currentSha as defaultCurrentSha, commitUnixTime as defaultCommitUnixTime, commitsBetween as defaultCommitsBetween } from './git-ops';
import {
  evaluateDeployStaleness,
  deployStalenessThresholdsFromEnv,
  type DeployStalenessThresholds,
} from './green-checkpoint';

// ─── rating → gate verdict classification ──────────────────────────────────────────

/** Ratings this adapter treats as a full PASS for gating purposes. */
const GATE_PASS_RATINGS = new Set(['pass', 'healthy', 'good', 'yes', 'green', 'exemplary', 'exceptional']);
/** Ratings that mean "not yet assessable" — distinct from a real FAIL. */
const GATE_UNKNOWN_RATINGS = new Set(['unknown']);
// Everything else — fail/broken/bad/no/red/severe, AND partial/degraded/mixed/warn —
// classifies FAIL: a release gate must not silently treat "partial"/"degraded" as good
// enough to GO (an averaged score is fine for a trend; a gate needs a crisp cutoff).

/** PURE: classify one rubric criterion rating into the gate's 3-way raw verdict. */
export function classifyRatingForGate(rating: string): ComponentRawVerdict {
  const key = rating.trim().toLowerCase();
  if (GATE_PASS_RATINGS.has(key)) return 'pass';
  if (GATE_UNKNOWN_RATINGS.has(key)) return 'unknown';
  return 'fail';
}

const VERDICT_SEVERITY: Record<ComponentRawVerdict, number> = { pass: 0, unknown: 1, fail: 2 };

/** PURE: the worst-case verdict across a scorecard's ratings, with the criterion that
 *  produced it. A release gate does not average away one broken/unknown criterion —
 *  any single non-pass criterion sinks the whole component. */
export function worstCaseVerdict(
  ratings: Record<string, { rating: string }>,
): { verdict: ComponentRawVerdict; worstKey: string | null; worstRating: string | null } {
  let verdict: ComponentRawVerdict = 'pass';
  let worstKey: string | null = null;
  let worstRating: string | null = null;
  for (const [key, entry] of Object.entries(ratings)) {
    const v = classifyRatingForGate(entry.rating);
    if (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[verdict]) {
      verdict = v;
      worstKey = key;
      worstRating = entry.rating;
    }
  }
  return { verdict, worstKey, worstRating };
}

// ─── rubric-verdict component ───────────────────────────────────────────────────────

/** Mirrors rubric-staleness-watchdog.ts's default alert threshold (EI-12149) — the same
 *  "how long may a release-gating rubric go ungraded" policy, applied here as the
 *  component's staleness window instead of a separate alert. */
export const DEFAULT_RUBRIC_STALE_AFTER_MS = 6 * 60 * 60_000;

export interface RubricComponentDeps {
  getRubric?: typeof defaultGetRubric;
  listScorecards?: typeof defaultListScorecards;
}

export interface RubricComponentOpts {
  /** Default true — a release-gating rubric normally gates GO. */
  mandatory?: boolean;
  /** Default {@link DEFAULT_RUBRIC_STALE_AFTER_MS}. */
  maxAgeMs?: number;
  sourceHive?: string;
  deps?: RubricComponentDeps;
}

/**
 * Build a `ComponentSpec` that reduces one rubric's LATEST COMPLETE scorecard to a
 * pass/fail/unknown verdict. 'unknown' when: the rubric doesn't resolve, isn't
 * `active` (not ratified — grading an unratified draft can never authorize GO), has no
 * scorecard on record, or its latest scorecard is INCOMPLETE (missing/extra keys —
 * never misread an incomplete card's happenstance-empty gaps as "all rated").
 * `gradedGeneration` (when the scorecard carries one) becomes this component's
 * `lineage`, so a profile-level `expectedLineage` mismatch is caught by the evaluator.
 */
export function rubricReleaseComponent(rubricRef: string, opts: RubricComponentOpts = {}): ComponentSpec {
  const mandatory = opts.mandatory ?? true;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RUBRIC_STALE_AFTER_MS;
  const getRubricFn = opts.deps?.getRubric ?? defaultGetRubric;
  const listScorecardsFn = opts.deps?.listScorecards ?? defaultListScorecards;

  return {
    key: `rubric:${rubricRef}`,
    title: `Rubric verdict — ${rubricRef}`,
    mandatory,
    maxAgeMs,
    async check(): Promise<ComponentCheckResult> {
      const now = new Date().toISOString();
      const rubric = await getRubricFn(rubricRef);
      if (!rubric) {
        return { verdict: 'unknown', reason: `rubric '${rubricRef}' not found`, measuredAt: now, evidence: [] };
      }
      if (rubric.status !== 'active') {
        return {
          verdict: 'unknown',
          reason: `rubric '${rubricRef}' is not ratified (status: ${rubric.status})`,
          measuredAt: now,
          evidence: [],
        };
      }
      const rows: ScorecardRow[] = await listScorecardsFn({ rubricRef, sourceHive: opts.sourceHive, limit: 1 });
      const latest = rows[0];
      if (!latest) {
        return { verdict: 'unknown', reason: `no scorecard on record for '${rubricRef}'`, measuredAt: now, evidence: [] };
      }
      const lineage = latest.gradedGeneration ? { sha: latest.gradedGeneration.sha } : null;
      const evidence = [{ ref: latest.issueId, kind: 'scorecard', detail: { sourceHive: latest.sourceHive ?? null } }];
      if (!latest.rubricResolved || latest.missingKeys.length > 0 || latest.extraKeys.length > 0) {
        return {
          verdict: 'unknown',
          reason:
            `latest scorecard for '${rubricRef}' is INCOMPLETE ` +
            `(missing: ${latest.missingKeys.join(', ') || 'none'}; extra: ${latest.extraKeys.join(', ') || 'none'})`,
          measuredAt: latest.createdAt,
          evidence,
          lineage,
        };
      }
      const { verdict, worstKey, worstRating } = worstCaseVerdict(latest.ratings);
      return {
        verdict,
        reason:
          verdict === 'pass'
            ? `all ${Object.keys(latest.ratings).length} criteria pass`
            : `criterion '${worstKey}' rated '${worstRating}'`,
        measuredAt: latest.createdAt,
        evidence,
        lineage,
      };
    },
  };
}

// ─── hard operational gate: deploy-pin staleness ───────────────────────────────────

export interface DeployStalenessGateDeps {
  /** Resolve the DEPLOYED sha (the running generation's identity). Defaults to
   *  readRunningGeneration().sha. */
  deployedSha?: () => Promise<string | null>;
  currentSha?: typeof defaultCurrentSha;
  commitUnixTime?: typeof defaultCommitUnixTime;
  commitsBetween?: typeof defaultCommitsBetween;
}

export interface DeployStalenessGateOpts {
  /** The integration-tree repo path git-ops reads. Defaults to
   *  PAPERCUSP_INTEGRATION_ROOT, else process.cwd(). */
  repo?: string;
  mandatory?: boolean;
  thresholds?: DeployStalenessThresholds;
  deps?: DeployStalenessGateDeps;
}

/**
 * Build the hard-gate `ComponentSpec` wrapping the existing (previously unwired)
 * `evaluateDeployStaleness` pure decision: is the deployed pin too old / too many
 * commits behind the integration tip? Reuses `git-ops.ts`'s commit primitives to
 * measure `pinAgeMs`/`commitsBehind` live — no new git plumbing.
 */
export function deployStalenessGateComponent(opts: DeployStalenessGateOpts = {}): ComponentSpec {
  const repo = opts.repo ?? process.env.PAPERCUSP_INTEGRATION_ROOT ?? process.cwd();
  const mandatory = opts.mandatory ?? true;
  const deployedShaFn =
    opts.deps?.deployedSha ?? (async () => (await defaultReadRunningGeneration()).sha);
  const currentShaFn = opts.deps?.currentSha ?? defaultCurrentSha;
  const commitUnixTimeFn = opts.deps?.commitUnixTime ?? defaultCommitUnixTime;
  const commitsBetweenFn = opts.deps?.commitsBetween ?? defaultCommitsBetween;

  return {
    key: 'gate:deploy-staleness',
    title: 'Deploy pin staleness gate',
    mandatory,
    async check(): Promise<ComponentCheckResult> {
      const now = new Date().toISOString();
      const deployedSha = await deployedShaFn();
      if (!deployedSha) {
        return { verdict: 'unknown', reason: 'could not resolve the deployed sha', measuredAt: now, evidence: [] };
      }
      const [candidateSha, commitTimeSec] = await Promise.all([
        currentShaFn(repo),
        commitUnixTimeFn(repo, deployedSha),
      ]);
      const pinAgeMs = Date.now() - commitTimeSec * 1000;
      const commitsBehind = (await commitsBetweenFn(repo, deployedSha, candidateSha)).length;
      const thresholds = opts.thresholds ?? deployStalenessThresholdsFromEnv();
      const verdict = evaluateDeployStaleness({ pinAgeMs, commitsBehind }, thresholds);
      return {
        verdict: verdict.alarm ? 'fail' : 'pass',
        reason: verdict.alarm
          ? verdict.message
          : `deploy pin ${deployedSha.slice(0, 12)} is ${Math.round(pinAgeMs / 3_600_000)}h old, ${commitsBehind} commit(s) behind candidate`,
        measuredAt: now,
        evidence: [{ ref: deployedSha, kind: 'git-sha', detail: { pinAgeMs, commitsBehind, candidateSha } }],
        lineage: { sha: deployedSha },
      };
    },
  };
}

// ─── the assembled papercusp profile ────────────────────────────────────────────────

export const PAPERCUSP_RELEASE_PROFILE_REF = 'papercusp-public-release-readiness';

export interface BuildPapercuspReleaseProfileDeps {
  listRubrics?: typeof defaultListRubrics;
  readRunningGeneration?: typeof defaultReadRunningGeneration;
}

export interface BuildPapercuspReleaseProfileOpts {
  profileRef?: string;
  /** Extra components (e.g. future P-007/P-008 component rubrics or gates) to compose
   *  alongside the auto-discovered releaseGating rubrics + the deploy-staleness gate. */
  extraComponents?: ComponentSpec[];
  rubricOpts?: Omit<RubricComponentOpts, 'mandatory'>;
  gateOpts?: DeployStalenessGateOpts;
  deps?: BuildPapercuspReleaseProfileDeps;
}

/**
 * Assemble the papercusp release profile: every ACTIVE `releaseGating` rubric (auto-
 * discovered — a newly-ratified release-gating rubric is picked up with no code
 * change) + the deploy-staleness hard gate, stamped with the RUNNING generation as
 * `expectedLineage` so evidence graded against a stale/different generation is
 * refused as 'lineage-mismatch'.
 */
export async function buildPapercuspReleaseProfile(
  opts: BuildPapercuspReleaseProfileOpts = {},
): Promise<ReleaseProfileSpec> {
  const listRubricsFn = opts.deps?.listRubrics ?? defaultListRubrics;
  const readRunningGenerationFn = opts.deps?.readRunningGeneration ?? defaultReadRunningGeneration;

  const [releaseGatingRubrics, generation] = await Promise.all([
    listRubricsFn({ status: 'active' }).then((rows) => rows.filter((r) => r.releaseGating === true)),
    readRunningGenerationFn(),
  ]);

  // Reuse the Rubric objects listRubrics already fetched instead of a redundant
  // per-component getRubric round-trip — resolve by id from this same read unless the
  // caller explicitly injected its own getRubric (e.g. a test fixture).
  const rubricById = new Map(releaseGatingRubrics.map((r) => [r.rubricId, r]));
  const rubricDeps = {
    ...opts.rubricOpts?.deps,
    getRubric: opts.rubricOpts?.deps?.getRubric ?? (async (ref: string) => rubricById.get(ref) ?? null),
  };

  return {
    profileRef: opts.profileRef ?? PAPERCUSP_RELEASE_PROFILE_REF,
    ...(generation.sha ? { expectedLineage: { sha: generation.sha } } : {}),
    components: [
      ...releaseGatingRubrics.map((r) =>
        rubricReleaseComponent(r.rubricId, { ...opts.rubricOpts, deps: rubricDeps }),
      ),
      deployStalenessGateComponent(opts.gateOpts),
      ...(opts.extraComponents ?? []),
    ],
  };
}

/** Build + evaluate the papercusp release profile in one call — the entry point
 *  WI-3548's GO/NO-GO synthesis consumes. `evaluateOpts` threads through to the
 *  generic evaluator (e.g. an injectable `now` for deterministic tests). */
export async function evaluatePapercuspReleaseProfile(
  opts: BuildPapercuspReleaseProfileOpts & { evaluateOpts?: EvaluateReleaseProfileOpts } = {},
): Promise<ReleaseProfileVerdict> {
  const spec = await buildPapercuspReleaseProfile(opts);
  return evaluateReleaseProfile(spec, opts.evaluateOpts);
}
