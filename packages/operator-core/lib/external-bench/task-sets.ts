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
 *
 * SWE-bench Verified is a SEPARATE family/suite (benchmark-arms-su-vs-queen-expansion P-006).
 * Verified is the ORIGINAL `princeton-nlp/SWE-bench_Verified` ecosystem — NOT SWE-bench Pro:
 * the original SWE-bench `swebench` harness (`python -m swebench.harness.run_evaluation`), the
 * original `docker.io/swebench/sweb.eval.*` images (NOT `jefzda/sweap-images`), real JSON-array
 * FAIL_TO_PASS/PASS_TO_PASS, and an un-prefixed `instance_id` (`astropy__astropy-12907`, NOT
 * `instance_…`). So Verified rows map through {@link verifiedRowToBenchTask}, NOT
 * {@link rowToBenchTask}, and carry `benchmark: 'swe-bench-verified'`:
 *
 *   'verified-pilot-10'    → a 10-instance representative subset (1 per repo, all tiers).
 *   'swe-bench-verified'   → the full 500-instance test split.
 *   'swe-bench-verified-custom' → the verified set filtered to an explicit instance-id list.
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

/**
 * A SWE-bench **Verified** task row as written to `~/.papercusp/bench-results/swe-bench-verified/tasks.jsonl`
 * (P-006). Maps the `princeton-nlp/SWE-bench_Verified` dataset row → a TaskRow-shaped record. Differences
 * from {@link TaskRow}: the `instance_id` is UN-prefixed (`astropy__astropy-12907`), `fail_to_pass`/
 * `pass_to_pass` are REAL JSON-array strings (double-quoted, e.g. `["test::foo"]`, NOT Pro's Python-ish
 * single-quoted literals), and the grader needs `test_patch` + `version` + `environment_setup_commit` rather
 * than Pro's `selected_test_files_to_run` + dockerhub tag. The gold `patch` is deliberately NOT persisted
 * (the arm must never see it — un-gameable task set). `swebench_difficulty` is the upstream human effort label.
 */
interface VerifiedTaskRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  /** JSON-array string of fully-qualified test ids the patch must turn green. */
  fail_to_pass?: string;
  /** JSON-array string of tests that must stay green. */
  pass_to_pass?: string;
  /** The hidden test-file patch the grader applies before running the suite. */
  test_patch?: string;
  /** Upstream `version` — selects the env/install recipe the swebench harness uses. */
  version?: string;
  /** Commit the harness sets the env up at (distinct from base_commit for some repos). */
  environment_setup_commit?: string;
  created_at?: string;
  /** Upstream human-annotated effort label (`<15 min fix` | `15 min - 1 hour` | `1-4 hours` | `>4 hours`). */
  swebench_difficulty?: string;
  /** Derived easy/medium/hard tier (mapped from {@link swebench_difficulty}). */
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

/** The full SWE-bench Verified 500-task JSONL (env-overridable). */
export function verifiedTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_VERIFIED_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'swe-bench-verified', 'tasks.jsonl')
  );
}

/** The 10-instance SWE-bench Verified representative pilot JSONL (env-overridable). */
export function verifiedPilotTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_VERIFIED_PILOT_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'swe-bench-verified', 'verified-pilot-10.jsonl')
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

/* ------------------------------- SWE-bench Verified ------------------------------- */

/** Parse a REAL JSON-array string (`["a","b"]`) → string[]. Verified ships proper JSON (unlike Pro's
 *  Python-ish single-quoted literals that {@link pyList} repairs), so a plain JSON.parse is correct. */
function jsonStrList(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Derive the canonical SWE-bench docker image name the ORIGINAL `swebench` harness pulls for a Verified
 * instance. The harness normalizes the instance_id to lowercase and replaces `__` → `_1776_` only in older
 * versions; the current convention is `docker.io/swebench/sweb.eval.<arch>.<instance_id_lower>:latest` with
 * `__` preserved. We emit the namespaced repo name WITHOUT a tag (the grader/harness owns the tag + arch)
 * so the value is informational provenance, not a hardcoded pull target. Arch defaults to x86_64.
 *
 * ⚠ The EXACT image name (arch suffix, tag, any `__`→`_1776_` munge) is harness-version-specific and is NOT
 * verified here against a real pull (P-006 is metadata-only). The verified GRADER resolves the real image via
 * the `swebench` harness itself — this is a best-effort label for the run card / `graderMeta`, never the
 * grading source of truth.
 */
function verifiedImageName(instanceId: string, arch = 'x86_64'): string {
  return `swebench/sweb.eval.${arch}.${instanceId.toLowerCase()}`;
}

/** Map one SWE-bench Verified row → a BenchTask. Mirrors {@link rowToBenchTask} but carries the
 *  Verified family + the swebench-harness grader inputs (FAIL_TO_PASS / PASS_TO_PASS / test_patch /
 *  version / environment_setup_commit) and the informational image name. */
export function verifiedRowToBenchTask(r: VerifiedTaskRow): BenchTask {
  return {
    benchmark: 'swe-bench-verified',
    instanceId: r.instance_id,
    problemStatement: r.problem_statement,
    repo: `${reposRoot()}/${shortName(r.instance_id)}`,
    baseCommit: r.base_commit ?? '',
    ...(r.tier ? { tier: r.tier } : {}),
    graderMeta: {
      // The official swebench harness keys (the grader reads these; the arm never does).
      image_name: verifiedImageName(r.instance_id),
      FAIL_TO_PASS: jsonStrList(r.fail_to_pass),
      PASS_TO_PASS: jsonStrList(r.pass_to_pass),
      test_patch: r.test_patch ?? '',
      version: r.version ?? '',
      environment_setup_commit: r.environment_setup_commit ?? '',
      upstream_repo: r.repo,
      ...(r.swebench_difficulty ? { swebench_difficulty: r.swebench_difficulty } : {}),
      ...(r.tier ? { tier: r.tier } : {}),
    },
  } satisfies BenchTask;
}

function readVerifiedJsonl(path: string): VerifiedTaskRow[] {
  if (!existsSync(path)) {
    throw new Error(
      `SWE-bench Verified task set not found at ${path} — run the dataset acquisition (P-006) to provision it`,
    );
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VerifiedTaskRow);
}

/** Load a SWE-bench Verified task set → BenchTask[]. `verified-pilot-10` reads the 10-instance subset;
 *  `swe-bench-verified` the full 500; `swe-bench-verified-custom` filters the full set to `taskIds`. */
export function loadVerifiedTaskSet(taskSetId: string, taskIds?: string[]): BenchTask[] {
  const path = taskSetId === 'verified-pilot-10' ? verifiedPilotTaskSetPath() : verifiedTaskSetPath();
  let tasks = readVerifiedJsonl(path).map(verifiedRowToBenchTask);
  if (taskSetId === 'swe-bench-verified-custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) throw new Error('task set "swe-bench-verified-custom" requires a non-empty taskIds list');
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) throw new Error('no tasks in the Verified corpus matched the custom taskIds');
  }
  return tasks;
}

/** The SWE-bench Verified task-set ids this loader serves. */
export const VERIFIED_TASK_SET_IDS = ['verified-pilot-10', 'swe-bench-verified', 'swe-bench-verified-custom'] as const;

/** True iff `taskSetId` is a SWE-bench Verified set (routes to {@link loadVerifiedTaskSet}). */
export function isVerifiedTaskSet(taskSetId: string): boolean {
  return (VERIFIED_TASK_SET_IDS as readonly string[]).includes(taskSetId);
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
  if (isVerifiedTaskSet(taskSetId)) {
    // Wrap so a synchronous validation throw surfaces as a rejected promise (the Pro branch convention).
    try {
      return Promise.resolve(loadVerifiedTaskSet(taskSetId, taskIds));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
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
  let verifiedCount: number | null = null;
  try {
    verifiedCount = readVerifiedJsonl(verifiedTaskSetPath()).length;
  } catch {
    verifiedCount = null;
  }
  let verifiedPilotCount: number | null = null;
  try {
    verifiedPilotCount = readVerifiedJsonl(verifiedPilotTaskSetPath()).length;
  } catch {
    verifiedPilotCount = null;
  }
  return [
    { id: '11-task-pilot', label: '11-task pilot (public SWE-bench Pro)', count: pilotCount },
    {
      id: 'stratified-30',
      label: 'Difficulty-stratified 30 (10 easy / 10 medium / 10 hard)',
      count: stratifiedCount,
    },
    { id: 'swe-bench-pro-full', label: 'Full SWE-bench Pro (~731)', count: 731 },
    { id: 'verified-pilot-10', label: 'SWE-bench Verified pilot (10, representative)', count: verifiedPilotCount },
    { id: 'swe-bench-verified', label: 'Full SWE-bench Verified (500)', count: verifiedCount },
    { id: 'custom', label: 'Custom instance ids', count: null },
  ];
}
