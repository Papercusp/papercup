#!/usr/bin/env node
// Find workspaces affected by a git diff and run their vitest suites.
//
// Usage:
//   node scripts/affected-tests.mjs [--base <ref>] [--integration] [--all]
//
// Defaults:
//   --base origin/main
//   runs the unit suite (`npm test`) per affected workspace
//
// Flags:
//   --integration   also run `npm run test:integration` where defined
//   --all           ignore git diff; run every workspace's tests
//   --dry           print what would run, don't run
//
// Diagnostics:
//   --print-affected                  print `AFFECTED_WS\t<name>` and matching
//                                      `AFFECTED_GUARD\t<workspace>\t<script>` lines, then exit
//   --changed-paths a/b.ts,c/d.mjs    derive the affected set from these paths instead of a git diff
//
//   Together they answer "which suites would a change to THESE files run?" —
//     node scripts/affected-tests.mjs --changed-paths scripts/lint-tsc.mjs --print-affected
//   which a git-based probe cannot answer here: git-sync sweeps the whole tree, so no
//   real commit is ever scoped to just your paths.

import { execSync, execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadavg, availableParallelism, tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { parseQuarantineWorkspaces } from "./lib/quarantine.mjs";
import {
  parseSummaryFailedCounts,
  parseFailedTestFiles,
  countTimeoutSignatures,
  attributeFailedTask,
  renderFailingFilesSummary,
} from "./lib/vitest-summary.mjs";
import { selectRelatedTests } from "./lib/related-tests.mjs";
import { stripCommentsOnly } from "./lib/strip-comments-and-strings.mjs";
import { emptySuiteGuardArgs } from "./lib/empty-suite-guard.mjs";
import { applyWorkerCapEnv } from "./lib/worker-cap.mjs";
import {
  resolveBatchTimeoutMs,
  resolveTaskTimeoutMs,
  isWatchdogTimeout,
  killSpawnedProcessTree,
  parseBatchProgress,
  classifyBatchProgress,
  formatBatchProgress,
} from "./lib/batch-watchdog.mjs";
import { classifyTaskExit, isGatingFailure } from "./lib/task-exit-class.mjs";
import {
  classifyResidualFailure,
  formatLoadSuspectNotice,
  formatLoadSuspectMarker,
} from "./lib/load-suspect.mjs";
import { detectCargoTermination } from "./lib/cargo-result.mjs";
import { listTrackedFiles } from "./lib/tracked-files.mjs";
// D-021/P-002: summed task work, measured per-run. The helper/marker retain their legacy
// "serial" names, but after budgeted scheduling the sum is serial-equivalent work rather than
// elapsed wall time. See scripts/lib/serial-phase.mjs.
import { formatSerialPhaseSummary } from "./lib/serial-phase.mjs";
import {
  durationEstimate,
  formatTaskBudgetMarker,
  formatTaskBudgetObservedMarker,
  mergeDurationHistory,
  readDurationHistory,
  resolveGlobalWorkerBudget,
  resolveTaskBudget,
  resolveWorkerMemoryMb,
  runBudgetedTasks,
  writeDurationHistoryAtomic,
} from "./lib/budgeted-task-scheduler.mjs";
import {
  buildPassingTaskVerdictIdentity,
  decidePassingTaskVerdict,
  hashDependencyFileSet,
  mergePassingTaskVerdictUpdates,
  passingTaskVerdictEntry,
  readPassingTaskVerdictCache,
  writePassingTaskVerdictCacheAtomic,
} from "./lib/passing-task-verdict-cache.mjs";
// EI-10542: this runner interleaves its own header/status lines (fd 1/2) with
// child suite output written synchronously via `stdio: 'inherit'`. On a non-TTY
// fd (the gate captures to a pipe/file) `console.*` is async-buffered and flushes
// AFTER the blocking spawnSync child has already written, so a workspace's output
// prints under another workspace's header. Emit our own lines synchronously so
// they stay glued to the child output they label. See scripts/lib/sync-write.mjs.
import {
  writeAllSync,
  outSync as rawOutSync,
  errSync as rawErrSync,
} from "./lib/sync-write.mjs";

// EI-15802: an agent running this as a BACKGROUND task only sees the harness's
// own truncated tail (~150 lines) plus an exit-code notification — on a long
// combined JS+cargo run that window can cover only the FINAL suite's summary,
// so an agent trusting either the exit code alone or the truncated tail alone
// gets a false read in opposite directions (a real earlier failure hidden by a
// later 'exit 0' cargo pass, or vice versa). Always write the FULL run's output
// — this script's own header/status lines AND every child suite's stdout/stderr
// — to one discoverable, fixed-per-run log file, and print its path prominently
// at the very start (survives a truncated tail) and again at the end (both the
// success and failure summaries). `outSync`/`errSync` below shadow the raw
// sync-write helpers so every EXISTING call site in this file gets logged for
// free, with zero behavior change to what's written to the real fd.
// EI-18121314648626462: keying solely on process.pid is NOT collision-proof —
// under this host's heavy concurrent load (dozens of agents + the hourly
// green-checkpoint routine all running this script), Linux recycles PIDs
// within minutes, so two unrelated invocations (e.g. a staging-tree run and a
// papercusp-checkpoint-tree run started ~10min apart) can land on the SAME
// reused PID and silently append/overwrite each other's log — corrupting the
// "Full run log: ..." path every downstream verifier trusts as evidence. Add a
// short random nonce (independent of pid, time-of-day, and host clock skew) so
// two concurrent runs can never collide, while keeping the pid in the filename
// for human readability when correlating with `ps`/`top`.
// EI-19395701908500754: hoisted out of the path so the SAME token can stamp the
// per-FILE break-set line below. A green-checkpoint verdict log interleaves this
// run's output with the gate's own self-test fixtures, which emit identically-shaped
// lines; a token that is also in the `Full run log:` path is what lets a reader tie a
// break set to THIS run instead of to a fixture that hard-codes a different one.
const RUN_TOKEN = `${process.pid}-${randomBytes(4).toString("hex")}`;
const RUN_LOG_PATH = `/tmp/papercusp-affected-tests-${RUN_TOKEN}.log`;
function logLine(text) {
  if (text == null || text === "") return;
  try {
    appendFileSync(RUN_LOG_PATH, String(text));
  } catch {
    // Logging must never fail the actual test run.
  }
}
function outSync(msg = "") {
  rawOutSync(msg);
  logLine(`${msg}\n`);
}
function errSync(msg = "") {
  rawErrSync(msg);
  logLine(`${msg}\n`);
}
// ── How the run ENDED, recorded in the run's own log (EI-18682539587976453) ──
// The `AFFECTED_TESTS_RESULT` line is emitted on every CLEAN exit path, and
// EI-18796017307093897's guard pins exactly that. But a run that is KILLED reaches
// none of them, so the marker's ABSENCE means either "still running" or "died" —
// and telling those two apart is precisely what a triager needs. Measured
// near-miss: a background test:affected killed at a compaction boundary left a log
// whose last line was a clean "0 errors" — byte-for-byte what a healthy in-progress
// run looks like at that instant. It was caught only by noticing a stale mtime and
// hunting for the process. Absence is not a signal; it is the lack of one.
//
// So every termination this process can OBSERVE now emits the marker exactly once,
// and for the ones it CANNOT observe — every signal, for the reason spelled out at
// the `process.on('exit')` block below — the BEGIN line carries the pid, so a reader
// holding a marker-less log settles "dead or still running" with `kill -0 <pid>`
// instead of a pgrep pattern that self-matches. Both halves are needed: a log is
// only self-identifying if EVERY way it can end is either stamped or classifiable.
let terminalEmitted = false;
// `--print-affected` is an ENUMERATION query, not a run: it deliberately emits no
// verdict marker so a parser gets a clean AFFECTED_WS/AFFECTED_GUARD list, and two
// tests pin that absence. Exempt it rather than teaching every caller to ignore a
// marker they were promised would not appear.
let terminalSuppressed = false;
// Counters for the abort path, read through a swappable closure because the real
// bindings (`tasks`, `failed`, …) are declared ~1500 lines below: a closure over a
// not-yet-initialized `let` throws a TDZ ReferenceError, and a crash INSIDE the
// crash handler loses the verdict entirely — the failure this whole block exists to
// prevent. Upgraded in place once the real counters exist; until then zeros are the
// honest answer, because no task has run yet.
let plannedTaskCount = 0;
let readTerminalCounters = () => ({
  tasks: plannedTaskCount,
  failed: 0,
  quarantinedFailed: 0,
  timedOutTasks: 0,
});
/** Emit the terminal marker for a run that did NOT reach a clean verdict path. */
function emitAbortMarker(extra) {
  if (terminalEmitted || terminalSuppressed) return;
  terminalEmitted = true;
  const c = readTerminalCounters();
  // Same five fields a caller parses on every other path, so one grep classifies
  // any log — a reader must not need a second parser for the abnormal case.
  errSync(
    `AFFECTED_TESTS_RESULT status=aborted tasks=${c.tasks} failed=${c.failed} ` +
      `quarantinedFailed=${c.quarantinedFailed} timedOutTasks=${c.timedOutTasks} ${extra}`,
  );
}
// Written to the run log only — never stdout/stderr. Its job is to make the LOG
// self-identifying, and stdout carries parsed contracts (`--print-affected`) that
// gain nothing from it.
logLine(
  `AFFECTED_TESTS_BEGIN run=${RUN_TOKEN} pid=${process.pid} at=${new Date().toISOString()}` +
    ` (no AFFECTED_TESTS_RESULT below ⇒ this run never terminated on its own: check \`kill -0 ${process.pid}\`)\n`,
);
// ⚠⚠ DELIBERATELY NO SIGTERM/SIGINT TRAP HERE — it is the obvious fix, it is what
// EI-18682539587976453 proposed, and it MAKES THIS SCRIPT WORSE. Measured 2026-08-12
// on this file: with `process.on('SIGTERM', …)` registered, a group SIGTERM mid-run
// left the run ALIVE and marker-less 105s later, and it took a SIGKILL to reap.
//
// Two facts compose into that: (1) registering ANY listener for a signal removes its
// default disposition, so the process no longer dies on delivery; (2) a JS signal
// handler runs on the event loop, and this script's run loop is a SYNCHRONOUS chain
// of `spawnSync` calls that never yields a turn — so the handler that was supposed
// to write the marker cannot run until the whole run is over anyway. The trap thus
// buys no marker and costs promptness: it converts a killable runner into one that
// only SIGKILL can stop, against a repo whose kill discipline is load-bearing.
//
// What DOES work is below and above: `exit` covers every in-process way out (an
// uncaught exception, an unhandled rejection, an early exit that emits no verdict),
// and for a signal — where by construction nothing of ours can run — the BEGIN line's
// pid is the handle, so `kill -0 <pid>` settles "dead or still running" straight from
// the log. Generalizing to the other long-running scripts the filer named
// (green-checkpoint, deploy-cli): a signal trap is only a real option for a runner
// whose main loop is genuinely async, and it must still be paired with a SIGKILL
// escalation upstream. Check the loop before reaching for the trap.
process.on("exit", (code) => {
  // Catches every remaining way out with no verdict: an uncaught exception, an
  // unhandled rejection, or an early process.exit() on a path that emits nothing
  // (e.g. the unrecognized-flag refusal). A clean path has already set the flag.
  emitAbortMarker(`reason=exit-without-verdict code=${code}`);
});
// The budgeted scheduler runs task children concurrently, so their byte streams cannot be
// inherited without interleaving one task under another task's header. Capture every task and
// replay it in declaration order after the initial pool drains. This also leaves every retry,
// summary cross-check, failure attributor, and the full run log on the same evidence path.
const captureOutput = () => true;

// ── Shared-host worker cap (WI-3792 follow-up, 2026-07-10) ──────────────────
// Vitest defaults each suite's fork pool to EVERY core. On the shared 128-core
// dev box that means ONE full-suite run spawns ~128 workers — and the gate,
// peers' runs, and agent sessions routinely overlap, so 2-3 concurrent suites
// put 300+ runnable tasks on the host (loadavg 1000-3000; twice this week the
// box melted: /tmp/pcv day + the ORT spin-pool day, both amplified by exactly
// this). Cap workers per suite at min(32, max(8, cores/4)) unless the caller
// already chose a cap. Wall-clock per suite gets slower; the HOST stays alive.
// VITEST_MAX_WORKERS is the vitest-4 name (verified: the only worker-cap env
// in vitest 4.1.8's dist); MAX_THREADS/MAX_FORKS kept as belts for any tree
// still on vitest ≤3.
//
// WI-5621 (2026-07-20): the static cap above only protects against ONE run's
// own worker count — it says nothing about how many OTHER concurrent
// test:affected/test:file invocations (this fleet routinely runs dozens) are
// already piling onto the same box. `applyWorkerCapEnv` adds an adaptive
// shrink term: when loadavg is already above the core count (the host is
// oversubscribed before this run even starts), the cap shrinks proportionally
// instead of unconditionally grabbing up to 32 more workers. See
// scripts/lib/worker-cap.mjs for the full rationale + the (unit-tested) pure
// function this wraps.
const WORKER_CAP = applyWorkerCapEnv({
  cores: availableParallelism(),
  load1: loadavg()[0],
});
const SCHEDULER_WORKER_MEMORY_MB = resolveWorkerMemoryMb({
  affectedWorkerMemoryMb: process.env.AFFECTED_WORKER_MEMORY_MB,
  nodeOptions: process.env.NODE_OPTIONS,
  fallback: 1024,
});
// The green checkpoint currently pins VITEST_MAX_FORKS/THREADS=2 but not
// VITEST_MAX_WORKERS. `applyWorkerCapEnv` fills the missing modern spelling from host load, which
// can be much larger. Collapse ALL spellings after that fill and take the minimum so the gate's
// pre-existing two-fork safety rail remains the global scheduler ceiling.
const SCHEDULER_WORKER_BUDGET = resolveGlobalWorkerBudget({
  affectedWorkerBudget: process.env.AFFECTED_GLOBAL_WORKER_BUDGET,
  vitestMaxWorkers: process.env.VITEST_MAX_WORKERS,
  vitestMaxForks: process.env.VITEST_MAX_FORKS,
  vitestMaxThreads: process.env.VITEST_MAX_THREADS,
  fallback: WORKER_CAP,
});
const SCHEDULER_CONFIG = resolveTaskBudget({
  workerBudget: SCHEDULER_WORKER_BUDGET,
  memoryBudgetMb:
    process.env.AFFECTED_GLOBAL_MEMORY_MB ??
    SCHEDULER_WORKER_BUDGET * SCHEDULER_WORKER_MEMORY_MB,
  workerMemoryMb: SCHEDULER_WORKER_MEMORY_MB,
  maxConcurrentTasks: process.env.AFFECTED_MAX_CONCURRENT_TASKS ?? 2,
  reserveWorkers: 1,
});
const TASK_DURATION_HISTORY_PATH =
  process.env.AFFECTED_TASK_HISTORY_PATH ??
  join(tmpdir(), "papercusp-affected-task-durations-v1.json");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : d;
};
const has = (k) => args.includes(k);

const base = arg("--base", process.env.AFFECTED_BASE || "origin/main");
const runIntegration = has("--integration");
const runAll = has("--all");
// EI-19463337855465369: `--dry-run` is the more common CLI convention (npm,
// git, rsync, kubectl all use it) and this repo's own agent guidance points
// people at previewing before a heavy run — so it's the spelling an agent
// reaches for. Accept it as an alias rather than relying solely on the
// unknown-flag refusal below to catch it.
const dry = has("--dry") || has("--dry-run");
// P-016 (release-pipeline-resilience-2026-06-09 D-010): range + print-only mode for the
// green-checkpoint's longest-green-PREFIX salvage. With --range-from/--range-to, the
// changed-file set is the two-dot diff of that commit range (NOT the working tree), and
// --print-affected emits one `AFFECTED_WS\t<name>` line per affected workspace plus one
// `AFFECTED_GUARD\t<workspace>\t<script>` line per attached repo-wide guard, then exits
// WITHOUT running any tests — a cheap git+graph affected-set probe per candidate prefix.
const rangeFrom = arg("--range-from", null);
const rangeTo = arg("--range-to", null);
// --changed-paths a,b,c — compute the affected set from these paths instead of a
// git diff. See affectedWorkspaces() for why a git-based probe cannot answer
// "what would touching X select?" on this tree.
const changedPathsOverride = (() => {
  const raw = arg("--changed-paths", null);
  if (raw == null) return null;
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
})();
const printAffected = has("--print-affected");
// --related — narrow each affected workspace's run to the TEST FILES that could
// actually be reached by the changed files, instead of running its whole suite.
// See scripts/lib/related-tests.mjs for the measured narrowing (median ~5.4x in
// operator-core) and for why every rail widens back to the full suite on doubt.
//
// ⚠ DELIBERATELY OPT-IN, and NOT wired into `test:affected`. The green-checkpoint
// gate's greenCmd IS `npm run test:affected`, and the gate is what certifies
// `main`. Import-graph selection structurally cannot see cross-cutting breakage
// (the classic: a required field added to a shared interface strands fixtures that
// never import the changed file — which is why lint:required-field-strands and
// lint:tsc exist). So selection is the developer inner loop; the gate stays broad.
const relatedOnly = has("--related");
const runElSuite = has("--el-suite");
const excludeArg = arg("--exclude", "");
const excludes = new Set(excludeArg.split(",").filter(Boolean));

// EI-19463337855465369: an argv token starting with `--` that none of the
// arg()/has() calls above consumed used to be silently DISCARDED — has()/
// arg() only ever ask "is this flag present"; neither one complains about a
// flag they don't recognize. A typo (or the `--dry-run` convention above,
// before the alias was added) matched nothing, and the script fell straight
// through to its DEFAULT action — which, unlike most CLIs' cheap default, is
// one of the heaviest jobs on this box: actually running the affected test
// suites. This is the same zero-or-unbounded-work-reported-as-clean family
// this repo already guards against elsewhere (a `tsc -p .` that typechecks
// zero files and reads clean; a `test:file -t <pattern>` that matches zero
// tests and reports `status=passed`) — here inverted: instead of silently
// doing LESS than asked, it silently did FAR MORE, with no "unknown flag"
// line to notice before the multi-minute run was already underway. Refuse
// instead of guessing.
const KNOWN_FLAGS = [
  "--base",
  "--integration",
  "--all",
  "--dry",
  "--dry-run",
  "--range-from",
  "--range-to",
  "--changed-paths",
  "--print-affected",
  "--related",
  "--el-suite",
  "--exclude",
];
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
function closestKnownFlag(flag) {
  let best = null;
  let bestDist = Infinity;
  for (const known of KNOWN_FLAGS) {
    const d = editDistance(flag, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  // Only suggest something plausibly a typo of — a wild guess is worse than none.
  return bestDist <= 4 ? best : null;
}
const unknownFlags = args.filter(
  (a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a),
);
if (unknownFlags.length > 0) {
  errSync(
    `affected-tests.mjs: unrecognized flag(s): ${unknownFlags.join(", ")}`,
  );
  for (const flag of unknownFlags) {
    const suggestion = closestKnownFlag(flag);
    if (suggestion) errSync(`  did you mean ${suggestion}?`);
  }
  errSync("");
  errSync(`Known flags: ${KNOWN_FLAGS.join(" ")}`);
  errSync(
    "(see the usage comment at the top of scripts/affected-tests.mjs for what each does)",
  );
  errSync(
    "Refusing to run rather than silently ignoring the flag and running the full default job.",
  );
  process.exit(1);
}

// Read quarantine.txt: BARE workspace-level entries (no `::`) get added to
// the whole-workspace quarantine set (logged as quarantined, not silently
// skipped). Per-file `ws::glob` entries are informational only here — vitest
// doesn't have a per-file skip flag from outside, and the PRECISE per-file
// quarantine match is green-checkpoint.ts's job (applyTestQuarantine), which
// only runs on a genuinely red exit code.
//
// WI-3371 (2026-07-09): this used to do `const [ws] = line.split('::'); if
// (ws) quarantined.add(ws)` — which added the WORKSPACE half of a per-file
// `ws::glob` entry too, so any operator-core failure (the biggest, most
// critical workspace, and the only one with per-file quarantine entries)
// silently stopped gating `npm run test:affected` entirely, contradicting
// this very comment. Fixed per explicit go-ahead from su-4d7a4628 (p2p lead)
// 2026-07-09 — expect NEW gating failures in the previously-masked
// hyperbee/p2p/substrate/federation suites; route fallout per area (hyperbee
// + federation → su-4d7a4628, hive-git → su-63834d42, coord-parity →
// su-4dc3b...), not "revert this fix".
const quarantineFile = join(ROOT, "quarantine.txt");
const quarantined = existsSync(quarantineFile)
  ? parseQuarantineWorkspaces(readFileSync(quarantineFile, "utf8"))
  : new Set();

// WI-3094: Node's execSync defaults maxBuffer to 1MB — comfortably exceeded by
// `git diff --name-only` output once `base` (origin/main) has drifted far enough
// behind HEAD (a live monorepo case: main only fast-forwards on a green
// checkpoint, so it can sit hundreds of commits behind staging for hours under
// fleet load). Observed live: a 460-commit-behind origin/main produced a 5.2MB
// `--name-only` diff, which overflowed the 1MB default and threw `spawnSync
// /bin/sh ENOBUFS` — caught by affectedWorkspaces()'s try/catch (which prints the
// loud EI-1989 banner) but still silently degrading every run to `--all` (every
// workspace), the exact slow-and-masked failure mode that banner exists to call
// out, not fix. 256MB (matching the vitest spawnSync maxBuffer just below) is
// ample headroom — even a full-repo `--name-only` diff is only a few MB — so the
// fast, correct affected-set path succeeds instead of falling back.
function sh(cmd) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

// Collect every file changed vs `base` — committed (base...HEAD), uncommitted
// (working tree vs HEAD), and untracked.
//
// `--ignore-submodules=dirty` (NOT `=all`) is load-bearing in both directions:
//
//  - it still tolerates the broken/retired submodules that forced `=all` here
//    originally: the shared staging checkout carries retired submodules (e.g.
//    libs/papercusp-db, libs/zero-harness) whose `.git` ref points at a missing
//    `.git/modules/...` gitdir, which aborts the diff with `fatal: not a git
//    repository: libs/papercusp-db/../../.git/modules/libs/papercusp-db`. That
//    fatal comes from git ENTERING the submodule to check whether its work tree
//    is dirty — exactly the step `dirty` skips. Before this was handled, the
//    failure was swallowed and the whole run silently degraded to `--all` (every
//    workspace) — slow, noisy, and it masked the real cause (EI-1989).
//
//  - but unlike `=all` it does NOT suppress GITLINK changes, i.e. "this
//    submodule now points at a new commit". A submodule's files never appear as
//    superproject paths (they live in another repo); the gitlink is the ONLY way
//    its changes can surface here. Under `=all`, a commit touching only
//    libs/generic/memory produced an EMPTY changed-file set, so the affected set
//    was empty, so ZERO tests ran and the gate went green having verified
//    nothing — for ~25 submodules, including the memory lib's 286 tests.
//
// Uncommitted work INSIDE a live submodule is what `dirty` drops, so probe for
// it separately (submoduleDirtyPaths) — that keeps the local pre-commit loop
// honest without reintroducing the fatal.
// `git ls-files --others` does not recurse into submodules, so it needs no such
// flag. Throws on a genuine git error so the caller can decide to warn or bail.
function changedFiles() {
  if (rangeFrom && rangeTo) {
    // P-016: two-dot range — files changed BY the commits in (rangeFrom, rangeTo]. No
    // working-tree / untracked component: we're probing a historical commit prefix for
    // the green-checkpoint salvage, not diffing the live tree.
    return sh(
      `git diff --name-only --ignore-submodules=dirty ${rangeFrom}..${rangeTo}`,
    )
      .split("\n")
      .filter(Boolean);
  }
  const committed = sh(
    `git diff --name-only --ignore-submodules=dirty ${base}...HEAD`,
  )
    .split("\n")
    .filter(Boolean);
  const uncommitted = sh("git diff --name-only --ignore-submodules=dirty HEAD")
    .split("\n")
    .filter(Boolean);
  const untracked = sh("git ls-files --others --exclude-standard")
    .split("\n")
    .filter(Boolean);
  return [
    ...new Set([
      ...committed,
      ...uncommitted,
      ...untracked,
      ...submoduleDirtyPaths(),
    ]),
  ];
}

// The changed-path list REPO_WIDE_INVARIANT_GUARDS matches against, memoized so
// enabling a guard never re-shells the four git commands changedFiles() runs.
// Honours --changed-paths for the same reason affectedWorkspaces() does: it is
// the only way to test a selection rule hermetically on this tree, where
// git-sync sweeps everything and no real commit is ever scoped to your paths.
// Fails OPEN (empty list => no guard added): a guard is a safety net, and a net
// that converts a git hiccup into a hard failure of everyone's test loop is a
// worse trade than one that occasionally does not fire.
let invariantGuardChangedPathsCache = null;
function invariantGuardChangedPaths() {
  if (invariantGuardChangedPathsCache) return invariantGuardChangedPathsCache;
  if (changedPathsOverride)
    return (invariantGuardChangedPathsCache = changedPathsOverride);
  if (runAll) return (invariantGuardChangedPathsCache = []); // --all already runs every suite
  try {
    invariantGuardChangedPathsCache = changedFiles();
  } catch {
    invariantGuardChangedPathsCache = [];
  }
  return invariantGuardChangedPathsCache;
}

/**
 * Every submodule path declared in `.gitmodules` (e.g. `libs/papercusp`), memoized.
 *
 * Exists because a submodule path is a CHANGED-PATH SHAPE in its own right, and the only
 * shape under which a change inside a submodule ever reaches this file: the diffs above run
 * `--ignore-submodules=dirty` and `submoduleDirtyPaths()` reports the submodule ROOT, so an
 * edit to `libs/papercusp/packages/locks/src/su-lock-store.ts` arrives here as the bare path
 * `libs/papercusp` — no extension, and matched by no file-family predicate. A guard whose
 * `appliesTo` tests only `/\.tsx?$/` therefore CANNOT attach for any submodule-internal
 * change, which is 39 submodules' worth of source (WI-38401; the 2026-08-12 ~14h `main`
 * freeze originated in exactly that blind spot).
 *
 * Fails OPEN (empty set) for the same reason `invariantGuardChangedPaths()` does.
 */
let gitmodulePathsCache = null;
function gitmodulePaths() {
  if (gitmodulePathsCache) return gitmodulePathsCache;
  try {
    gitmodulePathsCache = new Set(
      sh("git config --file .gitmodules --get-regexp path")
        .split("\n")
        .filter(Boolean)
        // The value is everything past the first space, so a path containing spaces
        // survives (splitting on whitespace would truncate it).
        .map((l) => l.slice(l.indexOf(" ") + 1).trim())
        .filter(Boolean),
    );
  } catch {
    gitmodulePathsCache = new Set(); // no .gitmodules (or unreadable) — nothing to probe
  }
  return gitmodulePathsCache;
}

// Live submodules with uncommitted work — the blind spot `--ignore-submodules=dirty`
// leaves. Returns submodule paths (e.g. `libs/generic/memory`), which map to a
// workspace exactly like a gitlink change does. Best-effort by design: a retired
// submodule whose gitdir is gone throws, and that is precisely the case we must
// swallow rather than let abort the run.
function submoduleDirtyPaths() {
  const paths = [...gitmodulePaths()];
  if (!paths.length) return [];
  const dirty = [];
  for (const p of paths) {
    try {
      // stdio pipe: a retired submodule's `fatal: cannot change to '<path>'` is an
      // EXPECTED, handled condition here. execSync forwards stderr to the parent by
      // default, so without this a swallowed error still prints a scary `fatal:` line
      // and reads like a broken run (the EI-1989 failure mode, in reverse).
      const out = execFileSync("git", ["-C", p, "status", "--porcelain"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (out) dirty.push(p);
    } catch {
      // Retired/broken submodule — skip it, exactly as `=all` used to.
    }
  }
  return dirty;
}

const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// STANDALONE packages: real, tested packages in this tree that are deliberately NOT
// npm workspaces, so `root.workspaces` cannot see them and this script used to run
// ZERO of their tests — including in the green gate, whose greenCmd is
// `npm run test:affected` (release-config.ts). papercusp-desktop is the case that
// exposed it (WI-6077): a git SUBMODULE with its own dependency graph and lockfile,
// whose ~20 guard suites (deb/sidecar/reaper/config + the live-federation rig
// selftests) protect exactly the release+packaging paths this repo ships, and none
// of them were reachable from any gate.
//
// ⚠ DO NOT "tidy" these into root.workspaces. Adding a submodule there changes npm's
// install/hoisting topology for a package that manages its own deps — a far larger and
// riskier change than the gate gap it would close. They are joined to the graph HERE
// instead, and marked `standalone` so spawnSpecFor() runs them with cwd=<dir> rather
// than `npm run --workspace <dir>`, which only resolves for genuine workspaces.
//
// Its Rust tests are NOT included and must not be: a separate cargo step already runs
// them (`test:rust` -> scripts/report-cargo-tests.mjs). The gap was only the JS/shell side.
//
// `libs/generic/sse` is the SECOND case, and it arrived here for a DIFFERENT reason than
// papercusp-desktop: not a deliberate exclusion, an OVERSIGHT. It is structurally identical
// to its listed siblings (`libs/generic/search`, `/memory`, `/sync` — all git submodules, no
// private lockfile, same layout) and simply never got added to `root.workspaces`, so every
// path under it mapped to NO workspace. MEASURED 2026-08-10 (EI-20027740706934564):
//
//   --changed-paths libs/generic/sse/src/index.ts  -> (nothing)  EXIT=0   ZERO workspaces
//   --changed-paths libs/generic/search/src/hybrid.ts -> @papercusp/search, @papercusp/web,
//                                                        @papercusp/operator-core, @papercusp/agent-mcp
//
// Cost of that hole, both directions: sse's own 18 test files / 183 tests never ran in the
// gate (greenCmd is `npm run test:affected`), AND none of the SEVEN packages that already
// DECLARE @papercusp/sse ran either — apps/operator + agent-mcp (`file:../../libs/generic/sse`),
// flags, agent-chat, tooldef-http, sync, desktop-ipc (`"*"`). Note the declarations were never
// the problem: the reverse-dep walk could not use them because the changed path never resolved
// to the package in the first place. This is the SSE transport — `HarnessSyncProvider` passes a
// literal syncType="SSE" with no runtime branch — i.e. the shipping desktop product's sync path.
// Latent rather than constantly-breaking for the same reason the `scripts/` hole was: git-sync
// sweeps the whole tree, so an sse change is nearly always co-committed with paths that DO
// select something. Invisible until the one sweep where it isn't.
//
// ⚠ Joined HERE rather than added to `root.workspaces` for a MEASURED reason, not a stylistic
// one: `package-lock.json` carries its OWN copy of the workspaces array (84 entries, exactly
// matching root package.json), and CI runs `npm ci` strict. Listing sse there without
// regenerating the lockfile breaks `npm ci`; regenerating it means a full `install:safe` that
// rewrites node_modules/.bin under every concurrent agent's in-flight test run. Normalizing it
// into a real workspace is the cleaner end-state and should be done in a quiet window — the
// lockfile already records it as `{"resolved":"libs/generic/sse","link":true}`, identical in
// shape to a listed sibling, so that change is small; it is the TIMING that makes it costly.
// Its `test` script was added in the same change (siblings all use the same `vitest run`);
// scripts are not recorded in lockfile package entries, so that half is lockfile-inert.
// EI-20028225708881148 — `libs/papercusp/packages/file-claim` is the SAME hole as sse above,
// found by widening the check-workspace-deps-complete guard and re-probing every non-workspace
// local package rather than only the one that surfaced. MEASURED 2026-08-10, before this line:
//
//   node scripts/affected-tests.mjs --changed-paths libs/papercusp/packages/file-claim/src/index.ts \
//     --print-affected        ->  ZERO AFFECTED_WS lines
//
// It is a real runtime dependency of the orchestrator's chunk-loop
// (worker-chunk-loop.ts, chunk-loop-driver.ts, run-worker-chunk-loop.ts,
// file-lock-queue-coordinator.ts) and of libs/papercusp/packages/locks' coordinator, and it is
// ALREADY DECLARED by three workspaces — apps/operator (`file:../../libs/papercusp/packages/file-claim`),
// orchestrator and locks (`"*"`). As with sse, the declarations were never the problem: the
// changed path resolved to no package, so the reverse-dep walk had nothing to walk FROM.
// Joining it here puts `@papercusp/file-claim` into wsByName, and reverseDeps then reaches those
// declarers on any change to it.
//
// ⚠ Unlike sse, file-claim has NO tests of its own (`vitest run --passWithNoTests`), so the value
// here is entirely in selecting its DECLARERS — notably the orchestrator's own
// file-lock-queue-coordinator.test.ts and its conformance suite, which exist precisely to keep the
// two FileClaimCoordinator backends (in-process FileLockQueue vs PG-backed SU-locks) aligned. A
// vocabulary package whose whole job is cross-backend conformance is the worst possible one to
// have unrouted: changing it is exactly when you need both backends' suites to run.
//
// Joined HERE rather than added to root.workspaces for the same MEASURED lockfile reason given
// for sse above — package-lock.json carries its own 84-entry workspaces array and CI runs
// `npm ci` strict; the lock already records file-claim as a link entry, so normalizing it is a
// small change whose cost is TIMING, not shape.
const STANDALONE_PACKAGE_DIRS = [
  "papercusp-desktop",
  "libs/generic/sse",
  "libs/papercusp/packages/file-claim",
];

// EI-19346163916263067 — NON-WORKSPACE SOURCE DIRECTORIES.
//
// The mapping in affectedWorkspaces() below matches a changed path against each
// WORKSPACE DIRECTORY. Root `scripts/` is not an npm workspace and holds no
// package.json, so EVERY path under it mapped to NOTHING: it contributed zero to
// the affected set. That directory is the repo's own gate machinery —
// affected-tests.mjs itself, lint-tsc*.mjs, gen-declarations.ts, next-migration.mjs,
// and the 53 `check-*.mjs` guards — i.e. the tooling that decides what gets tested
// was the one thing that tooling could not select tests for.
//
// The tests DO exist: 56 test files in packages/operator-core exercise root
// `scripts/` directly (every `check-*.mjs` guard test, lint-tsc.test.ts,
// generated-declarations.test.ts, typecheck-script.test.ts, the affected-tests-*
// guards). They were simply unreachable from the edit that needs them.
//
// MEASURED incidence before this fix (last 600 commits of staging): 106 commits
// touched `scripts/`; for 7 of them (6.6%) the computed affected set did NOT
// include operator-core, so those ~56 suites never ran — and one (33edac17e5)
// selected ZERO workspaces and reported `status=passed tasks=0` having run nothing.
// It is rare rather than never because git-sync sweeps the whole tree, so a commit
// is almost never scripts-only; that also means the hole is invisible until the
// one sweep where it isn't.
//
// Routed into `directlyChanged` (not appended after the walk) deliberately: these
// paths then behave exactly like a change to the owning workspace, reverse-deps
// included. Splitting the semantics would add a second selection rule whose
// divergence from the first nobody would notice.
const NON_WORKSPACE_PATH_ROUTES = [
  { prefix: "scripts/", workspace: "@papercusp/operator-core" },
  // CLAUDE.md is a PRESCRIPTIVE artifact spliced into every agent's prompt, and
  // its executable claims are asserted by operator-core's doc-claims suite
  // (false-premise-in-prescriptive-artifacts-2026-08-02 P-004). MEASURED before
  // adding it: `--changed-paths CLAUDE.md` selected ZERO workspaces, so the one
  // guard that checks this file did not run when this file changed — the guard
  // would have fired only via the full suite, hours later at the fleet gate,
  // which is the exact latency the check exists to remove.
  { prefix: "CLAUDE.md", workspace: "@papercusp/operator-core" },
  // WI-37840. `templates/` is SHIPPED CONTENT with no package.json of its own, and
  // the three guards that govern it are vitest files in operator-core
  // (template-bundle-integrity, template-docs-slugs, template-store-shadowing).
  // MEASURED before adding it: `--changed-paths templates/papercusp-ui/template.yaml`
  // selected ZERO workspaces and exited 0, while the same run against an
  // operator-core path selected five — so a templates-only commit ran no tests at
  // all, and "nothing to gate" is GREEN at the green-checkpoint. Every defect this
  // plan built guards for (a dangling docs: slug, an unvendored @papercusp/* import
  // in a template check, user-layer shadowing residue) is introduced by exactly that
  // shape of commit, so the guards were unreachable from the change they guard.
  { prefix: "templates/", workspace: "@papercusp/operator-core" },
];

// EI-19388389386110890 — REPO-WIDE INVARIANTS ENFORCED FROM ONE WORKSPACE.
//
// NON_WORKSPACE_PATH_ROUTES above fixes "this path maps to no workspace". This
// fixes the opposite shape: the path maps to its workspace perfectly well, but
// the CHECK that governs it lives in a DIFFERENT one, so the check never runs.
//
// child-output-guard.test.ts is the worked example. Its scope is the whole repo
// — it enumerates via `git ls-files --recurse-submodules`, ~20k TypeScript paths
// across 39 submodules — but it is a vitest file inside @papercusp/operator-core,
// so it is selected only when operator-core is affected. MEASURED 2026-08-03:
//
//   --changed-paths packages/operator-core/lib/terminal-spawn.ts
//       -> AFFECTED_WS @papercusp/operator-core, @papercusp/web   (guard runs)
//   --changed-paths apps/operator/lib/release/deploy-cli.ts
//       -> AFFECTED_WS @papercusp/web                             (guard does NOT run)
//
// So introducing a chunk-unsafe `stdout += String(chunk)` anywhere outside
// operator-core produced NO local signal — test:affected green, lint:tsc green
// (it is type-only) — and first surfaced hours later as a red FLEET gate that
// blocks every agent. That is the whole reported history of the class: five
// separate correct fixes (EI-19298378364087215, EI-19356631236774183, WI-6776,
// WI-6666/WI-6667), each caught at the most expensive possible moment, each
// looking like fresh breakage because each offender genuinely was new.
//
// A guard listed here runs whenever a changed path matches `appliesTo`, even if
// its owning workspace is not otherwise affected. It is a SEPARATE, NARROW task
// (never the workspace's whole `test` suite) precisely so it can be cheap enough
// to run on every change: the chunk-safe guard is 14 assertions, ~1s.
//
// Adding one is a deliberate act: the cost is paid by every agent on every edit,
// so it is only worth it for an invariant that is genuinely repo-wide AND whose
// violation is expensive to discover late. Two existing repo-wide invariants do
// NOT belong here because they already have repo-root lint legs of their own
// (lint:no-raw-setinterval, lint:no-unenrolled-spawn) — that contrast is the
// argument for this list, not against it.
// MIRRORS `SOURCE_ROOTS` / `SCHEMA_FILE_REL` in scripts/check-partial-index-alignment.mjs.
// Deliberately COPIED rather than imported: this router is the entry point for every
// agent's test loop, and the guard mechanism above is documented to fail OPEN — a static
// import would let a load error in a lint script hard-fail everyone's `test:affected`,
// which is exactly the trade that comment rejects.
//
// Copying costs a drift risk, so the drift is ASSERTED, not trusted:
// `affected-tests-repo-wide-invariant-guards.test.ts` imports the real exports and fails
// if these lists disagree. Add a root there and this list must follow, or the guard
// silently stops firing for that root — the same "green because it stopped checking"
// shape the registry exists to prevent.
const PARTIAL_INDEX_SOURCE_ROOTS = [
  "packages/operator-core/lib",
  "packages/agent-mcp/src",
  "apps/operator/lib",
  "libs/papercusp/packages",
];
const PARTIAL_INDEX_SCHEMA_FILE =
  "libs/papercusp/libs/db/src/schema/generated.ts";

// WI-9573 / EI-20208711931756460. Mirrors SQL_DIR + SOURCE_ROOTS in
// scripts/check-migration-forward-compat.mjs — that lint scans parked migration artifacts
// and source consumers, so if either domain moves, this must follow or the guard silently
// stops firing (the same "green because it stopped checking" shape).
const MIGRATION_SQL_DIR = "libs/papercusp/libs/db/sql";
const MIGRATION_SOURCE_ROOTS = [
  "apps",
  "packages",
  "libs/papercusp/packages",
  "libs/papercusp/libs/db/src",
];

// EI-7667. Mirrors ROOTS in scripts/check-no-unthreaded-apply.mjs — that guard walks
// exactly these roots, so if its scan widens, this must follow or the guard silently
// stops firing on the new root.
const UNTHREADED_APPLY_SOURCE_ROOTS = ["packages", "libs", "apps"];

// okf-frontmatter-adoption-2026-08-08 P-006. MIRRORS OKF_SCAN_ROOTS in
// scripts/check-okf-conformance.mjs — mirrored, not imported, because this file is
// every agent's test-loop entry point and a static import would let a load error in
// that lint hard-fail everyone's test:affected. The mirror is asserted equal to the
// real exports by affected-tests-repo-wide-invariant-guards.test.ts; if the lint's
// scan widens, this must follow or the guard silently stops firing on the new root.
const OKF_SCAN_ROOTS = [
  "apps/operator-docs/src/content/docs/agent-insights/",
  "libs/papercusp/packages/harness/knowledge-packs/",
];

// WI-37605. MIRRORS `GC_TAG_SOURCE_ROOTS` in scripts/check-green-checkpoint-tag.mjs — that guard
// walks exactly these roots, so if its scan widens this must follow or the guard silently stops
// firing on the new root. Mirrored rather than imported for the reason stated above: this router is
// every agent's test-loop entry point, and a static import would let a load error in a lint script
// hard-fail everyone's test:affected. The mirror is asserted equal to the real export by
// affected-tests-repo-wide-invariant-guards.test.ts.
const GC_TAG_SOURCE_ROOTS = ["packages/operator-core/lib", "apps/operator/lib"];

// MIRRORS `EXIT_NOT_CHECKED` in scripts/lib/not-checked.mjs — mirrored, not imported, for the
// same reason as the roots above: this file is every agent's test-loop entry point, and a load
// error in a lint module must not hard-fail everyone's test:affected. Asserted equal to the real
// export by affected-tests-repo-wide-invariant-guards.test.ts.
//
// WHY THE RUNNER HAS TO KNOW THIS NUMBER AT ALL (WI-37826): the strand-guard family derives its
// subject from `git diff <base>`, so it answers THREE things, not two — 0 "checked, found
// nothing", 1 "checked, found something", 2 "I could not look". A gate that collapses those into
// `status !== 0` reads "I could not look" as "violation". That is not hypothetical here: a gate
// checkout is CLEAN BY CONSTRUCTION (the candidate is committed), so the working diff is empty
// and a registered strand guard examines zero files EVERY time — turning exit 2 into a
// permanent, content-free red on every candidate that touches a .ts file.
const EXIT_NOT_CHECKED = 2;

// WI-38089 — the declarations freshness guard must be reachable from the `.mjs` files it guards.
//
// `packages/operator-core/lib/generated-declarations.test.ts` execs `scripts/gen-declarations.ts
// --check`, comparing the 42 `.mjs` inputs declared in tsconfig.declarations.json against their
// committed `.d.mts`. It is a vitest file inside @papercusp/operator-core, so it was selected only
// when operator-core was otherwise affected. MEASURED 2026-08-12:
//
//   --changed-paths apps/operator/scripts/psu-launcher.mjs
//       -> AFFECTED_WS @papercusp/web ONLY                         (guard does NOT run)
//   --changed-paths packages/operator-core/lib/model-context-budget.mjs
//       -> AFFECTED_WS @papercusp/operator-core, ...               (guard runs)
//
// psu-launcher.mjs IS a declared input (tsconfig.declarations.json), so editing it without
// re-running `npm run gen:declarations` produced NO local signal — test:affected green, and the
// drift is type-only so lint:tsc is green too — and first surfaced as green-checkpoint red #9
// (candidate cc56ee43) an hour later, against a candidate its author had long moved past. That is
// the expensive shape this list exists for: the red lands on whoever is watching the gate rather
// than on whoever caused it. Two remediation commits in the preceding 4h are the same class:
// d41534e1 ("regenerate all generated declaration projections") and 00d79147.
//
// DERIVED from tsconfig.declarations.json rather than MIRRORED as a literal list — a deliberate
// deviation from the mirrored roots above. The config IS the set gen-declarations reads, so
// deriving makes drift structurally impossible rather than merely asserted. The stated reason those
// other lists are copied — "a static import would let a load error in a lint script hard-fail
// everyone's test:affected" — is about importing EXECUTABLE modules; this reads data, never
// executes it, and is wrapped so a malformed config cannot throw here.
//
// A quoted-`.mjs` regex, not JSON.parse: the config carries `//` comments, so JSON.parse rejects it
// outright (verified). An over-match — a quoted `.mjs` inside a comment — only widens attachment,
// which is the fail-safe direction; every real entry is quoted, so under-matching a declared input
// cannot happen.
const DECLARATIONS_CONFIG = "tsconfig.declarations.json";
let declarationInputsCache;
function declarationMjsInputs() {
  if (declarationInputsCache !== undefined) return declarationInputsCache;
  try {
    const raw = readFileSync(join(ROOT, DECLARATIONS_CONFIG), "utf8");
    const found = [...raw.matchAll(/"([^"\n]+\.mjs)"/g)].map((m) => m[1]);
    // An empty set would silently disable the guard, which is the failure mode this whole
    // registry exists to prevent — treat it as "could not read" and widen instead.
    declarationInputsCache = found.length > 0 ? new Set(found) : null;
  } catch {
    // Fail SAFE, not open. Elsewhere in this file failing open (no guard) is right because the
    // subject list is the CHANGED paths; here the subject is the guard's own scope, so an
    // unreadable config must not quietly stop it firing. Over-attaching costs ~6s; under-attaching
    // costs a fleet-blocking gate red discovered hours later.
    declarationInputsCache = null;
  }
  return declarationInputsCache;
}

const REPO_WIDE_INVARIANT_GUARDS = [
  {
    // WI-39420 (2026-08-16) — lint:di-seam-arity-strands wire-up. The guard scans EVERY
    // tracked .ts/.tsx source in the repo (defaultCandidateFiles in
    // scripts/check-di-seam-arity-strands.mjs), but its enforcing test lives in
    // @papercusp/operator-core — so a DI-seam arity-strand introduced in any OTHER
    // workspace would only be judged when operator-core happened to be independently
    // affected: the partial-enforcement hole check-lint-guard-reachability names.
    // Registering here routes the guard with every changed path it actually covers.
    // --fail blocks on NEW findings only; pre-wiring debt lives in the script's
    // shrink-only FAIL_BASELINE. Cheap: one tsc parse pass over candidate files, no DB.
    workspace: "@papercusp/operator-core",
    // The BASE guard name — the reachability census's coverage credit is an exact-name
    // lookup (`repoWideRegistered.has(row.name)`), and companion spellings like `:fail`
    // are collapsed into the base. operator-core's declaration of this name runs the
    // script in --fail mode (root's stays advisory for hand-runs): enforcement
    // strictness is a property of the enforcement declaration, not of the name.
    script: "lint:di-seam-arity-strands",
    // Exit 2 = EXIT_NOT_CHECKED (zero candidate files). A gate checkout's working diff
    // is empty by construction, so "examined nothing" must not red the gate.
    notCheckedIsNonGating: true,
    // Mirror of the script's own candidate filter: judge the changed path only if the
    // guard would actually scan it.
    appliesTo: (f) =>
      /\.tsx?$/.test(f) &&
      !/\.(test|spec|integration\.test)\.tsx?$/.test(f) &&
      !/(^|\/)(dist|build|node_modules|\.papercusp)\//.test(f) &&
      !f.startsWith("papercup-release/") &&
      !f.startsWith("papercup-checkpoint/"),
  },
  {
    // EI-20551144708194616 — three guards that police papercusp-desktop/bin/*.sh live in
    // apps/operator (@papercusp/web), and the router's path->workspace map sends those two
    // to DISJOINT workspaces. Measured:
    //   papercusp-desktop/bin/release-local.sh              -> AFFECTED_WS @papercusp/desktop
    //   apps/operator/lib/release/<any of these>.test.ts    -> AFFECTED_WS @papercusp/web
    // So each guard ran only when apps/operator changed — precisely when its subject had NOT
    // moved. The one change that would reintroduce the regression was the one change that did
    // not run the test: the confidence of coverage with none of the coverage.
    //
    // These are invariants over SHELL SCRIPTS, not unit tests of a workspace's code, so
    // attaching them here (rather than relocating them into @papercusp/desktop) is the
    // faithful fix — the subject and its guard now route together no matter which workspace
    // a change selects. Each failure class is measured in whole release cuts: a signing-key
    // regression destroyed a tri-platform cut ~35 min in, and the rootfs/versionName ordering
    // regressions each fail the whole cut from inside a leg, ~10 min in. A fourth guard
    // (parallel-leg-supervisor) pins the CONCURRENT supervision that keeps such a failure
    // from also reaping its still-building siblings (EI-20549139616021387).
    workspace: "@papercusp/web",
    script: "test:release-script-guards",
    // Cheap by construction: all three are pure file READS + string assertions — no DB, no
    // network, no build — so this is runnable in GitHub CI exactly as it is here. Vitest exits
    // 1 when a named path matches nothing (verified: `passWithNoTests` is NOT set on this
    // script), so renaming a guard file fails loudly instead of silently guarding nothing.
    //
    // NO hostSuiteRatchet, deliberately — the fail-safe direction. @papercusp/web's own `test`
    // task does re-run these three files, but a ratchet is only honest when the guard's subject
    // and its host suite are selected by the SAME change, and here they are selected by disjoint
    // ones: that disjointness is the entire defect being fixed. Declaring a ratchet would let a
    // papercusp-desktop/bin change skip the guard on the strength of a suite that change does not
    // run — reintroducing the hole in a subtler form. (The registry test enforces this: it
    // rejected a ratchet naming a file outside the host workspace's own package.)
    appliesTo: (f) => f.startsWith("papercusp-desktop/bin/"),
  },
  {
    // WI-5472 — the SAME disjointness defect as the entry directly above, one directory over.
    // The guard's subject is papercusp-desktop/bin/lib/federation-asserts.sh; the guard itself
    // lives in @papercusp/operator-core (alongside the sibling desktop-shell guards, e.g.
    // live-federation-gate-k3-cut-verdict.test.ts). Measured 2026-08-17:
    //   papercusp-desktop/bin/lib/federation-asserts.sh -> AFFECTED_WS @papercusp/desktop
    //   packages/operator-core/lib/<this guard>.test.ts -> AFFECTED_WS @papercusp/operator-core
    // Disjoint, so without this entry the guard runs only when operator-core changes for some
    // unrelated reason — i.e. never when its subject actually moves.
    //
    // ⚠ The test CANNOT simply be relocated into @papercusp/desktop: that package is not in the
    // root `workspaces` list, so nothing under it is selected or run by the root vitest at all.
    // Attaching it here is the only way subject and guard travel together.
    //
    // The invariant: fed_hive_merge_probe / fed_coord_merge_probe must reach their 0/1 verdict
    // under `set -u` with RIG_HIVE_ID unset. When they do not, they die on an unbound `ws`, every
    // caller's `$( ... || true )` swallows it, and the federation-merge assertions read FAIL
    // whether or not federation works — a false RED that costs whole debugging sessions on the
    // transport layer, which is fine.
    workspace: "@papercusp/operator-core",
    script: "lint:federation-assert-nounset",
    // Cheap by construction: sources the shell lib with drv_psql stubbed — no PG, no network, no
    // sleeps (both probes short-circuit before their poll loops). 542ms measured. No
    // `--passWithNoTests`, so renaming the guard file fails loudly instead of guarding nothing.
    //
    // NO hostSuiteRatchet, deliberately — same reasoning as the entry above: operator-core's own
    // `test` task does re-run this file, but subject and host suite are selected by DISJOINT
    // changes, and that disjointness is the entire defect being fixed here. A ratchet would let a
    // federation-asserts.sh edit skip the guard on the strength of a suite that edit never runs.
    appliesTo: (f) => f === "papercusp-desktop/bin/lib/federation-asserts.sh",
  },
  {
    // WI-39608 — the guard that keeps `scripts/mutation-probe.sh`'s copy-paste EXAMPLE
    // runnable. Its three subjects do NOT route together: the two shell scripts select
    // @papercusp/operator-core (so the guard's own suite runs), but the test the example
    // NAMES lives under apps/operator/lib and selects @papercusp/web. Measured:
    //   scripts/mutation-probe.sh                            -> AFFECTED_WS @papercusp/operator-core
    //   scripts/verify-tauri-headless.sh                     -> AFFECTED_WS @papercusp/operator-core
    //   apps/operator/lib/verify-tauri-headless-bind-retry.test.ts -> AFFECTED_WS @papercusp/web
    // So deleting the PROBE_SCRIPT read from that test — i.e. reintroducing the exact
    // defect WI-39608 fixed — was the one change the guard would not have run for.
    //
    // The failure this prevents is not a broken example, it is a FALSE VERDICT ABOUT A
    // GUARD: with `{}` substituted into an env var nothing consumes, the probe measures
    // the unmutated tracked file and reports "mutant SURVIVED" for a guard that is fine.
    workspace: "@papercusp/operator-core",
    script: "lint:mutation-probe-example",
    // Cheap by construction: pure file reads + regex assertions — no DB, no network, no
    // subprocess, no build. 11ms measured. No `--passWithNoTests`, so renaming the guard
    // file fails loudly instead of silently guarding nothing.
    //
    // NO hostSuiteRatchet, deliberately — same reasoning as the two entries above.
    // operator-core's own `test` task does re-run this file, but the subject that most
    // needs the guard (the named test) is selected by a DISJOINT change, and that
    // disjointness is the entire hole being closed. A ratchet would let that edit skip
    // the guard on the strength of a suite the edit never runs.
    //
    // WI-39623 added the 4th subject. The guard now judges the PROJECTED copy of the
    // example too (in the composed corpus), and a projection lands as an ordinary edit to
    // that generated file — so without this entry the one change that rots the projected
    // copy would again be the change the guard does not run for. That is exactly the hole
    // the three entries above exist to close, one file further along the pipeline.
    appliesTo: (f) =>
      f === "scripts/mutation-probe.sh" ||
      f === "scripts/verify-tauri-headless.sh" ||
      f === "apps/operator/lib/verify-tauri-headless-bind-retry.test.ts" ||
      f === "packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md",
  },
  {
    // EI-20687080717457981 — the guard that keeps CLAUDE.md's "which commit carries your
    // change" command actually printing UTC. Same disjointness hole as the entry above,
    // one doc further along: the guard lives in operator-core, but its SUBJECT is the
    // PROJECTED doc, and a projection lands as an edit to `CLAUDE.md` /
    // `claude-md-corpus.generated.md` — neither of which is a `.tsx?` file, so the
    // workspace-selection rule cannot attach operator-core for it. Without this entry the
    // one change that can reintroduce the defect (re-editing the part, then projecting)
    // is the change the guard would not run for.
    //
    // The defect is worth a machine because it is INVISIBLE to review: `TZ=UTC git log
    // ... --format='%cI'` renders the COMMIT's own offset (`-04:00` here) and ignores TZ
    // entirely, so the output looks exactly like a UTC ISO-8601 stamp and is silently 4h
    // off. Every commit in this repo carries the box's own -04:00, so only a synthetic
    // foreign-offset commit can tell the two hypotheses apart — which is why the guard
    // builds one rather than asserting against real history.
    workspace: "@papercusp/operator-core",
    script: "lint:git-log-utc-claim",
    // Cheap by construction: file reads + one throwaway `git init` in os.tmpdir(), no DB
    // and no network. ~92ms measured. It shells out to `git`, which is a hard dependency
    // of every other guard here already.
    //
    // NO hostSuiteRatchet, deliberately — same reasoning as the entry above. operator-core's
    // own `test` task does re-run this file, but the subject that most needs the guard (the
    // projected doc) is selected by a DISJOINT change, and that disjointness is the hole.
    appliesTo: (f) =>
      f === "CLAUDE.md" ||
      f === "packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md",
  },
  {
    // WI-38089. See declarationMjsInputs() above for the measurement and the derive-vs-mirror
    // rationale.
    workspace: "@papercusp/operator-core",
    // ~6.1s measured (3 runs, warm): a `tsc --emitDeclarationOnly` into a temp dir, then a
    // byte-compare of 42 files. The most expensive entry in this list, which is why `appliesTo` is
    // the narrowest possible set — the declared inputs themselves — rather than every `.mjs`.
    script: "lint:declarations-fresh",
    // The ratchet is real: generated-declarations.test.ts execs the SAME `--check` invocation, so
    // when operator-core's own suite runs, this has genuinely already executed.
    hostSuiteRatchet:
      "packages/operator-core/lib/generated-declarations.test.ts",
    appliesTo: (f) => {
      // Adding an input without generating its `.d.mts` is a config edit, not a source edit, and
      // `--check` reports it as `missing` rather than `stale` — so the config itself must attach.
      if (f === DECLARATIONS_CONFIG) return true;
      const declared = declarationMjsInputs();
      if (!declared) return /\.mjs$/.test(f) || /\.d\.mts$/.test(f);
      if (declared.has(f)) return true;
      // Hand-editing a generated `.d.mts` is drift in the opposite direction: the committed
      // declaration no longer matches what the generator would emit.
      return (
        f.endsWith(".d.mts") && declared.has(f.replace(/\.d\.mts$/, ".mjs"))
      );
    },
  },
  {
    // WI-38239 — the drift detector for the PG-canonical authored-doc corpus (plan
    // claude-md-projection-from-pg-2026-08-10). `scripts/project-authored-docs.ts` called this
    // "a GATE" in its own header while NOTHING invoked it, and the cost was measured twice in
    // one day: four projected docs hand-edited and drifted ~20h before anyone noticed, then
    // testing/agent-e2e.mdx drifted AGAIN ~5h later. Both surfaced only by a hand-run command.
    //
    // Keyed on the CONTENT PATHS rather than on the projector, because the change this must
    // catch is a hand-edit to a projected doc — the projector itself is usually untouched when
    // the corpus drifts. The projector + its config attach too: a change to how projection is
    // computed can drift all 873 files at once without any doc being edited.
    //
    // Narrow by design, and that narrowness is what makes it proportionate: it fires ONLY when
    // a projected doc actually changes. A legitimate projector write leaves the file matching
    // its PG row, so the check passes; the only red it can produce is a genuine hand-edit,
    // whose remedy is one command (`--ingest --reconcile`, which preserves the edit into PG
    // rather than clobbering it).
    //
    // Runnable off-box by construction: `--check` SKIPS cleanly (exit 0, and it says it checked
    // nothing) when Postgres is unreachable, so attaching it here does not fail every GitHub CI
    // run — see the no-DB degrade note in project-authored-docs.ts. That degrade is what makes
    // registration honest rather than a permanently-red leg the fleet learns to ignore.
    workspace: "@papercusp/operator-core",
    script: "gen:authored-docs:check",
    // No hostSuiteRatchet: authored-doc-projection.test.ts unit-tests the projection HELPERS,
    // it never execs `--check` over the real corpus, so no suite run implies this has executed.
    appliesTo: (f) =>
      f.startsWith("apps/operator-docs/src/content/docs/") ||
      f === "scripts/project-authored-docs.ts" ||
      f === ".papercusp/docs.json",
  },
  {
    // WI-38239 — `gen:compaction:check` was one of the 8 orphaned `gen:*:check` guards the
    // census widening exposed (it ran on NO blocking path). It is the ONLY real-tree assertion
    // that the shipped compaction floor renders: compaction-strategy.test.ts exercises
    // renderCompactionStrategy over `mkdtemp` FIXTURES only, so a suite pass says nothing about
    // whether the actual `apps/operator/prompts/papercusp-compaction.base.md` still renders.
    //
    // That gap is not hypothetical. This is the file every psu session's compaction floor is
    // built from, and both failures it detects are silent today. MEASURED against a COPY of the
    // real prompts dir (tier-2 probe, tree untouched), the two branches are NOT symmetric:
    //   - missing/empty base  → renderer returns '' → exit 1. Reachable from CONTENT, and the
    //     install then writes NO strategy at all. Proven: deleting the base flipped the verdict
    //     while the unmutated copy passed.
    //   - PAPERCUSP-COMPACTION:CLIENT-OVERLAY marker survives → exit 1. NOT reachable from
    //     content — spliceAtMarker is `split(marker).join(content)`, so it replaces EVERY
    //     occurrence (a planted duplicate marker did not survive). This branch fires only if the
    //     splice implementation itself regresses, which is why splice-tooling-overlay.ts is in
    //     `appliesTo` below rather than the prompts alone.
    //
    // Cheap by construction: a two-file read + a string splice, no DB and no network, so it is
    // runnable in GitHub CI exactly as it is here.
    workspace: "@papercusp/operator-core",
    script: "gen:compaction:check",
    // No hostSuiteRatchet: compaction-strategy.test.ts is fixture-only (mkdtemp) and never
    // references gen-compaction.ts, so no suite run implies this has executed over the real
    // prompts dir. Declaring one would be the phantom ratchet the registry test forbids.
    appliesTo: (f) =>
      f === "apps/operator/prompts/papercusp-compaction.base.md" ||
      f === "apps/operator/prompts/papercusp-compaction.claude.md" ||
      f === "scripts/gen-compaction.ts" ||
      // The renderer and the splice/marker it depends on — the "overlay marker survived" half
      // of the check is a property of these two files, not of the prompts.
      f === "packages/operator-core/lib/desktop-install/papercusp-files.ts" ||
      f ===
        "packages/operator-core/lib/desktop-install/splice-tooling-overlay.ts",
  },
  {
    // WI-38239 — `gen:knowledge-packs:check`, same orphan cohort. The builtin packs' shared
    // items must stay byte-identical to their canonical `coding` source (sync-map.json);
    // hand-editing a mirror silently strands the other side.
    //
    // MEASURED, and it is why this is registered UNCONDITIONALLY rather than ratcheted:
    // pack-sync.test.ts asserts the same invariant over the real tree, and a pack edit does
    // today pull @papercusp/operator-core in (probed: editing knowledge-packs/work/*.md selects
    // it). But that coverage is an artifact of the dependency graph, not a declared premise —
    // precisely the assumption whose quiet breakage this registry already recorded once
    // (declaring @papercusp/db-org on operator-core silently disabled lint:migration-forward-compat).
    // A ratchet is also unavailable honestly: pack-sync.test.ts RE-IMPLEMENTS the comparison
    // rather than exercising gen-knowledge-packs.mjs, so the ratchet assertion would reject it.
    // Attaching unconditionally is the fail-safe direction that test's own message prescribes,
    // and the duplicate cost is a handful of file reads.
    workspace: "@papercusp/operator-core",
    script: "gen:knowledge-packs:check",
    appliesTo: (f) =>
      f.startsWith("libs/papercusp/packages/harness/knowledge-packs/") ||
      f === "scripts/gen-knowledge-packs.mjs",
  },
  {
    // WI-38239 — `gen:tool-catalog:check`, the last WIRE-able member of the orphaned `gen:*:check`
    // cohort the census widening exposed. It guards `.papercusp/tool-catalog.json`, the 1.1MB
    // projection of the `defineTool` registry (docs-and-memory-as-projections D-002).
    //
    // TRACKED-VS-IGNORED DECIDES WIRE-VS-RETIRE, and here it decided AGAINST the generator's own
    // header: this generator and its openapi sibling BOTH claimed the artifact was "NOT committed"
    // — the sibling citing this one BY NAME as its justification. Measured against the tree that is
    // false (`git ls-files` returns it; `git check-ignore` does not), so a genuinely committed
    // artifact carries a genuine drift invariant. The openapi sibling was RETIRED on the opposite
    // measurement: that artifact IS gitignored, and `--check` treats a missing file as stale, so
    // wiring it would have red-pinned every fresh checkout. Two headers agreeing with each other is
    // not corroboration when one inherits from the other — verify against the tree.
    //
    // THE INVARIANT WAS ALREADY VIOLATED WHEN THIS ENTRY WAS WRITTEN, which is the case for wiring
    // it rather than an argument for it: the committed catalog was missing FOUR tools that exist in
    // the registry (db:migrations, issues:list, testing:runs, work_items:stranded) plus a batch of
    // edited descriptions/guidance. Nothing reported it, and the repo's own CLAUDE.md routing table
    // already documented three of the four as available to agents.
    //
    // The cost objection in that header — "it cold-imports the full ~300-tool registry" — is the
    // only real one, and it does not survive measurement: ~10s (3 runs: 10.2 / 9.6 / 10.6), 3/3
    // completions, idempotent (regenerate, then `--check` exits 0). It needs NO database and no
    // network — against a dead PG port with an empty PAPERCUSP_HOME it still exits 0 in 10.6s — so
    // it is runnable in GitHub CI exactly as it is here (the import registers definitions; pools
    // open lazily and nothing queries).
    workspace: "@papercusp/operator-core",
    script: "gen:tool-catalog:check",
    // No hostSuiteRatchet: nothing execs gen-tool-catalog.ts, and the only repo references to it
    // are the scaffold tool's instructional text. Declaring one would be the phantom ratchet the
    // registry test forbids.
    appliesTo: (f) =>
      // All 12 randomly sampled catalog entries define under agent-tools/; endpoint-route
      // contributes none (every one of the 729 entries carries BOTH an MCP name and an http path).
      // `.test.ts` is excluded deliberately — a test beside a tool registers nothing.
      (f.startsWith("packages/operator-core/lib/agent-tools/") &&
        !f.endsWith(".test.ts")) ||
      // The projection surface itself: `listAllProjectedTools` and `defineTool` decide WHAT is
      // projected and WHICH fields land, so a change here can move all 729 entries at once with no
      // tool file edited.
      (f.startsWith("packages/agent-mcp/src/") && !f.endsWith(".test.ts")) ||
      (f.startsWith("libs/generic/tooldef/src/") && !f.endsWith(".test.ts")) ||
      f === "scripts/gen-tool-catalog.ts" ||
      // Drift in the other direction: a hand-edit to the generated artifact.
      f === ".papercusp/tool-catalog.json",
  },
  {
    // WI-38239 — `gen:fleet-lessons:check`, the LAST of the eight orphaned `gen:*:check` guards.
    // It mirrors the machine-local curated fleet-lessons pack into the committed copy that ships.
    //
    // ⚠ READ THIS BEFORE TRUSTING A RED FROM IT. Wiring was blocked until 2026-08-13 by a real
    // defect, not by cost: the exporter copied the curated pack VERBATIM while the committed copy
    // had been backfilled to OKF v0.2 (okf_version / type:) by scripts/okf-backfill-packs.mjs. So
    // `--check` reported 4 files "differ" and told the reader to run the writer — and running it
    // would have STRIPPED those fields and turned `lint:okf-conformance` (which scans this exact
    // directory) RED. Two guards over the same files, each prescribing a state the other rejects,
    // with the red one prescribing the break. gen-fleet-lessons.ts now applies the OKF addition ON
    // EXPORT (okfExportBody), so what ships is conformant whatever the curated side holds and the
    // remedy this guard names is safe to run. Do NOT revert that without re-opening this question.
    //
    // The message's stated direction was also wrong and is worth distrusting on sight: it says the
    // committed copy is BEHIND, and the measured diff was the committed copy AHEAD by one metadata
    // line per file.
    //
    // HONEST LIMIT — what this canNOT catch: the drift that matters most is the fleet ADOPTING
    // knowledge into the curated pack, which changes NO repo file, so no path-triggered guard ever
    // fires for it. That case wants a scheduled sweep. What this DOES catch is a hand-edit to the
    // committed pack and a change to the exporter itself — worth having, and not to be quoted as
    // "the shipped pack is verified current".
    //
    // Cheap and off-fleet-safe by construction: ~1.5s (2 runs: 1.50 / 1.45), and with no shared
    // knowledge-packs root it prints "nothing to export (ok)" and exits 0 — so a CI runner or a
    // fresh clone, which has no curated pack, passes rather than red-pinning.
    workspace: "@papercusp/operator-core",
    script: "gen:fleet-lessons:check",
    // No hostSuiteRatchet: no test execs gen-fleet-lessons.ts, so no suite run implies this has
    // executed over the real pack.
    appliesTo: (f) =>
      f.startsWith(
        "libs/papercusp/packages/harness/knowledge-packs/fleet-lessons/",
      ) ||
      f === "scripts/gen-fleet-lessons.ts" ||
      // The OKF normalizers the exporter now depends on — a change to what they add changes what
      // this guard considers conformant output.
      f === "scripts/okf-backfill-packs.mjs" ||
      f === "scripts/okf-backfill-insights.mjs",
  },
  {
    // WI-38312 — `lint:sidecar-fallback-reported` (EI-20281745253229841) shipped enforcing
    // NOTHING: its only coverage was a logic-test of its predicate over fixtures, so
    // lint:guard-reachability went red for every agent whose change mapped into
    // operator-core — an unattributed `failed=1` with zero failing FILES, which reads as
    // "your change broke something" and sends each of them hunting in their own diff.
    //
    // It scans every tracked .ts, so anchoring it to operator-core's suite alone would
    // rebuild the same blind spot one level down: a bad fallback added in ANY other
    // workspace gets no local signal and first surfaces as a red fleet gate.
    //
    // Cost: ~0.8s (measured, 3 warm runs: 0.73/0.79/0.86). It was ~13s until this entry
    // forced the question — it read all 5,434 eligible files when only 6 mention a sidecar
    // entrypoint. A `git grep -l -F` prefilter does that selection in the index. The verdict
    // is unchanged BY MEASUREMENT, not by argument: git grep missed 0 of the 6 files an
    // exhaustive read found, and masking can only ever REMOVE matches, so the grep is a
    // strict superset of what the masked check can accept.
    workspace: "@papercusp/operator-core",
    script: "lint:sidecar-fallback-reported",
    // The ratchet is real: the guard's own test execs this SAME script over the real
    // tree, so when operator-core's suite runs it has genuinely already executed.
    hostSuiteRatchet:
      "packages/operator-core/lib/fleet/sidecar-fallback-reported-guard.test.ts",
    // Mirrors the guard's own eligibility filter — an unreported fallback can only be
    // introduced by a non-test .ts source, or by editing the guard/allowlist itself.
    appliesTo: (f) =>
      f === "scripts/check-sidecar-fallback-reported.mjs" ||
      (f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".integration.test.ts") &&
        !f.includes("/dist/") &&
        !f.includes("node_modules")),
  },
  {
    // EI-19454727576364875 — a `lint:*` script is declared in a package.json, so editing a
    // package.json is the single edit that can ORPHAN a guard (add a script and wire it nowhere;
    // rename one a runner invokes by name; delete one a gate leg expects). The meta-guard that
    // detects exactly that already existed and was reachable only from a root npm script, i.e.
    // from nothing that any edit selects.
    //
    // ⚠ Registering it here was IMPOSSIBLE-IN-EFFECT until the early-exit ordering bug above was
    // fixed: root `package.json` maps to no workspace, so the guard loop was unreachable for the
    // very file this entry is keyed on. Registration would have looked correct and done nothing —
    // which is why the item it closes had concluded the only remedy was to route package.json to
    // a workspace and pay a whole suite for every root edit.
    workspace: "@papercusp/operator-core",
    script: "lint:guard-reachability",
    // No hostSuiteRatchet: no test file execs this detector, so it attaches unconditionally —
    // the fail-safe direction, and cheap because appliesTo is package.json-only.
    appliesTo: (f) => f === "package.json" || f.endsWith("/package.json"),
  },
  {
    // EI-20098997113620795 — `attributeFailedTask` must be able to name a failing FILE for every
    // test RUNNER the repo actually runs. Twice it could not, and neither time did anything fail:
    // an unreadable runner returns no file rows, which maps to the reason `no-file-rows`, whose
    // documented causes are "a worker crash, an OOM, a spawn error". So a red reported plausible
    // INFRASTRUCTURE while the failing file sat named in plain text a few lines up.
    //
    // Registered repo-wide because the TRIGGER is not a change to the attributor — it is a
    // workspace changing what it RUNS. Measured: `--changed-paths papercusp-desktop/package.json`
    // selects `@papercusp/desktop` and nothing else, so a workspace adopting a new runner would
    // never have selected the guard that exists to catch exactly that. Keying on package.json is
    // therefore the whole point; narrowing to "files that look test-related" would rebuild the
    // blind spot one level down, the same argument no-undrained-stdout-exit makes above.
    workspace: "@papercusp/operator-core",
    script: "lint:attributor-runner-coverage",
    // The ratchet IS the guard: this file is a plain vitest test inside operator-core's own
    // suite, so when that suite runs it has genuinely already executed — not assumed.
    hostSuiteRatchet:
      "packages/operator-core/lib/__tests__/attributor-runner-coverage.test.ts",
    appliesTo: (f) =>
      f === "package.json" ||
      f.endsWith("/package.json") ||
      f === "scripts/affected-tests.mjs" ||
      f === "scripts/lib/vitest-summary.mjs" ||
      f === "scripts/lib/test-runner-classes.mjs",
  },
  {
    // EI-20055889379250637 — `console.log(<unbounded>); process.exit()` truncates
    // through a PIPE (measured: only ~8 KiB escapes; a TTY and a `> file` redirect are
    // both synchronous and therefore fine). It is registered repo-wide for the same
    // reason as chunk-safe below: the defect appears when someone adds a `--json` mode
    // or an accumulating write to ANY CLI, and nobody knows in advance which file that
    // will be. Narrowing to "files that already print JSON" would rebuild the blind
    // spot one level down.
    workspace: "@papercusp/operator-core",
    script: "lint:no-undrained-stdout-exit",
    // The ratchet inside operator-core's suite EXECS the guard over REPO_ROOT (the
    // `describe('the tree is currently clean (ratchet)')` case), so deferring to the
    // host suite is genuinely safe here rather than assumed.
    hostSuiteRatchet:
      "packages/operator-core/lib/undrained-stdout-exit-guard.test.ts",
    appliesTo: (f) => /\.[cm]?[jt]sx?$/.test(f),
  },
  {
    // EI-20070078750133139 — the D-034 shape, 7th instance. `lint:no-raw-spawn` enumerates
    // the WHOLE tracked tree (every .ts outside _retired/node_modules/dist/*.test.ts) but its
    // only enforcement point was a vitest file in operator-core, so a bypass introduced
    // anywhere else got no local signal at all.
    //
    // It surfaced now rather than earlier because the census got MORE accurate, not because
    // the guard changed: EI-20064929206355679 made the shared stripper an AST parse, which
    // promoted this guard from "logic-test only" to enforced-but-partially-covered. A true
    // new finding — so the remedy is registration, NOT an append to
    // ACKNOWLEDGED_PARTIAL_COVERAGE (that set is shrink-only and says so).
    workspace: "@papercusp/operator-core",
    // The standalone SCRIPT. ⚠ operator-core did not DECLARE this script until this change —
    // a registration naming a workspace that lacks the script is INERT (silently skipped at
    // :815 while scoring as fully enforced), which is the exact trap WI-37454 found and now
    // fails on. The package.json declaration is half of this fix, not incidental to it.
    script: "lint:no-raw-spawn",
    // COST, measured before registering (this registry's own standing instruction). The guard
    // was ~11.8-12.1s — 50x what the entries here normally cost — because the AST stripper
    // above parses every scanned file. A provably-sound raw-text pre-filter in the guard
    // (skip files not containing `buildInvokeOnce`; blanking only removes text, so it cannot
    // hide a hit) brought it to ~0.95s, which is the same order as the guards already here.
    // Registering it at 12s would have taxed every fleet-wide test:affected run touching a
    // .ts file, so the pre-filter is what makes this entry affordable rather than a
    // regression traded for coverage.
    hostSuiteRatchet:
      "packages/operator-core/lib/dbos/no-raw-spawn-guard.test.ts",
    // MIRRORS `isExcluded` in scripts/check-no-raw-agent-spawn.mjs — deliberately copied
    // rather than narrowed: the predicate must match what the guard actually scans, and the
    // asymmetry (predicate wider or narrower than the scan) is the defect this registry
    // exists to prevent.
    appliesTo: (f) =>
      /\.ts$/.test(f) &&
      !f.endsWith(".test.ts") &&
      !f.startsWith("_retired/") &&
      !f.includes("/_retired/") &&
      !f.includes("/node_modules/") &&
      !f.includes("/dist/"),
  },
  {
    workspace: "@papercusp/operator-core",
    script: "lint:chunk-safe",
    // The guard script IS a vitest file in operator-core, so the host suite re-runs it
    // by construction — the one case where the skip needs no separate ratchet.
    hostSuiteRatchet: "packages/operator-core/lib/child-output-guard.test.ts",
    // Every TS-family source file: the guard's own enumeration is repo-wide, so
    // narrowing this to "files that spawn children" would re-create the blind
    // spot one level down — the point is that nobody knows in advance which file
    // is about to grow a stream accumulator.
    appliesTo: (f) => /\.[cm]?tsx?$/.test(f),
  },
  {
    // WI-9434 — the same shape as chunk-safe, one instance later. The lint's own
    // ratchet (`the tree is currently aligned`) execs it over the repo, but that
    // ratchet is a vitest file in operator-core, so it ran ONLY when operator-core
    // was independently affected — while the lint SCANS four roots. MEASURED:
    //   --changed-paths apps/operator/lib/release/green-checkpoint.ts
    //       -> AFFECTED_WS @papercusp/web        (3 of the 4 scanned roots escape)
    // A misaligned `->>` landing in apps/operator/lib therefore produced no local
    // signal and would first surface as a red FLEET gate.
    workspace: "@papercusp/operator-core",
    // The standalone SCRIPT (0.57-0.60s measured), NOT the 20-test vitest file
    // (7.66s — vitest startup dominates). The narrow task only needs the RATCHET
    // "does the tree violate the invariant"; the discrimination tests that prove the
    // detector works already run inside operator-core's own suite.
    script: "lint:partial-index-alignment",
    // `describe('the tree is currently aligned (ratchet)')` execs the SAME script over
    // REPO_ROOT inside operator-core's suite, so deferring to it is genuinely safe.
    hostSuiteRatchet:
      "packages/operator-core/lib/partial-index-alignment-guard.test.ts",
    appliesTo: (f) =>
      f === PARTIAL_INDEX_SCHEMA_FILE ||
      (/\.[cm]?tsx?$/.test(f) &&
        PARTIAL_INDEX_SOURCE_ROOTS.some((r) => f.startsWith(`${r}/`))),
  },
  {
    // WI-9573 / EI-20208711931756460 — the D-034 shape a THIRD time, and the most expensive instance yet.
    // lint:migration-forward-compat had NO local enforcement point at all: it was invoked
    // only by green-checkpoint (apps/operator/lib/release/green-checkpoint.ts), so a
    // migration author got zero signal and the violation first surfaced as a red FLEET
    // gate hours later, blocking every agent. That is not hypothetical — on 2026-08-03 it
    // red-pinned the gate for 4 consecutive runs on migrations 750/751/752/754/755, and
    // three other sessions hit the same wall independently the same day (see also
    // EI-19409083906144989, EI-19407054630567497).
    //
    // A .sql migration also maps to NO workspace test suite, so unlike the two guards
    // above there was no partial coverage to widen — the local signal was entirely absent.
    workspace: "@papercusp/operator-core",
    // The standalone script (~0.1s: it readdirs one directory and regex-scans 65 files).
    script: "lint:migration-forward-compat",
    appliesTo: (f) => {
      const isMigrationArtifact =
        f.startsWith(`${MIGRATION_SQL_DIR}/`) &&
        (f.endsWith(".sql") ||
          f.endsWith(".sql.DRAFT") ||
          f.endsWith(".sql.PENDING-CODE-DEPLOY"));
      const isSourceConsumer = MIGRATION_SOURCE_ROOTS.some(
        (root) => f.startsWith(`${root}/`) && /\.[cm]?[jt]sx?$/.test(f),
      );
      return isMigrationArtifact || isSourceConsumer;
    },
  },
  {
    // WI-4311 — the D-034 shape again, with the most delayed discovery of the set.
    // The canonical fix (WITH (FORCE) in makeDrop(), libs/test-config/src/pg-migrate.ts)
    // landed 2026-07-12, but four hand-rolled teardown sites kept the old
    // terminate-then-plain-drop shape and were found 22 DAYS later. Nothing local
    // flagged them, and nothing could: the offending file's own suite passes — the
    // damage is ~88 backends parked in DROP DATABASE state on the SHARED test
    // container, which surfaces as OTHER agents' CONNECT_TIMEOUTs. A violation whose
    // cost lands entirely on somebody else's test run is the exact profile this
    // registry exists for.
    workspace: "@papercusp/operator-core",
    // The standalone script (~1.0s measured, 3 runs — the same order as lint:chunk-safe
    // above, which this list already accepts at that price).
    script: "lint:drop-database-force",
    hostSuiteRatchet:
      "packages/operator-core/lib/drop-database-force-guard.test.ts",
    // Every TS-family file, for chunk-safe's stated reason: narrowing to "files that
    // currently talk to postgres" would re-create the blind spot one level down, and
    // the bug being guarded IS a NEW file hand-rolling its own teardown.
    appliesTo: (f) => /\.[cm]?tsx?$/.test(f),
  },
  {
    // WI-39630 — the D-034 shape, but the violation is INDEX-shaped rather than
    // source-shaped, which is why it went unseen across SEVENTEEN submodules at once.
    //
    // A path both tracked in the index AND matched by .gitignore is a contradiction git
    // settles as "tracked wins", so the ignore rule silently goes inert. Nothing errors
    // and no source file looks wrong — every affected submodule already had
    // `node_modules/` in its .gitignore, which is precisely why reading .gitignore files
    // could never have found it. Once peer npm churn deletes those files, they surface as
    // ` D` rows, git-sync hands git an explicit pathspec for an ignored path, git refuses
    // ("use -f"), and that repo's ENTIRE sync leg dies every tick — measured 2026-08-17 at
    // ~6,500 tracked paths and 16 consecutive failing ticks on dock-workbench.
    //
    // That cost profile is the registry's whole reason for existing: the offending repo's
    // own suite passes perfectly while EVERYONE's commits stop reaching :3070.
    workspace: "@papercusp/operator-core",
    // The standalone script (0.61s measured, 3 runs — between lint:partial-index-alignment's
    // 0.57-0.60s and lint:drop-database-force's ~1.0s, both already accepted here).
    script: "lint:no-tracked-node-modules",
    // Deliberately NO hostSuiteRatchet. tracked-node-modules-guard.test.ts exercises the
    // PREDICATE against injected listers — it never execs the guard against the real tree,
    // so it cannot re-run this invariant in-suite. Declaring a ratchet here would assert
    // exactly the kind of unverified premise EI-20026978310669562 was filed for. Absent a
    // ratchet the guard attaches unconditionally, which is the fail-safe direction and
    // affordable at 0.61s.
    // Deliberately EVERY changed path. Unlike its siblings there is no source pattern that
    // predicts this violation — it is armed by a `git add -f`, or by vendoring in a
    // submodule whose upstream committed its node_modules, neither of which need touch a
    // file this run would otherwise select. Narrowing by extension would reproduce the
    // exact blind spot that let 17 repos arrive here undetected.
    appliesTo: () => true,
  },
  {
    // EI-7667 — the D-034 shape again, and the reason this guard exists at all.
    // lint:no-unthreaded-apply SCANS packages/ libs/ apps/ for production call sites of
    // the hyperbee op-apply seam that fail to thread `ownLogKeyHex`, but its enforcement
    // point is a vitest file in operator-core. `applyOpVia` is DEFINED in operator-core,
    // so a new un-threaded call site there is caught by workspace selection alone — while
    // one in apps/ or libs/ importing that seam can leave operator-core unaffected and
    // escape entirely. Registering closes exactly that leg.
    //
    // Why the escape matters more here than the usual "a red lands later": an un-threaded
    // apply is invisible in BOTH the logs and the database (it restamps a remote row as a
    // local write with a newer-than-wire clock, so the genuine op then loses every LWW
    // compare and the record stays permanently shadowed). It survived four gate runs and
    // three wrong diagnoses on the p2p rig for that reason — this is a defect class the
    // fleet gate would NOT reliably surface, so local enforcement is the real backstop.
    workspace: "@papercusp/operator-core",
    // The standalone script (0.62-0.65s measured, 3 runs — between lint:partial-index-
    // alignment's 0.57-0.60s and lint:drop-database-force's ~1.0s, both accepted here).
    // Not the vitest file: the narrow task only needs the tree ratchet, and the controls
    // proving the detector can still fail already run inside operator-core's own suite.
    script: "lint:no-unthreaded-apply",
    // Mirrors ROOTS in scripts/check-no-unthreaded-apply.mjs — if that scan ever widens,
    // this must follow or the guard silently stops firing on the new root (the same
    // "green because it stopped checking" shape MIGRATION_SQL_DIR is annotated for).
    appliesTo: (f) =>
      /\.[cm]?tsx?$/.test(f) &&
      UNTHREADED_APPLY_SOURCE_ROOTS.some((r) => f.startsWith(`${r}/`)),
  },
  {
    // okf-frontmatter-adoption-2026-08-08 P-006 — the D-034 shape, this time for a
    // CONTENT corpus rather than a source one, which makes the escape total rather
    // than partial. MEASURED before wiring:
    //   --changed-paths <an agent-insights doc>   -> AFFECTED_WS @papercupai/operator-docs
    // and that workspace runs no suite covering the corpus, so an insight doc that
    // drops `type:` (or writes an unparseable `stale_after:`) produced NO local signal
    // whatsoever. The pack half is worse in kind: those files are written by CODE
    // (plan D-003), so the corpus can regress with no author involved at all and the
    // first notice would be a red on files nobody edited.
    workspace: "@papercusp/operator-core",
    // The standalone script (~1.0s measured — the same order as lint:chunk-safe and
    // lint:drop-database-force, both already accepted at that price). The narrow task
    // only needs the tree RATCHET; the discrimination tests proving the detector can
    // still fail live in docs-engine's own suite (okf-conformance.test.ts).
    script: "lint:okf-conformance",
    hostSuiteRatchet:
      "packages/operator-core/lib/okf-conformance-guard.test.ts",
    // Mirrors isOkfScannedFile() in check-okf-conformance.mjs: the two corpus roots,
    // the three extensions it opens, and the dot-path exclusion (Astro's loader never
    // sees those, so the lint does not judge them and routing on them would spend the
    // fleet's edit budget on a finding impossible by construction).
    appliesTo: (f) =>
      OKF_SCAN_ROOTS.some((r) => f.startsWith(r)) &&
      !f.split("/").some((seg) => seg.startsWith(".")) &&
      (f.endsWith(".md") ||
        f.endsWith(".mdx") ||
        /(^|\/)manifest\.ya?ml$/.test(f)),
  },
  {
    // WI-37454 — the D-034 shape again, caught as a LATENT gate red rather than a live one.
    // lint:no-retired-resurrection enumerates the WHOLE superproject index, but its only
    // enforcement point is a vitest file in operator-core
    // (packages/operator-core/lib/retired-resurrection-guard.test.ts), so it ran only when
    // operator-core was independently affected. `lint:guard-reachability` scored it
    // PARTIALLY COVERED and — being a blocking green-checkpoint leg — exited 1 at HEAD.
    //
    // It had not red-pinned the gate YET only because the lint legs are skipped once the
    // gate has already halted (`haltedBy ? null : …`, green-checkpoint.ts:5095): the
    // 10:01:04Z verdict was held by 6 test files, so the lint legs never ran. Those files
    // were already passing at HEAD, so the next clean run would have reached this leg and
    // red-pinned on it — the same surprise as WI-10589's "imminent gate red".
    workspace: "@papercusp/operator-core",
    // The standalone script (212/248/221ms measured over 3 runs) — the same order as
    // lint:chunk-safe and lint:drop-database-force, both already accepted at that price.
    // The narrow task only needs the tree RATCHET; the discrimination tests that prove the
    // detector can still fail live in operator-core's own suite.
    script: "lint:no-retired-resurrection",
    // EVERY tracked path, deliberately unnarrowed. The guard reads `git ls-files -s` with
    // no extension filter and matches on BLOB SHA (findResurrections in
    // check-retired-resurrection.mjs), so a resurrection is a content-identity fact about
    // any two paths — one under `_retired/`, one live — regardless of file type. Narrowing
    // this to a source-extension set (as chunk-safe's comment warns) would re-create the
    // blind spot one level down: a resurrected .css/.json/.md would escape the very guard
    // whose whole purpose is that nobody knows in advance which file gets un-retired.
    appliesTo: () => true,
  },
  {
    // EI-19971915610840229 — the SIBLING of the resurrection guard above, and it had
    // the same gap for longer. CLAUDE.md's retired-surfaces section closed with the
    // flat assertion "`lint:no-retired` guards re-imports", while NOTHING invoked the
    // script: it sat on the acknowledged-unreachable list in
    // check-lint-guard-reachability.mjs, doc-asserted and unenforced. A doc promising
    // a guard that never runs is worse than no guard, because it is quoted as
    // evidence — an agent re-importing a `_retired/` module reads that sentence and
    // concludes the boundary is being watched.
    //
    // Verified clean at wiring time (`npm run lint:no-retired` → exit 0, "no live
    // imports of _retired/ modules and no retired orchestrator-spawn fetch"), so
    // registering it cannot red anyone's loop on pre-existing debt.
    workspace: "@papercusp/operator-core",
    // ~1.39s over 3 runs — the same order as lint:chunk-safe (~1.0s), already
    // accepted here. It walks tracked sources via listTrackedFiles, which recurses
    // into all submodules (WI-6730).
    script: "lint:no-retired",
    // The TS/JS family the guard itself filters to (`/\.(ts|tsx|mjs|cjs|js)$/` in
    // check-no-retired-imports.mjs). Matched to the scan rather than to a workspace:
    // the guard reads the WHOLE tree including submodules, so enforcing it only when
    // operator-core happens to be affected is exactly the D-034 partial-coverage
    // shape the reachability checker flags.
    appliesTo: (f) => /\.(?:tsx?|[cm]?js)$/.test(f),
  },
  {
    // WI-37445 — and the point of this one is that it is the D-034 shape's MIRROR IMAGE.
    // The other entries are guards whose VIOLATIONS escape workspace selection. This guard
    // exists because a whole failure CLASS does: adding a runtime export strands every test
    // that mocks the module with an enumerating `vi.mock` factory, and `test:affected`
    // cannot select those tests even in principle — the diff touches the source module while
    // the file that breaks names it only inside a string literal. So the guard that reports
    // the gap must not be selected by the same mechanism that has the gap.
    workspace: "@papercusp/operator-core",
    // ~440ms typical, ~605ms worst case (3 runs measured; the worst case is the one that
    // actually walks the test corpus, which only happens when an export was added).
    // Cheaper than lint:chunk-safe and lint:okf-conformance, both accepted here at ~1.0s.
    script: "lint:vimock-export-strands",
    // ADVISORY — being registered here is what makes it SPEAK, printing the trigger into the
    // run of whoever added the export.
    //
    // ⚠ This comment used to read "it always exits 0, so it can never red the gate" — the
    // invariant that made registering it safe. WI-37806 broke it (correctly: a run that
    // examined nothing must not report success) without updating this entry, which ARMED a
    // fleet-wide gate red that had not fired yet only because the gate's checkout still ran
    // the older copy. A guard's exit contract is part of its REGISTRATION, not a private
    // detail — change one and this entry has to move with it.
    notCheckedIsNonGating: true,
    // TS-family only: nothing else can declare a runtime export for a factory to omit.
    appliesTo: (f) => /\.[cm]?tsx?$/.test(f),
  },
  {
    // WI-38401 / EI-20020054576584970 — the sibling of the entry above, and the same
    // MIRROR-IMAGE shape: adding a REQUIRED field to an exported interface strands every
    // DEPENDENT that constructs it, and `test:affected` cannot select those in principle
    // (a scoped typecheck compiles the changed file plus what IT imports, never its
    // importers — build:typecheck states that limitation in its own `scopeToFiles`
    // contract). So the guard reporting the gap must not be selected by the mechanism
    // that has it.
    //
    // WHY THIS IS REGISTERED AT ALL, given the guard already existed: it ran on NO
    // automated path. Its only automated reach was a PostToolUse nudge hook, which fires
    // solely for Claude Code Edit|Write|MultiEdit sessions that have it registered —
    // nothing for a `psu` non-Claude client, a script-driven edit, or CI. MEASURED
    // (2026-08-12): `ActiveLockRow.lock_id` gained a required field in
    // libs/papercusp/packages/locks/, stranded its constructors, and froze `main` ~14h.
    // `npm run test:affected` was green throughout, because this guard was in it nowhere.
    //
    // ⚠ THE ADVISORY FORM, DELIBERATELY — never `lint:required-field-strands:typecheck`.
    // The `--typecheck` variant execs `lint:tsc` over packages/operator-core (~104s cold,
    // and it QUEUES behind scripts/pc-heavy.sh: measured 2026-08-13 still queued at 90s
    // under load 93.8). Putting that in every agent's edit loop would be the most
    // expensive entry here by two orders of magnitude. The advisory form exits 0 even WITH
    // findings (`if (!runTypecheck) process.exit(0)`) — being registered is what makes it
    // SPEAK, printing the strand + the workspace-specific typecheck command into the run
    // of whoever added the field.
    //
    // ~1.72-1.77s (3 runs measured through the workspace script, 9 files examined) — a
    // `git show` + TS parse per changed file, so cost tracks the working diff, which
    // git-sync keeps small by sweeping every few minutes.
    workspace: "@papercusp/operator-core",
    script: "lint:required-field-strands",
    // Its subject is the WORKING DIFF, so a gate checkout — clean by construction — makes
    // it examine zero files and exit EXIT_NOT_CHECKED on every candidate. Non-gating is
    // therefore mandatory, not defensive; the strand-family declaration test in
    // affected-tests-repo-wide-invariant-guards.test.ts asserts it from the guard's own
    // `not-checked.mjs` import rather than from a hand-maintained list.
    notCheckedIsNonGating: true,
    // No hostSuiteRatchet: check-required-field-strands.test.ts exercises the DETECTOR
    // over fixtures and never diffs the real tree, so operator-core's own suite running
    // implies nothing about this having executed.
    //
    // TS-family files, PLUS submodule roots. That second half is not a nicety: it is the
    // only shape under which a submodule-internal change reaches this registry at all
    // (see gitmodulePaths()), and the measured incident above lives inside one. A
    // `/\.tsx?$/`-only predicate would have left the exact class that froze `main`
    // unattached while looking fully wired.
    appliesTo: (f) => /\.[cm]?tsx?$/.test(f) || gitmodulePaths().has(f),
  },
  {
    // WI-37593 — the D-034 shape, and the one instance that corrupts THIS FILE'S OWN
    // reverse-dep walk, so every other guard's selection inherits the blind spot.
    //
    // MEASURED (2026-08-09, the ~2h20m fleet-gate freeze): `libs/generic/search/src/
    // hybrid.ts` gained `lexicalWithCascade()` and broke 3 fixtures in operator-core.
    //   --changed-paths libs/generic/search/src/hybrid.ts
    //       -> AFFECTED_WS @papercusp/search, @papercusp/web    (operator-core ABSENT)
    // Mechanism, read at the writer: the reverse-dep map above is built from
    // {dependencies, devDependencies, peerDependencies} ONLY. operator-core imports
    // @papercusp/search in 10+ files and declares it in NONE, so the edge does not
    // exist in the graph and the consumer is invisible. Nothing caught it locally; the
    // fleet gate went red 3x and `main` was frozen while four agents converged on it.
    //
    // ⚠ WHY REGISTER A GUARD THAT IS ALREADY "ENFORCED": it is enforced REMOTELY and
    // POST-PROMOTION only — .github/workflows/test.yml runs it, but git-sync stamps
    // every commit `[skip ci]`, so the push/pull_request triggers never fire
    // (EI-18661485259809120); green-checkpoint dispatches the workflow explicitly AFTER
    // it fast-forwards `main`. So the author of an undeclared import gets ZERO local
    // signal, and the fleet's own blocking verdict never runs it. lint:guard-reachability
    // therefore classifies it `[ci]` = enforced, which is true and still leaves exactly
    // the gap this registry exists to close. Do NOT read its absence from that census's
    // NOT-ENFORCED list as evidence the local path is covered.
    workspace: "@papercusp/operator-core",
    // 1.10-1.16s (3 runs measured) — between lint:chunk-safe and lint:drop-database-force
    // (~1.0s), both already accepted here at that price.
    script: "lint:workspace-deps-complete",
    // Mirrors the guard's OWN scan surface: `--include=*.ts` / `*.tsx`
    // (check-workspace-deps-complete.mjs:150-151). Deliberately NOT the wider
    // /\.[cm]?tsx?$/ the guards above use — matching more than it scans only wastes the
    // 1.1s, but the annotation would then lie about what it covers. `package.json` is the
    // OTHER direction and is why this is not a source-only predicate: DELETING a
    // declaration reintroduces the edge without touching a single import.
    appliesTo: (f) =>
      /\.tsx?$/.test(f) || f === "package.json" || f.endsWith("/package.json"),
  },
  {
    // retire-mug-kettle-su-only-2026-08-09 P-016 — the recurrence guard for the
    // mug/kettle/cup retirement. Repo-wide because the thing it guards against is a NEW
    // entry point, and nobody knows in advance which file is about to grow one: the
    // console door (D-022) appeared in endpoint-route/routes/agent-mcp/, which no
    // narrower predicate would have thought to watch.
    workspace: "@papercusp/operator-core",
    // ~3.4s: it shells out to scripts/mug-kettle-surface-census.mjs --json rather than
    // re-implementing its 8 detectors, so there is exactly ONE implementation of them.
    script: "lint:no-ungated-mug-kettle",
    // Mirrors the union of both scan surfaces: the census walks packages/libs/apps/scripts
    // for the TS-family + .mjs, and the guard's own role-door pass adds .mjs launchers
    // (apps/operator/scripts/psu-launcher.mjs is a real door). Blueprint PROMPTS are a
    // census category too (`prompt|coding/mug|…md`), so .md counts — a new mug role prompt
    // is exactly the kind of quiet re-introduction this is for.
    appliesTo: (f) => /\.[cm]?[jt]sx?$/.test(f) || f.endsWith(".md"),
  },
  {
    // WI-38269 — the VACUOUS FLAG GUARD class, routed from the acceptance scorecard for
    // retire-mug-kettle-su-only-2026-08-09 (criterion `guards-bind-not-vacuous`).
    //
    // WHY REGISTERED HERE AT ALL, when the guard already has an enforcing test.
    // `packages/operator-core/lib/vacuous-flag-guard.test.ts` runs the scan over the real
    // tree, so check-lint-guard-reachability classifies it `test`/blocking. But the `test`
    // tier only fires when @papercusp/operator-core is independently affected — and the
    // motivating instance lived in `apps/operator-vite/src/components/adv/`, a DIFFERENT
    // workspace. So the one edit that produced the original defect is exactly the edit the
    // test tier would not have selected. That is the gap this list exists to close, and it
    // is the same argument the partial-index and green-checkpoint-tag entries make.
    //
    // ~2.4s measured (6,658 test files + 8,963 source files; two regex passes plus a
    // bounded, memoized import walk). Comparable to the mug-kettle entry above.
    workspace: "@papercusp/operator-core",
    script: "lint:vacuous-flag-guard",
    hostSuiteRatchet: "packages/operator-core/lib/vacuous-flag-guard.test.ts",
    // BOTH directions matter, which is why this is not a test-file-only predicate. The
    // defect appears when a TEST adds a flag mock — and, the actual motivating case, when
    // a SOURCE file DROPS its last flag read while the test that toggles it stays behind.
    // Narrowing to `*.test.*` would rebuild the blind spot one level down: AdvNowRunning.tsx
    // is the file that changed, and it is not a test.
    appliesTo: (f) => /\.[cm]?[jt]sx?$/.test(f),
  },
  {
    // WI-38314 — the UNREACHABLE-TIER MOCK class: a test whose mock DEFAULT supplies a
    // constant source predicate as the opposite constant, so every case in the file starts
    // in a state production cannot reach. Sibling of the vacuous-flag-guard entry above and
    // registered for the same reason, but the asymmetry it closes is different: that one
    // catches a knob that drives nothing, this one catches a knob that drives a branch
    // nothing can enter. Neither can see the other's defect.
    //
    // BOTH directions matter, so this is deliberately not a test-file-only predicate. The
    // defect appears when a TEST adds an impossible default — and, the harder direction,
    // when a SOURCE predicate COLLAPSES to a constant (a flag deletion, exactly what P-068
    // did to `mugKettleSystemEnabled`) and every pre-existing mock of it silently becomes
    // dead coverage without one test file changing. `pot/started.ts` is the file that
    // changed in the motivating case, and it is not a test.
    //
    // ~14s measured over 1,915 mocking test files plus the source sweep for constant
    // predicates — the heaviest entry here, but it runs only when a .ts/.tsx path changes
    // in an operator-core-affected run.
    workspace: "@papercusp/operator-core",
    script: "lint:no-unreachable-tier-mock",
    hostSuiteRatchet:
      "packages/operator-core/lib/unreachable-tier-mock-guard.test.ts",
    appliesTo: (f) => /\.[cm]?[jt]sx?$/.test(f),
  },
  {
    // WI-37605 — the D-034 shape again, and this one straddles the boundary in BOTH
    // directions, which is why neither workspace's own suite can hold it. The invariant
    // ("no executable line hardcodes the green-checkpoint production tag") is violated in
    // packages/operator-core (release-actions.ts, 24 sites) AND in apps/operator
    // (green-checkpoint.ts, 13 sites). A guard hosted in operator-core is not selected when
    // only green-checkpoint.ts changes — MEASURED and stated verbatim at the partial-index
    // entry above: `--changed-paths apps/operator/lib/release/green-checkpoint.ts` ->
    // AFFECTED_WS @papercusp/web. So the offender that produced the original report is
    // exactly the one an unregistered guard would miss.
    //
    // The violation is expensive to discover late in the specific way this list cares about:
    // it is invisible locally (it changes no behaviour and no test), and it surfaces as a
    // TRIAGER misreading a verdict log mid-incident — the captured suite line is
    // byte-identical to a real gate decision. Measured on the 4 newest verdict logs on
    // 2026-08-10: 6 impostor lines each.
    //
    // Verified clean at wiring time (`node scripts/check-green-checkpoint-tag.mjs` -> exit 0),
    // so registering it cannot red anyone's loop on pre-existing debt.
    workspace: "@papercusp/operator-core",
    // ~0.3s: a plain fs walk of two lib roots with a cheap `includes` pre-filter before the
    // quote-aware scanner ever runs. The SCRIPT, not the vitest file — the narrow task only
    // needs the ratchet; the discrimination controls that prove the detector works already
    // run inside operator-core's own suite (green-checkpoint-tag-guard.test.ts).
    script: "lint:green-checkpoint-tag",
    hostSuiteRatchet:
      "packages/operator-core/lib/green-checkpoint-tag-guard.test.ts",
    appliesTo: (f) =>
      /\.[cm]?tsx?$/.test(f) &&
      GC_TAG_SOURCE_ROOTS.some((r) => f.startsWith(`${r}/`)),
  },
  {
    // EI-20035436440627349 — the D-034 shape at its most literal: an unparseable module
    // does not break the workspace it lives in, it breaks every workspace that imports
    // it, and THIS FILE plus its scripts/lib/*.mjs helpers are themselves .mjs, so a
    // broken one corrupts the selection mechanism the other guards are chosen by.
    //
    // WHY IT EARNS A SLOT rather than being left to whoever runs a suite next: one
    // unparseable module reds every test file that transitively imports it; all of them
    // produce real FAIL rows; all attribute cleanly to a file; so the runner stamps its
    // most CONFIDENT label — `coverage=complete` — over a list of entirely innocent
    // files, with the culprit absent. `transformCulpritCount` (WI-37607) names the
    // culprit but only downstream, after a peer has already paid for the triage.
    //
    // Measured 2026-08-10, the incident that prompted it: a regex pasted verbatim into
    // a JSDoc block contained the comment terminator, making
    // scripts/lib/strip-comments-and-strings.mjs unparseable tree-wide. Caught by a
    // peer before git-sync swept it, so no broken commit landed — the window, not the
    // commit, is what this closes.
    workspace: "@papercusp/operator-core",
    // ~1.7-2.1s over 3 warm runs: 277 tracked .mjs through a parallel `node --check`
    // pool. Same order as lint:no-retired (~1.39s), which is accepted here.
    script: "lint:js-syntax",
    // NO hostSuiteRatchet ON PURPOSE. Declaring one would skip this guard exactly when
    // operator-core's full suite runs — i.e. on the biggest changesets — and the whole
    // point is that a parse break is tree-wide and instant. Unconditional attach is the
    // fail-safe direction this list documents above.
    //
    // .mjs ONLY. `.js`/`.cjs` would pull in large vendored bundles (the desktop
    // sidecar's monaco) whose baseline is unmeasured; the .mjs baseline was measured
    // clean FIRST (277/277 parse, exit 0 at wiring time), which is what lets this ship
    // ENFORCING instead of as a ratchet carrying debt.
    appliesTo: (f) => f.endsWith(".mjs"),
  },
  {
    // WI-5371 / WI-5673 — a Protomux carries AT MOST ONE hypercore/alpha channel per
    // discovery key, and every harness on this machine shares ONE peer socket. So a second
    // local replica of a remote key never attaches a replicator: it sits at peersCount 0
    // FOREVER while the socket stays live and every health surface reads healthy, then trips
    // replication_stalled -> repair-on-detect (which structurally cannot win the one slot) ->
    // repair-exhausted -> a FORCED TOPIC REJOIN that tears down the SHARED socket for the
    // healthy co-tenant harnesses too. `remote-core-host.ts` fixed it by keeping ONE core per
    // (machine, key) behind the `openRemoteLog` seam — but nothing stopped the next
    // `store.get({ key })` from re-arming it, and the failure is silent at the call site.
    workspace: "@papercusp/operator-core",
    script: "lint:no-unhosted-remote-core",
    // The ratchet IS the guard: no-unhosted-remote-core-guard.test.ts EXECS the real script
    // three times (violation -> exit 1, clean -> exit 0, own-log -> exit 0), so when
    // operator-core's suite runs the detector has genuinely executed, not been assumed.
    hostSuiteRatchet:
      "packages/operator-core/lib/no-unhosted-remote-core-guard.test.ts",
    // NARROW TRIGGER, BROAD SCAN — deliberate, and the asymmetry is the point. The script
    // always scans libs/packages/apps in full (~7.6s), so a violation planted anywhere is
    // caught by any in-scope edit; `appliesTo` only decides WHEN to pay that cost. Keyed on
    // the surfaces where a Corestore is actually in scope, because attaching ~7.6s to every
    // TS edit in the repo is not a trade this list accepts (the sibling guards above run
    // 1.4-2.1s). A new Corestore call site in a wholly unrelated tree is the residual gap;
    // it is caught the next time anything under these paths moves.
    appliesTo: (f) =>
      /^packages\/operator-core\/lib\/sync\//.test(f) ||
      /(^|\/)(corestore|peer-log|remote-core-host|scope-cores)\.ts$/.test(f) ||
      f.includes("/hyperbee/") ||
      f === "scripts/check-no-unhosted-remote-core.mjs",
  },
  {
    // WI-38351 — `lint:migrations` is a GATE lint that nothing ran locally, so the author of a
    // bad migration saw a GREEN `npm run test:affected` and the fleet found out hours later, as a
    // red green-checkpoint that blocks EVERY agent's deploy. Third occurrence of that class
    // (WI-38348 / migration 815, EI-20224121418388370, EI-10999): each time the detector already
    // existed, cost ~1.1s, and simply never ran at the one moment it was still cheap to fix.
    //
    // Its checks are all whole-corpus by construction — duplicate NNN, raw BEGIN/COMMIT, RENAME
    // CONSTRAINT, tenant DEFAULT, index-shape swap, and the reservation-row check that produced
    // all three reds — so a per-workspace suite can never stand in for it.
    workspace: "@papercusp/operator-core",
    script: "lint:migrations",
    // NO hostSuiteRatchet ON PURPOSE, and here that is load-bearing rather than conventional:
    // operator-core is pulled into the affected set for EVERY `libs/papercusp/**` path (see the
    // EI-20026978310669562 note on the runner loop below), so declaring a ratchet would skip this
    // guard on precisely the changesets it exists for. `lib/lint-migrations.test.ts` also unit-
    // tests the helpers against fixtures rather than exec'ing the real corpus, so no honest
    // ratchet is available to declare even if the skip were safe.
    //
    // Honest off-box: the reservation leg needs Postgres and SKIPS cleanly when it is unreachable
    // ("· reservation check skipped (PG unreachable: …)", exit 0), so this does not become a
    // permanently-red leg in GitHub CI — same degrade-not-fail property that made
    // gen:authored-docs:check registrable above.
    appliesTo: (f) =>
      // The migration corpus itself — the numbered .sql files every check above reads. Kept as a
      // directory test rather than an `^libs/papercusp/` anchor so a second scan dir (SCAN_DIRS in
      // lint-migrations.mjs / next-migration.mjs) is covered the day one is added.
      /(^|\/)libs\/db\/sql\/\d+-.*\.sql$/.test(f) ||
      // …and the three files that DECIDE what "clean" means. A change to the linter or to the
      // allocator that hands out the numbers can invalidate the whole corpus at once without any
      // .sql file moving, which is the same shape as the projector case above.
      f === "scripts/lint-migrations.mjs" ||
      f === "scripts/next-migration.mjs",
  },
  {
    // WI-5977 (explicit-presence as an ENFORCED convention). The item's own thesis is that
    // "a convention nobody enforces decays into advice", and that is literally what had
    // happened to its lint: `lint:explicit-presence` shipped (WI-6004), then ran on NO
    // blocking path for two weeks and sat in ACKNOWLEDGED_UNREACHABLE
    // (check-lint-guard-reachability.mjs) as "logic-test only". This registration is the
    // graduation.
    //
    // It gates on a COUNT RATCHET, not on zero. Measured 2026-08-13: 55 unallowlisted
    // candidates tree-wide with an empty ALLOW, so `--strict` would be a permanently-red
    // leg — the kind the fleet learns to ignore. `--ratchet` fails only when the count
    // RISES (baseline in .explicit-presence-baseline.json, ratchet-only-down), which is the
    // same shape as .mock-cast-escape-baseline.json.
    //
    // Deliberately NOT the guard's diff-scoped default mode: with no diff base that mode
    // prints "nothing new to check" and exits 0 having scanned NOTHING. A verifier that
    // reports success without measuring is the exact defect class WI-5977 is about, so the
    // wired invocation is the whole-tree one and its output states the count it measured.
    workspace: "@papercusp/operator-core",
    // ~13.5s (measured, 2 runs: 13.46 / 13.55) — the most expensive entry in this list, and
    // the reason `appliesTo` is pinned to the analyzer's own SCAN_ROOTS rather than every
    // .ts in the repo: a change outside those roots cannot move the count at all.
    script: "lint:explicit-presence",
    // No hostSuiteRatchet: check-explicit-presence.test.ts execs the analyzer's `--self-test`
    // (a positive control on the DETECTOR) but never the whole-tree `--ratchet`, so an
    // operator-core suite run does NOT imply this has executed. Declaring one anyway would
    // be the phantom ratchet affected-tests-repo-wide-invariant-guards.test.ts forbids —
    // and it is what let lint:migration-forward-compat silently stop attaching (see the
    // hostSuiteRatchet note at the selection loop below).
    appliesTo: (f) =>
      // The analyzer's SCAN_ROOTS, mirrored — and it only reads `.ts`, so nothing else under
      // them can move the count. Test files are NOT excluded even though the analyzer skips
      // them: attaching too often costs seconds, attaching too rarely is a silent coverage
      // hole, and only one of those two errors is recoverable.
      (/\.ts$/.test(f) &&
        (f.startsWith("packages/operator-core/lib/") ||
          f.startsWith("apps/operator/lib/") ||
          f.startsWith("libs/papercusp/"))) ||
      // The detector and its baseline decide what "clean" means, so a change to either can
      // move the verdict without any scanned file changing.
      f === "scripts/check-explicit-presence.mjs" ||
      f === ".explicit-presence-baseline.json",
  },
];

const workspaces = [
  ...expandWorkspaces(root.workspaces),
  ...STANDALONE_PACKAGE_DIRS.filter((d) =>
    existsSync(join(ROOT, d, "package.json")),
  ),
];
const standaloneDirs = new Set(STANDALONE_PACKAGE_DIRS);

function expandWorkspaces(patterns) {
  const out = [];
  for (const p of patterns) {
    if (p.includes("*")) {
      const base = p.replace(/\/\*$/, "");
      const baseDir = join(ROOT, base);
      if (!existsSync(baseDir)) continue;
      for (const entry of execSync(`ls -1 ${JSON.stringify(baseDir)}`, {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean)) {
        const dir = join(base, entry);
        if (existsSync(join(ROOT, dir, "package.json"))) out.push(dir);
      }
    } else if (existsSync(join(ROOT, p, "package.json"))) {
      out.push(p);
    }
  }
  return out;
}

const wsByName = new Map();
const wsByDir = new Map();
for (const dir of workspaces) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  const meta = {
    dir,
    name: pkg.name,
    scripts: pkg.scripts || {},
    deps: depsOf(pkg),
    standalone: standaloneDirs.has(dir),
  };
  wsByName.set(pkg.name, meta);
  wsByDir.set(dir, meta);
}

function depsOf(pkg) {
  return new Set(
    Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    }),
  );
}

// Reverse-dependency map: which workspaces depend on X?
const reverseDeps = new Map();
for (const ws of wsByDir.values()) {
  for (const dep of ws.deps) {
    if (!wsByName.has(dep)) continue;
    if (!reverseDeps.has(dep)) reverseDeps.set(dep, new Set());
    reverseDeps.get(dep).add(ws.name);
  }
}

// P-016 (D-010): print-only affected-set probe for the green-checkpoint longest-green-
// prefix salvage. The machine-readable lines are emitted AFTER the repo-wide guard
// selection below, so this probe reports the same guard tasks that a real run would
// attach. It still exits before any test task runs.

function affectedWorkspaces() {
  if (runAll) return [...wsByDir.values()];

  // --changed-paths <a,b,c>: compute the affected set from an EXPLICIT path list
  // instead of a git diff. Two uses, one mechanism (EI-19346163916263067):
  //   - "what would touching this file actually select?" — the question whose
  //     unanswerability let root `scripts/` map to zero workspaces unnoticed. On
  //     this tree a git-based probe cannot answer it: git-sync sweeps the WHOLE
  //     tree, so no real commit is ever scoped to the paths you care about, and
  //     the working-tree/untracked legs of changedFiles() fold in every peer's
  //     in-flight edits on top.
  //   - it makes the selection rules unit-testable hermetically (no repo history,
  //     no clean tree, no synthetic commits).
  // Read-only and selection-only — it cannot cause anything to run that a real
  // change to those same paths would not.
  if (changedPathsOverride) {
    return resolveAffected(changedPathsOverride);
  }

  let changed;
  try {
    changed = changedFiles();
  } catch (e) {
    // EI-8580: a shallow clone whose fetch horizon no longer overlaps
    // `base` (origin/main) fails `git diff base...HEAD` with something
    // like "no merge base" / "no common ancestor" — the diff needs the
    // merge-base commit, not just the tip. This is self-healing: a bounded
    // `git fetch --deepen=2000` is additive (never touches the working
    // tree) and, on a normal drift, restores the merge base outright. Try
    // that ONCE before giving up to --all, so a stale-but-fixable shallow
    // clone doesn't silently pay a full-tree run (and the unrelated flakes
    // that come with it) every single time.
    const looksLikeMergeBaseGap =
      /no merge base|no common ancestor|unrelated histories/i.test(e.message);
    let healed = false;
    if (looksLikeMergeBaseGap) {
      errSync("");
      errSync(
        `!!!!!! affected-tests: \`git diff\` against ${base} found no merge base — shallow clone horizon gap.`,
      );
      errSync(
        "!!!!!! Attempting a one-shot self-heal: git fetch --deepen=2000 origin main staging ...",
      );
      try {
        execSync("git fetch --deepen=2000 origin main staging", {
          cwd: ROOT,
          encoding: "utf8",
          stdio: "pipe",
        });
        changed = changedFiles();
        healed = true;
        errSync(
          "!!!!!! Self-heal succeeded — merge base restored, proceeding with the real affected set.",
        );
        errSync("");
      } catch (e2) {
        errSync(`!!!!!! Self-heal fetch/retry failed: ${e2.message}`);
        errSync("");
      }
    }
    if (!healed) {
      // `--ignore-submodules=dirty` (see changedFiles) means a broken retired
      // submodule no longer trips this — so a failure HERE is now a GENUINE git
      // problem, not the routine retired-submodule breakage. Make the
      // degrade-to-everything LOUD: the old fallback printed two quiet lines and
      // ran all ~80 workspaces, which read as a normal (if slow) run and hid the
      // real cause (EI-1989). A banner on stderr ensures it can't masquerade as
      // the intended fast path.
      errSync("");
      errSync(
        "!!!!!! affected-tests: COULD NOT COMPUTE THE AFFECTED SET !!!!!!",
      );
      errSync(`!!!!!! \`git diff\` against ${base} failed: ${e.message}`);
      errSync(
        "!!!!!! FALLING BACK TO --all (running EVERY workspace) — SLOW, and a BUG, not the intended path.",
      );
      errSync("!!!!!! Fix the git error above; do not rely on this fallback.");
      errSync("");
      return [...wsByDir.values()];
    }
  }

  return resolveAffected(changed);
}

// The path-set -> workspace-set rule, factored out so the --changed-paths probe
// (and its guard test) exercise the SAME code the real git-diff path does. Two
// copies of this that could drift would make the test prove nothing.
function resolveAffected(changed) {
  const directlyChanged = new Set();
  for (const file of changed) {
    let matchedAWorkspace = false;
    for (const ws of wsByDir.values()) {
      // `file === ws.dir` (no trailing slash) is the SUBMODULE case: a gitlink
      // change is reported as the bare directory, not as a path beneath it. Without
      // this arm, a submodule workspace can never be marked affected.
      if (
        file === ws.dir ||
        file === `${ws.dir}/package.json` ||
        file.startsWith(`${ws.dir}/`)
      ) {
        directlyChanged.add(ws.name);
        matchedAWorkspace = true;
      }
    }
    // Paths in a non-workspace source directory (see NON_WORKSPACE_PATH_ROUTES).
    // Deliberately a FALLBACK, not an override: if a real workspace ever owns the
    // path, that ownership wins and the route stays silent.
    if (matchedAWorkspace) continue;
    for (const route of NON_WORKSPACE_PATH_ROUTES) {
      if (!file.startsWith(route.prefix)) continue;
      if (wsByName.has(route.workspace)) directlyChanged.add(route.workspace);
    }
  }

  // Walk reverse-deps transitively
  const affected = new Set(directlyChanged);
  const queue = [...directlyChanged];
  while (queue.length) {
    const name = queue.shift();
    const dependents = reverseDeps.get(name);
    if (!dependents) continue;
    for (const d of dependents) {
      if (!affected.has(d)) {
        affected.add(d);
        queue.push(d);
      }
    }
  }

  return [...affected].map((name) => wsByName.get(name)).filter(Boolean);
}

/**
 * Detect "EL-relevant" file changes — persona, sync script, the test
 * itself, or any registered command def the agent might call. When
 * these change AND --integration is set, auto-enable --el-suite so the
 * operator's voice agent doesn't drift unnoticed.
 */
function elSuiteAutoTrigger() {
  if (runAll) return false; // user already opted into everything
  let changed;
  try {
    changed = changedFiles();
  } catch {
    return false;
  }
  return changed.some(
    (f) =>
      f === "apps/operator/prompts/operator.persona.md" ||
      f === "apps/operator/scripts/el-agent-sync.mjs" ||
      f === "apps/operator/scripts/el-suite-test.mjs" ||
      f.startsWith("apps/operator/lib/commands/defs/"),
  );
}
if (runIntegration && !runElSuite && elSuiteAutoTrigger()) {
  outSync("(EL-relevant files changed — auto-enabling --el-suite)");
  // mutate the flag so the task collector below picks it up
  // eslint-disable-next-line no-global-assign
  globalThis.__autoElSuite = true;
}

const affected = affectedWorkspaces();

// EI-19454727576364875 — there is DELIBERATELY no `if (!affected.length) exit` here, and it
// must not be reintroduced. It used to sit at this line, 46 lines above the
// REPO_WIDE_INVARIANT_GUARDS loop below, which made that loop unreachable whenever the changed
// paths mapped to no workspace. That silently defeated the mechanism in exactly the case it was
// built for: a guard is registered by `appliesTo(changedFile)` PRECISELY so it keeps running when
// its host workspace is not affected, and the change that routes NOWHERE (root package.json,
// tsconfig.base.json, the lockfile) is the one most likely to break something repo-wide.
//
// Measured before the fix: `--changed-paths package.json` printed
// `status=passed tasks=0 reason=no-affected-workspaces` while a guard registered with
// `appliesTo: (f) => f === 'package.json'` sat right there, matching, and never ran. The failure
// presented as GREEN — `tasks=0 … status=passed` is indistinguishable from "nothing needed
// checking", which is the expensive direction for a gate to fail in.
//
// The empty-affected case is now handled by the single `if (!tasks.length)` exit below, AFTER the
// guards have had their chance to attach. The per-workspace loop is already a no-op over an empty
// `affected`; `wsByName` is built from ALL workspaces, so a guard's host still resolves; and with
// no `test` task present the `hostSuiteRatchet` deferral cannot fire, so guards attach
// unconditionally — the fail-safe direction.

// ── PURE/STATEFUL LANE SPLIT (plan gate-suite-speedup-2026-08-12, P-003) ────────────────
// A workspace declaring BOTH lane scripts runs them INSTEAD of its single `test` task. The
// PURE lane (files that never touch the module registry — no vi.mock/doMock/resetModules)
// runs with vitest's top-level `isolate` OFF, so files SHARE a fork's module registry
// instead of cold-transpiling the package graph once per file; the STATEFUL lane keeps
// today's isolated behaviour. Together the two lanes run EXACTLY the file set `test` ran.
//
// `npm run test` itself is deliberately UNCHANGED and still runs the whole suite isolated.
// That is load-bearing, not incidental: the green-checkpoint's isolation and confirming
// co-execution re-runs reach a workspace through resolveWorkspaceTestInvocation
// (`npm run test --workspace <ws> -- <files>`), which sets no lane env — so those re-runs
// stay isolated BY CONSTRUCTION, and WI-6956 keeps its ability to classify "passes alone,
// fails co-executed" as a real concurrency defect rather than absorbing it.
const LANE_SCRIPTS = ["test:lane-pure", "test:lane-stateful"];
const hasLaneSplit = (ws) => LANE_SCRIPTS.every((s) => ws.scripts?.[s]);
/**
 * Do this workspace's already-queued tasks cover its FULL unit suite?
 *
 * The `hostSuiteRatchet` deferral below asks "is the host suite running?", and before the
 * lane split that was spelled `t.script === 'test'`. Under the split the full suite is the
 * UNION of the two lane tasks, so a literal 'test' check would silently answer NO and
 * re-attach EVERY ratchet-declaring guard as a separate npm invocation — each paying the
 * ~6.5s per-leg spawn the split exists to save. Fail-safe in direction, but it would eat a
 * large share of the gain, and nothing would report that it had.
 */
const coversHostSuite = (queued, wsName) =>
  queued.some((t) => t.ws.name === wsName && t.script === "test") ||
  LANE_SCRIPTS.every((s) =>
    queued.some((t) => t.ws.name === wsName && t.script === s),
  );

const tasks = [];
for (const ws of affected) {
  if (excludes.has(ws.name)) {
    outSync(`(excluded ${ws.name})`);
    continue;
  }
  if (ws.scripts.test) {
    if (hasLaneSplit(ws))
      for (const script of LANE_SCRIPTS) tasks.push({ ws, script });
    else tasks.push({ ws, script: "test" });
  }
  // Static drift check between el-agent-sync TOOLS list and the
  // commands registry. Cheap (no network), catches the runtime crash
  // class that hit us yesterday ("Client tool not defined on client").
  // Always runs when present — no integration flag gate.
  if (ws.scripts["lint:el-tools"]) tasks.push({ ws, script: "lint:el-tools" });
  if (runIntegration && ws.scripts["test:integration"])
    tasks.push({ ws, script: "test:integration" });
  // EL Conv AI behavior suite. Hits the live agent; expensive (a few
  // EL minutes per run). Gated behind --integration AND --el-suite
  // because most operator changes don't affect persona/tools — opt-in
  // when you've touched prompts/operator.persona.md, scripts/el-agent-
  // sync.mjs, lib/commands/defs/**, or want to verify before a release.
  // Skips with exit 0 when EL credentials aren't available so CI
  // without an XI_API_KEY doesn't fail the gate.
  if (
    runIntegration &&
    (runElSuite || globalThis.__autoElSuite) &&
    ws.scripts["test:el-suite"]
  )
    tasks.push({ ws, script: "test:el-suite" });
}

// Repo-wide invariant guards (see REPO_WIDE_INVARIANT_GUARDS). Appended AFTER the
// per-workspace loop.
//
// EI-20026978310669562 — this skip used to read `t.script === 'test' || t.script ===
// guard.script`, justified as "that suite already contains the guard, so adding it
// there would just run the same assertions twice". That premise was ASSUMED per guard
// and true for only SOME of them, which made the skip a silent coverage hole with a
// trigger nobody would connect to it: the guard stopped attaching the moment the HOST
// workspace became affected for an unrelated reason. Measured — declaring
// @papercusp/db-org et al. on operator-core (a dependency-graph change, nothing to do
// with linting) pulled operator-core into the affected set for every libs/papercusp/**
// path, so a migration .sql change silently stopped running
// lint:migration-forward-compat: exactly the class WI-9573 wired this registry to
// prevent, re-opened by a change three files away.
//
// So the premise is now DECLARED (`hostSuiteRatchet`) rather than assumed, and asserted
// by affected-tests-repo-wide-invariant-guards.test.ts: a guard may only be skipped in
// favour of the host suite if it NAMES the in-suite ratchet that re-runs it, and that
// file must really exec it. A guard that declares nothing attaches unconditionally —
// the fail-safe direction, since the narrow tasks are sub-second by design.
const selectedInvariantGuards = [];
for (const guard of REPO_WIDE_INVARIANT_GUARDS) {
  const ws = wsByName.get(guard.workspace);
  if (!ws?.scripts?.[guard.script]) continue;
  if (excludes.has(ws.name)) continue;
  // Dedupe the guard against ITSELF unconditionally: queueing the identical narrow task
  // twice is pure waste and buys no coverage.
  if (tasks.some((t) => t.ws.name === ws.name && t.script === guard.script))
    continue;
  // Defer to the host workspace's full suite ONLY where a named ratchet re-runs this
  // invariant inside it.
  if (guard.hostSuiteRatchet && coversHostSuite(tasks, ws.name)) continue;
  if (!invariantGuardChangedPaths().some((f) => guard.appliesTo(f))) continue;
  selectedInvariantGuards.push({ workspace: ws.name, script: guard.script });
  if (!printAffected)
    outSync(`(repo-wide invariant guard: ${ws.name} :: ${guard.script})`);
  tasks.push({
    ws,
    script: guard.script,
    notCheckedIsNonGating: Boolean(guard.notCheckedIsNonGating),
  });
}

/**
 * Path aliases for a workspace, read from its tsconfig `compilerOptions.paths`.
 *
 * Only intra-package aliases matter here (`@/…`); a bare package specifier is out of
 * graph by design. Returning {} on any problem is SAFE, not lossy: an alias we cannot
 * resolve makes the importing file "unresolved", and related-tests.mjs treats an
 * unresolved file as reaching everything — so a missing mapping widens the run rather
 * than silently dropping edges from the graph.
 */
function tsconfigAliasesFor(wsRoot) {
  try {
    const tsconfigPath = join(wsRoot, "tsconfig.json");
    if (!existsSync(tsconfigPath)) return {};
    // Tolerate comments/trailing commas — tsconfig is JSON5-ish in practice.
    // Comments are masked by the SHARED stripper, never a local regex. A naive
    // `//`-to-end-of-line rule is string-literal-blind, so a tsconfig value that
    // merely CONTAINS " // " (measured: `"note": "ratio 1 // 2 is fine"`) is
    // truncated mid-string and JSON.parse throws. The catch below would swallow
    // that and return {}, silently dropping every alias — which makes each aliased
    // import unresolvable and fail-safes the whole workspace to "reaches
    // everything". Safe direction, but it disables narrowing INVISIBLY, which is
    // the failure mode this file can least afford to hide. Trailing commas are
    // stripped AFTER masking, so a comma inside a string is never touched either.
    const raw = stripCommentsOnly(readFileSync(tsconfigPath, "utf8"), tsconfigPath).replace(
      /,(\s*[}\]])/g,
      "$1",
    );
    const cfg = JSON.parse(raw);
    const opts = cfg.compilerOptions ?? {};
    const baseUrl = join(wsRoot, opts.baseUrl ?? ".");
    const out = {};
    for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
      const target = Array.isArray(targets) ? targets[0] : null;
      if (typeof target !== "string") continue;
      // "@/*": ["./*"]  ->  prefix "@/" maps to <baseUrl>/
      const prefix = pattern.replace(/\*$/, "");
      const dir = join(baseUrl, target.replace(/\*$/, ""));
      out[prefix] = dir.endsWith("/") ? dir : dir + "/";
    }
    return out;
  } catch {
    return {};
  }
}

// --related: narrow each workspace's `test` task to the test files the change can
// actually reach. Everything else about the task list is untouched — in particular
// the repo-wide invariant guards above keep attaching exactly as they do without
// this flag, because they are the cross-cutting net that selection cannot replace.
//
// A task keeps `relatedFiles` only when the engine returns mode 'related'. Every
// other outcome leaves it undefined and therefore runs the FULL suite, which is the
// safe direction: over-running costs minutes, under-running certifies nothing.
if (relatedOnly && !printAffected) {
  const changedAbs = invariantGuardChangedPaths().map((f) => join(ROOT, f));
  // The unit suite is narrowable whether it is one `test` script or a lane split.
  // Passing the selection to a LANE still runs that lane's own env + include set,
  // so each lane executes exactly (its files ∩ the selection) and lane semantics are
  // preserved. Integration, el-suite and the invariant guards are NOT narrowable:
  // each means something specific by "run" that a positional filter would quietly
  // change.
  const narrowable = (script) => script === "test" || LANE_SCRIPTS.includes(script);
  const byWorkspace = new Map();

  for (const t of tasks) {
    if (!narrowable(t.script)) continue;
    // A zero-match positional filter is a FAILURE for a script without
    // --passWithNoTests. Narrowing legitimately produces zero matches for a lane, so
    // only narrow where an empty run is a clean pass; otherwise leave the task alone.
    if (!/--passWithNoTests\b/.test(t.ws.scripts?.[t.script] ?? "")) continue;

    if (!byWorkspace.has(t.ws.name)) {
      const wsRoot = join(ROOT, t.ws.dir);
      let result;
      try {
        result = selectRelatedTests({
          rootDir: wsRoot,
          changedPaths: changedAbs,
          aliases: tsconfigAliasesFor(wsRoot),
        });
      } catch (err) {
        // A crash in selection must never be able to SHRINK a run. Fall back loudly.
        result = {
          mode: "full",
          selected: [],
          total: 0,
          reason: `selection-error(${(err && err.message) || err})`,
        };
      }
      byWorkspace.set(t.ws.name, { result, wsRoot });
      outSync(
        `RELATED_SELECTION ws=${t.ws.name} selected=${
          result.mode === "related" ? result.selected.length : result.total
        } total=${result.total} mode=${result.mode} reason=${result.reason}`,
      );
    }

    const { result, wsRoot } = byWorkspace.get(t.ws.name);
    if (result.mode === "related") {
      // vitest takes positional filters as substring matches against test paths;
      // workspace-relative paths are what its `include` globs resolve against.
      t.relatedFiles = result.selected.map((f) => relative(wsRoot, f));
    }
  }
}

if (printAffected) {
  for (const ws of affected) outSync(`AFFECTED_WS\t${ws.name}`);
  for (const guard of selectedInvariantGuards) {
    outSync(`AFFECTED_GUARD\t${guard.workspace}\t${guard.script}`);
  }
  // An enumeration query, not a run: no verdict is owed, and two tests pin that
  // no AFFECTED_TESTS_RESULT appears here. Exempt it from the abort fallback.
  terminalSuppressed = true;
  process.exit(0);
}

if (!tasks.length) {
  // Two genuinely different empty outcomes, kept as DISTINCT reasons (EI-19454727576364875).
  // Collapsing them would hide the more interesting one: "workspaces were selected but none of
  // them declares a test script" is a coverage smell worth noticing, whereas "this change routes
  // nowhere at all" is the case that used to skip the repo-wide guards entirely.
  if (!affected.length) {
    outSync(
      "No affected workspaces (and no repo-wide invariant guard matched the changed paths).",
    );
    outSync(
      "AFFECTED_TESTS_RESULT status=passed tasks=0 failed=0 quarantinedFailed=0 timedOutTasks=0 reason=no-affected-workspaces",
    );
  } else {
    outSync(
      `Affected: ${affected.map((w) => w.name).join(", ")} — but none declare a 'test' script.`,
    );
    outSync(
      "AFFECTED_TESTS_RESULT status=passed tasks=0 failed=0 quarantinedFailed=0 timedOutTasks=0 reason=no-test-script",
    );
  }
  terminalEmitted = true;
  process.exit(0);
}

outSync(
  affected.length
    ? `Affected workspaces (${affected.length}): ${affected.map((w) => w.name).join(", ")}`
    : // Reachable since EI-19454727576364875: a change can route to NO workspace and still have
      // repo-wide invariant guards to run. Spelled out rather than printing an empty list, so a
      // triager reading the log is not left wondering whether the selection silently failed.
      "Affected workspaces (0) — repo-wide invariant guards only.",
);
// The task list is final here, so an abort from this point on can report the real
// planned count instead of the pre-selection zero.
plannedTaskCount = tasks.length;
outSync(`Running ${tasks.length} task(s):`);
for (const t of tasks) outSync(`  - ${t.ws.name} :: ${t.script}`);
outSync(formatTaskBudgetMarker(SCHEDULER_CONFIG));
// EI-15802: printed EARLY (before any suite runs) and again in the final
// summary — a truncated background-task tail is more likely to still show
// this line than a full multi-suite run's early output, so it survives even
// when the rest of the header has already scrolled out of the retained tail.
outSync(
  `Full run log: ${RUN_LOG_PATH} (grep this — not just the exit code or a truncated tail — for the real per-suite verdict)`,
);

if (dry) {
  outSync(
    `AFFECTED_TESTS_RESULT status=dry-run tasks=${tasks.length} failed=0 quarantinedFailed=0 timedOutTasks=0`,
  );
  terminalEmitted = true;
  process.exit(0);
}

// AFFECTED_RETRY_FAILED=1 (the green-checkpoint sets it): re-run a FAILED
// workspace once before counting it. On the shared dev box the gate runs
// while the fleet is at load 70-95, and single-test timeout flakes were
// holding green `main` back for HOURS (2026-06-06 afternoon: consecutive
// not-greens whose identification re-run passed 8867/8867). A real
// regression fails both runs; a load flake almost never fails twice in a
// row. Default OFF so interactive `test:affected` keeps fail-fast feedback.
//
// EI-9103 (2026-07-10): interactive `test:affected` was NOT exempt from the
// same load-flake class the gate protects itself against — a fleet-load
// verification sweep false-failed 4 operator-core suites purely on wall-clock
// (60-80s, all pass in 6-8s isolated) because AFFECTED_RETRY_FAILED defaults
// OFF here. Every agent running the MANDATED test:affected sweep on a loaded
// box hit this and had to hand-triage (re-run + isolate) every time. Rather
// than flip the default globally (which would silently retry away a genuine
// regression on a quiet box too), auto-enable the SAME retry only when the
// box is actually loaded enough to plausibly cause it — load1 above the
// threshold the gate's own comment cites as its affected regime (70-95) with
// headroom to catch it earlier. An explicit AFFECTED_RETRY_FAILED=0/1 always
// wins (still lets a caller force fail-fast even on a loaded box, or force
// retry on a quiet one).
const AUTO_RETRY_LOAD1_THRESHOLD = 40;
const explicitRetryFailed = process.env.AFFECTED_RETRY_FAILED;
const currentLoad1 = loadavg()[0];
const retryFailed =
  explicitRetryFailed != null
    ? explicitRetryFailed === "1"
    : currentLoad1 > AUTO_RETRY_LOAD1_THRESHOLD;
if (explicitRetryFailed == null && retryFailed) {
  outSync(
    `>>> load1=${currentLoad1.toFixed(0)} > ${AUTO_RETRY_LOAD1_THRESHOLD} — auto-enabling flake-absorbing retry ` +
      `(EI-9103; set AFFECTED_RETRY_FAILED=0 to force fail-fast anyway)`,
  );
}

// HARDEN-GATE (su-85e11 proposal, landed via brief 09 2026-06-10): when a
// workspace fails under AFFECTED_RETRY_FAILED, prefer re-running just the
// FAILED FILES in a FRESH process over re-running the whole workspace.
// Two flake classes the workspace-level retry handles poorly:
//   - cross-file state poisoning (vitest-fail-on-console catching another
//     file's late console output; shared bootstrap-graph state) — a fresh
//     process clears it where an identical full re-run can reproduce it;
//   - peer mid-edit transform errors on the shared tree — scoping the retry
//     to the failed files keeps the second run cheap (seconds, not a 10k-test
//     suite), so the gate's wall-clock stays bounded under load.
// Parse the vitest summary for failed files; when nothing parses (e.g. a
// non-vitest failure mode) fall back to the original full-workspace retry.
// EI-18819483316574031: this used to be a local copy of the rollup/FAIL regexes that
// did NOT strip ANSI, so on real (colourised) gate output it returned [] — silently
// downgrading the targeted fresh-process re-run of the actual failed files into a blunt
// whole-workspace retry. Now delegated to the shared, ANSI-stripping, unit-tested parser
// so it cannot drift from green-checkpoint.ts's copy again.
const parseFailedFiles = parseFailedTestFiles;
const FRESH_RETRY_MAX_FILES = 15; // a broader red is a real regression, not a flake

// EI-19370814345784324: a test that blocks its vitest worker's event loop SYNCHRONOUSLY
// (e.g. a tight `mkdirSync` ENOENT/EEXIST spin) makes vitest's own `testTimeout` unable to
// fire — that timeout is a timer on the very event loop the spin never yields, so the one
// bound that looks like it covers this is structurally incapable of firing. Measured
// 2026-08-02: a single wedged worker held the green-checkpoint gate (and every fleet
// deploy behind it) for 74 minutes before being found and killed by hand, with nothing up
// to the parent's 120-minute GREEN_CHECKPOINT_SUITE_TIMEOUT_MS backstop able to tell
// "wedged" from "legitimately slow" while it happened.
//
// The fix has to live in THIS process, not the child's. Each task is launched with async
// `spawn`, so this parent's timer remains runnable even when the child's event loop is
// synchronously spinning. The child leads a detached process group; on expiry the parent
// kills that whole group so npm/shell/vitest descendants cannot retain the capture pipes
// after the deadline. Default well below the 120m gate ceiling (generous for a legitimately
// slow full-workspace suite, but bounded), overridable for a caller who knows a specific
// workspace runs long. See scripts/lib/batch-watchdog.mjs for the unit-tested policy,
// attribution fallback, and process-tree kill.
// 45m, not 20m (EI-20268851913189733). The bound must exceed the LARGEST workspace's
// honest duration with headroom, or it stops being a watchdog and becomes a coin flip
// on load. Measured 2026-08-12: operator-core reported 3302 of its 4063 test files
// (81%) in 20.0m while still completing files at ~10ms each — i.e. it needs ~25m under
// fleet load, so the old default truncated the biggest leg MID-RUN and reported it as
// a wedge. green-checkpoint runs this same script and nothing overrides this env var,
// so that was a latent red-pin for every deploy. Still far below the ~120m gate
// ceiling this exists to protect, which is the bound that actually matters.
const BATCH_TIMEOUT_FLOOR_MS = 45 * 60_000;
const BATCH_TIMEOUT_MAX_MS = 90 * 60_000;
const BATCH_TIMEOUT_HEADROOM_MULTIPLIER = 2;
const BATCH_TIMEOUT_QUANTUM_MS = 5 * 60_000;
const BATCH_TIMEOUT_OVERRIDE_MS = resolveBatchTimeoutMs(
  process.env.AFFECTED_BATCH_TIMEOUT_MS,
  null,
);
const BATCH_KILL_SIGNAL = "SIGKILL";

// A PACKAGED install ships the whole suite (vitest, the test files, quarantine.txt,
// its own node at sidecar/bin/node) but has NO npm — by design. This script is
// reachable there (`node scripts/affected-tests.mjs --all`), so the only thing that
// made the suite unrunnable on a release build was re-spawning `npm run <script>`
// per workspace. When npm is absent, invoke the workspace's script directly instead.
// Every workspace `test`/`test:integration` script in this repo is a plain
// `vitest run …`, and `npm run` adds exactly two things we can reproduce: cwd =
// the workspace dir, and node_modules/.bin on PATH. Anything else fails LOUDLY
// rather than silently skipping — a suite that quietly runs nothing is the worst
// outcome for a release check.
const npmAvailable =
  spawnSync("npm", ["--version"], { stdio: "ignore" }).status === 0;
if (!npmAvailable) {
  outSync(
    "note: npm not found (packaged install?) — running each workspace's script directly.",
  );
}

/**
 * Reproduce what `npm run <script> --workspace <dir>` gives a script, without npm:
 * cwd = the workspace dir, and both the workspace's and the root's node_modules/.bin
 * on PATH. We also prepend THIS node's own directory, because a packaged install's
 * node lives at sidecar/bin/node and is not necessarily the `node` on PATH — without
 * it every `#!/usr/bin/env node` shebang in .bin/ fails to resolve.
 */
function spawnSpecFor(t, extraArgs) {
  if (npmAvailable) {
    // A STANDALONE package (see STANDALONE_PACKAGE_DIRS) is not an npm workspace, so
    // `--workspace <dir>` does not resolve for it — npm fails with "No workspaces
    // found". Run it the way a human would: `npm run <script>` with cwd = its own dir,
    // which resolves against ITS package.json and its own node_modules/.bin.
    if (t.ws.standalone) {
      const argv = [
        "run",
        t.script,
        ...(extraArgs.length ? ["--", ...extraArgs] : []),
      ];
      return { cmd: "npm", argv, cwd: join(ROOT, t.ws.dir) };
    }
    const argv = [
      "run",
      t.script,
      "--workspace",
      t.ws.dir,
      ...(extraArgs.length ? ["--", ...extraArgs] : []),
    ];
    return { cmd: "npm", argv, cwd: ROOT };
  }
  // No npm (a PACKAGED install — see the note above). The direct-exec fallback below
  // reproduces `npm run` for a script that is a single binary invocation; a standalone
  // package's aggregate `test` is a composite shell line (`npm run a && npm run b`),
  // which that fallback cannot honor. Fail LOUDLY rather than silently verifying
  // nothing — the stated principle for this whole code path.
  if (t.ws.standalone) {
    throw new Error(
      `${t.ws.name} :: "${t.script}" is a standalone package's aggregate script and needs npm, ` +
        `which is unavailable here (packaged install?). Run its suites individually, or skip ` +
        `standalone packages in this environment — do not treat this as a pass.`,
    );
  }
  const script = (t.ws.scripts[t.script] ?? "").trim();
  const [tool, ...rest] = script.split(/\s+/);
  const wsDir = join(ROOT, t.ws.dir);
  const binDirs = [
    join(wsDir, "node_modules", ".bin"),
    join(ROOT, "node_modules", ".bin"),
  ];
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), ...binDirs, process.env.PATH]
      .filter(Boolean)
      .join(":"),
  };
  // `node foo.mjs` → run it with the node we are already running under.
  if (tool === "node")
    return {
      cmd: process.execPath,
      argv: [...rest, ...extraArgs],
      cwd: wsDir,
      env,
    };
  // Anything else must be a node_modules/.bin entry (vitest, astro, tsx, …).
  // Spawn the bin itself so its shebang picks the right interpreter; PATH above
  // makes that resolve. Fail LOUDLY on a missing bin — a release check that
  // silently runs nothing is worse than one that stops.
  const bin = binDirs.map((d) => join(d, tool)).find((p) => existsSync(p));
  if (!bin) {
    throw new Error(
      `${t.ws.name} :: "${t.script}" is \`${script}\` — no \`${tool}\` in ${binDirs.join(" or ")}. ` +
        `Install npm, or add the missing dependency.`,
    );
  }
  return { cmd: bin, argv: [...rest, ...extraArgs], cwd: wsDir, env };
}

// ── P-003/D-003: conservative passing-task reuse across candidate refires ───
// setupTree() rebuilds the checkpoint checkout for every newer candidate. The cache therefore
// lives outside ROOT, but its filename is scoped to this checkout root so another pipeline/tree
// can never consume it accidentally. It is enabled only for the real green checkpoint; local
// affected runs remain fresh feedback. PAPERCUSP_TEST_RUN_GROUP is part of the complete child-env
// hash below, which deliberately confines reuse to one gate run's auto-refire chain.
const TASK_VERDICT_CACHE_ENABLED = process.env.GREEN_CHECKPOINT === "1";
const TASK_VERDICT_CACHE_ROOT_SCOPE = createHash("sha256")
  .update(ROOT)
  .digest("hex")
  .slice(0, 16);
const TASK_VERDICT_CACHE_PATH =
  process.env.AFFECTED_TASK_VERDICT_CACHE_PATH ||
  join(
    tmpdir(),
    `papercusp-affected-passing-verdicts-v1-${TASK_VERDICT_CACHE_ROOT_SCOPE}.json`,
  );
const taskVerdictCacheRead = TASK_VERDICT_CACHE_ENABLED
  ? readPassingTaskVerdictCache(TASK_VERDICT_CACHE_PATH)
  : null;
const taskVerdictCacheUpdates = {};
const taskVerdictDigestCache = new Map();
const taskVerdictTrackedScan = TASK_VERDICT_CACHE_ENABLED
  ? listTrackedFiles(ROOT)
  : null;
const taskVerdictGuardKeys = new Set(
  selectedInvariantGuards.map(
    ({ workspace, script }) => `${workspace} :: ${script}`,
  ),
);

const pathInsideDir = (file, dir) => file === dir || file.startsWith(`${dir}/`);

function localDependencyClosureDirs(workspaceName) {
  const dirs = new Set();
  const seen = new Set();
  const queue = [workspaceName];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const ws = wsByName.get(name);
    if (!ws) continue;
    dirs.add(ws.dir);
    for (const dep of ws.deps) if (wsByName.has(dep)) queue.push(dep);
  }
  return [...dirs].sort();
}

function dependencyProvenanceForTask(t) {
  if (!TASK_VERDICT_CACHE_ENABLED) return null;
  // These tasks consume live/external state by definition. A content hash cannot establish
  // complete provenance, so D-003 says miss rather than pretending the closure is sufficient.
  if (t.script === "test:integration" || t.script === "test:el-suite") {
    return {
      ok: false,
      reason: "provenance-incomplete:external-integration-task",
    };
  }
  const scan = taskVerdictTrackedScan;
  if (!scan || scan.files.length === 0) {
    return {
      ok: false,
      reason: "provenance-incomplete:tracked-file-enumeration-empty",
    };
  }
  const key = taskKey(t);
  const wholeTree = taskVerdictGuardKeys.has(key);
  const closureDirs = localDependencyClosureDirs(t.ws.name);
  for (const dir of closureDirs) {
    if (!scan.files.some((file) => pathInsideDir(file, dir))) {
      return {
        ok: false,
        reason: `provenance-incomplete:workspace-not-enumerated:${dir}`,
      };
    }
  }
  // Shared gate inputs are part of every task: root manifests/config, affected runner + helpers,
  // and the common Vitest configuration package. The task's own workspace and every transitive
  // local dependency supply the rest. Repo-wide guards conservatively bind the whole tree.
  const files = wholeTree
    ? scan.files
    : scan.files.filter(
        (file) =>
          !file.includes("/") ||
          file.startsWith("scripts/") ||
          file.startsWith("libs/test-config/") ||
          closureDirs.some((dir) => pathInsideDir(file, dir)),
      );
  const unavailable = scan.unscannedPresent.filter(
    (submodule) =>
      wholeTree ||
      closureDirs.some(
        (dir) => pathInsideDir(dir, submodule) || pathInsideDir(submodule, dir),
      ),
  );
  return hashDependencyFileSet({
    root: ROOT,
    files,
    unavailable,
    digestCache: taskVerdictDigestCache,
  });
}

const taskVerdictGateConfig = {
  batchTimeout: {
    overrideMs: BATCH_TIMEOUT_OVERRIDE_MS,
    floorMs: BATCH_TIMEOUT_FLOOR_MS,
    headroomMultiplier: BATCH_TIMEOUT_HEADROOM_MULTIPLIER,
    quantumMs: BATCH_TIMEOUT_QUANTUM_MS,
    maxMs: BATCH_TIMEOUT_MAX_MS,
  },
  batchKillSignal: BATCH_KILL_SIGNAL,
  captureOutput: captureOutput(),
  scheduler: SCHEDULER_CONFIG,
  retryFailed,
  retryLoad1Threshold: AUTO_RETRY_LOAD1_THRESHOLD,
  freshRetryMaxFiles: FRESH_RETRY_MAX_FILES,
  runIntegration,
  runAll,
  runElSuite,
  laneScripts: LANE_SCRIPTS,
  excludes: [...excludes].sort(),
  quarantine: [...quarantined].sort(),
};

let failed = 0;
let quarantinedFailed = 0;
// EI-19332556961886184: a non-quarantined failure whose own output ALSO shows a vitest
// hard-timeout signature ("Test/Hook timed out in Nms.") — tracked separately from
// `failed` so a triager can see "N failed, M of which show a timeout signature" instead
// of a bare "N failed" that collapses a load-correlated timeout and a real assertion
// break into the same red. Purely additive: never subtracted from `failed`, never
// changes the exit code or any retry/absorption decision.
let timedOutTasks = 0;
// The real counters now exist, so an abort during the run loop below — the long
// window this whole mechanism is about — reports what had actually happened when
// the signal landed, not the pre-run zeros. Declared here rather than at the top
// because a closure over these `let`s is a TDZ throw until this point.
readTerminalCounters = () => ({
  tasks: tasks.length,
  failed,
  quarantinedFailed,
  timedOutTasks,
});
// EI-2341 item 2: the final summary used to report only a COUNT of failed tasks,
// so finding WHICH task failed meant scrolling back through the whole run's
// interleaved output. Track names as we go and name them in the final summary.
const failedTaskNames = [];
// EI-19395701908500754: the per-FILE break set, accumulated as we go. `failedTaskNames`
// above names WORKSPACES; nothing named FILES, so triagers mined the gate's prose for
// them and got fixture paths. A failed task whose files cannot be named goes into
// `unattributedTasks` WITH ITS REASON rather than being silently absent — an empty file
// list must never be indistinguishable from "nothing failed".
const failedFileEntries = [];
const unattributedTasks = [];
// WI-38300: failures that survived HARDEN-GATE absorption while the box was STILL loaded.
// They stay counted in `failed` — this list only drives the extra attribution a triager needs
// so nobody "fixes" tests that were never broken. See scripts/lib/load-suspect.mjs.
const loadSuspectTasks = [];
// WI-37607: the CULPRIT MODULES of any parse failure seen in a failed task's output. Accumulated
// separately from the two above because it is orthogonal to both: a module that fails to parse
// still yields FAIL rows for every file importing it, so the usual shape is a FULLY attributed
// break set (`coverage=complete`) whose every entry is a casualty. Measured 2026-08-09: 21 files,
// zero unattributed, one broken module — a peer mid-write on this shared tree.
const transformCulpritPaths = [];
// D-021/P-002: per-leg wall time, summed as SERIAL-EQUIVALENT task work. Before P-002 the tasks
// actually ran one at a time, so this was also phase wall time. They now overlap under the global
// scheduler envelope, which makes their sum useful work rather than elapsed time. A retry is
// recorded as an ADDITIONAL leg for the same task rather than folded into it, so flake-absorption
// cost stays separable from first-run cost.
const taskLegs = [];
const recordLeg = (task, ms) => {
  taskLegs.push({ name: `${task.ws.name} :: ${task.script}`, ms });
};
const taskKey = (task) => `${task.ws.name} :: ${task.script}`;
const taskContexts = tasks.map((t) => ({
  t,
  isQuarantined: quarantined.has(t.ws.name),
  // EI-11132: when this script declares --passWithNoTests AND the workspace genuinely
  // has matching test files on disk, disable passWithNoTests for THIS task.
  guardArgs: emptySuiteGuardArgs({
    scriptText: t.ws.scripts[t.script] ?? "",
    wsAbsDir: join(ROOT, t.ws.dir),
    script: t.script,
  }),
  cacheProvenance: dependencyProvenanceForTask(t),
}));
const durationHistory = readDurationHistory(TASK_DURATION_HISTORY_PATH);
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

/**
 * Async captured child runner. `spawn` keeps the parent event loop free so the scheduler can
 * overlap tasks, while buffering lets the reporting loop below replay whole task records in
 * declaration order. Each child gets ITS allocation as the Vitest cap; the sum is bounded by
 * SCHEDULER_CONFIG, so this cannot multiply the former per-workspace WORKER_CAP.
 */
function runCapturedTask(
  context,
  allocation,
  extraArgs = [],
  scriptOverride = null,
) {
  const spawnTask = scriptOverride
    ? { ...context.t, script: scriptOverride }
    : context.t;
  const spawnTaskKey = taskKey(spawnTask);
  const taskDurationMs = durationEstimate(durationHistory, spawnTaskKey);
  const taskTimeoutMs = resolveTaskTimeoutMs({
    overrideMs: BATCH_TIMEOUT_OVERRIDE_MS,
    floorMs: BATCH_TIMEOUT_FLOOR_MS,
    durationMs: taskDurationMs,
    headroomMultiplier: BATCH_TIMEOUT_HEADROOM_MULTIPLIER,
    quantumMs: BATCH_TIMEOUT_QUANTUM_MS,
    maxMs: BATCH_TIMEOUT_MAX_MS,
  });
  const taskTimeoutSource = BATCH_TIMEOUT_OVERRIDE_MS != null
    ? "override"
    : taskDurationMs == null || taskTimeoutMs === BATCH_TIMEOUT_FLOOR_MS
      ? "floor"
      : taskTimeoutMs === BATCH_TIMEOUT_MAX_MS
        ? "history-capped"
        : "history";
  const {
    cmd,
    argv,
    cwd,
    env: specEnv,
    // `--related` narrowing applies ONLY to the initial, complete invocation. A
    // targeted retry already carries its own explicit file list in extraArgs, and
    // appending the selection there would widen the very run that exists to isolate
    // one file. (The passing-verdict cache keys on the full argv, so a narrowed run
    // gets a distinct identity and can never be replayed as a full-suite pass.)
  } = spawnSpecFor(spawnTask, [
    ...context.guardArgs,
    ...extraArgs,
    ...(extraArgs.length === 0 ? (spawnTask.relatedFiles ?? []) : []),
  ]);
  const childEnv = {
    ...process.env,
    ...(specEnv ?? {}),
    VITEST_MAX_WORKERS: String(allocation.workers),
    VITEST_MAX_FORKS: String(allocation.workers),
    VITEST_MAX_THREADS: String(allocation.workers),
  };
  let cacheIdentity = null;
  let cacheDecision = null;
  // Only the initial, complete task invocation is reusable. A targeted/fresh retry is evidence
  // used to classify a failure from THIS candidate, never a new passing verdict for the whole
  // task. That distinction prevents a one-file retry from being replayed as a full-suite pass.
  if (
    TASK_VERDICT_CACHE_ENABLED &&
    extraArgs.length === 0 &&
    scriptOverride == null
  ) {
    if (context.cacheProvenance?.ok) {
      cacheIdentity = buildPassingTaskVerdictIdentity({
        taskKey: taskKey(context.t),
        command: {
          cmd,
          argv,
          cwd,
          scriptText: spawnTask.ws.scripts[spawnTask.script] ?? null,
        },
        // Hashing happens inside the helper; raw environment values (including credentials) are
        // never written to the cache. Keeping the COMPLETE env is conservative: an unfamiliar
        // variable cannot silently become relevant without invalidating reuse.
        environment: childEnv,
        gateConfig: {
          ...taskVerdictGateConfig,
          batchTimeout: {
            ...taskVerdictGateConfig.batchTimeout,
            effectiveMs: taskTimeoutMs,
            source: taskTimeoutSource,
          },
        },
        dependencyHash: context.cacheProvenance.hash,
      });
      cacheDecision = decidePassingTaskVerdict({
        enabled: true,
        cacheRead: taskVerdictCacheRead,
        entry: taskVerdictCacheRead.cache.entries[taskKey(context.t)],
        identity: cacheIdentity,
      });
    } else {
      cacheDecision = {
        hit: false,
        reason: context.cacheProvenance?.reason ?? "provenance-incomplete",
      };
    }
    if (cacheDecision.hit) {
      return Promise.resolve({
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null,
        __elapsedMs: 0,
        __timeoutMs: taskTimeoutMs,
        __timeoutSource: taskTimeoutSource,
        __durationEstimateMs: taskDurationMs,
        __cacheStatus: "hit",
        __cacheReason: cacheDecision.reason,
        __cacheIdentity: cacheIdentity,
      });
    }
  }
  const startedAt = Date.now();
  return new Promise((resolveRun) => {
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let spawnError = null;
    let captureError = null;
    let settled = false;
    let watchdogTimedOut = false;
    const child = spawn(cmd, argv, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Own a process group so the watchdog can reap npm -> shell -> vitest ->
      // worker descendants together. A direct-child kill leaves descendants
      // holding these capture pipes and made a 45m timeout close at 49.8m.
      detached: true,
    });
    const progressTask = JSON.stringify(taskKey(spawnTask));
    const emitProgress = (state, status = null, signal = null) => {
      // Deliberately bypass the ordered replay buffer: this tiny, self-identifying marker is
      // the live pulse consumed by green-checkpoint while the child output remains captured.
      // It contains no child bytes, so concurrent tasks cannot misattribute test output.
      rawErrSync(
        `AFFECTED_TASK_PROGRESS state=${state} task=${progressTask} ` +
          `elapsedSec=${Math.floor((Date.now() - startedAt) / 1000)} capturedBytes=${capturedBytes} ` +
          `timeoutMs=${taskTimeoutMs} timeoutSource=${taskTimeoutSource} ` +
          `durationEstimateMs=${taskDurationMs ?? "unknown"} ` +
          `exitStatus=${status ?? "pending"} signal=${signal ?? "pending"}`,
      );
    };
    const watchdogTimer = setTimeout(() => {
      if (settled) return;
      watchdogTimedOut = true;
      emitProgress("watchdog-firing");
      killSpawnedProcessTree(child, BATCH_KILL_SIGNAL);
    }, taskTimeoutMs);
    watchdogTimer.unref?.();
    let progressTimer = null;
    const scheduleProgress = () => {
      progressTimer = setTimeout(() => {
        if (settled) return;
        emitProgress("running");
        scheduleProgress();
      }, 60_000);
      progressTimer.unref?.();
    };
    emitProgress("started");
    scheduleProgress();
    const capture = (chunks) => (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes <= MAX_CAPTURE_BYTES) {
        chunks.push(chunk);
      } else if (!captureError) {
        captureError = Object.assign(
          new Error(
            `${taskKey(context.t)} exceeded the ${MAX_CAPTURE_BYTES}-byte capture ceiling`,
          ),
          { code: "ENOBUFS" },
        );
        killSpawnedProcessTree(child, BATCH_KILL_SIGNAL);
      }
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      if (progressTimer) clearTimeout(progressTimer);
      emitProgress(
        watchdogTimedOut
          ? "watchdog-killed"
          : captureError
            ? "capture-killed"
            : spawnError
              ? "spawn-error"
              : "finished",
        status,
        signal,
      );
      resolveRun({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error: captureError ?? spawnError,
        __elapsedMs: Date.now() - startedAt,
        __timeoutMs: taskTimeoutMs,
        __timeoutSource: taskTimeoutSource,
        __durationEstimateMs: taskDurationMs,
        __watchdogTimedOut: watchdogTimedOut,
        ...(cacheDecision
          ? {
              __cacheStatus: "miss",
              __cacheReason: cacheDecision.reason,
              __cacheIdentity: cacheIdentity,
            }
          : {}),
      });
    });
  });
}

function emitCapturedTaskOutput(t, r, allocation, label = "initial") {
  outSync(
    `    scheduler ${label}: lane=${allocation.lane} workers=${allocation.workers} ` +
      `memoryMb=${allocation.memoryMb}`,
  );
  if (r.__cacheStatus) {
    outSync(
      `    AFFECTED_TASK_CACHE task=${JSON.stringify(taskKey(t))} ` +
        `status=${r.__cacheStatus} reason=${r.__cacheReason}`,
    );
  }
  if (r.error) errSync(`>>> ${t.ws.name} spawn error: ${r.error.message}`);
  writeAllSync(1, r.stdout ?? "");
  writeAllSync(2, r.stderr ?? "");
  logLine(r.stdout ?? "");
  logLine(r.stderr ?? "");
}

const initialPool = await runBudgetedTasks(taskContexts, {
  ...SCHEDULER_CONFIG,
  estimateMs: (context) =>
    durationEstimate(durationHistory, taskKey(context.t)),
  runTask: (context, allocation) => runCapturedTask(context, allocation),
});
for (const scheduled of initialPool.results) {
  if (scheduled.value.__cacheStatus !== "hit") {
    recordLeg(scheduled.task.t, scheduled.value.__elapsedMs);
  }
}
outSync(formatTaskBudgetObservedMarker(initialPool.stats));
try {
  // Re-read immediately before the atomic replace so a run that finished while this one was
  // active is less likely to be overwritten. Atomicity guarantees readers never parse a torn
  // file; losing one racing observation merely leaves the prior estimate in place.
  const latestHistory = readDurationHistory(TASK_DURATION_HISTORY_PATH);
  const nextHistory = mergeDurationHistory(
    latestHistory,
    initialPool.results
      .filter(({ value }) => value.__cacheStatus !== "hit")
      .map(({ task, value }) => ({
        key: taskKey(task.t),
        durationMs: value.__elapsedMs,
      })),
  );
  writeDurationHistoryAtomic(
    TASK_DURATION_HISTORY_PATH,
    nextHistory,
    RUN_TOKEN,
  );
} catch (error) {
  errSync(
    `>>> duration history unavailable (continuing without it): ${error.message}`,
  );
}

for (const scheduled of initialPool.results) {
  const { t, isQuarantined, guardArgs } = scheduled.task;
  outSync(
    `\n>>> ${t.ws.name} :: ${npmAvailable ? "npm " : ""}run ${t.script}${isQuarantined ? " [QUARANTINED]" : ""}`,
  );
  if (guardArgs.length) {
    outSync(
      `    (EI-11132 empty-suite guard: on-disk test files found — this run's --passWithNoTests is disabled)`,
    );
  }
  emitCapturedTaskOutput(t, scheduled.value, scheduled.allocation);
  // Retries intentionally begin only here, after `initialPool` has drained. A retry gets the
  // same global envelope through the same scheduler, but because it is the only admitted task
  // it can use the full effective worker budget without exceeding either ceiling.
  const run = async (extraArgs = [], scriptOverride = null) => {
    const retryPool = await runBudgetedTasks([scheduled.task], {
      ...SCHEDULER_CONFIG,
      runTask: (context, allocation) =>
        runCapturedTask(context, allocation, extraArgs, scriptOverride),
    });
    const retry = retryPool.results[0];
    recordLeg(t, retry.value.__elapsedMs);
    emitCapturedTaskOutput(t, retry.value, retry.allocation, "retry");
    return retry.value;
  };
  /**
   * The fresh-process retry, PC_TEST_LANE-aware (plan gate-suite-speedup-2026-08-12, P-003).
   *
   * MEASURED 2026-08-13: a `test:lane-pure` leg failed 14 files; 10 of them passed when
   * re-run isolated, i.e. they were artifacts of the lane's own fork reuse, not defects.
   * The retry below re-ran them by re-invoking THE SAME SCRIPT, so `PC_TEST_LANE=pure`
   * was still set, the files ran non-isolated again, and the pollution reproduced — the
   * retry could not absorb the one class it was best placed to absorb.
   *
   * That is not merely a wasted retry. A surviving lane artifact is counted as a failing
   * FILE, and both this script's FRESH_RETRY_MAX_FILES and green-checkpoint's
   * ISOLATION_MAX_FILES are 15 — past which a red is declared a real regression and the
   * gate's isolation rescue is skipped entirely. So lane artifacts spend a budget that
   * exists to absorb genuine load flakes, and 10 of 15 is most of it.
   *
   * Fix: for a lane leg, retry the failed files under the DEFAULT `test` script. It sets
   * no lane env, so it resolves the default config and is ISOLATED BY CONSTRUCTION — the
   * same property the gate's own isolation and confirming co-execution re-runs rely on
   * (resolveWorkspaceTestInvocation). A genuine failure still fails this isolated re-run
   * exactly as it would with no lane split at all, so nothing is absorbed that shouldn't be.
   */
  const runFreshRetry = async (files) =>
    hasLaneSplit(t.ws) ? run(files, "test") : run(files);
  let r = scheduled.value;
  // WI-38300: absorption state, read by the reporting branch far below to decide whether a
  // surviving failure is a confident red or load-suspect residue. Declared out here because
  // the retry branch and the reporting branch are separate statements over the same task.
  let absorptionRan = false;
  let load1AtRerun = null;
  let residualFiles = [];
  const watchdogTimedOut =
    r.__watchdogTimedOut === true ||
    (r.__watchdogTimedOut == null &&
      isWatchdogTimeout(
        { signal: r.signal, status: r.status, elapsedMs: r.__elapsedMs },
        { killSignal: BATCH_KILL_SIGNAL, timeoutMs: r.__timeoutMs },
      ));
  if (watchdogTimedOut) {
    // Not retried: a wedge that reproduces once burns the exact same window again, turning
    // one bounded stall back into an unbounded-feeling one. Report it plainly and move on —
    // the next batch already proceeds either way (this is a per-batch bound, not a run-wide
    // one), so the gate stays attributable instead of a silent 2h hang.
    // EI-20268851913189733: this message used to ASSERT the spin cause. It has two
    // possible causes and it can TELL THEM APART from evidence it already holds, so
    // it must not send the reader hunting a file that does not exist. A spin STALLS
    // (progress stops, one file never finishes); an over-long suite keeps completing
    // files right into the wall. Observed 2026-08-12: operator-core reported 3302 of
    // 4063 files with the last ones passing in 9-15ms each — a timeout, reported as
    // a spin, which cost a real investigation.
    // A path mention is not progress: only Vitest's per-file rollup rows prove
    // that a file completed. Also preserve null for streamed TTY output; turning
    // it into an empty string would falsely report "no progress" and invite a
    // spin diagnosis from evidence this process never captured.
    const capturedOut =
      typeof r.stdout === "string" || typeof r.stderr === "string"
        ? `${r.stdout ?? ""}${r.stderr ?? ""}`
        : null;
    const progressEvidence = parseBatchProgress(capturedOut);
    const progress = formatBatchProgress(
      progressEvidence,
      classifyBatchProgress(progressEvidence),
    );
    errSync(
      `\n>>> ${t.ws.name} :: ${t.script} WATCHDOG-KILLED after ${(r.__elapsedMs / 60000).toFixed(1)}m with no exit ` +
        `(effective timeout=${r.__timeoutMs}ms source=${r.__timeoutSource} ` +
        `durationEstimateMs=${r.__durationEstimateMs ?? "unknown"}; ` +
        `AFFECTED_BATCH_TIMEOUT_MS=${process.env.AFFECTED_BATCH_TIMEOUT_MS ?? "unset"}). ` +
        `NOT retrying. ${progress}. ` +
        `A synchronously-spinning test remains a hypothesis only when a live progress signal shows progress ` +
        `stopped; captured output without timing must not be used to assert a spin ` +
        `(EI-19370814345784324).`,
    );
  } else if (
    retryFailed &&
    // EI-20107132436867486: retry ONLY what this run would actually count against itself.
    // This used to read `r.status !== 0 && retryFailed && !isQuarantined`, which re-ran a
    // task the reporting branch below was about to forgive as non-gating — announcing a
    // WORKSPACE-shaped "FAILED — retrying once" for one guard that examined nothing, on
    // every run against a git-sync-swept tree (i.e. the normal case). Same predicate as the
    // reporting branch, so the two cannot drift apart again.
    isGatingFailure(
      classifyTaskExit({
        status: r.status,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: t.notCheckedIsNonGating,
        quarantined: isQuarantined,
      }),
    )
  ) {
    const failedFiles = parseFailedFiles(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    if (failedFiles.length > 0 && failedFiles.length <= FRESH_RETRY_MAX_FILES) {
      errSync(
        `\n>>> ${t.ws.name} FAILED — fresh-process re-run of ${failedFiles.length} failed file(s) (HARDEN-GATE flake absorption): ${failedFiles.join(", ")}`,
      );
      r = await runFreshRetry(failedFiles);
      absorptionRan = true;
      // WI-38300: sampled AFTER the re-run, deliberately. loadavg()[0] is a TRAILING 1-minute
      // average, so a post-sample describes the load the RE-RUN itself experienced — the thing
      // in question. A pre-sample describes the first pass, which is already known to have been
      // high (it is what enabled absorption) and therefore discriminates nothing.
      load1AtRerun = loadavg()[0];
      // ⚠ Keep the line above IMMEDIATELY after the re-run — affected-tests-load-suspect.test.ts
      // pins the two within 500 chars, because a trailing average sampled late stops describing
      // the run it is meant to describe. Add prose BELOW this point, never between them.
      // The residue is what SURVIVED the re-run, not what entered it. This used to be
      // assigned `failedFiles` — the PRE-retry set — while formatLoadSuspectNotice states
      // the files "failed the first pass AND the fresh-process re-run". Measured
      // 2026-08-13: a lane leg failed 14 files, the re-run left 4, and the notice named
      // all 14 — pointing gate triage at 10 files that had just passed. Re-parse the
      // RE-RUN's own output; fall back to the pre-retry set only when nothing parses, so
      // an unparseable failure still names something rather than silently naming none.
      const rerunFailedFiles = parseFailedFiles(
        `${r.stdout ?? ""}${r.stderr ?? ""}`,
      );
      residualFiles =
        rerunFailedFiles.length > 0 ? rerunFailedFiles : failedFiles;
      if (r.status === 0)
        errSync(
          `>>> ${t.ws.name} failed files passed in a fresh process — counted as a FLAKE, not a failure.`,
        );
    } else {
      errSync(
        `\n>>> ${t.ws.name} FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)`,
      );
      r = await run();
      absorptionRan = true;
      // Post-sample for the same reason as the scoped arm above.
      load1AtRerun = loadavg()[0];
      if (r.status === 0)
        errSync(
          `>>> ${t.ws.name} passed on retry — counted as a FLAKE, not a failure.`,
        );
    }
  }
  // EI-18653696921091778: an exit code of 0 does NOT imply "no reds" — vitest can
  // print a summary reporting failed test files/tests yet still exit 0 (observed
  // live 2026-07-25, root cause not yet pinned down; load-dependent per the report).
  // Cross-check the captured summary text against the exit code whenever we have
  // it; a nonzero failed-count with a "successful" exit is treated as a failure —
  // fail-safe, since trusting the suspicious green would silently hold the gate
  // open for a genuinely red suite (the opposite mistake — an occasional false
  // failure on a truly-clean run — just costs a rerun, and is loudly explained).
  if (r.status === 0 && captureOutput()) {
    const summary = parseSummaryFailedCounts(
      `${r.stdout ?? ""}${r.stderr ?? ""}`,
    );
    if (summary && (summary.testFiles > 0 || summary.tests > 0)) {
      errSync(
        `\n⚠⚠ ${t.ws.name} exited 0 but its own vitest summary reports ${summary.testFiles} failed test file(s) / ` +
          `${summary.tests} failed test(s) — treating as a FAILURE (EI-18653696921091778: an exit-code/summary ` +
          `mismatch must never read as green). Full run log: ${RUN_LOG_PATH}`,
      );
      r = { ...r, status: 1 };
    }
  }
  if (r.status !== 0) {
    // WI-37830: the classification is a pure, unit-tested helper because every branch below
    // runs ONLY once a task has already failed — on a healthy tree that is never, so this
    // gate-protecting logic was previously reachable by no test and checkable only by
    // reading it. The retry decision above consults the SAME helper.
    const exitClass = classifyTaskExit({
      status: r.status,
      notCheckedExitCode: EXIT_NOT_CHECKED,
      notCheckedIsNonGating: t.notCheckedIsNonGating,
      quarantined: isQuarantined,
    });
    if (exitClass === "not-checked") {
      // "I could not look" is not "I found a violation" — see EXIT_NOT_CHECKED above. Reported
      // LOUDLY rather than swallowed: the guard really did verify nothing, and a reader who
      // takes this run as coverage of the strand class would be wrong. It just is not the
      // failing task's fault, and it cannot be fixed by anyone downstream of it.
      errSync(
        `\n  ⚠ ${t.ws.name} :: ${t.script} examined NOTHING (exit ${EXIT_NOT_CHECKED}) — not gating.\n` +
          `    This guard infers its subject from the working diff, which is empty in a clean\n` +
          `    checkout, so it has no opinion here. It speaks in a LOCAL run, where the edit\n` +
          `    that triggers it is still uncommitted.`,
      );
    } else if (exitClass === "quarantined") {
      quarantinedFailed++;
      errSync(`  (quarantined failure — not gating)`);
    } else {
      failed++;
      failedTaskNames.push(`${t.ws.name} :: ${t.script}`);
      // EI-19395701908500754: name the FILES, not just the workspace. Delegated to a
      // unit-tested helper for the same reason as the rendering below — this runs only
      // when the gate is already red, so nothing here is exercised on a green run.
      // EI-20342691406630303: a watchdog kill does not imply that the child produced no
      // parseable failure rows. A long suite can print its final Vitest summary immediately
      // before the watchdog lands. Always parse the captured bytes; `batch-timeout` is only
      // the reason to use when attribution genuinely has no file to return.
      const a = attributeFailedTask({
        workspace: t.ws.name,
        task: `${t.ws.name} :: ${t.script}`,
        captured: captureOutput(),
        output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
        fallbackReason: watchdogTimedOut ? "batch-timeout" : undefined,
      });
      failedFileEntries.push(...a.entries);
      unattributedTasks.push(...a.unattributed);
      transformCulpritPaths.push(...a.transformCulprits);
      // EI-19332556961886184: surface a timeout signature right here, in the log a
      // triager reads, instead of letting it collapse into an indistinguishable red.
      // Only possible when the child's output was captured (a non-TTY / background
      // caller — see captureOutput() above); an interactive TTY run streamed straight
      // to the terminal via stdio:'inherit' and r.stdout/r.stderr are unset here.
      if (captureOutput()) {
        const timedOutCount = countTimeoutSignatures(
          `${r.stdout ?? ""}${r.stderr ?? ""}`,
        );
        if (timedOutCount > 0) {
          timedOutTasks++;
          errSync(
            `  ⚠ this run's output shows ${timedOutCount} vitest "timed out" signature(s) — this ` +
              `failure may be a wall-clock timeout artifact (load-correlated), NOT necessarily a real ` +
              `assertion failure. Verify before treating as a regression: grep the run log for ` +
              `"timed out in" (see AGENT-ENV/CLAUDE.md's assertion-vs-timeout recipe).`,
          );
        }
      }
      // WI-38300: absorption's own premise ("a real regression fails both runs; a load flake
      // almost never fails twice in a row") does NOT hold for the load class that AUTO-ENABLES
      // absorption — the retry is immediate, so it re-runs under the same load that caused the
      // first failure. When that is what happened, say so instead of rendering the residue as a
      // confident regression. The task stays COUNTED either way (residualGates); only the
      // attribution changes. Classification lives in a pure helper because this branch runs only
      // once the gate is already red — on a healthy tree, never.
      const residualClass = classifyResidualFailure({
        absorptionRan,
        rerunStatus: absorptionRan ? r.status : null,
        load1AtRerun,
        threshold: AUTO_RETRY_LOAD1_THRESHOLD,
      });
      if (residualClass === "load-suspect") {
        loadSuspectTasks.push({
          task: `${t.ws.name} :: ${t.script}`,
          load1AtRerun,
          files: residualFiles,
        });
        errSync(
          formatLoadSuspectNotice({
            workspace: t.ws.name,
            load1AtRerun,
            threshold: AUTO_RETRY_LOAD1_THRESHOLD,
            files: residualFiles,
          }),
        );
      }
    }
  }
  // Cache only a clean FIRST-PASS result after the exit-code/summary cross-check above. A retry
  // that rescued a flake is useful evidence for this candidate but deliberately not strong
  // enough to suppress the next candidate's full task. Hits retain their existing entry.
  if (
    TASK_VERDICT_CACHE_ENABLED &&
    scheduled.value.__cacheStatus === "miss" &&
    scheduled.value.status === 0 &&
    r.status === 0 &&
    !absorptionRan &&
    scheduled.value.__cacheIdentity
  ) {
    taskVerdictCacheUpdates[taskKey(t)] = passingTaskVerdictEntry(
      scheduled.value.__cacheIdentity,
    );
  }
}

if (
  TASK_VERDICT_CACHE_ENABLED &&
  Object.keys(taskVerdictCacheUpdates).length > 0
) {
  try {
    // Re-read immediately before replace so another serialized pipeline observation is retained.
    // The root-scoped filename prevents unrelated checkout roots from contending in the first
    // place; merge-before-rename protects same-root followers without weakening atomicity.
    const latest = readPassingTaskVerdictCache(TASK_VERDICT_CACHE_PATH);
    const merged = mergePassingTaskVerdictUpdates(
      latest.cache,
      taskVerdictCacheUpdates,
    );
    writePassingTaskVerdictCacheAtomic(
      TASK_VERDICT_CACHE_PATH,
      merged,
      RUN_TOKEN,
    );
    outSync(
      `AFFECTED_TASK_CACHE_WRITE status=stored entries=${Object.keys(taskVerdictCacheUpdates).length} ` +
        `path=${TASK_VERDICT_CACHE_PATH}`,
    );
  } catch (error) {
    errSync(
      `AFFECTED_TASK_CACHE_WRITE status=failed reason=${error.message} (continuing without reuse)`,
    );
  }
}

// ── D-021/P-002: serial-equivalent task work under the budgeted scheduler ────
// Emitted every run, so the answer is re-measured rather than inherited — a number this cheap to
// re-measure should never be quoted from memory. `--print-affected` runs zero tasks, so this
// emits nothing there and the tests pinning that path's marker-less output stay satisfied by
// construction rather than by an explicit exemption. Arithmetic + wording live in the helper.
for (const line of formatSerialPhaseSummary(taskLegs)) outSync(line);

// ── P-009: Wire cargo tests into the same cadence as vitest/playwright ────────
// Run the Rust/cargo native suite reporter after all vitest tasks complete.
// The reporter records test results in harness_shared.test_runs (framework='cargo')
// so the Tests tab covers the desktop shell. Fail-soft per D-007: never affects
// the overall exit code, only the ledger write.
outSync(
  `\n>>> Running cargo tests (P-009: papercusp-desktop/src-tauri Rust suite)...`,
);
try {
  const cargoReporter = resolve(ROOT, "scripts", "report-cargo-tests.mjs");
  const cargoManifest = resolve(
    ROOT,
    "papercusp-desktop",
    "src-tauri",
    "Cargo.toml",
  );
  // EI-15802: this suite runs LAST, so on a non-TTY (background-task) caller its
  // own summary is exactly what a fixed-size tail buffer retains — capture +
  // log it the same way as the vitest tasks above, instead of 'inherit'-only,
  // so an earlier JS/TS failure isn't hidden behind a trailing cargo pass/fail.
  const cargoRun = captureOutput()
    ? spawnSync(
        process.execPath,
        [cargoReporter, "--manifest-path", relative(ROOT, cargoManifest)],
        {
          cwd: ROOT,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
        },
      )
    : spawnSync(
        process.execPath,
        [cargoReporter, "--manifest-path", relative(ROOT, cargoManifest)],
        {
          cwd: ROOT,
          stdio: "inherit",
        },
      );
  if (captureOutput()) {
    writeAllSync(1, cargoRun.stdout ?? "");
    writeAllSync(2, cargoRun.stderr ?? "");
    logLine(cargoRun.stdout ?? "");
    logLine(cargoRun.stderr ?? "");
  }
  if (cargoRun.status !== 0) {
    const cargoOutput = `${cargoRun.stdout ?? ""}${cargoRun.stderr ?? ""}`;
    const termination = detectCargoTermination(cargoOutput);
    if (termination) {
      errSync(
        `>>> cargo test suite was killed by ${termination.signalName} (signal ${termination.signal}); ` +
          "this is an external process termination, not a compiler diagnostic — re-run before source triage.",
      );
    } else {
      errSync(`>>> cargo test suite exited with code ${cargoRun.status}`);
    }
    if (!quarantined.has("papercusp-desktop")) {
      failed++;
      failedTaskNames.push("papercusp-desktop :: cargo test");
      // Not a vitest task — the vitest FAIL-row parser can never attribute it to files.
      const cargoFailure = {
        task: "papercusp-desktop :: cargo test",
        reason: "non-vitest",
      };
      if (termination)
        cargoFailure.reason = `killed-by-signal:${termination.signalName}`;
      unattributedTasks.push(cargoFailure);
    }
  }
} catch (err) {
  errSync(`>>> cargo test runner error: ${err.message}`);
  failed++;
  failedTaskNames.push("papercusp-desktop :: cargo test (runner error)");
  unattributedTasks.push({
    task: "papercusp-desktop :: cargo test (runner error)",
    reason: "non-vitest",
  });
}

if (quarantinedFailed) {
  errSync(`\n${quarantinedFailed} quarantined task(s) failed (not gating).`);
}
// EI-18796017307093897: a caller observed a background `npm run test:affected`
// job report "completed, exit code 0" while this SAME run's own log said "1
// non-quarantined task(s) failed" — i.e. the wrapper/notification layer that
// relayed the exit code disagreed with what this script actually decided.
// Nothing in this script's own control flow can produce that divergence (the
// `process.exit(1)` below is inseparable from the failure message that
// precedes it — see the regression test asserting exactly that), so the most
// robust fix isn't inside this file's exit-code logic, it's giving every
// caller a way to verify the TRUE verdict independent of exit-code plumbing
// elsewhere. Emit one canonical, greppable, machine-parseable line — mirroring
// `scripts/test-files.mjs`'s `TEST_FILE_RESULT` line — whose `status` token is
// derived from the exact same `failed`/`quarantinedFailed` counters that
// decide the exit code below, so an agent, a gate, or a background-task
// notifier can grep RUN_LOG_PATH for this line instead of trusting a
// possibly-misreported exit code alone.
const resultLine = (status) =>
  `AFFECTED_TESTS_RESULT status=${status} tasks=${tasks.length} failed=${failed} quarantinedFailed=${quarantinedFailed} timedOutTasks=${timedOutTasks}`;
if (failed) {
  errSync(`\n${failed} non-quarantined task(s) failed:`);
  for (const name of failedTaskNames) errSync(`  - ${name}`);
  // EI-19332556961886184: named separately from the list above so a triager sees the
  // distinction without having to scroll back through each task's own output.
  if (timedOutTasks) {
    errSync(
      `${timedOutTasks} of the ${failed} failed task(s) show a vitest "timed out" signature — ` +
        `verify before assuming a real assertion break (see the per-task note above / grep the run log).`,
    );
  }
  // EI-19395701908500754: the per-FILE break set, stated by the run itself. `resultLine`'s
  // failed=N counts TASKS; a triager needs FILES, and until now the only per-file signal in
  // a green-checkpoint verdict log was the gate's own prose — which its self-tests emit too,
  // so mining it returned fixture paths. Rendered by a unit-tested helper rather than inline:
  // this path runs only when the gate is ALREADY red, so a fault here would surface at the
  // worst possible moment and no source-text assertion could have caught it.
  // WI-37607: `transformCulprits` makes the summary lead with the PARSE failure when one is
  // present. Without it a peer's mid-write reads as `coverage=complete` over N innocent files —
  // measured 21 on this runner and 7 on the gate's own checkout, both stamped complete.
  for (const line of renderFailingFilesSummary({
    runToken: RUN_TOKEN,
    failedTaskCount: failed,
    entries: failedFileEntries,
    unattributed: unattributedTasks,
    transformCulprits: transformCulpritPaths,
  })) {
    errSync(line);
  }
  // WI-38300: a SEPARATE greppable advisory, deliberately NOT a field on resultLine — that
  // line's shape is pinned by affected-tests-result-line.test.ts and parsed by
  // green-checkpoint, and widening a VERDICT contract to carry an ADVISORY is how advisories
  // come to be read as verdicts. Emitted only when there is load-suspect residue, so its
  // absence is the ordinary case and costs no output.
  if (loadSuspectTasks.length) {
    errSync(
      formatLoadSuspectMarker({
        tasks: loadSuspectTasks.length,
        files: loadSuspectTasks.reduce((n, e) => n + e.files.length, 0),
        maxLoad1: Math.max(...loadSuspectTasks.map((e) => e.load1AtRerun)),
        threshold: AUTO_RETRY_LOAD1_THRESHOLD,
      }),
    );
  }
  errSync(resultLine("failed"));
  terminalEmitted = true;
  errSync(`Full run log: ${RUN_LOG_PATH}`);
  process.exit(1);
}
outSync("\nAll affected tests passed.");
outSync(resultLine("passed"));
terminalEmitted = true;
outSync(`Full run log: ${RUN_LOG_PATH}`);
