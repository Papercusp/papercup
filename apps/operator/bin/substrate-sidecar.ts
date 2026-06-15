#!/usr/bin/env node
/**
 * Substrate process isolation sidecar (P-009).
 *
 * JSON-RPC 2.0 server over Unix socket. Decouples corestores + Hyperswarm
 * natives + GC pauses from the main operator, freeing it from event-loop
 * blocking and per-harness RSS overhead.
 *
 * Usage: node substrate-sidecar.ts
 *
 * Environment:
 *   PAPERCUSP_SUBSTRATE_IPC_SOCKET — Unix socket path (default: .papercusp/substrate.sock)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { EventEmitter } from 'node:events';

// JSON-RPC 2.0 method handlers
interface RpcContext {
  storeMap: Map<string, { workspaceId: string; harnessSlug: string }>;
  nextStoreId: number;
}

const ctx: RpcContext = {
  storeMap: new Map(),
  nextStoreId: 1,
};

// JSON-RPC 2.0 response builder
function rpcResponse(result: unknown, id: number | string | null): object {
  if (id === null) return {}; // Notification
  return {
    jsonrpc: '2.0',
    result,
    id,
  };
}

function rpcError(code: number, message: string, id: number | string | null, data?: unknown): object {
  if (id === null) return {}; // Notification
  return {
    jsonrpc: '2.0',
    error: { code, message, ...(data && { data }) },
    id,
  };
}

// RPC method implementations (Phase 1 scope)

function handleHealthz(): unknown {
  return {
    status: 'ready',
    uptime_ms: process.uptime() * 1000,
    timestamp: new Date().toISOString(),
  };
}

interface OpenStoreRequest {
  workspaceId: string;
  harnessSlug: string;
}

function handleOpenStore(params: unknown): unknown {
  const p = params as OpenStoreRequest;
  if (!p.workspaceId || !p.harnessSlug) {
    throw new Error('Missing workspaceId or harnessSlug');
  }

  const key = `${p.workspaceId}::${p.harnessSlug}`;
  const existing = [...ctx.storeMap.entries()].find(([_, v]) => {
    const mapKey = `${v.workspaceId}::${v.harnessSlug}`;
    return mapKey === key;
  });

  if (existing) {
    return { storeId: existing[0], isNew: false };
  }

  const storeId = `store-${ctx.nextStoreId++}`;
  ctx.storeMap.set(storeId, { workspaceId: p.workspaceId, harnessSlug: p.harnessSlug });
  return { storeId, isNew: true };
}

interface CloseStoreRequest {
  storeId: string;
}

function handleCloseStore(params: unknown): unknown {
  const p = params as CloseStoreRequest;
  ctx.storeMap.delete(p.storeId);
  return { ok: true };
}

interface GetStoreStatusRequest {
  storeId: string;
}

function handleGetStoreStatus(params: unknown): unknown {
  const p = params as GetStoreStatusRequest;
  const store = ctx.storeMap.get(p.storeId);
  if (!store) {
    throw new Error('Store not found');
  }

  return {
    isOpen: true,
    ownLogLength: 0, // Phase 1: placeholder
    admittedPeerCount: 0, // Phase 1: placeholder
    lastMergeAt: null,
  };
}

interface BootHarnessRequest {
  workspaceId: string;
  harnessSlug: string;
  swarmBinding?: { kind: string; value: string };
}

function handleBootHarness(params: unknown): unknown {
  const p = params as BootHarnessRequest;
  const openStoreResult = handleOpenStore({
    workspaceId: p.workspaceId,
    harnessSlug: p.harnessSlug,
  });

  return {
    storeId: (openStoreResult as { storeId: string }).storeId,
    swarmTopicHex: 'a1b2c3', // Phase 1: placeholder
    ownLogKey: 'log-key-hex', // Phase 1: placeholder
    mergeLoopStarted: true,
  };
}

interface OnAnnounceRequest {
  storeId: string;
  announce: {
    logKey: string;
    logSeq: number;
    signature: string;
    timestamp: string;
  };
}

function handleOnAnnounce(params: unknown): unknown {
  const p = params as OnAnnounceRequest;
  // Phase 1: simple admit decision
  return {
    decision: 'admit',
    remoteLogKey: (p.announce as { logKey: string }).logKey,
  };
}

interface TriggerMergeNowRequest {
  storeId: string;
}

function handleTriggerMergeNow(params: unknown): unknown {
  const p = params as TriggerMergeNowRequest;
  // Phase 1: no-op merge
  return {
    mergedOps: 0,
    durationMs: 0,
  };
}

interface GetMergeStatusRequest {
  storeId: string;
}

function handleGetMergeStatus(params: unknown): unknown {
  const p = params as GetMergeStatusRequest;
  return {
    lastMergeAt: null,
    lastMergeDurationMs: 0,
    totalOpsProcessed: 0,
    admittedPeerCount: 0,
    nextMergeIn: 1000,
  };
}

interface GetAdmittedLogsRequest {
  storeId: string;
}

function handleGetAdmittedLogs(params: unknown): unknown {
  const p = params as GetAdmittedLogsRequest;
  // Phase 1: empty list
  return {
    logs: [],
  };
}

// Dispatch table
const methods: Record<string, (params: unknown) => unknown> = {
  'sidecar:healthz': () => handleHealthz(),
  'substrate:openStore': handleOpenStore,
  'substrate:closeStore': handleCloseStore,
  'substrate:getStoreStatus': handleGetStoreStatus,
  'substrate:bootHarness': handleBootHarness,
  'substrate:onAnnounce': handleOnAnnounce,
  'substrate:triggerMergeNow': handleTriggerMergeNow,
  'substrate:getMergeStatus': handleGetMergeStatus,
  'substrate:getAdmittedLogs': handleGetAdmittedLogs,
};

// JSON-RPC 2.0 request handler
function handleRequest(
  data: string,
  callback: (response: string) => void,
): void {
  let request: unknown;
  try {
    request = JSON.parse(data);
  } catch (e) {
    callback(
      JSON.stringify(rpcError(-32700, 'Parse error', null)),
    );
    return;
  }

  const req = request as { jsonrpc?: string; method?: string; params?: unknown; id?: number | string | null };

  if (!req.method) {
    callback(
      JSON.stringify(rpcError(-32600, 'Invalid Request', req.id ?? null)),
    );
    return;
  }

  const handler = methods[req.method];
  if (!handler) {
    callback(
      JSON.stringify(rpcError(-32601, 'Method not found', req.id ?? null)),
    );
    return;
  }

  try {
    const result = handler(req.params);
    callback(JSON.stringify(rpcResponse(result, req.id ?? null)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal error';
    callback(
      JSON.stringify(rpcError(-32603, msg, req.id ?? null)),
    );
  }
}

// Unix socket server
function startServer(): void {
  const socketPath = process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET || '.papercusp/substrate.sock';
  const socketDir = path.dirname(socketPath);

  // Ensure socket directory exists
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }

  // Clean up stale socket
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const server = net.createServer((socket: net.Socket) => {
    let buffer = '';

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Simple line-based protocol: one JSON-RPC 2.0 per line
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line) {
          handleRequest(line, (response) => {
            socket.write(response + '\n');
          });
        }
      }
    });

    socket.on('error', (err) => {
      console.error('[socket-error]', err.message);
    });

    socket.on('end', () => {
      // Socket closed
    });
  });

  server.listen(socketPath, () => {
    console.log(`[substrate-sidecar] listening on ${socketPath}`);
    // Print handshake for parent process (Tauri sidecar protocol)
    console.log(`PAPERCUSP_SUBSTRATE_READY socket=${socketPath}`);
  });

  server.on('error', (err) => {
    console.error('[server-error]', err.message);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[substrate-sidecar] shutting down gracefully');
    server.close(() => {
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('[substrate-sidecar] interrupted');
    server.close(() => {
      process.exit(0);
    });
  });
}

startServer();
