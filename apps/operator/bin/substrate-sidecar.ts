#!/usr/bin/env node
/**
 * Substrate process-isolation sidecar.
 *
 * Thin entrypoint: a JSON-RPC 2.0 server over a Unix socket + the child-process
 * IPC handle channel, dispatching to the testable host in operator-core
 * (`substrate-sidecar-host.ts`). All store ownership + the RPC method
 * implementations live there so they unit-test without spawning this process.
 *
 * Two channels, by design:
 *   1. JSON-RPC over the Unix socket — control + metadata (boot, append, token
 *      allocation, attach confirmation, observability). Reliable, line-framed.
 *   2. The Node child_process IPC channel — out-of-band Duplex *handle* transfer
 *      (`process.on('message', (msg, handle))`). A peer socket accepted by the
 *      main process is handed here via `subprocess.send(msg, socket)`; the host's
 *      `prepareSocketHandoff` / `attachSocket` correlate the handle to a store by
 *      a single-use token.
 *
 * Reached ONLY when the OFF-by-default `papercusp-substrate-sidecar` flag is ON.
 *
 * Environment:
 *   PAPERCUSP_SUBSTRATE_IPC_SOCKET — Unix socket path (default: .papercusp/substrate.sock)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import { createSubstrateSidecarHost } from '@papercusp/operator-core/lib/sync/hyperbee/substrate-sidecar-host';

const host = createSubstrateSidecarHost();

// JSON-RPC 2.0 response builders
function rpcResponse(result: unknown, id: number | string | null): object {
  if (id === null) return {}; // Notification
  return { jsonrpc: '2.0', result, id };
}
function rpcError(code: number, message: string, id: number | string | null, data?: unknown): object {
  if (id === null) return {}; // Notification
  return { jsonrpc: '2.0', error: { code, message, ...(data ? { data } : {}) }, id };
}

async function handleRequest(data: string, callback: (response: string) => void): Promise<void> {
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
function registerHandleListener(): void {
  if (typeof process.send !== 'function') return; // no IPC channel
  process.on('message', (message: unknown, handle: unknown) => {
    const m = message as { kind?: string; handoffToken?: string } | null;
    if (!m || m.kind !== 'substrate:socketHandle' || typeof m.handoffToken !== 'string') return;
    host.receiveHandle(m.handoffToken, handle as Duplex);
  });
}

function startServer(): void {
  const socketPath = process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET || '.papercusp/substrate.sock';
  const socketDir = path.dirname(socketPath);

  if (!fs.existsSync(socketDir)) fs.mkdirSync(socketDir, { recursive: true });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  registerHandleListener();

  const server = net.createServer((socket: net.Socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          void handleRequest(line, (response) => {
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

startServer();
