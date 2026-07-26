/**
 * The green-checkpoint job — plan release-gate-ready-branch-2026-06-04, Phase 1
 * (D-003); staging→main model since staging-branch-pipeline-2026-06-06.
 * Fast-forwards the green pin (`releaseRef`, now the **`main` branch**) to the
 * newest integration commit that is GREEN, so `main` only ever holds known-good,
 * tests-passing states — with zero manual curation. git-sync keeps committing
 * ALL WIP to the integration branch (`staging`, unchanged); this advances the
 * green `main` behind it. The gap between staging HEAD and `main` IS the
 * untested buffer. Requires `main` NOT to be checked out in the integration
 * tree (it lives on `staging`), so `git branch -f main` is free to move.
 *
 * Two correctness rules from the plan's Risks:
 *   - "Green" is measured in an ISOLATED checkout of the CANDIDATE commit (the
 *     dedicated checkpoint worktree), NEVER the churning shared tree — otherwise
 *     a peer's in-flight edit pollutes test:affected.
 *   - It only ever FAST-FORWARDS the green pin (advanceReady refuses non-FF), and
 *     reads a FIXED candidate sha up front, so it can't race git-sync's commits.
 *
 * Effects are injected (CheckpointDeps) so the orchestration is unit-tested
 * without running the (heavy) suite; realCheckpointDeps wires the real ones.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, readFileSync, rmSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  revParse,
  refExists,
  isAncestor,
  advanceReady,
  revListBefore,
  commitUnixTime,
  changedFiles,
  type AdvanceResult,
} from './git-ops';
import { toolingRoot, type ReleaseConfig } from './release-config';
import { runPerfGate, perfGatePolicyFromEnv } from './perf-gate';
import { runDesktopPerfGate, desktopPerfGatePolicyFromFlags } from './desktop-perf-gate';
import { runDeltaGate, deltaGatePolicyFromEnv } from './delta-gate';
import { heldGateAlert } from './held-gate-alarm';

export interface CheckpointDeps {
  /** (Re)build the isolated checkpoint checkout at `ref` (setup-release-checkout.sh). */
  setupTree(ref: string): Promise<void>;
  /** load-flake-isolation-2026-06-23: re-run ONE originally-failing test file in
   *  ISOLATION (a fresh `vitest run <file>` at single concurrency, same tree+env) to
   *  decide load-flake-vs-real-break. Optional + injected so the realCheckpointDeps
   *  wiring is unit-testable without running real vitest; realCheckpointDeps shells it
   *  through the CheckpointExec seam. */
  isolationRun?(input: { workspace: string; file: string }): Promise<IsolationResult>;
  /** worker-pool-crash-absorption-2026-06-25 (WI-806): re-run ONE whole workspace's
   *  suite at REDUCED concurrency (a single fork) after the gate run crashed a vitest
   *  worker fork (OOM/ENOMEM under fleet load) and emitted NO per-file `FAIL` lines —
   *  so parseFailingFilesByWorkspace found zero files to re-run in isolation. The
   *  per-file isolation path can't fire (no signature); this re-runs the affected
   *  WORKSPACE once to decide load-crash-flake vs real break. Optional + injected so
   *  realCheckpointDeps's wiring is unit-testable without running real vitest. */
  workspaceRerun?(input: { workspace: string }): Promise<WorkspaceRerunResult>;
  /** Run the "green" suite in `treeDir` against `base`; resolve green=true on pass.
   *  `failingTests` is a STABLE signature of what failed (test files / workspaces),
   *  extracted from the FULL output — used to dedup the release-fixer dispatch by the
   *  failure rather than the candidate sha (P-012).
   *  `flakeSuspects` (load-flake-isolation-2026-06-23): files that FAILED under the
   *  gate's 8-fork load but PASSED on an isolated single-concurrency re-run — i.e. the
   *  suite was red only from box-weather, so `green` is reported true and these files
   *  are surfaced (drives the P-009 flake ledger / quarantine nudge). */
  runGreen(
    treeDir: string,
    base: string | null,
  ): Promise<{
    green: boolean;
    summary: string;
    failingTests?: string[];
    flakeSuspects?: string[];
    /** Workspace-mapped failures, so a re-run knows the cwd for each file. Feeds the
     *  stale-candidate re-triage; absent ⇒ no re-triage (the red is treated as real). */
    failingFiles?: FailingFile[];
    /** WI-4957: the FULL-suite output log this run wrote (an exact reference a verdict
     *  consumer can open directly, rather than re-deriving it from the checkpoint log dir
     *  and a timestamp). Absent when the write itself failed (best-effort — see the
     *  realCheckpointDeps writer). */
    logPath?: string;
    /** isolation-retry-resilience-2026-07-19 (EI-15849): the load-flake / worker-crash
     *  absorption attempt's own verdict note, present WHENEVER that absorber actually ran —
     *  regardless of whether it flipped the gate green. Before this, a NOT-absorbed
     *  attempt's reasoning existed only as a console.log inside the detached checkpoint
     *  child process (truncated to ~200-500 chars by the parent's own logging), making a
     *  held-gate incident undiagnosable after the fact without grepping raw suite logs that
     *  don't even contain the isolation re-run's own output. */
    isolationNote?: string;
  }>;
  /** Fast-forward `ready` to `candidate` (advanceReady). */
  advance(candidate: string): Promise<AdvanceResult>;
  /** Publish `ready` to origin. */
  push(ref: string): Promise<void>;
  broadcast(summary: string, body?: string): Promise<void>;
  /** Resolve the CURRENT tip of the integration branch (may be newer than `candidate`,
   *  which the quiet-cut deliberately holds back). Optional: absent ⇒ no re-triage. */
  resolveTip?(): Promise<string | null>;
  /** Re-run EXACTLY these failing files at `ref`, for the stale-candidate re-triage.
   *  Optional: absent ⇒ every red is treated as real (today's behaviour). */
  runTestsAtRef?(ref: string, files: FailingFile[]): Promise<{ pass: boolean; summary: string }>;
  /** EI-18669342433807110: called right before a stale-candidate auto-refire RECURSES (which can
   *  run a full suite again, minutes, before this process returns) — merges a marker into
   *  `gate_health` so a concurrent reader (coord:orient, dev:why) can tell the cached red for
   *  `info.fromCandidate` is being re-verified RIGHT NOW instead of dispatching someone at tests
   *  this very run may be about to disprove. Optional / best-effort: existing test stubs need not
   *  provide it; realCheckpointDeps wires it to release/in-flight-retriage.ts's merge write. */
  recordInFlightRetriage?(info: {
    fromCandidate: string;
    refiringCandidate: string;
    refireAttempt: number;
    maxRefires: number;
    failingFiles: string[];
  }): Promise<void>;
  /** Age of the deployed release pin + how far it trails tip, for the staleness alarm.
   *  Optional: absent ⇒ alarm never fires. */
  deployStaleness?(): Promise<{ pinAgeMs: number; commitsBehind: number } | null>;
  /** release-pipeline-resilience-2026-06-09 P-002: open a durable, human-facing
   *  `release-not-green` escalation on red. Transition-only (no-op if one is
   *  already open) so the hourly tick doesn't re-open it while the gate stays
   *  red. Optional so existing test stubs need not provide it. */
  escalate?(summary: string, body: string): Promise<void>;
  /** Resolve any open `release-not-green` escalation — the gate recovered. */
  clearEscalation?(): Promise<void>;
  /** docs-audit #2: how long has the gate been held red (ms), or null if it isn't
   *  currently escalated (first red of a fresh hold). Drives the rising-urgency
   *  re-broadcast so a long-held gate gets LOUDER instead of going silent. */
  heldGateMs?(): Promise<number | null>;
  /** F2 (round-4 P-031): perf-regression deploy gate. Runs post-runGreen / pre-advance
   *  on a GREEN candidate: if the operator is in a definitive per-thread wedge right now,
   *  WARN (default — still advance) or BLOCK (only when the owner armed block-mode). Optional
   *  + flag-gated (a no-op `pass` unless PAPERCUSP_PERF_GATE=1) so existing stubs need not
   *  provide it and the default deploy behaviour is unchanged. */
  perfGate?(candidate: string): Promise<{ action: 'pass' | 'warn' | 'block'; summary: string }>;
  /** desktop-performance-suite-2026-07-20 P-011: the desktop-UI perf gate. Runs
   *  post-runGreen / pre-advance on a GREEN candidate: if the latest persisted
   *  desktop-perf run (desktop_perf_runs, P-010) shows a budgeted interaction /
   *  route / RSS regression, WARN (default — still advance) or BLOCK (only when
   *  block-mode is armed, which V1 never does — warn-not-block until trusted).
   *  Optional + FLAG-gated (FLAGS.DESKTOP_PERF_GATE, default ON; a no-op `pass`
   *  when off or when no run is recorded) so existing stubs need not provide it. */
  desktopPerfGate?(candidate: string): Promise<{ action: 'pass' | 'warn' | 'block'; summary: string }>;
  /** P-016 (agent-tool-delta-protocol D-008): the delta-protocol SAFETY gate.
   *  Runs post-runGreen / pre-advance on a GREEN candidate: if the production
   *  semantic-delta flag is ON but the Lane-C scenarios (S23/S24/S25) are not
   *  recorded-green-and-fresh, WARN (default) or BLOCK (owner-armed). Optional +
   *  flag-gated (a no-op `pass` unless PAPERCUSP_DELTA_GATE=1) so existing stubs
   *  need not provide it and the default deploy behaviour is unchanged. */
  deltaGate?(candidate: string): Promise<{ action: 'pass' | 'warn' | 'block'; summary: string }>;
  /** EI-11118 (cupboard-public-release P-009 durable fix): the Cupboard prod-
   *  hygiene gate. Runs post-runGreen / pre-advance on a GREEN candidate: scans
   *  the LIVE prod Cupboard storefront for E2E/smoke test-junk rows (the
   *  psu-fed-e2e-* / cupboard-verify-smoke / octocat-etc. pattern purged once in
   *  P-009) and WARNs (default — still advance) or BLOCKs (only when the owner
   *  armed block-mode) on a re-accumulation. Optional; default-ON unless
   *  PAPERCUSP_CUPBOARD_HYGIENE_GATE=0 (see cupboard-hygiene-gate.ts for why this
   *  one gate defaults on, unlike perf/delta-gate) — existing stubs that omit it
   *  behave exactly as before (no call site fires without the dep). */
  cupboardHygieneGate?(candidate: string): Promise<{ action: 'pass' | 'warn' | 'block'; summary: string }>;
  /** P-016 (release-pipeline-resilience-2026-06-09 D-010): the commit shas between
   *  `from` (exclusive) and `to` (inclusive), OLDEST-FIRST, full shas — the batch the
   *  green-checkpoint is gating. Used by the longest-green-PREFIX salvage to know which
   *  prefixes exist. Optional + injected so existing stubs are unaffected. */
  commitsInRange?(from: string, to: string): Promise<string[]>;
  /** P-016 (D-010): the workspace NAMES affected by the diff `from..to` (changed files
   *  → workspaces → reverse-dep expansion — `affected-tests.mjs --print-affected`), or
   *  null when it can't be computed (caller then declines the salvage, never guesses).
   *  Pure git+graph, NO test run, so the prefix scan is cheap. Optional + injected. */
  affectedWorkspacesForRange?(from: string, to: string): Promise<string[] | null>;
  /** WI-2997 (EI-7443 follow-up, item 3): per-file 7d historical flake stats for
   *  the CURRENTLY failing test files, so the not-green broadcast/escalate can
   *  show flake-vs-regression immediately instead of the release-fixer
   *  re-deriving it by hand via `dev:build_status` / testFlakeRollup. NAMING
   *  NOTE: distinct from the load-flake-isolation `flakeSuspects` concept above
   *  (files that failed under THIS run's concurrent load but passed in
   *  isolation) — this is the historical CROSS-RUN `harness_shared.test_runs`
   *  rollup. Optional + injected (like the other DB-backed deps here) so
   *  existing stubs need not provide it; best-effort at the call site (any
   *  error there just skips the annotation, never blocks the red path). */
  flakeLookup?(
    files: string[],
  ): Promise<Record<string, { fails: number; passes: number; bothStatusShas: number; isSuspect: boolean }>>;
  /** EI-10800: emit an awaitable gate-verdict event (release:green / green-checkpoint:red,
   *  each global + pipeline-scoped). AWAITED at every call site so the fire completes before
   *  runGreenCheckpoint returns. Historically each verdict was a fire-and-forget
   *  `void import('.../events/await/engine').then(emit)` — on the GREEN full-advance path the
   *  function returns IMMEDIATELY after kicking it off, so the short-lived checkpoint process
   *  tore down before the detached dynamic import resolved and `release:green:<pipeline>` fired
   *  via `event` ZERO times in its whole history (87 timeouts / 0 events) while the RED path —
   *  saved only incidentally by a trailing `await deps.escalate` — fired normally. Optional +
   *  injected like the other effects here (existing stubs need not provide it) AND — the point —
   *  the emit is finally UNIT-TESTABLE; the hard dynamic import is exactly what hid this for 8
   *  days. realCheckpointDeps wires it to emitAwaitedEvent(source:'green-checkpoint').
   *
   *  EI-12457: `cancelSiblingKeysFor` names the MUTUALLY-EXCLUSIVE opposite-outcome key(s)
   *  (a green emit names the red keys and vice versa) — threaded to
   *  emitAwaitedEvent's cancelSiblingKeysFor so a subscriber's now-dead wait on the
   *  opposite outcome is retired the instant this candidate resolves, instead of
   *  living until its own timeout. */
  emitEvent?(input: { key: string; summary: string; payload: unknown; cancelSiblingKeysFor?: string[] }): Promise<void>;
  /** EI-13992: apply any pending `libs/papercusp/libs/db/sql/*.sql` migrations to the
   *  live dev PG the suite is about to run against, BEFORE runGreen — breaks the
   *  self-sustaining deadlock "gate red → main frozen → boot-only migration apply
   *  never re-fires → dev PG drifts behind → tests asserting new columns fail →
   *  gate stays red" (this gate run happens on its own schedule regardless of
   *  whether main is frozen, so the dev PG can no longer drift far enough to
   *  red-pin the gate on a missing-column failure). Idempotent + never throws
   *  (schema_migrations tracker makes a no-op re-run cheap; a failed migration is
   *  logged and left pending, same as the boot-time apply). Optional so existing
   *  test stubs need not provide it; realCheckpointDeps wires it to the real
   *  applyPendingMigrationsNow(). */
  ensureMigrationsCurrent?(): Promise<{ applied: number; failed: { file: string; error: string }[] } | null>;
  /** EI-18666996942859193: both-directions package-lock.json ⇄ node_modules diff on the
   *  checkpoint tree, run right after `setupTree` / before `runGreen` — so a drifted tree
   *  ("N required package(s) missing from node_modules") surfaces as its own DISTINCT,
   *  self-explaining log line, instead of the only symptom being an unrelated-looking
   *  failing test file (exactly what cost two agents hours on 2026-07-25: the failing file
   *  was `lib/memory/session-extraction-llm.test.ts`, which says nothing about a missing
   *  `ollama` package). Purely diagnostic — it never itself holds the gate; a real missing
   *  package still shows up as its own real test failures, this just NAMES the root cause
   *  alongside them. Optional so existing test stubs need not provide it; realCheckpointDeps
   *  wires it to `checkLockTreeDrift()` (packages/operator-core/lib/boot-integrity-preflight),
   *  scoped to `cfg.checkpointRoot` (the tree this run actually judges). */
  checkTreeDrift?(): Promise<{ ok: boolean; missing: string[]; extraneous: string[]; skipped: boolean; error?: string } | null>;
  log(s: string): void;
  /** WI-4957: THIS run's own identity — independent of `candidate` (the sha it judges).
   *  Two runs can judge the exact same candidate (a re-fire after an infra hiccup, or the
   *  routine and a manual run racing before WI-1562's proactive refusal existed); `runId`
   *  is what lets a consumer tell those verdicts apart instead of conflating them by sha
   *  alone. Threaded into every emitted event payload + the returned CheckpointResult.
   *  realCheckpointDeps stamps a fresh randomUUID() per process; existing test stubs may
   *  omit it (payloads then carry `runId: null` rather than throwing). */
  runId?: string;
}

export interface CheckpointResult {
  advanced: boolean;
  candidate: string;
  from: string | null;
  green: boolean | null;
  reason: 'up-to-date' | 'not-fast-forward' | 'not-green' | 'advanced' | 'advanced-prefix' | 'create-failed' | 'perf-held' | 'desktop-perf-held' | 'delta-held' | 'cupboard-hygiene-held' | 'skipped-locked';
  /** WI-4494: THIS RUN recorded its own verdict (gate_health + the pipeline event), because its
   *  launcher stamped the record target into the env. Read by the routine, which then does NOT
   *  record it a second time (that would double-count the red streak). Absent ⇒ the caller records,
   *  exactly as before WI-4494 — which is what keeps an old-CLI/new-routine skew safe.
   *  Set by the CLI entrypoint, never by runGreenCheckpoint itself. */
  recorded?: boolean;
  /** P-016 (D-010): on a PARTIAL advance (reason 'advanced-prefix'), the sha `main`
   *  was FF'd to — the longest GREEN prefix — while `candidate` stays the red TIP (so
   *  failingTests + the release-fixer still target the real failure). Absent otherwise. */
  advancedTo?: string;
  summary?: string;
  /** P-012: a stable signature of what failed (test files / workspaces) on the
   *  not-green path, so the release-fixer dispatch dedups by FAILURE, not candidate sha. */
  failingTests?: string[];
  /** The individual failing CASE names, for the human reading the verdict. Never used
   *  as a signature (see extractFailingTestNames). */
  failingTestNames?: string[];
  /** Stale-candidate re-triage (2026-07-10): was this red still broken at TIP? Present
   *  on the not-green path whenever the re-triage could run. `stale-candidate` means the
   *  gate judged a commit whose failures peers had already fixed. */
  retriage?: RedTriage & { tip: string | null };
  /** load-flake-isolation-2026-06-23: files the gate ABSORBED as load-flakes — they
   *  failed under the 8-fork checkpoint load but PASSED in an isolated re-run, so the
   *  gate is GREEN despite the initial red. Surfaced so the P-009 ledger can tally a
   *  chronically-flaky file and the owner can quarantine it accountably. */
  flakeSuspects?: string[];
  /** WI-4957: this run's own identity (see CheckpointDeps.runId) — carried on every
   *  verdict so a consumer can distinguish two runs that happen to judge the same
   *  candidate, and so an events:await can bind to an EXACT run when that matters. */
  runId?: string;
  /** WI-4957: the full-suite output log THIS run wrote, when produced (not-green paths
   *  only — an advance/up-to-date verdict has no failing suite output to reference). */
  logPath?: string;
  /** isolation-retry-resilience-2026-07-19 (EI-15849): see CheckpointDeps.runGreen's
   *  `isolationNote` — carried through verbatim so a NOT-absorbed verdict's reasoning is
   *  durably recorded (release-actions.ts persists it via buildCheckpointDetail), not lost
   *  to a truncated console log. */
  isolationNote?: string;
}

export interface CheckpointRunLock {
  acquired: boolean;
  lockDir: string;
  owner?: { pid?: number; startedAt?: string; detail?: string };
  release(): void;
}

/**
 * EI-7646: the pipeline identity stamped on gate-verdict events + used as the
 * pipeline-scoped event-key segment (`release:green:<pipeline>`). The basename of
 * the integration root distinguishes the co-hosted pipelines on one box (e.g.
 * `papercusp` vs `papercup`); sanitized so it is always a safe key segment.
 */
export function pipelineName(integrationRoot: string): string {
  const base = path.basename(path.resolve(integrationRoot));
  return (base.replace(/[^a-zA-Z0-9_-]/g, '-') || 'default').slice(0, 64);
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A checkpoint run is bounded by the routine's suite timeout
 *  (GREEN_CHECKPOINT_SUITE_TIMEOUT_MS in harness/routines/release-actions.ts — 55m), so a
 *  lock held longer than THIS is DEFINITIVELY stale and is reclaimed even if its recorded
 *  pid still looks alive. Without this, a run that hung past its timeout / crashed without
 *  releasing / left a lock whose pid got RECYCLED to an unrelated live process wedged
 *  the gate forever — the dead-pid check alone never reclaims a recycled-pid lock. This
 *  is the silent multi-hour fleet-deploy freeze (green-checkpoint-stale-lock-2026-06-26).
 *  INVARIANT: keep this STRICTLY GREATER than the suite timeout AND SELF_WATCHDOG_MS, so a
 *  run is killed by the timeout (or, parent-dead, by its own watchdog) and releases its lock
 *  before the lock is reclaimable — else an overlapping hourly fire spawns a 2nd concurrent
 *  suite and OOMs the box. Raised 45m→65m in lock-step with the 25m→55m timeout bump
 *  (green-checkpoint-timeout-vs-forks-2026-06-27), then 65m→190m with the 55m→120m bump
 *  (EI-7553: under full-fleet load the multi-pass suite measured 60–90m, so the 55m/65m pair
 *  killed healthy runs pre-verdict; 190m sits above BOTH the 120m timeout and the 180m
 *  self-watchdog, making the full chain coherent for the first time:
 *  timeout 120m < self-watchdog 180m < stale-reclaim 190m). The dead-pid check still
 *  reclaims a crashed run's lock immediately; THIS threshold only gates the recycled-pid
 *  case, so the longer window costs nothing in the common crash path. */
export const CHECKPOINT_LOCK_STALE_MS = 190 * 60_000;

/** WI-1319 root fix (c): a SELF-BOUND wall-clock watchdog, armed by THIS process
 *  (green-checkpoint.ts) itself, independent of the supervising parent
 *  (release-actions.ts's `runScript`, which SIGTERMs the whole process group at
 *  GREEN_CHECKPOINT_SUITE_TIMEOUT_MS=55m + escalates to SIGKILL 15s later).
 *
 *  That parent-side kill relies on the PARENT (the bg-host / routines-tick node
 *  process) staying alive long enough for its in-memory `setTimeout` to fire.
 *  This process is spawned `detached: true` (its own process-group leader) —
 *  detached is exactly what lets it SURVIVE the parent's death/restart, which
 *  means a parent restart mid-suite (routine bg-host crash/deploy/manual
 *  restart) silently drops the ONLY thing that was going to kill a hung run:
 *  the child (this process + any vitest/tsx workers it spawned, which inherit
 *  ITS pgid since they're plain non-detached `runCmd` spawns) is orphaned,
 *  keeps holding the run-lock, and — if genuinely deadlocked (e.g. wedged in
 *  ep_poll awaiting a vitest child that never returns, 0 CPU) — never releases
 *  it or exits. The run-lock's own stale-reclaim (CHECKPOINT_LOCK_STALE_MS,
 *  time-based) lets a LATER attempt proceed, but does nothing to the orphan
 *  itself — it lingers, leaking RSS/FDs/docker containers, and each repeat
 *  orphan compounds the resource pressure on this memory-constrained box. This
 *  froze `main` ~97h on 2026-06-30 even with the reaper's 60m no-output window
 *  in place (that window only cancels the DBOS-level bookkeeping row — it has
 *  no reach into an already-orphaned OS process tree).
 *
 *  Fix: THIS process arms its own watchdog on startup. If it fires, the parent
 *  is presumed dead (a live parent's SIGTERM+SIGKILL would have landed well
 *  before this — see the margin below), so this process releases its own lock,
 *  emits a loud red verdict through the normal checkpoint result path, and then
 *  SIGKILLs its OWN process group (`-process.pid`, covering itself + every
 *  runCmd-spawned vitest/tsx worker in one shot) — no orphan can outlive it.
 *
 *  INVARIANT: strictly greater than the parent's full kill window (120m SIGTERM
 *  + 15s SIGKILL escalation), so a LIVE parent's kill always wins the race and
 *  this watchdog is a pure backstop, never a competing timeout. Keep it at or
 *  above 3h for long-load checkpoint runs so the outer launch cap cannot cut the
 *  suite off before the red verdict path can run. Also strictly less than
 *  CHECKPOINT_LOCK_STALE_MS (190m) so THIS run terminates itself (and frees its
 *  lock) before a peer attempt would need to force-reclaim it. */
export const SELF_WATCHDOG_MS = 3 * 60 * 60_000;

export function snapshotCheckpointProcessGroup(pid: number): string | null {
  try {
    const r = spawnSync(
      'ps',
      ['-o', 'pid=,ppid=,pgid=,stat=,etime=,pcpu=,pmem=,command=', '-g', String(pid)],
      { encoding: 'utf8', maxBuffer: 64 * 1024 },
    );
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.error || !out) return null;
    return out;
  } catch {
    return null;
  }
}

/** WI-4528 (EI-10800 class): how long the self-watchdog waits for an ASYNC `onFire` — the loud
 *  RED-verdict emit + the urgent attention-notify — to actually SETTLE before it delivers the
 *  guaranteed SIGKILL. Negligible against the 3h watchdog, and BOUNDED so a wedged/hanging emit
 *  can never block the kill this watchdog exists to deliver. */
export const SELF_WATCHDOG_ONFIRE_GRACE_MS = 8_000;

/** Await `p`, but never longer than `graceMs` — resolves when `p` settles OR the grace elapses,
 *  whichever comes first, and swallows a rejection (the caller proceeds either way). This is what
 *  lets armSelfWatchdog land an async last-gasp emit without ever letting it wedge the kill. */
async function awaitBounded(p: Promise<unknown>, graceMs: number, log: (msg: string) => void): Promise<void> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(() => {
          log(
            `[green-checkpoint] self-watchdog onFire hook did not settle within ${graceMs}ms — ` +
              `proceeding to SIGKILL (the red verdict may not have been emitted)`,
          );
          resolve();
        }, graceMs);
      }),
    ]);
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
  }
}

/** WI-1319 root fix (c) — the watchdog described above, ACTUALLY ARMED. (The
 *  constant above shipped 2026-07-02 with the full design in its comment, but
 *  nothing ever called `setTimeout` — this closes that gap.) Call once, right
 *  after `acquireCheckpointRunLock` succeeds, and `cancel()` it on every normal
 *  exit path (success or handled failure) so a healthy run never lets the timer
 *  fire. `unref()`'d so an already-scheduled watchdog can never itself keep the
 *  process alive past a clean exit — it only matters if the process is STILL
 *  running (i.e. actually wedged) when it goes off.
 *
 *  `kill`/`pid`/`log`/`ms` are injected for tests — a unit test must never let
 *  this construct a real multi-minute timer or call the real `process.kill`. */
export function armSelfWatchdog(
  lock: { release: () => void },
  opts: {
    ms?: number;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    pid?: number;
    log?: (msg: string) => void;
    snapshotProcessGroup?: (pid: number) => string | null;
    /** WI-4528 (EI-10800 class): onFire MAY BE ASYNC. It emits the loud RED verdict that parked
     *  agents wake on (`checkpoint:await` → `green-checkpoint:red:<pipeline>`) plus the urgent
     *  attention-notify — both are async DB/IO writes. We BOUND-AWAIT a returned promise before
     *  the SIGKILL below, because fire-and-forgetting it here is a GUARANTEED lost wake: the kill
     *  targets our OWN process group on the very next synchronous line, so the event loop never
     *  turns again and the emit's continuation never runs. (A sync/absent onFire keeps the
     *  original fully-synchronous kill path.) */
    onFire?: () => void | Promise<void>;
    /** Max wait for an async `onFire` to settle before the guaranteed kill (injected in tests).
     *  Defaults to SELF_WATCHDOG_ONFIRE_GRACE_MS. */
    onFireGraceMs?: number;
  } = {},
): { cancel: () => void } {
  const ms = opts.ms ?? SELF_WATCHDOG_MS;
  const pid = opts.pid ?? process.pid;
  const kill = opts.kill ?? ((p: number, sig: NodeJS.Signals) => process.kill(p, sig));
  const log = opts.log ?? ((m: string) => console.error(m));
  const snapshotProcessGroup = opts.snapshotProcessGroup ?? snapshotCheckpointProcessGroup;
  const onFireGraceMs = opts.onFireGraceMs ?? SELF_WATCHDOG_ONFIRE_GRACE_MS;
  const timer = setTimeout(() => {
    log(
      `[green-checkpoint] self-watchdog fired after ${Math.round(ms / 60_000)}m with no normal exit — ` +
        `presumed-dead parent (release-actions.ts's runScript never landed its SIGTERM+SIGKILL); ` +
        `releasing the run-lock and killing this process's OWN group (pid ${pid}) so no orphan can outlive it`,
    );
    try {
      const snapshot = snapshotProcessGroup(pid);
      if (snapshot) {
        log(`[green-checkpoint] self-watchdog process-group snapshot before SIGKILL:\n${snapshot}`);
      }
    } catch {
      /* diagnostic-only */
    }
    try {
      lock.release();
    } catch {
      /* best-effort — a missing/already-gone lock must not stop the kill below */
    }
    const doKill = () => {
      try {
        kill(-pid, 'SIGKILL'); // negative pid → the whole group (this process + every runCmd-spawned vitest/tsx worker)
      } catch {
        /* group already gone */
      }
    };
    let fired: void | Promise<void>;
    try {
      fired = opts.onFire?.();
    } catch {
      /* best-effort — emit the loud red verdict first, even if the hook fails */
      fired = undefined;
    }
    // WI-4528 (EI-10800 class): if onFire went async, its emit is still IN FLIGHT right now. The
    // kill below SIGKILLs our OWN process group, so the event loop would never turn again and the
    // emit would be lost with CERTAINTY (not merely raced) — every agent parked on the red verdict
    // would silently hang to its own timeout. Let it LAND first, bounded, then kill regardless.
    if (fired && typeof (fired as PromiseLike<void>).then === 'function') {
      void awaitBounded(fired as Promise<void>, onFireGraceMs, log).then(doKill, doKill);
    } else {
      doKill();
    }
  }, ms);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

/** PER-ROOT run-lock dir (2026-07-02): the bare `.green-checkpoint-run.lock` made every
 *  lineage sharing the DEFAULT ~/.papercusp/checkpoint-logs serialize on ONE lock — the stale
 *  papercup-root lineage's back-to-back ~40-min suites held it across EVERY papercusp hourly
 *  fire (11+ consecutive 'skipped-locked', `main` frozen ~21h, deploys dead — WI-1508 is
 *  quiescing that lineage; this makes the gate immune to the contention class regardless).
 *  Same per-root pattern as checkpointUnitForRoot (release-checkpoint-launch.ts): the SAME
 *  root still single-flights (cron-vs-manual, the OOM guard the lock exists for), while
 *  DIFFERENT roots stop contending — they already isolate via their own checkouts +
 *  MemoryMax'd runs. The old unsuffixed name is left to old-lineage code; no interference. */
export function checkpointRunLockDir(logDir: string, integrationRoot: string): string {
  let h = 0;
  for (let i = 0; i < integrationRoot.length; i++) h = (h * 31 + integrationRoot.charCodeAt(i)) >>> 0;
  return path.join(logDir, `.green-checkpoint-run-${h.toString(36)}.lock`);
}

export function acquireCheckpointRunLock(
  lockDir: string,
  opts: {
    pid?: number;
    isPidAlive?: (pid: number) => boolean;
    /** Reclaim a held lock older than this even if its pid looks alive. Default
     *  CHECKPOINT_LOCK_STALE_MS. Injected for tests. */
    staleAfterMs?: number;
    /** Clock seam — used for BOTH the lock's recorded `startedAt` and the over-age
     *  check, so they share one timeline (injected in tests). */
    now?: () => number;
  } = {},
): CheckpointRunLock {
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultPidAlive;
  const now = opts.now ?? (() => Date.now());
  const staleAfterMs = opts.staleAfterMs ?? CHECKPOINT_LOCK_STALE_MS;
  const token = randomUUID();
  mkdirSync(path.dirname(lockDir), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid, startedAt: new Date(now()).toISOString(), token }));
      return {
        acquired: true,
        lockDir,
        release: () => {
          try {
            const raw = readFileSync(path.join(lockDir, 'owner.json'), 'utf8');
            const owner = JSON.parse(raw) as { token?: string };
            if (owner.token === token) rmSync(lockDir, { recursive: true, force: true });
          } catch {
            // If the owner file vanished, the lock was already gone.
          }
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw e;
      let owner: { pid?: number; startedAt?: string; detail?: string } = {};
      try {
        owner = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8')) as typeof owner;
      } catch {
        owner = { detail: 'owner metadata unreadable' };
      }
      // Hold the lock for a LIVE owner — unless it has outlived the max run age, in
      // which case it is reclaimed regardless of apparent pid liveness (hung-past-timeout,
      // crashed-without-release, or recycled-pid — see CHECKPOINT_LOCK_STALE_MS).
      const ageMs = owner.startedAt ? now() - Date.parse(owner.startedAt) : NaN;
      const overAge = Number.isFinite(ageMs) && ageMs > staleAfterMs;
      if (typeof owner.pid === 'number' && isPidAlive(owner.pid) && !overAge) {
        return { acquired: false, lockDir, owner, release: () => {} };
      }
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  return { acquired: false, lockDir, owner: { detail: 'could not acquire after stale lock cleanup' }, release: () => {} };
}

/**
 * EI-10680: builds the SIGTERM/SIGINT handler a live run installs so an external "stop this
 * run" (systemctl --user stop, e.g. release-checkpoint-launch's replaceStale path) deterministically
 * releases the run-lock before this process exits — regardless of whether Node's OS-default
 * terminate-on-signal behaviour is still in effect (it is silently disabled the moment ANY
 * listener is registered for the same signal anywhere in-process, e.g. by vitest's own
 * worker-pool cleanup, which this run's programmatic vitest invocation can trigger). Without
 * this, a killed-but-not-yet-exited run can hold its file lock past its systemd unit's "stop"
 * job completing, so a caller's replaceStale (stop the stale run, then relaunch) relaunches
 * straight into "skipped-locked" against the very run it believed it had just stopped
 * (confirmed live 2026-07-13 — the SAME pid reported "already running" on two consecutive
 * replaceStale attempts).
 *
 * Pure + injectable (`releaseAndExit`/`log`) so the release-on-signal behaviour is unit-testable
 * without spawning a real process or sending a real signal.
 */
export function createTerminationSignalHandler(
  releaseAndExit: (code: number) => void,
  log: (msg: string) => void = (m) => console.error(m),
): (signal: NodeJS.Signals) => void {
  return (signal: NodeJS.Signals): void => {
    log(`[green-checkpoint] received ${signal} — releasing run-lock and exiting (pid ${process.pid})`);
    releaseAndExit(143);
  };
}

/** The marker the green-checkpoint CLI prints its CheckpointResult JSON behind, so the
 *  release-actions routine parses one delimited line instead of brace-slicing the whole
 *  stdout (P-008). MUST stay in sync with the literal in release-actions.ts. */
export const GREEN_CHECKPOINT_RESULT_MARKER = '__GREEN_CHECKPOINT_RESULT__';

/** Strip SGR colour codes. The suite runs under a pty-less pipe but vitest still
 *  colourizes (FORCE_COLOR in the fleet env), and EVERY line-anchored matcher below
 *  would otherwise see `\x1b[41m FAIL \x1b[0m …` and miss: a red verdict on
 *  2026-07-10 carried `failingTests: []` for exactly this reason (0 raw matches, 5
 *  after stripping), sending triage at the wrong test for hours. Strip first, match
 *  second — always. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex -- SGR codes are the thing being removed.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Extract a stable failure signature from the FULL suite output (NOT the 2000-char
 *  tail, which can truncate the markers). Covers every shape the gate's runners emit:
 *    - vitest failed-tests section:  ` FAIL  src/x.test.tsx > suite > case`
 *    - vitest per-file rollup:       ` ❯ src/x.test.tsx (9 tests | 8 failed) 4435ms`
 *    - affected runner workspaces:   ` >>> @papercusp/web FAILED`
 *  The rollup line is the load-bearing one: vitest prints only the first few `FAIL`
 *  lines but a `❯ … | N failed)` for EVERY failing file, so a 17-failure run is fully
 *  named. Used for the release-fixer dedup, the quarantine check, and (now) the
 *  stale-candidate re-triage, which can only re-run tests it can name. */
export function extractFailingTests(out: string): string[] {
  const clean = stripAnsi(out);
  const set = new Set<string>();
  for (const m of clean.matchAll(/^\s*FAIL\s+(\S+)/gm)) set.add(m[1]);
  for (const m of clean.matchAll(/^\s*❯\s+(\S+)\s+\(\d+\s+tests?[^)]*\|\s*\d+\s+failed\)/gm)) set.add(m[1]);
  for (const m of clean.matchAll(/>>>\s+(\S+)\s+FAILED\b/g)) set.add(m[1]);
  return [...set].sort().slice(0, 50);
}

/** The individual failing CASE names (`× renders the …`), for humans reading a verdict.
 *  Deliberately separate from `extractFailingTests`: that one returns a stable FILE /
 *  workspace signature (consumed by dedup, quarantine, partial-green and re-triage),
 *  and folding case names into it would break every one of those matchers. */
export function extractFailingTestNames(out: string): string[] {
  const clean = stripAnsi(out);
  const set = new Set<string>();
  for (const m of clean.matchAll(/^\s*×\s+(.+?)(?:\s+\d+ms)?\s*$/gm)) set.add(m[1].trim());
  for (const m of clean.matchAll(/^\s*FAIL\s+\S+\s+>\s+(.+?)\s*$/gm)) set.add(m[1].trim());
  return [...set].sort().slice(0, 50);
}

/** Max failing case names quoted per file in an isolation log line — keeps one
 *  pathological file (a 200-case suite) from burying the rest of the verdict. */
export const ISOLATION_MAX_NAMED_CASES = 3;

/** EI-18673560248447615: the failing CASE names attributed to the FILE they failed in.
 *
 *  `extractFailingTestNames` returns a FLAT list across the whole run, which is fine for
 *  the canary but useless to the isolation loop — that loop reasons one file at a time and
 *  needs to name the cases for THAT file. Without this, the checkpoint log says a file
 *  "still failed" and (since EI-18669336904251384) that load was not the cause, but never
 *  WHAT failed: the case name lives only in the separate multi-thousand-line full-suite log
 *  under ~/.papercusp/checkpoint-logs/. Reading `× keeps audited active surfaces free of
 *  direct cyan literals 173ms` on the isolation line itself ends triage immediately.
 *
 *  Parses vitest's per-file rollup structure: a `❯ <file> (N tests | M failed)` header
 *  followed by that file's case rows. Bare `❯ <group>` lines (nested describes, no
 *  `(N tests | …)` suffix) are NOT file headers and must not re-key the accumulator. */
export function extractFailingCasesByFile(out: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of stripAnsi(out).split('\n')) {
    const fileHeader = /^\s*❯\s+(\S+)\s+\(\d+\s+tests?[^)]*\|\s*\d+\s+failed\)/.exec(rawLine);
    if (fileHeader) {
      current = fileHeader[1];
      if (!byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (!current) continue;
    const failedCase = /^\s*×\s+(.+?)(?:\s+\d+ms)?\s*$/.exec(rawLine);
    if (failedCase) {
      const names = byFile.get(current)!;
      const name = failedCase[1].trim();
      if (!names.includes(name)) names.push(name);
    }
  }
  return byFile;
}

/** Render the failing cases for one file as a log suffix, or '' when none were parsed
 *  (a build break, a non-vitest red, or output shapes this parser doesn't cover — the
 *  caller's line must still read correctly with nothing appended). */
export function describeFailingCases(cases: string[] | undefined): string {
  if (!cases || cases.length === 0) return '';
  const shown = cases.slice(0, ISOLATION_MAX_NAMED_CASES);
  const more = cases.length - shown.length;
  return ` — failed case(s): ${shown.map((c) => `"${c}"`).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/* ── stale-candidate re-triage ────────────────────────────────────────────────
 *
 * The gate judges a QUIET commit (≥240s old), never the tip — so on a tree this
 * busy the candidate is routinely 1-3h behind by the time the suite finishes. Any
 * failure that peers have already fixed in that window reds the gate on work that
 * is no longer broken. On 2026-07-09/10 that cost ~6h of deploy latency across four
 * runs; the manual remedy was identical every time: re-run the failing files at tip,
 * see them pass, re-fire.
 *
 * This is the GENERAL form of the "rename-skew" problem (a vocabulary rename whose
 * tests and components crossed the gate in separate commits, redding every candidate
 * cut inside the window). A lint rule would only have caught renames; classifying the
 * red against the tip catches every kind of skew — renames, peer fixes, half-landed
 * refactors — because it asks the only question that matters: *is this still broken?*
 */

export interface RedTriage {
  /** `stale-candidate` = failed at the judged commit, passes at tip ⇒ not a real red.
   *  `real-red` = reproduces at tip (or there is no newer tip to blame).
   *  `unknown` = could not localize (no named failures / no re-run) ⇒ treat as real. */
  classification: 'real-red' | 'stale-candidate' | 'unknown';
  /** Re-fire the gate on the newer tip? Only ever true for `stale-candidate`, and
   *  only while under the attempt cap — a re-fire storm is worse than a held gate. */
  autoRefire: boolean;
  detail: string;
}

/** Bounded auto-refire cap; 0 disables auto-refire entirely. Default 2 — enough to
 *  ride out the common "peer fixed it 20 minutes ago" case, few enough that a
 *  genuinely broken tip still reaches a human quickly. */
export function autoRefireCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCUSP_GATE_AUTO_REFIRE_CAP;
  if (raw === undefined) return 2;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2;
}

/** Pure verdict classifier. `tipRetest` is the result of re-running EXACTLY the named
 *  failing files at `tip` (null when we could not or did not run it). */
export function classifyRedAgainstTip(input: {
  candidate: string;
  tip: string | null;
  failingTests: string[];
  tipRetest: { ran: boolean; pass: boolean } | null;
  refireAttempts: number;
  maxRefires: number;
}): RedTriage {
  const { candidate, tip, failingTests, tipRetest, refireAttempts, maxRefires } = input;
  if (!tip || tip === candidate) {
    return { classification: 'real-red', autoRefire: false, detail: 'candidate is the tip — nothing newer to blame' };
  }
  if (failingTests.length === 0) {
    return { classification: 'unknown', autoRefire: false, detail: 'no named failing tests — cannot re-run at tip' };
  }
  if (!tipRetest?.ran) {
    return { classification: 'unknown', autoRefire: false, detail: 'tip re-run unavailable' };
  }
  if (tipRetest.pass) {
    const autoRefire = maxRefires > 0 && refireAttempts < maxRefires;
    return {
      classification: 'stale-candidate',
      autoRefire,
      detail:
        `${failingTests.length} failing file(s) PASS at tip ${tip.slice(0, 8)} — the red is stale ` +
        `(candidate ${candidate.slice(0, 8)} predates the fix)` +
        (autoRefire ? `; auto-refiring (attempt ${refireAttempts + 1}/${maxRefires})` : '; refire cap reached'),
    };
  }
  return {
    classification: 'real-red',
    autoRefire: false,
    detail: `failures REPRODUCE at tip ${tip.slice(0, 8)} — genuine red, holding the gate`,
  };
}

/* ── deploy-staleness alarm ───────────────────────────────────────────────────
 * A held gate is loud; a gate that greens but whose PIN never moves is silent. On
 * 2026-07-09/10 the release pin sat ~18h behind tip with owner-priority UI invisible,
 * and the only alarm was the owner asking (twice) where a feature had gone. Age alone
 * is a bad trigger (a quiet Sunday is fine); commits-behind alone is a bad trigger (a
 * busy hour is fine). Fire only when BOTH cross — the tree moved a lot AND the deploy
 * did not follow. */

export interface DeployStalenessThresholds {
  maxPinAgeMs: number;
  maxCommitsBehind: number;
}

export function deployStalenessThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): DeployStalenessThresholds {
  const hours = Number(env.PAPERCUSP_DEPLOY_STALE_HOURS);
  const commits = Number(env.PAPERCUSP_DEPLOY_STALE_COMMITS);
  return {
    maxPinAgeMs: (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3_600_000,
    maxCommitsBehind: Number.isFinite(commits) && commits > 0 ? commits : 20,
  };
}

export interface DeployStalenessVerdict {
  alarm: boolean;
  urgency: 'none' | 'warn' | 'urgent';
  message: string;
}

export function evaluateDeployStaleness(
  input: { pinAgeMs: number; commitsBehind: number; blockingFailures?: string[] },
  thresholds: DeployStalenessThresholds,
): DeployStalenessVerdict {
  const { pinAgeMs, commitsBehind, blockingFailures = [] } = input;
  const ageHours = pinAgeMs / 3_600_000;
  if (pinAgeMs < thresholds.maxPinAgeMs || commitsBehind < thresholds.maxCommitsBehind) {
    return { alarm: false, urgency: 'none', message: '' };
  }
  // Double the age threshold ⇒ this is no longer "the gate is chewing", it is a drought.
  const urgency: 'warn' | 'urgent' = pinAgeMs >= thresholds.maxPinAgeMs * 2 ? 'urgent' : 'warn';
  const blocking = blockingFailures.length
    ? `\n\nBlocking red:\n${blockingFailures.slice(0, 10).map((f) => `  - ${f}`).join('\n')}`
    : '\n\nNo failing tests recorded — the gate may be wedged rather than red.';
  return {
    alarm: true,
    urgency,
    message:
      `${urgency === 'urgent' ? '🚨' : '⚠️'} deploy stale: the release pin is ${ageHours.toFixed(1)}h old and ` +
      `${commitsBehind} commits behind tip. Shipped work is not reaching the running app.${blocking}`,
  };
}

export interface TestQuarantineEntry {
  workspace: string;
  pattern: string | null;
}

export interface QuarantineVerdict {
  allFailuresQuarantined: boolean;
  failingTests: string[];
  quarantined: string[];
}

export function parseTestQuarantine(text: string): TestQuarantineEntry[] {
  const out: TestQuarantineEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [workspace, pattern] = line.split('::');
    if (!workspace) continue;
    out.push({ workspace, pattern: pattern?.trim() || null });
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source);
}

export function isQuarantinedTestFile(file: FailingFile, entries: TestQuarantineEntry[]): boolean {
  for (const entry of entries) {
    if (entry.workspace !== file.workspace) continue;
    if (!entry.pattern) return true;
    if (globToRegExp(entry.pattern).test(file.file)) return true;
  }
  return false;
}

export function applyTestQuarantine(fullOutput: string, failingTests: string[], entries: TestQuarantineEntry[]): QuarantineVerdict {
  const failingFiles = parseFailingFilesByWorkspace(fullOutput);
  if (!failingFiles.length || !entries.length) {
    return { allFailuresQuarantined: false, failingTests, quarantined: [] };
  }

  const byWorkspace = new Map<string, { total: number; quarantined: number }>();
  const quarantinedFiles = new Set<string>();
  const quarantinedLabels: string[] = [];
  for (const file of failingFiles) {
    const current = byWorkspace.get(file.workspace) ?? { total: 0, quarantined: 0 };
    current.total += 1;
    if (isQuarantinedTestFile(file, entries)) {
      current.quarantined += 1;
      quarantinedFiles.add(file.file);
      quarantinedFiles.add(`${file.workspace}::${file.file}`);
      quarantinedLabels.push(`${file.workspace}::${file.file}`);
    }
    byWorkspace.set(file.workspace, current);
  }

  if (!quarantinedLabels.length) {
    return { allFailuresQuarantined: false, failingTests, quarantined: [] };
  }

  const filtered = failingTests.filter((test) => {
    if (quarantinedFiles.has(test)) return false;
    const ws = byWorkspace.get(test);
    if (ws && ws.total > 0 && ws.total === ws.quarantined) return false;
    return true;
  });
  return {
    allFailuresQuarantined: filtered.length === 0 && quarantinedLabels.length === failingFiles.length,
    failingTests: filtered,
    quarantined: quarantinedLabels.sort(),
  };
}

/** A single failing test FILE, paired with the workspace it ran under. The
 *  isolation re-run needs BOTH: the file (to scope `vitest run <file>`) and the
 *  workspace dir (the cwd vitest runs in — the file path is workspace-relative). */
export interface FailingFile {
  /** The workspace package name printed by the affected runner's `>>> <ws> :: …` header. */
  workspace: string;
  /** The test file path as vitest reports it (workspace-relative, e.g. `lib/foo.test.ts`). */
  file: string;
}

/**
 * load-flake-isolation-2026-06-23: parse the FULL affected-runner output into the
 * concrete failing test FILES, grouped by the workspace they ran under, so the
 * isolation re-run can re-run exactly those files at single concurrency.
 *
 * The affected runner sections its output by `>>> <ws> :: npm run <script>` headers
 * (scripts/affected-tests.mjs), then prints that workspace's vitest output beneath —
 * including `FAIL <file>` suite rows and `❯ <file> (… N failed …)` summary rows. A
 * failing file therefore belongs to the MOST RECENT `>>>` header above it. We parse
 * line-by-line, tracking the current workspace, and collect only real test FILES
 * (`.test.`/`.spec.`) — never the bare workspace markers `extractFailingTests` also
 * returns (those aren't files and can't be handed to `vitest run`).
 *
 * Mirrors `parseFailedFiles`'s file regexes in affected-tests.mjs so the two stay in
 * lock-step. Pure + total: empty output ⇒ `[]`, never throws.
 */
export function parseFailingFilesByWorkspace(fullOutput: string): FailingFile[] {
  const TEST_FILE = /\S+\.(?:test|spec)\.[cm]?[jt]sx?/;
  // `>>> <ws> :: npm run <script>` — the affected runner's per-workspace section header.
  const HEADER = /^\s*>>>\s+(\S+)\s+::\s+npm run\b/;
  // `❯ lib/x/y.test.ts (22 tests | 1 failed) 85ms` — a failed-file summary row.
  const SUMMARY_FAIL = new RegExp(`^\\s*❯\\s+(${TEST_FILE.source})\\s+\\([^)]*\\bfailed\\b[^)]*\\)`);
  // `FAIL  lib/x/y.test.ts …` — a failed-suite row (transform/setup errors).
  const SUITE_FAIL = new RegExp(`^\\s*FAIL\\s+(${TEST_FILE.source})\\b`);

  // Strip ANSI FIRST: every matcher below is line-anchored, and vitest colourizes both
  // the rollup and ` FAIL ` rows. Without this the parse silently returned [] on real
  // gate output — which quietly disabled load-flake AND worker-crash absorption (they
  // re-run "the originally failing files", of which there were apparently none). Same
  // root cause as the empty `failingTests` in the 2026-07-10 verdict.
  const lines = stripAnsi(fullOutput).split('\n');

  // Pre-scan: files named by a rollup summary row (SUMMARY_FAIL) inside SOME workspace
  // section. Rollups are child stdout printed inside the child's own section, so their
  // header attribution is trustworthy. Bare ` FAIL ` rows also appear in vitest's
  // "Failed Tests" epilogue, which the gate's captured-stream block-flush can DISPLACE
  // past later workspaces' headers — on 2026-07-17 operator-core's quarantined hyperbee
  // failure re-parsed under @papercupai/gitnexus-bridge as a phantom un-quarantined
  // entry, redding an all-failures-quarantined run. A FAIL row may therefore only
  // INTRODUCE a file the rollups never named (transform/setup errors emit no rollup),
  // never re-attribute a rollup-named file to whatever section its epilogue landed in.
  const rollupFiles = new Set<string>();
  {
    let ws: string | null = null;
    for (const line of lines) {
      const h = HEADER.exec(line);
      if (h) {
        ws = h[1];
        continue;
      }
      const m = SUMMARY_FAIL.exec(line);
      if (m && ws) rollupFiles.add(m[1]);
    }
  }

  const out: FailingFile[] = [];
  const seen = new Set<string>();
  let currentWs: string | null = null;
  for (const line of lines) {
    const h = HEADER.exec(line);
    if (h) {
      currentWs = h[1];
      continue;
    }
    const summary = SUMMARY_FAIL.exec(line);
    const m = summary ?? SUITE_FAIL.exec(line);
    if (m) {
      const file = m[1];
      // A FAIL row naming a rollup-attributed file is either a dup of its rollup pair
      // or a displaced epilogue row under a foreign header — the rollup wins; keeping
      // this pair would manufacture a workspace that never ran the file.
      if (!summary && rollupFiles.has(file)) continue;
      // A file before any `>>>` header (or a non-affected-runner invocation) has no
      // known workspace; skip it — we can't run `vitest run <file>` without a cwd.
      if (!currentWs) continue;
      const key = `${currentWs}\u0000${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ workspace: currentWs, file });
    }
  }
  return out;
}

/** The result of re-running ONE originally-failing file in isolation. */
export interface IsolationResult {
  workspace: string;
  file: string;
  /** true ⇒ the file PASSED on its isolated re-run (a load-flake suspect). */
  passed: boolean;
  /** true ⇒ the isolated re-run itself errored/timed out (verdict undetermined for this file). */
  errored?: boolean;
  /** EI-18669336904251384: wall-clock duration of this attempt, in ms — the near-free
   *  evidence that lets the retry-loop log tell "starved by ambient load" apart from "a
   *  deterministic assertion that fails fast". Optional so a hand-built test fixture
   *  (most of this file's unit tests) need not supply it; its absence just falls back to
   *  the unattributed wording (see ISOLATION_LOAD_STARVATION_MIN_MS). */
  durationMs?: number;
}

/** EI-18669336904251384: the minimum wall-clock time an isolated re-run attempt must have
 *  taken before the retry-loop log may blame "ambient host load" for its failure. A real
 *  process that was genuinely CPU-starved spends real time waiting for a scheduler slot —
 *  it does not fail in single-digit-to-low-double-digit milliseconds. A failure that fast
 *  is a deterministic assertion (a real break, or — as measured on 2026-07-25 — a stale
 *  candidate whose fix already landed at tip), and asserting "ambient host load" for it is
 *  false attribution that teaches the fleet to wait out a red that will never self-heal.
 *  1s is comfortably above vitest's own process/import startup cost (seen at 130ms+ in this
 *  file's own suite) so it never mis-fires on a merely-quick-but-real run. */
export const ISOLATION_LOAD_STARVATION_MIN_MS = 1_000;

export type FlakeVerdict =
  /** every originally-failing file PASSED in isolation ⇒ the red was pure load-flake. */
  | 'all-flakes'
  /** at least one file STILL FAILED in isolation ⇒ a real deterministic break. */
  | 'real-break'
  /** the isolation run couldn't decide (no files parsed, an isolation error) ⇒ trust the original verdict. */
  | 'inconclusive';

export interface FlakeDecision {
  verdict: FlakeVerdict;
  /** files that flaked (failed under load, passed in isolation) — recorded as flake-suspects. */
  flakeAbsorbed: string[];
  /** files that STILL failed in isolation — a real break; the gate must stay red. */
  stillFailing: string[];
}

/**
 * load-flake-isolation-2026-06-23: the PURE flake-vs-real decision. SAFE by
 * construction — it NEVER hides a deterministic bug:
 *   - `real-break`     ⇐ ANY originally-failing file still fails in isolation, OR any
 *                          isolation re-run ERRORED (we cannot prove that file is a flake).
 *   - `all-flakes`     ⇐ we re-ran a non-empty set of files AND every one PASSED cleanly
 *                          (no errors). Only THIS verdict may flip the gate red→green.
 *   - `inconclusive`   ⇐ there were no parseable failing files to re-run (e.g. a build
 *                          break, a non-vitest failure mode). Caller keeps the ORIGINAL
 *                          (red) verdict — uncertainty never flips red→green.
 *
 * The fail-safe bias is deliberate: an errored isolation re-run counts as a real break,
 * not a flake, so a flaky-to-run isolation step can never manufacture a false green.
 */
export function decideFlakeAbsorption(input: {
  originalFailing: FailingFile[];
  isolationResults: IsolationResult[];
}): FlakeDecision {
  const { originalFailing, isolationResults } = input;
  if (originalFailing.length === 0) {
    return { verdict: 'inconclusive', flakeAbsorbed: [], stillFailing: [] };
  }
  const label = (r: { workspace: string; file: string }) => `${r.workspace}::${r.file}`;
  const byKey = new Map(isolationResults.map((r) => [label(r), r]));

  const flakeAbsorbed: string[] = [];
  const stillFailing: string[] = [];
  for (const f of originalFailing) {
    const r = byKey.get(label(f));
    // No result for an originally-failing file, or the re-run errored ⇒ we cannot
    // prove it's a flake ⇒ treat it as still-failing (fail-safe; never flip to green).
    if (!r || r.errored || !r.passed) {
      stillFailing.push(label(f));
    } else {
      flakeAbsorbed.push(label(f));
    }
  }
  const verdict: FlakeVerdict = stillFailing.length > 0 ? 'real-break' : 'all-flakes';
  return { verdict, flakeAbsorbed, stillFailing };
}

/** The most files the isolation step will ever re-run. A broad red (many distinct
 *  failing files) is a real regression, not the box-weather flake this absorbs —
 *  re-running dozens of files would also blow the gate's wall-clock budget. Mirrors
 *  affected-tests.mjs's FRESH_RETRY_MAX_FILES (15). */
export const ISOLATION_MAX_FILES = 15;

/**
 * isolation-retry-resilience-2026-07-19 (EI-15849): the SINGLE-concurrency isolation
 * re-run above only removes the checkpoint suite's OWN 8-fork contention — it does
 * NOTHING about AMBIENT host-wide load from OTHER processes (other pots' gate suites,
 * federation, concurrent SU builds). On a box at loadavg 99+/128-core, a single isolated
 * `vitest run <file>` can itself be CPU-starved and fail/timeout on its first attempt even
 * though the file is perfectly deterministic and would pass the moment the box settles —
 * exactly the incident this const is named for (a 14-file operator-core/endpoint-route
 * cluster reproduced clean in isolation once load had dropped, but the gate had already
 * frozen `main` for hours on the FIRST, load-starved isolation attempt). One bounded retry
 * per file gives a transient ambient-load blip a second chance without weakening the
 * fail-safe guarantee: {@link decideFlakeAbsorption} still requires every file to produce
 * a clean PASS to flip red→green, so a deterministically-broken test — which fails the
 * same way on every attempt — is never absorbed. */
export const ISOLATION_RETRY_MAX = 1;

/** Delay between a failed isolation attempt and its retry. Short — just enough to let a
 *  transient scheduling burst clear, not a real backoff (this is a re-verify, not a
 *  rate-limited API call). */
export const ISOLATION_RETRY_DELAY_MS = 5_000;

/** isolation-retry-resilience-2026-07-19 (EI-15849): overall wall-clock budget for the
 *  WHOLE per-file retry phase (summed across every originally-failing file), NOT a
 *  per-file cap. Bounds the worst-case extra time this hardening can ever add on top of
 *  the existing one-pass isolation cost, so a broad ambient-load incident (many failing
 *  files, each eligible for a retry) can never balloon the checkpoint run past its outer
 *  suite timeout. Once the budget is exhausted, no further retries are attempted — a
 *  file's most-recent result stands, exactly matching pre-retry behavior. Because the
 *  budget can only ever ADD absorption chances (never remove the baseline first-pass
 *  attempt), the worst case never regresses below what the gate did before this fix. */
export const ISOLATION_RETRY_BUDGET_MS = 20 * 60_000;

/** The outcome of the whole flake-absorption attempt — what {@link runGreenCheckpoint}
 *  needs to (maybe) flip the verdict, plus the suspects to surface. */
export interface FlakeAbsorptionOutcome {
  /** true ⇒ the original red was pure load-flake; the caller may report green=true. */
  absorbedToGreen: boolean;
  /** files proven flaky (failed under load, passed in isolation) — surfaced as suspects. */
  flakeSuspects: string[];
  /** human-readable note for the log / broadcast. */
  note: string;
}

/**
 * load-flake-isolation-2026-06-23: orchestrate the flake-vs-real isolation re-run —
 * the SAFE fix for the incident where `runner-aggregate.test.ts` + `scheduler-workspace-
 * scope.test.ts` failed the gate under the 8-fork checkpoint load but PASSED in isolation
 * (and AFFECTED_RETRY_FAILED=1 didn't absorb them). PURE of vitest/exec: the actual
 * re-runner is injected (`isolationRun`), so this orchestration is unit-testable.
 *
 * Bounded + fail-safe — it can only EVER flip red→green when it has POSITIVE proof:
 *   1. Parse the originally-failing FILES (+ their workspaces) from the full output.
 *      None parseable (build break / non-vitest red) ⇒ keep the original red (`false`).
 *   2. A broad red (> {@link ISOLATION_MAX_FILES} files) is treated as a real regression,
 *      NOT a flake ⇒ keep the original red. (Cheap guard + bounds wall-clock.)
 *   3. Re-run each file in isolation. Any re-run that REJECTS is caught and recorded as
 *      `errored` (⇒ that file counts as still-failing in the decision — never a flake).
 *   4. {@link decideFlakeAbsorption}: only `all-flakes` (every file re-ran and PASSED)
 *      flips to green. `real-break` / `inconclusive` keep the gate red.
 *
 * isolation-retry-resilience-2026-07-19 (EI-15849): step 3 above is now ITSELF retried —
 * a file that fails or errors is re-attempted up to {@link ISOLATION_RETRY_MAX} more
 * times (bounded overall by {@link ISOLATION_RETRY_BUDGET_MS} across every file, so a
 * broad ambient-load incident can never balloon past the checkpoint's outer suite
 * timeout), because the SINGLE-concurrency re-run only removes the checkpoint's OWN
 * contention — it does nothing about ambient host-wide load from OTHER processes, which
 * can starve even an isolated re-run on its first attempt. This can only ever ADD
 * absorption chances, never remove the fail-safe: {@link decideFlakeAbsorption} still
 * sees exactly one (the FINAL) result per file, and a deterministically-broken file fails
 * that final result too, on every attempt, so it is never absorbed.
 *
 * The whole attempt is itself wrapped so that ANY unexpected throw defaults to the
 * ORIGINAL (red) verdict — uncertainty NEVER manufactures a false green.
 */
export async function attemptFlakeAbsorption(
  fullOutput: string,
  isolationRun: (input: { workspace: string; file: string }) => Promise<IsolationResult>,
  log: (s: string) => void = () => {},
  opts: {
    /** Extra attempts per file beyond the first. Default {@link ISOLATION_RETRY_MAX}. */
    retryMax?: number;
    /** Delay before each retry. Default {@link ISOLATION_RETRY_DELAY_MS}. Injected for tests. */
    retryDelayMs?: number;
    /** Overall wall-clock budget for the whole retry phase. Default {@link ISOLATION_RETRY_BUDGET_MS}. */
    retryBudgetMs?: number;
    /** Clock seam — injected for tests. Default `Date.now`. */
    now?: () => number;
    /** Sleep seam — injected for tests (never real-sleeps in a unit test). Default a real `setTimeout`. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<FlakeAbsorptionOutcome> {
  const keep = (note: string): FlakeAbsorptionOutcome => ({ absorbedToGreen: false, flakeSuspects: [], note });
  const retryMax = opts.retryMax ?? ISOLATION_RETRY_MAX;
  const retryDelayMs = opts.retryDelayMs ?? ISOLATION_RETRY_DELAY_MS;
  const retryBudgetMs = opts.retryBudgetMs ?? ISOLATION_RETRY_BUDGET_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    // EI-18673560248447615: parsed once up front so every log line below can NAME the
    // cases that failed, instead of sending the reader to the separate full-suite log.
    const casesByFile = extractFailingCasesByFile(fullOutput);
    const originalFailing = parseFailingFilesByWorkspace(fullOutput);
    if (originalFailing.length === 0) {
      return keep('isolation: no parseable failing test files (build break / non-vitest red) — gate stays red');
    }
    if (originalFailing.length > ISOLATION_MAX_FILES) {
      return keep(
        `isolation: ${originalFailing.length} failing files (> ${ISOLATION_MAX_FILES}) — a broad red is a real regression, not a load-flake; gate stays red`,
      );
    }
    log(
      `isolation: re-running ${originalFailing.length} originally-failing file(s) at single concurrency: ${originalFailing
        .map((f) => f.file)
        .join(', ')}`,
    );
    // isolation-retry-resilience-2026-07-19: ONE shared deadline for the whole phase (not
    // per-file), computed once up front, so N failing files can never multiply the retry
    // budget by N — the worst-case extra time this hardening can ever add is bounded.
    const retryDeadline = now() + retryBudgetMs;
    const runOnce = async (f: FailingFile): Promise<IsolationResult> => {
      try {
        return await isolationRun(f);
      } catch (e) {
        // An isolation re-run that ITSELF errored cannot prove the file is a flake →
        // record errored:true so decideFlakeAbsorption counts it as still-failing
        // (unless a retry below still has budget to try again).
        log(`isolation: re-run of ${f.workspace}::${f.file} errored (${e instanceof Error ? e.message : e}) — treated as still-failing`);
        return { workspace: f.workspace, file: f.file, passed: false, errored: true };
      }
    };
    const isolationResults: IsolationResult[] = [];
    for (const f of originalFailing) {
      let result = await runOnce(f);
      let attempt = 1;
      while (!result.passed && attempt <= retryMax && now() < retryDeadline) {
        // EI-18669336904251384: don't assert "ambient host load" unconditionally — a
        // failure that finished in milliseconds was not starved, it ran to completion and
        // failed deterministically (a real break, or a stale candidate whose fix already
        // landed at tip). Only attribute to load when the measured duration is actually
        // consistent with starvation; otherwise say plainly that load is not the likely
        // cause, so a human/agent reading the log doesn't wait out a red that will never
        // self-heal. Retrying is still safe either way — it can only ever ADD an
        // absorption chance, never manufacture a false green.
        const attribution =
          result.durationMs === undefined
            ? '(ambient host load, not just the checkpoint\'s own concurrency, can starve even an isolated re-run — duration not measured)'
            : result.durationMs >= ISOLATION_LOAD_STARVATION_MIN_MS
              ? `(took ${result.durationMs}ms — consistent with ambient host load starving the isolated re-run)`
              : `(finished in ${result.durationMs}ms — too fast to be load-starved; likely a real break or a stale candidate, NOT ambient load)`;
        log(
          `isolation: ${f.workspace}::${f.file} still failing after attempt ${attempt} ${attribution}${describeFailingCases(casesByFile.get(f.file))} — retrying (${retryDeadline - now()}ms of retry budget remaining)`,
        );
        await sleep(retryDelayMs);
        result = await runOnce(f);
        attempt++;
      }
      isolationResults.push(result);
    }
    const decision = decideFlakeAbsorption({ originalFailing, isolationResults });
    if (decision.verdict === 'all-flakes') {
      const note = `isolation: ALL ${decision.flakeAbsorbed.length} originally-failing file(s) PASSED in isolation — absorbed as load-flake(s): ${decision.flakeAbsorbed.join(', ')}`;
      log(note);
      return { absorbedToGreen: true, flakeSuspects: decision.flakeAbsorbed, note };
    }
    // EI-18673560248447615: this note is the gate's VERDICT line — the one an agent reads
    // to decide whether a red is theirs. Naming the failing cases here is what turns
    // "some file broke, go read a 5000-line log" into an actionable verdict.
    const namedStillFailing = decision.stillFailing.map(
      (label) => `${label}${describeFailingCases(casesByFile.get(label.split('::')[1] ?? label))}`,
    );
    return keep(
      `isolation: ${decision.stillFailing.length} file(s) STILL FAILED in isolation — real break, gate stays red: ${namedStillFailing.join('; ')}`,
    );
  } catch (e) {
    // Any unexpected fault in the absorption attempt defaults to the ORIGINAL verdict.
    return keep(`isolation: absorption attempt errored (${e instanceof Error ? e.message : e}) — defaulting to the original (red) verdict`);
  }
}

/**
 * worker-pool-crash-absorption-2026-06-25 (WI-806): the substrings that mark a vitest
 * WORKER-POOL crash — a fork dying under memory/load pressure (ENOMEM / OOM-kill /
 * SIGKILL'd child), NOT a test assertion. Vitest reports it as an `Unhandled Error`
 * with NO per-file `FAIL <file>` row, so parseFailingFilesByWorkspace finds zero files
 * to re-run in isolation and the gate falls straight through to a hard RED. We detect it
 * by these stable pool-error markers so the no-signature crash gets ABSORB-OR-RETRY'd
 * instead of silently wedging the release pipeline (the 5×-consecutive-red incident).
 */
export const WORKER_POOL_CRASH_MARKERS = [
  '[vitest-pool]',
  'Worker forks emitted error',
  'Worker exited unexpectedly',
  'Worker terminated',
] as const;

/** worker-pool-crash-absorption-2026-06-25 (WI-806): does the suite output look like a
 *  vitest worker-POOL crash (a fork OOM/terminate under load) rather than a test failure?
 *  Pure substring match against {@link WORKER_POOL_CRASH_MARKERS}. */
export function isWorkerPoolCrash(output: string): boolean {
  return WORKER_POOL_CRASH_MARKERS.some((m) => output.includes(m));
}

/**
 * worker-pool-crash-absorption-2026-06-25 (WI-806): the WORKSPACE(S) whose suite crashed,
 * extracted from a worker-pool-crash output that carries NO per-file `FAIL` rows. A vitest
 * worker-fork crash names its workspace in npm's error footer:
 *   `npm error workspace @papercusp/operator-core@0.1.0`
 *   `npm error path …/packages/operator-core`
 * and (under the affected runner) in the `>>> <ws> :: npm run …` section header above it.
 * We harvest the explicit `npm error workspace <name>` lines first (most precise), then
 * fall back to the `>>>` section headers. Pure + total: no match ⇒ `[]`, never throws.
 */
export function parseCrashedWorkspaces(output: string): string[] {
  const seen = new Set<string>();
  // `npm error workspace @papercusp/operator-core@0.1.0` → strip the trailing @version.
  for (const m of output.matchAll(/^\s*npm error workspace\s+(\S+)/gm)) {
    seen.add(m[1].replace(/@[^@/]*$/, ''));
  }
  if (seen.size === 0) {
    // Fall back to the affected-runner section headers (`>>> <ws> :: npm run <script>`).
    for (const m of output.matchAll(/^\s*>>>\s+(\S+)\s+::\s+npm run\b/gm)) seen.add(m[1]);
  }
  return [...seen].sort();
}

/** worker-pool-crash-absorption-2026-06-25 (WI-806): result of re-running ONE crashed
 *  workspace's suite at reduced concurrency. */
export interface WorkspaceRerunResult {
  workspace: string;
  /** true ⇒ the workspace's suite PASSED cleanly on the reduced-concurrency re-run. */
  passed: boolean;
  /** true ⇒ the re-run STILL crashed the pool (another worker-pool error) — undecided,
   *  treated as a real failure (fail-safe; never a false green). */
  crashedAgain?: boolean;
  /** true ⇒ the re-run failed with a real per-file/assertion failure (a genuine red). */
  realFailure?: boolean;
}

/** worker-pool-crash-absorption-2026-06-25 (WI-806): the outcome of the whole
 *  worker-crash absorption attempt — what runGreen needs to (maybe) flip the verdict. */
export interface WorkerCrashAbsorptionOutcome {
  /** true ⇒ the crash was pure load/infra; every crashed workspace re-ran GREEN. */
  absorbedToGreen: boolean;
  /** workspaces proven load-crash flaky (crashed under gate load, passed on the re-run) —
   *  surfaced as flake suspects so the absorption is auditable, never silent. */
  flakeSuspects: string[];
  /** human-readable note for the log / broadcast. */
  note: string;
}

/**
 * worker-pool-crash-absorption-2026-06-25 (WI-806): orchestrate the worker-pool-crash
 * absorb-or-retry — the SAFE fix for the gap where a vitest fork OOMs under fleet load,
 * emits NO `FAIL <file>` lines, parseFailingFilesByWorkspace yields ZERO files, and the
 * gate falls through to a hard RED that wedges the release pipeline (the 5×-consecutive-
 * red incident). PURE of vitest/exec: the re-runner is injected (`workspaceRerun`).
 *
 * Fires ONLY when the suite output IS a worker-pool crash AND there are ZERO parseable
 * per-file failures (the per-file isolation path already handles a crash that still
 * named its files). Then re-runs each crashed WORKSPACE once at reduced concurrency:
 *   - every workspace re-runs GREEN ⇒ absorb (green + flakeSuspects).
 *   - any workspace crashes AGAIN, fails for real, or its re-run errors ⇒ stay RED.
 * Bounded by {@link WORKER_CRASH_MAX_WORKSPACES} (a broad multi-workspace crash is a real
 * regression, not box-weather). Wrapped so ANY unexpected throw defaults to the ORIGINAL
 * (red) verdict — uncertainty NEVER manufactures a false green.
 */
export async function attemptWorkerCrashAbsorption(
  fullOutput: string,
  workspaceRerun: (input: { workspace: string }) => Promise<WorkspaceRerunResult>,
  log: (s: string) => void = () => {},
): Promise<WorkerCrashAbsorptionOutcome> {
  const keep = (note: string): WorkerCrashAbsorptionOutcome => ({ absorbedToGreen: false, flakeSuspects: [], note });
  try {
    if (!isWorkerPoolCrash(fullOutput)) {
      return keep('worker-crash: output is not a vitest worker-pool crash — not a load-crash flake');
    }
    // The per-file isolation absorber already handles a crash that STILL named failing
    // files; this path is ONLY for the no-signature crash (zero parseable per-file fails).
    if (parseFailingFilesByWorkspace(fullOutput).length > 0) {
      return keep('worker-crash: per-file failures were parseable — handled by the isolation absorber, not the workspace re-run');
    }
    const workspaces = parseCrashedWorkspaces(fullOutput);
    if (workspaces.length === 0) {
      return keep('worker-crash: pool crash but no crashed workspace localizable — gate stays red');
    }
    if (workspaces.length > WORKER_CRASH_MAX_WORKSPACES) {
      return keep(
        `worker-crash: ${workspaces.length} crashed workspaces (> ${WORKER_CRASH_MAX_WORKSPACES}) — a broad crash is a real regression, not box-weather; gate stays red`,
      );
    }
    log(
      `worker-crash: vitest pool crash with NO per-file failures — re-running ${workspaces.length} crashed workspace(s) at reduced concurrency: ${workspaces.join(', ')}`,
    );
    const flakeSuspects: string[] = [];
    for (const workspace of workspaces) {
      let r: WorkspaceRerunResult;
      try {
        r = await workspaceRerun({ workspace });
      } catch (e) {
        // A re-run that ITSELF errored cannot prove the crash was a flake → stay red.
        return keep(
          `worker-crash: re-run of ${workspace} errored (${e instanceof Error ? e.message : e}) — treated as still-failing, gate stays red`,
        );
      }
      if (!r.passed) {
        const why = r.crashedAgain ? 'crashed AGAIN' : r.realFailure ? 'real failure' : 'did not pass';
        return keep(`worker-crash: re-run of ${workspace} ${why} — real break (or persistent infra fault), gate stays red`);
      }
      flakeSuspects.push(`${workspace} (worker-pool crash)`);
    }
    const note = `worker-crash: ALL ${workspaces.length} crashed workspace(s) PASSED on a reduced-concurrency re-run — absorbed as load/infra flake(s): ${workspaces.join(', ')}`;
    log(note);
    return { absorbedToGreen: true, flakeSuspects, note };
  } catch (e) {
    return keep(`worker-crash: absorption attempt errored (${e instanceof Error ? e.message : e}) — defaulting to the original (red) verdict`);
  }
}

/** worker-pool-crash-absorption-2026-06-25 (WI-806): the most workspaces the worker-crash
 *  re-run will ever absorb. A crash spanning many workspaces is a real regression (or a
 *  box-wide fault that a re-run won't fix), not the single-workspace box-weather flake this
 *  absorbs — and re-running many full workspace suites would blow the gate's wall-clock. */
export const WORKER_CRASH_MAX_WORKSPACES = 2;

/** Host-set, test-affecting NON-`PAPERCUSP_` env vars the gate must strip (P-008).
 *  `AGENT_MODELS` (the operator's per-role model map, e.g. `{"worker":"opus"}` in
 *  .env.local) leaked into the gate and broke `@papercusp/orchestrator` invoke.test
 *  2026-06-09 — green in a clean shell, red only under the routine. The gate measures
 *  the COMMITTED defaults; tests that need it set it themselves. */
export const HOST_ENV_STRIP = ['AGENT_MODELS'];

/**
 * Per-fork V8 old-space cap (MiB) the gate FORCES onto the spawned vitest forks.
 *
 * The bg-host / staging hosts run with `NODE_OPTIONS=--max-old-space-size=131072`
 * (a 128 GiB heap for the long-lived host). Inherited UNCHANGED by the spawned
 * `test:affected` → vitest, it told EACH of the 8 concurrent forks it had 128 GiB
 * of headroom, so V8 deferred old-space GC and the forks bloated; under the shared
 * box's live-fleet load that tipped into ENOMEM / OOM-killed workers, surfacing as
 * the VARYING, pass-in-isolation reds that held `main` for ~16h (different files
 * each hourly run, every one green on an isolated re-run — pure memory-pressure
 * flake, no deterministic break). 4 GiB is far above any unit file's real working
 * set (they pass at V8's ~2 GiB default in CI/local) yet lets all 8 forks fit in
 * ~32 GiB with headroom and GC normally. Same rule as the PAPERCUSP_* + AGENT_MODELS
 * strip below: the host's identity must never define green.
 */
export const GREEN_CHECKPOINT_FORK_HEAP_MB = 4096;

/**
 * worker-pool-crash-absorption-2026-06-25 (WI-806): the default vitest fork concurrency
 * the gate runs at. ROOT-CAUSE prevention for the 5×-consecutive-red incident where
 * `@papercusp/operator-core`'s suite CRASHED a worker fork (ENOMEM / OOM-kill under the
 * shared box's live-fleet load) — `[vitest-pool]: Worker forks emitted error`, with NO
 * per-file `FAIL` lines for the absorber to re-run.
 *
 * The old default was 8 forks × {@link GREEN_CHECKPOINT_FORK_HEAP_MB} (4 GiB) = ~32 GiB of
 * nominal headroom the forks would happily bloat into; under concurrent fleet load that
 * tipped over the box's real free memory and OOM-killed a fork. Halving the concurrency to
 * 4 kept the worst-case fork footprint at ~16 GiB — at a modest wall-clock cost (the gate is
 * hourly, not latency-critical). The gate already raised VITEST_UNIT_TIMEOUT_MS to 180s, so
 * fewer parallel forks won't time-out the heavy `await import()` files.
 *
 * UPDATE 2026-06-25: 4 forks (~16 GiB) STILL OOM-/timeout-flaked the gate red on a DIFFERENT
 * random file each run (conversations-core, watchdog, cross_harness, …) for 1h+ — the box was
 * chronically memory-pressured (≈124 GiB into swap from the 32-worker :3070 operator + live
 * fleet, plus a peer's concurrent 23k-test run) — wedging every FF and forcing a manual
 * force-deploy. Lowered again to 2 (~8 GiB worst-case) for durable margin on the
 * chronically-swapping box; the gate is hourly + acquireCheckpointRunLock serializes fires, so
 * the slower run can't overlap-OOM. NOTE: fewer forks is a MITIGATION — the deeper root is the
 * box's memory BASELINE (the operator cluster size); if 2 still flakes, the durable fix is
 * operator-cluster reduction or a memory-aware gate-defer, not fewer forks. Configurable via
 * VITEST_MAX_FORKS/THREADS (a pre-set value always wins).
 */
export const GREEN_CHECKPOINT_MAX_FORKS = 2;

/**
 * Strip any inherited `--max-old-space-size` (both `=value` and space-separated
 * `--flag value` forms, and the `_` spelling) from a NODE_OPTIONS string and pin
 * it to {@link GREEN_CHECKPOINT_FORK_HEAP_MB}, preserving every other token
 * (e.g. `--expose-gc`). Total + pure: an empty/undefined input yields just the
 * pinned heap flag, so the gate's per-fork heap is DETERMINISTIC regardless of
 * what the host launched the bg-host with.
 */
export function sanitizeForkNodeOptions(
  nodeOptions: string | undefined,
  heapMb: number = GREEN_CHECKPOINT_FORK_HEAP_MB,
): string {
  const toks = (nodeOptions ?? '').split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^--max[-_]old[-_]space[-_]size$/.test(t)) {
      i++; // also drop its value (the next token)
      continue;
    }
    if (/^--max[-_]old[-_]space[-_]size=/.test(t)) continue;
    kept.push(t);
  }
  kept.push(`--max-old-space-size=${heapMb}`);
  return kept.join(' ');
}

/**
 * Build the GREEN suite's environment — the COMMITTED DEFAULTS, with the host's
 * identity stripped — as a fresh env (so realCheckpointDeps.runGreen's env logic,
 * which twice held `main` red for hours via leaked env, is unit-testable without
 * running the suite). `source` defaults to the live process env.
 *
 * - Strip ALL `PAPERCUSP_*` (a demo flag leaked from the systemd user-manager env
 *   held `main` red for hours 2026-06-06; non-flag host vars — PAPERCUSP_OPERATOR_URL
 *   / SPAWN_SU_BEARER — struck again 2026-06-07, failing spawn-chokepoint tests 8/8
 *   under the routine while the same sha passed in a login shell) + every
 *   {@link HOST_ENV_STRIP} key. The host's identity must never define green.
 * - `GREEN_CHECKPOINT=1` — a marker so genuinely load-/live-network-sensitive tests
 *   that CANNOT be hermetic (real Hyperswarm/DHT, ports) self-exclude via
 *   `describe.skipIf(process.env.GREEN_CHECKPOINT === '1')`; they still run in CI/local.
 * - `AFFECTED_BASE=<base>` (when given) so test:affected runs exactly the candidate's delta;
 *   any host-leaked AFFECTED_BASE is dropped — the `base` arg is the ONLY source, so a
 *   base-null full run is never silently narrowed by an inherited value.
 * - `VITEST_MAX_FORKS/THREADS` default to {@link GREEN_CHECKPOINT_MAX_FORKS} (respecting a
 *   pre-set value): the checkpoint shares the box with the live fleet; uncapped/too-high
 *   worker concurrency under that load produces timeout FLAKES (a 1-of-8881 load-flake held
 *   `main` back 2026-06-06) AND OOM-killed worker forks (WI-806: 8 × 4 GiB bloated past the
 *   box's free memory and crashed the pool, wedging the gate 5× in a row).
 * - `AFFECTED_RETRY_FAILED` defaults to 1 (respecting a pre-set value): re-run a failed
 *   workspace once before calling it red — a real regression fails twice, a flake doesn't.
 * - `NODE_OPTIONS` is sanitized ({@link sanitizeForkNodeOptions}): the host's
 *   `--max-old-space-size=131072` (the bg-host's 128 GiB heap) is stripped and pinned to
 *   {@link GREEN_CHECKPOINT_FORK_HEAP_MB} so the 8 concurrent forks can't each bloat to
 *   128 GiB and ENOMEM the box — the memory-pressure flake that held `main` ~16h.
 */
export function buildGreenCheckpointEnv(
  base: string | null,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const k of Object.keys(env)) {
    if (k.startsWith('PAPERCUSP_') || HOST_ENV_STRIP.includes(k)) delete env[k];
  }
  // The bg-host's 128 GiB `--max-old-space-size` must NOT ride into the test forks
  // (8 × 128 GiB → no GC → ENOMEM under fleet load). Pin a sane per-fork heap.
  env.NODE_OPTIONS = sanitizeForkNodeOptions(env.NODE_OPTIONS);
  env.GREEN_CHECKPOINT = '1';
  // AFFECTED_BASE comes ONLY from the `base` argument — never a host-leaked value.
  // The gate runs the suite with AFFECTED_BASE set, so a child runGreen(tree, null)
  // would otherwise inherit that base and silently NARROW a "full" affected run —
  // the host's env defining what green measures, the very leak this builder exists
  // to prevent (held `main` red on the candidate-base sha, 2026-06-14).
  delete env.AFFECTED_BASE;
  if (base) env.AFFECTED_BASE = base;
  // WI-806: cap fork concurrency to a MEMORY-SAFE default (4, not the old 8) so the
  // forks can't collectively bloat past the box's free memory and OOM-kill a worker
  // under live-fleet load — the worker-pool crash that wedged the gate 5× in a row.
  env.VITEST_MAX_FORKS = env.VITEST_MAX_FORKS ?? String(GREEN_CHECKPOINT_MAX_FORKS);
  env.VITEST_MAX_THREADS = env.VITEST_MAX_THREADS ?? String(GREEN_CHECKPOINT_MAX_FORKS);
  env.AFFECTED_RETRY_FAILED = env.AFFECTED_RETRY_FAILED ?? '1';
  // VITEST_UNIT_TIMEOUT_MS=180000 (respecting a pre-set value): the gate runs
  // operator-core's heaviest `await import()` unit tests (create-*, hive/guard,
  // coord-program-workflow.smoke, endpoint routes) under 8 concurrent forks that
  // serialize the shared SRC transform — a single cold heavy import measured 74-97s
  // even on an idle box (2026-06-22). The 60s dev default flaked the gate red on
  // ~9 such files (all passing in isolation); 180s gives headroom. Dev/CI keep 60s
  // (libs/test-config reads this env; unset ⇒ 60s).
  env.VITEST_UNIT_TIMEOUT_MS = env.VITEST_UNIT_TIMEOUT_MS ?? '180000';
  return env;
}

/** P-012 failure signature for the release-fixer dedup, folding the SPA-build break in:
 *  a green run has none; otherwise the extracted suite failures, plus the sentinel
 *  `@papercusp/operator-vite` when the build (not the suite) is what failed — so a broken
 *  build holds `main` like any other red and dedups by FAILURE, not the hourly candidate sha. */
export function checkpointFailureSignature(
  fullOutput: string,
  green: boolean,
  buildOk: boolean,
): string[] {
  const failingTests = green ? [] : extractFailingTests(fullOutput);
  if (!buildOk && !failingTests.includes('@papercusp/operator-vite')) failingTests.push('@papercusp/operator-vite');
  return failingTests;
}

/** De-noise the suite (+ build) output for the held-gate broadcast/escalation.
 *
 *  Strips ANSI, drops npm's error boilerplate (~10 lines/failed-workspace that
 *  repeatedly pushed the real `FAIL` names out of the tail — cost two diagnosis
 *  round-trips 2026-06-06), then leads with a FAILURE-FOCUSED digest: the per-file
 *  rollups, the `FAIL` lines, the failing case names, and vitest's own counts.
 *
 *  Leading with the digest (rather than the raw tail) is the fix for the 2026-07-10
 *  verdict whose `summary` was 2000 chars of a testing-library DOM dump — the tail of
 *  a red run is whatever the LAST assertion happened to print, which is uncorrelated
 *  with what broke. The tail is still appended underneath, since timeouts and build
 *  breaks surface there and nowhere else. */
export function summarizeSuiteOutput(fullOutput: string): string {
  const lines = stripAnsi(fullOutput)
    .split('\n')
    .filter((l) => !/^npm error/.test(l));

  const isSignal = (l: string): boolean =>
    /^\s*FAIL\s+\S/.test(l) ||
    /^\s*❯\s+\S+\s+\(\d+\s+tests?[^)]*\|\s*\d+\s+failed\)/.test(l) ||
    /^\s*×\s+\S/.test(l) ||
    />>>\s+\S+\s+FAILED\b/.test(l) ||
    /^\s*(Test Files|Tests)\s+.*(failed|passed)/.test(l);

  const digest = lines.filter(isSignal).slice(0, 40);
  // No failure markers (a build break, a wedge, a runner crash): the tail is the ONLY
  // evidence there is, so it keeps the full budget.
  if (digest.length === 0) return lines.join('\n').slice(-2000);
  // Otherwise the digest leads and the tail follows within the same budget.
  return `${digest.join('\n')}\n\n--- tail ---\n${lines.join('\n').slice(-1200)}`.slice(0, 2000);
}

export interface CheckpointOpts {
  /** Override the candidate (default: integration-branch HEAD). */
  candidate?: string;
  /** Don't push `ready` to origin (local-only). */
  noPush?: boolean;
  /** How many times this run has already auto-refired on a stale red (internal; the
   *  cap in autoRefireCapFromEnv bounds the recursion). */
  refireAttempts?: number;
}

/**
 * P-016 (release-pipeline-resilience-2026-06-09 D-010): is the longest-green-PREFIX
 * FF gate armed? DEFAULT-OFF — when off, a red candidate holds `main` exactly as it
 * does today (whole-batch all-or-nothing). Env-armed opt-in, mirroring the perf/delta
 * gates, because partial FF is the deepest change to the single most fleet-critical
 * gate and D-010 calls for an OWNER-ATTENDED live cutover ("build attended not blind").
 */
/** Quiet-cut window in seconds; 0 disables. Default 240s (~1.5 git-sync ticks) —
 *  PAPERCUSP_QUIET_CUT=0 opts out entirely, PAPERCUSP_QUIET_CUT_SEC tunes the window. */
export function quietCutSecFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  if (env.PAPERCUSP_QUIET_CUT === '0') return 0;
  const v = Number(env.PAPERCUSP_QUIET_CUT_SEC);
  return Number.isFinite(v) && v >= 0 ? v : 240;
}

export function partialGreenGateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  // Default ON (2026-07-01, owner directive): the salvage is confirm-gated — a wrong
  // prefix guess just fails the confirm run and holds — so there is no unproven-code
  // risk in arming it everywhere. `PAPERCUSP_PARTIAL_GREEN_GATE=0` is the opt-out
  // (launch-time config, e.g. to force strict tip-only gating while debugging).
  return env.PAPERCUSP_PARTIAL_GREEN_GATE !== '0';
}

/**
 * P-016 (D-010): salvage the LONGEST GREEN PREFIX when the candidate (the batch tip) is
 * red, so one unrelated red commit no longer holds every clean change behind it hostage.
 *
 * Strategy — cheap-locate, then CONFIRM:
 *   1. `failingWs` = the workspaces that actually failed (the failure signature ∩ the
 *      batch's affected set). If the failure can't be localized to a workspace (build
 *      break / bare FAIL <file>), we decline — never guess.
 *   2. Walk the batch commits oldest→newest; the affected set is monotonic in prefix
 *      length, so the longest prefix whose CUMULATIVE affected set touches NO failing
 *      workspace is the salvage candidate. All git+graph, no test runs — cheap.
 *   3. CONFIRM by running the gate ONCE on that prefix. `main` only ever FFs to a commit
 *      that ITSELF ran green — so the invariant "`main` is always a tested-green state"
 *      is preserved; a wrong guess just fails the confirm and holds (today's behavior).
 *
 * Returns a partial-advance CheckpointResult (reason 'advanced-prefix') or null (hold).
 * `candidate` stays the RED tip so the failing-test signature + release-fixer dispatch
 * keep targeting the real failure; `advancedTo` carries the prefix `main` moved to.
 */
async function tryLongestGreenPrefix(
  cfg: ReleaseConfig,
  deps: CheckpointDeps,
  lastReady: string,
  candidate: string,
  failingTests: string[] | undefined,
  noPush: boolean,
): Promise<CheckpointResult | null> {
  if (!deps.commitsInRange || !deps.affectedWorkspacesForRange) return null; // not wired (e.g. a minimal stub)
  if (!failingTests?.length) return null; // no signature → can't localize → don't guess
  const commits = await deps.commitsInRange(lastReady, candidate); // oldest→newest, full shas
  if (commits.length <= 1) return null; // only the red tip itself — nothing to salvage behind it

  const fullAffected = await deps.affectedWorkspacesForRange(lastReady, candidate);
  if (!fullAffected) return null; // resolver couldn't compute → hold (safe)
  const failingSig = new Set(failingTests);
  // The failing WORKSPACES = those in the batch's affected set whose name is in the
  // failure signature. File-path entries (FAIL <file>) and the build sentinel won't
  // match a workspace name, so they fall out — if nothing localizes, we decline.
  const failingWs = new Set(fullAffected.filter((w) => failingSig.has(w)));
  if (failingWs.size === 0) return null; // failure not workspace-localizable → hold

  // Longest prefix (oldest-first) whose cumulative affected set avoids every failing ws.
  let prefixTip: string | null = null;
  for (const sha of commits.slice(0, -1)) { // exclude the red tip itself
    const aff = await deps.affectedWorkspacesForRange(lastReady, sha);
    if (!aff) break; // can't compute this prefix → stop at the last clean one
    if (aff.some((w) => failingWs.has(w))) break; // this commit (cumulatively) touches a failing ws
    prefixTip = sha; // clean so far — extend the prefix
  }
  if (!prefixTip) return null; // the very first new commit already implicates a failing ws

  // CONFIRM the prefix is itself green before FF-ing `main` to it (the invariant guard).
  deps.log(
    `partial-green-gate: candidate ${candidate.slice(0, 8)} red (failing ws: ${[...failingWs].join(', ')}); ` +
      `confirming longest clean prefix ${prefixTip.slice(0, 8)}`,
  );
  await deps.setupTree(prefixTip);
  const confirm = await deps.runGreen(cfg.checkpointRoot, lastReady);
  if (!confirm.green) {
    deps.log(`partial-green-gate: prefix ${prefixTip.slice(0, 8)} did NOT confirm green — holding (no partial advance)`);
    return null; // affected reasoning was incomplete; stay safe
  }
  const adv = await deps.advance(prefixTip);
  if (!adv.advanced) return null;
  if (!noPush) await deps.push(cfg.releaseRef).catch((e) => deps.log(`warn: push ${cfg.releaseRef} failed: ${e}`));
  deps.log(
    `✅ partial-green-gate: ${cfg.releaseRef} advanced ${adv.from?.slice(0, 8) ?? 'none'} → ${prefixTip.slice(0, 8)} ` +
      `(longest green prefix; tip ${candidate.slice(0, 8)} still red)`,
  );
  await deps
    .broadcast(
      `🟧 green-checkpoint: PARTIAL advance — \`${cfg.releaseRef}\` → ${prefixTip.slice(0, 8)} (longest GREEN prefix), tip ${candidate.slice(0, 8)} still red`,
      `Was ${adv.from?.slice(0, 8) ?? 'unset'}. One unrelated red no longer hostages the clean prefix — it is now deployable. The red tip's failing tests still need a fix (release-fixer dispatched).`,
    )
    .catch(() => {});
  // The prefix is a real green advance — wake any agent awaiting "the next green".
  // EI-10800: AWAITED through the deps.emitEvent seam (was a fire-and-forget `void import`).
  {
    const prefixSummary = `${cfg.releaseRef} advanced to ${prefixTip!.slice(0, 8)} (longest green prefix; tip ${candidate.slice(0, 8)} held red)`;
    const pipeline = pipelineName(cfg.integrationRoot);
    // WI-4957: `runId` on the payload (this run's identity) + `pipeline` (was previously
    // only used to build cancelSiblingKeysFor below, never carried on the payload itself —
    // a checkpoint:await bound to `pipeline` still lineage-checks via the pipeline-SCOPED
    // key, but the payload field lets a global-key waiter self-check it without re-deriving
    // it from the emitter).
    const payload = { sha: prefixTip, from: adv.from, partial: true, redTip: candidate, pipeline, runId: deps.runId ?? null };
    const cancelSiblingKeysFor = ['green-checkpoint:red', `green-checkpoint:red:${pipeline}`];
    try {
      // EI-7646/WI-4957: fire BOTH the global key and the pipeline-scoped one, mirroring the
      // full-advance path below — a partial advance is still a real green outcome for
      // `prefixTip`, and a `checkpoint:await { pipeline, candidateSha: prefixTip }` (the
      // pipeline-scoped, candidate-bound default) must be able to see it. Before this fix
      // only the global key fired, so a candidate-bound waiter on a partial advance could
      // hang to its own timeout despite the gate having genuinely resolved for its candidate.
      await deps.emitEvent?.({
        key: 'release:green',
        summary: prefixSummary,
        payload,
        // EI-12457: this candidate resolved green (partial) — a subscriber's still-
        // pending red await for this pipeline can now never legitimately fire.
        cancelSiblingKeysFor,
      });
      await deps.emitEvent?.({
        key: `release:green:${pipeline}`,
        summary: prefixSummary,
        payload,
        cancelSiblingKeysFor,
      });
    } catch (e) {
      deps.log(`warn: release:green (partial) emit failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return {
    advanced: true,
    candidate, // the RED tip — keeps failingTests + the release-fixer targeting the real failure
    advancedTo: prefixTip,
    from: adv.from,
    green: false, // the candidate (tip) is NOT green; `main` advanced to a green PREFIX
    reason: 'advanced-prefix',
    summary: confirm.summary,
    failingTests,
    ...(deps.runId ? { runId: deps.runId } : {}),
  };
}

/**
 * WI-2997 (EI-7443 follow-up, item 3): render a short per-file 7d historical-flake
 * annotation for the CURRENTLY failing test files, so a release-fixer sees
 * flake-vs-regression at a glance instead of re-deriving it by hand. Pure +
 * exported so it is unit-testable without a live DB — `deps.flakeLookup`
 * supplies the per-file stats; this just formats them. NAMING: distinct from
 * the load-flake-isolation `flakeSuspects`/`flakeNote` used elsewhere in this
 * file (a WITHIN-this-run isolation-recheck concept, load-flake-isolation-2026-06-23)
 * — this is the historical CROSS-RUN `harness_shared.test_runs` rollup (EI-7443).
 * Returns '' when none of `files` has any historical record (nothing to add).
 */
export function historicalFlakeAnnotations(
  stats: Record<string, { fails: number; passes: number; bothStatusShas: number; isSuspect: boolean }>,
  files: string[],
): string {
  const lines = files
    .filter((f) => stats[f])
    .map((f) => {
      const s = stats[f];
      return `  - ${f}: ${s.fails} fail(s) / ${s.passes} pass(es) over 7d${
        s.isSuspect ? ' — ⚠️ known flake-suspect (mixed pass/fail across commits)' : ''
      }`;
    });
  return lines.length
    ? `\n\n📊 7d historical flake stats for failing file(s) (EI-7443):\n${lines.join('\n')}`
    : '';
}

export async function runGreenCheckpoint(
  cfg: ReleaseConfig,
  deps: CheckpointDeps,
  opts: CheckpointOpts = {},
): Promise<CheckpointResult> {
  let candidate = opts.candidate
    ? await revParse(cfg.integrationRoot, opts.candidate)
    : await revParse(cfg.integrationRoot, cfg.integrationBranch);
  const lastReady = (await refExists(cfg.integrationRoot, cfg.releaseRef))
    ? await revParse(cfg.integrationRoot, cfg.releaseRef)
    : null;

  // QUIET CUT (2026-07-01): never judge a tip younger than the quiet window. On a shared
  // tree, a logically-atomic cross-package change lands across SEVERAL ~3-min git-sync
  // ticks — a candidate cut between the halves is TORN and reds the whole run on a state
  // no one ever intended to ship (the 2026-07-01 camelCase facade tear: the consumer-side
  // test update landed minutes after the candidate was cut). Stepping back to the newest
  // commit that has been the tip-state for ≥ quietAgeSec gives an in-flight change one
  // more tick to land its other half before being judged. Only applies when the caller
  // didn't pin an explicit candidate; opt out with PAPERCUSP_QUIET_CUT=0, tune with
  // PAPERCUSP_QUIET_CUT_SEC (default 240s ≈ 1.5 ticks).
  if (!opts.candidate && quietCutSecFromEnv() > 0) {
    try {
      const quietSec = quietCutSecFromEnv();
      const tipTime = await commitUnixTime(cfg.integrationRoot, candidate);
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - tipTime < quietSec) {
        const aged = await revListBefore(cfg.integrationRoot, cfg.integrationBranch, nowSec - quietSec);
        // Guards: the aged pick must exist, differ, and still fast-forward from the pin
        // (equal-to-lastReady is fine — the up-to-date path below reports it).
        if (aged && aged !== candidate && (!lastReady || (await isAncestor(cfg.integrationRoot, lastReady, aged)))) {
          deps.log(
            `quiet-cut: tip ${candidate.slice(0, 8)} is ${nowSec - tipTime}s old (<${quietSec}s quiet window) — ` +
              `judging ${aged.slice(0, 8)} instead (the newest ≥${quietSec}s-old state); the tip gets the next run`,
          );
          candidate = aged;
        }
      }
    } catch (e) {
      deps.log(`quiet-cut: skipped (${e instanceof Error ? e.message : e}) — judging the tip as before`);
    }
  }

  if (candidate === lastReady) {
    deps.log(`${cfg.releaseRef} already at integration HEAD ${candidate.slice(0, 8)} — nothing to checkpoint`);
    return { advanced: false, candidate, from: lastReady, green: null, reason: 'up-to-date' };
  }

  // The green pin only ever fast-forwards — refuse a candidate that isn't a descendant.
  if (lastReady && !(await isAncestor(cfg.integrationRoot, lastReady, candidate))) {
    deps.log(`candidate ${candidate.slice(0, 8)} is NOT a descendant of ${cfg.releaseRef} ${lastReady.slice(0, 8)} — refusing`);
    return { advanced: false, candidate, from: lastReady, green: null, reason: 'not-fast-forward' };
  }

  deps.log(`checkpointing candidate ${candidate.slice(0, 8)} (base ${lastReady?.slice(0, 8) ?? 'none'})`);
  await deps.setupTree(candidate);
  // EI-13992: preflight — apply any pending migrations to the live dev PG BEFORE
  // judging, so a run of this gate can never red-pin itself on schema drift caused
  // by main sitting frozen (see CheckpointDeps.ensureMigrationsCurrent doc). Never
  // blocks the run: a failure here just means migrations stay pending, same as
  // today; the suite still runs and reports its own real verdict.
  if (deps.ensureMigrationsCurrent) {
    try {
      const migrated = await deps.ensureMigrationsCurrent();
      if (migrated && migrated.applied > 0) {
        deps.log(`migration preflight: applied ${migrated.applied} pending migration(s) to the dev PG before judging`);
      }
      if (migrated && migrated.failed.length > 0) {
        deps.log(`migration preflight: ${migrated.failed.length} migration(s) failed to apply (left pending): ${migrated.failed.map((f) => f.file).join(', ')}`);
      }
    } catch (e) {
      deps.log(`migration preflight skipped (${e instanceof Error ? e.message : e})`);
    }
  }
  // EI-18666996942859193: tree-drift preflight — name a drifted checkpoint tree as its
  // own distinct signal BEFORE judging, so a red caused by it reads as "tree drift" up
  // front rather than only as an arbitrary-looking failing test file (see
  // CheckpointDeps.checkTreeDrift doc — this is what the 2026-07-25 8-missing-package
  // incident cost two agents hours misdiagnosing). Purely diagnostic: never blocks or
  // alters the advance/hold decision, same discipline as the migration preflight above.
  if (deps.checkTreeDrift) {
    try {
      const drift = await deps.checkTreeDrift();
      if (drift && !drift.skipped) {
        if (drift.missing.length > 0) {
          deps.log(
            `tree-drift preflight: ${drift.missing.length} package(s) required by package-lock.json are MISSING from ` +
              `node_modules in the checkpoint tree: ${drift.missing.join(', ')} — this run will likely fail on an ` +
              `unrelated-looking MODULE_NOT_FOUND; fix with \`npm install\` in the tree this was copied from`,
          );
        }
        if (drift.extraneous.length > 0) {
          deps.log(
            `tree-drift preflight: ${drift.extraneous.length} node_modules director${drift.extraneous.length === 1 ? 'y is' : 'ies are'} ` +
              `extraneous (not in package-lock.json, will be pruned on next install): ${drift.extraneous.join(', ')}`,
          );
        }
      } else if (drift?.skipped) {
        deps.log(`tree-drift preflight skipped (${drift.error ?? 'unknown reason'})`);
      }
    } catch (e) {
      deps.log(`tree-drift preflight failed (${e instanceof Error ? e.message : e})`);
    }
  }
  const { green, summary, failingTests, flakeSuspects, failingFiles = [], logPath, isolationNote } = await deps.runGreen(
    cfg.checkpointRoot,
    lastReady,
  );
  // load-flake-isolation-2026-06-23: runGreen may have ABSORBED a load-flake — the
  // affected suite went red under the gate's 8-fork load, but every originally-failing
  // FILE then PASSED on an isolated single-concurrency re-run, so it reported green=true
  // and surfaced the flake suspects. Make that visible in the green-advance broadcast
  // below so a flake-absorbed advance is auditable (and the file is on record for the
  // P-009 chronic-flake ledger / quarantine nudge), without holding the whole fleet's gate.
  if (green && flakeSuspects?.length) {
    deps.log(
      `candidate ${candidate.slice(0, 8)} is green (load-flake absorbed: ${flakeSuspects.join(', ')} — failed under load, passed in isolation)`,
    );
  }
  if (!green) {
    deps.log(`candidate ${candidate.slice(0, 8)} is NOT green — ${cfg.releaseRef} stays at ${lastReady?.slice(0, 8) ?? 'unset'}`);
    // EI-6542: surface "this exact failing test file already changed since the
    // candidate" — the manual git-log check a triaging agent otherwise repeats by
    // hand. Purely informational (never alters the advance/hold decision): a
    // logically-atomic change split across git-sync ticks means the quiet-cut
    // candidate can be stale by the time the ~40min suite finishes, and a newer
    // commit may already have fixed the exact failing file(s). Best-effort — any
    // git error here just skips the note, never blocks the red path.
    let alreadyFixedNote = '';
    if (failingTests?.length) {
      try {
        const freshTip = await revParse(cfg.integrationRoot, cfg.integrationBranch);
        if (freshTip !== candidate) {
          const changedSinceCandidate = new Set(await changedFiles(cfg.integrationRoot, candidate, freshTip));
          const alreadyTouched = failingTests.filter((f) => changedSinceCandidate.has(f));
          if (alreadyTouched.length) {
            alreadyFixedNote =
              `\n\n⚠ already changed since candidate ${candidate.slice(0, 8)} (may be fixed-since downstream — verify before re-diagnosing from scratch): ${alreadyTouched.join(', ')}`;
            deps.log(`already-fixed-since: ${alreadyTouched.join(', ')} changed between ${candidate.slice(0, 8)} and ${freshTip.slice(0, 8)}`);
          }
        }
      } catch (e) {
        deps.log(`already-fixed-since check skipped (${e instanceof Error ? e.message : e})`);
      }
    }
    // WI-2997 (EI-7443 follow-up): best-effort 7d historical flake annotation for
    // the failing file(s) — purely informational, same fail-soft shape as the
    // already-fixed-since check above; any error here just skips the note.
    let historicalFlakeNote = '';
    if (failingTests?.length && deps.flakeLookup) {
      try {
        const stats = await deps.flakeLookup(failingTests);
        historicalFlakeNote = historicalFlakeAnnotations(stats, failingTests);
      } catch (e) {
        deps.log(`historical-flake-lookup skipped (${e instanceof Error ? e.message : e})`);
      }
    }
    await deps
      .broadcast(
        `🟥 green-checkpoint: ${candidate.slice(0, 8)} not green — \`${cfg.releaseRef}\` held at ${lastReady?.slice(0, 8) ?? 'unset'}`,
        summary + alreadyFixedNote + historicalFlakeNote,
      )
      .catch(() => {});
    // release-pipeline-resilience-2026-06-09 P-005: emit a reaction event on the RED path,
    // symmetric with the `release:green` emit below. A `release-fixer` launch-blueprint (P-006)
    // reacts to this to auto-diagnose the failing test; it also unblocks any agent that
    // `events:await`s the gate verdict. The `summary` is the de-noised failing-test tail above.
    // EI-10800: AWAITED through the deps.emitEvent seam (was fire-and-forget `void import` — it
    // fired reliably ONLY because the trailing `await deps.escalate` kept the process alive; make
    // that guarantee explicit, not incidental). Global + pipeline-scoped key (EI-7646: a waiter on
    // ONE pipeline's gate must not wake on every OTHER pipeline's verdict).
    {
      const redSummary = `green-checkpoint: ${candidate.slice(0, 8)} not green — ${cfg.releaseRef} held`;
      const pipeline = pipelineName(cfg.integrationRoot);
      // WI-4957: carry the FULL failing-test signature + an exact log reference on the
      // event payload itself — a consumer previously had only the de-noised `summary`
      // tail, which is unreliable for anything more precise than "something failed".
      // `runId` distinguishes this verdict from another run that might judge the same
      // candidate later (a re-fire, or a routine/manual race).
      const payload = {
        sha: candidate,
        from: lastReady ?? null,
        pipeline,
        summary: summary + alreadyFixedNote + historicalFlakeNote,
        failingTests: failingTests ?? [],
        logPath: logPath ?? null,
        runId: deps.runId ?? null,
      };
      // EI-12457: this candidate resolved red — a subscriber's still-pending green
      // await for this pipeline can now never legitimately fire.
      const cancelSiblingKeysFor = ['release:green', `release:green:${pipeline}`];
      try {
        await deps.emitEvent?.({ key: 'green-checkpoint:red', summary: redSummary, payload, cancelSiblingKeysFor });
        await deps.emitEvent?.({ key: `green-checkpoint:red:${pipeline}`, summary: redSummary, payload, cancelSiblingKeysFor });
      } catch (e) {
        deps.log(`warn: green-checkpoint:red emit failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    // P-002: durable human-facing escalation (transition-only, cleared on green).
    await deps.escalate?.(
      `green-checkpoint held: ${candidate.slice(0, 8)} not green`,
      `\`${cfg.releaseRef}\` stays at ${lastReady?.slice(0, 8) ?? 'unset'}.\n\nFailing tail:\n${summary}${alreadyFixedNote}${historicalFlakeNote}`,
    ).catch(() => {});
    // docs-audit #2: a held gate must get LOUDER, not go silent. Past 2h/4h/8h
    // re-broadcast a rising-urgency alert (the gate blocks EVERY fleet deploy), so a
    // long-held gate keeps surfacing top-of-inbox instead of one stale escalation.
    const heldMs = await deps.heldGateMs?.().catch(() => null);
    if (heldMs != null) {
      const alert = heldGateAlert(heldMs);
      if (alert) {
        await deps
          .broadcast(
            `${alert.emoji} ${alert.urgency}: green gate held ${alert.ageLabel} — \`${cfg.releaseRef}\` stuck at ${lastReady?.slice(0, 8) ?? 'unset'}, ${candidate.slice(0, 8)} still not green (blocking every fleet deploy)`,
            summary,
          )
          .catch(() => {});
      }
    }
    // Stale-candidate re-triage: is this red still broken at TIP? The quiet-cut judges a
    // commit that is minutes-to-hours old, so a peer fix (or the far side of a half-landed
    // rename) lands between the cut and the verdict. Re-run exactly the named failing files
    // at tip: if they pass, the red is an artifact of WHEN we cut, not of what we shipped.
    // Fail-soft in every direction — any error here degrades to today's plain red.
    //
    // ORDERING IS LOAD-BEARING (EI-10615). This runs BEFORE the partial-green prefix
    // salvage below, and the two were once the other way round — which made this rescue
    // DEAD CODE on a fast fleet:
    //   * this check is CHEAP (re-runs only the N named failing files — the 7th stale red
    //     was disproved in 559ms) and its payoff is TOTAL (a stale red is void ⇒ refire on
    //     tip ⇒ a FULL advance);
    //   * the prefix salvage is the opposite trade: a SECOND full affected suite (tens of
    //     minutes) for a PARTIAL advance at best.
    // With the expensive step first, seven consecutive gate runs ended their log on the
    // partial-green "confirming longest clean prefix …" line and never got another line —
    // superseded/killed mid-confirm, so execution never reached here. Every one of those
    // reds passed at tip. `main` sat 143 commits behind for ~9h with nothing broken.
    //
    // It is a CORRECTNESS bug too, not merely a scheduling one: on a stale red the failure
    // signature does not reproduce at tip, so tryLongestGreenPrefix would localize "failing
    // workspaces" from a PHANTOM failure and under-advance `main` to a prefix chosen to
    // dodge it. Triage the red before reasoning from it.
    const tip = await deps.resolveTip?.().catch(() => null) ?? null;
    let retriage: (RedTriage & { tip: string | null }) | undefined;
    // Re-running needs a workspace per file (the cwd for `npm run test --workspace`), so a
    // red we could name but not LOCATE stays a plain red rather than a silent no-op.
    if (tip && tip !== candidate && failingFiles.length > 0 && deps.runTestsAtRef) {
      deps.log(`red at ${candidate.slice(0, 8)}; re-running ${failingFiles.length} failing file(s) at tip ${tip.slice(0, 8)}`);
      const tipRun = await deps.runTestsAtRef(tip, failingFiles).catch((e: unknown) => {
        deps.log(`tip re-run failed to execute (${e instanceof Error ? e.message : e}) — treating red as real`);
        return null;
      });
      const verdict = classifyRedAgainstTip({
        candidate,
        tip,
        failingTests: failingTests ?? [],
        tipRetest: tipRun ? { ran: true, pass: tipRun.pass } : null,
        refireAttempts: opts.refireAttempts ?? 0,
        maxRefires: autoRefireCapFromEnv(),
      });
      retriage = { ...verdict, tip };
      // WI-5366: tipRun.summary carries the verified-head note (+ per-workspace
      // pass/FAIL) from runTestsAtRef but was previously computed and discarded —
      // log it alongside the classification so a future "REPRODUCE at tip <sha>"
      // verdict always shows the sha the tree was ACTUALLY verified at, not just
      // the sha that was requested.
      deps.log(`re-triage: ${verdict.classification} — ${verdict.detail}${tipRun ? ` (${tipRun.summary})` : ''}`);

      // A stale red is not a red. Re-fire the whole gate on the newer tip rather than
      // holding the pin on a failure that no longer exists — bounded by the refire cap
      // so a genuinely-broken tip still converges to a held gate and a human.
      if (verdict.autoRefire) {
        await deps.broadcast(
          `🔁 green-checkpoint re-firing on tip ${tip.slice(0, 8)}: red at ${candidate.slice(0, 8)} was STALE (${failingFiles.length} file(s) pass at tip)`,
        ).catch(() => {});
        // EI-18669342433807110: the recursive re-fire below can run a full suite again (minutes)
        // before this process returns anything — mark the refire IN FLIGHT now so a concurrent
        // reader doesn't spend that whole window seeing a plain cached red with no hint a fresh
        // verdict is imminent.
        await deps
          .recordInFlightRetriage?.({
            fromCandidate: candidate,
            refiringCandidate: tip,
            refireAttempt: (opts.refireAttempts ?? 0) + 1,
            maxRefires: autoRefireCapFromEnv(),
            failingFiles: failingFiles.map((f) => f.file),
          })
          .catch(() => {});
        return runGreenCheckpoint(cfg, deps, {
          ...opts,
          candidate: tip,
          refireAttempts: (opts.refireAttempts ?? 0) + 1,
        });
      }
    }

    // P-016 (D-010): longest-green-PREFIX FF. With the gate ARMED, a red TIP no longer
    // holds the clean PREFIX behind it hostage — `main` FFs to the longest prefix that
    // ITSELF runs green (confirm-gated, so the "always tested-green" invariant holds).
    // Runs AFTER the red escalate/broadcast/emit above, so the red tip is still fully
    // surfaced + the release-fixer still dispatched on it. Default-ON (opt-out via
    // PAPERCUSP_PARTIAL_GREEN_GATE=0); a failure here just falls through to the normal
    // hold. (release-pipeline-resilience P-016)
    //
    // EI-10615: SKIPPED for a `stale-candidate` red. That red's failing files PASS at tip,
    // so its signature is a phantom — salvaging a "longest clean prefix" from it would spend
    // a second full suite under-advancing `main` around a failure that does not exist. We
    // only reach here on a stale red when the refire cap is spent; holding is then correct.
    const staleRed = retriage?.classification === 'stale-candidate';
    if (staleRed) {
      deps.log('partial-green-gate: skipped — red is a STALE candidate (passes at tip); its failure signature is a phantom');
    }
    if (lastReady && !staleRed && partialGreenGateEnabledFromEnv()) {
      const partial = await tryLongestGreenPrefix(cfg, deps, lastReady, candidate, failingTests, !!opts.noPush).catch(
        (e) => {
          deps.log(`partial-green-gate: errored, holding (${e instanceof Error ? e.message : e})`);
          return null;
        },
      );
      if (partial) return partial;
    }

    // Deploy-staleness alarm: a held gate is loud, but a PIN that never moves is silent.
    // Attach the blocking red so the page is actionable, not just an age complaint.
    const staleness = await deps.deployStaleness?.().catch(() => null);
    if (staleness) {
      const verdict = evaluateDeployStaleness(
        { ...staleness, blockingFailures: failingTests },
        deployStalenessThresholdsFromEnv(),
      );
      if (verdict.alarm) {
        await deps.broadcast(verdict.message.split('\n')[0], verdict.message).catch(() => {});
        if (verdict.urgency === 'urgent') {
          await deps.escalate?.('deploy stale: shipped work is not reaching the running app', verdict.message).catch(() => {});
        }
      }
    }

    return {
      advanced: false,
      candidate,
      from: lastReady,
      green: false,
      reason: 'not-green',
      summary,
      failingTests,
      failingTestNames: extractFailingTestNames(summary),
      ...(retriage ? { retriage } : {}),
      ...(deps.runId ? { runId: deps.runId } : {}),
      ...(logPath ? { logPath } : {}),
      ...(isolationNote ? { isolationNote } : {}),
    };
  }

  // F2 (round-4 P-031): the candidate is GREEN — but if the operator is in a definitive
  // per-thread wedge right NOW, don't silently advance the green pin into a degraded
  // runtime. Default-WARN (surface + still advance); BLOCK only when the owner armed
  // block-mode. Flag-gated + fail-soft (a no-op `pass` unless enabled), so the default
  // deploy path is unchanged until the owner opts in.
  const perf = await deps.perfGate?.(candidate).catch(() => undefined);
  if (perf && perf.action !== 'pass') {
    deps.log(perf.summary);
    await deps.broadcast(perf.summary).catch(() => {});
    if (perf.action === 'block') {
      await deps
        .escalate?.(`green-checkpoint held: ${candidate.slice(0, 8)} perf-degraded`, perf.summary)
        .catch(() => {});
      return { advanced: false, candidate, from: lastReady, green: true, reason: 'perf-held', summary: perf.summary };
    }
  }

  // desktop-performance-suite-2026-07-20 P-011: the desktop-UI perf gate. The
  // candidate is GREEN — but if the latest recorded desktop-perf run shows a
  // budgeted interaction/route/RSS regression, don't silently advance the green
  // pin into a slower desktop UX. Default-WARN (surface + still advance); BLOCK
  // only when block-mode is armed (V1 never arms it — warn-not-block until
  // trusted). Flag-gated + fail-soft (a no-op `pass` unless FLAGS.DESKTOP_PERF_GATE
  // is on AND a run is recorded), so the default deploy path is unchanged.
  const desktopPerf = await deps.desktopPerfGate?.(candidate).catch(() => undefined);
  if (desktopPerf && desktopPerf.action !== 'pass') {
    deps.log(desktopPerf.summary);
    await deps.broadcast(desktopPerf.summary).catch(() => {});
    if (desktopPerf.action === 'block') {
      await deps
        .escalate?.(`green-checkpoint held: ${candidate.slice(0, 8)} desktop-perf-regressed`, desktopPerf.summary)
        .catch(() => {});
      return { advanced: false, candidate, from: lastReady, green: true, reason: 'desktop-perf-held', summary: desktopPerf.summary };
    }
  }

  // P-016 (agent-tool-delta-protocol D-008): the delta SAFETY gate. If the
  // production semantic-delta flag is ON but the Lane-C scenarios (S23/S24/S25)
  // are not recorded-green-and-fresh, do not advance the green pin into a state
  // that ships an unverified silent-wrong-merge hazard. Default-WARN (surface +
  // still advance); BLOCK only when the owner armed block-mode. Flag-gated +
  // fail-closed-when-armed (a no-op `pass` unless enabled), so the default deploy
  // path is unchanged until the owner opts in.
  const delta = await deps.deltaGate?.(candidate).catch(() => undefined);
  if (delta && delta.action !== 'pass') {
    deps.log(delta.summary);
    await deps.broadcast(delta.summary).catch(() => {});
    if (delta.action === 'block') {
      await deps
        .escalate?.(`green-checkpoint held: ${candidate.slice(0, 8)} delta-unproven`, delta.summary)
        .catch(() => {});
      return { advanced: false, candidate, from: lastReady, green: true, reason: 'delta-held', summary: delta.summary };
    }
  }

  // EI-11118 (P-009 durable fix): the Cupboard prod-hygiene gate. Scans the live
  // prod storefront for E2E/smoke test-junk (default-WARN — surface + still
  // advance; BLOCK only when the owner armed block-mode), so a re-accumulation
  // of the P-009 junk pattern is visible at every green deploy instead of
  // silently piling up until the next manual sweep.
  const cupboardHygiene = await deps.cupboardHygieneGate?.(candidate).catch(() => undefined);
  if (cupboardHygiene && cupboardHygiene.action !== 'pass') {
    deps.log(cupboardHygiene.summary);
    await deps.broadcast(cupboardHygiene.summary).catch(() => {});
    if (cupboardHygiene.action === 'block') {
      await deps
        .escalate?.(`green-checkpoint held: ${candidate.slice(0, 8)} cupboard prod storefront polluted`, cupboardHygiene.summary)
        .catch(() => {});
      return {
        advanced: false,
        candidate,
        from: lastReady,
        green: true,
        reason: 'cupboard-hygiene-held',
        summary: cupboardHygiene.summary,
      };
    }
  }

  const adv = await deps.advance(candidate);
  if (adv.advanced && !opts.noPush) {
    await deps.push(cfg.releaseRef).catch((e) => deps.log(`warn: push ${cfg.releaseRef} failed: ${e}`));
  }
  deps.log(`✅ ${cfg.releaseRef} advanced ${adv.from?.slice(0, 8) ?? 'none'} → ${candidate.slice(0, 8)} (green)`);
  const flakeNote = flakeSuspects?.length
    ? `\n\n⚠️ Load-flake absorbed: ${flakeSuspects.join(', ')} failed under the gate's concurrent load (a per-file flake, or a worker-pool OOM crash) but PASSED on a reduced-concurrency re-run. Consider quarantining / investigating memory if it recurs.`
    : '';
  await deps
    .broadcast(
      `🟩 green-checkpoint: \`${cfg.releaseRef}\` advanced to ${candidate.slice(0, 8)} (green, deployable)${flakeSuspects?.length ? ' [load-flake absorbed]' : ''}`,
      `Was ${adv.from?.slice(0, 8) ?? 'unset'}. The next deploy will pick this up.${flakeNote}`,
    )
    .catch(() => {});
  // P-002: the gate recovered — resolve any open `release-not-green` escalation.
  await deps.clearEscalation?.().catch(() => {});
  // await-event-primitive-2026-06-05 P-015: `release:green` is awaitable — an agent blocked
  // on "the next green ready" sleeps on it (events:await) instead of polling the checkpoint.
  // EI-10800: AWAIT it (was a fire-and-forget `void import(...)` that raced this function's
  // immediate return → process teardown, so `release:green:<pipeline>` never once woke an
  // awaiter: 87 timeouts / 0 events across its whole history). Global key (back-compat) +
  // pipeline-scoped (EI-7646). Fail-soft but LOUD — a broken emit is logged, never swallowed.
  {
    const greenSummary = `${cfg.releaseRef} advanced to ${candidate.slice(0, 8)} (green, deployable)`;
    const pipeline = pipelineName(cfg.integrationRoot);
    // WI-4957: runId (this run's identity) rides the payload alongside sha/from/pipeline.
    const payload = { sha: candidate, from: adv.from, pipeline, runId: deps.runId ?? null };
    // EI-12457: this candidate resolved green — a subscriber's still-pending red
    // await for this pipeline can now never legitimately fire.
    const cancelSiblingKeysFor = ['green-checkpoint:red', `green-checkpoint:red:${pipeline}`];
    try {
      await deps.emitEvent?.({ key: 'release:green', summary: greenSummary, payload, cancelSiblingKeysFor });
      await deps.emitEvent?.({ key: `release:green:${pipeline}`, summary: greenSummary, payload, cancelSiblingKeysFor });
    } catch (e) {
      deps.log(`warn: release:green emit failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return {
    advanced: adv.advanced,
    candidate,
    from: adv.from,
    green: true,
    reason: 'advanced',
    summary,
    ...(flakeSuspects?.length ? { flakeSuspects } : {}),
    ...(deps.runId ? { runId: deps.runId } : {}),
  };
}

/** Real effect wiring. The heavy bit — runGreen — runs the configured suite in
 *  the isolated checkpoint tree with AFFECTED_BASE pinned to the last green. */
/** The shell-exec seam realCheckpointDeps shells the heavy ops through. Defaults
 *  to the module's spawn-backed runCmd; injected as a fake so the real-path
 *  WIRING (env-strip, SPA-build-folds-into-green per P-005, the push guard, the
 *  setup-script invocation) is unit-testable without running the suite / build /
 *  a git push (hive-run-evaluation gap #10). */
export type CheckpointExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; allowNonZero?: boolean; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** load-flake-isolation-2026-06-23: hard cap for ONE isolated single-file re-run.
 *  A single test file at single concurrency finishes in seconds; 5 min covers even a
 *  cold heavy `await import()` graph. On timeout the exec REJECTS → the absorption step
 *  records that file errored → it counts as still-failing (never a false green). */
export const ISOLATION_RUN_TIMEOUT_MS = 5 * 60_000;

/** worker-pool-crash-absorption-2026-06-25 (WI-806): hard cap for ONE crashed-workspace
 *  re-run at single concurrency. A whole workspace suite (vs one file) needs more room
 *  than the per-file isolation run, but must still bound a genuine hang. On timeout the
 *  exec REJECTS → attemptWorkerCrashAbsorption treats it as still-failing (never a false
 *  green). */
export const WORKSPACE_RERUN_TIMEOUT_MS = 15 * 60_000;

/**
 * EI-8744: is there NOTHING the (npm) green command could gate in this tree?
 *
 * A codeless pot (e.g. `extends coding` but only a README + `.papercusp` state — NO
 * `package.json`) has nothing `npm run test:affected` can run: npm dies with
 * `Missing script: test:affected` (rc=1) BEFORE any test executes. The gate then went
 * hard-RED with an EMPTY failing-test signature, so the release-fixer bee — dispatched
 * hourly on that red — had no failing test to fix and could only escalate, and the red
 * recurred every hour (wasted release-fixer churn on a codeless E2E-scaffold pot).
 *
 * "Nothing to gate" is GREEN, not RED — matching affected-tests.mjs's own
 * "No affected workspaces." (exit 0) green path and the `spaBuildWorkspace===''`
 * SPA-build skip in {@link realCheckpointDeps}. This is a PURE decision so it is unit
 * testable without a real checkout/suite run:
 *   - Guarded to an NPM-based greenCmd (default `npm run test:affected`): a non-npm
 *     greenCmd (e.g. `cargo test`) can gate real code with no `package.json`, so it is
 *     NEVER treated as nothing-to-gate.
 *   - Fires ONLY when the tree has NO root `package.json`. The papercusp integration
 *     tree — and every real coding pot — always commits a root `package.json`, so this
 *     is a STRICT no-op for the fleet-critical pipeline: it can only ever flip the
 *     degenerate codeless case (where there is genuinely nothing testable) green.
 */
export function isNothingToGate(greenCmd: string, treeHasPackageJson: boolean): boolean {
  const npmGreenCmd = /^npm(\s|$)/.test(greenCmd.trim());
  return npmGreenCmd && !treeHasPackageJson;
}

/** Whether the isolated candidate checkout exposes the platform typecheck leg.
 *
 * The Papercusp root owns `lint:tsc`; subject hives are allowed to omit it, so the
 * release gate must discover the script rather than blindly running an operator-only
 * command in every per-hive checkout. A missing script means there is no typecheck leg
 * for that subject, not a typecheck failure.
 */
export function hasNpmScript(treeDir: string, scriptName: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(treeDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof pkg.scripts?.[scriptName] === 'string' && pkg.scripts[scriptName].trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * EI-18661485259809120: every commit git-sync produces (and therefore every commit
 * `main` ever advances to, since main only ever FAST-FORWARDS from a staging commit
 * — it never gets a fresh commit of its own) carries a literal `[skip ci]` suffix
 * (run-git-sync.ts's default message). GitHub Actions honors `[skip ci]` in the HEAD
 * commit message for BOTH `push` and `pull_request` events, so test.yml's `push:
 * branches: [main]` trigger has never actually fired on a real `main` advance since
 * the staging->main model landed (confirmed: its last real push-triggered run was
 * 2026-06-30, and the failure that stopped it there is unrelated + already fixed on
 * HEAD) — its "GATING" lints have been gating nothing.
 *
 * `workflow_dispatch` is a DIFFERENT trigger type, not filtered by a commit's
 * `[skip ci]` marker, so we fire it explicitly right after each real FF of `main` —
 * once per green-checkpoint promotion (not on every git-sync tick to `staging`,
 * which this is never called for). Best-effort: a GitHub API hiccup (network, auth,
 * missing `workflow_dispatch:` trigger on a fork) must never fail the checkpoint
 * itself, so every failure is caught and only logged.
 */
async function dispatchCiWorkflow(integrationRoot: string, ref: string, log: (s: string) => void): Promise<void> {
  try {
    const { gitOriginUrl, parseGithubRemote } = await import(
      '@papercusp/operator-core/lib/cupboard/resolve-repo-coords'
    );
    const origin = await gitOriginUrl(integrationRoot);
    const coords = origin ? parseGithubRemote(origin) : null;
    if (!coords) {
      log(`ci-dispatch: skipped — no GitHub origin resolved for ${integrationRoot}`);
      return;
    }
    const { getOctokit } = await import('@papercusp/operator-core/lib/identity/octokit-client');
    const oc = await getOctokit();
    if (!oc) {
      log('ci-dispatch: skipped — gh not authenticated');
      return;
    }
    await oc.rest.actions.createWorkflowDispatch({
      owner: coords.owner,
      repo: coords.repo,
      workflow_id: 'test.yml',
      ref,
    });
    log(`ci-dispatch: triggered test.yml on ${coords.owner}/${coords.repo}@${ref}`);
  } catch (e) {
    log(`warn: ci-dispatch failed (non-fatal, test.yml stays un-re-verified this tick): ${e}`);
  }
}

/** WI-6053: one post-suite leg's TRI-STATE outcome.
 *
 *  Each leg used to be a plain `let xOk = true` that only ever got assigned when the leg
 *  actually ran — so "never ran" and "ran and passed" were the SAME value, and nothing
 *  downstream could tell them apart. Three states make the difference representable, which
 *  is the whole point: a skipped leg can never again be counted as a pass. */
type LegStatus = 'passed' | 'failed' | 'skipped';

interface LegOutcome {
  status: LegStatus;
  /** Why a skipped leg was skipped — a subject hive without the script, or an earlier
   *  leg having already failed (the chain short-circuits). Never an assertion of health. */
  skipReason?: string;
}

interface PostSuiteLegs {
  /** True when no leg FAILED. A skipped leg is neither a pass nor a fail: it is the
   *  documented subject-hive opt-out, and it never contributes evidence of green. */
  ok: boolean;
  typecheck: LegOutcome;
  lintMigrations: LegOutcome;
  lintIdentity: LegOutcome;
  lintDesignPrimitives: LegOutcome;
  build: LegOutcome;
  /** Concatenated failure detail, appended verbatim to the suite output. */
  output: string;
  /** P-012 signature fragments for whichever legs failed (`lint:tsc`, …). */
  failingSignatures: string[];
}

/** The legs' state when the suite is NOT (yet) considered passing: every one skipped,
 *  with the reason recorded. `ok` is true because nothing failed — but every individual
 *  status is `skipped`, so no consumer can mistake this for five passes. */
function legsNotRun(skipReason: string): PostSuiteLegs {
  const skipped: LegOutcome = { status: 'skipped', skipReason };
  return {
    ok: true,
    typecheck: skipped,
    lintMigrations: skipped,
    lintIdentity: skipped,
    lintDesignPrimitives: skipped,
    build: skipped,
    output: '',
    failingSignatures: [],
  };
}

/**
 * WI-6053: every check that stands between a passing SUITE and a green verdict, in one
 * place, run as a unit.
 *
 * These five legs (typecheck · migrations lint · the 3 identity-leak lints ·
 * design-primitives lint · SPA build) were previously five inline blocks in runGreen, each
 * gated on `r.code === 0` — the raw SUITE exit code — while each `*Ok` flag defaulted to
 * `true`. That coupling was invisible and wrong: when the suite went red the legs all
 * skipped and kept their `true` defaults, and flake-absorption then set `green = true`
 * without re-running or re-checking any of them. Every absorbed-green candidate was
 * fast-forwarded to `main` with all five merely ASSUMED. That is how afdbda332b's
 * operator-core type errors reached `main` on 2026-07-26 — the gate reported green having
 * never typechecked, linted, or built the tree.
 *
 * Hoisting them here makes "the suite is considered passing" the single trigger, so the
 * absorption path can pay the same price the native path pays. The chain still
 * short-circuits (a failing leg skips the rest — a red is a red, and the remaining legs
 * cost real gate minutes), and a subject hive without a script still opts out per-leg via
 * hasNpmScript. The ORDER is deliberate and asserted by green-checkpoint-real-deps.test.ts:
 * cheapest-and-most-diagnostic first, the expensive SPA build last.
 */
export async function runPostSuiteLegs(
  treeDir: string,
  env: NodeJS.ProcessEnv,
  exec: CheckpointExec,
  spaWorkspace: string,
): Promise<PostSuiteLegs> {
  const legs = legsNotRun('not reached');
  const outputs: string[] = [];
  const failingSignatures: string[] = [];
  /** Short-circuit reason once a leg has failed — every later leg records THIS, so the
   *  verdict says "not run because typecheck failed", never a bare skip. */
  let haltedBy: string | undefined;

  // WI-4493: `test:affected` is an esbuild/Vitest gate and does not typecheck
  // operator-core. The Papercusp root's `lint:tsc` ratchet catches new per-file
  // regressions, so run it in the same isolated candidate tree before allowing the
  // candidate through the release gate. Subject hives without that script retain their
  // existing gate semantics.
  if (!hasNpmScript(treeDir, 'lint:tsc')) {
    legs.typecheck = { status: 'skipped', skipReason: 'candidate provides no lint:tsc script' };
  } else {
    const typecheck = await exec('npm', ['run', 'lint:tsc'], { cwd: treeDir, env, allowNonZero: true });
    legs.typecheck = { status: typecheck.code === 0 ? 'passed' : 'failed' };
    if (typecheck.code !== 0) {
      haltedBy = 'lint:tsc failed';
      failingSignatures.push('lint:tsc');
      outputs.push(
        '\n\n=== TYPECHECK FAILED (npm run lint:tsc) — operator-core type regressions block the release ===\n' +
          typecheck.stdout +
          typecheck.stderr,
      );
    }
  }

  // EI-485: lint:migrations' PG-backed "unreserved migration number" check (a hand-picked
  // NNN that skipped db:next-migration) was never wired into any automated gate — its 3
  // pure-filesystem checks (dup-NNN, raw transaction control, unguarded RENAME CONSTRAINT)
  // got wired into the vitest suite itself (lint-migrations.test.ts, EI-6843) and so
  // already ran on every `test:affected`, but the PG-backed leg only ever ran on a manual
  // `npm run lint:migrations` — which nobody ran, so real drift (16 already-applied numbers
  // >= ENFORCED_FROM lacking a reservation row, backfilled in
  // 620-backfill-migration-reservations-ei485.sql) reached green `main` undetected. Cheap
  // (one fs scan + one PG query; gracefully skips the PG leg when unreachable, never a
  // false red) and the checkpoint tree has a reachable PG, so gate it here like lint:tsc.
  if (haltedBy) {
    legs.lintMigrations = { status: 'skipped', skipReason: haltedBy };
  } else if (!hasNpmScript(treeDir, 'lint:migrations')) {
    legs.lintMigrations = { status: 'skipped', skipReason: 'candidate provides no lint:migrations script' };
  } else {
    const migrations = await exec('npm', ['run', 'lint:migrations'], { cwd: treeDir, env, allowNonZero: true });
    legs.lintMigrations = { status: migrations.code === 0 ? 'passed' : 'failed' };
    if (migrations.code !== 0) {
      haltedBy = 'lint:migrations failed';
      failingSignatures.push('lint:migrations');
      outputs.push(
        '\n\n=== MIGRATION LINT FAILED (npm run lint:migrations) — committed migration-file discipline / unreserved migration number ===\n' +
          migrations.stdout +
          migrations.stderr,
      );
    }
  }

  // EI-18147177863084708: the 3 identity-leak lints (check-no-owner-name-tags.mjs =
  // `[owner:<name>]` provenance tags; check-no-box-identity.mjs = hardcoded `/home/<user>/`
  // paths; check-no-identity-literals.mjs = bare box git-name/email/hostname/OS-user)
  // previously ran ONLY inside release-local.sh's WI-4776 gate, at release-CUT time — so a
  // leak an agent authors on `staging` (a `[owner:Jane …]` tag or a stray box-identity
  // literal is CORRECT on a carry surface but a leak in shipped source) sat undetected
  // through every green-checkpoint tick until a release attempt finally tripped over it,
  // sometimes dozens of commits later: the 0.0.12 Windows Server cut (2026-07-20) hit 24
  // accumulated leaks across 13 files, killing 2 cut attempts ~30min each. These are GLOBAL
  // source scans, independent of the candidate diff — same rationale as
  // lint:design-primitives below. Unlike release-local.sh's `&&`-chain (which only ever
  // shows the FIRST failing lint's leaks, forcing whack-a-mole across multiple builds),
  // every one of the three runs and every failure is reported together in one verdict.
  if (haltedBy) {
    legs.lintIdentity = { status: 'skipped', skipReason: haltedBy };
  } else {
    const identityLints: Array<{ script: string; label: string }> = [
      { script: 'lint:no-owner-name-tags', label: 'OWNER-NAME TAG' },
      { script: 'lint:no-box-identity', label: 'BOX-IDENTITY PATH' },
      { script: 'lint:no-identity-literals', label: 'BOX IDENTITY LITERAL' },
    ];
    const identityFailures: string[] = [];
    let identityRan = 0;
    for (const { script, label } of identityLints) {
      if (!hasNpmScript(treeDir, script)) continue;
      identityRan++;
      const out = await exec('npm', ['run', script], { cwd: treeDir, env, allowNonZero: true });
      if (out.code !== 0) {
        identityFailures.push(`\n\n=== ${label} LINT FAILED (npm run ${script}, WI-4776 class) ===\n` + out.stdout + out.stderr);
      }
    }
    legs.lintIdentity = identityRan === 0
      ? { status: 'skipped', skipReason: 'candidate provides none of the 3 identity-leak lint scripts' }
      : { status: identityFailures.length === 0 ? 'passed' : 'failed' };
    if (identityFailures.length) {
      haltedBy = 'identity-leak lints failed';
      failingSignatures.push('lint:identity-leak');
      outputs.push(
        '\n\n=== IDENTITY-LEAK LINTS FAILED (WI-4776 class — owner-name tag / box path / box identity literal committed to tracked source) ===' +
          identityFailures.join(''),
      );
    }
  }

  // EI-18218408212070282: `test:affected` (the suite leg) only runs a workspace's suite when
  // that workspace is in the CANDIDATE DIFF's affected set (scripts/affected-tests.mjs).
  // design-primitives.test.ts and its siblings (css-tokens.test.ts, contrast.test.ts) are
  // GLOBAL source-scanning lints — they scan the WHOLE apps/operator + operator-vite tree
  // for token/primitive compliance, independent of what this candidate's diff touched. So a
  // candidate whose diff doesn't happen to touch @papercusp/web (or anything
  // reverse-depending on it) skipped them entirely, and a real, pre-existing violation
  // elsewhere in the tree rode straight into the green pin: the gate flapped red<->green on
  // the SAME uncorrected violation purely depending on each candidate's diff shape, not on
  // whether the tree was actually clean. Run it here — never gated by the affected set — so
  // "green" means the whole tree's design-primitive invariants hold, not just the diffed
  // slice. `npm run test:file` (scripts/test-files.mjs) resolves each file to its owning
  // Vitest config and hard-fails on a zero/partial match, so a future rename of any of the
  // three files fails LOUDLY here instead of silently stopping being gated.
  if (haltedBy) {
    legs.lintDesignPrimitives = { status: 'skipped', skipReason: haltedBy };
  } else if (!hasNpmScript(treeDir, 'lint:design-primitives')) {
    legs.lintDesignPrimitives = { status: 'skipped', skipReason: 'candidate provides no lint:design-primitives script' };
  } else {
    const designPrimitives = await exec('npm', ['run', 'lint:design-primitives'], { cwd: treeDir, env, allowNonZero: true });
    legs.lintDesignPrimitives = { status: designPrimitives.code === 0 ? 'passed' : 'failed' };
    if (designPrimitives.code !== 0) {
      haltedBy = 'lint:design-primitives failed';
      failingSignatures.push('lint:design-primitives');
      outputs.push(
        '\n\n=== DESIGN PRIMITIVES LINT FAILED (npm run lint:design-primitives) — global token/primitive scan, independent of the affected set ===\n' +
          designPrimitives.stdout +
          designPrimitives.stderr,
      );
    }
  }

  // P-005: the SPA build is PART of "green". A build break (a bad import, a type error in a
  // bundled module) passes the Vitest suite, then fails at the deploy's swap step
  // (`--build-spa`) and rolls back — needlessly draining + restarting the live :3070
  // (2026-06-09 13:31–14:00: three rolled-back deploys of the same broken green). Build it
  // here, in the isolated checkpoint tree, so a broken build holds `main` like any other red
  // — before it ever reaches a deploy.
  //
  // The SPA build is the platform operator SPA (@papercusp/operator-vite by default). A
  // per-hive SUBJECT repo with no operator SPA sets cfg.spaBuildWorkspace='' (via
  // PAPERCUSP_SPA_BUILD_WORKSPACE in its env overlay): there is nothing to build, so SKIP it
  // and let the gate = the hive's test suite. Hardcoding the workspace here made
  // `npm --workspace @papercusp/operator-vite run build` die with "No workspaces found" on
  // every per-hive gate, holding that hive's `main` forever (oddsmith).
  if (haltedBy) {
    legs.build = { status: 'skipped', skipReason: haltedBy };
  } else if (!spaWorkspace) {
    legs.build = { status: 'skipped', skipReason: 'hive declares no SPA build workspace' };
  } else {
    // EI-1836: a COMMITTED git conflict marker makes the SPA build die with a cryptic
    // CssSyntaxError ("Unknown word Stashed"). On 2026-06-20 three such markers in
    // globals.css (a bad git-sync auto-merge — the live-merge resolver doesn't catch
    // already-committed ones) froze the SPA/sidecar/WI-280-witness/green-checkpoint builds:
    // the whole fleet deploy, on a stray word in CSS, with no named root. Catch markers
    // HERE, before the expensive+cryptic build, so the held gate NAMES the file:line. git
    // grep (not scripts/check-conflict-markers.mjs) keeps this robust for an older candidate
    // tree predating that script. The ERE mirrors its CONFLICT_MARKER_ERE: 7 of `<`/`>`/`|`
    // at line start — brackets every git conflict, zero false positives (the bare `=======`
    // separator is excluded as FP-prone). git grep exit 0 = match found, 1 = clean.
    const markers = await exec('git', ['grep', '-n', '-I', '-E', '^(<{7}|>{7}|\\|{7})([ \\t]|$)', '--', '.'], {
      cwd: treeDir,
      env,
      allowNonZero: true,
    });
    if (markers.code === 0 && markers.stdout.trim()) {
      // Treat exactly like a failed build (folds @papercusp/operator-vite into
      // checkpointFailureSignature) and SKIP the build entirely — it would only die
      // cryptically on the same markers.
      legs.build = { status: 'failed' };
      outputs.push(
        '\n\n=== COMMITTED CONFLICT MARKERS (@papercusp/operator-vite, EI-1836) — would break the SPA build ===\n' + markers.stdout,
      );
    } else {
      // PAPERCUSP_RETAIN_DIST_CHUNKS=1 — this build targets the LIVE WORKING TREE, which is
      // exactly where desktop windows are open (:3170/:3270 serve this dist). A default
      // one-shot build stages into dist.next/ and SWAPS it over dist/, deleting every old
      // hashed chunk; any window opened before the swap then 404s the lazy chunk it is
      // pinned to and dead-ends on "Importing a module script failed" (owner-reported
      // 2026-07-26). Because this gate runs on a TIMER, it broke every open window on a
      // schedule — and the error card blames "the dev build watcher", so it was never traced
      // back to here. Retention is the documented cure (WI-1484): emptyOutDir:false +
      // devDistPrunePlugin's age-prune, so old chunks survive long enough for an open webview
      // and are still bounded.
      // ⚠ This does NOT weaken the gate: index.html always points at the NEW chunks, so what
      // is verified/deployed is unchanged — retained chunks are extra files, and on a fresh
      // checkout (the release build) there are none to retain, which is why the release path
      // is deliberately left alone.
      const b = await exec('npm', ['--workspace', '@papercusp/operator-vite', 'run', 'build'], {
        cwd: treeDir,
        env: { ...env, PAPERCUSP_RETAIN_DIST_CHUNKS: '1' },
        allowNonZero: true,
      });
      legs.build = { status: b.code === 0 ? 'passed' : 'failed' };
      if (b.code !== 0) {
        outputs.push('\n\n=== SPA BUILD FAILED (@papercusp/operator-vite) — would fail the deploy swap ===\n' + b.stdout + b.stderr);
      }
    }
  }

  legs.ok = ![legs.typecheck, legs.lintMigrations, legs.lintIdentity, legs.lintDesignPrimitives, legs.build].some(
    (l) => l.status === 'failed',
  );
  legs.output = outputs.join('');
  legs.failingSignatures = failingSignatures;
  return legs;
}

export function realCheckpointDeps(
  cfg: ReleaseConfig,
  exec: CheckpointExec = runCmd,
  /** WI-4957: this process's own run identity — defaults to a fresh randomUUID() so every
   *  real invocation is self-identifying without the CLI having to remember to generate
   *  one; the CLI still passes its OWN pre-generated id explicitly (see the entrypoint
   *  below) so the SAME runId appears in both the normal verdict path and the self-watchdog
   *  emergency-red path, which builds deps separately. */
  runId: string = randomUUID(),
  /** EI-18104902318285612: test-only seam threaded straight through to the
   *  attemptFlakeAbsorption call inside runGreen (its own now/sleep/retry* options).
   *  A REAL invocation always omits this, so production behaviour is byte-identical
   *  (attemptFlakeAbsorption defaults to real Date.now/setTimeout). A unit test whose
   *  fixture makes a file fail on every isolation attempt (retryMax=1 still retries
   *  ONCE before giving up) can inject a no-op `sleep` here so it never performs a
   *  real ISOLATION_RETRY_DELAY_MS (5s) wait — eliminating the host-CPU-load timing
   *  correlation this previously gave green-checkpoint-real-deps.test.ts's "real
   *  break" / "fail-safe: re-run throws" cases (they retry a deterministically-still-
   *  failing file once, so ran a real 5s setTimeout on every invocation). */
  flakeAbsorptionOpts?: Parameters<typeof attemptFlakeAbsorption>[3],
): CheckpointDeps {
  const log = (s: string) => console.log(`[green-checkpoint] ${s}`);
  // load-flake-isolation-2026-06-23: re-run ONE originally-failing file in isolation —
  // a fresh `vitest run <file>` scoped to its workspace, at SINGLE concurrency
  // (VITEST_MAX_FORKS/THREADS=1) so the 8-fork load contention that caused the flake is
  // gone. Same committed-defaults env (buildGreenCheckpointEnv) + the same checkpoint
  // tree the suite ran in. A bounded timeout (ISOLATION_RUN_TIMEOUT_MS) caps a genuine
  // hang; on timeout/spawn-error the result is errored:true so the decision treats the
  // file as still-failing (never a false-green). `--no-file-parallelism` + the fork cap
  // give a clean, deterministic single-file run. Defined as a const (not `this`) so
  // runGreen can call it directly without depending on call-site binding.
  const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
    const env = buildGreenCheckpointEnv(null);
    env.VITEST_MAX_FORKS = '1';
    env.VITEST_MAX_THREADS = '1';
    // EI-18669336904251384: measure wall-clock duration so the retry-loop log can tell a
    // real ambient-load starvation (slow) apart from a fast deterministic failure (real
    // break / stale candidate) instead of blaming load unconditionally.
    const startedAt = Date.now();
    try {
      const r = await exec(
        'npm',
        ['run', 'test', '--workspace', workspace, '--', '--no-file-parallelism', file],
        { cwd: cfg.checkpointRoot, env, allowNonZero: true, timeoutMs: ISOLATION_RUN_TIMEOUT_MS },
      );
      return { workspace, file, passed: r.code === 0, durationMs: Date.now() - startedAt };
    } catch (e) {
      log(`isolation: vitest re-run of ${workspace}::${file} threw (${e instanceof Error ? e.message : e})`);
      return { workspace, file, passed: false, errored: true, durationMs: Date.now() - startedAt };
    }
  };
  // WI-806: re-run ONE crashed WORKSPACE's whole suite at REDUCED concurrency (a single
  // fork) after a vitest worker-pool crash (OOM/terminate under fleet load) that emitted
  // NO per-file `FAIL` lines. Same committed-defaults env + checkpoint tree as the gate
  // run, but VITEST_MAX_FORKS/THREADS forced to 1 so the load contention that crashed the
  // pool is gone. We classify the re-run: code 0 ⇒ passed (load-crash flake); a fresh
  // worker-pool crash ⇒ crashedAgain (undecided ⇒ stay red); any other non-zero ⇒
  // realFailure. A bounded timeout caps a genuine hang; on timeout/spawn-error this throws,
  // and attemptWorkerCrashAbsorption treats a throwing re-run as still-failing (never a
  // false green).
  const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
    const env = buildGreenCheckpointEnv(null);
    env.VITEST_MAX_FORKS = '1';
    env.VITEST_MAX_THREADS = '1';
    const r = await exec('npm', ['run', 'test', '--workspace', workspace], {
      cwd: cfg.checkpointRoot,
      env,
      allowNonZero: true,
      timeoutMs: WORKSPACE_RERUN_TIMEOUT_MS,
    });
    if (r.code === 0) return { workspace, passed: true };
    const out = r.stdout + r.stderr;
    if (isWorkerPoolCrash(out)) return { workspace, passed: false, crashedAgain: true };
    return { workspace, passed: false, realFailure: true };
  };
  return {
    isolationRun,
    workspaceRerun,
    runId,
    // EI-10800: the single AWAITED emit seam every gate-verdict now flows through. Was a
    // fire-and-forget `void import(...).then(emit)` inlined at each call site — the green
    // full-advance one raced the process teardown and never woke a `release:green:<pipeline>`
    // awaiter. Awaiting couples the emit's fireAwaitsForKey/insertDeliveries to the caller's
    // lifetime (the caller stays alive to record the pipeline_event, so the fire is durable).
    async emitEvent({ key, summary, payload, cancelSiblingKeysFor }) {
      const { emitAwaitedEvent } = await import('@papercusp/operator-core/lib/events/await/engine');
      await emitAwaitedEvent({ key, summary, payload, source: 'green-checkpoint', cancelSiblingKeysFor });
    },
    // EI-13992: real wiring for the migration-currency preflight (see
    // CheckpointDeps.ensureMigrationsCurrent doc) — applies to the SAME dev PG
    // db-boot-migrate targets at operator boot, just without its once-per-process
    // `_ran` guard (a gate run is its own per-invocation caller).
    async ensureMigrationsCurrent() {
      const { applyPendingMigrationsNow } = await import('@papercusp/operator-core/lib/db-boot-migrate');
      return applyPendingMigrationsNow();
    },
    // EI-18666996942859193: real wiring for the tree-drift preflight (see
    // CheckpointDeps.checkTreeDrift doc) — scoped to `cfg.checkpointRoot`, the ISOLATED
    // tree this run actually judges (a hardlink copy of the integration tree taken by
    // setupTree, which has already run by the time this is called).
    async checkTreeDrift() {
      const { checkLockTreeDrift } = await import('@papercusp/operator-core/lib/boot-integrity-preflight');
      return checkLockTreeDrift({ rootDir: cfg.checkpointRoot });
    },
    // EI-18669342433807110: real wiring for the in-flight-refire marker. Mirrors
    // recordOwnVerdict's own gate below (see the CLI entrypoint) — only the run our launcher
    // stamped as the record target writes gate_health at all; an un-stamped run (old-CLI/new-
    // routine skew, or a manual run with no target) silently no-ops, exactly like the final
    // verdict write does.
    async recordInFlightRetriage(info) {
      try {
        const { gateVerdictTargetFromEnv } = await import('@papercusp/operator-core/lib/release/gate-verdict-target');
        const target = gateVerdictTargetFromEnv();
        if (!target) return; // not the record-target-designated run — nothing to mark.
        const { recordInFlightRetriage: write } = await import('@papercusp/operator-core/lib/release/in-flight-retriage');
        await write(target, info);
      } catch {
        /* best-effort diagnostic — never let this break the checkpoint run */
      }
    },
    async setupTree(ref) {
      // P-019: the SCRIPT lives in the TOOLING tree (papercusp), not cfg.integrationRoot
      // (the SUBJECT — a per-hive repo has no release scripts). --integration stays the subject.
      const script = path.join(toolingRoot(), 'apps/operator/bin/release/setup-release-checkout.sh');
      // `force` (not `auto`) for the CHECKPOINT tree: the `auto` lockfile/entry-set
      // heuristic is structurally blind to NESTED dependency drift (e.g. astro's nested
      // get-tsconfig@5.0.0-beta.4 vs the hoisted root 4.14.0), so it intermittently left
      // the throwaway checkpoint tree's node_modules stale → spurious DETERMINISTIC reds
      // (astro check "no export readTsconfig"; native-addon-preflight better-sqlite3) that
      // red the gate for the WHOLE fleet while PASSING on the real integration tree
      // (EI-2699). A throwaway, correctness-critical tree must always re-copy from
      // integration; the hardlink (cp -al) copy is cheap. The DEPLOY keeps `auto` + the
      // verify-before-cutover preflight (mcp-host-availability-resilience-2026-06-22).
      await exec('bash', [script, '--ref', ref, '--integration', cfg.integrationRoot, '--release', cfg.checkpointRoot, '--node-modules', 'force']);
    },
    async runGreen(treeDir, base) {
      // EI-8744: nothing-to-gate short-circuit. A codeless pot (no root package.json)
      // can't run the npm green command — it dies with `Missing script` (rc=1) before any
      // test, and the gate went hard-RED with an empty failing-test signature, churning the
      // hourly release-fixer with nothing to fix. Nothing to gate ⇒ GREEN (see
      // isNothingToGate). Strict no-op for the real pipeline (always has a root package.json).
      if (isNothingToGate(cfg.greenCmd, existsSync(path.join(treeDir, 'package.json')))) {
        const note = `no package.json in ${treeDir} — nothing to gate (green command \`${cfg.greenCmd}\` has no script to run); treating as green (EI-8744)`;
        log(note);
        return { green: true, summary: note, failingTests: [] };
      }
      const [cmd, ...args] = cfg.greenCmd.split(' ');
      // The gate measures the COMMITTED DEFAULTS: buildGreenCheckpointEnv strips the
      // host's identity (all PAPERCUSP_* + HOST_ENV_STRIP), pins AFFECTED_BASE to the
      // last green, caps vitest parallelism + retries once to absorb load-flakes, and
      // marks GREEN_CHECKPOINT=1 (its doc records the incidents behind each rule).
      const env = buildGreenCheckpointEnv(base);
      const r = await exec(cmd, args, { cwd: treeDir, env, allowNonZero: true });

      // WI-4493: `test:affected` is an esbuild/Vitest gate and does not typecheck
      // operator-core. The Papercusp root's `lint:tsc` ratchet catches new per-file
      // regressions, so run it in the same isolated candidate tree before allowing
      // the candidate through the release gate. Subject hives without that script
      // retain their existing gate semantics.
      let typecheckOut = '';
      let typecheckOk = true;
      if (r.code === 0 && hasNpmScript(treeDir, 'lint:tsc')) {
        const typecheck = await exec('npm', ['run', 'lint:tsc'], {
          cwd: treeDir,
          env,
          allowNonZero: true,
        });
        typecheckOk = typecheck.code === 0;
        if (!typecheckOk) {
          typecheckOut =
            '\n\n=== TYPECHECK FAILED (npm run lint:tsc) — operator-core type regressions block the release ===\n' +
            typecheck.stdout +
            typecheck.stderr;
        }
      }

      // EI-485: lint:migrations' PG-backed "unreserved migration number" check (a
      // hand-picked NNN that skipped db:next-migration) was never wired into any
      // automated gate — its 3 pure-filesystem checks (dup-NNN, raw transaction
      // control, unguarded RENAME CONSTRAINT) got wired into the vitest suite itself
      // (lint-migrations.test.ts, EI-6843) and so already ran on every `test:affected`,
      // but the PG-backed leg only ever ran on a manual `npm run lint:migrations` —
      // which nobody ran, so real drift (16 already-applied numbers >= ENFORCED_FROM
      // lacking a reservation row, backfilled in 620-backfill-migration-reservations-
      // ei485.sql) reached green `main` undetected. Cheap (one fs scan + one PG query;
      // gracefully skips the PG leg when unreachable, never a false red) and the
      // checkpoint tree has a reachable PG, so gate it here like lint:tsc. A subject
      // hive without the script (hasNpmScript false — no migrations dir) skips this
      // leg entirely, same fallback as the typecheck leg above.
      let lintMigrationsOut = '';
      let lintMigrationsOk = true;
      if (r.code === 0 && typecheckOk && hasNpmScript(treeDir, 'lint:migrations')) {
        const migrations = await exec('npm', ['run', 'lint:migrations'], {
          cwd: treeDir,
          env,
          allowNonZero: true,
        });
        lintMigrationsOk = migrations.code === 0;
        if (!lintMigrationsOk) {
          lintMigrationsOut =
            '\n\n=== MIGRATION LINT FAILED (npm run lint:migrations) — committed migration-file discipline / unreserved migration number ===\n' +
            migrations.stdout +
            migrations.stderr;
        }
      }

      // EI-18147177863084708: the 3 identity-leak lints (check-no-owner-name-tags.mjs =
      // `[owner:<name>]` provenance tags; check-no-box-identity.mjs = hardcoded
      // `/home/<user>/` paths; check-no-identity-literals.mjs = bare box git-name/email/
      // hostname/OS-user) previously ran ONLY inside release-local.sh's WI-4776 gate, at
      // release-CUT time — so a leak an agent authors on `staging` (a `[owner:Jane …]` tag
      // or a stray box-identity literal is CORRECT on a carry surface but a leak in shipped
      // source) sits undetected through every green-checkpoint tick until a release attempt
      // finally trips over it, sometimes dozens of commits later: the 0.0.12 Windows Server
      // cut (2026-07-20) hit 24 accumulated leaks across 13 files, killing 2 cut attempts
      // ~30min each. These are GLOBAL source scans, independent of the candidate diff — same
      // rationale as lint:design-primitives below — so run all three here, UNCONDITIONALLY,
      // so a leak reds the checkpoint the tick it lands instead of surfacing only at cut
      // time. Unlike release-local.sh's `&&`-chain (which only ever shows the FIRST failing
      // lint's leaks, forcing whack-a-mole across multiple builds), every one of the three
      // is run and every failure is reported together in one verdict. A subject hive without
      // these scripts (hasNpmScript false) skips this leg entirely, same fallback as the
      // legs above.
      let lintIdentityOut = '';
      let lintIdentityOk = true;
      if (r.code === 0 && typecheckOk && lintMigrationsOk) {
        const identityLints: Array<{ script: string; label: string }> = [
          { script: 'lint:no-owner-name-tags', label: 'OWNER-NAME TAG' },
          { script: 'lint:no-box-identity', label: 'BOX-IDENTITY PATH' },
          { script: 'lint:no-identity-literals', label: 'BOX IDENTITY LITERAL' },
        ];
        const identityFailures: string[] = [];
        for (const { script, label } of identityLints) {
          if (!hasNpmScript(treeDir, script)) continue;
          const out = await exec('npm', ['run', script], { cwd: treeDir, env, allowNonZero: true });
          if (out.code !== 0) {
            identityFailures.push(`\n\n=== ${label} LINT FAILED (npm run ${script}, WI-4776 class) ===\n` + out.stdout + out.stderr);
          }
        }
        lintIdentityOk = identityFailures.length === 0;
        if (!lintIdentityOk) {
          lintIdentityOut =
            '\n\n=== IDENTITY-LEAK LINTS FAILED (WI-4776 class — owner-name tag / box path / box identity literal committed to tracked source) ===' +
            identityFailures.join('');
        }
      }

      // EI-18218408212070282: `test:affected` (the `r` leg above) only runs a workspace's
      // suite when that workspace is in the CANDIDATE DIFF's affected set (scripts/
      // affected-tests.mjs). design-primitives.test.ts and its siblings (css-tokens.test.ts,
      // contrast.test.ts) are GLOBAL source-scanning lints — they scan the WHOLE
      // apps/operator + operator-vite tree for token/primitive compliance, independent of
      // what this candidate's diff touched. So a candidate whose diff doesn't happen to
      // touch @papercusp/web (or anything reverse-depending on it) skips them entirely, and
      // a real, pre-existing violation elsewhere in the tree (e.g. left by an earlier
      // candidate whose OWN diff also missed the affected set, or a live-merge landing
      // between checkpoint runs) rides straight into the green pin: the gate flapped
      // red<->green on the SAME uncorrected violation purely depending on each candidate's
      // diff shape, not on whether the tree was actually clean. Run these three files
      // UNCONDITIONALLY here — like lint:tsc/lint:migrations above, never gated by the
      // affected set — so "green" means the whole tree's design-primitive invariants hold,
      // not just the diffed slice. `npm run test:file` (scripts/test-files.mjs) resolves
      // each file to its owning Vitest config and hard-fails on a zero/partial match, so a
      // future rename of any of the three files fails LOUDLY here instead of silently
      // stopping being gated. A subject hive without the script (hasNpmScript false — no
      // design-lint files) skips this leg entirely, same fallback as the legs above.
      let lintDesignPrimitivesOut = '';
      let lintDesignPrimitivesOk = true;
      if (r.code === 0 && typecheckOk && lintMigrationsOk && lintIdentityOk && hasNpmScript(treeDir, 'lint:design-primitives')) {
        const designPrimitives = await exec('npm', ['run', 'lint:design-primitives'], {
          cwd: treeDir,
          env,
          allowNonZero: true,
        });
        lintDesignPrimitivesOk = designPrimitives.code === 0;
        if (!lintDesignPrimitivesOk) {
          lintDesignPrimitivesOut =
            '\n\n=== DESIGN PRIMITIVES LINT FAILED (npm run lint:design-primitives) — global token/primitive scan, independent of the affected set ===\n' +
            designPrimitives.stdout +
            designPrimitives.stderr;
        }
      }

      // P-005: the SPA build is PART of "green". A build break (a bad import, a type
      // error in a bundled module) passes the Vitest suite, then fails at the deploy's
      // swap step (`--build-spa`) and rolls back — needlessly draining + restarting the
      // live :3070 (2026-06-09 13:31–14:00: three rolled-back deploys of the same broken
      // green). Build it here, in the isolated checkpoint tree, so a broken build holds
      // `main` like any other red — before it ever reaches a deploy. Only run it once the
      // suite is green (a red suite already holds `main`; no point building).
      let buildOut = '';
      let buildOk = true;
      // The SPA build is the platform operator SPA (@papercusp/operator-vite by default).
      // A per-hive SUBJECT repo with no operator SPA sets cfg.spaBuildWorkspace='' (via
      // PAPERCUSP_SPA_BUILD_WORKSPACE in its env overlay): there is nothing to build, so
      // SKIP it and let the gate = the hive's test suite. Hardcoding the workspace here
      // made `npm --workspace @papercusp/operator-vite run build` die with "No workspaces
      // found" on every per-hive gate, holding that hive's `main` forever (oddsmith).
      const spaWorkspace = cfg.spaBuildWorkspace;
      if (r.code === 0 && typecheckOk && lintMigrationsOk && lintIdentityOk && lintDesignPrimitivesOk && spaWorkspace) {
        // EI-1836: a COMMITTED git conflict marker makes the SPA build die with a
        // cryptic CssSyntaxError ("Unknown word Stashed"). On 2026-06-20 three such
        // markers in globals.css (a bad git-sync auto-merge — the live-merge resolver
        // doesn't catch already-committed ones) froze the SPA/sidecar/WI-280-witness/
        // green-checkpoint builds: the whole fleet deploy, on a stray word in CSS, with
        // no named root. Catch markers HERE, before the expensive+cryptic build, so the
        // held gate NAMES the file:line. git grep (not scripts/check-conflict-markers.mjs)
        // keeps this robust for an older candidate tree predating that script. The ERE
        // mirrors its CONFLICT_MARKER_ERE: 7 of `<`/`>`/`|` at line start — brackets every
        // git conflict, zero false positives (the bare `=======` separator is excluded as
        // FP-prone). git grep exit 0 = match found, 1 = clean.
        const markers = await exec(
          'git',
          ['grep', '-n', '-I', '-E', '^(<{7}|>{7}|\\|{7})([ \\t]|$)', '--', '.'],
          { cwd: treeDir, env, allowNonZero: true },
        );
        if (markers.code === 0 && markers.stdout.trim()) {
          // Treat exactly like a failed build (buildOk=false folds @papercusp/operator-vite
          // into checkpointFailureSignature) and SKIP the build entirely — it would only
          // die cryptically on the same markers.
          buildOk = false;
          buildOut =
            '\n\n=== COMMITTED CONFLICT MARKERS (@papercusp/operator-vite, EI-1836) — would break the SPA build ===\n' +
            markers.stdout;
        } else {
          // PAPERCUSP_RETAIN_DIST_CHUNKS=1 — this build targets the LIVE WORKING
          // TREE, which is exactly where desktop windows are open (:3170/:3270
          // serve this dist). A default one-shot build stages into dist.next/ and
          // SWAPS it over dist/, deleting every old hashed chunk; any window opened
          // before the swap then 404s the lazy chunk it is pinned to and dead-ends
          // on "Importing a module script failed" (owner-reported 2026-07-26).
          // Because this gate runs on a TIMER, it broke every open window on a
          // schedule — and the error card blames "the dev build watcher", so it was
          // never traced back to here. Retention is the documented cure (WI-1484):
          // emptyOutDir:false + devDistPrunePlugin's age-prune, so old chunks
          // survive long enough for an open webview and are still bounded.
          // ⚠ This does NOT weaken the gate: index.html always points at the NEW
          // chunks, so what is verified/deployed is unchanged — retained chunks are
          // extra files, and on a fresh checkout (the release build) there are none
          // to retain, which is why the release path is deliberately left alone.
          const b = await exec('npm', ['--workspace', '@papercusp/operator-vite', 'run', 'build'], {
            cwd: treeDir,
            env: { ...env, PAPERCUSP_RETAIN_DIST_CHUNKS: '1' },
            allowNonZero: true,
          });
          buildOk = b.code === 0;
          if (!buildOk) {
            buildOut = '\n\n=== SPA BUILD FAILED (@papercusp/operator-vite) — would fail the deploy swap ===\n' + b.stdout + b.stderr;
          }
        }
      }
      let green = r.code === 0 && typecheckOk && lintMigrationsOk && lintIdentityOk && lintDesignPrimitivesOk && buildOk;
      const fullOutput = r.stdout + r.stderr + typecheckOut + lintMigrationsOut + lintIdentityOut + lintDesignPrimitivesOut + buildOut;

      // load-flake-isolation-2026-06-23: the SAFE flake-absorption pass. ONLY when the
      // SUITE is what failed (r.code !== 0; the build only runs on a green suite, so
      // buildOk is still true here) — a build break is deterministic, never a load-flake.
      // Re-run each originally-failing FILE in isolation at single concurrency; if EVERY
      // one passes, the red was box-weather (the 8-fork checkpoint load) and the gate is
      // GREEN. If any still fails, it's a real break and the gate stays red. Fail-safe:
      // attemptFlakeAbsorption can only flip red→green on POSITIVE proof, never on error.
      // This is what AFFECTED_RETRY_FAILED=1 couldn't absorb for runner-aggregate.test.ts
      // + scheduler-workspace-scope.test.ts (the 2026-06-23 4h gate stall).
      let flakeSuspects: string[] | undefined;
      // isolation-retry-resilience-2026-07-19 (EI-15849): the absorber's own note,
      // persisted REGARDLESS of whether it absorbed — see CheckpointDeps.runGreen's
      // isolationNote doc for why (a not-absorbed verdict's reasoning was previously
      // undiagnosable after the fact).
      let isolationNote: string | undefined;
      if (r.code !== 0 && buildOk) {
        const outcome = await attemptFlakeAbsorption(fullOutput, isolationRun, log, flakeAbsorptionOpts);
        isolationNote = outcome.note;
        if (outcome.absorbedToGreen) {
          green = true;
          flakeSuspects = outcome.flakeSuspects;
        } else if (isWorkerPoolCrash(fullOutput) && parseFailingFilesByWorkspace(fullOutput).length === 0) {
          // WI-806: a vitest WORKER-POOL crash (a fork OOM/terminate under fleet load) emits
          // NO per-file `FAIL` lines, so the per-file isolation absorber above found zero
          // files and couldn't decide — it falls straight through to a hard RED that wedges
          // the whole release pipeline (the 5×-consecutive-red incident). ABSORB-OR-RETRY:
          // re-run the crashed WORKSPACE(S) once at reduced concurrency. Only a genuine
          // PASSING re-run flips to green (surfaced as a flake suspect); a re-crash or any
          // real failure stays red. Fail-safe — proof required, never a blanket green.
          const crash = await attemptWorkerCrashAbsorption(fullOutput, workspaceRerun, log);
          isolationNote = crash.note;
          if (crash.absorbedToGreen) {
            green = true;
            flakeSuspects = crash.flakeSuspects;
          }
        }
      }

      // Persist the FULL suite (+ build) output — the 2000-char tail below repeatedly
      // proved undiagnosable post-hoc ("2 non-quarantined task(s) failed" with no test
      // names survived the truncation; 2026-06-06/07 cost five diagnosis round-trips +
      // manual re-runs). One file per run, tiny disk, names every failure forever.
      // WI-4957: hoisted OUTSIDE the try so a verdict consumer gets an exact log reference
      // alongside the failing-test names, not just the truncated summary tail.
      let logPath: string | undefined;
      try {
        const logDir = cfg.checkpointLogDir;
        mkdirSync(logDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        logPath = path.join(logDir, `${stamp}-base-${(base ?? 'none').slice(0, 12)}.log`);
        writeFileSync(logPath, fullOutput);
        log(`full suite output → ${logPath}`);
        // P-014: prune logs older than 14 days so this dir doesn't grow unbounded.
        pruneOldLogs(logDir, 14);
      } catch { /* best-effort — the gate verdict must not depend on logging */ }

      // P-012: a stable failure signature from the FULL output (before truncation), folding
      // the SPA build break in, so the release-fixer dedups by WHAT failed, not the candidate
      // sha. The de-noised 2000-char tail rides the held-gate broadcast/escalation.
      let failingTests = checkpointFailureSignature(fullOutput, green, buildOk);
      if (!typecheckOk && !failingTests.includes('lint:tsc')) failingTests.push('lint:tsc');
      if (!lintMigrationsOk && !failingTests.includes('lint:migrations')) failingTests.push('lint:migrations');
      if (!lintIdentityOk && !failingTests.includes('lint:identity-leak')) failingTests.push('lint:identity-leak');
      if (!lintDesignPrimitivesOk && !failingTests.includes('lint:design-primitives')) failingTests.push('lint:design-primitives');
      let summary = summarizeSuiteOutput(fullOutput);
      if (!green && buildOk && failingTests.length) {
        try {
          const quarantinePath = path.join(treeDir, 'quarantine.txt');
          const quarantine = existsSync(quarantinePath) ? parseTestQuarantine(readFileSync(quarantinePath, 'utf8')) : [];
          const q = applyTestQuarantine(fullOutput, failingTests, quarantine);
          if (q.quarantined.length) {
            failingTests = q.failingTests;
            const note = `\n\nQuarantined out of v1 gate verdict: ${q.quarantined.join(', ')}`;
            summary = `${summary}${note}`.slice(-2000);
            log(`[green-checkpoint] ${q.quarantined.length} quarantined test failure(s) excluded from v1 verdict: ${q.quarantined.join(', ')}`);
          }
          if (q.allFailuresQuarantined) green = true;
        } catch (e) {
          log(`[green-checkpoint] quarantine read failed; preserving red verdict: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Workspace-mapped failures for the stale-candidate re-triage (which file, and the
      // cwd to re-run it in). Recomputed from the raw output, not `failingTests`, because
      // the re-triage needs the {workspace,file} pair, not the flat signature.
      const failingFiles = green ? [] : parseFailingFilesByWorkspace(fullOutput);
      return {
        green,
        summary,
        failingTests,
        ...(flakeSuspects?.length ? { flakeSuspects } : {}),
        ...(failingFiles.length ? { failingFiles } : {}),
        ...(logPath ? { logPath } : {}),
        ...(isolationNote ? { isolationNote } : {}),
      };
    },
    advance: (candidate) => advanceReady(cfg.integrationRoot, candidate, cfg.releaseRef),
    // Stale-candidate re-triage seams (P-004). The quiet-cut judges a commit that is
    // minutes-to-hours old; these let the gate ask "is this red still real at tip?".
    async resolveTip() {
      const r = await exec('git', ['-C', cfg.integrationRoot, 'rev-parse', cfg.integrationBranch], { allowNonZero: true });
      return r.code === 0 ? r.stdout.trim() || null : null;
    },
    async runTestsAtRef(ref, files) {
      // Re-run EXACTLY the originally-failing files, at `ref`, in a throwaway checkout —
      // never the churning integration tree (a concurrent edit would poison the answer).
      // Reuse the checkpoint tree the gate already prepared: point it at `ref`, then run
      // each failing file in its own workspace at single concurrency (the same isolation
      // the flake path uses, so a load-flake doesn't masquerade as a real red at tip).
      // A tree-setup failure is ABSENCE of evidence, not evidence the failures
      // reproduce. Returning {pass:false} here would reach classifyRedAgainstTip as
      // tipRetest={ran:true,pass:false} and render "failures REPRODUCE at tip <sha> —
      // genuine red" for a tip we never actually ran. Let it propagate: the caller's
      // .catch(() => null) maps it to tipRetest=null → the classifier's own
      // 'tip re-run unavailable' branch, which holds the gate just the same but says
      // the true thing. Same verdict, honest reason.
      //
      // WI-5110: the root fix now lives IN setupTree's own script
      // (setup-release-checkout.sh's assert_checkout_landed) — a zero exit from it
      // is an honest, self-verified guarantee that HEAD == ref, so this call either
      // succeeds with a genuinely-correct tree or throws (propagating to the caller's
      // .catch(() => null) → the honest 'tip re-run unavailable' fallback below).
      // No redundant re-check needed here; kept unduplicated on purpose (the single
      // source of truth is the script, not this call site).
      await this.setupTree(ref);
      // WI-5366: assert_checkout_landed proves the GIT state (HEAD == ref) but says
      // nothing about stale WORKING-TREE ARTIFACTS the script's clean step doesn't
      // touch (fixed alongside this: `git clean` now runs `-x`, but re-verifying the
      // sha HERE too — and threading it into the summary every caller logs — makes
      // any FUTURE staleness class in this tree (a different one, not yet found)
      // self-announcing instead of silently trusted the way the bare "REPRODUCE at
      // tip <sha>" verdict was before. Best-effort: a failure to resolve HEAD must
      // never block the real test run below.
      const verifiedHead = await revParse(cfg.checkpointRoot, 'HEAD').catch(() => 'unresolved');
      const headNote = `verified-head=${verifiedHead.slice(0, 12)} (requested ${ref.slice(0, 12)})`;
      const byWorkspace = new Map<string, string[]>();
      for (const f of files) byWorkspace.set(f.workspace, [...(byWorkspace.get(f.workspace) ?? []), f.file]);
      const env = buildGreenCheckpointEnv(null);
      env.VITEST_MAX_FORKS = '1';
      env.VITEST_MAX_THREADS = '1';
      const summaries: string[] = [headNote];
      for (const [workspace, wsFiles] of byWorkspace) {
        const r = await exec(
          'npm',
          ['run', 'test', '--workspace', workspace, '--', '--no-file-parallelism', ...wsFiles],
          { cwd: cfg.checkpointRoot, env, allowNonZero: true, timeoutMs: ISOLATION_RUN_TIMEOUT_MS },
        ).catch((e: unknown) => ({ code: 1, stdout: '', stderr: String(e) }));
        summaries.push(`${workspace}: ${r.code === 0 ? 'pass' : 'FAIL'}`);
        if (r.code !== 0) return { pass: false, summary: summaries.join('; ') };
      }
      return { pass: true, summary: summaries.join('; ') };
    },
    // Deploy-staleness alarm seam (P-005): how old is the deployed pin, and how far does
    // it trail tip? `null` on any git failure ⇒ the alarm simply doesn't fire.
    async deployStaleness() {
      try {
        const pin = await exec('git', ['-C', cfg.integrationRoot, 'rev-parse', cfg.releaseRef], { allowNonZero: true });
        if (pin.code !== 0) return null;
        const pinSha = pin.stdout.trim();
        const ts = await exec('git', ['-C', cfg.integrationRoot, 'show', '-s', '--format=%ct', pinSha], { allowNonZero: true });
        const behind = await exec('git', ['-C', cfg.integrationRoot, 'rev-list', '--count', `${pinSha}..${cfg.integrationBranch}`], { allowNonZero: true });
        if (ts.code !== 0 || behind.code !== 0) return null;
        const pinUnix = Number(ts.stdout.trim());
        const commitsBehind = Number(behind.stdout.trim());
        if (!Number.isFinite(pinUnix) || !Number.isFinite(commitsBehind)) return null;
        return { pinAgeMs: Date.now() - pinUnix * 1000, commitsBehind };
      } catch {
        return null;
      }
    },
    // P-016 (D-010): the batch commits oldest-first (full shas), from the integration
    // repo's own history — `from..to` excludes `from`, includes `to`.
    async commitsInRange(from, to) {
      const r = await exec('git', ['-C', cfg.integrationRoot, 'log', '--reverse', '--format=%H', `${from}..${to}`], {
        allowNonZero: true,
      });
      if (r.code !== 0) return [];
      return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    },
    // P-016 (D-010): affected workspace NAMES for the diff `from..to`, via the shared
    // resolver's range+print mode (changed files → workspaces → reverse-deps). Pure
    // git+graph, no test run. Returns null on any resolver failure so the caller holds.
    async affectedWorkspacesForRange(from, to) {
      const script = path.join(cfg.integrationRoot, 'scripts/affected-tests.mjs');
      const r = await exec('node', [script, '--range-from', from, '--range-to', to, '--print-affected'], {
        cwd: cfg.integrationRoot,
        allowNonZero: true,
      });
      if (r.code !== 0) return null;
      const prefix = 'AFFECTED_WS\t';
      return r.stdout
        .split('\n')
        .filter((l) => l.startsWith(prefix))
        .map((l) => l.slice(prefix.length).trim())
        .filter(Boolean);
    },
    // PAPERCUSP_MAIN_PUSH_OK=1 — green-checkpoint is the ONE writer allowed past
    // the pre-push guard on `main` (bin/git-hooks/pre-push). Everyone else's
    // pushes to main are blocked by that hook.
    push: async (ref) => {
      await exec('git', ['-C', cfg.integrationRoot, 'push', 'origin', `${ref}:${ref}`], {
        env: { ...process.env, PAPERCUSP_MAIN_PUSH_OK: '1' },
      });
      // See dispatchCiWorkflow's doc comment (EI-18661485259809120): the pushed commit's
      // `[skip ci]` message means the push above never actually triggers test.yml on
      // GitHub's side — re-fire it explicitly so the remote gate still runs.
      await dispatchCiWorkflow(cfg.integrationRoot, ref, log);
    },
    async broadcast(summary, body) {
      const { sendMessage } = await import('@papercusp/operator-core/lib/agent-tools/coordination/messages');
      // EI-15925: EVERY co-hosted pot runs its own green-checkpoint against its own
      // integrationRoot, and they all broadcast to the SAME audience `*` in the shared
      // workspace. Unlabelled, "`main` advanced to <sha>" from the oddsmith pipeline is
      // indistinguishable from papercusp's — on 2026-07-18 oddsmith's real 439b4037 was
      // read fleet-wide as a papercusp PHANTOM sha (it resolves in no papercusp repo),
      // during an open release decision where an executor resolves "the current green
      // sha" at cut time. An unattributable release broadcast can misdirect a cut into
      // a different product's commit. The event payload already carries `pipeline`
      // (see emitEvent above); the human/agent-facing message did not — it does now.
      const pipeline = pipelineName(cfg.integrationRoot);
      await sendMessage(
        {
          ownerId: 'green-checkpoint',
          ownerLabel: `green-checkpoint[${pipeline}]`,
          source: 'static-client',
          workspaceId: null,
          userId: null,
        },
        { to: ['*'], summary: `[${pipeline}] ${summary}`, body, category: 'service-health' },
      );
    },
    // P-002: durable human-facing escalation surface for a held gate. Tagged
    // `source: 'green-checkpoint'` so the open/clear pair is idempotent across
    // the hourly tick. Fail-safe — the gate verdict never depends on this.
    async escalate(summary, body) {
      const { openEscalation, listEscalations } = await import(
        '@papercusp/operator-core/lib/agent-tools/coordination/escalations'
      );
      const open = await listEscalations({ status: 'open' });
      if (open.some((e) => (e as Record<string, unknown>).source === 'green-checkpoint')) return;
      await openEscalation(
        { ownerId: 'green-checkpoint', ownerLabel: 'green-checkpoint', source: 'static-client', workspaceId: null, userId: null },
        { severity: 'blocker', summary, body, meta: { source: 'green-checkpoint' } },
      );
      // platform-ops-batch-2026-07-09 P-002: a LIVE push (desktop-native + mobile) the
      // moment the gate FIRST goes red — the durable escalation above already surfaces
      // in the Attention panel, but that is pull (the owner has to look); this is push,
      // symmetric with the self-watchdog's own notifyAttention call below. Fires once
      // per hold (the dedup return above skips this on every subsequent hourly tick
      // while still red — the rising-urgency `broadcast` tiers cover the "still red"
      // drumbeat instead of re-pushing every tick).
      try {
        const { notifyAttention } = await import('@papercusp/operator-core/lib/attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release gate RED',
          body: summary,
          importance: 'urgent',
          data: { source: 'green-checkpoint' },
        });
      } catch {
        // best-effort — the gate verdict never depends on the push landing.
      }
    },
    async clearEscalation() {
      const { listEscalations, resolveEscalation } = await import(
        '@papercusp/operator-core/lib/agent-tools/coordination/escalations'
      );
      const open = await listEscalations({ status: 'open' });
      for (const e of open) {
        if ((e as Record<string, unknown>).source === 'green-checkpoint') {
          await resolveEscalation({
            msg_id: e.msg_id,
            choice: 'gate green',
            resolver: 'green-checkpoint',
          }).catch(() => {});
        }
      }
    },
    // docs-audit #2: how long the current `release-not-green` escalation has been
    // open (= how long the gate's been held red), or null if none is open. The
    // escalation opens on first red, so this is null on the first red of a fresh
    // hold (no loud alert yet) and grows across the hourly ticks while held.
    async heldGateMs() {
      try {
        const { listEscalations } = await import(
          '@papercusp/operator-core/lib/agent-tools/coordination/escalations'
        );
        const open = await listEscalations({ status: 'open' });
        const e = open.find((x) => (x as Record<string, unknown>).source === 'green-checkpoint') as
          | { ts?: string }
          | undefined;
        if (!e?.ts) return null;
        const opened = Date.parse(e.ts);
        return Number.isFinite(opened) ? Math.max(0, Date.now() - opened) : null;
      } catch {
        return null; // never let the alarm read break the gate verdict
      }
    },
    // WI-2997 (EI-7443 follow-up): the real historical-flake lookup — 7d
    // testFlakeRollup + flagFlakeSuspects from dev-data.ts, the exact same
    // rollup dev:build_status folds into `flake_suspects`. Best-effort: any
    // error (e.g. no PG in a minimal/CLI context) yields {} — the caller's own
    // fail-soft wrapping then just skips the annotation.
    async flakeLookup(files) {
      try {
        const { testFlakeRollup, flagFlakeSuspects } = await import('@papercusp/operator-core/lib/dev-data');
        const { entries } = await testFlakeRollup(7);
        const suspectPaths = new Set(flagFlakeSuspects(entries, 7).map((s) => s.file_path));
        const byFile = new Map(entries.map((e) => [e.file_path, e]));
        const out: Record<string, { fails: number; passes: number; bothStatusShas: number; isSuspect: boolean }> = {};
        for (const f of files) {
          const e = byFile.get(f);
          if (e) {
            out[f] = { fails: e.fails, passes: e.passes, bothStatusShas: e.both_status_shas, isSuspect: suspectPaths.has(f) };
          }
        }
        return out;
      } catch {
        return {};
      }
    },
    // F2 (round-4 P-031): the real perf gate reads the latest perf-signals-v1 capture
    // and evaluates it against the per-thread budgets; policy comes from the env flags
    // (PAPERCUSP_PERF_GATE / PAPERCUSP_PERF_GATE_BLOCK). Inert (`pass`, reads nothing)
    // until the owner enables it.
    perfGate: (candidate) => runPerfGate(perfGatePolicyFromEnv(), candidate),
    // desktop-performance-suite-2026-07-20 P-011: the real desktop-perf gate reads
    // the latest persisted desktop-perf run (desktop_perf_runs) and evaluates its
    // budgeted measures. Policy from the FLAGS system (FLAGS.DESKTOP_PERF_GATE,
    // default ON — a FLAGS entry, not env; block-mode never armed in V1). A no-op
    // `pass` (reads nothing) when the flag is off or no run is recorded.
    desktopPerfGate: async (candidate) =>
      runDesktopPerfGate(await desktopPerfGatePolicyFromFlags(), { candidateSha: candidate }),
    // P-016 (agent-tool-delta-protocol D-008): the real delta gate reads the
    // baked production delta-flag default + the latest recorded Lane-C scenario
    // verdicts (llm_test_runs) — NOT a synchronous live-model eval. Policy from
    // the env flags (PAPERCUSP_DELTA_GATE / PAPERCUSP_DELTA_GATE_BLOCK). Inert
    // (`pass`, reads nothing) until the owner enables it.
    deltaGate: (candidate) =>
      runDeltaGate(deltaGatePolicyFromEnv(), candidate, {
        readFlagEnabled: async () => {
          const { FLAG_DEFAULTS, FLAGS } = await import('@papercusp/flags');
          // The deploy-gate signal is the BAKED default that ships, not a
          // per-user PostHog eval — "is the delta opt-in flipped on in this build".
          return FLAG_DEFAULTS[FLAGS.TOOL_DELTA_PROTOCOL] === true;
        },
        readVerdicts: async (ids) => {
          const { latestScenarioVerdicts } = await import(
            '@papercusp/operator-core/lib/llm-testing/storage'
          );
          return latestScenarioVerdicts(ids);
        },
        now: () => Date.now(),
      }),
    // EI-11118 (P-009 durable fix): the real gate scans the LIVE prod Cupboard
    // storefront (or PAPERCUSP_CUPBOARD_URL-overridden target). Policy from the
    // env flags (PAPERCUSP_CUPBOARD_HYGIENE_GATE / _BLOCK). Default-ON warn-only
    // — see cupboard-hygiene-gate.ts for why this one gate ships enabled.
    cupboardHygieneGate: async (candidate) => {
      const { runCupboardHygieneGate, cupboardHygienePolicyFromEnv } = await import('./cupboard-hygiene-gate');
      return runCupboardHygieneGate(cupboardHygienePolicyFromEnv(), candidate);
    },
    log,
  };
}

/** P-014: delete checkpoint-log files older than `days` so the dir doesn't grow
 *  unbounded (it was trending ~16MB / 43 files in 3 days). Best-effort, never throws. */
function pruneOldLogs(dir: string, days: number): void {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch { /* skip a vanished/locked file */ }
    }
  } catch { /* dir gone — nothing to prune */ }
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; allowNonZero?: boolean; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // A bounded timeout (used by the isolation re-run): SIGKILL the child and REJECT, so
    // a genuine hang can't stall the gate — the caller treats a rejected isolation re-run
    // as still-failing, never a flake.
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`${cmd} ${args.join(' ')} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0 || opts.allowNonZero) resolve({ code: code ?? 0, stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

// CLI: `tsx green-checkpoint.ts [--candidate <ref>] [--no-push]`
if (require.main === module) {
  const { releaseConfig } = require('./release-config') as typeof import('./release-config');
  const cfg = releaseConfig();
  const arg = (f: string) => {
    const i = process.argv.indexOf(f);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const emitResult = (r: CheckpointResult): void => {
    // The pretty result goes to STDERR (human-readable); STDOUT carries ONLY the
    // single marker line. CRITICAL for cross-version compat: the routine that invokes
    // this CLI runs from the integration tree, so a DEPLOYED (older) green-checkpoint
    // handler — which still brace-slices stdout `slice(indexOf('{'), lastIndexOf('}'))`
    // — runs THIS newer CLI. Two JSON objects on stdout (pretty + marker) made that
    // slice span both + the marker text → invalid JSON → recorded 'error' (and wedged
    // the pipeline). One object on stdout keeps the old brace-slice AND the new marker
    // parse both working.
    console.error(JSON.stringify(r, null, 2));
    console.log(`${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify(r)}`);
  };

  /**
   * WI-4494 — THE RUN RECORDS ITS OWN VERDICT.
   *
   * Before this, `gate_health` + the pipeline event were written by the ROUTINE that parsed our
   * stdout — so a DETACHED manual run (`release:checkpoint-run`) executed the whole suite, produced
   * a perfectly good green/red, and threw it away. That is what made run-lock contention lethal: a
   * manual run holds the lock for up to 55 min, the hourly routine fire lands mid-run and records
   * `skipped-locked` (a no-op — it has no verdict), and the run that DOES have the verdict discards
   * it. gate_health then freezes on a stale red, which dispatches more fixers, which fire more
   * manual runs. Observed live 2026-07-12: three consecutive fires skipped, the release pin frozen
   * ~10h. We are the producer; we record. Then the collision is harmless — whoever wins the lock is
   * the one with a verdict, and it lands.
   *
   * Fail-SAFE by construction: we record ONLY when our launcher stamped the record target into the
   * env (see gate-verdict-target.ts). No stamp ⇒ we return false, leave `recorded` unset, and the
   * caller records exactly as it always did — which is what keeps an old-routine/new-CLI skew (the
   * deployed tree driving the integration tree's CLI) working. Any failure here degrades to the
   * same place, so this can never leave the gate blind: the worst case is the old behaviour.
   */
  const recordOwnVerdict = async (r: CheckpointResult): Promise<boolean> => {
    try {
      const { gateVerdictTargetFromEnv } = await import('@papercusp/operator-core/lib/release/gate-verdict-target');
      const target = gateVerdictTargetFromEnv();
      if (!target) return false; // not launched with a record target — the caller records.
      const { recordCheckpointVerdict } = await import('@papercusp/operator-core/lib/harness/routines/release-actions');
      return await recordCheckpointVerdict(target, r);
    } catch (e) {
      console.error(`[green-checkpoint] verdict self-record failed (the caller will record): ${e instanceof Error ? e.message : e}`);
      return false;
    }
  };

  const candidateArg = arg('--candidate');
  // WI-4957: ONE runId for this whole process, shared by the normal verdict path
  // (realCheckpointDeps below) AND the self-watchdog emergency-red path (which builds its
  // own event payload independently) — so every event this process could possibly emit
  // carries the SAME run identity.
  const runId = randomUUID();
  const lock = acquireCheckpointRunLock(checkpointRunLockDir(cfg.checkpointLogDir, cfg.integrationRoot));
  if (!lock.acquired) {
    Promise.all([
      revParse(cfg.integrationRoot, candidateArg ?? cfg.integrationBranch).catch(() => candidateArg ?? cfg.integrationBranch),
      refExists(cfg.integrationRoot, cfg.releaseRef)
        .then((ok) => (ok ? revParse(cfg.integrationRoot, cfg.releaseRef) : null))
        .catch(() => null),
    ])
      .then(([candidate, from]) => {
        emitResult({
          advanced: false,
          candidate,
          from,
          green: null,
          // NOT 'up-to-date' (which release-actions treats as a benign green that resets
          // the stall streak): a lock-skip is a NON-advance, and a PERSISTENT one (a stale
          // lock that never reclaims) is exactly the silent multi-hour deploy freeze. Its
          // own reason keeps it OUT of the green set so trackGateStall counts it and the
          // held-gate alarm fires. (green-checkpoint-stale-lock-2026-06-26.)
          reason: 'skipped-locked',
          summary: `green-checkpoint skipped: another checkpoint process is already running${lock.owner?.pid ? ` (pid ${lock.owner.pid})` : ''}`,
        });
        process.exit(0);
      })
      .catch((e) => {
        console.error('[green-checkpoint] FAILED:', e instanceof Error ? e.message : e);
        process.exit(1);
      });
  } else {
    // WI-1319 root fix (c): arm the self-watchdog for the lifetime of this run —
    // canceled on every normal exit path below, so it only ever fires on a genuine
    // wedge (see armSelfWatchdog's doc comment).
    const watchdog = armSelfWatchdog(lock, {
      // WI-4528 (EI-10800 class): ASYNC + AWAITED. These two effects used to be fire-and-forget
      // `void import(...).then(emit)` — a GUARANTEED lost wake, not merely a race: armSelfWatchdog
      // SIGKILLs this process's own group on the very next synchronous line, so the dynamic
      // import()s (which cannot even begin resolving until the sync stack unwinds) never got a
      // single event-loop turn. Every agent parked on the red verdict via checkpoint:await missed
      // it and hung to its own timeout — in the ONE situation (lost parent, abnormal exit) where
      // that wake matters most. armSelfWatchdog now BOUND-awaits this hook before the kill.
      onFire: async () => {
        const red: CheckpointResult = {
          advanced: false,
          candidate: candidateArg ?? cfg.integrationBranch,
          from: null,
          green: false,
          reason: 'not-green',
          summary:
            `self-watchdog fired after ${Math.round(SELF_WATCHDOG_MS / 60_000)}m with no normal exit — ` +
            `checkpoint run likely lost its supervising parent; run-lock released and process group is being terminated.`,
          runId,
        };
        emitResult(red);
        const pipeline = pipelineName(cfg.integrationRoot);
        // WI-4957: no failing-test signature exists for a watchdog timeout (the suite never
        // finished) — carry an explicit empty array rather than omitting the field, so a
        // consumer can tell "ran and found nothing failing" (impossible here) apart from
        // "never got far enough to know" by checking `reason` rather than a missing key.
        const payload = { sha: red.candidate, from: red.from, pipeline, summary: red.summary, failingTests: [] as string[], runId };
        // EI-12457: symmetric with the normal red path — cancel any still-pending
        // green await for this pipeline now that this candidate resolved red.
        const cancelSiblingKeysFor = ['release:green', `release:green:${pipeline}`];
        try {
          const { emitAwaitedEvent } = await import('@papercusp/operator-core/lib/events/await/engine');
          await emitAwaitedEvent({
            key: 'green-checkpoint:red',
            summary: 'green-checkpoint self-watchdog fired — red verdict emitted',
            payload,
            source: 'green-checkpoint',
            cancelSiblingKeysFor,
          });
          await emitAwaitedEvent({
            key: `green-checkpoint:red:${pipeline}`,
            summary: 'green-checkpoint self-watchdog fired — red verdict emitted',
            payload,
            source: 'green-checkpoint',
            cancelSiblingKeysFor,
          });
        } catch (e) {
          console.error(
            `[green-checkpoint] self-watchdog red-verdict emit FAILED (awaiters will fall back to their timeout): ${e instanceof Error ? e.message : e}`,
          );
        }
        try {
          const { notifyAttention } = await import('@papercusp/operator-core/lib/attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'Release pipeline RED — green-checkpoint self-watchdog fired',
            body: red.summary ?? 'self-watchdog fired with no summary',
            importance: 'urgent',
            data: { candidate: red.candidate, reason: red.reason },
          });
        } catch {
          /* best-effort — the kill proceeds regardless */
        }
      },
    });
    const releaseAndExit = (code: number): never => {
      watchdog.cancel();
      lock.release();
      process.exit(code);
    };
    // EI-10680: this process previously had NO signal handler for SIGTERM/SIGINT, so an
    // external "stop this run" (systemctl --user stop, e.g. from release-checkpoint-launch's
    // replaceStale path) relied entirely on the OS's default terminate-on-signal behaviour to
    // kill it. That default is silently BYPASSED the moment ANY listener is registered for the
    // same signal anywhere in this process (Node then expects user code to call process.exit()
    // itself) — and this run programmatically drives vitest's runner, whose own worker-pool
    // cleanup path can install exactly such a listener. When that happens the process survives
    // past the stop request without ever reaching `releaseAndExit`, so its run-lock is never
    // released — a caller's replaceStale (stop the stale run, then relaunch) then relaunches
    // straight into "skipped-locked" against the very run it believed it had just stopped
    // (confirmed live 2026-07-13: the SAME pid reported "already running" on two consecutive
    // replaceStale attempts). Registering our OWN handler makes the release deterministic:
    // whatever else may or may not be listening, THIS run always drops its lock and exits the
    // moment it is asked to stop.
    const handleTermSignal = createTerminationSignalHandler(releaseAndExit);
    process.once('SIGTERM', handleTermSignal);
    process.once('SIGINT', handleTermSignal);
    runGreenCheckpoint(cfg, realCheckpointDeps(cfg, undefined, runId), {
      candidate: candidateArg,
      noPush: process.argv.includes('--no-push'),
    })
      .then(async (r) => {
        // WI-4494: record BEFORE emitResult/exit — `releaseAndExit` calls process.exit(), which
        // would kill an un-awaited write. The marker then carries `recorded` so the routine knows
        // not to record this same verdict a second time (double-counting the red streak).
        const recorded = await recordOwnVerdict(r);
        emitResult(recorded ? { ...r, recorded: true } : r);
        releaseAndExit(0);
      })
      .catch((e) => {
        watchdog.cancel();
        lock.release();
        console.error('[green-checkpoint] FAILED:', e instanceof Error ? e.message : e);
        process.exit(1);
      });
  }
}
