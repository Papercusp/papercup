/**
 * The reproducibility-layer types (BRIEF 8 / P-010). The per-(task × arm × seed)
 * scoreable row — `TaskRunResult` — is OWNED by P-011 (`@papercusp/bench-metrics`)
 * and imported here; this file owns the two repro artifacts that wrap it:
 *
 *   RolloutRecord — the Rollout-Card published unit (arXiv 2605.12131): the full
 *     config snapshot, exact model/harness versions + git sha, env fingerprint,
 *     VERBATIM raw grader output, the graded submission, and the trajectory
 *     pointer. 1:1 with a run_result via the shared `rolloutId`.
 *   PreregRecord — the pre-registered run config, content-hashed and committed to
 *     git before the run (the tune-to-test firewall).
 *   EmitRolloutInput — the structured input every arm runner hands to
 *     emitRollout(); one call writes the run_result row + the rollout card.
 *
 * snake_case (PG, migration 291) ↔ camelCase (TS) is the persistence seam, owned
 * here in store.ts (rows → TaskRunResult) + emit.ts (input → rows).
 */
import type {
  ArmId,
  BenchSuite,
  GenerationStatus,
  GraderModality,
  GraderStatus,
  TestOutcome,
} from '@papercusp/bench-metrics';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';

const pin = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const distinct = <T>(items: T[]) => new Set(items).size === items.length;
const taskRoster = z.array(pin).min(1).refine(distinct, 'Task ids must be unique.');
const seeds = z.array(z.number().int().nonnegative()).min(1).refine(distinct, 'Seeds must be unique.');
const generationCap = z.object({
  maxUsd: z.number().finite().positive(),
  maxTokens: z.number().int().positive().optional(),
  maxWallClockMs: z.number().int().positive(),
}).strict();

/** Current runs extend the existing prereg config; historical configs retain their original schema. */
export const currentBenchmarkProtocolSchema = z.object({
  schemaVersion: z.literal(1),
  runId: pin,
  taskIds: taskRoster,
  seeds,
  arms: z.array(z.object({
    id: pin,
    agent: z.enum(['codex', 'claude']),
    model: pin,
    effort: pin,
    account: pin,
    generationBudget: generationCap,
    runtime: z.object({ sourceRevision: pin, runtimeRevision: pin, clientVersion: pin, promptHash: digest, toolsHash: digest }).strict(),
  }).strict()).min(2),
  aggregateBudgetUsd: z.number().finite().positive(),
  maxInFlightUsd: z.number().finite().positive(),
  priceSchedule: z.object({ version: pin, rates: z.array(z.object({
    model: pin, inputUsdPerMillion: z.number().finite().nonnegative(),
    cachedInputUsdPerMillion: z.number().finite().nonnegative(), outputUsdPerMillion: z.number().finite().nonnegative(),
  }).strict()).min(1) }).strict(),
  grader: z.object({ family: pin, version: pin, imageDigest: pin }).strict(),
  context: z.object({
    corpusHash: digest, memoryHash: digest, corpusRef: pin, memoryRef: pin,
    isolation: z.literal('fresh-per-assignment'), forbiddenSources: z.array(pin).min(1),
  }).strict(),
  exclusions: z.array(pin),
  stopping: z.object({
    maxAttemptsPerAssignment: z.number().int().positive(),
    budgetAction: z.literal('record-cap-outcome'), graderOutage: z.literal('repair-or-inconclusive'),
    superiorityClaim: z.literal('withheld-confirmation-only'),
  }).strict(),
  confirmation: z.object({
    taskIds: taskRoster, seeds,
    plannedPairedTasks: z.number().int().positive(),
    minimumEffect: z.number().finite().gt(0).lte(1), alpha: z.number().finite().gt(0).lt(1),
    power: z.number().finite().gt(0).lt(1), method: pin,
  }).strict(),
}).strict().superRefine((protocol, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (!distinct(protocol.arms.map(arm => arm.id))) issue(['arms'], 'Arm ids must be unique.');
  const cap = canonicalJson(protocol.arms[0].generationBudget);
  if (protocol.arms.some(arm => canonicalJson(arm.generationBudget) !== cap)) issue(['arms'], 'Matched arms require equal generation caps.');
  if (protocol.maxInFlightUsd > protocol.aggregateBudgetUsd) issue(['maxInFlightUsd'], 'In-flight exposure cannot exceed the aggregate cap.');
  const modelRates = protocol.priceSchedule.rates.map(rate => rate.model);
  if (!distinct(modelRates) || protocol.arms.some(arm => !modelRates.includes(arm.model))) issue(['priceSchedule'], 'Every arm model needs one frozen price rate.');
  if (protocol.confirmation.taskIds.some(id => protocol.taskIds.includes(id))) issue(['confirmation', 'taskIds'], 'Confirmation tasks must be withheld from the pilot.');
  if (protocol.confirmation.plannedPairedTasks > protocol.confirmation.taskIds.length) issue(['confirmation', 'plannedPairedTasks'], 'The confirmation roster must reserve the planned paired tasks.');
});
export type CurrentBenchmarkProtocol = z.infer<typeof currentBenchmarkProtocolSchema>;

/** Refuse drift between the frozen protocol and the request that will actually launch. */
export function requireCurrentBenchmarkAssignment(config: unknown, execution: {
  runId: string; armId: string; seed: number; taskId: string;
  agent: string; model: string; effort: string; account: string;
  budget: { maxUsd?: number; maxTokens?: number; maxWallClockMs?: number };
}): CurrentBenchmarkProtocol {
  const parsed = currentBenchmarkProtocolSchema.safeParse(config);
  if (!parsed.success) throw new Error(`Current benchmark requires a complete frozen protocol: ${parsed.error.message}`);
  const protocol = parsed.data;
  const arm = protocol.arms.find(candidate => candidate.id === execution.armId);
  if (protocol.runId !== execution.runId || !arm || !protocol.taskIds.includes(execution.taskId) || !protocol.seeds.includes(execution.seed)) {
    throw new Error('Current benchmark assignment is not in the frozen protocol.');
  }
  if (arm.agent !== execution.agent || arm.model !== execution.model || arm.effort !== execution.effort || arm.account !== execution.account ||
      canonicalJson(arm.generationBudget) !== canonicalJson(execution.budget)) {
    throw new Error('Current benchmark launch controls or budget drift from the frozen protocol.');
  }
  return protocol;
}

/** The Rollout Card — the published unit of reproducibility (1:1 with a run_result). */
export interface RolloutRecord {
  rolloutId: string;
  runId: string;
  preregHash: string;
  suite: BenchSuite;
  taskId: string;
  arm: ArmId;
  seed: number;
  /** The resolved per-run config incl. arm settings + model params. */
  configSnapshot?: Record<string, unknown> | null;
  modelId: string;
  /** Exact provider model version string if distinct from modelId. */
  modelVersion?: string | null;
  harnessVersion: string;
  /** Exact tree sha the harness ran from. */
  harnessGitSha?: string | null;
  /** os / node / docker image digests / grader image digest. */
  envFingerprint?: Record<string, unknown> | null;
  graderFamily: string;
  graderVersion: string;
  /** Structured grader report: { failToPass, passToPass, report }. */
  graderOutput?: unknown;
  /** The benchmark's own output, VERBATIM. */
  rawGraderOutput?: string | null;
  /** The exact submission graded — M1: the unified diff; M2: the env handle ref. */
  submission?: string | null;
  trajectoryRef?: string | null;
  trajectoryKind?: string | null;
  createdAt: string;
}

/** The pre-registered run config (committed to git before the run). */
export interface PreregRecord {
  preregHash: string;
  runId: string;
  label?: string | null;
  suites: BenchSuite[];
  config: Record<string, unknown>;
  /** Repo-relative path the committed file lands at (benchmarks/preregistrations/<runId>.json). */
  filePath: string;
  gitCommitted: boolean;
  gitCommitSha?: string | null;
  createdAt: string;
}

/**
 * What an arm runner hands to emitRollout(). The `generation` half is arm-specific
 * (tokens SUMMED across every agent/role/candidate+verifier — coordination
 * overhead counted in OUR number); the `grading` half comes verbatim from the
 * arm-agnostic OfficialGrader. cost_usd + price_table_version are DERIVED at emit
 * (P-011 priceRun) — never passed in, so one published price table applies to
 * every arm identically.
 */
export interface EmitRolloutInput {
  runId: string;
  /** Must match an existing benchmark_prereg row (tune-to-test firewall). */
  preregHash: string;
  suite: BenchSuite;
  taskId: string;
  arm: ArmId;
  /** Independent-attempt ordinal — ≥3 distinct per (task × arm). */
  seed: number;
  modality: GraderModality;
  /** The L2 fleet run that placed this task (Phase 5 / D-010); null for standalone L1 arms. */
  fleetRunId?: string | null;
  generation: {
    status: GenerationStatus;
    error?: string | null;
    tokensIn: number;
    tokensOut: number;
    /** SUMMED across every agent/role (Papercusp) or every candidate+verifier (best-of-N). */
    tokensTotal: number;
    tokensCacheRead?: number | null;
    tokensCacheWrite?: number | null;
    wallClockMs: number;
    turns?: number;
    /** GENERATION iso-budget cap this run ran under (null = uncapped / native). */
    budgetTokens?: number | null;
    /** Did generation hit/terminate at the cap? (a capped run ≠ a genuine fail). */
    capped?: boolean;
    modelId: string;
    harnessVersion: string;
    /** Arm-specific detail; opaque to scoring, published for repro (best-of-N candidates, …). */
    armMeta?: Record<string, unknown> | null;
    /** The graded submission content (diff/env-ref) — stored in the rollout card. */
    submission?: string | null;
    trajectoryRef?: string | null;
    trajectoryKind?: string | null;
  };
  grading: {
    /** NULL when never genuinely graded (generation/grader infra) — excluded from accuracy. */
    resolved: boolean | null;
    status: GraderStatus;
    family: string;
    version: string;
    error?: string | null;
    failToPass?: TestOutcome[] | null;
    passToPass?: TestOutcome[] | null;
    /** Full grader report → rollout.grader_output. */
    structuredOutput?: unknown;
    /** Verbatim grader output → rollout.raw_grader_output. */
    rawOutput?: string | null;
    /**
     * Continuous partial-credit score in [0,1] for rubric/checkpoint/coordination suites
     * (TheAgentCompany, PaperBench, AgentsNet) → run_result.score. NULL for boolean-resolved
     * suites (SWE-bench family) where `resolved` is the score.
     */
    score?: number | null;
  };
  provenance?: {
    configSnapshot?: Record<string, unknown> | null;
    modelVersion?: string | null;
    harnessGitSha?: string | null;
    envFingerprint?: Record<string, unknown> | null;
  };
}
