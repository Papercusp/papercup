/**
 * Release-gating system actions — plan release-gate-ready-branch-2026-06-04
 * (Phase 1 green-checkpoint); staging→main auto-serve model since
 * staging-branch-pipeline-2026-06-06.
 *
 * Two routines, registered here so the routines engine can fire them:
 *   - `system:green-checkpoint` — fast-forwards the green pin (the **`main`
 *     branch**) to the newest GREEN `staging` commit. Runs the suite in an
 *     ISOLATED checkout.
 *   - `system:release-trigger` — when green `main` is ahead of the running
 *     release checkout, runs the SCRIPTED deploy (`deploy-cli --execute`)
 *     directly: the green gate IS the go/no-go now (auto-serve), and the deploy
 *     mechanics carry their own drain + health-check + auto-rollback. The
 *     release-manager agent remains for interactive/incident use only.
 *
 * Both are seeded ACTIVE (seed-release-routines.ts) — auto-serve posture.
 *
 * Layering: these handlers SHELL OUT to the standalone scripts in
 * apps/operator/lib/release/* (operator-core must not import the apps/operator
 * tier). The scripts are designed to run standalone via tsx for exactly this.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { appendPipelineEvent } from '../git-sync/pipeline-events';
import {
  gateVerdictEnv,
  isRecordableVerdict,
  type GateVerdictTarget,
} from '../../release/gate-verdict-target';
import { releaseCheckpointConfig } from '../../release-checkpoint-config';
import { describeGateRedOwnership, gateFailureSignature, type GateRedOwnership } from '../../release/gate-red-ownership';
import { RELEASE_FIXER_NO_TURN_PHASE, releaseFixerSpawnAlive } from '../../release/fixer-liveness';
// WI-37605: narrate under the RESOLVED tag, never a hardcoded '[green-checkpoint]'. This module's
// own suite (release-actions*.test.ts) drives these code paths, and vitest captures their stdout
// verbatim into the gate's persisted verdict log — so a hardcoded prefix emits a line
// byte-identical to a real gate decision. Measured: the `skipped-locked` line from
// gateStallNoopLogMessage() below appeared at line 6693 of the 33cd2bfebec8 verdict log reading
// exactly like the gate explaining why it stood down. It was a test fixture.
//
// WI-7274 fixed this class for green-checkpoint.ts's own narration by tagging at the emit funnel;
// this module never got that treatment because the tag was believed to live in apps/operator. It
// does not — it lives in operator-core (checkpoint-log-tags.ts, moved down by
// EI-19395755190419540), i.e. in THIS package, so the funnel is a plain relative import.
import { orchestratorStdoutTag } from '../../release/checkpoint-log-tags';
import { greenCheckpointDbPoolEnv } from '../../release/checkpoint-db-pool';
import { buildIsolatedScopeArgv, SCOPE_LAUNCH_FAILURE_RE } from '../../systemd-scope';
import type { FlakeSuspect } from '../../dev-data';
import {
  buildDeployTerminalShell,
  RELEASE_DEPLOY_UNIT,
} from '../../release-deploy-terminal';

// Kept as exports from this historical module for callers/tests that already
// use the release-actions config surface. The implementation is shared with
// the detached manual launcher in release/checkpoint-db-pool.ts.
export { DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX, resolveGreenCheckpointDbPoolMax } from '../../release/checkpoint-db-pool';

// Re-exported for backward compatibility — release-actions.test.ts imports
// buildIsolatedScopeArgv from THIS module. The pure builder itself now lives in
// ../../systemd-scope so the orchestrator-runner.ts agent-spawn seam (WI-1499) can
// reuse it without pulling in this file's module-level registerSystemAction side effect.
export { buildIsolatedScopeArgv };

/** Markers the release CLIs print their result JSON behind (P-008) — parse ONE delimited
 *  line instead of brace-slicing all of stdout (fragile to any log line with braces). MUST
 *  match the literals in green-checkpoint.ts / deploy-cli.ts (operator-core cannot import
 *  the apps/operator tier, so the contract is duplicated by value). */
const GREEN_CHECKPOINT_RESULT_MARKER = '__GREEN_CHECKPOINT_RESULT__';
const DEPLOY_PLAN_MARKER = '__DEPLOY_PLAN__';

/** Parse the JSON on the line carrying `marker`, or null if absent/unparseable. */
function parseMarkerLine(stdout: string, marker: string): Record<string, unknown> | null {
  const line = stdout.split('\n').find((l) => l.includes(marker));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Checkouts that must NEVER serve as the integration tree.
 *
 *  `papercup-release` / `papercusp-release` are the DEPLOY ARTIFACT (pinned to green
 *  `main`); `*-checkpoint` are the gate's own isolated test trees. Gating any of them
 *  judges code that is NOT what agents commit to — and does so SILENTLY, which is the
 *  whole defect: a wrong-tree run reports a perfectly well-formed verdict about the
 *  wrong commits. Two agents independently concluded the gate was executing the
 *  release copy while debugging a 22h freeze (EI-20263854732193595). */
const NON_INTEGRATION_CHECKOUTS = new Set([
  'papercup-release',
  'papercusp-release',
  'papercup-checkpoint',
  'papercusp-checkpoint',
]);

/** The integration tree (where green-checkpoint/deploy operate). Explicit env so
 *  it stays correct even after the operator itself runs from the release checkout.
 *
 *  FAIL-CLOSED (EI-20263854732193595): when `PAPERCUSP_INTEGRATION_ROOT` is unset the
 *  cwd-relative fallback is CORRECT for a normal operator (…/papercusp/apps/operator →
 *  …/papercusp) and CATASTROPHIC for one running out of the release checkout
 *  (…/papercup-release/apps/operator → …/papercup-release). The old code could not tell
 *  those apart and returned both without complaint. The guard is deliberately NARROW —
 *  it refuses ONLY the known-bad checkouts, so every working path keeps working and
 *  only the silent-wrong-tree case becomes a loud error. */
export function resolveIntegrationRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.PAPERCUSP_INTEGRATION_ROOT;
  if (explicit) return explicit;

  const derived = path.resolve(cwd, '..', '..');
  const base = path.basename(derived);
  if (NON_INTEGRATION_CHECKOUTS.has(base)) {
    throw new Error(
      `integrationRoot: refusing to gate ${derived} — "${base}" is a release/checkpoint checkout, ` +
        `not the integration tree. Gating it would judge code nobody commits to and report a ` +
        `well-formed verdict about the wrong commits. Set PAPERCUSP_INTEGRATION_ROOT to the ` +
        `staging checkout explicitly. (EI-20263854732193595)`,
    );
  }
  return derived;
}

function integrationRoot(): string {
  return resolveIntegrationRoot();
}

/** The integration tree for a READ-ONLY DIAGNOSTIC, or `null` when it cannot be resolved.
 *
 *  `resolveIntegrationRoot` is deliberately FAIL-CLOSED: it THROWS on a release/checkpoint
 *  checkout so a gate/deploy run can never silently act on the wrong tree. That is right for
 *  the gating and deploy paths — and wrong for the two best-effort diagnostics below, both of
 *  which are documented to degrade (nulls / fail-open) rather than fail a routine tick.
 *
 *  Those sites passed `integrationRoot()` as a call ARGUMENT, which puts a SYNCHRONOUS throw
 *  OUTSIDE the `.catch()` that implements their fail-safe — the promise never exists, so the
 *  handler never runs. Once the guard landed, that turned the gate's OWN unit runs red: vitest
 *  executes operator-core with cwd `<tree>/packages/operator-core`, so the `../..` fallback
 *  resolves to `…/papercusp-checkpoint` inside the checkpoint tree and the resolver refuses.
 *  Diagnostics ask for the root through here; the gating/deploy paths keep the throw. */
function integrationRootForDiagnostic(): string | null {
  try {
    return integrationRoot();
  } catch {
    return null;
  }
}

/** One line of run-scoped evidence: WHICH tree this gate run is judging, and HOW that was
 *  decided. The guard above stops the catastrophic case (a release/checkpoint checkout);
 *  this makes the merely-SURPRISING case legible — an explicit `PAPERCUSP_INTEGRATION_ROOT`
 *  pointing somewhere unexpected still produces a perfectly well-formed verdict about the
 *  wrong commits, and no guard can tell that apart from a correct one.
 *
 *  Why a line in the log at all (EI-20263854732193595): during the 22h freeze TWO agents
 *  independently concluded the gate was executing the release copy, and neither could
 *  cheaply confirm or refute it, because the checkpoint log never stated the root. The
 *  absence of that one line is what turned a five-minute check into hours of archaeology. */
export function integrationRootEvidence(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const root = resolveIntegrationRoot(env, cwd);
  const source = env.PAPERCUSP_INTEGRATION_ROOT ? 'PAPERCUSP_INTEGRATION_ROOT' : 'cwd-fallback';
  return `integration root: ${root} (source=${source}, emitter=routine-dispatcher)`;
}

function tsxBin(root: string): string {
  return path.join(root, 'node_modules/.bin/tsx');
}

export interface ReleaseToolingStatus {
  ok: boolean;
  reason?: 'missing_tsx' | 'missing_script';
  root: string;
  tsx: string;
  script: string;
}

export function releaseToolingStatus(
  root: string,
  relScript: string,
  exists: (p: string) => boolean = existsSync,
): ReleaseToolingStatus {
  const tsx = tsxBin(root);
  const script = path.join(root, relScript);
  if (!exists(tsx)) return { ok: false, reason: 'missing_tsx', root, tsx, script };
  if (!exists(script)) return { ok: false, reason: 'missing_script', root, tsx, script };
  return { ok: true, root, tsx, script };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** WI-39841 (Defect 2): THIS runner's own deadline timer fired and SIGTERM'd the group.
   *  Without it, a deadline-kill is indistinguishable from a script crash — both arrive as a
   *  non-zero exit with no parseable result marker, and both were recorded as a red. They call
   *  for opposite operator actions, so the fact is captured at the only place that knows it
   *  first-hand (the timer callback) rather than inferred downstream from empty fields. */
  timedOut?: boolean;
}

/** Per-fork vitest heap budget (GiB) — one fork's `--max-old-space-size` worth. */
const CHECKPOINT_FORK_HEAP_G = 4;

/** Fixed scope overhead (GiB): tsx/npm plus the testcontainers helpers, and headroom. */
const CHECKPOINT_SCOPE_OVERHEAD_G = 8;

/** Vitest fork count per capacity mode. MUST track `GREEN_CHECKPOINT_MAX_FORKS` /
 *  `GREEN_CHECKPOINT_RESERVED_MAX_FORKS` in apps/operator/lib/release/green-checkpoint.ts.
 *  Duplicated rather than imported because operator-core is the LOWER layer and must not
 *  import from apps/operator; `release-actions-memory-cap.test.ts` pins these to the real
 *  constants so the two cannot silently desynchronize again. */
export const CHECKPOINT_FORKS_BY_MODE = { shared: 2, reserved: 8 } as const;

/** Memory cap (GiB) for the ISOLATED green-checkpoint scope (see `runScript` isolate).
 *
 *  DERIVED from the fork count, never a fixed number. The cap exists to keep the suite's
 *  OOM inside its OWN cgroup, away from the bg-host cage — NOT to squeeze the suite.
 *
 *  It used to be a hard 16, sized for 2 forks. When the gate moved to `reserved` (8 forks)
 *  on 2026-08-17 the cap did not follow, so 4× the workers ran in a cgroup sized for the old
 *  count: the scope hit `memory.max` 310 times in the first ~2 minutes of a run while
 *  `oom_kill` stayed 0 — which is exactly why it read as healthy. Forced reclaim at the
 *  ceiling surfaces as vitest worker teardown ("environment was torn down" cascades) and
 *  stall-timer `console.error` reds on tests that PASS in isolation, i.e. indistinguishable
 *  from real breakage unless you read `memory.events`. That produced a different random red
 *  set every run and a 15-deep red streak that never converged. WI-39472. */
export function checkpointScopeMemoryMaxG(env: NodeJS.ProcessEnv = process.env): number {
  const mode =
    env.PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE === 'reserved' ? 'reserved' : 'shared';
  return CHECKPOINT_SCOPE_OVERHEAD_G + CHECKPOINT_FORKS_BY_MODE[mode] * CHECKPOINT_FORK_HEAP_G;
}

function runScript(
  root: string,
  relScript: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
  isolate?: { memoryMaxG: number },
  /** Env keys DELETED from the inherited env before `extraEnv` is applied. `extraEnv` cannot
   *  express a deletion, and for a SUBJECT-hive gate run the value that must go is one this
   *  process INHERITED (EI-20709645463022690). Explicit string[] rather than
   *  Record<string,string|undefined> — the latter would lean on Node silently dropping
   *  undefined env values, which is true but unstated. */
  clearEnv: string[] = [],
): Promise<RunResult> {
  const base = [tsxBin(root), path.join(root, relScript), ...args];
  // Isolation kill-switch: PAPERCUSP_CHECKPOINT_SCOPE=0 forces the pre-2026-07-01
  // direct spawn (ops escape hatch, peer of PAPERCUSP_GATEWAY_RPM_SMOOTH).
  const wantScope = !!isolate && process.env.PAPERCUSP_CHECKPOINT_SCOPE !== '0';
  const attempt = (argv: string[], fallback: (() => Promise<RunResult>) | null): Promise<RunResult> =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      // P-007: detached → the child is its own process-GROUP leader, so on the timeout we
      // can SIGTERM the WHOLE group (tsx → npm → vitest workers), not just the tsx parent.
      // Killing only the parent orphaned the test workers, which kept loading the shared
      // box past the cap and manufactured the very load-flakes the gate then has to absorb.
      // (Under the scope wrapper the group leader is systemd-run; the payload inherits
      // its pgid, so the group kill covers the same tree.)
      // Deletions apply to the INHERITED env only, BEFORE the overlay — so an `extraEnv`
      // entry naming a cleared key still wins (that is how the gate hands the subject run
      // papercusp's own DSN under HARNESS_ADMIN_DATABASE_URL while clearing DATABASE_URL).
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of clearEnv) delete childEnv[key];
      const child = spawn(argv[0], argv.slice(1), {
        cwd: root,
        env: { ...childEnv, PAPERCUSP_INTEGRATION_ROOT: root, ...extraEnv },
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let sigkiller: NodeJS.Timeout | undefined;
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig); // negative pid → the whole group
        } catch {
          /* group already gone */
        }
      };
      // WI-39841 (Defect 2): remember that WE killed it. This is the only point in the system
      // that observes the deadline-kill directly; everywhere downstream sees only "non-zero
      // exit, no marker", which is the same shape a crash produces.
      let timedOut = false;
      const killer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        // Escalate if a wedged worker ignores SIGTERM, so the group can't linger.
        sigkiller = setTimeout(() => killGroup('SIGKILL'), 15_000);
      }, timeoutMs);
      const finish = (r: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        if (sigkiller) clearTimeout(sigkiller);
        resolve(timedOut ? { ...r, timedOut: true } : r);
      };
      // Scope-launch failure (spawn error / fast systemd-run exit with a launch-shaped
      // stderr) → retry DIRECT once, so a box without a reachable user bus degrades to
      // the old same-cgroup behavior instead of red-pinning the gate.
      const finishOrFallback = (r: RunResult, launchFailed: boolean): void => {
        if (settled) return;
        if (fallback && launchFailed) {
          settled = true;
          clearTimeout(killer);
          if (sigkiller) clearTimeout(sigkiller);
          resolve(fallback());
          return;
        }
        finish(r);
      };
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (e) => finishOrFallback({ code: 1, stdout, stderr: stderr + String(e) }, true));
      child.on('close', (code) =>
        finishOrFallback(
          { code: code ?? 1, stdout, stderr },
          code !== 0 && Date.now() - startedAt < 5_000 && SCOPE_LAUNCH_FAILURE_RE.test(stderr),
        ),
      );
    });
  return wantScope
    ? attempt(buildIsolatedScopeArgv(base, isolate.memoryMaxG), () => attempt(base, null))
    : attempt(base, null);
}

/**
 * The wall-clock budget for ONE green-checkpoint suite run before runScript
 * SIGTERMs the whole process group (P-007). This MUST track the gate's fork
 * concurrency: GREEN_CHECKPOINT_MAX_FORKS (green-checkpoint.ts) was lowered
 * 8→4→2 for OOM safety on this memory-pressured shared box, which ~doubled the
 * suite's wall-clock — but this budget stayed at the original 25m, so every
 * 2-fork run OVERRAN it and was SIGTERM-killed (exit 143) BEFORE producing any
 * verdict, wedging the green gate (and thus every fleet deploy) for ~18h
 * (green-checkpoint-timeout-vs-forks-2026-06-27). 55m gave a 2-fork run headroom
 * under MODERATE load — but under sustained full-fleet load (46+ sessions) the
 * multi-pass suite measured 60–90m wall-clock, so 55m resumed killing HEALTHY
 * runs pre-verdict: 4 consecutive gate losses on 2026-07-05 froze `main` ~17h
 * (EI-7553 posts 50747/50749 — run verifiably alive at 59m, SIGTERM'd, verdict
 * row null forever). 120m covers the measured worst case with ~30m headroom.
 *
 * INVARIANT: keep this the SMALLEST link in the gate's timing chain —
 *   THIS (120m)  <  SELF_WATCHDOG_MS (180m, green-checkpoint.ts)
 *     <  DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (185m, dbos/dbos-executor-reaper.ts)
 *     <  CHECKPOINT_LOCK_STALE_MS (190m, green-checkpoint.ts)
 * — a run must be killed by THIS timeout (and release its lock) before that lock is
 * stale-reclaimable, else the next hourly fire spawns a SECOND concurrent suite and
 * OOMs the box; and the DBOS reaper's no-output window must sit above the whole run so
 * it cannot cancel a HEALTHY checkpoint's bookkeeping row mid-suite. That last link was
 * MISSING from this list when this budget was raised 55m→120m, so the reaper (still 60m)
 * silently became the tightest bound and reaped healthy runs — WI-6112. operator-core
 * cannot import from apps/operator, so the constants live in separate files; whoever
 * retunes one must retune the others (same convention as the result MARKERs above), and
 * apps/operator/lib/release/release-timing-invariants.test.ts asserts the ordering.
 *
 * Deeper root (see green-checkpoint.ts GREEN_CHECKPOINT_MAX_FORKS notes): the
 * box's memory BASELINE / the :3070 operator-cluster size. Freeing memory there
 * would let the gate run more forks → finish faster → afford a SHORTER budget.
 * This bump UNWEDGES the gate; it does not remove that deeper cost.
 *
 * SECOND INVARIANT — it must NOT be an integer multiple of the gate's fire period
 * (WI-39841). A scheduled run starts a second or two after its cron fire, so its
 * deadline lands a second or two after a LATER fire, and it is still holding the
 * exclusive run-lock at that moment: the fire that should have replaced it is refused,
 * and the gate sits idle until the following hour. At the old 120m against a 60m
 * period this was not a race that sometimes bit — it was deterministic for every run
 * that went the distance. Measured 2026-08-18: run started 17:15:04.877Z, cron fired
 * 19:15:01.941Z, run SIGTERMed 19:15:04 (journal `exited 143`), no run until 20:15.
 * One over-long run therefore cost ~2h of wall-clock, not 2h of work.
 *
 * Hence 115m, not 120m — the LARGEST value that still clears the boundary: a run that
 * starts at HH:15 now dies at HH+1:55 and the HH+2:15 fire finds the lock free, ~5 min
 * of slack. The 5 minutes given up are cheap — a run that needs >115m is a run that
 * was going to be killed mid-suite anyway and record a verdict-less red (the 17:15 run
 * produced NOTHING at its 120m mark) — while the slot recovered is a whole extra hour
 * of gate availability. `phase margin` in release-timing-invariants.test.ts pins it.
 */
export const GREEN_CHECKPOINT_SUITE_TIMEOUT_MS = 115 * 60_000;

/** The cron the gate is seeded with (seed-hive-release-routines.ts,
 *  seed-release-routines.ts, retrofit-hive-to-gate.ts all use this literal) and the
 *  fire period it implies. Exported so the phase invariant above is CHECKABLE rather
 *  than a comment — see release-timing-invariants.test.ts. */
export const GREEN_CHECKPOINT_CRON = "0 15 * * * *";
export const GREEN_CHECKPOINT_FIRE_PERIOD_MS = 60 * 60_000;

/** Minimum gap the suite timeout must leave between a deadline-kill and the next
 *  scheduled fire, so the lock is demonstrably free when that fire lands. */
export const GREEN_CHECKPOINT_PHASE_MARGIN_MS = 5 * 60_000;

/**
 * A green-checkpoint run's result, as the CLI reports it on its result-marker line.
 * (Structural mirror of green-checkpoint.ts's `CheckpointResult` — operator-core must not import
 * from apps/operator, so the shape is restated here, same convention as the result MARKERs above.)
 */
export interface CheckpointVerdict {
  reason: string;
  green?: boolean | null;
  candidate?: string;
  from?: string | null;
  summary?: string;
  failingTests?: string[];
  flakeSuspects?: string[];
  /** EI-18685042025868279: structural mirror of CheckpointResult.retriedTests — every
   *  test/workspace the gate had to RE-RUN to reach this verdict, with a measured attempt
   *  count. Kept as a loose row shape here (not an import) for the same reason every other
   *  field on this interface is: this is the DESERIALIZED verdict, parsed from the CLI's
   *  JSON marker, so it must not couple operator-core to apps/operator's types. */
  retriedTests?: Array<{ name: string; attempts: number; outcome: string; via: string }>;
  /** EI-18685042025868279: structural mirror of CheckpointResult.cleanGreen. true ⇒ green
   *  with nothing absorbed; false ⇒ green only after re-runs; ABSENT ⇒ unknown (an older
   *  CLI, or a red verdict, where the question has no referent). Never coerce absent to
   *  false — that would manufacture a "not clean" claim from no evidence. */
  cleanGreen?: boolean;
  advancedTo?: string;
  /** WI-4494: the CLI sets this when IT recorded the verdict (gate_health + pipeline event).
   *  The routine then MUST NOT record it again — a second `trackGateStall` for one verdict would
   *  double-increment the red streak. Absent/false ⇒ the caller records, exactly as pre-WI-4494. */
  recorded?: boolean;
  /** WI-4957: this run's own identity (structural mirror of CheckpointResult.runId) —
   *  distinguishes two runs that happen to judge the same candidate sha. */
  runId?: string;
  /** WI-4957: the full-suite output log this run wrote (structural mirror of
   *  CheckpointResult.logPath), when produced. */
  logPath?: string;
  /** EI-13288: structural mirror of green-checkpoint.ts's `RedTriage & { tip }` (stale-candidate
   *  re-triage, 2026-07-10). Present on the not-green path whenever the CLI could re-run the named
   *  failing files at a newer tip. When `classification === 'stale-candidate'` AND
   *  `autoRefire === false`, the CLI's OWN re-test already PROVED these exact files pass at `tip`
   *  and the refire was blocked, so this red's failing-test names must not be reported as a
   *  trustworthy, currently-reproducing verdict (see gate-verdict-freshness.ts Rule 3). An
   *  auto-refiring pass is an intermediate verdict that is about to be superseded; persisting its
   *  stale-cap fields would falsely tell readers that the cap was already reached. Never used to
   *  change the gate's green/red decision. */
  retriage?: {
    classification: 'real-red' | 'stale-candidate' | 'unknown';
    tip: string | null;
    detail: string;
    /** Structural mirror of RedTriage.autoRefire. Optional for old CLI payloads; absent is not
     *  proof that the cap was reached, so callers must fail closed before persisting stale fields. */
    autoRefire?: boolean;
    refireBlockedBy?: 'cap-disabled' | 'charged-budget' | 'absolute-ceiling' | 'deadline' | null;
  };
  /** isolation-retry-resilience-2026-07-19 (EI-15849): the load-flake / worker-crash
   *  absorption attempt's own human-readable verdict note, persisted REGARDLESS of
   *  whether it flipped the gate green — before this, a not-absorbed attempt's reasoning
   *  (which files still failed, whether isolation ran at all) existed only as a
   *  console.log inside the detached checkpoint child process, truncated to its last
   *  ~200-500 chars by the routine's own logging and never durably recorded. A held-gate
   *  incident was previously undiagnosable after the fact without grepping raw checkpoint
   *  logs (which don't even contain the isolation re-run's own output). Present whenever
   *  the isolation/worker-crash absorber actually ran. */
  isolationNote?: string;
  /** EI-18685041726970077 (owner-flagged highest-leverage fix from the nine-detector
   *  audit): structural mirror of green-checkpoint.ts's `GateLineage` — the judged
   *  candidate's lineage vs the integration branch's tip AT VERDICT TIME (commits
   *  behind + which failing files were touched in that range). Persisted into the
   *  append-only pipeline event detail so a red's staleness is readable from the
   *  DURABLE record (/admin/git, gate_health) without re-deriving it by hand — the
   *  exact archaeology the owner's report named as costing hours. Never used to
   *  change the gate's green/red decision. */
  lineage?: {
    candidate: string;
    tip: string;
    commitsBehind: number;
    failingFilesChangedInRange: string[];
    /** EI-20215068298600724: path-shaped failing files that did not match the
     *  candidate→tip range. Their fixes may have landed in the subjects they
     *  police, so a mixed match must remain visibly undetermined in durable gate
     *  history instead of reading as one all-stale/red verdict. */
    failingFilesUnchangedInRange?: string[];
    /** EI-19390159514676981: TOTAL files changed in the range. Without it the durable
     *  record cannot distinguish "the range was empty" (a real red) from "the range
     *  changed other files, just not the failing TEST files" — which is the expected
     *  shape of an ALREADY-FIXED red whenever the failing test polices OTHER files
     *  (budget/lint/census ratchets are fixed in the file they police, never in
     *  themselves). Absent ⇒ unmeasured, which must read as UNDETERMINED. */
    rangeFilesChanged?: number;
    /** EI-19393306381214544: how many failing entries were path-shaped. 0 ⇒ the empty
     *  intersection compared NOTHING (the failures were bare workspace names), so it
     *  is vacuous rather than evidence. */
    failingPathsConsidered?: number;
    /** EI-20063423357086565: failing files with UNCOMMITTED working-tree changes — the fix
     *  may already be written and merely un-swept by git-sync. Carried here for the same
     *  reason as the two discriminators above: every OTHER field in this record is derived
     *  from commits, so a durable record without this one re-states the exact false
     *  confidence ("candidate IS the tip ⇒ a real red") that the transient line was fixed
     *  for. Absent ⇒ no failing file was dirty; it is NOT a claim the tree was clean. */
    failingFilesDirtyUncommitted?: string[];
  };
  /** EI-18850448565330905: structural mirror of green-checkpoint.ts's `CheckpointResult.crashed`
   *  — this verdict was synthesized by the CLI's own crash handler because the normal run
   *  THREW instead of resolving a leg-reported red (e.g. a non-test member like a PG-backed
   *  plane lint). `summary` carries the thrown error; treat this as "the process crashed", not
   *  as a leg-scoped verdict — the specific failing leg is not always recoverable here. */
  crashed?: boolean;
}

/** The pipeline-event `detail` blob for a checkpoint verdict. Shared by BOTH recorders (the CLI's
 *  producer-side write and the routine's fallback) so a manual run's history row is identical to a
 *  routine run's — the /admin/git timeline must not be able to tell who launched the suite. */
export function buildCheckpointDetail(v: CheckpointVerdict): Record<string, unknown> {
  const detail: Record<string, unknown> = { green: v.green ?? null };
  if (v.candidate) detail.candidate = v.candidate.slice(0, 12);
  if (v.from) detail.from = v.from.slice(0, 12);
  // P-016: on a partial advance, record the prefix sha `main` was FF'd to (the red tip stays in
  // `candidate`) so /admin/git shows WHERE main landed vs the held tip.
  if (v.advancedTo) detail.advancedTo = v.advancedTo.slice(0, 12);
  // P-003 (git-sync-dx-hardening): persist the failing-test reason in the append-only event so WHY
  // the gate was red survives the per-tick metadata overwrite (capped).
  if (v.failingTests?.length) detail.failingTests = v.failingTests.slice(0, 20);
  // load-flake-isolation-2026-06-23: persist the files the gate ABSORBED as load-flakes.
  if (v.flakeSuspects?.length) detail.flakeSuspects = v.flakeSuspects.slice(0, 20);
  // EI-18685042025868279: persist the retry accounting, so "was this green clean?" is
  // answerable from the DURABLE record rather than only from a broadcast that scrolls away.
  // Without this the whole fix would stop at the log line — /admin/git, the flake ledger and
  // every gate-history reader would still see a retry-absorbed green as indistinguishable
  // from a clean one, which is the defect itself.
  if (v.retriedTests?.length) detail.retriedTests = v.retriedTests.slice(0, 20);
  // Recorded whenever the CLI stated it — INCLUDING `false`, which is the whole signal. A
  // truthiness check here would drop exactly the case worth persisting.
  if (typeof v.cleanGreen === 'boolean') detail.cleanGreen = v.cleanGreen;
  // WI-4957: persist the run identity + exact log reference so /admin/git history (and
  // gate-verdict-freshness's readers) can tell WHICH run produced this row and open its
  // full output directly, instead of only the de-noised failing-test names.
  if (v.runId) detail.runId = v.runId;
  if (v.logPath) detail.logPath = v.logPath;
  // isolation-retry-resilience-2026-07-19 (EI-15849): persist the absorption verdict note
  // even on a red (not absorbed) — see CheckpointVerdict.isolationNote for why this closes
  // a real diagnosability gap.
  if (v.isolationNote) detail.isolationNote = v.isolationNote.slice(0, 2000);
  // EI-18685041726970077: persist the lineage so a red's staleness is readable from the
  // durable pipeline-event record itself, not only from the transient broadcast/escalate text.
  if (v.lineage) {
    detail.lineage = {
      candidate: v.lineage.candidate.slice(0, 12),
      tip: v.lineage.tip.slice(0, 12),
      commitsBehind: v.lineage.commitsBehind,
      failingFilesChangedInRange: v.lineage.failingFilesChangedInRange.slice(0, 20),
      ...(v.lineage.failingFilesUnchangedInRange?.length
        ? { failingFilesUnchangedInRange: v.lineage.failingFilesUnchangedInRange.slice(0, 20) }
        : {}),
      // Carry the two discriminators too, or the durable record reproduces exactly the
      // false confidence the transient line was fixed for: an empty
      // failingFilesChangedInRange is only real-red evidence when the range itself was
      // empty AND there was something path-shaped to compare (EI-19390159514676981,
      // EI-19393306381214544). Copied conditionally so an unmeasured leg stays absent
      // rather than being written as a 0 that reads like a measurement.
      ...(v.lineage.rangeFilesChanged != null ? { rangeFilesChanged: v.lineage.rangeFilesChanged } : {}),
      ...(v.lineage.failingPathsConsidered != null
        ? { failingPathsConsidered: v.lineage.failingPathsConsidered }
        : {}),
      // EI-20063423357086565: the only leg here NOT derived from commits. Without it the
      // durable record shows "candidate IS the tip, 0 behind, nothing changed in range" —
      // three commit-based facts that are all TRUE and together read as a confirmed real
      // red, while the fix sat uncommitted on disk the whole time.
      ...(v.lineage.failingFilesDirtyUncommitted?.length
        ? { failingFilesDirtyUncommitted: v.lineage.failingFilesDirtyUncommitted.slice(0, 20) }
        : {}),
    };
  }
  // WI-7290: persist the RE-TRIAGE verdict — the gate's own DIRECT measurement of whether the
  // red still reproduces at tip ("we re-ran these exact files at tip; they passed / they still
  // fail / we could not measure").
  //
  // Until now the durable record carried `lineage` but NOT this, which is exactly backwards:
  // lineage is the weaker PROXY ("a failing file was MODIFIED somewhere in the range" — a
  // modification is not a fix), while the re-triage is the direct measurement, and the gate
  // computed it and threw it away. `gate_health` keeps only the `stale-candidate` case
  // (retriageStaleTip/retriageDetail, deliberately paired + cleared so a stale note cannot
  // outlive its verdict), so a `real-red`-at-tip finding — the single most decision-relevant
  // fact about a red — survived nowhere at all.
  //
  // Measured cost of that hole, all on the night of 2026-08-02: three filings against the gate
  // (WI-7290; EI-19388705187359206, filed MAJOR against the failing-file parser and retracted
  // only after its author hand-built a probe that disproved it; EI-19389700122825304, the same
  // author's note on misreading a field that could not answer the question), each independently
  // re-deriving from raw logs whether the tip re-run had happened. Recording-only: nothing reads
  // this to decide green/red — see the `unknown`-synthesis note in green-checkpoint.ts.
  if (v.retriage) {
    detail.retriage = {
      classification: v.retriage.classification,
      tip: v.retriage.tip ? v.retriage.tip.slice(0, 12) : null,
      detail: v.retriage.detail.slice(0, 500),
    };
  }
  // EI-20702428259478130: persist the ABNORMAL-EXIT discriminators. `summary` and `crashed` were
  // the only CheckpointVerdict fields this function never copied, and that made an INFRA DEATH and
  // a REAL TEST FAILURE identical in the durable record: both land as status='not-green' with
  // detail {green:false, runId, candidate} and nothing else to tell them apart.
  //
  // Measured cost, 2026-08-17 on oddsmith: four consecutive verdicts recorded not-green while the
  // suite passed 4460/4460. Nothing in the ledger could distinguish them from a genuine red — the
  // disproof required hand-reading the checkpoint log and diffing it against the last good run.
  // The thrown error exists at runtime, in `summary`, and was being discarded at exactly this
  // storage boundary. `crashed` is the structural mirror of CheckpointResult.crashed
  // (EI-18850448565330905) and is the field that makes the distinction MACHINE-readable rather
  // than leaving it to a human parsing prose.
  //
  // Copied conditionally, for the same reason the lineage discriminators above are: an absent leg
  // must stay ABSENT rather than be written as a falsey value that reads like a measurement — a
  // persisted `crashed: false` would assert a clean exit that nobody actually verified.
  if (v.summary) detail.summary = v.summary.slice(0, 2000);
  if (v.crashed === true) detail.crashed = true;
  return detail;
}

/**
 * WI-4494 — RECORD A VERDICT, from whoever produced it.
 *
 * The single act of "this run said something about the gate": the append-only pipeline event (the
 * /admin/git history) plus `gate_health` (the current-verdict blob every consumer reads). Before
 * WI-4494 this lived only in the routine's action body, so ONLY routine-launched runs recorded —
 * a manual `release:checkpoint-run` ran the full suite and threw its verdict away. See
 * release/gate-verdict-target.ts for the failure loop that produced (and the skew-safety that
 * governs which side calls this).
 *
 * Callable from the CLI itself (`green-checkpoint.ts`, via a dynamic import) — hence a plain
 * `GateVerdictTarget` rather than the routine-only `SystemActionCtx`.
 *
 * EI-13723: this is ALSO the release-fixer dispatch's producer-side convergence point, for the
 * same reason WI-4494 made it the recording one. A manually-launched `release:checkpoint-run`
 * self-records its verdict through this exact function (the CLI stamps `gateVerdictEnv` and calls
 * this from its own process) but, before this fix, the fixer-dispatch check lived ONLY in the
 * scheduled routine's own post-processing below — a code path a manual run never executes. During
 * the 2026-07-16/17 stall a fleet repeatedly fired manual checkpoint runs to get a fresh verdict
 * after each fix attempt; each run recorded a real red (with failing tests) but never dispatched a
 * fixer, AND each run's held run-lock caused the scheduled routine's own hourly ticks (the only
 * path that DID dispatch) to land `skipped-locked` — starving the gate of dispatch from both
 * sides for hours until a human broadcast got it manually picked up. Dispatching HERE means every
 * caller of this function — self-recording CLI (routine- or manually-launched) and the routine's
 * own version-skew fallback below — gets fixer coverage uniformly.
 *
 * Returns true when the verdict was recorded; false when it is not a verdict at all (a `skipped-*`
 * outcome — the run that HOLDS the lock is producing the real one and records it itself).
 */
/**
 * WI-38150 — PRE-BIND the self-heal module graph before the long suite runs.
 *
 * The gate's two self-heal paths — the release-red NOTIFY and the release-fixer DISPATCH —
 * are reached through `await import(...)` at the very END of a run that has by then been
 * executing for 30-55 minutes against the LIVE, MUTATING staging checkout. git-sync commits
 * the whole tree every few minutes, so those late imports can bind a module graph assembled
 * from two different states of the same tree. Nothing throws until the last import resolves,
 * and what it throws is a bare `does not provide an export named 'X'`.
 *
 * Observed 2026-08-12 (run started 06:34:21Z, failed 07:02Z): BOTH self-heal paths died on
 * `The requested module './agent-tools/coordination/identity' does not provide an export
 * named 'isTransportOnlyIdentity'` — an export added to the tree at 06:55:16Z, 21 minutes
 * INTO the run. The gate was on its 12th consecutive red at the time. So the one code path
 * that only ever executes when the gate is red is the path that was broken, and it took the
 * notifier down with it: no repair, and no report that no repair had happened.
 *
 * Binding these modules HERE — at the start of the action, before a single test has run —
 * makes the self-heal graph coherent as of run start, which is the same tree state the rest
 * of the run was cut from. It cannot fix a genuinely-missing export, and it is not meant to:
 * it removes the WINDOW, so a self-healer that would work at run start still works at run end.
 *
 * Deliberately NOT silent. A prebind failure is a PREDICTION that the self-healer is already
 * dead for this run, delivered while there is still time to act on it — the opposite of the
 * failure above, which was discovered hours later by reading a log.
 */
let selfHealPrebound: Promise<void> | null = null;
export function prebindSelfHealModules(): Promise<void> {
  // Idempotent per process: several runs (and the stale-red auto-refire, which recurses in
  // the SAME process) share one binding — re-importing a bound module is a no-op anyway, but
  // caching keeps the "PREBOUND"/"PREBIND FAILED" line to one per process rather than per pass.
  if (selfHealPrebound) return selfHealPrebound;
  selfHealPrebound = (async () => {
    const results = await Promise.allSettled([
      import('../../attention-notify'),
      import('../../blueprint/launch-blueprint'),
      import('../../dev-data'),
      import('../../severe-event-broadcast'),
      import('../../coord/gate-ownership'),
    ]);
    const failed = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : [],
    );
    if (failed.length > 0) {
      console.warn(
        `${orchestratorStdoutTag()} SELF-HEAL PREBIND FAILED (${failed.length}/${results.length}) — ` +
          `the release-red notify and/or release-fixer dispatch for THIS run will not launch, so a red ` +
          `gate will go unreported AND unrepaired. Fix before trusting this run's outcome: ${failed.join(' | ')}`,
      );
      return;
    }
    console.log(`${orchestratorStdoutTag()} self-heal modules prebound (${results.length}) — notify + fixer dispatch are launchable`);
  })();
  return selfHealPrebound;
}

/** Test seam: forget the cached prebind so a test can exercise the failure path. */
export function __resetSelfHealPrebindForTest(): void {
  selfHealPrebound = null;
}

export async function recordCheckpointVerdict(
  target: GateVerdictTarget,
  verdict: CheckpointVerdict,
): Promise<boolean> {
  if (!isRecordableVerdict(verdict.reason)) return false;
  await appendPipelineEvent({
    workspaceId: target.workspaceId,
    installSlug: target.installSlug,
    kind: 'green_checkpoint',
    status: verdict.reason,
    detail: buildCheckpointDetail(verdict),
  });
  // EI-19405864032365760: `summary` rides along so the 'migrations-pending' abort path can name
  // the pending migration in `gate_health.inconclusive` — it is the only field carrying it.
  await trackGateStall(target, verdict.reason, verdict.candidate, verdict.failingTests, verdict.from ?? null, verdict.retriage, verdict.summary ?? null);
  // EI-13723: see the doc above — the dispatch check moved here so a manual run gets fixer
  // coverage identical to a routine run. Fail-safe: never let a dispatch problem break verdict
  // recording, which already happened above.
  if (shouldDispatchReleaseFixer(verdict.reason, verdict.candidate, verdict.failingTests)) {
    await dispatchReleaseFixer(target, verdict.candidate, verdict.failingTests).catch((e) =>
      console.warn(`${orchestratorStdoutTag()} release-fixer dispatch failed: ${e instanceof Error ? e.message : e}`),
    );
  }
  return true;
}

/**
 * system:green-checkpoint — advance `ready` to the newest green integration
 * commit. Idempotent (FF-only, no-op when already green). Bounded so a stuck
 * suite can't wedge the routines tick.
 */
registerSystemAction('green-checkpoint', async (ctx: SystemActionCtx) => {
  // WI-38150: bind the self-heal graph NOW, while the tree still matches the state this run is
  // about to judge. By the time the suite ends (30-55min) the checkout has moved under us, and a
  // late `await import` of the notify/dispatch path can bind across the mutation and throw. Awaited
  // rather than fired-and-forgotten so the diagnostic lands BEFORE the suite's output buries it.
  await prebindSelfHealModules();
  // per-hive-git-and-release-gate P-010: route a per-hive routine to ITS OWN checkout /
  // branches / greenCmd. Operator-home (papercusp) → default root + empty overlay = EXACT
  // current behavior (regression-safe). A non-gated installSlug (gate disabled / no repo) →
  // skip (never run a suite for it). The overlay rides runScript's extraEnv → the
  // env-driven releaseConfig() in green-checkpoint.ts picks up the per-hive config.
  const { resolveCheckpointRouting } = await import('./hive-release-env');
  // EI-20263854732193595: state the judged tree ONCE per run, before any verdict exists.
  // Pinned by a source test — a builder nobody calls is the same silent-but-well-formed
  // failure this whole item is about.
  console.log(`${orchestratorStdoutTag()} ${integrationRootEvidence()}`);
  const routing = await resolveCheckpointRouting(ctx, integrationRoot());
  if (routing.skip) {
    console.log(`${orchestratorStdoutTag()} skip ${ctx.installSlug}: ${routing.skip.reason}`);
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'skipped-disabled',
      detail: { reason: routing.skip.reason },
    });
    return;
  }
  const root = routing.root;
  const tooling = releaseToolingStatus(root, 'apps/operator/lib/release/green-checkpoint.ts');
  if (!tooling.ok) {
    console.warn(
      `${orchestratorStdoutTag()} skip ${ctx.installSlug}: release tooling unavailable (${tooling.reason}) at ${root}`,
    );
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'skipped-no-tooling',
      detail: { reason: tooling.reason, root },
    });
    return;
  }
  const r = await runScript(
    root,
    'apps/operator/lib/release/green-checkpoint.ts',
    [],
    GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    // WI-4494: hand the CLI the harness whose gate this run is judging, so the PRODUCER of the
    // verdict is the thing that records it (see release/gate-verdict-target.ts). A CLI old enough
    // not to know the env simply ignores it and never sets `recorded` — we then record below,
    // exactly as before. The env is what makes that skew safe in both directions.
    {
      ...routing.extraEnv,
      ...gateVerdictEnv({ workspaceId: ctx.workspaceId, installSlug: ctx.installSlug }),
      // WI-4310: the suite's child process must not inherit a large host pool and
      // starve routinesTick's shared org-admin pool. The checkpoint-specific knob
      // is intentionally translated to the db package's standard pool override.
      ...greenCheckpointDbPoolEnv(),
    },
    // Isolate the multi-GB suite in its own transient scope/cgroup so its memory
    // never counts against (or OOM-kills) the bg-host cage that runs the hive loop.
    { memoryMaxG: checkpointScopeMemoryMaxG() },
    // EI-20709645463022690: for a SUBJECT hive, drop the operator's inherited DATABASE_URL/PG*
    // so the pot's suite resolves its OWN database. EMPTY for operator-home, whose gate legs
    // genuinely need that DSN — so papercusp's own pipeline is byte-identical (D-007).
    routing.clearEnv,
  );
  if (r.code !== 0) {
    console.warn(`${orchestratorStdoutTag()} exited ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`);
  } else {
    console.log(`${orchestratorStdoutTag()} ${(r.stdout || '').trim().slice(-200)}`);
  }

  // Pipeline history (mig 177): log the checkpoint outcome for the /admin Git tab.
  // The CLI prints the CheckpointResult as JSON ({ advanced, candidate, from,
  // green, reason }); `reason` IS our status vocabulary. On a crash before that
  // print (non-zero exit, no parseable JSON), record an 'error' row instead.
  // WI-39841 (Defect 2): a run KILLED at its own deadline is not a crash and is not a verdict.
  // Measured on the 2026-08-18T17:15:04Z cron run: SIGTERM'd at its 120m cap mid-salvage, it
  // recorded `failingTests:[] observedCandidate:null retriageDetail:null` — and still drove
  // consecutiveReds 26 -> 27, the streak that freezes `main` and dispatches release-fixers.
  // A contentless red is worse than no red: it names nothing to fix while asserting something
  // is broken. `parsed?.reason` below still wins whenever the run DID print a verdict before
  // dying, so this only relabels the genuinely verdict-less case.
  let status = checkpointFallbackStatus(r.timedOut);
  let candidate: string | undefined;
  let summary: string | undefined;
  let failingTests: string[] | undefined;
  let flakeSuspects: string[] | undefined;
  // P-008: parse the delimited result marker, not a brace-slice of all stdout.
  const parsed = parseMarkerLine(r.stdout, GREEN_CHECKPOINT_RESULT_MARKER) as CheckpointVerdict | null;
  if (parsed?.reason) {
    status = parsed.reason; // advanced | up-to-date | not-green | not-fast-forward | create-failed | skipped-locked
    candidate = parsed.candidate;
    summary = parsed.summary;
    failingTests = parsed.failingTests;
    flakeSuspects = parsed.flakeSuspects;
  }
  /**
   * WI-4494 — did the RUN already record its own verdict?
   *
   * The CLI is now the producer-side recorder (gate_health + the pipeline event), which is what
   * stops a detached `release:checkpoint-run` from computing a real green/red and discarding it.
   * When it recorded, recording again HERE would append a duplicate history row and — worse —
   * double-increment the red streak for a single verdict.
   *
   * We still record when it did NOT, and both cases are real:
   *  - version skew — the DEPLOYED routine drives the INTEGRATION tree's CLI, so an older CLI that
   *    knows nothing of `recorded` (or of the env that authorizes it to record) routinely runs here;
   *  - a crash with no parseable marker (status 'error'), which the CLI cannot report on its own
   *    behalf — it is dead. This branch is the ONLY reason the routine still holds a recorder.
   */
  const recordedByRun = parsed?.recorded === true;
  if (recordedByRun) {
    console.log(`${orchestratorStdoutTag()} '${status}' — recorded by the run that produced it (WI-4494)`);
  } else {
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status,
      detail: parsed?.reason
        ? buildCheckpointDetail(parsed)
        : // No parseable result marker (crash before print / non-zero exit) → 'error'.
          { code: r.code, stderr: (r.stderr || r.stdout).slice(-300) },
    });
  }

  // P-006 (release-pipeline-resilience-2026-06-09): a held gate auto-dispatches a
  // release-fixer agent to diagnose + fix the failing test — the test-failure
  // sibling of git-sync's merge-resolver. Fail-safe + deduped per red-candidate.
  // EI-13723: only for the version-skew fallback (!recordedByRun) — when the run recorded
  // its own verdict, `recordCheckpointVerdict` (called from inside the CLI, above) already
  // ran this exact check. Dispatching here TOO for a recordedByRun verdict would double-fire
  // the dedup'd decision for every routine tick on a modern CLI; gating on !recordedByRun
  // keeps this a pure fallback instead of a race with the producer-side dispatch.
  if (!recordedByRun && shouldDispatchReleaseFixer(status, candidate, failingTests)) {
    await dispatchReleaseFixer(ctx, candidate as string, failingTests).catch((e) =>
      console.warn(`${orchestratorStdoutTag()} release-fixer dispatch failed: ${e instanceof Error ? e.message : e}`),
    );
  }

  // P-004: track the red streak + time-since-last-green across ticks and fire a
  // LOUDER urgent alert when the gate has been HELD too long (the "stuck for a
  // while" signal, distinct from the per-candidate notification). Runs for every
  // verdict so it resets on green; fail-safe.
  // WI-4494: skipped when the run recorded its own verdict — see `recordedByRun` above. A second
  // trackGateStall for ONE verdict would count the same red twice.
  if (!recordedByRun) {
    // EI-13288: thread the parsed run's own retriage verdict through this fallback recorder too
    // (version-skew / crash path) — same as the WI-4494 producer-side path above.
    // EI-20767792192323374: thread `summary` here too. Both abort reasons ('migrations-pending',
    // 'infra-inconclusive') record their cause in `gate_health.inconclusive` and the summary is
    // the ONLY field carrying it — omitting it on this fallback path recorded a detail-less
    // abort, which reads as "aborted, cause unknown" exactly where the reader needs the cause.
    await trackGateStall(ctx, status, candidate, failingTests, parsed?.from ?? null, parsed?.retriage, parsed?.summary ?? null).catch((e) =>
      console.warn(`${orchestratorStdoutTag()} stall tracking failed: ${e instanceof Error ? e.message : e}`),
    );
  }

  // P-009: per-workspace flake history — tally workspaces the gate marked as a
  // PROVEN flake (failed then passed on retry) and notify when one is chronically
  // flaky so it gets quarantined accountably. Fail-safe.
  // load-flake-isolation-2026-06-23: ALSO tally the per-FILE flakes the new isolation
  // pass absorbed (red under load, green in isolation) — proven flakes keyed by
  // `<ws>::<file>`, finer-grained than the workspace-retry markers, so a chronically
  // load-flaky FILE trips the same quarantine nudge.
  await trackFlakeHistory(ctx, summary, flakeSuspects).catch((e) =>
    console.warn(`${orchestratorStdoutTag()} flake history failed: ${e instanceof Error ? e.message : e}`),
  );
});

/** P-004 thresholds: a gate held this many consecutive hourly checkpoints — or
 *  with no green for this long — is STALLED and worth an urgent, one-shot alert. */
// P-016: STALL thresholds are runtime-settable — see releaseCheckpointConfig() (release:checkpoint-config).

// P-003 (git-sync-dx-hardening): a stalled gate gets a DURABLE escalation row
// (every other pipeline failure has one) — its own phase so it never clobbers
// the git-sync conflict/error rows.
const GATE_STALL_PHASE = 'green-checkpoint-stall';
const GATE_STALL_KIND = 'green-checkpoint-stall';

/** Pure: the `harness_escalations` body for a green-checkpoint stall (testable). */
export function gateStallEscalationBody(opts: {
  installSlug: string;
  consecutiveReds: number;
  heldHrs: number | null;
  candidate?: string | null;
  failingTests?: string[];
  nowMs: number;
  /** EI-18672078222841101: WHO already owns this red, from the `last_fixer` record the
   *  dispatcher keys its own dedup on. Without it this escalation is a broadcast with no
   *  ownership field, and every recipient's individually-correct "a red gate blocking my
   *  work is mine to green" produces N parallel diagnoses of one single-owner question
   *  (observed: 3 agents, same leg, inside 15 minutes). Optional so an unwired/legacy
   *  caller still renders exactly as before. */
  ownership?: GateRedOwnership;
}): string {
  const tests = (opts.failingTests ?? []).slice(0, 20);
  return JSON.stringify({
    kind: GATE_STALL_KIND,
    harness_slug: opts.installSlug,
    consecutiveReds: opts.consecutiveReds,
    heldHrs: opts.heldHrs,
    candidate: opts.candidate ? opts.candidate.slice(0, 12) : null,
    failingTests: tests,
    emitted_at: opts.nowMs,
    ownership: opts.ownership
      ? {
          state: opts.ownership.state,
          covered: opts.ownership.covered,
          spawnId: opts.ownership.spawnId,
          ownerSignature: opts.ownership.ownerSignature,
        }
      : null,
    detail: `green-checkpoint has held main for ${opts.consecutiveReds} checkpoint(s)${
      opts.heldHrs != null ? ` (~${opts.heldHrs}h since the last green)` : ''
    }; staging changes are NOT reaching the release.${
      tests.length ? ` Failing: ${tests.slice(0, 5).join(', ')}${tests.length > 5 ? ` (+${tests.length - 5} more)` : ''}.` : ''
    }${opts.ownership ? ` ${opts.ownership.label}` : ''}`,
  });
}

/**
 * PURE (P-005): the fleet broadcast that OPENS the `gate-red-streak:<harness>`
 * condition — the thing that gives a red gate exactly one ownable work-item.
 *
 * ── WHY THIS RIDES THE EXISTING EDGE RATHER THAN A NEW DETECTOR ────────────────
 * The state machine this needs already exists, immediately below: `consecutiveReds`
 * increments per red tick, `stallAlerted` makes the alert one-shot per episode, and
 * the green branch resets both. A second detector (the obvious build — sweep
 * `gate_health` from the watchdog) would be a SECOND answer to a question the first
 * already answers, and the two would disagree the first time either threshold moved.
 * So the condition is emitted at the exact edge that already fires the urgent alert,
 * and resolved at the exact edge that already clears the escalation.
 *
 * ⚠ THE OPEN EDGE IS `stalledByCount || stalledByAge`, NOT the count alone — and the
 * name says "red-streak" because the count is the dominant trigger. Both legs are
 * evaluated ONLY inside the red branch, so both mean "the gate is red and stuck";
 * binding to the existing one-shot flag is what keeps open and close symmetric.
 * Splitting the count out would need a SECOND dedup flag and would double-alarm on
 * the overlap.
 *
 * The body names the sibling `green-stall:` condition on purpose: past 12h with no
 * green BOTH are open and one gate carries two owning work-items (see
 * {@link gateRedStreakConditionKey} for why that is accepted rather than suppressed).
 * A claimant who learns it here does not have to re-derive it.
 */
export function gateRedStreakBroadcast(opts: {
  installSlug: string;
  consecutiveReds: number;
  heldHrs: number | null;
  candidate?: string | null;
  failingTests?: string[];
  ownership?: GateRedOwnership;
  /** `staleness.commitsBehindTip` — how far the judged candidate trails staging. */
  commitsBehindTip?: number | null;
}): { summary: string; body: string } {
  const tests = (opts.failingTests ?? []).slice(0, 20);
  const held = opts.heldHrs != null ? ` (~${opts.heldHrs}h since the last green)` : '';
  return {
    summary:
      `green-checkpoint RED on ${opts.installSlug} — ${opts.consecutiveReds} consecutive red checkpoint(s)${held}; ` +
      `\`main\` is frozen and staging changes are NOT reaching the release.`,
    body:
      `The release gate is FIRING but every verdict is red${
        opts.candidate ? `; the last judged candidate was ${opts.candidate.slice(0, 12)}` : ''
      }.${
        tests.length
          ? ` Failing: ${tests.slice(0, 5).join(', ')}${tests.length > 5 ? ` (+${tests.length - 5} more)` : ''}.`
          : ''
      }${opts.ownership ? ` ${opts.ownership.label}` : ''}${
        opts.commitsBehindTip != null && opts.commitsBehindTip > 0
          ? ` NOTE: that candidate is ${opts.commitsBehindTip} commit(s) behind staging — on this tree the ` +
            `fix is very often already committed, so confirm a named failure still reproduces AT TIP ` +
            `(npm run test:file -- <paths>) before chasing it.`
          : ''
      }\n\nThis condition owns ONE work-item for this red (the condition bridge mints it), so claim ` +
      `that item rather than opening another. Distinct from \`green-stall:${opts.installSlug}\`, which ` +
      `means the gate is not producing verdicts AT ALL — during a long red streak both can be open, and ` +
      `they are the same gate seen two ways.`,
  };
}

/** Pure classification of a green-checkpoint tick's outcome for gate_health tracking.
 *  Exported for unit testing (EI-2615). */
/**
 * 'record-only' (WI-39450) is deliberately NOT 'noop'. 'noop' means "leave gate_health entirely
 * untouched", which is right for a tick that never judged anything — but a superseded pass DID
 * run a full suite, and EI-13288 persists its `retriageClassification` (and suppresses the
 * stale-cap pair) on purpose. Routing it to 'noop' would silently delete that diagnostic. So
 * 'record-only' writes every field exactly as a red does, and changes ONE thing: it does not
 * advance the streak.
 */
export type GateStallClass = 'reset' | 'noop' | 'red' | 'record-only';

/**
 * Classify a tick's `status` (+ whether the release pin moved since the last
 * observation) into how `trackGateStall` should treat `gate_health`:
 *   - 'reset': a real green verdict (or hard evidence `main` is advancing via
 *     `pinMoved`) — clear the red streak.
 *   - 'noop': `status === 'skipped-locked'` (EI-2615). Contention with an ACTIVE
 *     peer run is not evidence of a red build — it only proves another tick
 *     currently holds the lock, which is EXPECTED whenever ticks legitimately
 *     overlap (an hourly cron firing while a ~55min detached run is still in
 *     flight, or a manual `release:checkpoint-run` started mid-cycle).
 *     Counting it as a red produced exactly the EI-2615 symptom: a genuinely
 *     green FF (the OTHER, still-finishing tick) briefly shadowed by a
 *     colliding tick's false-red increment landing its own gate_health write
 *     afterward, leaving `gate.green=false` / a stale `consecutiveReds` for
 *     the gap between the two ticks' writes. The genuine "wedged, not firing"
 *     case `skipped-locked` was ALSO trying to catch is already covered by the
 *     separate `fireStale` signal (last-fire / last-green age,
 *     green-stall-watchdog.ts) — so leave `gate_health` untouched here rather
 *     than double-count healthy contention as a red.
 *   - 'noop': `status === 'migrations-pending'` (EI-18757975681519069) — the
 *     same reasoning one step earlier. The gate ABORTED before judging because
 *     the dev PG is known to be behind the candidate, so this tick produced no
 *     verdict about the code at all; counting a non-verdict as a red is the
 *     identical false-increment bug EI-2615 fixed for lock contention. And it
 *     is covered by a backstop, so "inconclusive" never goes silent — it just
 *     stops being mislabelled as a broken build. EI-19321275470651356 pins down
 *     WHICH backstop, because the obvious guess is wrong and cost a reader an
 *     investigation: it is NOT `fireStale`. `fireStale` keys on `last_fired_at`,
 *     which a noop tick still refreshes (see the WI-4489 note further down), so
 *     it reads FRESH throughout. The real detectors both live in
 *     release/green-stall-watchdog.ts, on a 15-min sweep:
 *       · `checkMainBehindStaging` — >20 commits behind AND >1h AND no advance
 *         in 2h. This is the one that actually fires (verified live on
 *         2026-08-02: a migrations-pending freeze escalated at 04:48Z, ~3.5h in).
 *       · `evaluateGreenStall`'s `verdictStale` — no GREEN verdict in 12h, the
 *         deep backstop. Keyed on `lastGreenAt`, which a noop leaves stale on
 *         purpose — that staleness IS the signal.
 *   - 'noop': `status === 'infra-inconclusive'` (EI-20767792192323374) — the same
 *     reasoning one step LATER. Here the suite DID run; what failed was the gate's
 *     own vite-node module cache, deleted underneath it mid-run by something on the
 *     host. Its ~4,800 failing files are innocent, so the tick is a non-verdict for
 *     the same reason a migrations-pending abort is, and gets the same backstops.
 *   - 'noop': `status === 'deadline-exceeded'` (WI-39841) — the run was SIGTERM'd at
 *     its own suite budget before it could record a verdict. The other two aborts
 *     happen BEFORE judging; this one is killed DURING or AFTER judging and simply
 *     cannot report, which is why it used to arrive here indistinguishable from a
 *     crash: non-zero exit, no parseable marker. The runner now stamps
 *     `RunResult.timedOut` at the timer that does the killing, so the two are told
 *     apart by an OBSERVED fact rather than by the shape of what is missing.
 *     Measured 2026-08-18: the 17:15:04Z run died at its 120m cap and banked red #27
 *     carrying `failingTests:[]` / `observedCandidate:null` — a red naming nothing to
 *     fix, which still drove the held-gate alarm and the release-fixer dispatch. Same
 *     backstops as the two above.
 *   - 'red': every other non-green verdict (not-green / error / create-failed /
 *     not-fast-forward / …) still counts toward the stall streak. 'error' keeps its
 *     place here: after WI-39841 it means a genuine crash or unparseable output, NOT
 *     a deadline-kill.
 */
/** The re-triage fields this module reads. Structural + narrow on purpose: `trackGateStall`'s
 *  own `retriage` param (and the CLI's CheckpointVerdict.retriage) satisfy it without either
 *  side importing the other's shape. */
export type GateStallRetriage = {
  classification?: 'real-red' | 'stale-candidate' | 'unknown' | null;
  autoRefire?: boolean;
  refireBlockedBy?: 'cap-disabled' | 'charged-budget' | 'absolute-ceiling' | 'deadline' | null;
};

/**
 * WI-39450: is this not-green verdict a PROVEN-STALE pass — one whose own re-triage re-ran the
 * failing files at tip and watched them PASS?
 *
 * This is the third instance of the EI-2615 / EI-18757975681519069 bug, and the most expensive:
 * a pass that judged an already-superseded tree is not a statement about the code, but
 * `trackGateStall` counted it anyway. Measured 2026-08-17: a run classified its own candidate
 * `stale-candidate`, stamped `superseded-by-refire`, and still drove consecutiveReds 10 -> 11 —
 * naming 7 `operator-core/lib/agent-tools/memory/*.test.ts` files that had ALL been modified in
 * the 23 commits since that candidate and passed 52/0 at tip. That red sends agents at
 * already-fixed files, which is precisely the harm EI-19405864032365760 documents.
 *
 * ⚠ THE FIRST VERSION OF THIS GUARD ALSO REQUIRED `autoRefire === true`, AND THAT MADE IT DEAD
 * CODE. Rationale then: "the guard is on the SUCCESSOR EXISTING — when the refire is blocked no
 * successor is coming, so this pass is the final word and must still count as a red." Measured
 * against 25 consecutive papercusp runs (2026-08-15..17), `autoRefire` was **false in 18 of 18**
 * runs that re-triaged at all — so the guarded branch never once executed. The run that actually
 * froze `main` (12:36:47Z, candidate 7a040c5c) is the exact shape it missed:
 * `classification=stale-candidate refireBlockedBy=deadline` — the gate PROVED all 4 failing files
 * pass at tip, then banked the red anyway because a second suite would outrun the run budget.
 *
 * The old rationale conflated two independent questions:
 *   · "is a rescue scheduled?"  — `autoRefire` / `refireBlockedBy`. A CLOCK-AND-BUDGET fact.
 *   · "is the code broken?"     — `classification`. An EVIDENCE fact, and the only one the streak
 *                                 is entitled to move on.
 * `stale-candidate` is returned from exactly one branch of `triageRed` (green-checkpoint.ts), the
 * one whose detail reads "N failing file(s) PASS at tip" — it is the strongest negative evidence
 * the gate ever produces. Whether the run then had the *minutes* to act on it changes nothing
 * about the code. So the streak guard keys on the evidence and ignores the schedule.
 *
 * ONE exception is preserved deliberately: `refireBlockedBy === 'charged-budget'` means the SAME
 * breakage survived every rescue attempt, which green-checkpoint.ts:2609-2611 calls out as the
 * loop guard "that must survive: it is what converges a genuinely-broken tip to a held gate and a
 * human". That one still counts as a red. The other three blockers are not evidentiary at all —
 * `deadline` is a clock, `cap-disabled` is a feature switch, and `absolute-ceiling`'s own operator
 * text says "every individual red WAS rescued ... the fix is to slow the tree or widen the window,
 * NOT to debug the files named above".
 *
 * Under-alerting is NOT a new risk here: this leaves `lastGreenAt` stale on purpose, exactly as
 * 'noop' does, so the two backstops documented above still fire — `checkMainBehindStaging`
 * (>20 commits behind, >1h, no advance in 2h) and `evaluateGreenStall`'s 12h `verdictStale`. A
 * frozen `main` escalates on its own; it never needed a miscounted red streak to be noticed.
 *
 * ⚠ Deliberately NOT keyed on the string `superseded-by-refire`: that is only a LOG trailer
 * (`green-checkpoint.ts` `stampPromotion`) and never reaches this function — the recorded
 * reason is a plain `not-green`.
 */
export function isProvenStaleCandidate(retriage?: GateStallRetriage | null): boolean {
  return (
    retriage?.classification === 'stale-candidate' &&
    retriage.refireBlockedBy !== 'charged-budget'
  );
}

/**
 * WI-39841 (Defect 2) — the status for a run that produced NO parseable result marker.
 *
 * Both inputs to this decision arrive looking identical downstream (non-zero exit, no marker),
 * so the discriminator has to be carried from the one place that observes it first-hand: the
 * runner's deadline timer, which stamps `RunResult.timedOut` at the moment it SIGTERMs the
 * group. This is deliberately NOT inferred from empty `failingTests`/`candidate` — a genuine
 * red can be sparse, and reading absence as a cause is how the two got conflated originally.
 *
 * ⚠ This is only the FALLBACK. A run that printed its verdict and was then killed keeps that
 * verdict: the caller overwrites `status` from `parsed.reason` whenever a marker parsed. So a
 * 'deadline-exceeded' status means "killed AND never reported", which is exactly the tick that
 * establishes nothing about the code.
 */
export function checkpointFallbackStatus(
  timedOut: boolean | undefined,
): 'deadline-exceeded' | 'error' {
  return timedOut ? 'deadline-exceeded' : 'error';
}

export function classifyGateStallStatus(
  status: string,
  pinMoved: boolean,
  retriage?: GateStallRetriage | null,
): GateStallClass {
  const isGreen = status === 'advanced' || status === 'up-to-date' || status === 'advanced-prefix';
  if (isGreen || pinMoved) return 'reset';
  // EI-20767792192323374: 'infra-inconclusive' joins the same class for the same reason one
  // step LATER in the run — the suite executed, but the gate's own vite-node module cache was
  // deleted underneath it, so its failures are a HOST fault and not a verdict about the code
  // (measured 2026-08-18: 4,789 of 5,505 files failed on candidate 1c64cd9f, and red #20 went
  // on the streak that freezes `main`). Same backstops as 'migrations-pending' — this leaves
  // `lastGreenAt` stale on purpose, so checkMainBehindStaging and evaluateGreenStall's 12h
  // `verdictStale` still escalate a frozen `main`; only the mislabelling stops.
  // WI-39841 (Defect 2): 'deadline-exceeded' — the run was SIGTERM'd at its own suite budget
  // before it could record a verdict. Same class, arrived at from the opposite end: the other
  // two abort BEFORE judging, this one is killed DURING/AFTER judging but cannot report. Either
  // way the tick establishes nothing about the code, and the streak may only move on evidence.
  // Measured 2026-08-18: the 17:15:04Z run died at its 120m cap and banked red #27 carrying
  // `failingTests:[]` and `observedCandidate:null` — a red that names nothing to fix, which
  // then drives the held-gate alarm and the release-fixer dispatch.
  // Same backstops as the other two, and they are what make this safe rather than quieter:
  // this leaves `lastGreenAt` stale ON PURPOSE, so checkMainBehindStaging (>20 behind, >1h, no
  // advance in 2h) and evaluateGreenStall's 12h `verdictStale` still escalate a frozen `main`.
  // A gate that keeps dying at its deadline therefore still reaches a human — as an abort that
  // names its own cause, instead of as a broken-build report naming nobody.
  if (
    status === 'skipped-locked' ||
    status === 'migrations-pending' ||
    status === 'infra-inconclusive' ||
    status === 'deadline-exceeded'
  )
    return 'noop';
  // WI-39450: a pass whose own re-triage watched the failing files PASS at tip produced no
  // verdict about the code — see isProvenStaleCandidate. Its diagnostics are still written
  // (EI-13288); only the streak is left alone.
  if (isProvenStaleCandidate(retriage)) return 'record-only';
  return 'red';
}

/**
 * WI-2825 (harden trackGateStall's silent no-op): should the durable
 * harness_escalations clear be treated as a suspicious miss worth a loud warning?
 * Pure decision, exported for unit testing without a DB — `trackGateStall` (below)
 * supplies the two live inputs: `stallAlerted` (gate_health believed an escalation
 * was fired) and the actual row count the clear UPDATE matched.
 *
 * Only true when a row WAS expected (stallAlerted) and NONE matched — an everyday
 * "nothing to clear" reset (no prior escalation, stallAlerted false) must stay
 * silent, exactly as before this change.
 */
export function shouldWarnOnStallClearMiss(stallAlerted: boolean, clearedCount: number): boolean {
  return stallAlerted && clearedCount === 0;
}

/**
 * EI-19321275470651356: the log line `trackGateStall` emits for a `'noop'` tick.
 *
 * `'noop'` covers two conditions whose correct operator response is OPPOSITE, so they
 * must not share one message:
 *   · `skipped-locked`      — a peer run IS in flight and will produce the verdict.
 *                             "wait, this resolves itself" is correct advice.
 *   · `migrations-pending`  — the preflight aborted and NOBODY is coming. Telling that
 *                             reader "an active peer run holds the lock" is factually
 *                             false, and it points them away from the real cause at
 *                             exactly the moment they are asking why `main` is stuck.
 *
 * Pure + exported so the distinction has a DB-free regression test, matching the
 * convention `shouldWarnOnStallClearMiss` / `classifyGateStallStatus` already set here.
 */
/**
 * WI-39450: the log line for a `'record-only'` tick. Its own function because the operator
 * response differs from BOTH noop conditions: no peer run holds a lock, and unlike
 * `migrations-pending` a full suite really did run — it just judged a tree that has already
 * moved. Saying so is the point: that failing-file list is exactly what sends agents at
 * already-fixed tests.
 *
 * ⚠ Do NOT reintroduce "handed off to an auto-refire, which will record the real verdict" here.
 * That was the original wording and it is false in the case that actually dominates: a refire
 * blocked by `deadline` records nothing, and `main` simply stays where it is until the next cron.
 * Promising a successor that never arrives is worse than promising nothing — a reader who
 * believes it waits instead of looking at the gate.
 */
export function gateStallRecordOnlyLogMessage(status: string): string {
  return (
    `${orchestratorStdoutTag()} '${status}' — this pass proved its OWN candidate STALE (its ` +
    `re-triage re-ran the failing files at tip and they PASSED). Diagnostics written, streak NOT ` +
    `advanced: this pass judged an already-superseded tree, so any failing files it named are ` +
    `stale — re-verify at tip before fixing anything. NOTE this run did NOT promote and may not ` +
    `have refired, so \`main\` can stay put with the streak flat; a frozen \`main\` is escalated by ` +
    `checkMainBehindStaging / evaluateGreenStall, not by this counter. See classifyGateStallStatus`
  );
}

export function gateStallNoopLogMessage(status: string): string {
  // EI-20767792192323374: the THIRD noop condition, and its correct operator response differs
  // from BOTH of the others — nobody holds a lock (so "wait, it resolves itself" is wrong) and
  // no migration is pending (so pointing at the migration list is wrong). The host deleted the
  // runner's temp root mid-suite; the next scheduled run judges normally once that stops, and
  // the files this run named are innocent and must not be triaged.
  if (status === 'infra-inconclusive') {
    return (
      `${orchestratorStdoutTag()} 'infra-inconclusive' — this run's suite FAILED WHOLESALE because the gate's own ` +
      `vite-node module cache was deleted mid-run (a HOST fault: a /tmp reaper or a peer sweeping the runner's temp ` +
      `root). It rendered no verdict about the code IN EITHER DIRECTION, so ⚠ DO NOT TRIAGE the files it failed — ` +
      `they are innocent. No peer run is in flight; the next scheduled run judges normally once the host fault ` +
      `clears. Leaving gate_health untouched (not a red; a frozen \`main\` is still escalated by ` +
      `checkMainBehindStaging / evaluateGreenStall, not by this counter — see classifyGateStallStatus)`
    );
  }
  if (status === 'migrations-pending') {
    return (
      `${orchestratorStdoutTag()} 'migrations-pending' — this run ABORTED at the migration preflight ` +
      `(the dev PG is known to be behind the candidate). NO peer run is in flight and no verdict ` +
      `is coming until the pending migration applies — see the pending migration(s) and their ` +
      `errors named just above. Leaving gate_health untouched (not a red: this tick judged no code ` +
      `at all; the deploy freeze itself is caught by checkMainBehindStaging / the green-stall ` +
      `watchdog, not by this counter — see classifyGateStallStatus)`
    );
  }
  return `${orchestratorStdoutTag()} '${status}' — an active peer run holds the lock; leaving gate_health untouched (not a red, see classifyGateStallStatus)`;
}

/**
 * P-004: track green-checkpoint gate health in the routine metadata (`gate_health`)
 * and fire ONE urgent stall alert when the red streak / age crosses the threshold
 * (transition-only via `stallAlerted`). The data also surfaces on the Git tab via
 * gitPipelineSnapshot().gate. Fail-safe — the routine tick never depends on it.
 */
// Exported for the EI-7472 regression test (capture the gate_health write and
// assert the watchdog-owned dedup flag survives a red tick / clears on green).
export async function trackGateStall(
  // WI-4494: narrowed from SystemActionCtx to the two fields this actually reads, so the CLI (which
  // has no routine context) can record its own verdict through the same path. A SystemActionCtx
  // still satisfies it structurally — every existing caller is unchanged.
  ctx: GateVerdictTarget,
  status: string,
  candidate?: string,
  failingTests?: string[],
  from?: string | null,
  /** EI-13288: the CLI's own stale-candidate re-triage verdict (see CheckpointVerdict.retriage
   *  above), when the caller has one. */
  retriage?: {
    classification: 'real-red' | 'stale-candidate' | 'unknown';
    tip: string | null;
    detail: string;
    autoRefire?: boolean;
    refireBlockedBy?: 'cap-disabled' | 'charged-budget' | 'absolute-ceiling' | 'deadline' | null;
  },
  /** EI-19405864032365760: the verdict's own prose (`CheckpointVerdict.summary`). Only read on the
   *  `migrations-pending` noop path, where it is the ONLY place the pending migration is named. */
  summary?: string | null,
  /** EI-19329732364513693 test seam — injectable git runner for the candidate-staleness
   *  measurement below. Defaults to the real one; mirrors checkReleaseFixerCandidateStale. */
  gitRunner?: GitCheckRunner,
): Promise<void> {
  // P-016 (D-010): a partial advance ('advanced-prefix') MOVED `main` (the longest green
  // prefix is deployable), so it resets the "main hasn't advanced" stall streak just like
  // a full advance — the red tip is tracked separately via the release-fixer dispatch.
  const isGreen = status === 'advanced' || status === 'up-to-date' || status === 'advanced-prefix';
  // P-006: every non-green verdict OTHER than 'skipped-locked' counts toward the stall
  // streak — INCLUDING 'error' (a green-checkpoint script crash or unparseable JSON).
  // WI-39841 CARVED THE TIMEOUT BACK OUT of that set: a run killed at its own suite budget
  // now arrives as 'deadline-exceeded' (stamped from RunResult.timedOut) and is a 'noop',
  // because it recorded no verdict and its red named no failing file. A CRASH still counts.
  // 'skipped-locked' (a run-lock collision — green-checkpoint-stale-
  // lock-2026-06-26) is handled separately below (EI-2615: `classifyGateStallStatus`
  // treats it as a no-op, not a red — see that function's doc for why). A persistent
  // crash/hang/wedged-lock still increments the streak (via 'error' + the separate
  // `fireStale` signal) and fires the held-gate alarm instead of freezing `main`
  // SILENTLY (the 21h fleet-deploy freeze this detector exists to catch). Only a real
  // green verdict resets the streak.
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // EI-18672078222841101: `last_fixer` rides along in the SAME metadata row we already
  // read — no extra round-trip, and deliberately NOT a new ownership record. It is the
  // signature-keyed record the dispatcher already keys its own dedup on, so the owner this
  // escalation names can never disagree with the owner the dispatcher is deferring to.
  const rows = (await sql.unsafe(
    `SELECT metadata->'gate_health' AS gh, metadata->'last_fixer' AS lf FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ gh: { consecutiveReds?: number; lastGreenAt?: number; firstRedAt?: number; stallAlerted?: boolean; lastFrom?: string; lastMainPin?: string | null; watchdogAlerted?: boolean; failingTests?: string[]; retriageStaleTip?: string | null; retriageDetail?: string | null; retriageClassification?: 'real-red' | 'stale-candidate' | 'unknown' | null } | null; lf: ReleaseFixerRecord | null }>;
  const gh = rows[0]?.gh ?? {};
  const lastFixer = rows[0]?.lf ?? null;
  // Release-pin movement (green-checkpoint-lock-starvation-2026-07-02): `from` is the
  // `main` pin the CLI observed. If it MOVED since the last routine observation, green
  // work landed on `main` through a path this routine never saw — a MANUAL detached run
  // or another lineage's gate (only ROUTINE-invoked runs write pipeline events /
  // gate_health). Without this, an hourly cron that keeps losing the run-lock to a
  // back-to-back manual runner records only 'skipped-locked' reds while `main` is in
  // fact advancing — 21 phantom reds, a false "main frozen ~21h" STALLED page, and a
  // false green-stall-watchdog escalation (it keys on lastGreenAt too). A moved pin is
  // hard evidence the pipeline is flowing, so it resets the streak like a green does.
  const fromPin = from ? from.slice(0, 12) : null;
  // EI-20706962612084953: compare the live pin against where `main` was LEFT by the last
  // routine observation — NOT against the pin that run STARTED from. `lastFrom` is the
  // pre-fast-forward pin by definition, so after any 'advanced' run the next run reads a
  // live pin that differs from it and declares `pinMoved` for the routine's OWN advance.
  // That misclassified the first red after a green as 'reset' — systematically masking
  // the single most important red to surface. `lastFrom` is deliberately NOT repurposed:
  // its "the pin as observed AT verdict time" contract is load-bearing for
  // `evaluateGateVerdictFreshness` Rule 1 ORDERING (gate-verdict-freshness.ts), which
  // needs the pre-FF value. `lastMainPin` records where main ENDED, so only a genuinely
  // EXTERNAL advance (a manual detached run, another lineage's gate — the
  // green-checkpoint-lock-starvation-2026-07-02 case this reset exists for) moves it.
  // The `?? gh.lastFrom` fallback covers a blob written before this field existed: it
  // degrades to exactly the previous behaviour rather than reading a missing pin as
  // "main never moved".
  const lastObservedMainPin = gh.lastMainPin ?? gh.lastFrom ?? null;
  const pinMoved = fromPin != null && lastObservedMainPin != null && fromPin !== lastObservedMainPin;
  const gateClass = classifyGateStallStatus(status, pinMoved, retriage);
  if (gateClass === 'noop') {
    // EI-2615: a lock collision with an ACTIVE peer run proves nothing about the
    // gate's health — leave gate_health completely untouched (don't even seed
    // lastFrom) so a slower, still-in-flight green tick's eventual reset write
    // can never be shadowed by this tick's false-red read-modify-write.
    // EI-19321275470651356: the two conditions in this class need opposite operator
    // advice, so the message is chosen by status (see gateStallNoopLogMessage).
    console.log(gateStallNoopLogMessage(status));
    // EI-19405864032365760: 'noop' must not COUNT this tick as a red — that reasoning
    // (EI-2615 / EI-18757975681519069) is correct and unchanged above. But "don't count it"
    // silently became "don't record it AT ALL", and those are different claims. The counters
    // keep the PREVIOUS red's values, so every read surface (dev:pipeline_position, /admin/git,
    // the gate cells) keeps rendering that stale red — same candidate, same failing tests —
    // while the true state is "aborted before judging; no verdict is coming". Measured
    // 2026-08-03: a pending migration froze the pipeline ~2.5h during which the fleet was told
    // "Gate is RED (N consecutive) — the reds are yours to fix", sending multiple agents at
    // failing files that had nothing to do with it. The documented backstops DO fire, but
    // `checkMainBehindStaging` needs >1h AND no advance in 2h (it escalated at ~3.5h that day)
    // and `verdictStale` needs 12h — both are floors for "someone is eventually told", not for
    // "the reader asking RIGHT NOW gets a true answer".
    //
    // So record the abort in its OWN key, leaving every counter untouched:
    //   · written via jsonb_set on the `{gate_health,inconclusive}` PATH, so unlike the
    //     whole-key replace at the end of this function it cannot shadow a concurrent
    //     counter write — the EI-7472 hazard that makes a read-modify-write here unsafe.
    //   · cleared by the next REAL verdict for free: that write replaces the whole
    //     `gate_health` key, and `next` sets `inconclusive: null` explicitly (same
    //     recovery-clear convention as `failingTests` / `retriageStaleTip`).
    // Scoped to the two ABORT conditions — 'migrations-pending' and (EI-20767792192323374)
    // 'infra-inconclusive'. 'skipped-locked' stays a total no-op on purpose: there a peer run IS
    // in flight and about to write the real verdict, which is precisely the write EI-2615 proved
    // must not be raced. An infra fault has no such peer, and leaving the previous red standing
    // is the exact 2.5h "the reds are yours to fix" failure described above — worse here, because
    // the stale red it keeps rendering names up to 4,789 innocent files.
    // WI-39841 (Defect 2): 'deadline-exceeded' joins them for the same reason, one phase later
    // still — the suite ran and may even have REACHED a verdict, but the process was killed
    // before it could record one, so nothing about the code was established. Recording it here
    // is what stops the abort going silent once it no longer counts as a red.
    if (
      status === 'migrations-pending' ||
      status === 'infra-inconclusive' ||
      status === 'deadline-exceeded'
    ) {
      try {
        await sql.unsafe(
          `UPDATE harness_shared.routines
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gate_health,inconclusive}', $2::jsonb, true),
                  updated_at = now()
            WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
          [
            ctx.installSlug,
            JSON.stringify({
              status,
              candidate: candidate?.slice(0, 12) ?? null,
              detail: summary ?? null,
              observedAtMs: Date.now(),
            }),
          ],
        );
      } catch (e) {
        // Fail-safe, exactly like every other write in this function: an unrecorded abort
        // degrades to the pre-EI-19405864032365760 behaviour (invisible), never to a wrong verdict.
        console.warn(`${orchestratorStdoutTag()} inconclusive-verdict record failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return;
  }
  // EI-19329732364513693: stamp HOW STALE the judged candidate is into the same blob that
  // carries the verdict, so a reader never has to re-derive it (and so the overwhelmingly
  // common case — not thinking to derive it at all — stops costing a wild-goose chase).
  // Fail-safe: nulls on any git error. Deliberately AFTER the 'noop' early-return above, which
  // leaves gate_health untouched and must not pay for a git call it will never record.
  // The root itself is part of the fail-safe: an unresolvable integration tree yields the same
  // nulls a git error does, instead of throwing out of the tick before `.catch()` can apply.
  const stalenessRoot = candidate ? integrationRootForDiagnostic() : null;
  const staleness: CandidateStaleness =
    candidate && stalenessRoot
      ? await measureCandidateStaleness(stalenessRoot, candidate, gitRunner ?? defaultGitCheckRunner).catch(() => ({
          candidateCommittedAt: null,
          commitsBehindTip: null,
        }))
      : { candidateCommittedAt: null, commitsBehindTip: null };
  // EI-20706962612084953: where `main` is left AFTER this run — the value the NEXT tick
  // compares its live pin against (see `lastObservedMainPin` above). 'advanced' fast-forwards
  // main to the candidate; every non-advancing status leaves it exactly where this run found
  // it. 'advanced-prefix' moves main to the longest green PREFIX — a sha this function is
  // never handed — so it records null and the next tick falls back to `lastFrom`, i.e. the
  // pre-existing behaviour for that one status rather than a value we would be inventing.
  const mainPinAfterRun =
    status === 'advanced'
      ? (candidate?.slice(0, 12) ?? fromPin)
      : status === 'advanced-prefix'
        ? null
        : fromPin;
  // EI-13288 / WI-7482 / EI-20243738214569472 — full rationale on the red branch below.
  // Hoisted above the branch so the NOT-GREEN reset arm records the same re-triage
  // provenance a red does: that arm IS a red verdict in every respect except the stall
  // streak, and leaving these null there would re-introduce, one field down, the very
  // "a not-green run recorded as if it had nothing to report" defect this change fixes.
  const retriageStale = retriage?.classification === 'stale-candidate';
  const retriageBlocked = retriageStale && retriage?.autoRefire === false;
  let next: Record<string, unknown>;
  if (gateClass === 'reset') {
    if (!isGreen) {
      console.log(
        `${orchestratorStdoutTag()} release pin moved ${gh.lastFrom} → ${fromPin} outside this routine (status '${status}') — main is advancing; resetting the stall streak`,
      );
    }
    // EI-7472: the final metadata write below REPLACES the whole `gate_health`
    // key (jsonb `||` is a shallow top-level merge). `watchdogAlerted` is owned by
    // the separate green-stall-watchdog sweep — carry it through every `next` here
    // or this whole-object replace silently drops it. On recovery (green) clear it,
    // matching the watchdog's own recovery-clear (green-stall-watchdog.ts).
    // EI-7505: clear the failing-test list on recovery — a stale list from the
    // last red streak must not linger in gate_health once the gate is green again.
    // WI-4489: stamp WHEN this verdict was observed and WHAT it judged. Without it the blob is a
    // value with no provenance, and a consumer cannot tell a live verdict from one frozen hours ago
    // by a starved writer (a `skipped-locked` no-op leaves gate_health untouched while still
    // refreshing `last_fired_at`, so `fireStale` reads FRESH). See release/gate-verdict-freshness.ts.
    // EI-13288: a stale-candidate note from a PRIOR red streak must not linger once the gate is
    // green again — same recovery-clear convention as `failingTests` just above.
    // EI-19405864032365760: `inconclusive` records a preflight ABORT (see the noop branch above).
    // A real verdict supersedes it, so clear it here — explicit rather than relying on the
    // whole-key replace, matching the `retriageStaleTip` / `failingTests` convention so a later
    // change to a merging write cannot silently resurrect a stale abort note.
    // EI-20706962612084953: this branch has TWO populations and only one of them is green.
    // `pinMoved` puts a NOT-GREEN verdict here on purpose (main is advancing via a path this
    // routine never saw, so the "main is frozen" stall streak is not real) — but the blob
    // written below was the full green signature regardless: consecutiveReds 0, firstRedAt
    // null, failingTests [], lastGreenAt = now. Every field agreed with a green and nothing
    // marked it apart, so every surface pointed at gate_health answered "green" for a run
    // that recorded not-green, and the stall detectors keyed on lastGreenAt/consecutiveReds
    // were silently suppressed for it. Reset the STALL STREAK (this branch's legitimate
    // purpose) WITHOUT claiming a green:
    //   · `lastGreenAt` is CARRIED, never stamped — the gate did not green, so the age of the
    //     last real green must keep running (it is what `verdictStale` measures).
    //   · `failingTests` carries this run's real list instead of being cleared as a recovery.
    //   · `watchdogAlerted` is carried, not cleared: clearing is a RECOVERY action and this is
    //     not a recovery (EI-7472 — the whole-key replace drops whatever `next` omits).
    //   · `stallAlerted` is carried for the same reason, and for one more: it is the dedup flag
    //     recording that the red-streak CONDITION is open. Clearing it while leaving that
    //     condition open would strand it — the later genuine green reads `gh.stallAlerted`
    //     false and broadcasts no resolve, leaking a permanently-open incident item (D-011).
    //   · `lastVerdict` is the explicit marker that was missing: with it a reader can tell the
    //     two populations of this branch apart instead of having to infer it from side-effects.
    next = isGreen
      ? { consecutiveReds: 0, lastGreenAt: Date.now(), firstRedAt: null, stallAlerted: false, lastVerdict: 'green', lastFrom: fromPin ?? gh.lastFrom ?? null, lastFromFresh: fromPin != null, lastMainPin: mainPinAfterRun, watchdogAlerted: false, failingTests: [], observedAt: Date.now(), observedCandidate: candidate?.slice(0, 12) ?? null, retriageStaleTip: null, retriageDetail: null, retriageClassification: null, candidateCommittedAt: staleness.candidateCommittedAt, commitsBehindTip: staleness.commitsBehindTip, inconclusive: null }
      : { consecutiveReds: 0, lastGreenAt: gh.lastGreenAt ?? null, firstRedAt: null, stallAlerted: gh.stallAlerted ?? false, lastVerdict: 'not-green', lastFrom: fromPin ?? gh.lastFrom ?? null, lastFromFresh: fromPin != null, lastMainPin: mainPinAfterRun, watchdogAlerted: gh.watchdogAlerted ?? false, failingTests: (failingTests ?? []).slice(0, 20), observedAt: Date.now(), observedCandidate: candidate?.slice(0, 12) ?? null, retriageStaleTip: retriageBlocked ? (retriage!.tip?.slice(0, 12) ?? null) : null, retriageDetail: retriageBlocked ? retriage!.detail : null, retriageClassification: retriage?.classification ?? null, candidateCommittedAt: staleness.candidateCommittedAt, commitsBehindTip: staleness.commitsBehindTip, inconclusive: null };
    // P-003: clear the durable stall escalation on the green transition (idempotent).
    // WI-2825: a 0-row match here (harness_slug/phase mismatch, or the row was already
    // cleared/removed some other way) previously succeeded silently — no error, no log —
    // so a genuinely-stuck escalation (gate_health.stallAlerted already true, meaning the
    // P-003 insert below DID fire earlier and a row SHOULD exist to clear) could linger in
    // harness_escalations forever while gate_health quietly reset to "no active alert".
    // That divergence is exactly the shape of the recurring "Unresolved escalation in
    // harness X" watchdog phantoms (EI-7569/EI-7575 this session): the routine metadata
    // says clear, the escalations table still shows one open. Surface it loudly instead —
    // only when we EXPECTED a row to clear (gh.stallAlerted), so a routine, everyday
    // "nothing to clear" reset (no prior escalation) stays silent as before.
    try {
      const cleared = await sql.unsafe(
        `UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $2
          WHERE harness_slug = $1 AND phase = $3 AND escalation IS NOT NULL`,
        [ctx.installSlug, Date.now(), GATE_STALL_PHASE],
      );
      if (shouldWarnOnStallClearMiss(!!gh.stallAlerted, cleared.count)) {
        console.warn(
          `${orchestratorStdoutTag()} stall escalation clear MATCHED 0 ROWS for harness_slug='${ctx.installSlug}' phase='${GATE_STALL_PHASE}' despite gate_health.stallAlerted=true (an escalation should have existed) — the durable harness_escalations row may be stuck OPEN even though this routine believes the stall is resolved. Check harness_escalations for a stale row under a different harness_slug value.`,
        );
      }
    } catch (e) {
      console.warn(`${orchestratorStdoutTag()} stall escalation clear failed: ${e instanceof Error ? e.message : e}`);
    }
    // A no-turn fixer escalation belongs to the same red episode. Clear it on the first
    // genuinely green verdict so a later reader cannot mistake the old dead launch for a
    // current gate failure. This uses the existing escalation table/phase surface and is
    // deliberately idempotent like the stall clear above.
    //
    // EI-20706962612084953: "genuinely green" is what this comment always said, but the
    // guard was missing — a NOT-GREEN pin-moved tick reaches this branch too and was
    // clearing the escalation for a red episode that is still open. The stall clear above
    // stays unconditional on purpose: it asserts only "main is advancing", which pinMoved
    // is direct evidence of. This one asserts the gate RECOVERED, which is a different
    // claim and false here.
    if (isGreen) {
      try {
        await sql.unsafe(
          `UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $2
            WHERE harness_slug = $1 AND phase = $3 AND escalation IS NOT NULL`,
          [ctx.installSlug, Date.now(), RELEASE_FIXER_NO_TURN_PHASE],
        );
      } catch (e) {
        console.warn(`${orchestratorStdoutTag()} release-fixer no-turn escalation clear failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    // P-005: CLOSE the red-streak condition — the bridge settles the owning work-item
    // on this broadcast, so a missed resolve leaks one permanently-open incident item
    // per episode (D-011's leak, which is exactly what the bridge's `settle: true`
    // exists to prevent). Guarded on `gh.stallAlerted`, the same transition edge the
    // escalation clear above uses: a routinely-green tick opened no condition and must
    // broadcast no recovery, or every green hour spams a resolution for nothing.
    //
    // ⚠ Read `gh.stallAlerted` (the value BEFORE this green reset), never `next`
    // (which sets it false unconditionally two lines up) — testing the post-reset
    // value would make this dead code that never fires.
    //
    // EI-20706962612084953: `isGreen` guards it for the second reason — the broadcast SAYS
    // "green-checkpoint GREEN again … the earlier red-gate alarm is stale", and on a
    // not-green pin-moved tick that is a false all-clear that also SETTLES the owning
    // work-item. A moved pin proves main is advancing; it proves nothing about this
    // verdict, which is precisely the conflation this whole change removes.
    if (isGreen && gh.stallAlerted) {
      try {
        const { broadcastSevereEventResolved } = await import('../../severe-event-broadcast');
        const { gateRedStreakConditionKey } = await import('../../coord/gate-ownership');
        await broadcastSevereEventResolved({
          conditionKey: gateRedStreakConditionKey(ctx.installSlug),
          // The harness slug is repeated on EVERY clause on purpose. This broadcast lands in
          // the inbox of agents working OTHER harnesses, where the consequence clauses ("the
          // red streak is over", "the earlier red-gate alarm is stale") read as global
          // all-clears — a reader on a still-red harness can take it as their own gate
          // recovering. Naming the slug once in the lead is not enough: inbox summaries
          // TRUNCATE, and it is the unscoped tail that survives and gets believed. Observed
          // live 2026-08-17: a sidestage GREEN-again broadcast read as papercusp news while
          // papercusp sat at 15 consecutive reds.
          summary:
            `[${ctx.installSlug}] green-checkpoint GREEN again on ${ctx.installSlug} — ${ctx.installSlug}'s red ` +
            `streak is over and its \`main\` is advancing, so the earlier red-gate alarm for ${ctx.installSlug} ` +
            `is stale. This says NOTHING about any other harness's gate — each harness has its own.`,
        });
      } catch (e) {
        console.warn(`${orchestratorStdoutTag()} red-streak condition resolve failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } else {
    // WI-39450: a 'record-only' tick carries the streak FORWARD instead of advancing it. It is
    // not a green (nothing was promoted, so it must not reset either) — it is a pass whose own
    // re-triage re-ran the named failing files at tip and watched them PASS, i.e. it produced no
    // evidence about the current code at all. Measured 2026-08-17: consecutiveReds 10 -> 11 off a
    // pass whose own classifier said `stale-candidate`, naming 7 files that passed 52/0 at tip;
    // and 13 -> 14 off candidate 67c66f70, whose 4 named files passed 156/0 at tip.
    // When such a pass DOES refire, advancing would additionally double-count one logical run
    // (the superseded pass AND its successor each land a verdict) — but that is a second reason,
    // not the reason: `isProvenStaleCandidate` deliberately does not require a refire, because
    // `autoRefire` was false in 18 of 18 re-triaging runs sampled over 2026-08-15..17.
    // `firstRedAt` is left alone for the same reason — a non-verdict must not START a streak,
    // or a `stalledByAge` escalation could be dated from a tick that judged nothing current.
    const recordOnly = gateClass === 'record-only';
    if (recordOnly) console.log(gateStallRecordOnlyLogMessage(status));
    const consecutiveReds = recordOnly ? (gh.consecutiveReds ?? 0) : (gh.consecutiveReds ?? 0) + 1;
    const firstRedAt = recordOnly ? (gh.firstRedAt ?? null) : (gh.firstRedAt ?? Date.now());
    const lastGreenAt = gh.lastGreenAt ?? null;
    let stallAlerted = gh.stallAlerted ?? false;
    const stalledByCount = consecutiveReds >= releaseCheckpointConfig().stallReds;
    const stalledByAge = lastGreenAt != null && Date.now() - lastGreenAt > releaseCheckpointConfig().stallAgeMs;
    if ((stalledByCount || stalledByAge) && !stallAlerted) {
      stallAlerted = true;
      const heldHrs = lastGreenAt ? Math.round((Date.now() - lastGreenAt) / 3_600_000) : null;
      // EI-18672078222841101: resolve the CURRENT owner before saying anything about one.
      // The old body asserted "A release-fixer is on it" unconditionally — which is simply
      // false whenever the dispatched fixer died without clearing the red, and that false
      // reassurance is the version of this bug that leaves a gate unowned instead of
      // triple-owned. Same signature derivation as the dispatcher (P-012: sorted failing
      // files, candidate as fallback) so the two cannot key on different things.
      const currentSignature = gateFailureSignature(failingTests, candidate);
      const ownership = describeGateRedOwnership({
        ownerSignature: lastFixer?.signature ?? null,
        currentSignature,
        dispatchedAtMs: lastFixer?.at ?? null,
        spawnId: lastFixer?.spawnId ?? null,
        // Only meaningful for the fixer holding THIS signature; a mismatch short-circuits
        // to 'stale-signature' anyway, so skip the liveness query in that case.
        fixerAlive:
          lastFixer?.signature && lastFixer.signature === currentSignature
            ? await releaseFixerSpawnAlive(sql, lastFixer.spawnId).catch(() => null)
            : null,
        nowMs: Date.now(),
      });
      try {
        const { notifyAttention } = await import('../../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release pipeline STALLED — main frozen',
          // EI-19329732364513693: name the candidate's distance behind tip IN the alert. This is
          // the surface a human actually reads, and a red whose candidate is far behind staging
          // is very often already fixed — saying so here is what stops the chase, rather than
          // leaving each reader to re-derive it (which, overwhelmingly, they do not).
          body: `green-checkpoint has held \`main\` for ${consecutiveReds} consecutive checkpoint(s)${heldHrs != null ? ` (~${heldHrs}h since the last green)` : ''}. Staging changes are NOT reaching the release. ${ownership.label}${
            staleness.commitsBehindTip != null && staleness.commitsBehindTip > 0
              ? ` NOTE: the judged candidate is ${staleness.commitsBehindTip} commit(s) behind staging${staleness.candidateCommittedAt ? `, committed ${staleness.candidateCommittedAt}` : ''} — confirm a named failure still reproduces AT TIP before chasing it.`
              : ''
          }`,
          importance: 'urgent',
          workspaceId: ctx.workspaceId,
          data: {
            consecutiveReds,
            candidate: candidate?.slice(0, 12) ?? null,
            ownership: ownership.state,
            ownerSpawnId: ownership.spawnId,
            candidateCommittedAt: staleness.candidateCommittedAt,
            commitsBehindTip: staleness.commitsBehindTip,
          },
        });
      } catch (e) {
        console.warn(`${orchestratorStdoutTag()} stall alert failed: ${e instanceof Error ? e.message : e}`);
      }
      // P-003: ALSO write a durable harness_escalations row — the silent-stall
      // gap (every other pipeline failure escalates; this one only notified +
      // overwrote metadata). Its own phase, idempotent upsert; fail-safe.
      try {
        await sql.unsafe(
          `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (harness_slug, phase)
           DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
          [
            ctx.installSlug,
            GATE_STALL_PHASE,
            gateStallEscalationBody({
              installSlug: ctx.installSlug,
              consecutiveReds,
              heldHrs,
              candidate,
              failingTests,
              nowMs: Date.now(),
              ownership,
            }),
            Date.now(),
            ctx.workspaceId,
          ],
        );
      } catch (e) {
        console.warn(`${orchestratorStdoutTag()} stall escalation write failed: ${e instanceof Error ? e.message : e}`);
      }
      // P-005: OPEN the `gate-red-streak:<harness>` condition, which is what turns
      // this red into exactly ONE claimable work-item (the condition bridge mints the
      // owner; see condition-bridge.ts's ACTIONABLE_CONDITIONS entry). Deliberately
      // inside the `!stallAlerted` edge with the two writes above, so all three fire
      // once per episode and the condition's lifetime IS the stall's.
      //
      // `oneShot: true` is load-bearing, not decoration (WI-6228): without it the
      // condition-staleness sweep reads this emitter's deliberate silence as recovery
      // and auto-resolves the condition on a timer — closing the owning work-item
      // while the gate is still red, which is worse than never minting one.
      try {
        const { broadcastSevereEvent } = await import('../../severe-event-broadcast');
        const { gateRedStreakConditionKey } = await import('../../coord/gate-ownership');
        const ev = gateRedStreakBroadcast({
          installSlug: ctx.installSlug,
          consecutiveReds,
          heldHrs,
          candidate,
          failingTests,
          ownership,
          commitsBehindTip: staleness.commitsBehindTip,
        });
        await broadcastSevereEvent({
          summary: ev.summary,
          body: ev.body,
          category: 'severe-event',
          conditionKey: gateRedStreakConditionKey(ctx.installSlug),
          oneShot: true,
        });
      } catch (e) {
        console.warn(`${orchestratorStdoutTag()} red-streak condition broadcast failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Seed/carry the pin so the NEXT tick can detect movement (first observation
    // seeds it without resetting; an unchanged pin carries through).
    // EI-7472: PRESERVE the watchdog-owned dedup flag across red ticks. Without
    // this, the whole-object replace below drops `watchdogAlerted` back to absent
    // every hourly red fire, so the green-stall-watchdog re-fires its STALLED
    // severe-event ~hourly for the life of a red streak (it is designed one-shot
    // until recovery). This writer does not own the field — carry it through.
    // EI-7505: persist the failing-verdict-test list into gate_health itself (the
    // green-checkpoint action already parses it — see `failingTests` above — but
    // previously discarded it here, forcing responders to hand-spelunk
    // harness_shared.test_runs during a deploy-freeze, which is inconclusive
    // because that table mixes every agent's local dev-test runs with the verdict
    // run). Persisting it lets the green-stall-watchdog alarm body name the
    // failing test(s) directly, and makes it queryable via
    // `metadata->'gate_health'->'failingTests'` without any log-spelunking.
    // WI-4489: `observedAt`/`observedCandidate` — see the reset path above. This is the branch that
    // MATTERS: a RED is what misdirects (it dispatches the release-fixer at the tests it names), so
    // a red MUST carry the provenance that lets a reader judge whether it is still true.
    // EI-13288: the CLI's own re-triage already re-ran these EXACT named failing files at a
    // newer tip and they PASSED. Persist that evidence only when the refire was actually
    // BLOCKED (`autoRefire === false`). An auto-refiring pass is recorded before recursion so
    // a crashed refire still leaves a verdict, but it is an intermediate verdict — writing its
    // stale-cap fields would make gate-verdict-freshness claim "the auto-refire cap was reached"
    // while the rescue is still running (EI-20243738214569472). Missing autoRefire is treated as
    // unknown for this safety-critical field: an old CLI cannot prove the cap was reached.
    // (`retriageStale` / `retriageBlocked` are computed once above the branch — the
    // not-green reset arm records the same provenance, so they cannot be allowed to drift.)
    next = {
      consecutiveReds,
      lastGreenAt,
      firstRedAt,
      stallAlerted,
      // EI-20706962612084953: the explicit verdict marker. Every write path states it, so a
      // reader never has to infer green-ness from a side-effect field like `lastGreenAt`.
      lastVerdict: 'not-green',
      lastFrom: fromPin ?? gh.lastFrom ?? null,
      // EI-20706962612084953: a red leaves `main` exactly where it found it.
      lastMainPin: mainPinAfterRun,
      // EI-20571364274022293 — the PROVENANCE of the line above, and the only ordering evidence
      // this blob carries about the pin. `fromPin ?? gh.lastFrom` silently carries the PREVIOUS
      // pin forward whenever this run could not resolve the live one (a broken/orphaned release
      // worktree does exactly that), after which `lastFrom` is no longer "the pin at verdict
      // time" — it is "the pin the last time anyone could read one". A reader comparing it to the
      // live pin then sees a difference that may predate the red by hours and concludes, wrongly,
      // that the gate greened. Recording WHICH of the two branches produced the value is what
      // lets `evaluateGateVerdictFreshness` tell hard proof from a coincidence of two shas.
      lastFromFresh: fromPin != null,
      watchdogAlerted: gh.watchdogAlerted ?? false,
      failingTests: (failingTests ?? []).slice(0, 20),
      observedAt: Date.now(),
      observedCandidate: candidate?.slice(0, 12) ?? null,
      retriageStaleTip: retriageBlocked ? (retriage!.tip?.slice(0, 12) ?? null) : null,
      retriageDetail: retriageBlocked ? retriage!.detail : null,
      // WI-7482: the two fields above are stale-ONLY by design (paired + cleared together, per
      // the note above), which left a reader unable to distinguish the three non-stale outcomes:
      // the gate re-ran the red at tip and it genuinely reproduced (`real-red`); the gate could
      // not check at all (`unknown` — no tip, no runnable file, no runner wired); or no verdict
      // was recorded whatsoever (`null`). All three previously presented IDENTICALLY here, as
      // `retriageDetail: null` — which reads as "the gate never looked" and is wrong in two of
      // the three cases. That misreading is not hypothetical: it produced three separate wrong
      // reconstructions on 2026-08-02/03 (EI-19388705187359206 — filed against the parser, then
      // retracted; EI-19389700122825304; and this item's own first diagnosis).
      //
      // Deliberately ADDITIVE: the stale pair keeps its exact semantics and its consumers
      // (git-pipeline-stats, gate-verdict-freshness Rule 3) are untouched. This carries only the
      // machine-readable classification; the human-readable "why" for the non-stale cases now
      // lands in the persisted verdict log (green-checkpoint.ts, the re-triage append).
      retriageClassification: retriage?.classification ?? null,
      // EI-19329732364513693: this is the branch that MATTERS. A red names failing tests and
      // BOTH agents and the release-fixer dispatcher act on those names, so a red must carry
      // enough provenance for a reader to judge whether it is still true of the tree.
      candidateCommittedAt: staleness.candidateCommittedAt,
      commitsBehindTip: staleness.commitsBehindTip,
      // EI-19405864032365760: a real verdict supersedes any recorded preflight abort — see the
      // reset branch above for why this is explicit rather than left to the whole-key replace.
      inconclusive: null,
    };
  }
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug, JSON.stringify({ gate_health: next })],
  );
}

/** P-009 thresholds: a workspace that has flaked this often is "chronically
 *  flaky"; re-notify at most once a day per workspace. */
// P-016: CHRONIC-FLAKE thresholds are runtime-settable — see releaseCheckpointConfig().

/**
 * P-009: per-workspace flake history. The affected-tests runner prints
 * `>>> <ws> passed on retry — counted as a FLAKE` when a workspace FAILED then
 * PASSED on the gate's single retry — an EXPLICIT, PROVEN flake. A real
 * regression fails twice and never gets this marker, so tallying these respects
 * this plan's D-002 (classify before acting) + D-004 (a regression still holds
 * main). We accumulate the counts per workspace in the green-checkpoint routine
 * metadata (`flake_history`), surface them on the Git tab via
 * gitPipelineSnapshot().gate.flakyWorkspaces, and notify ONCE (per cooldown) when
 * a workspace becomes chronically flaky so it gets quarantined accountably — the
 * lock-respecting `quarantine.txt` edit + de-quarantine follow-up are the
 * release-fixer's / a human's job (D-003), never a tracked-file write from this
 * routine. Fail-safe — the routine tick never depends on it.
 */
async function trackFlakeHistory(
  ctx: SystemActionCtx,
  summary?: string,
  flakeSuspects?: string[],
): Promise<void> {
  const flaked = new Set<string>();
  if (summary) {
    for (const m of summary.matchAll(/>>>\s+(\S+)\s+passed on retry — counted as a FLAKE/g)) {
      flaked.add(m[1]);
    }
  }
  // load-flake-isolation-2026-06-23: the per-file flakes the isolation pass absorbed
  // are PROVEN flakes too (failed under the gate's load, passed in an isolated re-run),
  // keyed by `<ws>::<file>` so the ledger distinguishes a chronically-flaky FILE from a
  // chronically-flaky workspace.
  for (const f of flakeSuspects ?? []) flaked.add(f);
  if (flaked.size === 0) return;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'flake_history' AS fh FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ fh: Record<string, { flakes?: number; lastFlakeAt?: number; notifiedAt?: number }> | null }>;
  const fh = rows[0]?.fh ?? {};
  const now = Date.now();
  const newlyChronic: string[] = [];
  for (const ws of flaked) {
    const prev = fh[ws] ?? {};
    const flakes = (prev.flakes ?? 0) + 1;
    let notifiedAt = prev.notifiedAt;
    if (flakes >= releaseCheckpointConfig().chronicFlakeCount && (notifiedAt == null || now - notifiedAt > releaseCheckpointConfig().flakeNotifyCooldownMs)) {
      newlyChronic.push(ws);
      notifiedAt = now;
    }
    fh[ws] = { flakes, lastFlakeAt: now, notifiedAt };
  }
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug, JSON.stringify({ flake_history: fh })],
  );
  if (newlyChronic.length > 0) {
    try {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'intervention',
        title: 'Chronically-flaky test(s) in the release gate',
        body: `${newlyChronic.join(', ')} has flaked ≥${releaseCheckpointConfig().chronicFlakeCount}× in the green-checkpoint suite (failed then passed on retry). Quarantine it accountably (quarantine.txt + a de-quarantine follow-up) so it stops risking gate stalls.`,
        importance: 'high',
        workspaceId: ctx.workspaceId,
        data: { workspaces: newlyChronic.join(',') },
      });
    } catch (e) {
      console.warn(`${orchestratorStdoutTag()} flake notify failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Persisted release-fixer dedup record (green-checkpoint routine metadata `last_fixer`). */
export interface ReleaseFixerRecord {
  /** Stable failure signature (sorted failing test files) — dedup key across candidates. */
  signature?: string;
  candidate?: string;
  /** When the fixer was last dispatched for this signature (epoch ms). */
  at?: number;
  /** The dispatched fixer's spawn id (fire-and-forget path) — null on the DBOS-durable
   *  path (which re-fires on crash itself) or a legacy record predating this field.
   *  THE signal P-014/D-009 added: the id we check liveness against. */
  spawnId?: string | null;
  runId?: string | null;
  /** When the human was last notified for this signature (notify cooldown, separate from dispatch). */
  notifiedAt?: number;
}

/**
 * EI-8740: should a held (`not-green`/`advanced-prefix`) gate verdict dispatch a
 * release-fixer at all?
 *
 * P-016 (D-010): on 'advanced-prefix' the longest-green PREFIX was promoted but the
 * batch TIP is still red — `candidate` is that red tip + `failingTests` its failures,
 * so the fixer dispatch is identical to a full hold (it must still fix the red tip).
 *
 * A verdict with an EMPTY `failingTests` means there is no failing TEST to fix —
 * either a setup/tooling failure before any test ran (e.g. a pot with a `package.json`
 * but no `test:affected` script — "Missing script", distinct from the no-`package.json`
 * case EI-8744 already flips to vacuously-green) or a phantom candidate from a stalled
 * advance. A release-fixer's contract is to fix a failing test; dispatching it with
 * nothing to reproduce is a guaranteed no-op that only classifies-and-escalates —
 * observed as hourly wasted-spawn churn on codeless E2E-scaffold pots (dummy-pot-0707,
 * spoon-knife-hive). `trackGateStall` (the caller's sibling step) still fires the
 * human-facing "held too long" alert regardless of this gate, so a genuinely-stuck gate
 * is never silently dropped — this only spares the pointless fixer spawn.
 */
export function shouldDispatchReleaseFixer(
  status: string,
  candidate: string | undefined,
  failingTests: string[] | undefined,
): candidate is string {
  return (status === 'not-green' || status === 'advanced-prefix') && !!candidate && !!failingTests && failingTests.length > 0;
}

export interface ReleaseFixerDecision {
  /** (Re-)dispatch a fixer this tick. */
  dispatch: boolean;
  /** Notify the human this tick (rate-limited separately from dispatch). */
  notify: boolean;
  reason: 'fresh' | 'covered' | 'self-heal';
}

/** The fixer dedup / self-heal window (2h). The signature dedup that was the ONLY
 *  guard before P-014; now the liveness check overrides it for a dead fixer. */
export const RELEASE_FIXER_DEDUP_MS = 2 * 60 * 60_000;

/**
 * PURE dispatch decision (agent-activity-liveness-truth-2026-06-21 P-014 / D-009).
 *
 * The old dedup was purely TIME-based — skip a same-signature re-dispatch for 2h —
 * so a fixer that DIED inside the window left the gate red + UNCOVERED for up to 2h
 * (the 2026-06-21 incident: a dead gate-fix bee mistaken for "actively fixing it").
 * Now liveness-aware: within the window we skip ONLY if the dispatched fixer is
 * still ALIVE; a dead fixer re-dispatches immediately (self-heal). Notify is
 * decided separately (rate-limited) so an hourly self-heal re-dispatch can't spam.
 *
 * @param fixerAlive caller's liveness verdict for the recorded fixer spawn:
 *   `true` = running + fresh heartbeat (covered); `false` = confirmed GONE
 *   (dead / finished / stale heartbeat) → re-dispatch; `null` = UNKNOWN (no spawn
 *   id to check — a DBOS-durable fire that self-recovers, or a legacy record) →
 *   treated as covered within the window, so we never regress to hammering.
 */
export function decideReleaseFixerDispatch(args: {
  lf: ReleaseFixerRecord | null;
  signature: string;
  now: number;
  fixerAlive: boolean | null;
  dedupMs?: number;
  notifyCooldownMs?: number;
}): ReleaseFixerDecision {
  const dedupMs = args.dedupMs ?? RELEASE_FIXER_DEDUP_MS;
  const notifyCooldownMs = args.notifyCooldownMs ?? RELEASE_FIXER_DEDUP_MS;
  const { lf, signature, now } = args;
  const sameRecent =
    !!lf && lf.signature === signature && typeof lf.at === 'number' && now - lf.at < dedupMs;
  if (!sameRecent) {
    // A fresh failure (new signature, or the prior one aged out) — dispatch + notify.
    return { dispatch: true, notify: true, reason: 'fresh' };
  }
  // Same failure within the window: the liveness-aware gate (D-009).
  if (args.fixerAlive !== false) {
    // alive (true) OR unknown (null — durable/legacy) → a fixer is (presumed) on it.
    return { dispatch: false, notify: false, reason: 'covered' };
  }
  // The previously-dispatched fixer is CONFIRMED GONE → self-heal: re-dispatch now.
  // Re-notify only past the notify cooldown so an hourly self-heal doesn't spam.
  const lastNotify = lf.notifiedAt ?? lf.at ?? 0;
  return { dispatch: true, notify: now - lastNotify > notifyCooldownMs, reason: 'self-heal' };
}

/**
 * Re-exported from `../../release/fixer-liveness` — moved there so read-side surfaces (the
 * pipeline snapshot / release:trace) can resolve fixer liveness WITHOUT importing this
 * module, whose `registerSystemAction` calls run at import. Re-exported rather than
 * relocated-and-updated-at-every-callsite so existing importers keep working, and so there
 * stays exactly one definition shared by the dispatcher and the ownership renderer.
 */
export { releaseFixerSpawnAlive };

/**
 * EI-7443: render each CURRENTLY-failing test file's 7d flake stats (from
 * `flagFlakeSuspects`) as a one-line-per-file annotation the release-fixer's
 * kickoff can lead with — so it sees flake-vs-regression immediately instead of
 * re-deriving it from scratch. Pure (no PG) so it's unit-testable without a live
 * DB; the DB round-trip (`testFlakeRollup`) lives in the thin caller below.
 * Returns undefined when no failing file matches a flagged suspect (the common
 * case — most gate reds ARE real regressions, not flakes) so callers can skip
 * the annotation entirely rather than append an empty section.
 */
export function annotateFailingTestsWithFlakeStats(
  failingTests: string[] | undefined,
  suspects: FlakeSuspect[],
): string | undefined {
  if (!failingTests?.length || !suspects.length) return undefined;
  const byFile = new Map(suspects.map((s) => [s.file_path, s]));
  const lines = failingTests
    .map((f) => byFile.get(f))
    .filter((s): s is FlakeSuspect => !!s)
    .map((s) => `  - ${s.file_path}: ${s.fails}F/${s.passes}P over 7d, ${s.both_status_shas} commit(s) with both a pass and a fail (flake_rate=${s.flake_rate})`);
  if (lines.length === 0) return undefined;
  return (
    `FLAKE SIGNAL (EI-7443, from the last 7d of harness_shared.test_runs — check this BEFORE assuming a regression):\n` +
    lines.join('\n')
  );
}

/** Result of a `git` invocation used only for the stale-candidate re-verify guard below —
 *  `ok` mirrors a zero exit code; `stdout` is trimmed. Never throws. */
export interface GitCheckResult {
  ok: boolean;
  stdout: string;
}

/** Injectable git runner (test seam) for {@link checkReleaseFixerCandidateStale}. Reuses
 *  the ALREADY-imported/mocked `spawn` (this file's tests mock `node:child_process` with
 *  only `spawn`) rather than pulling in `execFile`, so the default path stays exercisable
 *  under the existing test mock without widening it. */
export type GitCheckRunner = (root: string, args: string[]) => Promise<GitCheckResult>;

const defaultGitCheckRunner: GitCheckRunner = (root, args) =>
  new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn('git', ['-C', root, ...args]);
      child.stdout?.on('data', (d) => (out += d.toString()));
      child.on('error', () => resolve({ ok: false, stdout: '' }));
      child.on('close', (code) => resolve({ ok: code === 0, stdout: out.trim() }));
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });

/** Live re-verify inputs for {@link isStaleReleaseFixerCandidate} — see that function for
 *  the semantics of each flag. */
export interface ReleaseFixerCandidateStaleCheck {
  candidateExists: boolean;
  candidatePromoted: boolean;
}

/**
 * EI-8718: is `candidate` still worth dispatching a release-fixer for, RIGHT NOW — or has
 * it gone stale since the checkpoint run that reported it red? A long suite run (up to
 * 120min, per GREEN_CHECKPOINT_SUITE_TIMEOUT_MS) can finish red for a candidate the gate
 * has since moved past by other means (a later run, a manual force, GC) — dispatching a
 * fixer for it is then a guaranteed wasted spawn with nothing left to fix (observed:
 * candidate 2e7f9d7 present in no tree, gate green + promoted, 2 fixers dispatched for it).
 *
 * Checks BOTH:
 *  - `candidateExists` — `git cat-file -e <sha>^{commit}` in the integration checkout.
 *    False means the object was superseded and GC'd — definitely nothing to fix.
 *  - `candidatePromoted` — `candidate` is already reachable from `origin/main` HEAD (i.e.
 *    `origin/main` fast-forwarded PAST it). Only a green-verified commit ever reaches
 *    `origin/main`, so if `candidate` is an ancestor-or-equal of it, the gate already
 *    resolved this candidate to green by other means — nothing left to fix.
 *
 * Read-only (no `git fetch`) — reads the already-fetched `origin/main` ref, same
 * invariant as git-pipeline-position.ts's refContains.
 *
 * Deliberately does NOT suppress a genuinely still-red, not-yet-promoted candidate: a
 * valid object that `origin/main` does not yet contain is exactly the legitimate-dispatch
 * case (the CRITICAL danger the prior needs-human STOP flagged — never freeze the fixer
 * path on an actually-red gate).
 */
export function isStaleReleaseFixerCandidate(check: ReleaseFixerCandidateStaleCheck): boolean {
  return !check.candidateExists || check.candidatePromoted;
}

/** Live-compute {@link ReleaseFixerCandidateStaleCheck} for `candidate` in `root`. */
export async function checkReleaseFixerCandidateStale(
  root: string,
  candidate: string,
  runner: GitCheckRunner = defaultGitCheckRunner,
): Promise<ReleaseFixerCandidateStaleCheck> {
  const exists = await runner(root, ['cat-file', '-e', `${candidate}^{commit}`]);
  const candidateExists = exists.ok;
  if (!candidateExists) return { candidateExists, candidatePromoted: false };
  // `origin/main..<candidate>` lists commits reachable from candidate but not from
  // origin/main; a count of 0 means origin/main's history already contains candidate.
  const ahead = await runner(root, ['rev-list', '--count', `origin/main..${candidate}`]);
  const candidatePromoted = ahead.ok && ahead.stdout === '0';
  return { candidateExists, candidatePromoted };
}

/** EI-19329732364513693: how OLD is the candidate a verdict judged, and how far behind tip?
 *  See {@link measureCandidateStaleness} for why a verdict that omits this misleads. */
export interface CandidateStaleness {
  /** ISO-8601 commit time of the candidate; null when unreadable (GC'd sha, git error). */
  candidateCommittedAt: string | null;
  /** Commits on `staging` the candidate does NOT contain; null when unreadable. */
  commitsBehindTip: number | null;
}

/**
 * EI-19329732364513693: measure the candidate's AGE and DISTANCE BEHIND TIP, so a recorded
 * verdict can disclose them.
 *
 * Why this exists. The quiet-cut picks a candidate by waiting for a window with no recent
 * commits, so on a continuously-busy tree it can reach arbitrarily far back. What then makes
 * that candidate *fail* is not age as such — it is that git-sync commits the WHOLE tree on a
 * timer, so a refactor whose component edit and test edit are minutes-to-hours apart is
 * committed as a broken intermediate, and that intermediate is eligible to be judged.
 * Measured 2026-08-02: five failures across two consecutive reds, every one already green at
 * tip, with component→test skew windows of 34min, 2h11m, and (for the run fired 11:15:03Z) a
 * fix that landed 39 SECONDS after the candidate was cut.
 *
 * A red verdict names failing tests, and both agents and the release-fixer dispatcher act on
 * those names. Nothing in the log header, the broadcast, or `gate_health` said how old the
 * candidate was, so responders re-derived it by hand or — far more often — did not, and
 * chased failures that had been fixed hours earlier. Persisting these two numbers makes a
 * stale red self-defusing: "candidate is N commits / Xh behind tip" ends the chase at the
 * source instead of costing each reader the same rediscovery.
 *
 * Read-only and FAIL-SAFE: any git error yields nulls rather than throwing, because
 * `trackGateStall` must never fail a routine tick for want of a diagnostic.
 */
export async function measureCandidateStaleness(
  root: string,
  candidate: string,
  runner: GitCheckRunner = defaultGitCheckRunner,
): Promise<CandidateStaleness> {
  const committed = await runner(root, ['log', '-1', '--format=%cI', candidate]);
  // `<candidate>..staging` counts commits reachable from staging but NOT from the candidate —
  // i.e. exactly how far the tree moved on past what this verdict judged.
  const behind = await runner(root, ['rev-list', '--count', `${candidate}..staging`]);
  const parsedBehind = behind.ok ? Number.parseInt(behind.stdout, 10) : Number.NaN;
  return {
    candidateCommittedAt: committed.ok && committed.stdout ? committed.stdout : null,
    commitsBehindTip: Number.isFinite(parsedBehind) ? parsedBehind : null,
  };
}

/**
 * P-006 + P-014: dispatch a release-fixer agent for a held (not-green) gate,
 * mirroring git-sync's merge-resolver. Fires the `release-fix` launch blueprint
 * from the `green-checkpoint:red` trigger via fireLaunchBlueprintForEvent — the
 * canonical, spawn-RECORDING, DBOS-DURABLE fire path the P-007 test already
 * exercises (replacing the old raw fire-and-forget loopbackFetch that recorded no
 * spawn + lost the fixer on a crash). Deduped per red-candidate via the
 * green-checkpoint routine metadata (`last_fixer`) — now LIVENESS-AWARE (D-009): a
 * dead fixer no longer blocks re-dispatch for 2h (the 2026-06-21 incident class).
 * EI-8718: re-verifies the candidate isn't STALE (superseded+GC'd, or already
 * promoted past by other means) before paying for a dedup-slot write + fixer spawn.
 * Fail-safe: every step is best-effort and never throws into the routine tick.
 *
 * EI-13723: takes the plain `GateVerdictTarget` (installSlug + workspaceId) rather than the
 * routine-only `SystemActionCtx` — the only two fields this function reads — so
 * `recordCheckpointVerdict` (callable from the CLI itself, which has no `SystemActionCtx`) can
 * call it directly. A `SystemActionCtx` still satisfies this structurally at every existing
 * call site.
 */
async function dispatchReleaseFixer(ctx: GateVerdictTarget, candidate: string, failingTests?: string[]): Promise<void> {
  // EI-8718: cheap re-verify BEFORE touching dedup state — a candidate that's gone stale
  // between the checkpoint run reporting it and this dispatch call gets a no-op skip
  // instead of a wasted fixer spawn. Best-effort: a check failure (e.g. no repo at
  // integrationRoot(), transient git error) treats the candidate as NOT stale (fails open
  // to the pre-existing dispatch behavior) rather than silently swallowing a real red gate.
  const fixerRoot = integrationRootForDiagnostic();
  const staleCheck: ReleaseFixerCandidateStaleCheck = fixerRoot
    ? await checkReleaseFixerCandidateStale(fixerRoot, candidate).catch(
        () => ({ candidateExists: true, candidatePromoted: false }) satisfies ReleaseFixerCandidateStaleCheck,
      )
    : { candidateExists: true, candidatePromoted: false };
  if (isStaleReleaseFixerCandidate(staleCheck)) {
    console.log(
      `${orchestratorStdoutTag()} release-fixer dispatch skipped for ${candidate.slice(0, 8)}: stale candidate ` +
        `(exists=${staleCheck.candidateExists}, promoted=${staleCheck.candidatePromoted}) — gate already resolved`,
    );
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'release-fixer-skipped-stale',
      detail: {
        candidate: candidate.slice(0, 12),
        candidateExists: staleCheck.candidateExists,
        candidatePromoted: staleCheck.candidatePromoted,
      },
    }).catch(() => {});
    return;
  }

  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // P-012: dedup by the FAILURE SIGNATURE (the failing test files / workspaces), not the
  // candidate sha. While the gate stays red, staging advances hourly so every checkpoint
  // is a NEW candidate — keying on sha re-notified the human + re-spawned a fixer every
  // hour for the SAME failure. The signature is stable across candidates; only a CHANGED
  // failure set re-dispatches. Falls back to the candidate sha when none was extracted.
  // `candidate` is non-null here, so the shared helper's null case is unreachable — the
  // `?? candidate` keeps that provable to the type checker rather than widening `signature`.
  const signature = gateFailureSignature(failingTests, candidate) ?? candidate;
  const rows = (await sql.unsafe(
    `SELECT metadata->'last_fixer' AS lf FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ lf: ReleaseFixerRecord | null }>;
  const lf = rows[0]?.lf ?? null;

  // D-009 liveness-aware dedup: within the window, skip ONLY if the previously-
  // dispatched fixer is still alive. A dead/finished fixer re-dispatches now.
  const sameSignature = !!lf && lf.signature === signature;
  const fixerAlive = sameSignature ? await releaseFixerSpawnAlive(sql, lf?.spawnId) : null;
  const now = Date.now();
  const decision = decideReleaseFixerDispatch({ lf, signature, now, fixerAlive });
  if (!decision.dispatch) return; // a live fixer is covering this gate — the good dedup

  // Claim the dedup slot BEFORE firing (anti double-fire across ticks): a concurrent
  // tick now sees a fresh `at` with no spawn id → fixerAlive=null → covered → skips.
  // The spawn id is patched in after the fire below.
  const notifiedAt = decision.notify ? now : (lf?.notifiedAt ?? null);
  const writeRecord = (rec: ReleaseFixerRecord): Promise<unknown> =>
    sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
      [ctx.installSlug, JSON.stringify({ last_fixer: rec })],
    );
  await writeRecord({ signature, candidate, at: now, spawnId: null, runId: null, notifiedAt: notifiedAt ?? undefined });

  // P-003: a user-facing notification (native OS notification on desktop, mobile push).
  // Rate-limited by decision.notify so an hourly self-heal re-dispatch doesn't spam.
  if (decision.notify) {
    try {
      const { notifyAttention } = await import('../../attention-notify');
      const selfHeal = decision.reason === 'self-heal';
      await notifyAttention({
        kind: 'intervention',
        title: selfHeal ? 'Release gate still held — prior fixer died, re-dispatched' : 'Release gate held — staging→main blocked',
        body:
          `green-checkpoint couldn't promote candidate ${candidate.slice(0, 8)} (gate red${failingTests && failingTests.length > 0 ? `: ${failingTests.slice(0, 5).join(', ')}` : ''}); ` +
          `${selfHeal ? 'the previous release-fixer ended without clearing it — a fresh one was' : 'a release-fixer was'} dispatched to diagnose it.`,
        importance: 'high',
        workspaceId: ctx.workspaceId,
        data: { candidate: candidate.slice(0, 12), failing: (failingTests ?? []).slice(0, 10).join(','), selfHeal: String(selfHeal) },
      });
    } catch (e) {
      console.warn(`${orchestratorStdoutTag()} release-red notify failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // EI-7443: best-effort flake annotation for the CURRENTLY-failing files, from the
  // 7d harness_shared.test_runs rollup — never blocks/fails the dispatch (a rollup
  // hiccup just means no annotation, same as today).
  let flakeAnnotation: string | undefined;
  try {
    const { testFlakeRollup, flagFlakeSuspects } = await import('../../dev-data');
    const { entries } = await testFlakeRollup(7);
    flakeAnnotation = annotateFailingTestsWithFlakeStats(failingTests, flagFlakeSuspects(entries, 7));
  } catch (e) {
    console.warn(`${orchestratorStdoutTag()} flake-suspect annotation skipped (non-fatal): ${e instanceof Error ? e.message : e}`);
  }

  // P-006/P-014: fire the release-fixer via the canonical spawn-recording, DBOS-durable
  // path (fireLaunchBlueprintForEvent) so the fixer is liveness-trackable + survives a crash.
  const { fireLaunchBlueprintForEvent } = await import('../../blueprint/launch-blueprint');
  let fired: Awaited<ReturnType<typeof fireLaunchBlueprintForEvent>> = null;
  try {
    fired = await fireLaunchBlueprintForEvent('green-checkpoint:red', {
      installSlug: ctx.installSlug,
      workspaceId: ctx.workspaceId,
      kickoff:
        `green-checkpoint held \`main\`: candidate ${candidate.slice(0, 8)} failed the gate suite. Read the newest ~/.papercusp/checkpoint-logs/*.log, reproduce the failing test(s) locally to classify regression-vs-flake, then fix the code or de-flake (hermetic > tier-out > accountable quarantine). Do NOT push — the next checkpoint re-verifies.` +
        (flakeAnnotation ? `\n\n${flakeAnnotation}` : ''),
      extra: ['--green-checkpoint-red', JSON.stringify({ candidate })],
      bodyExtra: {
        releaseFixerContext: {
          candidate: candidate.slice(0, 12),
          failingTests: (failingTests ?? []).slice(0, 20),
        },
      },
      // P-010: the fixer's reproduce→classify→fix loop (maxTurns 30) needs far more than
      // the old 280s; the invoke-route ceiling is 1200s. 900s. The liveness-aware dedup
      // re-dispatches promptly if this fixer dies, so a long timeout is no longer a 2h gap.
      timeoutMs: 900_000,
    });
  } catch (e) {
    console.warn(`${orchestratorStdoutTag()} release-fixer fire failed: ${e instanceof Error ? e.message : e}`);
  }
  // Patch the recorded fixer's spawn id so the NEXT tick can check ITS liveness (D-009).
  const spawnId = fired?.spawn?.spawnId ?? null;
  const runId = fired?.spawn?.runId ?? null;
  if (spawnId || runId) {
    await writeRecord({ signature, candidate, at: now, spawnId, runId, notifiedAt: notifiedAt ?? undefined }).catch(() => {});
  }
  await appendPipelineEvent({
    workspaceId: ctx.workspaceId,
    installSlug: ctx.installSlug,
    kind: 'release_fixer',
    status: fired ? 'ok' : 'failed',
    detail: { candidate: candidate.slice(0, 12), reason: decision.reason, spawnId: spawnId ?? undefined },
  }).catch(() => {});
}

/** The fixed transient-unit name for the detached auto-deploy — fixed on
 *  purpose: systemd-run refuses a second unit with the same name while one is
 *  active, which is exactly the dedup we want across trigger ticks. */
export const AUTO_DEPLOY_UNIT = RELEASE_DEPLOY_UNIT;

/** The subset of the deploy plan (deploy.ts `DeployPlan`, emitted as JSON by
 *  `deploy-cli`) that the auto-serve gate reads. */
export interface AutoServePlan {
  targetSha?: string;
  currentReleaseSha?: string | null;
  isFastForward?: boolean;
  commits?: string[];
  noop?: boolean;
  /** Every changed path in this plan is the papercusp-desktop submodule gitlink — a
   *  shell-only pointer bump the operator deploy must skip (desktop-submodule-of-
   *  papercup-2026-06-09 D-003). Set by gatherPlan; absent on old plan JSON. */
  desktopOnly?: boolean;
}

/**
 * Auto-serve policy — may the unattended release-trigger deploy this plan?
 *
 * The trigger may ONLY advance the release checkout **forward** to a green
 * `main` that brings ≥1 NEW commit via a fast-forward (or perform the first
 * deploy, when the checkout isn't set up yet). It must NEVER act on a
 * zero-new-commit plan.
 *
 * Why this guard exists (root-caused 2026-06-07): the *detached* release
 * checkout can transiently sit AHEAD of green `main` — a
 * `chore(git-sync): auto-commit` lands in it during a deploy / green-checkpoint
 * race — so `currentReleaseSha !== targetSha` (the old `noop` SHA-equality test
 * is false) while `commits` is empty and `isFastForward` is false. The old gate
 * (`if (plan.noop) return`) missed exactly this case and redeployed a plan that
 * applies ZERO commits, which reverts the checkout BACKWARD; the next git-sync
 * tick re-advances it → an infinite redeploy storm, each iteration
 * HARD-RESTARTING the `:3070` operator and dropping in-flight MCP/HTTP requests.
 * Forward-only + non-empty + fast-forward is the structural fix. A
 * backward / lateral / non-FF move is a deliberate rollback (`rollback.ts`) or a
 * reviewed forced deploy (`deploy-cli --force`), never auto-serve.
 *
 * Also skips a DESKTOP-ONLY pointer bump (desktop-submodule-of-papercup-2026-06-09
 * D-003): once papercusp-desktop is a submodule, every desktop edit bumps the
 * superproject `papercusp-desktop` gitlink → FFs onto green `main`. Without this guard
 * a shell-only change would drain + restart the live `:3070` operator (which never
 * builds or uses the desktop). A forced/manual `deploy-cli --execute` still can.
 */
export function shouldAutoServe(plan: AutoServePlan): boolean {
  // First deploy — the release checkout isn't set up yet → establish it.
  if (plan.currentReleaseSha === null) return true;
  // Malformed/absent field → conservative: don't deploy.
  if (typeof plan.currentReleaseSha !== 'string') return false;
  if (plan.noop === true) return false;
  // D-003: a desktop-only pointer bump doesn't touch the operator — don't
  // auto-redeploy :3070 for a shell-only change.
  if (plan.desktopOnly === true) return false;
  // Forward-only: a genuine fast-forward bringing ≥1 NEW commit. A 0-commit or
  // non-FF plan means the checkout is AT or AHEAD of `main` → never redeploy.
  return plan.isFastForward === true && Array.isArray(plan.commits) && plan.commits.length > 0;
}

/** P-013 back-off window: how long after a failed/rolled-back deploy of a target we
 *  refuse to re-attempt the SAME target. */
const DEPLOY_BACKOFF_MS = 60 * 60_000;

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface DeployEventRow {
  status: string;
  detail: Record<string, unknown> | string | null;
  created_at: Date | string;
}

/**
 * P-013 pure decision: given the MOST-RECENT deploy event, should we skip re-attempting
 * `targetSha`? A deploy that fails/rolls-back reverts the release checkout BACKWARD, so
 * the next 15-min trigger sees green `main` still ahead and redeploys the SAME broken
 * target — draining + restarting :3070 every tick (2026-06-09 13:31–14:00: three
 * rolled-back retries of one broken green). True iff that event was a failure/rollback of
 * the SAME target within DEPLOY_BACKOFF_MS of `nowMs`. A new green (different sha) or the
 * window elapsing clears the back-off. Exported for unit testing.
 */
export function shouldBackOff(latest: DeployEventRow | null, targetSha: string, nowMs: number, backoffMs: number = DEPLOY_BACKOFF_MS): boolean {
  if (!latest || (latest.status !== 'failed' && latest.status !== 'rolled-back')) return false;
  const detail = typeof latest.detail === 'string' ? safeJson(latest.detail) : latest.detail ?? {};
  const lastTarget = String((detail as Record<string, unknown>).targetSha ?? ''); // stored sliced(0,12)
  const ageMs = nowMs - new Date(latest.created_at).getTime();
  return lastTarget.length > 0 && targetSha.startsWith(lastTarget) && ageMs < backoffMs;
}

/** DB glue over shouldBackOff — reads the latest deploy event; never blocks a deploy on a
 *  stats-read failure (fail-open). */
async function recentDeployFailedFor(slug: string, targetSha: string): Promise<boolean> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT status, detail, created_at FROM harness_shared.pipeline_events
        WHERE install_slug = $1 AND kind = 'deploy'
        ORDER BY created_at DESC LIMIT 1`,
      [slug],
    )) as DeployEventRow[];
    return shouldBackOff(rows[0] ?? null, targetSha, Date.now(), releaseCheckpointConfig().deployBackoffMs);
  } catch {
    return false;
  }
}

/**
 * system:release-trigger — AUTO-SERVE (staging-branch-pipeline-2026-06-06 D-002):
 * when green `main` is ahead of what the operator runs, launch the SCRIPTED
 * deploy. The green gate is the go/no-go; deploy-cli's mechanics carry drain +
 * snapshot + migrate + restart + health-check + auto-rollback, and deploy.ts
 * records the `deploy` pipeline event itself.
 *
 * The deploy is launched as a DETACHED transient systemd unit, NOT a child of
 * this host: the deploy restarts the very host this routine runs in, so a child
 * deploy-cli dies at its own restart step — the 2026-06-06 10:31 auto-deploy
 * lost its health probe, AUTO-ROLLBACK, broadcast and event exactly that way
 * (swap+migrate land before restart, which is why it half-worked). A transient
 * unit survives the restart and completes the whole lifecycle.
 */
registerSystemAction('release-trigger', async (ctx: SystemActionCtx) => {
  // per-hive-git-and-release-gate-2026-06-29 (D-001): per-hive AUTO-DEPLOY (leg 3) is
  // DEFERRED — the systemd unit (AUTO_DEPLOY_UNIT) + health probe below are operator-home-
  // specific. A non-home release-trigger only exists if a hive declared releaseGate.deploy
  // and opted in; guard it to a NO-OP so it can NEVER run the papercusp deploy for another
  // hive. When per-hive deploy lands, resolve a per-hive deploy target here instead.
  const { operatorHomeHarnessSlug } = await import('../operator-home-harness');
  if (ctx.installSlug && ctx.installSlug !== operatorHomeHarnessSlug()) {
    console.warn(
      `[release-trigger] per-hive auto-deploy not yet supported (${ctx.installSlug}) — skipping (leg-3 deferred, D-001)`,
    );
    return;
  }
  const root = integrationRoot();
  const tooling = releaseToolingStatus(root, 'apps/operator/lib/release/deploy-cli.ts');
  if (!tooling.ok) {
    console.warn(`[release-trigger] release tooling unavailable (${tooling.reason}) at ${root} — skipping this tick`);
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'deploy',
      status: 'skipped-no-tooling',
      detail: { reason: tooling.reason, root },
    });
    return;
  }
  // Cheap, side-effect-free: is there anything green to deploy?
  const plan = await runScript(root, 'apps/operator/lib/release/deploy-cli.ts', [], 60_000);
  // P-008: parse the delimited plan marker, not a brace-slice of all stdout.
  const parsedPlan = parseMarkerLine(plan.stdout, DEPLOY_PLAN_MARKER) as { plan?: AutoServePlan } | null;
  if (!parsedPlan) {
    console.warn('[release-trigger] could not parse deploy plan marker — skipping this tick');
    return;
  }
  const planObj: AutoServePlan | null = parsedPlan.plan ?? null;
  // Forward-only auto-serve: only advance to a green `main` that brings ≥1 new
  // commit via a fast-forward (or the first deploy). Skips the
  // checkout-at/ahead-of-main case that previously storm-redeployed :3070 — see
  // `shouldAutoServe`.
  if (!planObj || !shouldAutoServe(planObj)) return;

  // P-013: don't storm-redeploy a target that just failed/rolled-back — wait for a new
  // green (different sha) or the back-off window. This is what stops the every-15-min
  // retry of a broken green from draining + restarting the live operator each tick.
  if (typeof planObj.targetSha === 'string' && (await recentDeployFailedFor(ctx.installSlug, planObj.targetSha))) {
    console.warn(
      `[release-trigger] target ${planObj.targetSha.slice(0, 12)} failed/rolled-back within ${DEPLOY_BACKOFF_MS / 60_000}m — backing off (awaiting a new green or the window)`,
    );
    return;
  }

  const targetSha = typeof planObj.targetSha === 'string' ? planObj.targetSha.slice(0, 12) : '?';
  const commits = Array.isArray(planObj.commits) ? planObj.commits.length : '?';
  console.log(`[release-trigger] green main is ahead — launching detached auto-deploy of ${targetSha} (${commits} commit(s)) as ${AUTO_DEPLOY_UNIT}`);

  // PAPERCUSP_ALLOW_DEV_RESTART=1: the restart step is env-gated against ad-hoc
  // runs restarting the shared host — this routine IS the owner-authorized
  // auto-serve path (D-002), so it self-authorizes. Fire-and-forget: the
  // outcome is reported by deploy.ts (broadcast + pipeline event + awaitable
  // release:deployed/deploy-failed), not by this (about-to-be-restarted) host.
  await new Promise<void>((resolve) => {
    const child = spawn('systemd-run', [
      '--user',
      '--collect',
      `--unit=${AUTO_DEPLOY_UNIT}`,
      `--working-directory=${root}`,
      // EI-193: a transient unit inherits the systemd USER-MANAGER environment,
      // NOT this process's — and after a reboot the manager PATH is the bare
      // default (no linuxbrew/nvm node), so a bare `npx` dies with exit 127
      // and auto-deploy silently stops (observed 2026-06-09: every deploy
      // tick 127'd until a manual `systemctl --user import-environment PATH`).
      // Pass THIS operator's PATH (it found node) + use the absolute tsx bin
      // (same resolution as runScript) so the unit never depends on the
      // manager environment. PATH is still needed: tsx's shebang is
      // `#!/usr/bin/env node`.
      `--setenv=PATH=${process.env.PATH ?? ''}`,
      'bash',
      '-c',
      // P-014: `>` (truncate), not `>>` — each deploy's log is self-contained, so the
      // file can't grow unbounded; the durable record is pipeline_events + the journal.
      buildDeployTerminalShell(
        `PAPERCUSP_ALLOW_DEV_RESTART=1 PAPERCUSP_INTEGRATION_ROOT='${root}' '${tsxBin(root)}' apps/operator/lib/release/deploy-cli.ts --execute > /tmp/${AUTO_DEPLOY_UNIT}.log 2>&1`,
      ),
    ]);
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      console.warn(`[release-trigger] failed to launch ${AUTO_DEPLOY_UNIT}: ${e instanceof Error ? e.message : e}`);
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // Most common cause: the unit already exists = a deploy is in flight.
        console.warn(`[release-trigger] systemd-run exited ${code} (deploy already running?): ${stderr.trim().slice(0, 200)}`);
      }
      resolve();
    });
  });
});
