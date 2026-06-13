/**
 * `hive-eval/` — the Hive-run-evaluation battery (hive-run-evaluation-2026-06-13, HE-03).
 *
 * A sibling slice of the apiary IQ-battery (D-006/D-009): seeded scenarios with an objective
 * optimum (P-020), the run harness that drives a whole throwaway Hive on a scenario to
 * completion/timeout (P-021), and the determinism + repeat-distribution controls (P-022).
 * JUDGE-FREE — it records raw runs + distributions; HE-04/05 compute metrics over the
 * recorded observations and HE-06 layers the judge/composite/un-gameable gate.
 */
export {
  type HiveScenario,
  type ScenarioShape,
  type ScenarioWorkItem,
  type ScenarioSandbox,
  type AcceptanceTest,
  type ParallelismStructure,
  type ScenarioProblem,
  computeParallelismStructure,
  validateScenario,
} from './scenario';

export { HIVE_EVAL_SCENARIOS, SEED_APP_DIR, getScenario } from './scenarios';

export { hiveEvalRunIdentity, type HiveEvalRunKey, type HiveEvalRunIdentity } from './run-identity';

export {
  runHiveScenarioOnce,
  hiveScenarioSubject,
  makeFakeHivePorts,
  HIVE_RUN_DEFAULT_OPTS,
  type HiveRunPorts,
  type HiveRunOpts,
  type HiveScenarioCell,
  type HiveBootResult,
  type DriveResult,
  type HiveRunHandle,
  type HiveRunSignals,
  type HiveScenarioRunRecord,
  type FakeHiveBehavior,
  type FakeHivePorts,
} from './run-harness';

export {
  runHiveScenarioBattery,
  type HiveScenarioBatteryConfig,
  type HiveScenarioBatteryDeps,
  type HiveScenarioBatteryResult,
  type HiveScenarioRunOutcome,
  type HiveScenarioDistribution,
  type HiveRunOutcomeStatus,
} from './battery';

export {
  createInMemoryHiveEvalStore,
  type HiveEvalStore,
  type InMemoryHiveEvalStore,
  type HiveEvalScenarioRow,
  type HiveEvalRunRow,
  type HiveEvalRunFinish,
  type HiveRunObservations,
  type HiveRunTerminalState,
  type InstanceManifest,
} from './store';

export { createPgHiveEvalStore } from './store-pg';

export {
  computeOutcomeMetrics,
  detectFabrication,
  liveAcceptancePorts,
  type OutcomeMetrics,
  type OutcomeMetricsDeps,
  type AcceptancePorts,
  type RunGroundTruth,
  type WorkItemTruth,
  type FabricationResult,
  type TestResult,
} from './outcome-metrics';

export {
  buildGroundTruth,
  collectGroundTruth,
  commitBacksWorkItem,
  deriveActuals,
  gitLogCommits,
  liveGroundTruthPorts,
  type GroundTruthRaw,
  type GroundTruthCtx,
  type GroundTruthPorts,
  type LiveGroundTruthDeps,
  type WorkItemClaim,
  type WorkItemActual,
  type ObservedCommit,
} from './ground-truth';

export { computeSpeedMetrics, type SpeedMetrics, type RunTimings } from './speed-metrics';

export {
  computeEfficiencyMetrics,
  type EfficiencyMetrics,
  type RunBehavior,
  type MetricPairing,
} from './efficiency-metrics';

export {
  computeHiveScore,
  hiveScoreRubricHash,
  hiveScoreToRow,
  DEFAULT_HIVE_SCORE_RUBRIC_V1,
  type HiveScore,
  type HiveScoreRubric,
  type HiveAxisScore,
  type ScoreComponent,
  type DeterministicFloor,
  type AxisWeights,
  type EfficiencyWeights,
  type SpeedWeights,
  type HiveScoreThresholds,
} from './scoring';

export { type HiveEvalScoreRow } from './store';

// HE-07 — the scored generation runner (battery → HE-06 score → persist), the cadence's invocation
// target + the full-battery integration subject (P-050/P-061).
export {
  runHiveEvalGeneration,
  type HiveEvalGenerationDeps,
  type HiveEvalGenerationResult,
  type HiveEvalScoreExtractor,
  type HiveRunScoreInputs,
  type ScoredRun,
  type ScoredScenarioDistribution,
} from './generation-runner';

// HE-07 — the cadence orchestration (P-050; the `hive-eval:gen` blueprint op wraps this).
export { runHiveEvalGen, type HiveEvalGenDeps } from './gen-loop';
export {
  runHiveEvalCadenceTick,
  ownerBudgetUsd,
  type HiveEvalCadenceOutcome,
  type HiveEvalRunRequest,
  type HiveEvalRunFn,
} from './cadence-tick';

// HE-07 — the Benchmark-tab "Hive orchestration" trend read (P-050).
export { readHiveEvalInstanceSummaries, type HiveEvalGenerationSummary } from './trend-read';
