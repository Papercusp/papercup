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
 *
 * Two channels, by design (WI-157 post 45562):
 *   1. JSON-RPC over the Unix socket — control + metadata (token allocation,
 *      attach confirmation, observability). Reliable, line-framed.
 *   2. The Node child_process IPC channel — out-of-band Duplex *handle* transfer
 *      (`process.on('message', (msg, handle))`). A peer socket accepted by the
 *      main process is handed to this sidecar over the IPC channel via
 *      `subprocess.send(msg, socket)`; the JSON-RPC `prepareSocketHandoff` /
 *      `attachSocket` pair correlates the handle to a store by a single-use token.
 *
 * Phase 2 (WI-178): peer socket handoff + corestore-backed stores so an attached
 * socket actually drives `corestore.replicate(...)` inside the sidecar — the
 * federation path crossing the process boundary.
 */

import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import Corestore from 'corestore';

/**
 * Minimal Hypercore surface used by the observability methods. corestore's
 * `.get()` return type is loosely typed across builds; we pin only the members
 * we touch so tsc stays honest without an `any`.
 */
interface HypercoreLike {
  ready(): Promise<void>;
  update(opts?: { wait?: boolean }): Promise<unknown>;
  get(index: number, opts?: { wait?: boolean }): Promise<Buffer>;
  download(range: { start: number; end: number }): { done(): Promise<void> } | Promise<void>;
  length: number;
  byteLength: number;
  key: Buffer;
}

/** One opened corestore + its live replication connections. */
interface StoreRecord {
  workspaceId: string;
  harnessSlug: string;
  storagePath: string;
  store: Corestore | null;
  connections: Set<string>;
}

/** A pending socket handoff awaiting its out-of-band handle (Phase 2). */
interface HandoffEntry {
  storeId: string;
  peerId?: string;
  /** The Duplex handle once it arrives over the child IPC channel. */
  handle: Duplex | null;
  /** Single-use guard: attachSocket consumes it exactly once. */
  used: boolean;
  createdAt: number;
  /** Resolver set by attachSocket when it arrives before the handle does. */
  onHandle: ((handle: Duplex) => void) | null;
}

interface RpcContext {
  storeMap: Map<string, StoreRecord>;
  nextStoreId: number;
  nextConnId: number;
  handoffs: Map<string, HandoffEntry>;
  nextHandoffId: number;
}

const ctx: RpcContext = {
  storeMap: new Map(),
  nextStoreId: 1,
  nextConnId: 1,
  handoffs: new Map(),
  nextHandoffId: 1,
};

/** How long attachSocket waits for the out-of-band handle to arrive. */
const HANDOFF_HANDLE_TIMEOUT_MS = 10_000;
/** Idle prepared handoffs expire so a never-completed token can't leak. */
const HANDOFF_TTL_MS = 60_000;

/** JSON-RPC error carrying a specific code (defaults to -32603 otherwise). */
class RpcMethodError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'RpcMethodError';
  }
}

// JSON-RPC 2.0 response builders
function rpcResponse(result: unknown, id: number | string | null): object {
  if (id === null) return {}; // Notification
  return { jsonrpc: '2.0', result, id };
}

function rpcError(code: number, message: string, id: number | string | null, data?: unknown): object {
  if (id === null) return {}; // Notification
  return {
    jsonrpc: '2.0',
    error: { code, message, ...(data ? { data } : {}) },
    id,
  };
}

// ─── store path resolution ──────────────────────────────────────────────────

interface OpenStoreRequest {
  workspaceId: string;
  harnessSlug: string;
  /** Override the workspace root used to derive the storage path. */
  workspaceRoot?: string;
  /** Explicit storage dir (wins over workspaceRoot). Used by tests + callers
   *  that already resolved the per-harness hyperbee path. */
  storagePath?: string;
}

/** Mirror corestore.ts: `<workspaceRoot>/.papercusp/<harness>/hyperbee`. */
function resolveStoragePath(p: OpenStoreRequest): string {
  if (p.storagePath) return p.storagePath;
  const workspaceRoot = p.workspaceRoot || process.cwd();
  return path.join(workspaceRoot, '.papercusp', p.harnessSlug, 'hyperbee');
}

// ─── RPC method implementations ─────────────────────────────────────────────

function handleHealthz(): unknown {
  return {
    status: 'ready',
    uptime_ms: process.uptime() * 1000,
    timestamp: new Date().toISOString(),
  };
}

async function handleOpenStore(params: unknown): Promise<unknown> {
  const p = params as OpenStoreRequest;
  if (!p.workspaceId || !p.harnessSlug) {
    throw new RpcMethodError(-32602, 'Missing workspaceId or harnessSlug');
  }

  const key = `${p.workspaceId}::${p.harnessSlug}`;
  for (const [id, rec] of ctx.storeMap) {
    if (`${rec.workspaceId}::${rec.harnessSlug}` === key) {
      return { storeId: id, isNew: false };
    }
  }

  const storagePath = resolveStoragePath(p);
  await mkdir(storagePath, { recursive: true });
  const store = new Corestore(storagePath);
  await store.ready();

  const storeId = `store-${ctx.nextStoreId++}`;
  ctx.storeMap.set(storeId, {
    workspaceId: p.workspaceId,
    harnessSlug: p.harnessSlug,
    storagePath,
    store,
    connections: new Set(),
  });
  return { storeId, isNew: true };
}

interface CloseStoreRequest {
  storeId: string;
}

async function handleCloseStore(params: unknown): Promise<unknown> {
  const p = params as CloseStoreRequest;
  const rec = ctx.storeMap.get(p.storeId);
  if (rec?.store) {
    try {
      await rec.store.close();
    } catch {
      // best-effort: a store that already closed shouldn't fail the RPC
    }
  }
  ctx.storeMap.delete(p.storeId);
  return { ok: true };
}

interface GetStoreStatusRequest {
  storeId: string;
}

function handleGetStoreStatus(params: unknown): unknown {
  const p = params as GetStoreStatusRequest;
  const rec = ctx.storeMap.get(p.storeId);
  if (!rec) {
    throw new RpcMethodError(-32000, 'Store not found');
  }
  return {
    isOpen: !!rec.store,
    ownLogLength: 0, // own-log wiring is a later phase (merge loop in sidecar)
    admittedPeerCount: rec.connections.size,
    lastMergeAt: null,
  };
}

interface BootHarnessRequest {
  workspaceId: string;
  harnessSlug: string;
  workspaceRoot?: string;
  storagePath?: string;
  swarmBinding?: { kind: string; value: string };
}

async function handleBootHarness(params: unknown): Promise<unknown> {
  const p = params as BootHarnessRequest;
  const openStoreResult = (await handleOpenStore({
    workspaceId: p.workspaceId,
    harnessSlug: p.harnessSlug,
    workspaceRoot: p.workspaceRoot,
    storagePath: p.storagePath,
  })) as { storeId: string };

  // Swarm join + merge loop in the sidecar are a later phase; Phase 2 owns the
  // store + the socket-handoff replication path only.
  return {
    storeId: openStoreResult.storeId,
    swarmTopicHex: null,
    ownLogKey: null,
    mergeLoopStarted: false,
  };
}

interface OnAnnounceRequest {
  storeId: string;
  announce: { logKey: string; logSeq: number; signature: string; timestamp: string };
}

function handleOnAnnounce(params: unknown): unknown {
  const p = params as OnAnnounceRequest;
  return { decision: 'admit', remoteLogKey: p.announce.logKey };
}

interface TriggerMergeNowRequest {
  storeId: string;
}

function handleTriggerMergeNow(_params: unknown): unknown {
  return { mergedOps: 0, durationMs: 0 };
}

interface GetMergeStatusRequest {
  storeId: string;
}

function handleGetMergeStatus(_params: unknown): unknown {
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

function handleGetAdmittedLogs(_params: unknown): unknown {
  return { logs: [] };
}

// ─── Phase 2: peer socket handoff ───────────────────────────────────────────

interface PrepareSocketHandoffRequest {
  storeId: string;
  peerId?: string;
}

/** Phase 1 of the handoff: allocate a single-use token bound to a store. The
 *  raw socket arrives separately over the child IPC channel keyed by this token. */
function handlePrepareSocketHandoff(params: unknown): unknown {
  const p = params as PrepareSocketHandoffRequest;
  const rec = ctx.storeMap.get(p.storeId);
  if (!rec) throw new RpcMethodError(-32000, 'Store not found');

  sweepExpiredHandoffs();
  const handoffToken = `hoff-${ctx.nextHandoffId++}-${crypto.randomBytes(8).toString('hex')}`;
  ctx.handoffs.set(handoffToken, {
    storeId: p.storeId,
    peerId: p.peerId,
    handle: null,
    used: false,
    createdAt: Date.now(),
    onHandle: null,
  });
  return { handoffToken };
}

interface AttachSocketRequest {
  storeId: string;
  handoffToken: string;
  peerInfo?: { publicKeyHex?: string; remoteIp?: string };
  /** The sidecar's replication role. Default false (responder) — the connecting
   *  peer drives the protocol as initiator. */
  initiator?: boolean;
}

/** Phase 3 of the handoff: bind the (out-of-band) handle to the store and start
 *  `corestore.replicate(...)` over it. Robust to either arrival order of the
 *  handle (IPC) vs this call (JSON-RPC). */
async function handleAttachSocket(params: unknown): Promise<unknown> {
  const p = params as AttachSocketRequest;
  const entry = ctx.handoffs.get(p.handoffToken);
  if (!entry || entry.used) {
    throw new RpcMethodError(-32002, 'Socket handoff failed: unknown or already-used token');
  }
  if (entry.storeId !== p.storeId) {
    throw new RpcMethodError(-32002, 'Socket handoff failed: storeId mismatch for token');
  }
  const rec = ctx.storeMap.get(p.storeId);
  if (!rec || !rec.store) {
    throw new RpcMethodError(-32000, 'Store not found');
  }

  const handle = entry.handle ?? (await waitForHandle(entry, HANDOFF_HANDLE_TIMEOUT_MS));
  if (!handle) {
    throw new RpcMethodError(-32002, 'Socket handoff failed: handle did not arrive over IPC');
  }

  entry.used = true;
  ctx.handoffs.delete(p.handoffToken);

  const connectionId = `conn-${ctx.nextConnId++}`;
  replicateOverTransport(rec.store, handle, Boolean(p.initiator));
  rec.connections.add(connectionId);
  handle.on('close', () => rec.connections.delete(connectionId));

  return { ok: true, connectionId };
}

/** Wait (bounded) for the out-of-band handle to arrive. Resolves null on timeout. */
function waitForHandle(entry: HandoffEntry, timeoutMs: number): Promise<Duplex | null> {
  if (entry.handle) return Promise.resolve(entry.handle);
  return new Promise<Duplex | null>((resolve) => {
    const t = setTimeout(() => {
      entry.onHandle = null;
      resolve(null);
    }, timeoutMs);
    entry.onHandle = (handle: Duplex) => {
      clearTimeout(t);
      resolve(handle);
    };
  });
}

/** Dumb-pipe a raw transport into a corestore replication protocol stream. The
 *  transport (a plain handed-off socket) carries no `isInitiator` hint, so we
 *  drive the role explicitly via `store.replicate(initiator)` and pipe both ways
 *  — the transport-agnostic Hypercore replication recipe. */
function replicateOverTransport(store: Corestore, transport: Duplex, initiator: boolean): void {
  const repl = store.replicate(initiator) as unknown as Duplex;
  // A peer dying mid-replication emits 'error'; with no listener Node escalates
  // it to an uncaught exception (would crash the sidecar). Swallow both ends.
  transport.on('error', () => {});
  repl.on('error', () => {});
  transport.pipe(repl).pipe(transport);
}

function sweepExpiredHandoffs(): void {
  const now = Date.now();
  for (const [token, entry] of ctx.handoffs) {
    if (!entry.used && now - entry.createdAt > HANDOFF_TTL_MS) {
      try {
        entry.handle?.destroy?.();
      } catch {
        // best-effort
      }
      ctx.handoffs.delete(token);
    }
  }
}

interface GetCoreInfoRequest {
  storeId: string;
  coreKeyHex: string;
  /** When set, fetch + return this block (base64). */
  fetchBlock?: number;
  /** When true, download the whole core into this store (drives real verify CPU). */
  download?: boolean;
}

/** Observability: open a core by key in the sidecar store, sync its length from
 *  peers, and optionally fetch a block / bulk-download. The main process uses
 *  this to confirm replication progress; the federation guard asserts on it. */
async function handleGetCoreInfo(params: unknown): Promise<unknown> {
  const p = params as GetCoreInfoRequest;
  const rec = ctx.storeMap.get(p.storeId);
  if (!rec || !rec.store) throw new RpcMethodError(-32000, 'Store not found');

  const core = rec.store.get({ key: Buffer.from(p.coreKeyHex, 'hex') }) as unknown as HypercoreLike;
  await core.ready();
  try {
    await core.update({ wait: true });
  } catch {
    // no peer / nothing to learn yet — return whatever length we have
  }

  if (p.download && core.length > 0) {
    await downloadAll(core);
  }

  let blockBase64: string | undefined;
  if (typeof p.fetchBlock === 'number' && core.length > p.fetchBlock) {
    try {
      const block = await core.get(p.fetchBlock, { wait: true });
      blockBase64 = Buffer.from(block).toString('base64');
    } catch {
      // block not retrievable (peer gone) — omit it
    }
  }

  return { length: core.length, byteLength: core.byteLength, blockBase64 };
}

/** Download every block of a core (the real merkle-verify CPU + I/O a merge /
 *  replication catch-up incurs — the load the latency guard isolates). */
async function downloadAll(core: HypercoreLike): Promise<void> {
  try {
    const range = core.download({ start: 0, end: core.length });
    if (range && typeof (range as { done?: unknown }).done === 'function') {
      await (range as { done(): Promise<void> }).done();
      return;
    }
    await (range as Promise<void>);
    return;
  } catch {
    // fall through to a sequential fetch
  }
  for (let i = 0; i < core.length; i++) {
    try {
      await core.get(i, { wait: true });
    } catch {
      // best-effort per block
    }
  }
}

// ─── dispatch ───────────────────────────────────────────────────────────────

type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

const methods: Record<string, RpcHandler> = {
  'sidecar:healthz': () => handleHealthz(),
  'substrate:openStore': handleOpenStore,
  'substrate:closeStore': handleCloseStore,
  'substrate:getStoreStatus': handleGetStoreStatus,
  'substrate:bootHarness': handleBootHarness,
  'substrate:onAnnounce': handleOnAnnounce,
  'substrate:triggerMergeNow': handleTriggerMergeNow,
  'substrate:getMergeStatus': handleGetMergeStatus,
  'substrate:getAdmittedLogs': handleGetAdmittedLogs,
  // Phase 2 (WI-178)
  'substrate:prepareSocketHandoff': handlePrepareSocketHandoff,
  'substrate:attachSocket': handleAttachSocket,
  'substrate:getCoreInfo': handleGetCoreInfo,
};

async function handleRequest(data: string, callback: (response: string) => void): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(data);
  } catch {
    callback(JSON.stringify(rpcError(-32700, 'Parse error', null)));
    return;
  }

  const req = request as {
    jsonrpc?: string;
    method?: string;
    params?: unknown;
    id?: number | string | null;
  };

  if (!req.method) {
    callback(JSON.stringify(rpcError(-32600, 'Invalid Request', req.id ?? null)));
    return;
  }

  const handler = methods[req.method];
  if (!handler) {
    callback(JSON.stringify(rpcError(-32601, 'Method not found', req.id ?? null)));
    return;
  }

  try {
    const result = await handler(req.params);
    callback(JSON.stringify(rpcResponse(result, req.id ?? null)));
  } catch (e) {
    const code = e instanceof RpcMethodError ? e.code : -32603;
    const msg = e instanceof Error ? e.message : 'Internal error';
    const data2 = e instanceof RpcMethodError ? e.data : undefined;
    callback(JSON.stringify(rpcError(code, msg, req.id ?? null, data2)));
  }
}

// ─── out-of-band handle channel (child_process IPC) ─────────────────────────

/** Receive Duplex handles transferred from the main process over the child IPC
 *  channel (`subprocess.send(msg, socket)`). Correlated to a prepared handoff by
 *  token. No-op when launched without an IPC channel (the control-only methods
 *  still work). */
function registerHandleListener(): void {
  if (typeof process.send !== 'function') return; // no IPC channel
  process.on('message', (message: unknown, handle: unknown) => {
    const m = message as { kind?: string; handoffToken?: string } | null;
    if (!m || m.kind !== 'substrate:socketHandle' || typeof m.handoffToken !== 'string') return;
    const entry = ctx.handoffs.get(m.handoffToken);
    if (!entry) {
      // Unknown / expired token — destroy the orphan handle so it can't leak.
      try {
        (handle as { destroy?: () => void } | null)?.destroy?.();
      } catch {
        // best-effort
      }
      return;
    }
    entry.handle = handle as Duplex;
    if (entry.onHandle) {
      const cb = entry.onHandle;
      entry.onHandle = null;
      cb(handle as Duplex);
    }
  });
}

// ─── Unix socket server ─────────────────────────────────────────────────────

function startServer(): void {
  const socketPath = process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET || '.papercusp/substrate.sock';
  const socketDir = path.dirname(socketPath);

  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  registerHandleListener();

  const server = net.createServer((socket: net.Socket) => {
    let buffer = '';

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Line-based protocol: one JSON-RPC 2.0 message per line.
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

    socket.on('error', (err) => {
      console.error('[socket-error]', err.message);
    });

    socket.on('end', () => {
      // Control socket closed.
    });
  });

  server.listen(socketPath, () => {
    console.log(`[substrate-sidecar] listening on ${socketPath}`);
    // Handshake line the parent spawner waits for.
    console.log(`PAPERCUSP_SUBSTRATE_READY socket=${socketPath}`);
  });

  server.on('error', (err) => {
    console.error('[server-error]', err.message);
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    console.log(`[substrate-sidecar] ${signal} received, shutting down gracefully`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
