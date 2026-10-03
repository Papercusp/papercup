/**
 * The hermetic gym runner (P-001): orchestrates ONE `(task × variant × cycle)`
 * run on the dedicated gym-operator instance (D-018).
 *
 *   clone substrate@commit → register throwaway harness → apply variant overlay
 *   → file the synthetic feature → start the pipeline → poll to terminal.
 *
 * All effects are injected via {@link GymRunnerPorts}, so this sequencing +
 * teardown-on-setup-failure logic is unit-tested with fakes (no live operator,
 * no real agents). The runner deliberately does NOT tear down on success: the
 * trace collector (P-002) reads the clone (for the diff) and the harness schema
 * (for the transcript) AFTER the run, then calls teardown.
 */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gymRunIdentity, type GymRunIdentity, type GymRunKey } from './run-identity';
import { planVariantOverlay, type VariantOverlay } from './variant-overlay';
import { classifyGymRun, type GymRunOutcome } from './pipeline-status';
import { regressionsFromTests, testResultKey, type TestResult } from './signals';

/** Actual assertion results plus oracle bytes measured around the test process. */
export interface GymOracleRun {
  results: TestResult[];
  testPath: string;
  pinCommit: string;
  sourceHashes: { pinned: string | null; before: string | null; after: string | null };
  /** Principal implementation bytes measured around this test process. This
   * does not identify imported code, the runner, or the remote pipeline. */
  implementation?: { path: string; before: string | null; after: string | null } | null;
  execution?: { command: string[]; cwd: string; report: string; unresolved: string[] };
}

export interface GymOracleSpec {
  /** Repo-relative path of the real test file that judges the task. */
  testPath: string;
  /** Repo-relative implementation file the task restores. */
  implPath: string;
  /** Commit at which the oracle and reference implementation are pinned. */
  pinCommit: string;
  /** Auditable work-item/commit provenance for the real task. */
  sourceRef: string;
}

export interface GymTaskSpec {
  id: string;
  /** Substrate repo: local path or remote URL. */
  source: string;
  /** Pinned substrate commit SHA (D-009). */
  commit: string;
  /** The (deliberately mildly-underspecified) feature spec. */
  spec: string;
  /** The high-level intent the work should achieve. */
  intent: string;
  /** Real-corpus oracle metadata, when this task is test-anchored. */
  oracle?: GymOracleSpec;
}

export interface GymVariantSpec {
  id: string;
  overlay: VariantOverlay;
}

export interface GymRunSpec {
  task: GymTaskSpec;
  variant: GymVariantSpec;
  /** Optimization cycle (0 for the spine's manual A/B). */
  cycle: number;
  /** Repeat index within a (task × variant × cycle) — the P-014 variance sample; each repeat gets its own harness. */
  repeat?: number;
  /** The pinned harness-under-test commit (D-016) — recorded with the run. */
  harnessCommit: string;
  workspaceId: string;
  /** Scratch dir root the substrate clone lands under. */
  scratchRoot: string;
  /** Hard wall-clock cap for the pipeline. */
  timeoutMs: number;
  /** Delay between status polls. */
  pollIntervalMs: number;
}

/** The effectful operations the runner needs — bound to real operator functions in the wiring layer. */
export interface GymRunnerPorts {
  cloneSubstrate(i: { source: string; commit: string; destDir: string }): Promise<void>;
  registerThrowawayHarness(i: { slug: string; clonePath: string; workspaceId: string }): Promise<void>;
  applyPromptOverride(i: { workspaceId: string; slug: string; role: string; promptMd: string }): Promise<void>;
  fileFeature(i: { slug: string; featureId: string; spec: string; intent: string }): Promise<void>;
  startPipeline(i: { slug: string; featureId: string; workspaceId: string }): Promise<{ workflowID: string }>;
  pollStatus(i: { workflowID: string; slug: string; featureId: string }): Promise<{
    workflowStatus: string;
    featureStatus: string | null;
  }>;
  /** Run the task's immutable oracle inside the clone and return per-test results. */
  runOracle?(i: { clonePath: string; testPath: string; pinCommit?: string; implPath?: string }): Promise<TestResult[] | GymOracleRun | undefined>;
  teardownHarness(i: { slug: string; clonePath: string; workspaceId: string }): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface GymRunResult {
  runKey: GymRunKey;
  identity: GymRunIdentity;
  harnessSlug: string;
  featureId: string;
  clonePath: string;
  workflowID: string;
  outcome: GymRunOutcome;
  terminal: boolean;
  elapsedMs: number;
  /** Deterministic signals measured by the runner; absent means not measured. */
  deterministicSignals?: Record<string, unknown>;
}

export async function runGymPipeline(spec: GymRunSpec, ports: GymRunnerPorts): Promise<GymRunResult> {
  // The caller may mutate its spec while effects are awaited. Identity, filed
  // work and both oracle measurements must describe the same original task.
  spec = structuredClone(spec);
  const executionInput = {
    task: structuredClone(spec.task),
    variant: structuredClone(spec.variant),
    // Requested harness pin, not proof of the runtime code actually loaded.
    harnessCommit: spec.harnessCommit,
    taskHash: createHash('sha256').update(JSON.stringify(spec.task)).digest('hex'),
    variantHash: createHash('sha256').update(JSON.stringify(spec.variant)).digest('hex'),
  };
  const runKey: GymRunKey = { taskId: spec.task.id, variantId: spec.variant.id, cycle: spec.cycle, repeat: spec.repeat };
  const identity = gymRunIdentity(runKey);
  const clonePath = join(spec.scratchRoot, identity.cloneDirName);
  const overlayPlan = planVariantOverlay(spec.variant.overlay);

  // --- setup phase: any failure → best-effort teardown of what we created, then rethrow ---
  let workflowID: string;
  let preOracle: GymOracleRun | undefined;
  const measureOracle = async (): Promise<GymOracleRun | undefined> => {
    if (!spec.task.oracle || !ports.runOracle) return undefined;
    try {
      const results = await ports.runOracle({
        clonePath,
        testPath: spec.task.oracle.testPath,
        pinCommit: spec.task.oracle.pinCommit,
        implPath: spec.task.oracle.implPath,
      });
      if (!results) return undefined;
      // Legacy/custom array ports have no immutable-source receipt. Retain their
      // results for diagnosis, but they cannot authorize a no-regression claim.
      return structuredClone(Array.isArray(results) ? {
        results, testPath: spec.task.oracle.testPath, pinCommit: spec.task.oracle.pinCommit,
        sourceHashes: { pinned: null, before: null, after: null },
      } : results);
    } catch {
      // Oracle collection is evidence, not a reason to hide the pipeline outcome.
      return undefined;
    }
  };
  try {
    await ports.cloneSubstrate({ source: spec.task.source, commit: spec.task.commit, destDir: clonePath });
    // The task commit starts with the implementation rewound. Measure the oracle
    // BEFORE the agent pipeline changes the clone so regressionsFromTests compares
    // the same immutable test set pre/post.
    preOracle = await measureOracle();
    await ports.registerThrowawayHarness({ slug: identity.harnessSlug, clonePath, workspaceId: spec.workspaceId });
    for (const op of overlayPlan.promptOverrideOps) {
      await ports.applyPromptOverride({
        workspaceId: spec.workspaceId,
        slug: identity.harnessSlug,
        role: op.role,
        promptMd: op.promptMd,
      });
    }
    await ports.fileFeature({
      slug: identity.harnessSlug,
      featureId: identity.featureId,
      spec: spec.task.spec,
      intent: spec.task.intent,
    });
    const started = await ports.startPipeline({
      slug: identity.harnessSlug,
      featureId: identity.featureId,
      workspaceId: spec.workspaceId,
    });
    workflowID = started.workflowID;
  } catch (err) {
    try {
      await ports.teardownHarness({ slug: identity.harnessSlug, clonePath, workspaceId: spec.workspaceId });
    } catch {
      // best-effort cleanup; surface the original setup error
    }
    throw err;
  }

  // --- poll phase: the pipeline owns the feature now; keep artifacts and return
  //     the outcome (including errored/timeout) so the collector can capture the trace ---
  const start = ports.now();
  for (;;) {
    const snap = await ports.pollStatus({ workflowID, slug: identity.harnessSlug, featureId: identity.featureId });
    const elapsedMs = ports.now() - start;
    const cls = classifyGymRun({
      workflowStatus: snap.workflowStatus,
      featureStatus: snap.featureStatus,
      elapsedMs,
      timeoutMs: spec.timeoutMs,
    });
    if (cls.terminal) {
      const postOracle = await measureOracle();
      let deterministicSignals: Record<string, unknown> = { executionInput };
      if (spec.task.oracle) {
        const pre = preOracle?.results ?? [];
        const post = postOracle?.results ?? [];
        const beforeKeys = pre.map(testResultKey);
        const afterKeys = post.map(testResultKey);
        const populationComplete = beforeKeys.length > 0 && beforeKeys.length === afterKeys.length &&
          new Set(beforeKeys).size === beforeKeys.length && new Set(afterKeys).size === afterKeys.length &&
          beforeKeys.every((key) => afterKeys.includes(key)) &&
          [...pre, ...post].every((t) => t.name.trim().length > 0 && t.executed !== false);
        const pinned = preOracle?.sourceHashes.pinned;
        const sourceCurrent = typeof pinned === 'string' && /^[a-f0-9]{64}$/.test(pinned) &&
          [preOracle, postOracle].every((receipt) => receipt &&
            receipt.testPath === spec.task.oracle!.testPath && receipt.pinCommit === spec.task.oracle!.pinCommit &&
            Object.values(receipt.sourceHashes).every((value) => value === pinned));
        // The task may legitimately change the implementation between runs.
        // Each individual oracle must evaluate one stable principal artifact.
        const implementationCurrent = [preOracle, postOracle].every((receipt) => {
          const impl = receipt?.implementation;
          return impl?.path === spec.task.oracle!.implPath && typeof impl.before === 'string' &&
            /^[a-f0-9]{64}$/.test(impl.before) && impl.before === impl.after;
        });
        const regression = sourceCurrent && implementationCurrent ? regressionsFromTests(pre, post) : undefined;
        const regressionPopulation = pre.filter((t) => t.executed !== false && t.passed).length;
        deterministicSignals = {
          executionInput,
          // Collector/store preserve this receipt in the existing trace/signals.
          oracle: { sourceRef: spec.task.oracle.sourceRef, testPath: spec.task.oracle.testPath,
            pinCommit: spec.task.oracle.pinCommit, pre: preOracle ?? null, post: postOracle ?? null,
            sourceCurrent, implementationCurrent, populationComplete, regressionPopulation },
          ...(regression === true || (regression === false && populationComplete && regressionPopulation > 0)
            ? { regressions: regression } : {}),
          ...(sourceCurrent && implementationCurrent && populationComplete ? { taskPassed: post.every((t) => t.passed) } : {}),
        };
      }
      return {
        runKey,
        identity,
        harnessSlug: identity.harnessSlug,
        featureId: identity.featureId,
        clonePath,
        workflowID,
        outcome: cls.outcome,
        terminal: true,
        elapsedMs,
        deterministicSignals,
      };
    }
    await ports.sleep(spec.pollIntervalMs);
  }
}
