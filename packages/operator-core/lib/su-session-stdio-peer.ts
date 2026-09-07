/** PUI's pipe transport for the native Codex and OMP RPC servers. The native
 * process still owns inference/tools/history; the existing task manager owns
 * its process tree. No terminal, shell quoting, or provider loop is involved. */
import { randomUUID } from 'node:crypto';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { startSupervisorBeat } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { managedSpawn } from './task-manager/managed-spawn';
import { killTask } from './task-manager/control';
import type { TaskSpec } from './task-manager/types';

export type RpcFrame = Record<string, unknown>;
export interface SuStdioPeer {
  request(frame: RpcFrame, timeoutMs?: number): Promise<RpcFrame>;
  send(frame: RpcFrame): void;
  done: Promise<void>;
  close(): Promise<void>;
  pid(): number | null;
}
export interface SuStdioPeerOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workspaceId: string;
  spec: TaskSpec;
  ownerId: string;
  onMessage(frame: RpcFrame): void;
}

export async function startSuStdioPeer(options: SuStdioPeerOptions): Promise<SuStdioPeer> {
  const { child, taskId } = await managedSpawn(options.binary, options.args, options.spec, {
    workspaceId: options.workspaceId,
    spawnOptions: { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] },
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Structured engine has no protocol pipes');
  const pending = new Map<string, { resolve(value: RpcFrame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;
  let exited = false;
  let buffer = '';
  let heartbeat: ManagedHandle | undefined;
  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // Startup can fail before the caller receives this peer. Keep the rejection
  // observed while preserving it for the engine's lifecycle supervisor.
  void done.catch(() => undefined);
  function rejectPending(error: Error): void {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  function fail(error: Error): void {
    rejectPending(error);
    rejectExit(error);
    void close().catch((failure) => console.warn('[su-session] protocol teardown failed', failure));
  }
  function send(frame: RpcFrame): void {
    if (closed || exited || child.stdin!.destroyed) throw new Error('Structured engine connection is closed');
    child.stdin!.write(`${JSON.stringify(frame)}\n`, (error) => { if (error) fail(error); });
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    // A corrupt peer must fail visibly, never retain an unbounded partial frame.
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { fail(new Error('Structured engine frame exceeds 16 MiB')); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as RpcFrame;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Structured engine emitted a non-object frame');
        const id = frame.id == null ? null : String(frame.id);
        const response = frame.type === 'response' || (!frame.method && ('result' in frame || 'error' in frame));
        const request = id && response ? pending.get(id) : undefined;
        if (request && id) {
          pending.delete(id); clearTimeout(request.timer);
          if (frame.success === false || frame.error) {
            const error = frame.error;
            request.reject(new Error(typeof error === 'string' ? error : JSON.stringify(error)));
          } else request.resolve((frame.result ?? frame.data ?? {}) as RpcFrame);
        } else options.onMessage(frame);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
    }
  });
  // Diagnostics must never fill stderr and block the protocol. User-facing
  // errors come from the structured response, not an unredacted process log.
  child.stderr.on('data', () => undefined);
  child.on('error', fail);
  child.once('close', (code, signal) => {
    exited = true; heartbeat?.stop();
    rejectPending(new Error('Structured engine exited before acknowledging the request'));
    if (closed || (code === 0 && !signal)) resolveExit();
    else rejectExit(new Error(`Structured engine exited (${signal ?? code ?? 'unknown'})`));
  });
  if (child.pid) startSupervisorBeat(options.ownerId, {
    pid: child.pid, operatorUrl: options.env.PAPERCUSP_OPERATOR_URL,
    onTerminalSession: () => { void close().catch((error) => console.warn('[su-session] terminal cleanup failed', error)); },
    setIntervalImpl: (callback: () => void, ms: number) => {
      heartbeat = managedSetInterval('su-session-engine-heartbeat', ms, callback, { category: 'liveness', instanced: true });
      return {};
    },
  });
  async function waitForExit(ms: number): Promise<boolean> {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([new Promise<void>((resolve) => child.once('close', resolve)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
      return exited;
    } finally { clearTimeout(timer!); }
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; heartbeat?.stop();
    rejectPending(new Error('Structured engine closed before acknowledgement'));
    child.stdin!.end();
    closing = (async () => {
      if (await waitForExit(5_000)) return;
      const result = await killTask(taskId, { signal: 'SIGKILL', includeSubtree: true, reapTerminalResidue: true });
      if (!result.ok && result.error !== 'already_gone') throw new Error(`Structured engine teardown failed: ${result.error}`);
      if (!(await waitForExit(5_000))) throw new Error('Structured engine did not exit after tracked teardown');
    })();
    return closing;
  }
  return {
    send, done, close, pid: () => child.pid ?? null,
    request(frame, timeoutMs = 45_000) {
      const id = `pui-${randomUUID()}`;
      return new Promise<RpcFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Structured engine acknowledgement timed out; delivery is unknown, do not replay automatically'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ ...frame, id }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
  };
}
