/**
 * Substrate sidecar JSON-RPC server (extracted from
 * apps/operator/bin/substrate-sidecar.ts, P-006).
 *
 * The Unix-socket JSON-RPC server + child-process IPC handle channel that fronts
 * the testable host (substrate-sidecar-host.ts). It lives in operator-core (NOT
 * the bin) so the SAME code can be started two ways without the esbuild trap that
 * an auto-running bin guard would spring — esbuild bundles every module into the
 * single serve.mjs, so a bin's `import.meta.url === argv[1]` guard would resolve
 * TRUE on every operator boot and start a stray sidecar in the main process:
 *   - DEV     : apps/operator/bin/substrate-sidecar.ts (run via tsx) calls it.
 *   - PACKAGED: serve.ts diverts here under PAPERCUSP_SUBSTRATE_SIDECAR_MODE=1
 *     (the spawner re-execs serve.mjs itself — the packaged operator ships no
 *     separate bin to tsx).
 *
 * No top-level side effects: importing this module never starts a server; only
 * runSubstrateSidecarServer() does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import {
  createSubstrateSidecarHost,
  type SubstrateSidecarHost,
} from './substrate-sidecar-host';
import { resolveSubstrateSocketPath } from './substrate-socket-path';

// JSON-RPC 2.0 response builders
function rpcResponse(result: unknown, id: number | string | null): object {
  if (id === null) return {}; // Notification
  return { jsonrpc: '2.0', result, id };
}
function rpcError(code: number, message: string, id: number | string | null, data?: unknown): object {
  if (id === null) return {}; // Notification
  return { jsonrpc: '2.0', error: { code, message, ...(data ? { data } : {}) }, id };
}

async function handleRequest(
  host: SubstrateSidecarHost,
  data: string,
  callback: (response: string) => void,
): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(data);
  } catch {
    callback(JSON.stringify(rpcError(-32700, 'Parse error', null)));
    return;
  }
  const req = request as { jsonrpc?: string; method?: string; params?: unknown; id?: number | string | null };
  if (!req.method) {
    callback(JSON.stringify(rpcError(-32600, 'Invalid Request', req.id ?? null)));
    return;
  }
  const handler = host.methods[req.method];
  if (!handler) {
    callback(JSON.stringify(rpcError(-32601, 'Method not found', req.id ?? null)));
    return;
  }
  try {
    const result = await handler(req.params);
    callback(JSON.stringify(rpcResponse(result, req.id ?? null)));
  } catch (e) {
    const err = e as { code?: number; message?: string; data?: unknown };
    const code = typeof err.code === 'number' ? err.code : -32603;
    const msg = err.message ?? 'Internal error';
    callback(JSON.stringify(rpcError(code, msg, req.id ?? null, err.data)));
  }
}

/** Receive Duplex handles transferred from the main process over the child IPC
 *  channel. No-op when launched without an IPC channel (control methods still
 *  work). */
function registerHandleListener(host: SubstrateSidecarHost): void {
  if (typeof process.send !== 'function') return; // no IPC channel
  process.on('message', (message: unknown, handle: unknown) => {
    const m = message as { kind?: string; handoffToken?: string } | null;
    if (!m || m.kind !== 'substrate:socketHandle' || typeof m.handoffToken !== 'string') return;
    host.receiveHandle(m.handoffToken, handle as Duplex);
  });
}

/**
 * Start the substrate sidecar JSON-RPC server (control socket + IPC handle
 * channel) and own the process lifecycle (SIGTERM/SIGINT → host.closeAll). The
 * socket path is ABSOLUTE (resolveSubstrateSocketPath()) — never CWD-relative.
 */
export function runSubstrateSidecarServer(): void {
  const host = createSubstrateSidecarHost();
  const socketPath = resolveSubstrateSocketPath();
  const socketDir = path.dirname(socketPath);

  if (!fs.existsSync(socketDir)) fs.mkdirSync(socketDir, { recursive: true });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  registerHandleListener(host);

  const server = net.createServer((socket: net.Socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          void handleRequest(host, line, (response) => {
            socket.write(response + '\n');
          });
        }
      }
    });
    socket.on('error', (err) => console.error('[socket-error]', err.message));
    socket.on('end', () => {
      // Control socket closed.
    });
  });

  server.listen(socketPath, () => {
    console.log(`[substrate-sidecar] listening on ${socketPath}`);
    console.log(`PAPERCUSP_SUBSTRATE_READY socket=${socketPath}`);
  });

  server.on('error', (err) => {
    console.error('[server-error]', err.message);
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    console.log(`[substrate-sidecar] ${signal} received, shutting down gracefully`);
    void host.closeAll().finally(() => server.close(() => process.exit(0)));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
