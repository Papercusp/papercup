/**
 * Modality-1 (offline diff-batch) {@link OfficialGrader} backend for SWE-bench Pro (feasibility doc §2).
 * GENERATION is arm-specific; GRADING is this arm-agnostic Docker batch — the fairness invariant.
 *
 * Pipeline: collect {@link ArmSubmission} diffs → write the predictions JSON `[{instance_id, patch, prefix}]`
 * → run the official `swe_bench_pro_eval.py` (it pulls `jefzda/sweap-images:{dockerhub_tag}` per instance,
 * applies the patch, runs the repo tests via `run_scripts/`) → parse its report → {@link GradeResult}.
 * `resolved` = all FAIL_TO_PASS pass AND all PASS_TO_PASS still pass (inherited SWE-bench rule).
 *
 * Subprocess + fs are INJECTED so this is unit-testable with a fake eval (no Docker / no GB image pulls).
 * ⚠ The exact report layout written by `swe_bench_pro_eval.py` is parsed defensively in
 * {@link parseSweBenchProReport}; confirm the keys against a first real run (BRIEF 1 / P-001's images).
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader, TestOutcome } from '../types';

/** Run a subprocess; resolve with its captured streams + exit code (never reject on a non-zero exit). */
export type ProcExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Minimal fs the grader needs (injected for tests). */
export interface GraderFs {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  rm(path: string): Promise<void>;
}

export interface SweBenchProGraderConfig {
  /** Dir holding `swe_bench_pro_eval.py` + `run_scripts/` (the `scaleapi/SWE-bench_Pro-os` checkout). */
  evalRepoDir: string;
  /** The raw sample CSV the eval reads (`swe_bench_pro_full.csv`). */
  rawSamplePath: string;
  /** Docker Hub user that hosts the per-instance images (`jefzda`). */
  dockerhubUsername?: string;
  /** Grader concurrency (`--num_workers`). Tune to the grading host. */
  numWorkers?: number;
  /** Python interpreter (default `python3`). */
  pythonBin?: string;
  /** Scratch root for predictions JSON + output_dir (default OS temp). */
  workRoot?: string;
  /**
   * The exact grader version to PIN on every row (pre-registration, P-010): the image-set tag / eval-repo
   * commit. Required so a result is reproducible. e.g. "sweap-images@2026-05 / SWE-bench_Pro-os@<sha>".
   */
  version: string;
}

export interface SweBenchProGraderDeps {
  exec: ProcExec;
  fs: GraderFs;
}

const GRADER_FAMILY = 'swe-bench-pro';

interface PredictionRecord {
  instance_id: string;
  patch: string;
  prefix: string;
}

/** A per-instance result as we expect it from the eval report (defensive — keys confirmed on first run). */
interface RawInstanceResult {
  resolved?: boolean;
  fail_to_pass?: Record<string, boolean> | string[];
  pass_to_pass?: Record<string, boolean> | string[];
  error?: string;
  [k: string]: unknown;
}

function toOutcomes(v: Record<string, boolean> | string[] | undefined, defaultPass: boolean): TestOutcome[] | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return v.map((test) => ({ test, passed: defaultPass }));
  return Object.entries(v).map(([test, passed]) => ({ test, passed }));
}

/**
 * Map the eval report (keyed by instance_id, or by `${instance_id}__${prefix}` for multi-seed) onto the
 * submissions. A submission with no matching report entry → `graderError` (it ran but produced no verdict —
 * an infra failure, NOT a silent fail).
 */
export function parseSweBenchProReport(
  report: Record<string, RawInstanceResult> | { resolved?: string[]; [k: string]: unknown },
  submissions: ArmSubmission[],
  version: string,
): GradeResult[] {
  // Support a top-level resolved-list form (`{resolved:[ids], ...}`) as a fallback.
  const resolvedList: Set<string> | null = Array.isArray((report as { resolved?: unknown }).resolved)
    ? new Set((report as { resolved: string[] }).resolved)
    : null;

  return submissions.map((sub): GradeResult => {
    const keyed = `${sub.instanceId}__${sub.prefix}`;
    const entry = ((report as Record<string, RawInstanceResult>)[keyed] ??
      (report as Record<string, RawInstanceResult>)[sub.instanceId]) as RawInstanceResult | undefined;

    if (entry && typeof entry === 'object' && entry.error) {
      return {
        instanceId: sub.instanceId,
        prefix: sub.prefix,
        resolved: false,
        rawGraderOutput: entry,
        graderFamily: GRADER_FAMILY,
        graderVersion: version,
        graderError: String(entry.error),
      };
    }

    if (!entry && resolvedList === null) {
      return {
        instanceId: sub.instanceId,
        prefix: sub.prefix,
        resolved: false,
        rawGraderOutput: { missing: true },
        graderFamily: GRADER_FAMILY,
        graderVersion: version,
        graderError: 'no grader report entry for instance (image pull / eval failure?)',
      };
    }

    const failToPass = toOutcomes(entry?.fail_to_pass, false);
    const passToPass = toOutcomes(entry?.pass_to_pass, true);
    const resolved =
      typeof entry?.resolved === 'boolean'
        ? entry.resolved
        : resolvedList !== null
          ? resolvedList.has(sub.instanceId)
          : false;

    return {
      instanceId: sub.instanceId,
      prefix: sub.prefix,
      resolved,
      failToPass,
      passToPass,
      rawGraderOutput: entry ?? { resolved },
      graderFamily: GRADER_FAMILY,
      graderVersion: version,
    };
  });
}

export function makeSweBenchProGrader(cfg: SweBenchProGraderConfig, deps: SweBenchProGraderDeps): OfficialGrader {
  const { exec, fs } = deps;
  const pythonBin = cfg.pythonBin ?? 'python3';
  const dockerhubUsername = cfg.dockerhubUsername ?? 'jefzda';
  const numWorkers = cfg.numWorkers ?? 16;
  const workRoot = cfg.workRoot ?? '/tmp';

  return {
    family: GRADER_FAMILY,
    modality: 'diff',
    async grade(submissions: ArmSubmission[], _tasks: BenchTask[]): Promise<GradeResult[]> {
      const diffSubs = submissions.filter((s): s is Extract<ArmSubmission, { modality: 'diff' }> => s.modality === 'diff');
      if (diffSubs.length === 0) return [];

      const scratch = await fs.mkdtemp(`${workRoot}/swebp-grade-`);
      const predsPath = `${scratch}/predictions.json`;
      const outDir = `${scratch}/out`;
      try {
        const predictions: PredictionRecord[] = diffSubs.map((s) => ({
          instance_id: s.instanceId,
          patch: s.patch,
          prefix: s.prefix,
        }));
        await fs.writeFile(predsPath, JSON.stringify(predictions));

        // Drive grading ONLY through swe_bench_pro_eval.py — never `docker exec bash` (the §2 image note).
        const { code, stderr } = await exec(
          pythonBin,
          [
            'swe_bench_pro_eval.py',
            `--raw_sample_path=${cfg.rawSamplePath}`,
            `--patch_path=${predsPath}`,
            `--output_dir=${outDir}`,
            '--scripts_dir=run_scripts',
            `--num_workers=${numWorkers}`,
            `--dockerhub_username=${dockerhubUsername}`,
          ],
          { cwd: cfg.evalRepoDir },
        );

        let report: Record<string, RawInstanceResult> = {};
        let readErr: string | undefined;
        try {
          report = JSON.parse(await fs.readFile(`${outDir}/report.json`)) as Record<string, RawInstanceResult>;
        } catch (e) {
          readErr = `could not read grader report.json: ${e instanceof Error ? e.message : String(e)}`;
        }

        if (readErr) {
          // The whole batch failed to produce a report — every instance is an infra failure (not "unresolved").
          const detail = code !== 0 ? `${readErr} (eval exit ${code}: ${stderr.slice(0, 500)})` : readErr;
          return diffSubs.map((s) => ({
            instanceId: s.instanceId,
            prefix: s.prefix,
            resolved: false,
            rawGraderOutput: { batchError: detail },
            graderFamily: GRADER_FAMILY,
            graderVersion: cfg.version,
            graderError: detail,
          }));
        }

        return parseSweBenchProReport(report, diffSubs, cfg.version);
      } finally {
        await fs.rm(scratch).catch(() => {});
      }
    },
  };
}
