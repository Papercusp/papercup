/**
 * live-ports.ts — the LIVE `HiveRunPorts` assembly (HE-07 follow-on, P-063 / D-011): boot a real
 * throwaway Hive over a seeded scenario, drive it to completion, collect the run, tear it down.
 * This is the owner-gated leaf (P-051): wiring it makes the benchmark RUNNABLE, but the cadence
 * still spends nothing until the owner sets a budget + activates.
 *
 * Topology (owner decision 2026-06-13): the substrate is a MEMBER harness. `bootHive` mints the
 * Queen seat (`createHiveHarness`, repo-less hive home) AND registers the hermetic seed-app clone
 * as a MEMBER harness (`hive_slug` → the home) that `surveyHive` scans; the scenario's work-item
 * DAG seeds into the member. This mirrors the real Hive topology (Queen + member projects).
 *
 * The seam that keeps this honest: the live IO (git, PG, hive boot/survey, LLM-spending drive) is
 * injected via {@link LiveHivePortsDeps}, so this module's PURE core — the seed-app→pinned-SHA
 * materialization plan, the scenario→seed-DAG plan, and the drained predicate — is unit-tested
 * with no git/PG/LLM, and the full whole-Hive run is exercised only by an owner-armed run (NOT CI).
 *
 * The score EXTRACTOR's ground-truth leg is su-b459e's `ground-truth-live.ts` (P-062) — composed
 * here, not duplicated (the agreed file split).
 */
import { buildSubstrateCloneCommands, type GitCommand } from '../gym/clone';
import type { HiveScenario } from './scenario';
import type { HiveSurvey } from '../hive/survey';

// ───────────────────────── seed-app → a pinned-SHA git repo (pure) ─────────────────────────
//
// The seed-app fixture (SEED_APP_DIR) is a plain directory: the scenario sandbox carries
// `commit: 'seed'`, a placeholder — but `gym/clone` REQUIRES a hex SHA (a hermetic clone pins an
// immutable commit so the trace collector can `git diff <pin> HEAD`). So before cloning, bootHive
// materializes a one-commit git repo from a COPY of the fixture (never mutating the fixture itself)
// and clones from THAT at the resulting SHA. These are the materialization commands; the caller
// runs them then `git rev-parse HEAD` to read the pin (the SHA isn't known until the commit lands).

/** A fixed identity so `git commit` never fails on missing user config (the SHA itself is opaque —
 *  run identity comes from instance×scenario×repeat×seed, not the substrate commit). */
const SEED_GIT_IDENTITY = ['-c', 'user.name=hive-eval', '-c', 'user.email=hive-eval@papercusp.local'];

/** The git commands that turn a COPY of the seed-app fixture into a one-commit repo (the clone
 *  source). The caller execs these in order, then `git -C <baseDir> rev-parse HEAD` for the pin. */
export function seedRepoMaterializeCommands(baseDir: string): GitCommand[] {
  return [
    { argv: ['git', 'init', '--quiet', baseDir] },
    { argv: ['git', '-C', baseDir, 'add', '-A'] },
    { argv: ['git', '-C', baseDir, ...SEED_GIT_IDENTITY, 'commit', '--quiet', '-m', 'hive-eval seed-app base'] },
  ];
}

/** The hermetic clone of the materialized base @ the pinned SHA into the run's scratch dir. */
export function seedRepoCloneCommands(input: { baseDir: string; commit: string; destDir: string }): GitCommand[] {
  return buildSubstrateCloneCommands({ source: input.baseDir, commit: input.commit, destDir: input.destDir }).commands;
}

// ───────────────────────── scenario → the seed-DAG plan (pure) ─────────────────────────
//
// Each scenario work-item becomes a `todo` feature-family work-item in the member harness; its
// `dependsOn` becomes a feature→feature `blocks` edge so `surveyHive`'s readiness filter holds a
// lane back until its prerequisites complete (the same readiness the orchestrator dispatches by).
// The planted defect is already in the cloned repo, so seeding is pure metadata.

export interface SeedFeature {
  /** The member-harness feature id — the scenario work-item id (unique within the member). */
  featureId: string;
  title: string;
  /** What the bee must do (the work-item spec/summary). */
  spec: string;
}

/** A `blocks` edge: `blockedBy` (a prerequisite) must complete before `feature` is ready. */
export interface SeedEdge {
  feature: string;
  blockedBy: string;
}

export interface ScenarioSeedPlan {
  features: SeedFeature[];
  edges: SeedEdge[];
}

/** Turn a scenario's work-item DAG into the member-harness seed plan (features + block edges). */
export function scenarioSeedPlan(scenario: HiveScenario): ScenarioSeedPlan {
  const features: SeedFeature[] = scenario.workItems.map((w) => ({ featureId: w.id, title: w.title, spec: w.spec }));
  const edges: SeedEdge[] = [];
  for (const w of scenario.workItems) {
    for (const dep of w.dependsOn) edges.push({ feature: w.id, blockedBy: dep });
  }
  return { features, edges };
}

// ───────────────────────── completion: the drained predicate (pure) ─────────────────────────
//
// The whole-Hive run is DRAINED when the Queen has nothing left to do: the survey's frontier is
// empty (no unplaced ready work), no started plan remains, and no placement is in flight (a bee
// still working). `driveToCompletion` polls `surveyHive` + the in-flight-placement count and tests
// this each tick until true or the timeout — `drained` vs `timeout` is the terminal disposition.

/** True when the Hive has drained the scenario: nothing ready, nothing started, nothing in flight. */
export function isHiveDrained(
  survey: Pick<HiveSurvey, 'plans' | 'frontier'>,
  inFlightPlacements: number,
): boolean {
  return survey.frontier.length === 0 && survey.plans.length === 0 && inFlightPlacements <= 0;
}

// ───────────────────────── the injectable live IO seam ─────────────────────────
//
// The IO `makeLiveHivePorts` wires the PURE helpers above over these injected operations. Real
// defaults bind git/fs (clone), `createHiveHarness` + the member-register + schema scaffold (boot),
// the HFC insert + block-edge sync (seed), `hive:start` + `surveyHive` + the placement-in-flight
// query (drive), the spawn/work-item/cost reads (collect), and the schema-drop + clone-rm
// (teardown). Injected so the orchestration is unit-testable; bound for the owner-armed live run.
// (makeLiveHivePorts lands next — Phase 1 IO assembly + Phase 2 drive/collect — over this seam.)

export interface LiveHivePortsDeps {
  /** Run a git/shell command (execFile, no shell). Returns stdout (for `rev-parse`). */
  exec(cmd: string, args: string[]): Promise<{ stdout: string }>;
  /** Recursively copy the seed-app fixture into a writable base dir (never mutate the fixture). */
  copyDir(src: string, dest: string): Promise<void>;
  /** Remove a path (the clone / base dir) on teardown. */
  rm(path: string): Promise<void>;
}
