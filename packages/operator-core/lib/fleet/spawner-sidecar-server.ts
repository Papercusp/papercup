/**
 * Spawner sidecar JSON-RPC server (WI-344 ③, plan spawner-sidecar-offload-2026-06-30).
 *
 * Cloned from sync/hyperbee/substrate-sidecar-server.ts. The Unix-socket JSON-RPC
 * server that fronts the REAL agent-spawn chokepoint (`spawnInvokeOnce`, imported
 * from ../dbos/orchestrator-runner) — relocated OFF the bg-host main event loop so
 * the `child_process.spawn` of bee/queen children + the synchronous
 * `buildInvokeOnce` stop saturating routinesTick.
 *
 * It lives in operator-core (NOT the bin) so the SAME code can start two ways
 * without the esbuild trap an auto-running bin guard would spring (esbuild bundles
 * every module into serve.mjs, so a bin's `import.meta.url === argv[1]` guard would
 * resolve TRUE on every operator boot and start a stray sidecar in the main
 * process):
 *   - DEV     : apps/operator/bin/spawner-sidecar.ts (run via tsx) calls it.
 *   - PACKAGED: serve.ts diverts here under PAPERCUSP_SPAWNER_SIDECAR_MODE=1.
 *
 * No top-level side effects: importing this module never starts a server; only
 * runSpawnerSidecarServer() does. Reached ONLY when the OFF-by-default
 * `papercusp-spawner-sidecar` flag is ON.
 *
 * ── Protocol ──
 * Request  `spawn:invokeOnce` { projectDir, role, extras, extraEnv, timeoutMs?,
 *            resultPath?, forceSessionId? } → runs the real spawnInvokeOnce; while
 *            in flight it PUSHES (server→client notifications, no id):
 *              `spawn:pid`            { requestId, pid }
 *              `spawn:outputActivity` { requestId }
 *            then replies with the SpawnInvokeOnceResult.
 * Request  `spawn:cancel`     { requestId } → aborts that request's AbortController.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { spawnInvokeOnce, type SpawnInvokeOnceResult } from '../dbos/orchestrator-runner';
import { resolveSpawnerSocketPath } from './spawner-socket-path';

// JSON-RPC 2.0 response builders
function rpcResult(result: unknown, id: number | string): object {
  return { jsonrpc: '2.0', result, id };
}
function rpcError(code: number, message: string, id: number | string | null, data?: unknown): object {
  if (id === null) return {}; // can't reply to a parse-failed request with no id
  return { jsonrpc: '2.0', error: { code, message, ...(data ? { data } : {}) }, id };
}
function rpcNotification(method: string, params: unknown): object {
  // A JSON-RPC NOTIFICATION carries NO id — the client routes it to per-request
  // push callbacks via params.requestId.
  return { jsonrpc: '2.0', method, params };
}

interface InvokeOnceParams {
  projectDir: string;
  role: string;
  extras: string[];
  extraEnv: Record<string, string>;
  timeoutMs?: number;
  resultPath?: string;
  forceSessionId?: string;
}

interface ExecParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

function execProcess(params: ExecParams): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 0;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            stderr += `${stderr ? '\n' : ''}${params.command} ${(params.args ?? []).join(' ')} timed out after ${timeoutMs}ms — killed by the spawner sidecar guard`;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.();
            setTimeout(() => finish(-1), 20_000).unref?.();
          }, timeoutMs)
        : null;
    timer?.unref?.();
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      stderr += String(e);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

/**
 * Start the spawner sidecar JSON-RPC server on the (ABSOLUTE) socket and own the
 * process lifecycle (SIGTERM/SIGINT → close). Prints PAPERCUSP_SPAWNER_READY once
 * listening so the parent spawnSpawnerSidecar() handshake completes.
 */
export function runSpawnerSidecarServer(): void {
  const socketPath = resolveSpawnerSocketPath();
  const socketDir = path.dirname(socketPath);

  if (!fs.existsSync(socketDir)) fs.mkdirSync(socketDir, { recursive: true });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  // requestId → AbortController for the in-flight spawn it owns, so `spawn:cancel`
  // can stop it. Keyed by the client's per-request JSON-RPC id (single-client v1).
  const controllers = new Map<number | string, AbortController>();

  const server = net.createServer((socket: net.Socket) => {
    const write = (obj: object): void => {
      socket.write(JSON.stringify(obj) + '\n');
    };

    const handleLine = async (line: string): Promise<void> => {
      let req: { jsonrpc?: string; method?: string; params?: unknown; id?: number | string | null };
      try {
        req = JSON.parse(line);
      } catch {
        write(rpcError(-32700, 'Parse error', null));
        return;
      }
      const id = req.id ?? null;
      if (!req.method) {
        write(rpcError(-32600, 'Invalid Request', id));
        return;
      }

      if (req.method === 'spawn:invokeOnce') {
        if (id === null) {
          write(rpcError(-32600, 'spawn:invokeOnce requires an id', null));
          return;
        }
        const p = (req.params ?? {}) as InvokeOnceParams;
        const controller = new AbortController();
        controllers.set(id, controller);
        try {
          const result: SpawnInvokeOnceResult = await spawnInvokeOnce(
            p.projectDir,
            p.role,
            p.extras,
            p.extraEnv,
            {
              signal: controller.signal,
              timeoutMs: p.timeoutMs,
              resultPath: p.resultPath,
              forceSessionId: p.forceSessionId,
              onChildPid: (pid) => write(rpcNotification('spawn:pid', { requestId: id, pid })),
              onOutputActivity: () => write(rpcNotification('spawn:outputActivity', { requestId: id })),
            },
          );
          write(rpcResult(result, id));
        } catch (e) {
          const err = e as { message?: string };
          write(rpcError(-32603, err.message ?? 'Internal error', id));
        } finally {
          controllers.delete(id);
        }
        return;
      }

      if (req.method === 'process:exec') {
        if (id === null) {
          write(rpcError(-32600, 'process:exec requires an id', null));
          return;
        }
        try {
          const result = await execProcess((req.params ?? {}) as ExecParams);
          write(rpcResult(result, id));
        } catch (e) {
          const err = e as { message?: string };
          write(rpcError(-32603, err.message ?? 'Internal error', id));
        }
        return;
      }

      if (req.method === 'spawn:cancel') {
        const p = (req.params ?? {}) as { requestId?: number | string };
        const controller = p.requestId != null ? controllers.get(p.requestId) : undefined;
        if (controller) controller.abort();
        if (id !== null) write(rpcResult({ cancelled: !!controller }, id));
        return;
      }

      write(rpcError(-32601, 'Method not found', id));
    };

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) void handleLine(line);
      }
    });
    socket.on('error', (err) => console.error('[spawner-socket-error]', err.message));
    socket.on('end', () => {
      // Control socket closed.
    });
  });

  server.listen(socketPath, () => {
    console.log(`[spawner-sidecar] listening on ${socketPath}`);
    console.log(`PAPERCUSP_SPAWNER_READY socket=${socketPath}`);
  });

  server.on('error', (err) => {
    console.error('[spawner-server-error]', err.message);
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    console.log(`[spawner-sidecar] ${signal} received, shutting down gracefully`);
    for (const controller of controllers.values()) controller.abort();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
