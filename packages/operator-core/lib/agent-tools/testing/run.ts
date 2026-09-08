/**
 * testing:run — run exact test files and return a DISTILLED result.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-021 (D-021 measurement,
 * D-022 design ruling).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * D-021 measured the 7d corpus: 2,645 test-running atoms across 68 of 86 su
 * sessions. Agents already HAVE a good runner and reach for it 70.8% of the
 * time — what they lack is a RESULT. Of 2,620 test-running commands, 84.8%
 * pipe the output to `tail`/`head` (median `tail -60`), 81.7% merge `2>&1`
 * into that pipe, and 15.7% redirect to a log and grep it separately. The
 * command issued immediately after a test run is `cd` 1371x, `grep` 262x,
 * `tail` 109x. The cost this tool removes is the OUTPUT HANDLING, not the
 * execution — which is why it returns counts + per-test failures and offers
 * NO raw-output passthrough (that would re-create the `| tail -80` pipe
 * inside the tool and forfeit the entire saving).
 *
 * ── What it deliberately does NOT reimplement (D-022) ───────────────────────
 * This tool is an ASSEMBLY. `scripts/test-files.mjs` already owns owning-config
 * discovery, the zero/partial-match false-green refusal, the load-adaptive
 * worker cap, mid-install-corruption detection and Vitest-4 silent-collection
 * recovery — so we SHELL it and never re-derive routing. `distillVitestRun`
 * already owns the projection. The `admin-test-runs-reporter` already writes
 * one `harness_shared.test_runs` row per file on every local run, so this tool
 * writes NO rows; it only stamps `PAPERCUSP_TEST_RUN_GROUP=<runId>` so the
 * reporter correlates the run's rows and `testing:flakiness` can find them.
 *
 * ⚠ "one row per file" describes the row GRANULARITY, NOT the write TIMING.
 * The live reporter (libs/test-config/src/admin-test-runs-reporter.ts) QUEUES
 * each row in memory at `onTestModuleEnd` and performs its ONLY write in
 * `flushPending()`, called from `onTestRunEnd`/`onExit` — because `worktree_dirty`
 * and `commit_sha` are whole-RUN facts derived from a before/after git snapshot
 * that does not exist at file-completion time (D-007: "missing proof of stability
 * is dirty, never a false clean"). Consequence: a run killed mid-flight (batch
 * watchdog, SIGKILL) writes NOTHING — every already-computed per-file result is
 * lost, and leaves no trace (zero `cancelled`/`running` rows in 7 days / 459k rows).
 * Measured on real run-groups: per-file completions span up to ~24s while every
 * row is inserted within ~10ms of the others, ~1s after the last file (EI-20343103917336944).
 * ⛔ Do NOT reason about this ledger from
 * `packages/operator-core/test/reporters/admin-test-runs-reporter.ts` — that copy
 * DOES insert per-file, but it is wired to no vitest config and is a superseded
 * fossil; `defineVitestConfig` auto-wires the libs/test-config one.
 *
 * ── The correctness argument ────────────────────────────────────────────────
 * 372 raw-`vitest run` commands appear in the corpus across 44 sessions, 107 of
 * them with no `cd` — i.e. root-level `vitest run <path>`, exactly the
 * zero/partial-match false-green the router exists to refuse (a run that
 * silently executes NOTHING and exits 0). ~14% of all test invocations opt out
 * of that guard. Because this tool can only ever go through the router, that
 * bypass is not expressible here.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Exact FILES only — 82% of the measured family ("run these exact file(s)",
 * 69.5% via the router + 12.3% via raw vitest). `test:affected` (7.9%) is NOT
 * covered: `scripts/affected-tests.mjs` runs each workspace's own `npm test`
 * and has no vitest-arg passthrough, so a JSON reporter cannot be plumbed
 * through it without real work. Keep using `npm run test:affected` for that.
 */

import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  boundTestRunPayload,
  captureWorktreeSnapshot,
  computeWorktreeDirty,
  distillVitestRun,
  mergeDistilledRuns,
  parseFailureDetailsSidecar,
  parseVitestJsonForHarnessRows,
  persistHarnessTestRuns,
  TESTING_RUN_MAX_PAYLOAD_BYTES,
  startRun,
  startRunDurable,
  type SpawnRequest,
  type DistilledTestRun,
} from '../../testing-run-store';
import { deriveAffectedPlan } from './affected-plan';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { REPO_ROOT } from '../docs/_repo-paths';
import { selectUnambiguousEvidenceRoot } from '../../evidence-root-selection';
import { FOREGROUND_TIMEOUT_CEILING_MS, clampForegroundTimeoutMs } from '../capability/foreground-transport-cap';
import { ensurePapercuspTmpdir } from '@papercusp/test-config/tmpdir-guard';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  admissionContextFromEnvironment,
  governedExecutionLeaseTtlForTimeout,
  runGovernedOperation,
  type GovernedExecutionSettlement,
} from '../../resource-governor/execution';
import type { ResourceDemand } from '../../resource-governor/admission';

/** Hard ceiling on a single run, so a wedged suite can never hold a turn open
 *  indefinitely. 21% of corpus commands already hand-wrapped a `timeout`; this
 *  makes that budget the tool's own rather than something each agent re-picks. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
const ADMIN_TEST_RUNS_REPORTER_RELATIVE_PATH = 'libs/test-config/src/admin-test-runs-reporter.ts';
const TEST_FAILURE_DETAILS_FILENAME = 'failure-details.json';

/**
 * A managed Papercusp checkout owns a Vitest reporter that records its run.
 * An independent sibling checkout generally does not; in that case the
 * operator must ingest the JSON report itself after the child exits. Loading
 * Papercusp's TypeScript reporter into the foreign Vitest process is not a
 * reliable fallback: its package resolution and fail-soft database connection
 * both belong to a different checkout.
 */
export function shouldIngestVitestLedgerInProcess(testRoot: string): boolean {
  return !existsSync(join(testRoot, ADMIN_TEST_RUNS_REPORTER_RELATIVE_PATH));
}

const DETACHED_INSPECT_TEST_HINT =
  "For one test file, re-run it detached with capability:inspect { check: 'test', package: '<owning workspace>', path: '<test file>', run_in_background: true }, then poll capability:bash_output. " +
  'capability:inspect accepts one test path per call; split a multi-file run into one detached call per file, and do not pass the file array as onlyPaths (that field is typecheck-only). If this run returns a detachedRunId, poll it with testing:run-status { runId }. ';

const DETACHED_ROUTER_TEST_HINT =
  "For integration test files, re-run detached with capability:bash { command: 'npm run test:file -- <test path>', run_in_background: true }, then poll capability:bash_output. " +
  'The test:file router selects the owning Vitest config; run one file per detached call when needed. If this run returns a detachedRunId, poll it with testing:run-status { runId }. ';

function detachedRunStatusHint(runId: string): string {
  return `started detached recovery run ${runId}; poll it with testing:run-status { runId: '${runId}' }. `;
}

/**
 * A detached run whose durable snapshot did not land is readable ONLY from this
 * process's in-memory map, and only until it restarts — which is routine here.
 * Say so plainly rather than promising a poll that can answer `unknown_run`,
 * because the caller must never read that as "the tests passed".
 */
function detachedRunUndurableHint(runId: string): string {
  return (
    `started detached recovery run ${runId}, but its durable snapshot could NOT be written, so ` +
    `testing:run-status { runId: '${runId}' } may answer unknown_run — which is NOT evidence the tests passed. ` +
    'Prefer the detached fallback below. '
  );
}

/**
 * Compose the recovery sentence for a timed-out foreground run. Exported so the
 * durability gate is guarded directly: the promise we make about
 * testing:run-status must track whether the snapshot actually persisted.
 */
export function detachedRecoveryHint(opts: { runId?: string | undefined; durable: boolean }): string {
  if (!opts.runId) return '';
  return opts.durable ? detachedRunStatusHint(opts.runId) : detachedRunUndurableHint(opts.runId);
}

/**
 * Choose the timeout recovery that can actually run the timed-out file.
 *
 * `capability:inspect check:"test"` intentionally launches the package's default
 * `npx vitest` config. That config excludes `*.integration.test.*`, so prescribing
 * it for an integration timeout deterministically fails before the suite starts.
 * The repository's `npm run test:file` router is the owning-config surface for
 * integration files and must be the recovery path instead.
 */
export function detachedTestTimeoutHint(files: string[]): string {
  const hasIntegrationFile = files.some((file) => /\.integration\.test\.[cm]?[jt]sx?$/i.test(file));
  return hasIntegrationFile ? DETACHED_ROUTER_TEST_HINT : DETACHED_INSPECT_TEST_HINT;
}

/**
 * Build the store-backed recovery command for a Papercusp checkout. The
 * foreground run's JSON report lives in a private temporary directory that is
 * removed as soon as the bounded call returns; a detached run therefore gets
 * no report path from that run. Its store snapshot is the durable/pollable
 * result surface, while the router remains the source of truth for owning
 * config discovery and zero-match refusal.
 */
export function buildDetachedTestRunRequest(opts: {
  root: string;
  files: string[];
  testNamePattern?: string;
}): SpawnRequest {
  const vitestArgs = opts.testNamePattern ? [`--testNamePattern=${opts.testNamePattern}`] : [];
  return {
    kind: 'vitest',
    label: `testing:run timeout recovery (${opts.files.join(', ')})`,
    filePath: opts.files.length === 1 ? opts.files[0] : undefined,
    command: process.execPath,
    args: [join(opts.root, 'scripts', 'test-files.mjs'), ...opts.files, '--', ...vitestArgs],
    cwd: opts.root,
  };
}

type TestFilePathResolution = { ok: true; files: string[] } | { ok: false; path: string; matches: string[] };

/**
 * Expand the root package's declared workspace directories. The repository's root workspace
 * patterns are either concrete directories or one-level trailing `/*` globs; keeping this
 * discovery local avoids importing a task runner that would execute work at module load time.
 */
function declaredWorkspaceDirs(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    const dirs = new Set<string>();
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || !pattern) continue;
      const normalized = pattern.replace(/\\/g, '/');
      if (normalized.endsWith('/*') && !normalized.slice(0, -2).includes('*')) {
        const base = normalized.slice(0, -2);
        const baseDir = join(root, base);
        for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(baseDir, entry.name, 'package.json'))) {
            dirs.add(`${base}/${entry.name}`);
          }
        }
        continue;
      }
      if (!normalized.includes('*') && existsSync(join(root, normalized, 'package.json'))) {
        dirs.add(normalized);
      }
    }
    return [...dirs];
  } catch {
    return [];
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * A checkout that can own an absolute test path without relying on Papercusp's
 * router. This requires superproject markers, then accepts either a Vitest
 * config or an installed Vitest binary for the generic runner.
 */
function isWorkspaceCheckoutRoot(root: string): boolean {
  try {
    const git = statSync(join(root, '.git'));
    if (!git.isDirectory() && !git.isFile()) return false;
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    return Array.isArray(pkg.workspaces) || Array.isArray(pkg.workspaces?.packages);
  } catch {
    return false;
  }
}

/**
 * Discover independent workspace checkouts sitting beside the requested repo.
 *
 * A structured rubric check is stored as a portable workspace-relative path such
 * as `portal/tests/foo.test.ts`, but the test router must execute it from the
 * `portal` checkout itself.  The plan-audit citation resolver already admits
 * these sibling repositories; keep testing:run on the same admission rule rather
 * than rejecting a real, tracked test merely because it is outside the ambient
 * checkout.  Only direct children with a real `.git` directory and a workspace
 * package are admitted, so release/checkpoint worktrees and arbitrary folders do
 * not become execution roots.
 */
function independentWorkspaceCheckoutRoots(root: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // A stale requested root is handled by the normal resolver; keep the literal
    // path here so a sibling can still be discovered from its parent.
  }
  const parent = dirname(resolve(root));
  let entries: Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = join(parent, entry.name);
    try {
      if (realpathSync(candidate) === realRoot) continue;
      // A pointer-file `.git` identifies a release/checkpoint worktree, not an
      // independent checkout that may supply rubric evidence or run tests.
      if (!statSync(join(candidate, '.git')).isDirectory()) continue;
      if (!isWorkspaceCheckoutRoot(candidate)) continue;
      names.set(entry.name, realpathSync(candidate));
    } catch {
      // Broken symlink / disappearing checkout: leave it out of this snapshot.
    }
  }
  return names;
}

function isVitestCheckoutRoot(root: string): boolean {
  if (!isWorkspaceCheckoutRoot(root)) return false;
  return (
    [
      'vitest.config.ts',
      'vitest.config.mts',
      'vitest.config.cts',
      'vitest.config.js',
      'vitest.config.mjs',
      'vitest.config.cjs',
    ].some((name) => existsSync(join(root, name))) || existsSync(join(root, 'node_modules', '.bin', 'vitest'))
  );
}

/** Find the owning superproject for an absolute path, bounded to its ancestors. */
export function checkoutRootForPath(file: string): string | undefined {
  if (!isAbsolute(file)) return undefined;
  let dir = dirname(resolve(file));
  for (let depth = 0; depth < 64; depth += 1) {
    if (isWorkspaceCheckoutRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Select one checkout for a test request. Relative paths retain the caller's
 * ambient tree. Absolute paths switch only when every path resolves to the same
 * discovered checkout; mixed roots stay on the ambient tree and fail loudly
 * through the normal path checks instead of silently combining trees.
 */
export function checkoutRootForTestFiles(files: string[], ambientRoot: string): string {
  const absoluteFiles = files.filter((file) => isAbsolute(file));
  if (absoluteFiles.length === 0) return ambientRoot;
  const roots = absoluteFiles.map(checkoutRootForPath);
  if (roots.some((root): root is undefined => root === undefined)) return ambientRoot;
  const unique = [...new Set(roots as string[])];
  return unique.length === 1 ? unique[0]! : ambientRoot;
}

/**
 * Discover real Hive checkouts in the canonical and scoped Papercus homes.
 * The optional parent list keeps this focused-testable while production follows
 * the same ordering as the Hive seed routine.
 */
export function discoverKnownHiveCheckoutRoots(
  hiveParents: string[] = [
    join(homedir(), '.papercusp', 'hives'),
    ...(process.env.PAPERCUSP_HOME?.trim() ? [join(process.env.PAPERCUSP_HOME.trim(), 'hives')] : []),
  ],
): string[] {
  const roots = new Set<string>();
  for (const parent of hiveParents) {
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const root = join(parent, entry.name);
        if (isWorkspaceCheckoutRoot(root)) roots.add(root);
      }
    } catch {
      continue;
    }
  }
  return [...roots];
}

export type TestFileRootSource = 'requested' | 'absolute-file-checkout' | 'hive-checkout' | 'canonical-repo';

export interface SelectedTestFileRoot {
  root: string;
  source: TestFileRootSource;
}

function testFilesResolveAtRoot(files: string[], root: string): boolean {
  const hasRouter = existsSync(join(root, 'scripts', 'test-files.mjs'));
  if (!hasRouter && !isVitestCheckoutRoot(root)) return false;
  const resolution = normalizeTestFilePaths(files, root);
  if (!resolution.ok) return false;
  return resolution.files.every((file) => {
    if (isAbsolute(file)) return existsSync(file);
    const candidate = resolve(root, file);
    return isInsideRoot(root, candidate) && existsSync(candidate);
  });
}

/**
 * WI-41400 — select the direct testing:run handler's tree before the core's loud
 * invalid-root pre-flight. A valid requested checkout stays authoritative. A stale
 * phantom root may fall back to exactly one discovered Hive checkout, then to the
 * canonical repo only when there was no discovered match. Ambiguity preserves the
 * requested root so the core refuses loudly instead of choosing an arbitrary tree.
 */
export function selectTestFileRoot(
  files: string[],
  requested: string,
  opts: {
    discoveredRoots?: readonly string[];
    canonicalRepoRoot?: string;
  } = {},
): SelectedTestFileRoot {
  const preferredRoot = checkoutRootForTestFiles(files, requested);
  const preferredSource: TestFileRootSource =
    resolve(preferredRoot) === resolve(requested) ? 'requested' : 'absolute-file-checkout';
  const selected = selectUnambiguousEvidenceRoot<TestFileRootSource>({
    preferred: { root: preferredRoot, source: preferredSource },
    candidates: (opts.discoveredRoots ?? discoverKnownHiveCheckoutRoots()).map((root) => ({
      root,
      source: 'hive-checkout',
    })),
    fallback: { root: opts.canonicalRepoRoot ?? REPO_ROOT, source: 'canonical-repo' },
    resolvesEvery: (root) => testFilesResolveAtRoot(files, root),
  });
  return selected ?? { root: preferredRoot, source: preferredSource };
}

/**
 * Accept the two path vocabularies exposed by the release pipeline:
 * repo-root-relative paths (the router's native contract) and paths relative to exactly one
 * declared npm workspace (the gate's `{ workspace, file }` contract). A workspace-relative
 * spelling is expanded only when the file exists in one workspace; multiple matches are refused
 * before any test process starts so a caller cannot verify an unintended file.
 */
export function normalizeTestFilePaths(
  files: string[],
  root: string,
  workspaceDirs: string[] = declaredWorkspaceDirs(root),
): TestFilePathResolution {
  const normalized: string[] = [];
  const siblings = independentWorkspaceCheckoutRoots(root);
  for (const file of files) {
    if (isAbsolute(file)) {
      normalized.push(file);
      continue;
    }

    const rootCandidate = resolve(root, file);
    if (isInsideRoot(root, rootCandidate) && existsSync(rootCandidate)) {
      normalized.push(file);
      continue;
    }

    const matches = workspaceDirs
      .map((dir) => resolve(root, dir, file))
      .filter((candidate) => isInsideRoot(root, candidate) && existsSync(candidate))
      .map((candidate) => relative(root, candidate).split(sep).join('/'));
    if (matches.length > 1) return { ok: false, path: file, matches };
    if (matches.length === 1) {
      normalized.push(matches[0]!);
      continue;
    }

    // Workspace-relative sibling checkout spelling (`portal/tests/foo.test.ts`).
    // Return the absolute file so checkoutRootForTestFiles can hand the complete
    // request to that repository's own router/config.  Keep the original spelling
    // only when no admitted sibling contains it.
    const first = file.replace(/\\/g, '/').split('/')[0];
    const siblingRoot = first ? siblings.get(first) : undefined;
    if (siblingRoot && file.length > first!.length + 1) {
      const siblingCandidate = resolve(siblingRoot, file.slice(first!.length + 1));
      if (isInsideRoot(siblingRoot, siblingCandidate) && existsSync(siblingCandidate)) {
        normalized.push(siblingCandidate);
        continue;
      }
    }
    normalized.push(file);
  }
  return { ok: true, files: normalized };
}

/**
 * Router exit codes. The contract is stated once in
 * `scripts/lib/test-file-exit-codes.mjs` and pinned by
 * `packages/operator-core/lib/__tests__/test-file-exit-codes.test.ts`:
 * 0 = measured pass, 1 = MEASURED and genuinely failed, 2 = NOT MEASURED
 * (route/launch/admission error, watchdog reap, or a refused false-green),
 * 75 = EX_TEMPFAIL, also not measured and explicitly retryable.
 *
 * This comment used to read "1 = a refused false-green OR a genuine test
 * failure", which was an accurate description of a broken router: four
 * refusals that measured NOTHING returned the same code as a real red, so this
 * consumer could not tell them apart and neither could an agent reading a log.
 * EI-21884126680256710 moved those refusals onto 2, which is what makes the
 * single-meaning reading above true. The literal stays local rather than
 * imported so operator-core's bundle does not take a dependency on `scripts/`;
 * the pin test is what keeps the two copies honest.
 */
const ROUTER_EXIT_ROUTE_ERROR = 2;

export type RouterNotMeasuredReason = 'admission-starved' | 'undetermined';

export interface RouterNotMeasuredMarker {
  requested: number;
  executed: number;
  matched: number;
  measuredFiles: 0;
  status: 'not-measured';
  reason: RouterNotMeasuredReason;
}

/** Resource reservation made for one resident router/Vitest process. */
export const TEST_PROCESS_DEFAULT_MEMORY_BYTES = 1024 * 1024 * 1024;
export const TEST_PROCESS_DEFAULT_DISK_BYTES = 256 * 1024 * 1024;
export const TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS = 16;
export const TEST_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS = 250;

export interface TestProcessAdmissionDemandOptions {
  /** Number of exact files in this process' group. */
  readonly fileCount?: number;
  /** Allow a caller with a measured workspace profile to tighten the estimate. */
  readonly memoryBytes?: number;
  readonly diskBytes?: number;
  readonly fileDescriptors?: number;
}

/**
 * Build the planned resource vector for a test process. The vector is a
 * reservation (not a host-wide semaphore): it gives the durable governor a
 * useful shape while the close path records the measured peak. Keep the
 * process/fd overhead explicit because a Vitest run includes the router,
 * worker pool, report files, and pipes in addition to the named test file.
 */
export function buildTestProcessDemand(
  options: TestProcessAdmissionDemandOptions = {},
): ResourceDemand {
  const fileCount = Number.isFinite(options.fileCount) ? Math.max(1, Math.floor(options.fileCount!)) : 1;
  const memoryBytes = Number.isFinite(options.memoryBytes) && options.memoryBytes! > 0
    ? Math.floor(options.memoryBytes!)
    : TEST_PROCESS_DEFAULT_MEMORY_BYTES;
  const diskBytes = Number.isFinite(options.diskBytes) && options.diskBytes! > 0
    ? Math.floor(options.diskBytes!)
    : TEST_PROCESS_DEFAULT_DISK_BYTES;
  const fileDescriptors = Number.isFinite(options.fileDescriptors) && options.fileDescriptors! > 0
    ? Math.floor(options.fileDescriptors!)
    : TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS + fileCount;
  return {
    // CPU weight is relative residency, so one router/Vitest process reserves
    // one unit regardless of how many exact files it batches.
    cpuWeight: 1,
    memoryBytes,
    diskBytes,
    fileDescriptors,
  };
}

export interface TestProcessResourceSnapshot {
  /** Aggregate user+system CPU time for the process tree, in microseconds. */
  readonly cpuMicros: number | null;
  /** Aggregate resident working set for the process tree, in bytes. */
  readonly rssBytes: number | null;
  /** Aggregate open descriptors for the process tree. */
  readonly fileDescriptors: number | null;
}

function parseProcField(text: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+([0-9]+)\\s*(?:kB)?$`, 'm').exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function procStatus(pid: number): { parentPid: number | null; rssBytes: number | null } | null {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    const parentRaw = parseProcField(text, 'PPid');
    const rssKb = parseProcField(text, 'VmHWM') ?? parseProcField(text, 'VmRSS');
    return {
      parentPid: parentRaw === null ? null : Math.floor(parentRaw),
      rssBytes: rssKb === null ? null : rssKb * 1024,
    };
  } catch {
    return null;
  }
}

function procCpuMicros(pid: number): number | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = text.lastIndexOf(')');
    if (endOfCommand < 0) return null;
    const fields = text.slice(endOfCommand + 2).trim().split(/\s+/);
    // After the comm/state fields, procfs exposes utime at index 11 and stime
    // at index 12. Linux's user HZ is normally 100; retain the raw tick scale
    // if a non-standard value cannot be discovered, since the sampler only
    // uses deltas to derive a relative cpuWeight.
    const user = Number(fields[11]);
    const system = Number(fields[12]);
    if (!Number.isFinite(user) || !Number.isFinite(system)) return null;
    return (user + system) * 10_000;
  } catch {
    return null;
  }
}

function processTreePids(rootPid: number): number[] {
  if (process.platform !== 'linux' || !Number.isInteger(rootPid) || rootPid <= 0) return [rootPid];
  const children = new Map<number, number[]>();
  let entries: Dirent<string>[];
  try {
    entries = readdirSync('/proc', { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [rootPid];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const status = procStatus(pid);
    if (status?.parentPid !== null && status?.parentPid !== undefined) {
      const siblings = children.get(status.parentPid) ?? [];
      siblings.push(pid);
      children.set(status.parentPid, siblings);
    }
  }
  const result = [rootPid];
  for (let index = 0; index < result.length; index += 1) {
    const descendants = children.get(result[index]) ?? [];
    for (const pid of descendants) if (!result.includes(pid)) result.push(pid);
  }
  return result;
}

/** Read a fail-soft aggregate snapshot for a child and its descendants. */
export function readTestProcessResourceSnapshot(pid: number): TestProcessResourceSnapshot {
  const pids = processTreePids(pid);
  let cpuMicros = 0;
  let rssBytes = 0;
  let fileDescriptors = 0;
  let cpuMeasured = false;
  let rssMeasured = false;
  let fdMeasured = false;
  for (const childPid of pids) {
    const cpu = procCpuMicros(childPid);
    if (cpu !== null) {
      cpuMicros += cpu;
      cpuMeasured = true;
    }
    const status = procStatus(childPid);
    if (status?.rssBytes !== null && status?.rssBytes !== undefined) {
      rssBytes += status.rssBytes;
      rssMeasured = true;
    }
    if (process.platform === 'linux') {
      try {
        fileDescriptors += readdirSync(`/proc/${childPid}/fd`).length;
        fdMeasured = true;
      } catch {
        /* process can exit between the status and fd reads */
      }
    }
  }
  return {
    cpuMicros: cpuMeasured ? cpuMicros : null,
    rssBytes: rssMeasured ? rssBytes : null,
    fileDescriptors: fdMeasured ? fileDescriptors : null,
  };
}

export interface TestProcessDemandSampler {
  attach(pid: number | null | undefined): void;
  sample(): void;
  stop(extra?: Partial<ResourceDemand>): ResourceDemand;
}

/**
 * Sample a process tree while it is alive and turn its peak observations into
 * an actual demand vector. The reader is injectable so lifecycle tests can
 * prove accounting without depending on Linux procfs; production falls back
 * to the planned vector when a platform hides a metric.
 */
export function createTestProcessDemandSampler(
  planned: ResourceDemand,
  readSnapshot: (pid: number) => TestProcessResourceSnapshot = readTestProcessResourceSnapshot,
  now: () => number = Date.now,
): TestProcessDemandSampler {
  let pid: number | null = null;
  let timer: ManagedHandle | null = null;
  let stopped = false;
  let peakRss: number | null = null;
  let peakFds: number | null = null;
  let firstCpu: number | null = null;
  let lastCpu: number | null = null;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let cpuWeight: number | null = null;
  let stoppedDemand: ResourceDemand | null = null;

  const sample = (): void => {
    if (stopped || pid === null) return;
    let snapshot: TestProcessResourceSnapshot;
    try {
      snapshot = readSnapshot(pid);
    } catch {
      return;
    }
    const at = now();
    if (snapshot.rssBytes !== null && Number.isFinite(snapshot.rssBytes)) {
      peakRss = peakRss === null ? snapshot.rssBytes : Math.max(peakRss, snapshot.rssBytes);
    }
    if (snapshot.fileDescriptors !== null && Number.isFinite(snapshot.fileDescriptors)) {
      peakFds = peakFds === null ? snapshot.fileDescriptors : Math.max(peakFds, snapshot.fileDescriptors);
    }
    if (snapshot.cpuMicros !== null && Number.isFinite(snapshot.cpuMicros)) {
      if (firstCpu === null) {
        firstCpu = snapshot.cpuMicros;
        firstAt = at;
      }
      lastCpu = snapshot.cpuMicros;
      lastAt = at;
      if (firstAt !== null && lastAt !== null && lastAt > firstAt && firstCpu !== null && lastCpu !== null) {
        // CPU weight is CPU-seconds per wall-second, a relative residency
        // measure rather than an asserted core count.
        cpuWeight = Math.max(0.01, (lastCpu - firstCpu) / ((lastAt - firstAt) * 1_000));
      }
    }
  };

  return {
    attach(nextPid: number | null | undefined): void {
      if (stopped || !Number.isInteger(nextPid) || (nextPid as number) <= 0) return;
      pid = nextPid as number;
      sample();
      // One sampler is armed per governed test process, so the timer is
      // `instanced` (each arm coexists and the inventory aggregates them into
      // one row). It is `must-sample`: procfs has no push source for a live
      // process's peak RSS/CPU, which is the actual-demand this governed
      // execution releases with.
      timer = managedSetInterval(
        'lifecycle:test-process-resource-sampler',
        TEST_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
        sample,
        { category: 'lifecycle', instanced: true, classification: 'must-sample' },
      );
    },
    sample,
    stop(extra = {}): ResourceDemand {
      if (stoppedDemand) return stoppedDemand;
      if (!stopped) sample();
      stopped = true;
      timer?.stop();
      timer = null;
      stoppedDemand = {
        cpuWeight: extra.cpuWeight ?? cpuWeight ?? planned.cpuWeight ?? 1,
        memoryBytes: extra.memoryBytes ?? peakRss ?? planned.memoryBytes,
        diskBytes: extra.diskBytes ?? planned.diskBytes,
        fileDescriptors: extra.fileDescriptors ?? peakFds ?? planned.fileDescriptors,
      };
      return stoppedDemand;
    },
  };
}

/** Public outcome shape used by the settlement classifier and focused tests. */
export interface TestProcessOutcome {
  readonly code: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError?: string;
  readonly output: string;
  readonly actualDemand?: ResourceDemand;
}

/**
 * A process that exited with a real code did run and may have produced a
 * legitimate red test report, so release its measured residency. A timeout,
 * caller abort, spawn error, or signal-only exit has no trustworthy verdict and
 * cancels the receipt; callers surface those as timeout/aborted/route errors,
 * never as green.
 */
export function classifyTestProcessOutcome(outcome: TestProcessOutcome): GovernedExecutionSettlement {
  if (outcome.timedOut) return { kind: 'cancel', reason: 'test process timed out before a verdict was produced' };
  if (outcome.aborted) return { kind: 'cancel', reason: 'test process was aborted before a verdict was produced' };
  if (outcome.spawnError) return { kind: 'cancel', reason: `test process spawn failed: ${outcome.spawnError}` };
  if (/TEST_FILE_WATCHDOG|TEST_FILE_ROUTE_ERROR|worker\s+(?:exited|crash)|TasksMax|SIG(?:TERM|KILL)/i.test(outcome.output)) {
    return { kind: 'cancel', reason: 'test worker/route exited without a trustworthy verdict' };
  }
  if (outcome.code === null || outcome.signal) {
    return {
      kind: 'cancel',
      reason: `test process exited without a trustworthy verdict (code=${outcome.code ?? 'null'} signal=${outcome.signal ?? 'none'})`,
    };
  }
  return { kind: 'release', actualDemand: outcome.actualDemand };
}

/** The distilled outcome of one runTestFilesCore invocation — either the bounded
 *  run payload (`ok` reflects the tests; counts always complete; no `error` field) or a
 *  typed refusal naming why nothing could be judged. Discriminate on `error`. */
export type TestFilesCoreResult =
  | ({ ok: boolean; runId: string; root: string; error?: undefined } & DistilledTestRun & {
        /** The router produced a complete verdict after this tool's foreground budget elapsed. */
        budgetExceeded?: boolean;
        /** The foreground budget that elapsed before the complete verdict was surfaced. */
        budgetMs?: number;
        /** Router-reported elapsed time for the completed test process, when available. */
        runElapsedMs?: number;
        failuresReturned?: number;
        failuresOmitted?: number;
        truncationNote?: string;
      })
  | {
      ok: false;
      runId: string;
      root: string;
      error:
        | 'invalid_root'
        | 'ambiguous_workspace_path'
        | 'aborted'
      | 'timeout'
      | 'route_error'
        | 'not_measured'
      | 'no_report'
        | 'name_filter_no_match'
        | 'all_tests_skipped';
      hint?: string;
      path?: string;
      matches?: string[];
      timeoutMs?: number;
      skipped?: number;
      files?: number;
      routerOutput?: string;
      detachedRunId?: string;
      /** Whether the detached run's durable snapshot landed before we advertised its id. */
      detachedDurable?: boolean;
      status?: 'not-measured';
      reason?: RouterNotMeasuredReason;
      requested?: number;
      executed?: number;
      matched?: number;
      measuredFiles?: 0;
  };

/**
 * EI-21909191824649521: a run that COLLECTED tests and executed NONE of them produced no
 * evidence — yet vitest exits 0, and the two fields a reader treats as the verdict (`ok:true`
 * and `failed:0`) both read as success while `skipped:N` sits below them, outranked.
 *
 * That is the SAME epistemic event as the two refusals on either side of it — a path matching
 * zero files (`route_error`) and a `testNamePattern` matching zero tests
 * (`name_filter_no_match`) — and it was the one case left passing. The exposed consumer is an
 * acceptance grader following a rubric drill that names an env-gated `*-live` suite: it gets
 * `ok:true` and credits a criterion on which zero assertions ever ran.
 *
 * Deliberately NARROW to the zero-executed case. A PARTIALLY skipped run produced real
 * evidence and keeps its current shape; and `skipped > 0` is required so this can never
 * swallow a genuinely empty router result, which `route_error` / `no_report` already own.
 */
function zeroExecutedRefusal(
  run: { passed: number; failed: number; skipped: number; files: number },
  ctx: { runId: string; root: string },
): TestFilesCoreResult | null {
  if (run.passed + run.failed > 0 || run.skipped <= 0) return null;
  return {
    ok: false,
    runId: ctx.runId,
    root: ctx.root,
    error: 'all_tests_skipped',
    skipped: run.skipped,
    files: run.files,
    hint:
      `all ${run.skipped} collected test(s) were SKIPPED and NONE executed, so NOTHING was ` +
      'verified — this is NOT a pass, and `failed: 0` here is not evidence. The file is ' +
      'typically env-gated (`describe.skipIf` / `it.skip`): set the suite\'s env var to actually ' +
      'run it, or record the check as NOT EXECUTED.',
  };
}

/** Read every JSON report written by one router invocation, preserving group order. */
async function readRunReportTexts(dir: string): Promise<string[]> {
  try {
    const names = (await readdir(dir))
      .filter((name) => name.endsWith('.json') && name !== TEST_FAILURE_DETAILS_FILENAME)
      .sort();
    return (await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8').catch(() => null)))).filter(
      (text): text is string => text !== null,
    );
  } catch {
    return [];
  }
}

/** Read the optional assertion-detail sidecar without making it a run prerequisite. */
async function readFailureDetails(path: string, root: string): Promise<ReturnType<typeof parseFailureDetailsSidecar>> {
  try {
    return parseFailureDetailsSidecar(await readFile(path, 'utf8'), root);
  } catch {
    return [];
  }
}

/**
 * A foreground budget can expire after the router has already finished the
 * tests and emitted its terminal marker, while the child process is still
 * closing or flushing its report. Prefer that completed evidence over a false
 * timeout, but recover only when the marker and the structured report agree.
 */
async function recoverCompletedRunAfterBudget(opts: {
  output: string;
  dir: string;
  root: string;
  runId: string;
  files: string[];
  timeoutMs: number;
  maxFailures?: number;
}): Promise<TestFilesCoreResult | null> {
  const terminal = parseRouterTerminalCompletion(opts.output);
  if (!terminal) return null;
  if (terminal.requested !== opts.files.length) return null;

  const reportTexts = await readRunReportTexts(opts.dir);
  let run: DistilledTestRun | null = null;
  if (reportTexts.length > 0) {
    const failureDetails = await readFailureDetails(join(opts.dir, TEST_FAILURE_DETAILS_FILENAME), opts.root);
    run = mergeDistilledRuns(
      reportTexts.map((text) => distillVitestRun(text, opts.root, { maxFailures: opts.maxFailures, failureDetails })),
      { maxFailures: opts.maxFailures },
    );
  } else {
    run = parseRouterTestResult(opts.output, opts.files, {
      ...(opts.maxFailures === undefined ? {} : { maxFailures: opts.maxFailures }),
    });
  }

  // The marker's executed count is the router's file count. If no report (or
  // parser summary) can corroborate that count, retain the conservative timeout.
  if (!run || run.files !== terminal.executed || run.passed + run.failed <= 0) return null;
  const reportFailed = run.failed > 0;
  if ((terminal.status === 'passed' && reportFailed) || (terminal.status === 'failed' && !reportFailed)) return null;

  return boundTestRunPayload(
    {
      ok: terminal.status === 'passed',
      runId: opts.runId,
      root: opts.root,
      budgetExceeded: true,
      budgetMs: opts.timeoutMs,
      ...(terminal.runElapsedMs === undefined ? {} : { runElapsedMs: terminal.runElapsedMs }),
    },
    run,
  ) as TestFilesCoreResult;
}

interface RouterOutcome extends TestProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  output: string;
  actualDemand?: ResourceDemand;
}

/** Spawn a bounded test process, capturing its diagnostics. */
function runTestProcess(
  command: string,
  commandArgs: string[],
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  fileCount = 1,
): Promise<RouterOutcome> {
  const runGroup = env.PAPERCUSP_TEST_RUN_GROUP ?? 'unattributed';
  const plannedDemand = buildTestProcessDemand({ fileCount });
  return runGovernedOperation(
    {
      workspaceId: activeWorkspaceId(),
      namespace: 'testing-run-process',
      owner: `testing:run:${runGroup}`,
      admissionClass: 'process',
      demand: plannedDemand,
      payloadRef: `testing:run:${runGroup}`,
      parent: admissionContextFromEnvironment(env.PAPERCUSP_ADMISSION_CONTEXT),
      leaseTtlMs: governedExecutionLeaseTtlForTimeout(timeoutMs),
      metadata: { command, timeoutMs, fileCount, processKind: 'test-run' },
      settle: (outcome) => classifyTestProcessOutcome(outcome),
    },
    async (admissionContext) => new Promise((resolve) => {
    let output = '';
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let settled = false;
    // EI-19324351741370770: `scripts/test-files.mjs` launches the REAL vitest run via
    // `spawnSync('npx', ['vitest', 'run', ...])` — synchronously, and WITHOUT its own
    // `detached: true` — so that vitest process inherits THIS process's process group
    // rather than becoming reparented on its own. Killing only `child` (the router) by
    // its own pid terminates the router but leaves vitest running as an ORPHAN: Unix
    // never cascade-kills a process's children just because the parent died. That
    // orphan then keeps executing (and holding forks) for the suite's real duration,
    // invisible to the caller, who was told `error:'timeout'` and reasonably assumes
    // nothing is still running. Following the tool's own "re-run it detached" hint then
    // launches a SECOND concurrent run of the same suite.
    //
    // Fix: spawn the router `detached: true` so it becomes the leader of a NEW process
    // group (pgid === its own pid); vitest, spawned without its own `detached`, inherits
    // THAT group. On timeout, signal the NEGATIVE pid — killing the whole process group,
    // router and every child/grandchild it spawned — instead of just the router itself.
    const sampler = createTestProcessDemandSampler(plannedDemand);
    let child: ChildProcess;
    try {
      child = spawn(command, [...commandArgs, ...args], {
        cwd,
        env: { ...env, PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(admissionContext) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError,
        output: `[spawn-error] ${spawnError}`,
        actualDemand: sampler.stop({ diskBytes: 0 }),
      });
      return;
    }
    sampler.attach(child.pid);
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone, or (non-POSIX) negative-pid kill unsupported — fall back
        // to at least killing the router itself so we never silently no-op.
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    const killGroupWithFallback = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroupWithFallback();
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      // code:run owns the signal passed to inner dispatches. If its worker deadline
      // fires while this router is blocked in spawnSync-backed Vitest, the router must
      // terminate the same process group as its own timeout path; otherwise the inner
      // suite survives after the outer wrapper has returned (EI-20949515346526475).
      killGroupWithFallback();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    // Cap retained diagnostics — the router's own output is a fallback for the
    // error paths, never the success path's payload.
    const append = (b: Buffer) => {
      outputBytes += b.byteLength;
      output = (output + b.toString('utf8')).slice(-8192);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const finish = (outcome: Omit<RouterOutcome, 'actualDemand'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        ...outcome,
        actualDemand: sampler.stop({ diskBytes: outputBytes }),
      });
    };
    child.on('error', (e) => {
      spawnError = e.message;
      finish({ code: null, signal: null, timedOut, aborted, spawnError, output: `${output}\n[spawn-error] ${e.message}` });
    });
    child.on('close', (code, closeSignal) => finish({
      code,
      signal: closeSignal ?? null,
      timedOut,
      aborted,
      output,
    }));
    }),
  );
}

/** Spawn the Papercusp router, preserving its owning-workspace guarantees. */
function runRouter(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  fileCount = 1,
): Promise<RouterOutcome> {
  return runTestProcess(
    process.execPath,
    [join(cwd, 'scripts', 'test-files.mjs')],
    args,
    cwd,
    env,
    timeoutMs,
    signal,
    fileCount,
  );
}

/** Spawn a generic external Vitest checkout through its local npm installation. */
function runDirectVitest(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  fileCount = 1,
): Promise<RouterOutcome> {
  return runTestProcess(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--no-install', 'vitest'],
    args,
    cwd,
    env,
    timeoutMs,
    signal,
    fileCount,
  );
}

export interface DirectVitestRouteGroup {
  /** The declared npm workspace that owns these files (or the checkout root). */
  cwd: string;
  /** Layer-specific config, relative to cwd. Omitted to let Vitest/Vite discover the workspace default. */
  config?: string;
  /** Exact file filters, relative to cwd. */
  files: string[];
}

/**
 * Parse the router's terminal report when the selected runner does not emit a
 * Vitest JSON report. `scripts/test-files.mjs` uses this path for registered
 * `node:test` files (for example `papercusp-desktop/test/*.test.js`): it emits
 * the stamped `TEST_FILE_RESULT` marker plus Node's numeric summary, but
 * `--reporter=json --outputFile` is not meaningful to Node's test runner.
 *
 * Keep this parser strict. A marker without a non-zero test summary is not
 * enough to establish that tests actually ran, so the caller retains its
 * existing `no_report` refusal in that case.
 */
export function parseRouterTestResult(
  output: string,
  files: readonly string[] = [],
  opts: { maxFailures?: number } = {},
): DistilledTestRun | null {
  const markerRe = /^TEST_FILE_RESULT\s+requested=(\d+)\s+executed=(\d+)\s+matched=(\d+)\s+status=(passed|failed)\b[^\r\n]*$/gm;
  let marker: RegExpExecArray | null = null;
  for (const match of output.matchAll(markerRe)) marker = match;
  if (!marker) return null;

  const requested = Number(marker[1]);
  const executed = Number(marker[2]);
  const matched = Number(marker[3]);
  const status = marker[4];
  if (
    !Number.isSafeInteger(requested) ||
    !Number.isSafeInteger(executed) ||
    !Number.isSafeInteger(matched) ||
    requested < 1 ||
    executed < 1 ||
    matched !== requested ||
    executed !== matched
  ) {
    return null;
  }

  const summaryValue = (label: string): number | null => {
    const re = new RegExp(`^\\s*(?:ℹ|#)?\\s*${label}\\s+(\\d+)\\s*$`, 'gm');
    let value: number | null = null;
    for (const match of output.matchAll(re)) value = Number(match[1]);
    return value !== null && Number.isSafeInteger(value) ? value : null;
  };
  const tests = summaryValue('tests');
  const passed = summaryValue('pass');
  const reportedFailed = summaryValue('fail');
  if (tests === null || passed === null || reportedFailed === null || tests < 1) return null;

  const skipped =
    (summaryValue('skipped') ?? 0) +
    (summaryValue('todo') ?? 0) +
    (summaryValue('cancelled') ?? 0);
  const durationMatch = /^(?:\s*)(?:ℹ|#)?\s*duration_ms\s+([0-9]+(?:\.[0-9]+)?)\s*$/gm;
  let durationMs: number | null = null;
  for (const match of output.matchAll(durationMatch)) durationMs = Math.max(0, Math.round(Number(match[1])));

  const failed = Math.max(reportedFailed, status === 'failed' ? 1 : 0);
  const maxFailures = Math.max(1, Math.floor(opts.maxFailures ?? 20));
  const failureFile = files.length === 1 ? files[0]! : '(node:test failure)';
  const failureNames = [...output.matchAll(/^\s*not ok(?:\s+\d+)?\s+-\s+([^\r\n]+)$/gm)].map((m) => m[1]!.trim());
  const failures = failureNames.slice(0, maxFailures).map((test) => ({
    file: failureFile,
    test: test || '(unnamed node:test failure)',
    message: 'node:test reported a failure; structured Vitest failure details are unavailable for this runner.',
  }));
  if (failed > 0 && failures.length === 0) {
    failures.push({
      file: failureFile,
      test: '(node:test failure details unavailable)',
      message: `node:test reported ${failed} failed test(s); structured failure details were not emitted.`,
    });
  }

  const byFile =
    files.length === 1 && executed === 1
      ? { [files[0]!]: { passed, failed, skipped, collectionFailed: false } }
      : {};
  return {
    passed,
    failed,
    skipped,
    files: executed,
    failures,
    failuresTruncated: failureNames.length > maxFailures,
    durationMs,
    byFile,
  };
}

/**
 * Parse the router's terminal progress + verdict pair. This is intentionally
 * separate from parseRouterTestResult: Vitest writes its structured report to
 * the private report file, so its stdout has no `tests`/`pass` summary for that
 * parser to consume. The pair is still enough to prove that the router reached
 * a terminal, zero-exit state after this tool's foreground budget elapsed.
 */
export interface RouterTerminalCompletion {
  requested: number;
  executed: number;
  matched: number;
  status: 'passed' | 'failed';
  runElapsedMs?: number;
}

export function parseRouterTerminalCompletion(output: string): RouterTerminalCompletion | null {
  const markerRe =
    /^TEST_FILE_RESULT\s+requested=(\d+)\s+executed=(\d+)\s+matched=(\d+)\s+status=(passed|failed)\b[^\r\n]*$/gm;
  let marker: RegExpExecArray | null = null;
  for (const match of output.matchAll(markerRe)) marker = match;
  if (!marker) return null;

  const requested = Number(marker[1]);
  const executed = Number(marker[2]);
  const matched = Number(marker[3]);
  if (
    ![requested, executed, matched].every(Number.isSafeInteger) ||
    requested < 1 ||
    executed < 1 ||
    matched !== requested ||
    executed !== matched
  ) {
    return null;
  }

  let finishedLine: string | null = null;
  for (const match of output.matchAll(/^TEST_FILE_PROGRESS[^\r\n]*$/gm)) {
    const line = match[0];
    if (
      /\bstate=finished\b/.test(line) &&
      /\bexitStatus=0\b/.test(line) &&
      /\bsignal=none\b/.test(line)
    ) {
      finishedLine = line;
    }
  }
  if (!finishedLine) return null;

  const elapsedMatch = finishedLine.match(/\belapsedMs=(\d+)\b/);
  const runElapsedMs = elapsedMatch ? Number(elapsedMatch[1]) : undefined;
  if (runElapsedMs !== undefined && (!Number.isSafeInteger(runElapsedMs) || runElapsedMs < 0)) return null;

  return {
    requested,
    executed,
    matched,
    status: marker[4] as RouterTerminalCompletion['status'],
    ...(runElapsedMs === undefined ? {} : { runElapsedMs }),
  };
}

/**
 * Parse the router's typed NOT-MEASURED terminal marker.
 *
 * A governed admission refusal exits with the same reserved code as an ordinary
 * route refusal, so the marker is the only safe discriminator at this layer.
 * Keep this parser strict: malformed numbers, non-zero measuredFiles, unknown
 * reasons, or a different status must fall through to the existing route_error
 * result rather than being treated as a typed admission refusal.
 */
export function parseRouterNotMeasuredMarker(output: string): RouterNotMeasuredMarker | null {
  const markerRe =
    /^TEST_FILE_NOT_MEASURED\s+requested=(\d+)\s+executed=(\d+)\s+matched=(\d+)\s+measuredFiles=(\d+)\s+status=(not-measured)\s+reason=(admission-starved|undetermined)(?:\s+—.*)?$/gm;
  let marker: RegExpExecArray | null = null;
  for (const match of output.matchAll(markerRe)) marker = match;
  if (!marker) return null;

  const requested = Number(marker[1]);
  const executed = Number(marker[2]);
  const matched = Number(marker[3]);
  const measuredFiles = Number(marker[4]);
  if (
    ![requested, executed, matched, measuredFiles].every(Number.isSafeInteger) ||
    requested < 1 ||
    executed < 0 ||
    matched < 0 ||
    matched > requested ||
    executed > matched ||
    measuredFiles !== 0
  ) {
    return null;
  }
  return {
    requested,
    executed,
    matched,
    measuredFiles: 0,
    status: 'not-measured',
    reason: marker[6] as RouterNotMeasuredReason,
  };
}

const VITEST_LAYER_CONFIGS = {
  integration: [
    'vitest.integration.config.ts',
    'vitest.integration.config.mts',
    'vitest.integration.config.cts',
    'vitest.integration.config.js',
    'vitest.integration.config.mjs',
    'vitest.integration.config.cjs',
  ],
  browser: [
    'vitest.browser.config.ts',
    'vitest.browser.config.mts',
    'vitest.browser.config.cts',
    'vitest.browser.config.js',
    'vitest.browser.config.mjs',
    'vitest.browser.config.cjs',
  ],
} as const;

function directVitestLayerConfig(file: string, workspaceRoot: string, checkoutRoot: string): string | undefined {
  const layer = /\.browser\.test\.[cm]?[jt]sx?$/i.test(file)
    ? 'browser'
    : /\.integration\.test\.[cm]?[jt]sx?$/i.test(file)
      ? 'integration'
      : null;
  if (layer === null) return undefined;

  let dir = workspaceRoot;
  while (isInsideRoot(checkoutRoot, dir)) {
    for (const name of VITEST_LAYER_CONFIGS[layer]) {
      if (existsSync(join(dir, name))) return relative(workspaceRoot, join(dir, name)).split(sep).join('/');
    }
    if (resolve(dir) === resolve(checkoutRoot)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Route a generic external Vitest checkout at the same OWNERSHIP grain as npm workspaces.
 *
 * Papercusp checkouts use scripts/test-files.mjs. Managed Hive repositories often do not,
 * so the old fallback ran every requested file from the repository root. In a project-style
 * Vitest config that eagerly loads every child config, one explicit layered filename then
 * poisons unrelated unit configs before the owning workspace can run it (EI-21414388102126733).
 * Running from the nearest declared workspace preserves its Vite environment and confines
 * config discovery; an available integration/browser config is selected explicitly.
 */
export function groupDirectVitestRoutes(
  files: string[],
  root: string,
  workspaceDirs: string[] = declaredWorkspaceDirs(root),
): DirectVitestRouteGroup[] {
  const groups = new Map<string, DirectVitestRouteGroup>();
  const workspaceRoots = workspaceDirs.map((dir) => resolve(root, dir)).sort((a, b) => b.length - a.length);

  for (const file of files) {
    const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
    const cwd = workspaceRoots.find((candidate) => isInsideRoot(candidate, absolute)) ?? root;
    const requested = relative(cwd, absolute).split(sep).join('/');
    const config = directVitestLayerConfig(requested, cwd, root);
    const key = `${cwd}\0${config ?? ''}`;
    const group = groups.get(key) ?? { cwd, ...(config ? { config } : {}), files: [] };
    group.files.push(requested);
    groups.set(key, group);
  }

  return [...groups.values()];
}

/**
 * The whole run, callable OUTSIDE the MCP handler (P-011 / D-006: scorecards:emit runs
 * a criterion's structured tests-check through this exact path, so a grading-time run
 * and a testing:run judge files identically — one router, one distillation, one set of
 * refusals). The handler below is now a thin wrapper: ctx root resolution + the
 * foreground transport clamp stay THERE (they are transport concerns, not run
 * concerns); everything else lives here.
 */
export async function runTestFilesCore(opts: {
  files: string[];
  root: string;
  timeoutMs?: number;
  maxFailures?: number;
  testNamePattern?: string;
  signal?: AbortSignal;
  /** Request scope to stamp on the reporter's durable test-run rows. */
  workspaceId?: string;
  harnessSlug?: string;
}): Promise<TestFilesCoreResult> {
  // Normalize once before selecting the checkout.  A workspace-relative sibling
  // spelling (for example `portal/tests/foo.test.ts`) becomes an absolute path in
  // normalizeTestFilePaths; selecting from that result lets the router switch to
  // the sibling checkout's own Vitest config instead of trying to run the path from
  // the ambient Papercusp tree.
  const requestedPaths = normalizeTestFilePaths(opts.files, opts.root);
  const root = checkoutRootForTestFiles(
    requestedPaths.ok ? requestedPaths.files : opts.files,
    opts.root,
  );
  const runId = randomUUID();

  // WI-7189 / EI-19383071792758676: a wrong-tree resolution used to be SILENT —
  // a file that happens to exist (with stale content) at the resolved root ran
  // and returned a confident, plausible, WRONG green. `root` is echoed on EVERY
  // return path so a wrong-tree run is visible instead of silent. One loud
  // pre-flight refusal catches what the router's own check can't: a root that
  // isn't a papercusp checkout AT ALL (missing the router script itself) or a
  // known npm-workspace Vitest checkout.
  const hasRouter = existsSync(join(root, 'scripts', 'test-files.mjs'));
  if (!hasRouter && !isVitestCheckoutRoot(root)) {
    return {
      ok: false,
      runId,
      root,
      error: 'invalid_root',
      hint:
        `resolved workspace root '${root}' has no scripts/test-files.mjs or runnable Vitest workspace — ` +
        `it is not a supported checkout (or is a stale/partial one). This usually means the calling session is scoped to ` +
        `the wrong harness/tree (e.g. a legacy standalone clone) rather than the canonical staging ` +
        `checkout. Verify with 'pwd'/'git remote -v' in the tree you intend, and re-check how this ` +
        `session's harness/project is registered.`,
    };
  }
  const pathResolution = normalizeTestFilePaths(
    requestedPaths.ok ? requestedPaths.files : opts.files,
    root,
  );
  if (!pathResolution.ok) {
    return {
      ok: false,
      runId,
      root,
      error: 'ambiguous_workspace_path',
      path: pathResolution.path,
      matches: pathResolution.matches,
      hint:
        `workspace-relative test path ${JSON.stringify(pathResolution.path)} exists in multiple declared ` +
        `workspaces (${pathResolution.matches.join(', ')}). Re-run with a repo-root-relative or absolute path.`,
    };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ingestLedgerInProcess =
    Boolean(opts.workspaceId && opts.harnessSlug) && shouldIngestVitestLedgerInProcess(root);
  const ledgerWorktreeBefore = ingestLedgerInProcess ? captureWorktreeSnapshot(root) : null;

  // EI-21051590601555185: this tool runs inside the long-lived operator process, so it does not
  // pass through scripts/test-files.mjs before creating its private report directory. Apply the
  // same headroom-aware, papercusp-owned TMPDIR policy here; otherwise an exhausted/shared /tmp
  // fails at this mkdtemp call before the router can report a structured result.
  ensurePapercuspTmpdir();
  const dir = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-'));
  const reportPath = join(dir, 'report.json');
  const failureDetailsPath = join(dir, TEST_FAILURE_DETAILS_FILENAME);
  try {
    const vitestArgs = ['--reporter=json', `--outputFile=${reportPath}`];
    // Vitest treats an explicit --reporter as a replacement for the reporters declared by
    // the workspace config. Keep the admin ledger reporter in the same invocation, otherwise
    // testing:run returns correct counts but silently records no harness_shared.test_runs rows.
    const adminReporterPath = join(root, ADMIN_TEST_RUNS_REPORTER_RELATIVE_PATH);
    if (existsSync(adminReporterPath)) vitestArgs.push(`--reporter=${adminReporterPath}`);
    // WI-39830: the JOINED form, never `['-t', pattern]`. Split across two argv entries,
    // vitest's CAC parser reads any `-`-prefixed pattern as a new OPTION instead of as `-t`'s
    // value and dies with an opaque CACError — which makes every test in this repo whose name
    // starts with `--` (lint-tsc.test.ts, mutation-probe-script.test.ts, …) unrunnable by name.
    // The router normalizes this too, so the two agree; emitting it correctly here keeps the
    // tool's own contract from depending on a repair one layer down.
    if (opts.testNamePattern) vitestArgs.push(`--testNamePattern=${opts.testNamePattern}`);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PAPERCUSP_TEST_RUN_GROUP: runId,
      PAPERCUSP_TEST_ATTRIBUTION: '1',
      PAPERCUSP_TEST_FAILURE_DETAILS_PATH: failureDetailsPath,
      ...(opts.harnessSlug && opts.harnessSlug !== '*'
        ? { PAPERCUSP_TEST_RUN_HARNESS: opts.harnessSlug }
        : {}),
      ...(opts.workspaceId && opts.workspaceId !== '*'
        ? { PAPERCUSP_WORKSPACE_ID: opts.workspaceId }
        : {}),
    };
    // `testing:run` can itself be invoked from the repository's pc-heavy
    // wrapper. That wrapper exports a one-shot readiness/finalization marker
    // for its direct child; forwarding those exact paths into this nested
    // router makes it try to publish into the already-owned marker and fail
    // with EEXIST. The nested run owns no outer barrier, so scrub the paths
    // before spawning its router (the sidecar and test-run group remain local
    // to this invocation).
    delete childEnv.PC_HEAVY_PREEMPT_READY_FILE;
    delete childEnv.PC_HEAVY_PSI_FINALIZATION_FILE;
    let directReportPaths: string[] | null = null;
    let outcome: RouterOutcome;
    if (hasRouter) {
      outcome = await runRouter(
        [...pathResolution.files, '--', ...vitestArgs],
        root,
        // The reporter inside the child reads this and stamps run_group_id, so
        // the run's per-file rows are findable afterwards. We write no rows here.
        //
        // P-004: arm coverage attribution for the same child. Stamped unconditionally even
        // though a unit fork cannot use it — the fork disarms itself off the no-real-pg rail
        // (see attribution/context.ts), which is a decision only the fork can make correctly,
        // because one `files` array routinely spans both layers.
        childEnv,
        timeoutMs,
        opts.signal,
        pathResolution.files.length,
      );
    } else {
      const groups = groupDirectVitestRoutes(pathResolution.files, root);
      directReportPaths = groups.map((_, index) => (index === 0 ? reportPath : join(dir, `report.${index}.json`)));
      const deadline = Date.now() + timeoutMs;
      const outcomes: RouterOutcome[] = [];
      for (const [index, group] of groups.entries()) {
        if (opts.signal?.aborted) {
          outcomes.push({
            code: null,
            signal: null,
            timedOut: false,
            aborted: true,
            output: 'caller aborted before direct Vitest group start',
          });
          break;
        }
        const remaining = Math.max(1000, deadline - Date.now());
        const groupArgs = [
          'run',
          ...(group.config ? ['--config', group.config] : []),
          ...vitestArgs.map((arg) =>
            arg.startsWith('--outputFile=') ? `--outputFile=${directReportPaths?.[index] ?? reportPath}` : arg,
          ),
          ...group.files,
        ];
        const groupOutcome = await runDirectVitest(
          groupArgs,
          group.cwd,
          childEnv,
          remaining,
          opts.signal,
          group.files.length,
        );
        outcomes.push(groupOutcome);
        if (groupOutcome.timedOut || groupOutcome.aborted) break;
      }
      outcome = {
        code: outcomes.some((entry) => entry.code === null) ? null : outcomes.some((entry) => entry.code !== 0) ? 1 : 0,
        signal: outcomes.find((entry) => entry.signal)?.signal ?? null,
        timedOut: outcomes.some((entry) => entry.timedOut),
        aborted: outcomes.some((entry) => entry.aborted),
        output: outcomes
          .map((entry) => entry.output)
          .join('\n')
          .slice(-8192),
      };
    }

    if (outcome.aborted) {
      return {
        ok: false,
        runId,
        root,
        error: 'aborted',
        hint: 'the caller canceled this foreground test run; its router/Vitest process group was terminated',
        routerOutput: outcome.output.slice(-2000),
      };
    }
    if (outcome.timedOut) {
      const completed = await recoverCompletedRunAfterBudget({
        output: outcome.output,
        dir,
        root,
        runId,
        files: pathResolution.files,
        timeoutMs,
        ...(opts.maxFailures === undefined ? {} : { maxFailures: opts.maxFailures }),
      });
      if (completed) return completed;

      // The foreground process group has already been terminated by
      // runTestProcess. Start a NEW, independently pollable store run for the
      // same router request rather than asking the caller to reconstruct it via
      // a second orchestration surface. `startRun` owns a distinct run id and
      // creates a detached process group of its own. External generic Vitest
      // checkouts have no scripts/test-files.mjs route, so they retain the
      // existing explicit recovery hint until that route can be represented as
      // one store run.
      const detachedStart = hasRouter
        ? await startRunDurable(
            buildDetachedTestRunRequest({
              root,
              files: pathResolution.files,
              ...(opts.testNamePattern !== undefined ? { testNamePattern: opts.testNamePattern } : {}),
            }),
          )
        : undefined;
      const detachedSnapshot = detachedStart?.snapshot;
      const detachedDurable = detachedStart?.durable === true;
      const detachedRunId = detachedSnapshot?.runId;
      return {
        ok: false,
        runId,
        root,
        error: 'timeout',
        timeoutMs,
        hint: `hit the ${(timeoutMs / 1000).toFixed(0)}s budget. ` +
          detachedRecoveryHint({ runId: detachedRunId, durable: detachedDurable }) +
          detachedTestTimeoutHint(opts.files),
        routerOutput: outcome.output.slice(-2000),
        ...(detachedRunId ? { detachedRunId, detachedDurable } : {}),
      };
    }
    // A typed router refusal is still exit 2, but its strict marker distinguishes
    // governed admission starvation from an ordinary route/launch error. Parse
    // only the reserved exit code so a test's arbitrary output cannot manufacture
    // a not-measured result on a successful run.
    if (outcome.code === ROUTER_EXIT_ROUTE_ERROR) {
      const notMeasured = parseRouterNotMeasuredMarker(outcome.output);
      if (notMeasured) {
        return {
          ok: false,
          runId,
          root,
          error: 'not_measured',
          ...notMeasured,
          routerOutput: outcome.output.slice(-2000),
        };
      }
    }
    // Name-filter and all-skipped refusals intentionally retain their report so
    // the typed branches below can explain the vacuous run. Every other exit-2
    // result has no trustworthy report and remains the existing route_error.
    const hasReportBackedRefusal = /^(?:TEST_FILE_NAME_FILTER_NO_MATCH|TEST_FILE_ALL_SKIPPED)\b/m.test(
      outcome.output,
    );
    if (
      (outcome.code === ROUTER_EXIT_ROUTE_ERROR && !hasReportBackedRefusal) ||
      outcome.code === null
    ) {
      return { ok: false, runId, root, error: 'route_error', routerOutput: outcome.output.slice(-2000) };
    }

    // EI-18822211427354845: the router runs ONE `vitest run` per owning workspace
    // config, so a request spanning several workspaces writes SEVERAL reports —
    // `report.json`, `report.0.json`, `report.1.json`, … Reading only `reportPath`
    // distilled whichever group happened to write last and reported it as the whole
    // run: a two-workspace request with a RED first group returned `failed:0,
    // failures:[]`. `dir` is a private mkdtemp this function owns, so every *.json in
    // it belongs to THIS run and can be merged without any output parsing.
    if (directReportPaths?.some((path) => !existsSync(path))) {
      return {
        ok: false,
        runId,
        root,
        error: 'no_report',
        routerOutput: outcome.output.slice(-2000),
      };
    }

    let reportTexts: string[];
    try {
      const names = (await readdir(dir))
        .filter((n) => n.endsWith('.json') && n !== TEST_FAILURE_DETAILS_FILENAME)
        .sort();
      reportTexts = (await Promise.all(names.map((n) => readFile(join(dir, n), 'utf8').catch(() => null)))).filter(
        (t): t is string => t !== null,
      );
    } catch {
      reportTexts = [];
    }
    if (reportTexts.length === 0) {
      // Registered node:test files run through scripts/test-files.mjs and do
      // not produce Vitest's JSON report. Their terminal TEST_FILE_RESULT
      // plus Node's numeric summary is still a complete, structured verdict;
      // use it before treating the missing JSON file as a false-green refusal.
      const routerResult = parseRouterTestResult(outcome.output, pathResolution.files, {
        ...(opts.maxFailures !== undefined ? { maxFailures: opts.maxFailures } : {}),
      });
      if (routerResult) {
        const executedNothing = zeroExecutedRefusal(routerResult, { runId, root });
        if (executedNothing) return executedNothing;
        return boundTestRunPayload({ ok: routerResult.failed === 0 && outcome.code === 0, runId, root }, routerResult) as TestFilesCoreResult;
      }
      // Exit 1 with no report is the REFUSED false-green (the router bailed
      // before running anything) — the one case where "no results" is the
      // answer, and must never read as a pass.
      return { ok: false, runId, root, error: 'no_report', routerOutput: outcome.output.slice(-2000) };
    }

    let failureDetails = [] as ReturnType<typeof parseFailureDetailsSidecar>;
    try {
      failureDetails = parseFailureDetailsSidecar(await readFile(failureDetailsPath, 'utf8'), root);
    } catch {
      // The sidecar is optional and fail-soft; JSON reports remain authoritative.
    }

    const run = mergeDistilledRuns(
      reportTexts.map((text) => distillVitestRun(text, root, { maxFailures: opts.maxFailures, failureDetails })),
      { maxFailures: opts.maxFailures },
    );

    // External Vitest checkouts have no Papercusp reporter to write the
    // workspace-scoped execution ledger. Reuse the Tests-tab ingestion
    // primitives over the exact JSON reports we already distilled; the write
    // happens in the operator process, where the database handle is known, and
    // only when no child reporter exists so a managed checkout cannot double-
    // record the same run group.
    if (ingestLedgerInProcess && ledgerWorktreeBefore && opts.workspaceId && opts.harnessSlug) {
      const ledgerWorktreeAfter = captureWorktreeSnapshot(root);
      const rows = reportTexts.flatMap((text) => parseVitestJsonForHarnessRows(text, root));
      await persistHarnessTestRuns({
        harnessSlug: opts.harnessSlug,
        workspaceId: opts.workspaceId,
        rows,
        runGroupId: runId,
        source: 'local',
        commit: ledgerWorktreeAfter.commit,
        worktreeDirty: computeWorktreeDirty(ledgerWorktreeBefore, ledgerWorktreeAfter),
      });
    }

    // EI-19425177453558152: a `testNamePattern` matching ZERO tests measured NOTHING, yet every
    // test is merely SKIPPED and vitest exits 0 — so this used to return a green.
    //
    // The router carries its own refusal for this, but it reads vitest's `Tests` summary row
    // from stdout and THIS path always passes `--reporter=json`, so no such row exists and the
    // router's check correctly fails open. That is why the check is repeated here rather than
    // delegated: at this layer the distilled report gives an EXACT executed count, which is a
    // strictly better signal than any output parse. (Measured: with only the router's check,
    // this path still returned ok:true.)
    //
    // `skipped` is deliberately not required to be > 0 — the point is that nothing RAN.
    if (opts.testNamePattern && run.passed + run.failed === 0) {
      return {
        ok: false,
        runId,
        root,
        error: 'name_filter_no_match',
        skipped: run.skipped,
        files: run.files,
        hint:
          `testNamePattern ${JSON.stringify(opts.testNamePattern)} matched ZERO tests, so NOTHING was ` +
          `verified — this is NOT a pass (${run.skipped} test(s) were collected and skipped). The pattern ` +
          "matches a test's FULL name — every enclosing `describe` joined to the `it` text — so a fragment " +
          'of either matches, but a typo or a stale name matches nothing. Re-run without testNamePattern to ' +
          'see the real test names.',
      };
    }
    // The same vacuous-run class as the refusal above, arrived at WITHOUT a name filter:
    // every collected test was skipped (an env-gated suite whose variable is unset), so this
    // run executed nothing. See zeroExecutedRefusal.
    const executedNothing = zeroExecutedRefusal(run, { runId, root });
    if (executedNothing) return executedNothing;

    // D-062: bound the payload in BYTES, not entries. `maxFailures` caps the
    // LIST COUNT and so cannot bound bytes at all — one long assertion diff
    // outweighs fifty terse failures. Counts stay complete and a cut is stated
    // explicitly, so `failures.length` is never readable as "how many failed".
    return boundTestRunPayload({ ok: run.failed === 0 && outcome.code === 0, runId, root }, run) as TestFilesCoreResult;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  }
}

export default defineTool({
  name: 'testing:run',
  description:
    'Run exact Vitest files through the Papercusp router or a discovered external npm-workspace Vitest checkout and return distilled counts plus bounded failures. Files may be repo-root-relative, absolute, or relative to exactly one declared npm workspace; ambiguous workspace-relative paths refuse before execution. `root` reports the checkout actually tested. Zero/partial matches and invalid checkouts refuse instead of passing vacuously. `failed` is the true total; when `failuresTruncated` is set, read `failuresOmitted`. A Papercusp-router timeout starts a pollable detached recovery, returns `detachedRunId`, and tells you to call `testing:run-status { runId }` for its snapshot. Stamps PAPERCUSP_TEST_RUN_GROUP for ledger correlation.',
  guidance: {
    when: 'You edited code and want to know whether specific test files pass, and which tests failed and why. The default way to run named test files.',
    notWhen:
      'Running everything your edits affected (use `npm run test:affected` — not covered here), a non-Vitest suite (cargo/playwright), or when you genuinely need raw reporter output.',
    chaining:
      'testing:run → a red here is real (the router refuses false-greens); testing:flakiness { } on a failing file tells you whether it is a known flake before you treat it as your regression.',
  },
  capability: 'testing:run',
  requirePrincipal: false,
  // EI-18803497769946984: the handler shells out to Vitest and blocks for the whole
  // run without ever reading `ctx.tx`. Holding the ambient workspace transaction
  // across that wait trips idle_in_transaction_session_timeout (60s), surfacing as a
  // bare `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  // Acceptance judges must independently reproduce rubric checks before emitting a
  // verdict. The dedicated capability grant stays inert for every other tool.
  agentRoles: [...AGENT_ROLES, 'judge'],
  args: z.object({
    files: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Test file paths (repo-root-relative, absolute, or relative to exactly one declared npm workspace). Each is routed to its owning workspace + Vitest config; ambiguous workspace-relative paths and paths matching zero tests fail the call rather than passing vacuously.',
      ),
    changedPaths: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .optional()
      .describe(
        'SOURCE paths you edited (not test files) — returns the `npm run test:affected` PLAN and runs NOTHING (`mode:"plan"`, no pass/fail counts). ~0.4s, no admission ticket, where the real sweep can queue for minutes and be SIGTERMed having measured zero files. Gives the affected workspaces, each exact runnable task command, and the attached guards, so you can pick: run specific test files via `files`, run one `taskCommands[].command` verbatim, or accept the queue. Mutually exclusive with `files`.',
      ),
    testNamePattern: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Run only tests whose full name matches (Vitest `-t`). Use to re-run ONE failing test from a previous result's `failures[].test`. A pattern matching ZERO tests is REFUSED (`name_filter_no_match`), never reported as a pass — vitest merely skips them all and exits 0.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Hard budget for the whole run. Default ${DEFAULT_TIMEOUT_MS}ms, but a FOREGROUND run is clamped to ${FOREGROUND_TIMEOUT_CEILING_MS}ms — below the ~55s MCP transport cap — so a slow suite returns an actionable timeout instead of an opaque transport error. For a longer suite, follow the timeout response's detached recovery; integration files use the npm run test:file router.`,
      ),
    maxFailures: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        `Cap the returned failures list (default 20). Counts stay complete; \`failuresTruncated\` flags the cut. Note this caps the LIST COUNT, not bytes — the result is separately bounded to ${TESTING_RUN_MAX_PAYLOAD_BYTES} B, which is what actually limits a run with huge assertion diffs.`,
      ),
  }),
  async handler(args, ctx) {
    // Exactly one selector. Both branches REFUSE rather than defaulting, because every
    // default here is a silent wrong answer: picking `files` when both were sent would
    // ignore a radius the caller asked to see, and treating neither as "run everything"
    // is the zero/partial-match false-green this whole tool exists to refuse.
    const wantsPlan = args.changedPaths !== undefined;
    if (wantsPlan && args.files !== undefined) {
      return {
        data: {
          ok: false,
          error: 'mutually_exclusive_selectors',
          detail:
            'Pass `files` (run exact test files) OR `changedPaths` (derive the test:affected plan; runs nothing), never both.',
        },
      };
    }
    if (!wantsPlan && args.files === undefined) {
      return {
        data: {
          ok: false,
          error: 'no_selector',
          detail:
            'Pass `files` with the exact test files to run, or `changedPaths` with the SOURCE files you edited to see what verifying them would run.',
        },
      };
    }
    if (args.changedPaths !== undefined) {
      // The plan path deliberately does NOT go through selectTestFileRoot: that resolver
      // answers "which checkout owns these TEST files", and changedPaths are source files
      // that need not have a test file anywhere. The agent's own workspace root is the
      // tree it is editing, which is the tree whose radius it is asking about.
      const plan = await deriveAffectedPlan({
        changedPaths: args.changedPaths,
        root: resolveAgentWorkspaceRoot(ctx),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return { data: plan };
    }
    const files = args.files as string[];
    // EI-1754, again: this tool must judge the tree the AGENT is editing, not the
    // one the operator happens to run from. `inferWorkspaceRoot()` walks up from
    // `process.cwd()`, and the :3070 operator runs FROM the release checkout
    // (papercup-release, pinned to green `main`) — so a superuser's testing:run
    // routed every path into the RELEASE tree. Two failure modes, and the silent
    // one is the dangerous one: a test file present in BOTH trees ran against the
    // stale release copy and came back GREEN for an edit it never saw; a
    // staging-only NEW test file came back `route_error: does not exist`.
    // `resolveCapabilityBaseDir` is the same projectDir → PAPERCUSP_INTEGRATION_ROOT
    // → cwd resolver every capability tool (read/write/edit/bash/inspect) already
    // uses, so this tool now reads the same tree those tools write.
    const rootSelection = selectTestFileRoot(files, resolveAgentWorkspaceRoot(ctx));
    // EI-18776865728050036 — same clamp as build:typecheck, for the same reason: this tool is
    // dispatched FOREGROUND over an MCP transport that hard-caps a call at ~55s (EI-6073), so a
    // suite slower than that had the call killed before the core's `error:'timeout'` branch could
    // return, surfacing as an opaque `CONNECTION_CLOSED`. Clamping makes this handler win the
    // race and hand back an actionable next step. The clamp is a TRANSPORT concern, so it lives
    // here and not in runTestFilesCore (whose other callers budget for themselves).
    const timeoutMs = clampForegroundTimeoutMs(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const result = await runTestFilesCore({
      files,
      root: rootSelection.root,
      timeoutMs,
      signal: ctx.signal,
      ...(ctx.workspaceId && ctx.workspaceId !== '*' ? { workspaceId: ctx.workspaceId } : {}),
      ...(ctx.harnessSlug && ctx.harnessSlug !== '*' ? { harnessSlug: ctx.harnessSlug } : {}),
      ...(args.maxFailures !== undefined ? { maxFailures: args.maxFailures } : {}),
      ...(args.testNamePattern !== undefined ? { testNamePattern: args.testNamePattern } : {}),
    });
    const surfacedResult = { ...result, rootSource: rootSelection.source };
    if (result.ok === false && result.error === 'timeout') {
      return {
        data: {
          ...surfacedResult,
          hint:
            `hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (held below the ~55s MCP transport limit so you get this instead of an opaque CONNECTION_CLOSED). ` +
            detachedRecoveryHint({
              runId: result.detachedRunId,
              durable: result.detachedDurable === true,
            }) +
            detachedTestTimeoutHint(files),
        },
      };
    }
    return { data: surfacedResult };
  },
});
