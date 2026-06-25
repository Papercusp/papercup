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

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
  revParse,
  refExists,
  isAncestor,
  advanceReady,
  type AdvanceResult,
} from './git-ops';
import type { ReleaseConfig } from './release-config';
import { runPerfGate, perfGatePolicyFromEnv } from './perf-gate';
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
  ): Promise<{ green: boolean; summary: string; failingTests?: string[]; flakeSuspects?: string[] }>;
  /** Fast-forward `ready` to `candidate` (advanceReady). */
  advance(candidate: string): Promise<AdvanceResult>;
  /** Publish `ready` to origin. */
  push(ref: string): Promise<void>;
  broadcast(summary: string, body?: string): Promise<void>;
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
  /** P-016 (agent-tool-delta-protocol D-008): the delta-protocol SAFETY gate.
   *  Runs post-runGreen / pre-advance on a GREEN candidate: if the production
   *  semantic-delta flag is ON but the Lane-C scenarios (S23/S24/S25) are not
   *  recorded-green-and-fresh, WARN (default) or BLOCK (owner-armed). Optional +
   *  flag-gated (a no-op `pass` unless PAPERCUSP_DELTA_GATE=1) so existing stubs
   *  need not provide it and the default deploy behaviour is unchanged. */
  deltaGate?(candidate: string): Promise<{ action: 'pass' | 'warn' | 'block'; summary: string }>;
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
  log(s: string): void;
}

export interface CheckpointResult {
  advanced: boolean;
  candidate: string;
  from: string | null;
  green: boolean | null;
  reason: 'up-to-date' | 'not-fast-forward' | 'not-green' | 'advanced' | 'advanced-prefix' | 'create-failed' | 'perf-held' | 'delta-held';
  /** P-016 (D-010): on a PARTIAL advance (reason 'advanced-prefix'), the sha `main`
   *  was FF'd to — the longest GREEN prefix — while `candidate` stays the red TIP (so
   *  failingTests + the release-fixer still target the real failure). Absent otherwise. */
  advancedTo?: string;
  summary?: string;
  /** P-012: a stable signature of what failed (test files / workspaces) on the
   *  not-green path, so the release-fixer dispatch dedups by FAILURE, not candidate sha. */
  failingTests?: string[];
  /** load-flake-isolation-2026-06-23: files the gate ABSORBED as load-flakes — they
   *  failed under the 8-fork checkpoint load but PASSED in an isolated re-run, so the
   *  gate is GREEN despite the initial red. Surfaced so the P-009 ledger can tally a
   *  chronically-flaky file and the owner can quarantine it accountably. */
  flakeSuspects?: string[];
}

export interface CheckpointRunLock {
  acquired: boolean;
  lockDir: string;
  owner?: { pid?: number; startedAt?: string; detail?: string };
  release(): void;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireCheckpointRunLock(
  lockDir: string,
  opts: { pid?: number; isPidAlive?: (pid: number) => boolean } = {},
): CheckpointRunLock {
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultPidAlive;
  const token = randomUUID();
  mkdirSync(path.dirname(lockDir), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid, startedAt: new Date().toISOString(), token }));
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
      if (typeof owner.pid === 'number' && isPidAlive(owner.pid)) {
        return { acquired: false, lockDir, owner, release: () => {} };
      }
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  return { acquired: false, lockDir, owner: { detail: 'could not acquire after stale lock cleanup' }, release: () => {} };
}

/** The marker the green-checkpoint CLI prints its CheckpointResult JSON behind, so the
 *  release-actions routine parses one delimited line instead of brace-slicing the whole
 *  stdout (P-008). MUST stay in sync with the literal in release-actions.ts. */
export const GREEN_CHECKPOINT_RESULT_MARKER = '__GREEN_CHECKPOINT_RESULT__';

/** Extract a stable failure signature from the FULL suite output (NOT the 2000-char
 *  tail, which can truncate the markers): vitest `FAIL <file>` lines + the affected
 *  runner's `>>> <ws> FAILED` workspace markers. Used for the release-fixer dedup. */
export function extractFailingTests(out: string): string[] {
  const set = new Set<string>();
  for (const m of out.matchAll(/^\s*FAIL\s+(\S+)/gm)) set.add(m[1]);
  for (const m of out.matchAll(/>>>\s+(\S+)\s+FAILED\b/g)) set.add(m[1]);
  return [...set].sort().slice(0, 50);
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

  const out: FailingFile[] = [];
  const seen = new Set<string>();
  let currentWs: string | null = null;
  for (const line of fullOutput.split('\n')) {
    const h = HEADER.exec(line);
    if (h) {
      currentWs = h[1];
      continue;
    }
    const m = SUMMARY_FAIL.exec(line) ?? SUITE_FAIL.exec(line);
    if (m) {
      const file = m[1];
      // A file before any `>>>` header (or a non-affected-runner invocation) has no
      // known workspace; skip it — we can't run `vitest run <file>` without a cwd.
      if (!currentWs) continue;
      const key = `${currentWs} ${file}`;
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
}

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
 * The whole attempt is itself wrapped so that ANY unexpected throw defaults to the
 * ORIGINAL (red) verdict — uncertainty NEVER manufactures a false green.
 */
export async function attemptFlakeAbsorption(
  fullOutput: string,
  isolationRun: (input: { workspace: string; file: string }) => Promise<IsolationResult>,
  log: (s: string) => void = () => {},
): Promise<FlakeAbsorptionOutcome> {
  const keep = (note: string): FlakeAbsorptionOutcome => ({ absorbedToGreen: false, flakeSuspects: [], note });
  try {
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
    const isolationResults: IsolationResult[] = [];
    for (const f of originalFailing) {
      try {
        isolationResults.push(await isolationRun(f));
      } catch (e) {
        // An isolation re-run that ITSELF errored cannot prove the file is a flake →
        // record errored:true so decideFlakeAbsorption counts it as still-failing.
        log(`isolation: re-run of ${f.workspace}::${f.file} errored (${e instanceof Error ? e.message : e}) — treated as still-failing`);
        isolationResults.push({ workspace: f.workspace, file: f.file, passed: false, errored: true });
      }
    }
    const decision = decideFlakeAbsorption({ originalFailing, isolationResults });
    if (decision.verdict === 'all-flakes') {
      const note = `isolation: ALL ${decision.flakeAbsorbed.length} originally-failing file(s) PASSED in isolation — absorbed as load-flake(s): ${decision.flakeAbsorbed.join(', ')}`;
      log(note);
      return { absorbedToGreen: true, flakeSuspects: decision.flakeAbsorbed, note };
    }
    return keep(
      `isolation: ${decision.stillFailing.length} file(s) STILL FAILED in isolation — real break, gate stays red: ${decision.stillFailing.join(', ')}`,
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
 * 4 keeps the worst-case fork footprint at ~16 GiB — well within the box's free memory even
 * with the live fleet running — at a modest wall-clock cost (the gate is hourly, not
 * latency-critical). The gate already raised VITEST_UNIT_TIMEOUT_MS to 180s, so fewer
 * parallel forks won't time-out the heavy `await import()` files. Configurable via
 * VITEST_MAX_FORKS/THREADS (a pre-set value always wins).
 */
export const GREEN_CHECKPOINT_MAX_FORKS = 4;

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

/** De-noise the suite (+ build) output for the held-gate broadcast/escalation: drop npm's
 *  error boilerplate (~10 lines/failed-workspace that repeatedly pushed the real `FAIL`
 *  test names out of the tail — cost two diagnosis round-trips 2026-06-06) and keep the
 *  last 2000 chars (FAIL lines, timeouts, assertion output, the SPA-build failure tail). */
export function summarizeSuiteOutput(fullOutput: string): string {
  return fullOutput
    .split('\n')
    .filter((l) => !/^npm error/.test(l))
    .join('\n')
    .slice(-2000);
}

export interface CheckpointOpts {
  /** Override the candidate (default: integration-branch HEAD). */
  candidate?: string;
  /** Don't push `ready` to origin (local-only). */
  noPush?: boolean;
}

/**
 * P-016 (release-pipeline-resilience-2026-06-09 D-010): is the longest-green-PREFIX
 * FF gate armed? DEFAULT-OFF — when off, a red candidate holds `main` exactly as it
 * does today (whole-batch all-or-nothing). Env-armed opt-in, mirroring the perf/delta
 * gates, because partial FF is the deepest change to the single most fleet-critical
 * gate and D-010 calls for an OWNER-ATTENDED live cutover ("build attended not blind").
 */
export function partialGreenGateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_PARTIAL_GREEN_GATE === '1';
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
  void import('@papercusp/operator-core/lib/events/await/engine')
    .then(({ emitAwaitedEvent }) =>
      emitAwaitedEvent({
        key: 'release:green',
        summary: `${cfg.releaseRef} advanced to ${prefixTip!.slice(0, 8)} (longest green prefix; tip ${candidate.slice(0, 8)} held red)`,
        payload: { sha: prefixTip, from: adv.from, partial: true, redTip: candidate },
        source: 'green-checkpoint',
      }),
    )
    .catch(() => {});
  return {
    advanced: true,
    candidate, // the RED tip — keeps failingTests + the release-fixer targeting the real failure
    advancedTo: prefixTip,
    from: adv.from,
    green: false, // the candidate (tip) is NOT green; `main` advanced to a green PREFIX
    reason: 'advanced-prefix',
    summary: confirm.summary,
    failingTests,
  };
}

export async function runGreenCheckpoint(
  cfg: ReleaseConfig,
  deps: CheckpointDeps,
  opts: CheckpointOpts = {},
): Promise<CheckpointResult> {
  const candidate = opts.candidate
    ? await revParse(cfg.integrationRoot, opts.candidate)
    : await revParse(cfg.integrationRoot, cfg.integrationBranch);
  const lastReady = (await refExists(cfg.integrationRoot, cfg.releaseRef))
    ? await revParse(cfg.integrationRoot, cfg.releaseRef)
    : null;

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
  const { green, summary, failingTests, flakeSuspects } = await deps.runGreen(cfg.checkpointRoot, lastReady);
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
    await deps
      .broadcast(
        `🟥 green-checkpoint: ${candidate.slice(0, 8)} not green — \`${cfg.releaseRef}\` held at ${lastReady?.slice(0, 8) ?? 'unset'}`,
        summary,
      )
      .catch(() => {});
    // release-pipeline-resilience-2026-06-09 P-005: emit a reaction event on the
    // RED path, symmetric with the `release:green` emit below. A `release-fixer`
    // launch-blueprint (P-006) reacts to this to auto-diagnose the failing test;
    // it also unblocks any agent that `events:await`s the gate verdict. The
    // `summary` is the de-noised failing-test tail already captured above.
    void import('@papercusp/operator-core/lib/events/await/engine')
      .then(({ emitAwaitedEvent }) =>
        emitAwaitedEvent({
          key: 'green-checkpoint:red',
          summary: `green-checkpoint: ${candidate.slice(0, 8)} not green — ${cfg.releaseRef} held`,
          payload: { sha: candidate, from: lastReady ?? null, summary },
          source: 'green-checkpoint',
        }),
      )
      .catch(() => {});
    // P-002: durable human-facing escalation (transition-only, cleared on green).
    await deps.escalate?.(
      `green-checkpoint held: ${candidate.slice(0, 8)} not green`,
      `\`${cfg.releaseRef}\` stays at ${lastReady?.slice(0, 8) ?? 'unset'}.\n\nFailing tail:\n${summary}`,
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
    // P-016 (D-010): longest-green-PREFIX FF. With the gate ARMED, a red TIP no longer
    // holds the clean PREFIX behind it hostage — `main` FFs to the longest prefix that
    // ITSELF runs green (confirm-gated, so the "always tested-green" invariant holds).
    // Runs AFTER the red escalate/broadcast/emit above, so the red tip is still fully
    // surfaced + the release-fixer still dispatched on it. Default-OFF (env-armed); a
    // failure here just falls through to the normal hold. (release-pipeline-resilience P-016)
    if (lastReady && partialGreenGateEnabledFromEnv()) {
      const partial = await tryLongestGreenPrefix(cfg, deps, lastReady, candidate, failingTests, !!opts.noPush).catch(
        (e) => {
          deps.log(`partial-green-gate: errored, holding (${e instanceof Error ? e.message : e})`);
          return null;
        },
      );
      if (partial) return partial;
    }
    return { advanced: false, candidate, from: lastReady, green: false, reason: 'not-green', summary, failingTests };
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
  // await-event-primitive-2026-06-05 P-015: `release:green` is awaitable —
  // an agent blocked on "the next green ready" sleeps on it (events:await)
  // instead of polling the checkpoint. Fire-and-forget.
  void import('@papercusp/operator-core/lib/events/await/engine')
    .then(({ emitAwaitedEvent }) =>
      emitAwaitedEvent({
        key: 'release:green',
        summary: `${cfg.releaseRef} advanced to ${candidate.slice(0, 8)} (green, deployable)`,
        payload: { sha: candidate, from: adv.from },
        source: 'green-checkpoint',
      }),
    )
    .catch(() => {});
  return {
    advanced: adv.advanced,
    candidate,
    from: adv.from,
    green: true,
    reason: 'advanced',
    summary,
    ...(flakeSuspects?.length ? { flakeSuspects } : {}),
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

export function realCheckpointDeps(cfg: ReleaseConfig, exec: CheckpointExec = runCmd): CheckpointDeps {
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
    try {
      const r = await exec(
        'npm',
        ['run', 'test', '--workspace', workspace, '--', '--no-file-parallelism', file],
        { cwd: cfg.checkpointRoot, env, allowNonZero: true, timeoutMs: ISOLATION_RUN_TIMEOUT_MS },
      );
      return { workspace, file, passed: r.code === 0 };
    } catch (e) {
      log(`isolation: vitest re-run of ${workspace}::${file} threw (${e instanceof Error ? e.message : e})`);
      return { workspace, file, passed: false, errored: true };
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
    async setupTree(ref) {
      const script = path.join(cfg.integrationRoot, 'apps/operator/bin/release/setup-release-checkout.sh');
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
      const [cmd, ...args] = cfg.greenCmd.split(' ');
      // The gate measures the COMMITTED DEFAULTS: buildGreenCheckpointEnv strips the
      // host's identity (all PAPERCUSP_* + HOST_ENV_STRIP), pins AFFECTED_BASE to the
      // last green, caps vitest parallelism + retries once to absorb load-flakes, and
      // marks GREEN_CHECKPOINT=1 (its doc records the incidents behind each rule).
      const env = buildGreenCheckpointEnv(base);
      const r = await exec(cmd, args, { cwd: treeDir, env, allowNonZero: true });

      // P-005: the SPA build is PART of "green". A build break (a bad import, a type
      // error in a bundled module) passes the Vitest suite, then fails at the deploy's
      // swap step (`--build-spa`) and rolls back — needlessly draining + restarting the
      // live :3070 (2026-06-09 13:31–14:00: three rolled-back deploys of the same broken
      // green). Build it here, in the isolated checkpoint tree, so a broken build holds
      // `main` like any other red — before it ever reaches a deploy. Only run it once the
      // suite is green (a red suite already holds `main`; no point building).
      let buildOut = '';
      let buildOk = true;
      if (r.code === 0) {
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
          const b = await exec('npm', ['--workspace', '@papercusp/operator-vite', 'run', 'build'], {
            cwd: treeDir,
            env,
            allowNonZero: true,
          });
          buildOk = b.code === 0;
          if (!buildOk) {
            buildOut = '\n\n=== SPA BUILD FAILED (@papercusp/operator-vite) — would fail the deploy swap ===\n' + b.stdout + b.stderr;
          }
        }
      }
      let green = r.code === 0 && buildOk;
      const fullOutput = r.stdout + r.stderr + buildOut;

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
      if (r.code !== 0 && buildOk) {
        const outcome = await attemptFlakeAbsorption(fullOutput, isolationRun, log);
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
      try {
        const logDir = cfg.checkpointLogDir;
        mkdirSync(logDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logPath = path.join(logDir, `${stamp}-base-${(base ?? 'none').slice(0, 12)}.log`);
        writeFileSync(logPath, fullOutput);
        log(`full suite output → ${logPath}`);
        // P-014: prune logs older than 14 days so this dir doesn't grow unbounded.
        pruneOldLogs(logDir, 14);
      } catch { /* best-effort — the gate verdict must not depend on logging */ }

      // P-012: a stable failure signature from the FULL output (before truncation), folding
      // the SPA build break in, so the release-fixer dedups by WHAT failed, not the candidate
      // sha. The de-noised 2000-char tail rides the held-gate broadcast/escalation.
      const failingTests = checkpointFailureSignature(fullOutput, green, buildOk);
      const summary = summarizeSuiteOutput(fullOutput);
      return { green, summary, failingTests, ...(flakeSuspects?.length ? { flakeSuspects } : {}) };
    },
    advance: (candidate) => advanceReady(cfg.integrationRoot, candidate, cfg.releaseRef),
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
    },
    async broadcast(summary, body) {
      const { sendMessage } = await import('@papercusp/operator-core/lib/agent-tools/coordination/messages');
      await sendMessage(
        { ownerId: 'green-checkpoint', ownerLabel: 'green-checkpoint', source: 'static-client', workspaceId: null, userId: null },
        { to: ['*'], summary, body, category: 'service-health' },
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
    // F2 (round-4 P-031): the real perf gate reads the latest perf-signals-v1 capture
    // and evaluates it against the per-thread budgets; policy comes from the env flags
    // (PAPERCUSP_PERF_GATE / PAPERCUSP_PERF_GATE_BLOCK). Inert (`pass`, reads nothing)
    // until the owner enables it.
    perfGate: (candidate) => runPerfGate(perfGatePolicyFromEnv(), candidate),
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

  const candidateArg = arg('--candidate');
  const lock = acquireCheckpointRunLock(path.join(cfg.checkpointLogDir, '.green-checkpoint-run.lock'));
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
          reason: 'up-to-date',
          summary: `green-checkpoint skipped: another checkpoint process is already running${lock.owner?.pid ? ` (pid ${lock.owner.pid})` : ''}`,
        });
        process.exit(0);
      })
      .catch((e) => {
        console.error('[green-checkpoint] FAILED:', e instanceof Error ? e.message : e);
        process.exit(1);
      });
  } else {
    const releaseAndExit = (code: number): never => {
      lock.release();
      process.exit(code);
    };
    runGreenCheckpoint(cfg, realCheckpointDeps(cfg), {
      candidate: candidateArg,
      noPush: process.argv.includes('--no-push'),
    })
      .then((r) => {
        emitResult(r);
        releaseAndExit(0);
      })
      .catch((e) => {
        lock.release();
        console.error('[green-checkpoint] FAILED:', e instanceof Error ? e.message : e);
        process.exit(1);
      });
  }
}
