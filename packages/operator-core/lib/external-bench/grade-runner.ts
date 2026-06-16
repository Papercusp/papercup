/**
 * Grade trigger (benchmark-evaluation-ui-2026-06-16 P-010, D-024).
 *
 * Runs the OFFICIAL swe_bench_pro_eval over a run's collected diffs — the proven
 * _xbench_grade.py path (--use_local_docker, jefzda images) — and persists the
 * per-instance resolved map + resolvedCount/Pct into the operational store
 * (applyGradeMap). Detached + re-gradeable: the run goes status=grading → done.
 * This is the impartial scoring leg, already proven on flipt (D-024) + the m3 arm
 * (6/11). The grader fn is injectable so the orchestration is unit-tested without
 * docker.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDb, type DbScope } from './reproducibility/db';
import { applyGradeMap, setBenchRunStatus } from './run-store';
import { defaultBenchResultsDir } from './preserved-runs';

export interface GradeArgs {
  dir: string;
  arm: string;
  sampleJsonl: string;
}

export interface GradeDeps {
  scope?: DbScope;
  /** Run the official grader → { instance_id: resolved }. Default: the python path. */
  grade?: (args: GradeArgs) => Promise<Record<string, boolean>>;
  baseDir?: string;
}

/** Kick a (re-)grade of a run. Sets status=grading, runs the grader DETACHED,
 *  applies the verdict map, then status=done. Returns { runId, done } or an error. */
export async function gradeBenchRun(
  runId: string,
  deps: GradeDeps = {},
): Promise<{ runId: string; done: Promise<void> } | { error: string }> {
  const scope = deps.scope ?? {};
  const { sql, ws } = resolveDb(scope);
  const rows = await sql<{ arm: string }[]>`
    SELECT arm FROM harness_shared.bench_runs WHERE id = ${runId} AND workspace_id = ${ws} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { error: 'run_not_found' };

  const baseDir = deps.baseDir ?? defaultBenchResultsDir();
  const dir = join(baseDir, runId);
  const sampleJsonl = join(dir, 'tasks-sample.jsonl');
  const grade = deps.grade ?? runGradeScript;

  await setBenchRunStatus(runId, 'grading', {}, scope);

  const done = (async () => {
    try {
      const gradeMap = await grade({ dir, arm: row.arm, sampleJsonl });
      await applyGradeMap(runId, gradeMap, scope);
      await setBenchRunStatus(runId, 'done', {}, scope);
    } catch (e) {
      await setBenchRunStatus(
        runId,
        'error',
        { runError: `grade failed: ${e instanceof Error ? e.message : String(e)}` },
        scope,
      ).catch(() => {});
    }
  })();

  return { runId, done };
}

/** The default grader: spawn _xbench_grade.py (official swe_bench_pro_eval +
 *  local docker) and read its eval_results.json verdict map. */
async function runGradeScript(args: GradeArgs): Promise<Record<string, boolean>> {
  const { dir, arm, sampleJsonl } = args;
  const scriptPath = fileURLToPath(new URL('./_xbench_grade.py', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('python3', [scriptPath, arm], {
      env: { ...process.env, XBENCH_OUT_DIR: dir, XBENCH_SAMPLE: sampleJsonl },
      stdio: 'inherit',
    });
    proc.on('error', reject);
    // The script exits 2 when no verdict was produced; treat only 0 as success.
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`grade script exit ${code}`))));
  });
  const resultsPath = join(dir, `grade-${arm}`, 'out', 'eval_results.json');
  if (!existsSync(resultsPath)) throw new Error('grading produced no eval_results.json');
  const parsed = JSON.parse(readFileSync(resultsPath, 'utf8')) as Record<string, unknown>;
  const map: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(parsed)) map[k] = v === true;
  return map;
}
