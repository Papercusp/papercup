/**
 * bash-core + background-job registry for the `capability:bash*` tools.
 *
 * Part of P-010 (`agent-capability-confinement-2026-06-13`): the capability
 * defineTool surface. The `bash` tool is a THIN wrapper over a real shell
 * (D-004 — no reimplementation) that replicates the native Bash tool's I/O
 * ergonomics: combined output streaming, truncation/overflow-to-file, and
 * async/background job semantics (a 5-min build cannot be one blocking HTTP
 * request).
 *
 * IN-MEMORY REGISTRY — deliberate exception to the PG-by-default storage policy.
 * A *running child process handle* is inherently in-memory and process-bound;
 * it cannot be serialized to PG. This is the same exception class the storage
 * policy carves out for long-lived byte streams / live PTY sessions. The
 * DURABLE artifact (full output) is spilled to a scratch file under
 * `<stateDir>/scratch/`; only the live handle + read cursor live in the Map.
 * The operator (Hono host) is one long-lived process, so a background job
 * registered on one MCP `tools/call` is readable by a later `capability:bash_output`
 * call against the same operator — exactly how the native Bash background tool
 * holds its shell in the CLI process.
 */

import { spawn as childSpawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { augmentedSpawnPath, resolveBin } from '../../plugin-spawn-impl';
import { buildCapabilitySandboxCommand, scrubExecEnv } from './exec-sandbox';
import { resolveAgentMcpBaseUrl } from '../../mcp-base-url';
import {
  beginSyncEnrolment,
  completeSyncEnrolment,
  finishSyncEnrolment,
} from '../../task-manager/enroll-sync';
import { warmScopeProbe } from '../../task-manager/managed-spawn';

// Warm the systemd-scope probe at module load so the FIRST background job can
// already be confined. Fire-and-forget by design: a job must never wait on, or be
// refused by, the task manager's own readiness (task-manager P-008).
warmScopeProbe();

/** Inline output cap (chars). Output beyond this spills to the scratch log and
 *  the inline result carries head+tail + the log path. Mirrors the native
 *  tool's overflow-to-file behavior. */
export const INLINE_OUTPUT_CAP = 30_000;
/** Hard ceiling on retained in-memory output per job (bytes). Beyond this the
 *  in-memory tail is trimmed (the full stream is still on disk). 5 MB. */
const MEM_BUFFER_CAP = 5 * 1024 * 1024;
/** Default + max command wall-clock (ms). */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/** Keep at most this many finished jobs around for late `bash_output` reads. */
const MAX_RETAINED_JOBS = 64;

/**
 * A temp dir given to every capability-exec'd child, overriding whatever ephemeral
 * `TMPDIR` the operator inherited (EI-5912). The capability exec-sandbox (srt / the
 * bwrap `--tmpfs /tmp`) mounts a FRESH writable `/tmp`, so an inherited per-session
 * `TMPDIR=/tmp/claude/<runid>` does NOT exist inside the sandbox — a tool that does
 * `mkdir $TMPDIR/<x>` (vitest's SSR dir) then ENOENTs and the SANCTIONED test runner
 * (`capability:inspect { check:'test' }`) is unusable, forcing agents back to raw
 * bash. `/tmp` (the sandbox tmpfs root) always exists + is writable there (verified),
 * and is the sensible default TMPDIR unsandboxed too. Injected BEFORE the caller's
 * explicit `env`, so a caller that deliberately sets TMPDIR still wins. */
export const CAPABILITY_SANDBOX_TMPDIR = '/tmp';

export type BashStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timed_out';

export interface BashJob {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  startedAt: number;
  endedAt: number | null;
  status: BashStatus;
  exitCode: number | null;
  /** Retained tail of combined stdout+stderr (trimmed at MEM_BUFFER_CAP). */
  buffer: string;
  /** Total bytes ever produced (not just retained). */
  totalBytes: number;
  /** Absolute path to the full output spill log. */
  logPath: string;
  /** Index into `buffer` already returned by bash_output (incremental reads). */
  readCursor: number;
  logStream: WriteStream | null;
  /**
   * task-manager-no-escape-2026-07-27 P-008 — the DURABLE half of this job's
   * identity. The Map above dies with the operator process (EI-8855: any agent
   * restarting it wipes every handle, which is why an inherited "job COMPLETED"
   * claim has to be re-verified against the OS). The ledger row does not, and the
   * cgroup scope makes the job's whole subtree addressable without a pid.
   * Undefined for foreground runs, which by construction cannot outlive the call.
   */
  taskId?: string;
  scopeUnit?: string | null;
}

const JOBS = new Map<string, BashJob>();

/** Resolve + create the scratch dir for output spill. */
export function scratchDir(stateDir: string | undefined): string {
  const base = stateDir && stateDir.trim() ? stateDir : join(tmpdir(), 'papercusp-capability');
  const dir = join(base, 'scratch');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Spawn `bash -o pipefail -c <command>` with an augmented PATH (the operator
 *  sidecar's PATH often omits node/npx/git locations — same fix as
 *  pluginSpawnImpl). stdin is closed; combined stdout+stderr are piped.
 *
 *  `-o pipefail` (EI-13414): without it, bash's reported exit code for a
 *  piped command (`cmd | tail -N`, `| head`, `| grep`, …) is the LAST
 *  command's exit code, not the pipeline's — so `real-test-runner | tail -60`
 *  reports the tool's own exit 0 even when the runner FAILED, silently
 *  masking a real failure as a clean pass to whichever agent is trusting
 *  `exitCode`/`isError` as completion evidence (the exact near-miss that
 *  filed this bug: a real `1 non-quarantined task(s) failed` was reported as
 *  exit 0). `pipefail` makes the reported exit code the right-most non-zero
 *  status in the pipeline (or zero if all succeed) — the same fix a diligent
 *  caller is told to apply by hand (`set -o pipefail`); applying it at the
 *  spawn layer protects every agent using this shared shell tool, not just
 *  ones who remembered to opt in. A caller that truly wants "ignore this
 *  stage's exit code" still has the standard escape hatch (`cmd || true`,
 *  `cmd; true`) — same as any pipefail-enabled shell.
 *
 *  When `sandboxEnabled` (the resolved papercusp-capability-exec-sandbox flag,
 *  P-022/D-008), the `bash -c` runs inside a bwrap OS sandbox (fs + credential
 *  containment) where bwrap works; FAIL-OPEN to a raw spawn otherwise (a logged
 *  warning), so a host without a working bwrap is never bricked. */
function spawnShell(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  sandboxEnabled = false,
  background = false,
  /** task-manager P-008: wrap the resolved argv into this job's cgroup scope.
   *  Applied AFTER the sandbox decision so bwrap still wraps the payload and the
   *  scope wraps bwrap — the confinement layers nest rather than compete. */
  wrapScope?: (binary: string, argv: string[]) => { binary: string; argv: string[] },
): ChildProcess {
  const spawnPath = augmentedSpawnPath();
  // EI-1617: scrubExecEnv replaces the old stripHostX-only passthrough — an
  // ALLOWLIST (PATH/HOME/locale/toolchain vars + the couple of Papercusp
  // plumbing vars this path needs), not a denylist, so the operator's OWN
  // secrets (DB creds, webhook/JWT secrets, session keys, …) never reach a
  // bee's shell command. DISPLAY/XAUTHORITY/WAYLAND_DISPLAY are dropped too
  // (not in the allowlist) — strictly narrower than stripHostX, so the old
  // host-X isolation still holds.
  const inheritedEnv = normalizeInheritedOperatorUrl(scrubExecEnv(process.env));
  const decision = buildCapabilitySandboxCommand(
    { cmd: [resolveBin('bash', spawnPath), '-o', 'pipefail', '-c', command], cwd },
    // EI-16635: `background` (true for startBackground's run_in_background jobs)
    // tells the sandbox builder to omit bwrap's `--die-with-parent` — that flag
    // is incompatible with a job contractually meant to outlive this spawn call.
    { enabled: sandboxEnabled, background },
  );
  if (sandboxEnabled && !decision.sandboxed) {
    console.warn(
      `[capability:bash] exec-sandbox enabled but ${decision.reason} — running unsandboxed in the operator process (cwd ${cwd})`,
    );
  }
  const launch = wrapScope
    ? wrapScope(decision.binary, decision.argv)
    : { binary: decision.binary, argv: decision.argv };
  const child = childSpawn(launch.binary, launch.argv, {
    cwd,
    // ISOLATION (2026-06-19 keystroke-leak fix): strip the operator's host X session
    // (DISPLAY=:0 / gdm XAUTHORITY) so a bee shell can NEVER inherit the seat. A GUI
    // command only reaches a display when the caller (bash.ts) explicitly bound a
    // LEASED sandbox DISPLAY in `env`; with no lease there is no DISPLAY at all.
    // TMPDIR/TMP/TEMP → a dir that EXISTS inside the exec-sandbox (EI-5912): after
    // stripHostX (which keeps the inherited, possibly-ephemeral TMPDIR) but BEFORE
    // the caller's explicit `env`, so a deliberate caller override still wins.
    env: {
      ...inheritedEnv,
      TMPDIR: CAPABILITY_SANDBOX_TMPDIR,
      TMP: CAPABILITY_SANDBOX_TMPDIR,
      TEMP: CAPABILITY_SANDBOX_TMPDIR,
      ...(env ?? {}),
      PATH: spawnPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // OWN PROCESS GROUP (capability-bash-orphan-kill-2026-06-21): `detached:true`
    // makes the child (bash, or the bwrap wrapper) a process-group leader
    // (pgid === child.pid on Linux). That is what lets a timeout/abort kill the
    // WHOLE tree — bash AND every descendant it spawned (grep/ugrep/build/…) — via
    // process.kill(-pid). Without it, killing only the bash parent ORPHANS its
    // children (reparented to init), which keep running at full CPU: the runaway
    // 58-min ugrep that starved the operator event loop → :3070 wedge. We never
    // unref() the child, so the operator still tracks + reaps it normally.
    detached: true,
  });
  return child;
}

function normalizeInheritedOperatorUrl(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const raw = env.PAPERCUSP_OPERATOR_URL?.trim();
  if (!raw) return env;
  const hadMcpSuffix = /\/api\/mcp\/?$/.test(raw);
  const base = raw.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  const routedBase = resolveAgentMcpBaseUrl(base);
  if (routedBase === base) return env;
  return {
    ...env,
    PAPERCUSP_OPERATOR_URL: hadMcpSuffix ? `${routedBase}/api/mcp` : routedBase,
  };
}

/**
 * Kill a spawned command's ENTIRE process group, not just the bash parent.
 * spawnShell runs `detached:true`, so the child is its own process-group leader
 * (pgid === child.pid); signalling the NEGATIVE pid reaches bash and every
 * descendant it spawned. Without this a timed-out / aborted command leaves
 * orphaned grandchildren (e.g. ugrep) running at 100% CPU — the wedge root cause
 * (capability-bash-orphan-kill-2026-06-21). Falls back to a direct child kill if
 * the group signal fails (child already exited / pid reused). Never throws.
 */
function killProcessTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig); // negative pid → the whole process group
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already exited */
    }
  }
}

/** Append a chunk to a job's in-memory tail (trimmed) + spill log + totals. */
function appendOutput(job: BashJob, chunk: string): void {
  job.totalBytes += Buffer.byteLength(chunk, 'utf8');
  job.buffer += chunk;
  if (job.buffer.length > MEM_BUFFER_CAP) {
    const overflow = job.buffer.length - MEM_BUFFER_CAP;
    job.buffer = job.buffer.slice(overflow);
    job.readCursor = Math.max(0, job.readCursor - overflow);
  }
  try {
    job.logStream?.write(chunk);
  } catch {
    /* a spill-write fault must not crash the job */
  }
}

export interface RunOptions {
  command: string;
  cwd: string;
  stateDir: string | undefined;
  env?: Record<string, string>;
  /** Per-event streamer (foreground only). */
  onChunk?: (chunk: string) => void;
  /** Resolved papercusp-capability-exec-sandbox flag (P-022/D-008). When true the
   *  command runs inside a bwrap OS sandbox where bwrap works; fail-open otherwise. */
  sandboxEnabled?: boolean;
  /** task-manager P-008 provenance — the agent id this job is FOR, and the
   *  work-item it is attributable to. Optional because a caller that does not know
   *  should say so (the row records `capability:bash`) rather than guess: a wrong
   *  attribution in a ledger built for attribution is worse than an honest gap. */
  launchedBy?: string;
  workItemId?: string | null;
}

export interface ForegroundResult {
  status: BashStatus;
  exitCode: number | null;
  output: string;
  totalBytes: number;
  truncated: boolean;
  logPath: string;
  durationMs: number;
}

/**
 * Run a command to completion in the foreground. Streams chunks via `onChunk`,
 * spills the full combined output to a scratch log, enforces a wall-clock
 * timeout, and aborts on `signal`. Returns the (possibly head+tail-trimmed)
 * inline output plus the spill path.
 */
export function runForeground(opts: RunOptions, signal: AbortSignal, timeoutMs: number): Promise<ForegroundResult> {
  return new Promise<ForegroundResult>((resolvePromise) => {
    const id = cryptoRandomId();
    const logPath = join(scratchDir(opts.stateDir), `bash-${id}.log`);
    const logStream = safeWriteStream(logPath);
    const startedAt = Date.now();
    const child = spawnShell(opts.command, opts.cwd, opts.env, opts.sandboxEnabled, false);

    let buffer = '';
    let totalBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const onData = (b: Buffer): void => {
      const s = b.toString('utf8');
      totalBytes += Buffer.byteLength(s, 'utf8');
      if (buffer.length < MEM_BUFFER_CAP) buffer += s;
      try { logStream?.write(s); } catch { /* ignore spill fault */ }
      opts.onChunk?.(s);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGKILL');
    }, Math.min(timeoutMs, MAX_TIMEOUT_MS));

    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child, 'SIGKILL');
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const finish = (status: BashStatus, exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const truncated = buffer.length > INLINE_OUTPUT_CAP;
      const output = truncated ? headTail(buffer) : buffer;
      const result: ForegroundResult = {
        status,
        exitCode,
        output,
        totalBytes,
        truncated: truncated || totalBytes > Buffer.byteLength(buffer, 'utf8'),
        logPath,
        durationMs: Date.now() - startedAt,
      };
      // Resolve only AFTER the spill log has fully flushed to disk: a fire-and-forget
      // `end()` returns before createWriteStream's buffered writes reach the file, so a
      // caller (or test) that reads `logPath` synchronously could see a partially
      // flushed prefix — the tail is missing under I/O load. `end(cb)` fires the
      // callback on the stream's 'finish' event (flush complete). Resolve exactly once,
      // whether the flush completes or the stream errors (spill is best-effort).
      let resolved = false;
      const settleOnce = (): void => {
        if (resolved) return;
        resolved = true;
        resolvePromise(result);
      };
      if (logStream) {
        logStream.on('error', settleOnce);
        try { logStream.end(settleOnce); } catch { settleOnce(); }
      } else {
        settleOnce();
      }
    };

    child.on('error', (err) => {
      const msg = `\n[spawn error] ${err instanceof Error ? err.message : String(err)}\n`;
      totalBytes += msg.length;
      if (buffer.length < MEM_BUFFER_CAP) buffer += msg;
      try { logStream?.write(msg); } catch { /* ignore */ }
      finish('failed', null);
    });
    child.on('close', (code) => {
      const status: BashStatus = timedOut ? 'timed_out' : aborted ? 'killed' : code === 0 ? 'completed' : 'failed';
      finish(status, code);
    });
  });
}

/**
 * Start a command in the background. Registers a {@link BashJob}, returns its id
 * immediately. Output streams to both the in-memory tail (for incremental
 * `bash_output` reads) and the spill log. Prunes finished jobs past the cap.
 */
export function startBackground(opts: RunOptions, timeoutMs: number): BashJob {
  pruneFinished();
  const id = cryptoRandomId();
  const logPath = join(scratchDir(opts.stateDir), `bash-${id}.log`);

  // task-manager P-008: mint the task id + confinement decision BEFORE the fork so
  // the scope name can go into the argv; the ledger WRITES happen afterwards,
  // fire-and-forget, and can never block or fail this spawn (see enroll-sync.ts).
  const enrolment = beginSyncEnrolment({ class: 'bash-job', runtimeMaxSec: Math.ceil(timeoutMs / 1000) });

  // EI-16635: background:true — this job is a run_in_background spawn, meant to
  // outlive this call, so the sandbox path (when enabled) must not die-with-parent.
  const child = spawnShell(opts.command, opts.cwd, opts.env, opts.sandboxEnabled, true, enrolment.wrap);
  const job: BashJob = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    child,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    buffer: '',
    totalBytes: 0,
    logPath,
    readCursor: 0,
    logStream: safeWriteStream(logPath),
    taskId: enrolment.taskId,
    scopeUnit: enrolment.scopeUnit,
  };
  JOBS.set(id, job);

  completeSyncEnrolment(
    enrolment,
    {
      class: 'bash-job',
      // The command is the only honest title here, and it is what a human scanning
      // the pane will look for. Bounded so one pathological heredoc cannot bloat
      // every read of the table.
      title: opts.command.slice(0, 300),
      argv: ['bash', '-o', 'pipefail', '-c', opts.command],
      cwd: opts.cwd,
      launchedBy: opts.launchedBy ?? 'capability:bash',
      workItemId: opts.workItemId ?? null,
      logPath,
      runtimeMaxSec: Math.ceil(timeoutMs / 1000),
      detail: { bashJobId: id, sandboxed: Boolean(opts.sandboxEnabled) },
    },
    child.pid ?? null,
  );

  const onData = (b: Buffer): void => appendOutput(job, b.toString('utf8'));
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const timer = setTimeout(() => {
    if (job.status === 'running') {
      job.status = 'timed_out';
      killProcessTree(child, 'SIGKILL');
    }
  }, Math.min(timeoutMs, MAX_TIMEOUT_MS));

  child.on('error', (err) => {
    appendOutput(job, `\n[spawn error] ${err instanceof Error ? err.message : String(err)}\n`);
    job.status = 'failed';
    job.endedAt = Date.now();
    clearTimeout(timer);
    try { job.logStream?.end(); } catch { /* ignore */ }
    job.logStream = null;
    finishSyncEnrolment(enrolment, {
      state: 'exited',
      exitCode: null,
      exitReason: `spawn error: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
  child.on('close', (code) => {
    if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed';
    job.exitCode = code;
    job.endedAt = Date.now();
    clearTimeout(timer);
    try { job.logStream?.end(); } catch { /* ignore */ }
    job.logStream = null;
    // `timed_out` is preserved distinctly rather than collapsed into a kill: the
    // ledger's job is to say WHY something ended, and "hit its own deadline" and
    // "someone killed it" are different answers to that.
    finishSyncEnrolment(enrolment, {
      state: job.status === 'timed_out' ? 'timed_out' : job.status === 'killed' ? 'killed' : 'exited',
      exitCode: code,
      exitReason: job.status === 'timed_out' ? `exceeded ${timeoutMs}ms timeout` : null,
    });
  });

  return job;
}

export function getJob(id: string): BashJob | undefined {
  return JOBS.get(id);
}

/** Read the new output since the last read; advances the cursor unless `peek`. */
export function readJobOutput(job: BashJob, peek = false): string {
  const chunk = job.buffer.slice(job.readCursor);
  if (!peek) job.readCursor = job.buffer.length;
  return chunk;
}

/** Kill a job's process (SIGTERM, then SIGKILL after a grace period). */
export function killJob(job: BashJob): { ok: boolean; alreadyDone: boolean } {
  if (job.status !== 'running') return { ok: true, alreadyDone: true };
  try {
    killProcessTree(job.child, 'SIGTERM');
  } catch {
    /* fallthrough to SIGKILL */
  }
  setTimeout(() => {
    // NOTE: `job.status` is flipped to 'killed' below, SYNCHRONOUSLY, right after
    // the SIGTERM is sent — well before the process has actually exited. That
    // flip reflects kill-INTENT (a caller checking status should see "killed" as
    // soon as the kill is requested), not actual process death, so it must NOT be
    // used to decide whether the SIGKILL escalation is still needed: checking
    // `job.status === 'running'` here is always false and would silently make
    // this fallback dead code, defeating the grace-period safety net for a
    // process that ignores/survives SIGTERM. `exitCode` is set only by the real
    // `close` handler once the OS confirms the process has actually terminated —
    // that is the correct liveness signal for this guard.
    if (job.exitCode === null) {
      try { killProcessTree(job.child, 'SIGKILL'); } catch { /* ignore */ }
    }
  }, 2_000);
  job.status = 'killed';
  return { ok: true, alreadyDone: false };
}

/** Drop the oldest FINISHED jobs once we exceed the retention cap. Running jobs
 *  are never evicted. */
function pruneFinished(): void {
  if (JOBS.size <= MAX_RETAINED_JOBS) return;
  const finished = [...JOBS.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (const j of finished) {
    if (JOBS.size <= MAX_RETAINED_JOBS) break;
    JOBS.delete(j.id);
  }
}

/** Test-only: clear the registry. */
export function __resetBashJobs(): void {
  for (const j of JOBS.values()) {
    try { j.child.kill('SIGKILL'); } catch { /* ignore */ }
    try { j.logStream?.end(); } catch { /* ignore */ }
  }
  JOBS.clear();
}

function headTail(s: string): string {
  const half = Math.floor(INLINE_OUTPUT_CAP / 2);
  const head = s.slice(0, half);
  const tail = s.slice(s.length - half);
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n… [${omitted} chars omitted — full output in the log file] …\n\n${tail}`;
}

function safeWriteStream(path: string): WriteStream | null {
  try {
    return createWriteStream(path, { flags: 'w' });
  } catch {
    return null;
  }
}

function cryptoRandomId(): string {
  return crypto.randomUUID().slice(0, 12);
}
