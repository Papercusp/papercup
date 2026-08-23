/**
 * capability:bash_output — read incremental output from a background shell job
 * started by `capability:bash` (run_in_background). Mirrors the native
 * BashOutput tool: each call returns the output produced SINCE the last read
 * (use `peek` to read without advancing the cursor) plus the job's status.
 * Part of P-010 (`agent-capability-confinement-2026-06-13`).
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  JOB_LOG_END_MARKER_PREFIX,
  JOB_LOG_DIED_MARKER_PREFIX,
  detectBufferingLastStage,
  formatJobLogDiedMarker,
  formatBufferingPipelineAdvice,
  getJob,
  readJobOutput,
  scratchDir,
  type BashStatus,
  type BashJob,
} from './bash-jobs';
import { backgroundTypecheckVerdict } from './background-typecheck-verdict';
import { coresBetween, readCgroupCpuSample, MIN_SAMPLE_GAP_MS } from './cgroup-cpu';
import { getTask, getTaskByBashJobId } from '../../task-manager/store';
import { isTerminalState, serviceUnitForTask, type TaskRow } from '../../task-manager/types';
import { readProcessIdentity } from '../../process-identity';
import { readProcessCgroupPath, readProcessCmdline } from '../../task-manager/cgroup-read';

/**
 * Cap on the spill log we will read whole to classify a dead typecheck. A tsc
 * log is small (apps/operator's 850-diagnostic run is ~200KB), so this only ever
 * trips for something that is not the case we are classifying — and the retained
 * in-memory tail is the safe fallback, since the OOM/abort signature is written
 * LAST.
 */
const MAX_VERDICT_LOG_BYTES = 16 * 1024 * 1024;

/**
 * The full job output, for verdict classification only. Falls back to the
 * retained tail whenever the spill log is unreadable or implausibly large —
 * never throws, because a failure to classify must degrade to "no verdict", not
 * to a failed poll.
 */
function readJobLogForVerdict(job: BashJob): string {
  try {
    if (statSync(job.logPath).size > MAX_VERDICT_LOG_BYTES) return job.buffer;
    return readFileSync(job.logPath, 'utf8');
  } catch {
    return job.buffer;
  }
}

/** Tail this many bytes of a stranded job's log when the in-memory registry
 *  missed but the file survived on disk (EI-8855). */
export const STRANDED_LOG_TAIL_BYTES = 8_000;

/**
 * Keep the full body available for a filtered stranded-log read only while it
 * remains within the same bounded-read ceiling used by verdict inspection. A
 * larger log still gets its tail, but is never loaded wholesale just to apply
 * a caller-supplied regex.
 */
const MAX_STRANDED_LOG_CONTENT_BYTES = MAX_VERDICT_LOG_BYTES;

/**
 * EI-8855: the in-memory job registry (bash-jobs.ts) assumes "the operator is one
 * long-lived process" — false on a shared dev box where a DIFFERENT agent's
 * routine `systemctl --user restart papercup-*-api.service` (a common, documented
 * workflow — see repo-conventions § two-port model) kills the WHOLE service cgroup,
 * wiping every in-flight capability:bash background job's registry entry AND the
 * job's own child process in one shot. The caller then sees a bare "unknown_bash_id"
 * indistinguishable from a typo'd id or a truly-vanished job. Since the log path is
 * DETERMINISTIC from `stateDir` + `bash_id` (no registry needed), we can check
 * whether that file exists on disk even after the in-memory entry is gone, and
 * report the REAL diagnosis (stranded by a restart, not "wrong id") plus the
 * output the job DID produce before it died — instead of a dead end.
 *
 * EI-18666279107998059: also returns the log file's `birthtimeMs` (creation time,
 * a proxy for the job's own start time) so the caller can tell a genuine operator
 * restart apart from the job's OWN process dying independently — see
 * `diagnoseStrandedCause`. */
export type StrandedJobLog = {
  logPath: string;
  sizeBytes: number;
  tail: string;
  /** Full bounded body, present when the spill log fits the read ceiling. */
  content?: string;
  birthtimeMs: number;
};

/** Read only the final bounded tail of a spill log that is too large to retain whole. */
function readStrandedLogTail(logPath: string, sizeBytes: number): string {
  const bytesToRead = Math.min(sizeBytes, STRANDED_LOG_TAIL_BYTES);
  if (bytesToRead <= 0) return '';
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(logPath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < bytesToRead) {
      const read = readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, sizeBytes - bytesToRead + bytesRead);
      if (read === 0) break;
      bytesRead += read;
    }
  } finally {
    closeSync(fd);
  }
  return buffer.subarray(0, bytesRead).toString('utf8');
}

/** Read a known spill-log path without reconstructing it from this worker's stateDir. */
export function strandedJobLookupAtPath(logPath: string): StrandedJobLog | null {
  try {
    const st = statSync(logPath);
    if (!st.isFile()) return null;
    if (st.size <= MAX_STRANDED_LOG_CONTENT_BYTES) {
      const content = readFileSync(logPath, 'utf8');
      const tail = content.length > STRANDED_LOG_TAIL_BYTES ? content.slice(-STRANDED_LOG_TAIL_BYTES) : content;
      return { logPath, sizeBytes: st.size, tail, content, birthtimeMs: st.birthtimeMs };
    }
    return {
      logPath,
      sizeBytes: st.size,
      tail: readStrandedLogTail(logPath, st.size),
      birthtimeMs: st.birthtimeMs,
    };
  } catch {
    return null;
  }
}

export function strandedJobLookup(bashId: string, stateDir: string | undefined): StrandedJobLog | null {
  const logPath = join(scratchDir(stateDir), `bash-${bashId}.log`);
  return strandedJobLookupAtPath(logPath);
}

/**
 * EI-18666279107998059: decide WHICH of the two known causes actually explains a
 * stranded job, instead of asserting the more dramatic one ("the operator
 * restarted") as fact with no evidence check (the EI-16635 bug this superseded —
 * confirmed live: a job's tracking went stranded while `dev:service_health` showed
 * zero restarts, so the true cause was the job's OWN process dying independently).
 *
 * The check is simple and needs no extra I/O: THIS operator process's own
 * `process.uptime()` tells us exactly when it started. If it started AFTER the
 * job's log file was created, the operator must have restarted at some point
 * after the job began running — a restart is CONFIRMED.
 *
 * The other branch is the one that keeps getting mis-stated, so state it
 * precisely: if this process has been running continuously since before the job
 * started, a restart is IMPOSSIBLE (this very process would not exist to answer
 * the call). That rules out ONE cause. It says NOTHING about whether the job's
 * own process is still running — and on this box the overwhelmingly common
 * explanation is a job QUEUED behind pc-heavy's slot clamp, alive and simply not
 * producing output yet. Hence `job_liveness_unknown`, not `job_process_gone`:
 * the token names what this check can establish, which is the absence of one
 * cause, not the presence of a death.
 *
 * That distinction is not cosmetic — the two states have OPPOSITE correct
 * responses (keep waiting vs re-run), and re-running a queued heavy job adds
 * load to the very queue whose depth caused the missing output. Reported four
 * times independently (EI-19304682667917795, EI-19310882583645327,
 * EI-19327967209159644, EI-19332191089874223) before the code was corrected:
 * EI-18666279107998059 fixed the advice PROSE to hedge correctly but left the
 * `reason` field — the one callers branch on — asserting the confirmed-dead
 * token. Prose that contradicts its own status code loses to the status code.
 *
 * `job_process_gone` now has exactly one emitter: the ledger-confirmed terminal
 * state above, which really did observe an exit.
 */
export function diagnoseStrandedCause(opts: {
  jobBirthtimeMs: number;
  /** Defaults to the real `process.uptime()` — injectable for deterministic tests. */
  processUptimeMs?: number;
  /** Defaults to `Date.now()` — injectable for deterministic tests. */
  now?: number;
}): 'stranded_by_operator_restart' | 'job_liveness_unknown' {
  const now = opts.now ?? Date.now();
  const processUptimeMs = opts.processUptimeMs ?? process.uptime() * 1000;
  const processStartedAtMs = now - processUptimeMs;
  return processStartedAtMs > opts.jobBirthtimeMs ? 'stranded_by_operator_restart' : 'job_liveness_unknown';
}

/**
 * EI-18759519171684432: `diagnoseStrandedCause` above only rules out ONE cause (a
 * whole-operator restart) — it was never sound evidence that the job's OWN process
 * actually died, yet the handler asserted exactly that ("CONFIRMED NOT the cause …
 * the job's OWN process died independently") with no process check at all. Live
 * repro: a `test:affected` run was still executing (confirmed via `ps`, log file
 * still growing) while this verdict told the caller to re-run it — doubling the
 * load on an already-loaded box.
 *
 * The durable task-manager ledger (task-manager-no-escape-2026-07-27) is the fix:
 * `startBackground` stamps every job's ledger row with `detail.bashJobId` and its
 * spawned `pid` + `processIdentity` (a boot-id+start-ticks pair immune to PID
 * reuse — D-011), and that row survives exactly the failure that wipes the
 * in-memory JOBS map (an operator restart, or eviction under load). So instead of
 * inferring liveness from operator uptime, RE-PROBE the recorded pid's identity now
 * and compare: if it still matches, the process is CONFIRMED alive regardless of
 * what happened to the in-memory tracking. If the ledger itself already recorded a
 * terminal exit, that is stronger evidence than any heuristic. Only when neither
 * signal is available do we fall back to the uptime heuristic (below).
 */
export type LedgerLivenessVerdict =
  | { kind: 'confirmed_alive'; pid: number; scopeUnit: string | null; taskId: string }
  | {
      kind: 'confirmed_dead';
      state: string;
      exitCode: number | null;
      exitReason: string | null;
      /** Was this job's process running inside its own systemd scope (task-manager
       *  confined) or as a direct, unconfined child of the operator process? See
       *  the advice-building note at the `job_process_gone` handler branch below —
       *  this is what lets the advice explain a `stranded` verdict instead of
       *  reporting it as an unattributed mystery (EI-19315479997523199). */
      confined: boolean;
    }
  | { kind: 'no_ledger_row' }
  | { kind: 'ledger_inconclusive' };

/**
 * `processes:kill` addresses a durable task by taskId. The systemd scope is
 * diagnostic metadata returned by bash_output, not an accepted kill argument.
 */
export function confirmedAliveStopAdvice(): string {
  return 'To stop it, use processes:kill with the taskId below — never a bare kill.';
}

/**
 * Explain a ledger-confirmed stranded job without overstating what confinement
 * guarantees. A `systemd-run --scope` payload is outside the operator service's
 * cgroup, but the `systemd-run` monitor remains the operator's child. A routine
 * :3070/:3170 restart can therefore kill that monitor and end the sibling scope
 * too (EI-20219872509843731, observed across a restart wave on 2026-08-12).
 */
export function strandedJobAdvice(confined: boolean): string {
  return confined
    ? ' This job was CONFINED in its own systemd scope (task-manager), but the current ' +
        '`systemd-run --scope` monitor is still a child of the launching operator. A routine ' +
        ':3070/:3170 restart can end the scope, so confinement is a resource boundary, not a ' +
        'restart-durability guarantee. Check the operator service journal around the scope end ' +
        'time before attributing it to OOM or a manual `processes:kill`.'
    : ' This job was UNCONFINED (task-manager confinement was off, or its probe failed, at the moment ' +
        'it spawned), so it ran as a direct child of the operator process — the far more likely ' +
        'explanation is the routine, documented one: a peer restarted :3070/:3170 mid-job (repo-' +
        'conventions § two-port model) and every OTHER unconfined in-flight background job died with it. ' +
        'Not a bug in your command.';
}

export interface TaskProcessLivenessProbe {
  processIdentity: string | null;
  cgroupPath: string | null;
  cmdline: string;
}

function cmdlineFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function persistedCmdline(row: TaskRow): string {
  return row.argv.join(' ').trim();
}

function probeTaskProcess(pid: number): TaskProcessLivenessProbe {
  return {
    processIdentity: readProcessIdentity(pid),
    cgroupPath: readProcessCgroupPath(pid),
    cmdline: readProcessCmdline(pid),
  };
}

export function diagnoseFromLedger(
  row: TaskRow | null,
  probe: (pid: number) => TaskProcessLivenessProbe = probeTaskProcess,
): LedgerLivenessVerdict {
  if (!row) return { kind: 'no_ledger_row' };
  if (isTerminalState(row.state)) {
    return {
      kind: 'confirmed_dead',
      state: row.state,
      exitCode: row.exitCode ?? null,
      exitReason: row.exitReason ?? null,
      confined: row.confined,
    };
  }
  // pending/running/unaccounted/foreign: the ledger THINKS a process is alive.
  // Re-probe every identity pin before calling a verifier alive. PID identity
  // prevents PID reuse, the dedicated cgroup proves CPU movement belongs to this
  // task rather than a shared worker pool, and the command fingerprint prevents a
  // same-process exec from inheriting the old task's identity. Missing data fails
  // to inconclusive; liveness is never inferred from a partial pin set.
  if (row.pid && row.processIdentity && row.confined && row.scopeUnit && row.cgroupPath && row.argv.length > 0) {
    const now = probe(row.pid);
    const expectedCmdline = persistedCmdline(row);
    if (
      now.processIdentity === row.processIdentity &&
      now.cgroupPath === row.cgroupPath &&
      now.cmdline.length > 0 &&
      cmdlineFingerprint(now.cmdline) === cmdlineFingerprint(expectedCmdline)
    ) {
      return { kind: 'confirmed_alive', pid: row.pid, scopeUnit: row.scopeUnit ?? null, taskId: row.taskId };
    }
  }
  // The kernel disagrees with the ledger's non-terminal state (or we lack enough
  // to re-probe), but we never OBSERVED an exit — asserting death here would be the
  // exact overclaim this fix exists to remove. Let the reconciler (which runs
  // regardless) settle this row to `stranded` in its own time; report honestly that
  // this read could not confirm either way.
  return { kind: 'ledger_inconclusive' };
}

type ScopeActiveExec = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

let scopeExecFile: ScopeActiveExec | null = null;
function runScopeActiveExec(
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr?: string }> {
  if (!scopeExecFile) scopeExecFile = promisify(execFile) as unknown as ScopeActiveExec;
  return scopeExecFile(file, args, options);
}
const LIVE_SCOPE_ACTIVE_STATES = new Set(['active', 'activating', 'reloading', 'deactivating']);

/**
 * Ask the user systemd whether a durable bash-job service is still active.
 *
 * The PID/cgroup identity probe above is the strongest proof when all of its
 * pins are available, but a freshly enrolled scope can briefly have an
 * inconclusive row while its child is already queued behind pc-heavy. The unit
 * name is minted from the task id and is independent of the worker-local JOBS
 * map, PID timing, and cgroup-read races. Only accept the canonical service
 * name for a confined bash-job row; an arbitrary unit must never become a
 * liveness oracle. Failing to query systemd remains inconclusive, never dead.
 */
export async function taskScopeIsActive(
  row: Pick<TaskRow, 'taskId' | 'class' | 'confined' | 'scopeUnit'>,
  execFn: ScopeActiveExec = runScopeActiveExec,
): Promise<boolean> {
  if (
    row.class !== 'bash-job' ||
    !row.confined ||
    !row.scopeUnit
  ) {
    return false;
  }
  try {
    // Keep malformed or legacy rows fail-soft too: a liveness read must never
    // turn bad ledger metadata into a handler exception.
    if (row.scopeUnit !== serviceUnitForTask(row.taskId)) return false;
    const { stdout } = await execFn(
      'systemctl',
      ['--user', 'show', '-p', 'ActiveState', '--value', row.scopeUnit],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
    );
    return LIVE_SCOPE_ACTIVE_STATES.has(stdout.trim());
  } catch {
    return false;
  }
}

/** Max length of an agent-supplied `filter` regex (ReDoS surface bound). */
const MAX_FILTER_LEN = 200;

/**
 * Heuristic for a catastrophic-backtracking (ReDoS) pattern: a quantified GROUP
 * whose body itself contains a quantifier — `(a+)+`, `(.*)*`, `(a{2,})+`, `(.+){8}`.
 * This is the classic nested-quantifier signature; it runs in the shared OPERATOR
 * process, where a hang would block every concurrent agent's MCP calls, so we
 * reject rather than risk it. Approximate (not a full safe-regex analysis) but it
 * covers the common exponential-blowup classes.
 */
function isLikelyCatastrophicRegex(re: string): boolean {
  return /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(re);
}

/**
 * Apply the native-BashOutput `filter` regex to an output chunk: keep only the
 * LINES matching `filter` (the caller advances the cursor over the full chunk
 * regardless, so non-matching lines aren't re-shown). Never throws or hangs: an
 * invalid OR ReDoS-prone OR over-long regex returns the unfiltered chunk plus an
 * `error` note (the filter runs in the shared operator process, so an
 * agent-supplied pattern must not be able to wedge it). Exported pure for
 * deterministic unit testing (no subprocess).
 */
export function filterOutputLines(chunk: string, filter: string | undefined): { output: string; error?: string } {
  if (!filter) return { output: chunk };
  if (filter.length > MAX_FILTER_LEN) {
    return { output: chunk, error: `filter regex too long (>${MAX_FILTER_LEN} chars) — returning unfiltered output` };
  }
  if (isLikelyCatastrophicRegex(filter)) {
    return {
      output: chunk,
      error: 'filter regex rejected (ReDoS-prone nested quantifier) — returning unfiltered output',
    };
  }
  try {
    const re = new RegExp(filter);
    return {
      output: chunk
        .split('\n')
        .filter((line) => re.test(line))
        .join('\n'),
    };
  } catch (err) {
    return {
      output: chunk,
      error: `invalid filter regex (${err instanceof Error ? err.message : String(err)}) — returning unfiltered output`,
    };
  }
}

type RecoveredJobStatus = Exclude<BashStatus, 'running'>;

/** Translate a terminal task-ledger row into the normal BashOutput status shape. */
export function terminalStatusFromLedger(
  row: TaskRow | null,
): { status: RecoveredJobStatus; exitCode: number | null } | null {
  if (!row || !isTerminalState(row.state)) return null;
  switch (row.state) {
    case 'exited':
      return { status: row.exitCode === 0 ? 'completed' : 'failed', exitCode: row.exitCode ?? null };
    case 'killed':
      return { status: 'killed', exitCode: row.exitCode ?? null };
    case 'timed_out':
      return { status: 'timed_out', exitCode: row.exitCode ?? null };
    case 'stranded':
    case 'ended_unobserved':
      // These states prove the task is over but deliberately carry no trustworthy
      // shell exit code. Preserve the error path instead of manufacturing success.
      return { status: 'failed', exitCode: row.exitCode ?? null };
    default:
      return null;
  }
}

export interface StrandedJobLogInspection {
  terminal: { status: RecoveredJobStatus; exitCode: number | null } | null;
  /** A ledger-confirmed unobserved terminal marker appended by recovery. */
  died?: { status: 'failed'; state: string; exitCode: number | null };
  output: string;
  filterError?: string;
}

// The marker is written only after the child reaches a terminal state and the
// spill stream is flushed. It is therefore the durable completion evidence for
// a job whose in-memory BashJob entry was lost, even when the task ledger has not
// observed the close yet. Anchor at the start of a line so ordinary command
// output containing the marker prefix cannot become a false terminal verdict.
const JOB_LOG_END_MARKER_RE = new RegExp(
  '^' +
    JOB_LOG_END_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    ': status=(completed|failed|killed|timed_out) exit=(null|-?\\d+) at [^\\n]*(?:\\n|$)',
  'm',
);

/** Parse the durable terminal marker from a stranded job log tail. */
export function parseJobLogEndMarker(log: string): { status: RecoveredJobStatus; exitCode: number | null } | null {
  const match = JOB_LOG_END_MARKER_RE.exec(log);
  if (!match) return null;
  return {
    status: match[1] as RecoveredJobStatus,
    exitCode: match[2] === 'null' ? null : Number(match[2]),
  };
}

const JOB_LOG_DIED_MARKER_RE = new RegExp(
  '^' +
    JOB_LOG_DIED_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    ': state=([^\\s]+) exit=(null|-?\\d+) at [^\\n]*(?:\\n|$)',
  'm',
);

/** Parse the recovery marker that records a ledger-confirmed unobserved death. */
export function parseJobLogDiedMarker(log: string): { status: 'failed'; state: string; exitCode: number | null } | null {
  const match = JOB_LOG_DIED_MARKER_RE.exec(log);
  if (!match) return null;
  return {
    status: 'failed',
    state: match[1]!,
    exitCode: match[2] === 'null' ? null : Number(match[2]),
  };
}

/**
 * Append the unobserved-death marker exactly once. The read-before-append makes
 * repeated `bash_output` recovery polls idempotent, while checking both marker
 * kinds preserves JOB END precedence if the child close handler wins a race with
 * the recovery read. A missing/unwritable log is deliberately best-effort: the
 * ledger verdict returned by the caller remains authoritative even when the
 * marker cannot be persisted.
 */
export function appendJobDiedMarker(
  logPath: string,
  state: string,
  exitCode: number | null,
  exitReason: string | null,
  endedAtMs = Date.now(),
): boolean {
  try {
    const existing = readFileSync(logPath, 'utf8');
    if (parseJobLogEndMarker(existing) || parseJobLogDiedMarker(existing)) return false;
    appendFileSync(logPath, formatJobLogDiedMarker(state, exitCode, exitReason, endedAtMs), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Ledger states where the process ended but no child close/exit was observed. */
export function isLedgerConfirmedUnobservedDeath(state: string): boolean {
  return state === 'stranded' || state === 'ended_unobserved';
}

/**
 * Inspect a stranded log once for both durable completion and filtered output.
 * Keeping these decisions together prevents the tracking-loss branches from
 * drifting away from the normal BashOutput filter contract.
 */
export function inspectStrandedJobLog(
  log: string | Pick<StrandedJobLog, 'tail' | 'content'>,
  filter: string | undefined,
): StrandedJobLogInspection {
  // A caller asking for a filter needs the whole bounded body so a match before
  // the retained tail is not silently reported as absent. Without a filter,
  // preserve the established tail-only recovery contract and memory bound.
  const body =
    typeof log === 'string' ? log : filter && log.content !== undefined ? log.content : log.tail;
  const filtered = filterOutputLines(body, filter);
  const terminal = parseJobLogEndMarker(body);
  const died = terminal ? null : parseJobLogDiedMarker(body);
  return {
    terminal,
    ...(died ? { died } : {}),
    output: filtered.output,
    ...(filtered.error ? { filterError: filtered.error } : {}),
  };
}

/**
 * EI-20051445912325691 — answer "is this job WORKING or WEDGED?" in the reply, instead of
 * leaving every caller to hand-roll it. "Is my job done?" is ~12% of all bash calls on this
 * box, and the hand-rolled answers are wrong in whichever direction is most expensive:
 * `ps -o %cpu` is a process-LIFETIME average; a tree walk that misses a descendant or a
 * double-fork returns a false 0 (measured: 0 cores reported for a tree burning 19.89); and
 * the cgroup recipe applied to a FOREGROUND call reads the OPERATOR's own cgroup instead —
 * measured 7.33 cores across 34 pids in the same window the job itself burned 0.91, a false
 * BUSY that can never read zero, so a dead job reads as alive and the caller keeps waiting.
 *
 * Computed here, that ambiguity is unrepresentable: it is always a tracked background job's
 * own scope, resolved from its pid, or it is null with a reason.
 *
 * ZERO ADDED LATENCY ON A POLL. The previous sample is kept on the job, so from the second
 * read onward this reports cores burned SINCE YOUR LAST READ — more useful than an instant
 * anyway, being the average over exactly the window you were waiting. The FIRST read has no
 * baseline and says so, rather than pausing the reply to manufacture one.
 *
 * Fails soft in every direction: a reason string, never a number, and never a throw — this is
 * diagnostic garnish on a tool whose actual job is returning output.
 */
export function sampleJobCpu(
  job: BashJob,
  deps: { readText?: (p: string) => string | null; now?: () => number } = {},
): { cpu_cores?: number; cpu_basis?: string; cpu_unavailable?: string } {
  const readText =
    deps.readText ??
    ((p: string) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    });
  try {
    if (job.status !== 'running') return { cpu_unavailable: 'job-not-running' };
    const next = readCgroupCpuSample(job.child?.pid ?? null, { readText, now: deps.now });
    if (!next) return { cpu_unavailable: 'cgroup-unreadable' };
    const prev = job.lastCpuSample ?? null;
    job.lastCpuSample = next;
    const cores = coresBetween(prev, next);
    if (cores == null) {
      return {
        cpu_unavailable: 'awaiting-second-sample',
        cpu_basis: `baseline sample taken; a RATE needs two readings at least ${MIN_SAMPLE_GAP_MS}ms apart — read again and this becomes a number`,
      };
    }
    const windowSec = Math.max(1, Math.round((next.atMs - prev!.atMs) / 1000));
    return {
      cpu_cores: Math.round(cores * 100) / 100,
      cpu_basis:
        `cores burned by this job's OWN cgroup over the ${windowSec}s since your last bash_output read ` +
        `(1.0 = one core saturated). ~0 while status=running means ALIVE BUT DOING NOTHING — wedged, blocked on I/O, ` +
        `or still queued behind pc-heavy's slot clamp; it does NOT mean finished.`,
    };
  } catch {
    return { cpu_unavailable: 'cgroup-unreadable' };
  }
}

export default defineTool({
  name: 'capability:bash_output',
  description:
    'Read new output from a background shell job (started by capability:bash run_in_background:true). Accepts its process-local bash_id or durable task_id, so a successor can reattach after carry. Returns output since the last read plus status (running/completed/failed/…) and exit code.',
  guidance: {
    when: 'Poll a background job started by capability:bash. Use task_id after compaction/carry; it resolves through the durable task ledger and NEVER starts a replacement job. Call repeatedly to drain output as it runs; the final call after status leaves "running" gives the tail + exit code.',
    notWhen:
      'For a foreground command — its output is in the capability:bash result directly. A miss WITH a log tail means the job\'s in-memory tracking is gone while its log survived; three DISTINCT reason codes say what is known, never conflate them. `"tracking_lost_process_alive"` = CONFIRMED running (task-ledger pid re-probe) — do NOT re-run, keep polling. `"job_process_gone"` = CONFIRMED ended (the ledger observed a terminal state) — safe to re-run. `"job_liveness_unknown"` = only a whole-operator restart was ruled out; liveness is UNKNOWN and the job is most often alive but QUEUED behind pc-heavy\'s slot clamp — check `ps` for your command before re-running, or you add load to the very queue that is delaying it.',
    chaining:
      'capability:bash { run_in_background:true } → capability:bash_output { task_id } after carry (or { bash_id } in the launching context) → processes:kill { taskId } to stop early.',
    seeAlso: ['capability:bash (start the command)', 'capability:bash_kill (kill the backgrounded run)'],
  },
  capability: 'capability:bash',
  requirePrincipal: false,
  // EI-20190459016345227: output polling does not read ctx.tx and can await
  // the durable task-ledger fallback while a live seed cut is running. Do not
  // retain the ambient workspace transaction across that control-path I/O.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      bash_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The process-local id returned by capability:bash (run_in_background). Use only in the launching context.',
        ),
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The durable task id returned by capability:bash. Preferred after compaction/carry; attachment never restarts the job.',
        ),
      filter: z
        .string()
        .optional()
        .describe(
          'Regex; only output LINES matching it are returned (the read cursor still advances past ALL output, matching or not). Mirrors the native BashOutput filter.',
        ),
      peek: z.boolean().optional().describe('Read without advancing the read cursor (default false).'),
    })
    .superRefine((args, refinementCtx) => {
      if (Boolean(args.bash_id) === Boolean(args.task_id)) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Pass exactly one of bash_id or task_id.',
          path: ['bash_id'],
        });
      }
    }),
  async handler(args, ctx) {
    // `bash_id` indexes the process-local JOBS map. `task_id` is the durable
    // carry-safe handle: resolve it once through the existing task ledger, then
    // reuse the exact same live-map/log/identity/terminal-marker path below.
    // This module deliberately does not import `startBackground`; attachment can
    // never turn a lookup miss into a duplicate launch.
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*'
        ? ctx.workspaceId
        : ctx.principal?.workspaceId && ctx.principal.workspaceId !== '*'
          ? ctx.principal.workspaceId
          : undefined;
    let attachedLedgerRow: TaskRow | null = null;
    let bashId = args.bash_id;
    if (args.task_id) {
      if (!workspaceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'workspace_scope_required',
                task_id: args.task_id,
                advice: 'A concrete workspace scope is required to attach by durable task_id.',
              }),
            },
          ],
          isError: true,
        };
      }
      try {
        attachedLedgerRow = await getTask(args.task_id);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'task_ledger_unavailable',
                task_id: args.task_id,
                advice: `Could not read the durable task ledger; the job was NOT restarted. Retry attachment (${err instanceof Error ? err.message : String(err)}).`,
              }),
            },
          ],
          isError: true,
        };
      }
      // Treat a cross-workspace id exactly like a miss: callers cannot attach to
      // (or learn metadata about) another workspace's managed process.
      if (!attachedLedgerRow || attachedLedgerRow.workspaceId !== workspaceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'unknown_task_id',
                task_id: args.task_id,
                advice:
                  'No managed background shell job with this task_id exists in the current workspace. The job was NOT restarted.',
              }),
            },
          ],
          isError: true,
        };
      }
      const durableBashId = attachedLedgerRow.detail?.bashJobId;
      if (attachedLedgerRow.class !== 'bash-job' || typeof durableBashId !== 'string' || durableBashId.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'task_not_attachable',
                task_id: args.task_id,
                advice:
                  'This task is not a capability:bash background job with a durable bash handle. It was NOT restarted.',
              }),
            },
          ],
          isError: true,
        };
      }
      bashId = durableBashId;
    }

    // The schema enforces exactly one handle. Keep the runtime guard because
    // direct handler tests/callers can bypass schema parsing.
    if (!bashId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'missing_job_handle' }) }],
        isError: true,
      };
    }

    const job = getJob(bashId);
    if (!job) {
      // The JOBS map is worker-local in the clustered operator. Pin the durable
      // lookup to this request's workspace before deciding that the id is gone;
      // otherwise a clean exit on a sibling worker is misread as an unknown job.
      const ledgerRow =
        attachedLedgerRow ?? (await getTaskByBashJobId(bashId, workspaceId ? { workspaceId } : {}).catch(() => null));
      const jobIdentity = {
        bash_id: bashId,
        ...(ledgerRow?.taskId ? { task_id: ledgerRow.taskId } : {}),
      };
      const ledgerVerdict = diagnoseFromLedger(ledgerRow);
      const stranded =
        strandedJobLookup(bashId, ctx.stateDir) ??
        (ledgerRow?.logPath ? strandedJobLookupAtPath(ledgerRow.logPath) : null);
      if (stranded || ledgerRow) {
        const strandedLog: StrandedJobLogInspection = stranded
          ? inspectStrandedJobLog(stranded, args.filter)
          : { terminal: null, output: '' };
        // A log can grow between stat/read or be read through a stale worker's
        // cursor. When no filter was requested, prefer the independently
        // captured tail whenever the first inspection returned empty despite
        // bytes being present. A filter with no matches is legitimately empty.
        const recoveredStrandedOutput =
          !args.filter && strandedLog.output.length === 0 && stranded?.tail ? stranded.tail : strandedLog.output;
        const strandedOutput = {
          output_tail: recoveredStrandedOutput,
          ...(strandedLog.filterError ? { filter_error: strandedLog.filterError } : {}),
        };
        const recoveredLogPath = stranded?.logPath ?? ledgerRow?.logPath ?? undefined;

        // EI-20011476155595470: a child killed outside the normal close path
        // can leave a durable terminal ledger row but no JOB END line in the
        // spill log. Make that state self-describing for raw log readers. Do
        // this only for the ledger's explicitly unobserved-death states; a
        // normal observed exit/kill/timeout keeps JOB END semantics, and the
        // JOB END marker still wins if it is already present in the log.
        const diedMarkerWritten =
          ledgerVerdict.kind === 'confirmed_dead' &&
          isLedgerConfirmedUnobservedDeath(ledgerVerdict.state) &&
          recoveredLogPath
            ? appendJobDiedMarker(
                recoveredLogPath,
                ledgerVerdict.state,
                ledgerVerdict.exitCode,
                ledgerVerdict.exitReason,
                ledgerRow?.endedAt && Number.isFinite(Date.parse(ledgerRow.endedAt))
                  ? Date.parse(ledgerRow.endedAt)
                  : Date.now(),
              )
            : false;

        // EI-20230176152308336: the durable JOB END marker is stronger than a
        // stale/non-terminal task-ledger row. The marker is appended from the
        // child close handler, so once it is present the job has a recoverable
        // terminal verdict even though the in-memory BashJob and/or its ledger
        // update may have been lost. Return the normal BashOutput success shape
        // instead of making callers poll a process that already finished.
        if (strandedLog.terminal) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  ...jobIdentity,
                  status: strandedLog.terminal.status,
                  exit_code: strandedLog.terminal.exitCode,
                  running: false,
                  ...(stranded ? { total_bytes: stranded.sizeBytes } : {}),
                  ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                  recovered_from_log_marker: true,
                  ...strandedOutput,
                  output: recoveredStrandedOutput,
                }),
              },
            ],
          };
        }

        // A previous recovery read may already have appended JOB DIED. It is a
        // durable failed terminal verdict just like JOB END is a durable normal
        // terminal verdict, but never a success signal.
        if (strandedLog.died) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  ...jobIdentity,
                  status: strandedLog.died.status,
                  exit_code: strandedLog.died.exitCode,
                  running: false,
                  ...(stranded ? { total_bytes: stranded.sizeBytes } : {}),
                  ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                  recovered_from_died_marker: true,
                  ...strandedOutput,
                  output: strandedLog.output,
                }),
              },
            ],
            isError: true,
          };
        }

        const scopeActive =
          ledgerVerdict.kind === 'ledger_inconclusive' && ledgerRow
            ? await taskScopeIsActive(ledgerRow)
            : false;

        if (ledgerVerdict.kind === 'confirmed_alive' || scopeActive) {
          // EI-20218784292451325: a durable liveness proof is a successful
          // recovery, not a tool failure. The worker-local JOBS map may be
          // missing after a cross-worker read, but the task is still healthy;
          // surfacing `isError:true` made callers and the watchdog treat this
          // expected degraded read as a failed command. The recovered log is a
          // tail (there is no worker-local cursor), so say that explicitly while
          // preserving the normal running/status shape.
          // EI-19915289191989412: the "log tail will keep growing" promise below is
          // FALSE for a command whose last pipeline stage is a buffering filter
          // (`| tail -45`, `| head`, …) — that stage flushes nothing until the
          // whole pipeline exits, so `total_bytes_written` can legitimately sit at
          // 0 for the job's entire (confirmed-alive) run. `argv` is
          // `['bash', '-o', 'pipefail', '-c', <the raw command>]` (see
          // startBackground) — the raw command is always its LAST element.
          const processAlive = ledgerVerdict.kind === 'confirmed_alive' ? ledgerVerdict : null;
          const ledgerArgv = ledgerRow?.argv;
          const rawCommand = ledgerArgv && ledgerArgv.length > 0 ? ledgerArgv[ledgerArgv.length - 1] : undefined;
          const bufferingStage = rawCommand ? detectBufferingLastStage(rawCommand) : null;
          const growthAdvice = bufferingStage
            ? formatBufferingPipelineAdvice(bufferingStage, 'tracking-lost')
            : 'Keep polling capability:bash_output (the log tail below will keep growing as it runs)';
          const readPathAdvice = bufferingStage ? '' : ', or read log_path directly';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  ...jobIdentity,
                  status: 'running',
                  exit_code: null,
                  running: true,
                  ...(processAlive?.pid ?? ledgerRow?.pid
                    ? { pid: processAlive?.pid ?? ledgerRow?.pid }
                    : {}),
                  scope_unit: processAlive?.scopeUnit ?? ledgerRow?.scopeUnit ?? null,
                  recovered_from_ledger: true,
                  ...(scopeActive
                    ? { recovered_from_scope: true, liveness_proof: 'systemd_active_state' }
                    : { liveness_proof: 'process_identity_and_cgroup' }),
                  tracking_lost: true,
                  output_is_tail: true,
                  ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                  ...(stranded ? { total_bytes: stranded.sizeBytes } : {}),
                  ...(stranded ? { total_bytes_written: stranded.sizeBytes } : {}),
                  ...(diedMarkerWritten ? { job_died_marker_written: true } : {}),
                  ...strandedOutput,
                  output: recoveredStrandedOutput,
                  advice:
                    scopeActive
                      ? `This job's in-memory tracking is gone, but its durable systemd service ${ledgerRow?.scopeUnit} is ` +
                        'CONFIRMED ACTIVE — verified just now with systemd ActiveState, independent of the worker-local ' +
                        'registry and PID/cgroup probe. It may be queued behind pc-heavy and still produce no new output. ' +
                        'Do NOT re-run capability:bash — that would start a SECOND concurrent job and double the load. ' +
                        `${growthAdvice}${readPathAdvice}. To stop ${confirmedAliveStopAdvice()}`
                      : `This job's in-memory tracking is gone, but its real OS process (pid ${processAlive?.pid}` +
                        `${processAlive?.scopeUnit ? `, systemd scope ${processAlive.scopeUnit}` : ''}) is CONFIRMED ` +
                        'STILL RUNNING — verified just now via a process-identity re-probe against the durable task ' +
                        'ledger (immune to PID reuse), not a guess. Do NOT re-run capability:bash — that would start a ' +
                        `SECOND concurrent job and double the load. ${growthAdvice}${readPathAdvice}. To stop ` +
                        confirmedAliveStopAdvice(),
                }),
              },
            ],
          };
        }

        if (ledgerVerdict.kind === 'confirmed_dead') {
          const terminal = terminalStatusFromLedger(ledgerRow);
          // A durable `exited`/0 row is authoritative success evidence even when
          // this worker missed both the live handle and the end-marker read. The
          // old branch treated every terminal row as job_process_gone, causing
          // successful Vitest/typecheck jobs to be reported as errors (EI-20232536598731015).
          if (terminal?.status === 'completed') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    ok: true,
                    ...jobIdentity,
                    status: terminal.status,
                    exit_code: terminal.exitCode,
                    running: false,
                    ...(stranded ? { total_bytes: stranded.sizeBytes } : {}),
                    ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                    recovered_from_ledger: true,
                    ...strandedOutput,
                    output: recoveredStrandedOutput,
                  }),
                },
              ],
            };
          }
          const exitDetail =
            (ledgerVerdict.exitCode !== null ? ` exit code ${ledgerVerdict.exitCode}` : '') +
            (ledgerVerdict.exitReason ? `: ${ledgerVerdict.exitReason}` : '');
          // EI-19315479997523199 — a `stranded` verdict (the ledger observed the
          // scope/pid vanish from the kernel with no exit code ever seen) used to
          // report the SAME generic "CONFIRMED it actually ended" advice as a clean
          // exit, leaving a job that silently evaporated mid-wait just as
          // unattributed as it was before the ledger existed. `confined` is the
          // one signal that tells the two `stranded` shapes apart:
          //   - UNCONFINED (task-manager was off at spawn time, or its probe
          //     failed): this job lived as a direct child of the operator
          //     process, so the far more likely explanation is the routine,
          //     documented one — a peer restarted :3070/:3170 mid-job (repo-
          //     conventions § two-port model) and took every unconfined
          //     in-flight background job down with it. Not a bug in the command.
          //   - CONFINED: the payload is outside the operator's cgroup, but the
          //     systemd-run --scope monitor is still its child. Killing that
          //     monitor during an operator restart can end the sibling scope too;
          //     confinement is not restart durability (EI-20219872509843731).
          const strandedAdvice =
            ledgerVerdict.state !== 'stranded'
              ? null
              : ledgerVerdict.confined
                ? strandedJobAdvice(true)
                : strandedJobAdvice(false);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  ...jobIdentity,
                  reason: 'job_process_gone',
                  advice:
                    "This job's in-memory tracking is gone, and the durable task ledger CONFIRMS it actually ended " +
                    `(state=${ledgerVerdict.state}${exitDetail}) — not a guess.${strandedAdvice ?? ''} Re-run ` +
                    'capability:bash if you still need the result; check output_tail below for how far it got.',
                  ...(recoveredLogPath ? { log_path: recoveredLogPath } : {}),
                  ...(stranded ? { total_bytes_written: stranded.sizeBytes } : {}),
                  ...strandedOutput,
                }),
              },
            ],
            isError: true,
          };
        }

        // Without a surviving log there is no safe uptime-based fallback. The
        // ledger above has already had the chance to prove alive/dead; preserve
        // the existing unknown-id response rather than dereferencing a missing
        // birth time or inventing a restart cause.
        if (!stranded) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  ...jobIdentity,
                  reason: 'unknown_bash_id',
                  advice:
                    'No surviving output log is available for this background job. Re-run with capability:bash if you still need the result.',
                }),
              },
            ],
            isError: true,
          };
        }

        // EI-18666279107998059: EI-16635 stopped ASSERTING the restart cause as fact
        // but still couldn't tell the two causes apart, so every stranded job read
        // "here are two possible causes, go check yourself" even when this very
        // process's own uptime already proves which one it was (see
        // diagnoseStrandedCause). Do that check now — but this is a FALLBACK, only
        // reached when the ledger (above) had no row or could not confirm either
        // way, so word the verdict as the best available inference, not a fact
        // about the JOB's liveness (that overclaim is EI-18759519171684432 itself —
        // a whole-operator restart being ruled out never proved this job's own
        // process was gone).
        const cause = diagnoseStrandedCause({ jobBirthtimeMs: stranded.birthtimeMs });
        const ledgerCaveat =
          ledgerVerdict.kind === 'no_ledger_row'
            ? ' (no task-ledger record was found for this job to confirm further)'
            : ' (the task ledger still shows it non-terminal but could not confirm liveness — the process may have exited without the ledger observing it yet)';
        const advice =
          cause === 'stranded_by_operator_restart'
            ? "This job STARTED (its log file exists on disk) but its in-memory tracking is gone, and this operator process's own uptime is SHORTER than the job's age — CONFIRMED: the operator process that ran it restarted or was killed mid-job. A routine, common event on a shared dev box: any agent restarting :3070/:3170 kills every OTHER agent's in-flight background jobs too (repo-conventions § two-port model). It is NOT a wrong bash_id and not a bug in your command. Re-run capability:bash if you still need the result; check output_tail below for how far it got before dying."
            : `This job STARTED (its log file exists on disk) but its in-memory tracking is gone, and this operator process has been running continuously since BEFORE the job started — so a WHOLE-OPERATOR restart is ruled out${ledgerCaveat}. That does NOT confirm the job's own process died: before re-running, check yourself (e.g. \`ps\` for your command) — re-running while the original may still be alive doubles the load. If you can confirm it is really gone, re-run capability:bash; check output_tail below for how far it got.`;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                ...jobIdentity,
                reason: cause,
                advice,
                log_path: recoveredLogPath,
                total_bytes_written: stranded.sizeBytes,
                ...strandedOutput,
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              bash_id: bashId,
              reason: 'unknown_bash_id',
              advice:
                'No such background job (it may have been pruned, or the id is wrong). Re-run with capability:bash.',
            }),
          },
        ],
        isError: true,
      };
    }
    // Cursor advances over the FULL chunk (matching native BashOutput); the filter
    // only narrows what's RETURNED, so non-matching lines aren't re-shown next read.
    const fullChunk = readJobOutput(job, args.peek ?? false);
    const { output, error: filterError } = filterOutputLines(fullChunk, args.filter);
    const cpu = sampleJobCpu(job);
    // EI-20057167830211785: a backgrounded `tsc` that DIED (OOM, signal, bad
    // operand) emits a V8 dump and zero `error TS` lines, so every natural probe
    // — a grep count, an eyeball of the tail, this tool's own `output` — reads
    // exactly like a clean compile. The foreground paths already refuse that
    // reading; a backgrounded one had nowhere to say it, and backgrounding is
    // what agents are ROUTED to for any project too big for the ~50s foreground
    // cap. Deliberately computed from the SPILL LOG, not from `output`: `output`
    // is only the since-cursor chunk, so a caller that drained the log while the
    // job ran would be classified against an empty string.
    const deadTypecheck = backgroundTypecheckVerdict({
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      log: readJobLogForVerdict(job),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            bash_id: job.id,
            ...(job.taskId ? { task_id: job.taskId } : {}),
            status: job.status,
            exit_code: job.exitCode,
            running: job.status === 'running',
            total_bytes: job.totalBytes,
            log_path: job.logPath,
            ...cpu,
            ...(filterError ? { filter_error: filterError } : {}),
            ...(deadTypecheck
              ? {
                  typecheck_verdict: deadTypecheck.reason,
                  headline: deadTypecheck.headline,
                  advice: deadTypecheck.advice,
                }
              : {}),
            output,
          }),
        },
      ],
      ...(deadTypecheck ? { isError: true } : {}),
    };
  },
});
