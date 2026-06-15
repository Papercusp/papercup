/**
 * Publication export (BRIEF 8 / P-010). PG is canonical; this serializes a run's
 * rollout cards + a run-level manifest into benchmarks/ files for the
 * third-party reproducer bundle (the layout P-016's reproducer README points at).
 * Run after a pilot; git-sync carries the files to origin.
 *
 *   benchmarks/rollouts/<runId>/<arm>/<suite>__<taskId>__seed-<n>.json  — one per rollout
 *   benchmarks/runs/<runId>/manifest.json                                — the run index
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from '../../agent-tools/docs/_repo-paths';
import { getRollout, getPrereg, listRunResults } from './store';

/** Path-safe slug for a benchmark task id (instance ids carry slashes/colons). */
function slug(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export interface ExportResult {
  /** Repo-relative manifest path. */
  manifestPath: string;
  /** Repo-relative rollout file paths. */
  rolloutFiles: string[];
  count: number;
}

/**
 * Export every rollout for `runId` + a manifest. Returns repo-relative paths.
 */
export async function exportRunBundle(
  runId: string,
  opts: { repoRoot?: string } = {},
): Promise<ExportResult> {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const results = await listRunResults({ runId });

  const rolloutFiles: string[] = [];
  const arms = new Set<string>();
  const suites = new Set<string>();
  const seeds = new Set<number>();
  const graderVersions = new Set<string>();

  for (const r of results) {
    const rollout = await getRollout(r.rolloutId);
    const rel = path.join(
      'benchmarks',
      'rollouts',
      runId,
      r.arm,
      `${r.suite}__${slug(r.taskId)}__seed-${r.seed}.json`,
    );
    const abs = path.join(repoRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify({ result: r, rollout }, null, 2)}\n`, 'utf8');
    rolloutFiles.push(rel);
    arms.add(r.arm);
    suites.add(r.suite);
    seeds.add(r.seed);
    graderVersions.add(`${r.graderFamily}@${r.graderVersion}`);
  }

  const prereg = await getPrereg({ runId });
  const manifestRel = path.join('benchmarks', 'runs', runId, 'manifest.json');
  const manifestAbs = path.join(repoRoot, manifestRel);
  const manifest = {
    runId,
    preregHash: prereg?.preregHash ?? null,
    preregFile: prereg?.filePath ?? null,
    suites: [...suites].sort(),
    arms: [...arms].sort(),
    seeds: [...seeds].sort((a, b) => a - b),
    graderVersions: [...graderVersions].sort(),
    rolloutCount: results.length,
    exportedAt: new Date().toISOString(),
    rolloutFiles,
  };
  mkdirSync(path.dirname(manifestAbs), { recursive: true });
  writeFileSync(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { manifestPath: manifestRel, rolloutFiles, count: results.length };
}
