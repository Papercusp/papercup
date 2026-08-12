/**
 * The spawner sidecar's generic "run a process and give me its output" seam,
 * behind the `process:exec` JSON-RPC method.
 *
 * Lives in its OWN module rather than inside spawner-sidecar-server.ts so it can
 * be tested against real `git` without importing the server, which pulls in
 * `spawnInvokeOnce` (the whole orchestrator-runner chain) purely to serve a
 * different RPC method. Nothing here knows about agent spawning.
 *
 * ## The fd handoff (WI-6404)
 *
 * `process:exec` originally piped stdout and returned it as a STRING on the
 * line-delimited JSON reply. That is fine for plumbing output (oids, refs,
 * `rev-parse`), and wrong for the `git cat-file --batch` seam, which carries
 * multi-MB blob CONTENTS whose exact byte offsets are load-bearing — frames are
 * `<oid> SP <type> SP <size> LF <contents> LF`, so a single shifted byte
 * desynchronises the whole stream.
 *
 * Sending those bytes inline would mean base64 (+33%, plus JSON escaping) and a
 * multi-MB `JSON.parse` on the MAIN THREAD at both ends — plausibly a bigger
 * stall than the ~165ms fork the sidecar exists to remove, which would defeat
 * the point entirely. So `stdinPath`/`stdoutPath` hand real FILE DESCRIPTORS to
 * the child instead: git reads and writes them at kernel level, the bytes never
 * enter this process or the JSON channel, and byte fidelity is structural
 * rather than promised.
 */
import * as fsp from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { spawn, type StdioOptions } from 'node:child_process';

export interface ExecParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Optional no-output deadline. Unlike `timeoutMs` (the absolute hard
   * ceiling), this timer refreshes whenever stdout/stderr advances. */
  idleTimeoutMs?: number;
  timeoutMs?: number;
  /**
   * FD HANDOFF, input leg. When set, the child's stdin IS this file: the sidecar
   * opens it and passes the fd as `stdio[0]`, so the child reads it directly.
   * Absent ⇒ stdin is `'ignore'`, exactly as before.
   */
  stdinPath?: string;
  /**
   * FD HANDOFF, output leg. When set, the child's stdout is written STRAIGHT to
   * this file (see the module header for why). Absent ⇒ stdout is piped and
   * accumulated into `stdout`, exactly as before.
   */
  stdoutPath?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Bytes the child wrote to `stdoutPath` (fd-handoff mode only), so the
   *  caller can cross-check the file it reads back against what git produced. */
  stdoutBytes?: number;
}

export async function execProcess(params: ExecParams): Promise<ExecResult> {
  // Open the handoff files BEFORE spawning: a bad path must come back as a
  // normal non-zero result the caller can fall back from, never a thrown RPC
  // error (every caller's contract is degrade-to-local, not fail).
  let stdinHandle: fsp.FileHandle | undefined;
  let stdoutHandle: fsp.FileHandle | undefined;
  try {
    if (params.stdinPath) stdinHandle = await fsp.open(params.stdinPath, 'r');
    if (params.stdoutPath) stdoutHandle = await fsp.open(params.stdoutPath, 'w');
  } catch (e) {
    await stdinHandle?.close().catch(() => {});
    await stdoutHandle?.close().catch(() => {});
    return { code: -1, stdout: '', stderr: `spawner sidecar could not open a handoff file: ${String(e)}` };
  }

  const result = await new Promise<ExecResult>((resolve) => {
    const stdio: StdioOptions = [
      stdinHandle ? stdinHandle.fd : 'ignore',
      stdoutHandle ? stdoutHandle.fd : 'pipe',
      'pipe',
    ];
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio,
    });
    // Decode across chunk boundaries: a multi-byte UTF-8 character split between
    // two `data` events decodes to replacement chars under a plain
    // `String(chunk)`, silently corrupting output (e.g. a non-ASCII author or
    // subject in `git log`). StringDecoder holds the partial sequence back.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminating = false;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = (): void => {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ code, stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end() });
    };
    const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 0;
    const idleTimeoutMs = params.idleTimeoutMs && params.idleTimeoutMs > 0 ? params.idleTimeoutMs : 0;
    const terminate = (reason: string): void => {
      if (settled || terminating) return;
      terminating = true;
      clearTimers();
      stderr += `${stderr ? '\n' : ''}${params.command} ${(params.args ?? []).join(' ')} ${reason} — killed by the spawner sidecar guard`;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.();
      setTimeout(() => finish(-1), 20_000).unref?.();
    };
    const armIdleTimer = (): void => {
      if (idleTimeoutMs <= 0 || settled || terminating) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => terminate(`made no output progress for ${idleTimeoutMs}ms`),
        idleTimeoutMs,
      );
      idleTimer.unref?.();
    };
    if (timeoutMs > 0) {
      hardTimer = setTimeout(
        () => terminate(`timed out after ${timeoutMs}ms`),
        timeoutMs,
      );
      hardTimer.unref?.();
    }
    armIdleTimer();
    // In fd-handoff mode `child.stdout` is null — git writes to the file itself.
    child.stdout?.on('data', (d: Buffer) => {
      stdout += outDecoder.write(d);
      armIdleTimer();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += errDecoder.write(d);
      armIdleTimer();
    });
    child.on('error', (e) => {
      stderr += String(e);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });

  // Size the output BEFORE closing, so the caller can detect a short read.
  let stdoutBytes: number | undefined;
  if (stdoutHandle) {
    try {
      stdoutBytes = (await stdoutHandle.stat()).size;
    } catch {
      /* An fstat failure just means no cross-check is offered. */
    }
  }
  await stdinHandle?.close().catch(() => {});
  await stdoutHandle?.close().catch(() => {});
  return stdoutBytes === undefined ? result : { ...result, stdoutBytes };
}
