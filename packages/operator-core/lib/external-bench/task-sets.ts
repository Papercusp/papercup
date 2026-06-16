/**
 * Named benchmark task-set loader (benchmark-evaluation-ui-2026-06-16 P-004).
 *
 * Maps a task_set_id the launch form sends → the BenchTask[] the engine runs.
 * The Row→BenchTask mapping mirrors the CLI launcher (_xbench_realqueen_compare.ts
 * loadTasks) — same SWE-bench Pro JSONL shape, same grader-meta derivation — so a
 * UI launch and a CLI launch produce identical tasks.
 *
 *   '11-task-pilot'      → the locked 11-task public SWE-bench Pro pilot (the m3 set).
 *   'stratified-30'      → 10 EASY + 10 MEDIUM + 10 HARD difficulty-stratified tasks
 *                          (benchmark-arms-su-vs-queen-expansion-2026-06-16 P-005),
 *                          tiered by empirical per-task solve rate + a structural score.
 *                          Each task carries its `tier` so resolved% reports per-tier.
 *   'custom'             → the pilot set filtered to an explicit instance-id list.
 *   'swe-bench-pro-full' → the full ~731-task set (NOT yet provisioned on disk —
 *                          throws an honest error rather than silently running a
 *                          partial set; wiring the full dataset is owner-gated).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BenchTask } from './types';

/** A SWE-bench Pro task row as persisted in the pilot JSONL. */
interface TaskRow {
  instance_id: string;
  repo?: string;
  base_commit?: string;
  problem_statement: string;
  fail_to_pass?: string;
  selected_test_files_to_run?: string;
  language?: string;
  /** Difficulty tier — only present on stratified rows (see {@link stratifiedTaskSetPath}). */
  tier?: 'easy' | 'medium' | 'hard';
}

/** The canonical 11-task pilot JSONL (env-overridable). */
export function pilotTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_PILOT_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'm3-realqueen-2026-06-16', 'tasks-sample.jsonl')
  );
}

/** The difficulty-stratified 30-task JSONL (env-overridable). */
export function stratifiedTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_STRATIFIED_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'stratified-30', 'tasks.jsonl')
  );
}

/** The stratified set's tier map (instance_id → tier + difficulty score), env-overridable. */
export function stratifiedTiersPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_STRATIFIED_TIERS ??
    join(homedir(), '.papercusp', 'bench-results', 'stratified-30', 'tiers.json')
  );
}

/** Local repo checkout root the engine clones tasks under (env-overridable). */
function reposRoot(): string {
  return process.env.XBENCH_REPOS_ROOT ?? join(homedir(), '.papercusp', 'bench-repos');
}

/** Parse a Python-ish list literal ("['a', 'b']") → string[]. */
function pyList(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s.replace(/'/g, '"')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Derive the official grader's dockerhub tag (mirrors the CLI launcher). */
function dockerhubTag(instanceId: string, repo: string): string {
  const [repoBase, repoNameRaw] = repo.toLowerCase().split('/');
  let repoNameOnly = repoNameRaw;
  let hsh = instanceId.replace(/^instance_/, '');
  if (instanceId === 'instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan') {
    repoNameOnly = 'element-web';
  } else if (repo.toLowerCase().includes('element-hq') && repo.toLowerCase().includes('element-web')) {
    repoNameOnly = 'element';
    if (hsh.endsWith('-vnan')) hsh = hsh.slice(0, -5);
  } else if (hsh.endsWith('-vnan')) {
    hsh = hsh.slice(0, -5);
  }
  let tag = `${repoBase}.${repoNameOnly}-${hsh}`;
  if (tag.length > 128) tag = tag.slice(0, 128);
  return tag;
}

function shortName(instanceId: string): string {
  return instanceId.replace(/^instance_/, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
}

/** Map one JSONL row → a BenchTask (same shape the CLI builds). `tier` (when set) is
 *  carried both as a first-class field and inside graderMeta for per-tier reporting. */
export function rowToBenchTask(r: TaskRow): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: r.instance_id,
    problemStatement: r.problem_statement,
    repo: `${reposRoot()}/${shortName(r.instance_id)}`,
    baseCommit: r.base_commit ?? '',
    language: r.language,
    ...(r.tier ? { tier: r.tier } : {}),
    graderMeta: {
      dockerhub_tag: dockerhubTag(r.instance_id, r.repo ?? ''),
      FAIL_TO_PASS: pyList(r.fail_to_pass),
      PASS_TO_PASS: [],
      testFiles: pyList(r.selected_test_files_to_run),
      ...(r.tier ? { tier: r.tier } : {}),
    },
  } satisfies BenchTask;
}

function readJsonl(path: string): TaskRow[] {
  if (!existsSync(path)) {
    throw new Error(`bench task set not found at ${path} — the corpus is not provisioned on this host`);
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TaskRow);
}

/** The tiers.json shape (instance_id → tier + difficulty diagnostics). */
type TierEntry = { tier: 'easy' | 'medium' | 'hard'; score?: number };

/** Read the stratified set's tier map; missing file → empty map (rows then carry no tier). */
function readTiers(path: string): Map<string, 'easy' | 'medium' | 'hard'> {
  const out = new Map<string, 'easy' | 'medium' | 'hard'>();
  if (!existsSync(path)) return out;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, TierEntry>;
  for (const [iid, entry] of Object.entries(raw)) {
    if (entry?.tier === 'easy' || entry?.tier === 'medium' || entry?.tier === 'hard') out.set(iid, entry.tier);
  }
  return out;
}

/** Load the difficulty-stratified 30-task set → BenchTask[], tier merged from tiers.json. */
export function loadStratifiedTaskSet(): BenchTask[] {
  const rows = readJsonl(stratifiedTaskSetPath());
  const tiers = readTiers(stratifiedTiersPath());
  return rows.map((r) => rowToBenchTask({ ...r, tier: r.tier ?? tiers.get(r.instance_id) }));
}

/** Load a named task set → BenchTask[]. */
export function loadBenchTaskSet(taskSetId: string, taskIds?: string[]): Promise<BenchTask[]> {
  if (taskSetId === 'swe-bench-pro-full') {
    return Promise.reject(
      new Error(
        'task set "swe-bench-pro-full" (~731 tasks) is not yet provisioned on this host — ' +
          'wire the full SWE-bench Pro dataset before launching it (owner-gated). Use "11-task-pilot" or "custom".',
      ),
    );
  }
  if (taskSetId === 'stratified-30') {
    return Promise.resolve(loadStratifiedTaskSet());
  }
  const rows = readJsonl(pilotTaskSetPath());
  let tasks = rows.map(rowToBenchTask);
  if (taskSetId === 'custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) {
      return Promise.reject(new Error('task set "custom" requires a non-empty taskIds list'));
    }
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) {
      return Promise.reject(new Error('no tasks in the corpus matched the custom taskIds'));
    }
  }
  return Promise.resolve(tasks);
}

/** Write the grader's sample JSONL (the raw rows, filtered to `instanceIds` when
 *  given) to `destPath` — the --raw_sample_path the official grader reads. */
export function writeTaskSampleJsonl(taskSetId: string, instanceIds: string[] | undefined, destPath: string): number {
  if (taskSetId === 'swe-bench-pro-full') {
    throw new Error('swe-bench-pro-full sample is not provisioned on this host');
  }
  const rows = readJsonl(taskSetId === 'stratified-30' ? stratifiedTaskSetPath() : pilotTaskSetPath());
  const want = instanceIds && instanceIds.length > 0 ? new Set(instanceIds) : null;
  const selected = want ? rows.filter((r) => want.has(r.instance_id)) : rows;
  writeFileSync(destPath, selected.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return selected.length;
}

/** The task sets the launch form offers (id + label + count when known). */
export function knownTaskSets(): Array<{ id: string; label: string; count: number | null }> {
  let pilotCount: number | null = null;
  try {
    pilotCount = readJsonl(pilotTaskSetPath()).length;
  } catch {
    pilotCount = null;
  }
  let stratifiedCount: number | null = null;
  try {
    stratifiedCount = readJsonl(stratifiedTaskSetPath()).length;
  } catch {
    stratifiedCount = null;
  }
  return [
    { id: '11-task-pilot', label: '11-task pilot (public SWE-bench Pro)', count: pilotCount },
    {
      id: 'stratified-30',
      label: 'Difficulty-stratified 30 (10 easy / 10 medium / 10 hard)',
      count: stratifiedCount,
    },
    { id: 'swe-bench-pro-full', label: 'Full SWE-bench Pro (~731)', count: 731 },
    { id: 'custom', label: 'Custom instance ids', count: null },
  ];
}
