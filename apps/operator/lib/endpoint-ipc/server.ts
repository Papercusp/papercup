/**
 * Endpoint IPC server — webview→Tauri→Node fast path for the endpoint
 * system. See PROTOCOL.md for the wire spec and trust model.
 *
 * Lifecycle:
 *   1. Caller invokes `startEndpointIpcServer({ socketPath })`.
 *   2. Server binds, unlinks any stale socket, prints the
 *      `PAPERCUSP_IPC_READY socket=<path>` line to stdout.
 *   3. Rust client connects, sends REQUEST frames, receives EVENT_JSON /
 *      EVENT_BIN / DONE / ERROR frames, may send CANCEL.
 *   4. On process exit, server unlinks the socket file.
 *
 * Trust: synthetic operator principal, sig-verification skipped. See
 * transports.mdx § Trust model.
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FrameType,
  FrameDecoder,
  FrameError,
  encodeFrame,
  encodeJsonFrame,
  encodeEventBinPayload,
  type Frame,
  type FrameTypeValue,
} from './framing';
import {
  dispatchProjectedToolStream,
  lookupByMcpName,
  type UnifiedToolContext,
  type DispatchProjectedDeps,
} from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '@/lib/workspace-registry';

/** Returns the default per-process socket path on this OS. */
export function defaultSocketPath(pid: number = process.pid): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\papercusp-${pid}`;
  }
  return path.join(os.homedir(), '.papercusp', 'sockets', `${pid}.sock`);
}

export interface StartEndpointIpcServerOptions {
  /** Override default `~/.papercusp/sockets/<pid>.sock` / named-pipe path. */
  socketPath?: string;
  /**
   * Allowed tool names. When unset, every registered projected tool is
   * dispatchable; when set, REQUESTs for other tool names return an
   * `ERROR { code: 'tool_not_allowed' }`. The Phase-3 rollout starts
   * with `['operator:scan']` and widens once burn-in is clean.
   */
  allowedTools?: ReadonlySet<string> | readonly string[];
  /**
   * Dispatcher deps. Defaults to `{}` (no PG telemetry / quota). Wire
   * a real `recordInvocation` + `readQuotaState` here once we extract
   * `PROJECTED_DEPS` out of `app/api/[transport]/route.ts`.
   */
  deps?: DispatchProjectedDeps;
  /**
   * Optional logger. Defaults to console.log/warn with an [ipc] prefix.
   */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface EndpointIpcServer {
  /** Underlying Node server (for tests). */
  server: net.Server;
  /** Resolved socket path the server is listening on. */
  socketPath: string;
  /** Number of currently-open client connections. */
  connectionCount(): number;
  /** Close listener + all open connections; resolves when fully shut down. */
  close(): Promise<void>;
}

/**
 * Start listening for IPC connections. Resolves once the server has
 * bound and printed the ready line to stdout.
 *
 * Bind failures (path-in-use, EACCES) reject with the underlying error.
 */
export async function startEndpointIpcServer(
  options: StartEndpointIpcServerOptions = {},
): Promise<EndpointIpcServer> {
  const socketPath = options.socketPath ?? defaultSocketPath();
  const allowed =
    options.allowedTools !== undefined
      ? new Set(options.allowedTools)
      : null;
  const deps = options.deps ?? {};
  const logger =
    options.logger ?? {
      info: (m) => console.log(`[ipc] ${m}`),
      warn: (m) => console.warn(`[ipc] ${m}`),
    };

  if (process.platform !== 'win32') {
    await fs.promises.mkdir(path.dirname(socketPath), {
      recursive: true,
      mode: 0o700,
    });
    // Stale socket cleanup. Ignore ENOENT.
    try {
      await fs.promises.unlink(socketPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    handleConnection(socket, { allowed, deps, logger });
    socket.on('close', () => {
      connections.delete(socket);
    });
  });

  server.on('error', (err) => {
    logger.warn(`server error: ${err instanceof Error ? err.message : String(err)}`);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

  // Stdout-ready-line per PROTOCOL.md. Rust waits on this exact prefix.
  process.stdout.write(`PAPERCUSP_IPC_READY socket=${socketPath}\n`);

  return {
    server,
    socketPath,
    connectionCount: () => connections.size,
    close: async () => {
      for (const c of connections) c.destroy();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') {
        try {
          await fs.promises.unlink(socketPath);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/* ─── Per-connection handler ────────────────────────────────────────── */

interface PerConnectionDeps {
  allowed: Set<string> | null;
  deps: DispatchProjectedDeps;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}

function handleConnection(socket: net.Socket, deps: PerConnectionDeps): void {
  const dec = new FrameDecoder();
  // Per-call AbortControllers, keyed by request id.
  const inFlight = new Map<bigint, AbortController>();
  // Cancel ids that arrived BEFORE their REQUEST. The handler checks
  // this set on registration and pre-aborts the new controller. Without
  // this, a CANCEL frame that races ahead of its REQUEST (possible on
  // pipelined writes) would silently no-op and the tool would run to
  // completion. Bounded by lastSeenId so we don't grow indefinitely —
  // monotonic id check drops anything reused.
  const preCancelledIds = new Set<bigint>();
  let lastSeenId: bigint = 0n;

  const writeFrame = (type: FrameTypeValue, payload: Buffer): boolean => {
    if (socket.destroyed) return false;
    // Returns false when write buffer is full; we don't currently apply
    // back-pressure on emit (the bounded-mpsc-10k design is implemented
    // on the Rust client side). Node sockets buffer in memory.
    return socket.write(encodeFrame(type, payload));
  };
  const writeJson = (type: FrameTypeValue, value: unknown): boolean =>
    writeFrame(type, Buffer.from(JSON.stringify(value), 'utf8'));

  const sendError = (id: bigint, code: string, message: string): void => {
    writeJson(FrameType.ERROR, {
      id: Number(id),
      error: { code, message },
    });
  };

  socket.on('data', (chunk: Buffer) => {
    try {
      dec.push(chunk);
    } catch (err) {
      if (err instanceof FrameError) {
        deps.logger.warn(`frame decode error: ${err.message}; closing connection`);
        socket.destroy();
        return;
      }
      throw err;
    }
    for (const frame of dec.drain()) {
      void dispatchFrame(frame).catch((err) => {
        deps.logger.warn(
          `unexpected dispatchFrame throw: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  });

  socket.on('close', () => {
    for (const ac of inFlight.values()) ac.abort();
    inFlight.clear();
  });

  socket.on('error', (err) => {
    deps.logger.warn(`socket error: ${err.message}`);
  });

  async function dispatchFrame(frame: Frame): Promise<void> {
    if (frame.type === FrameType.REQUEST) {
      await handleRequest(frame.payload);
    } else if (frame.type === FrameType.CANCEL) {
      handleCancel(frame.payload);
    } else {
      deps.logger.warn(
        `unexpected client frame type 0x${frame.type.toString(16)}; closing`,
      );
      socket.destroy();
    }
  }

  async function handleRequest(payload: Buffer): Promise<void> {
    let parsed: { id: number; toolName: string; input?: unknown };
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      deps.logger.warn('REQUEST payload not JSON; closing');
      socket.destroy();
      return;
    }
    if (
      typeof parsed.id !== 'number' ||
      !Number.isFinite(parsed.id) ||
      typeof parsed.toolName !== 'string'
    ) {
      deps.logger.warn('REQUEST missing id/toolName; closing');
      socket.destroy();
      return;
    }
    const id = BigInt(parsed.id);
    // Monotonic id check — protocol requires strict-increasing per
    // connection.
    if (id <= lastSeenId) {
      deps.logger.warn(`non-monotonic REQUEST id=${id} (last=${lastSeenId}); closing`);
      socket.destroy();
      return;
    }
    lastSeenId = id;

    if (deps.allowed && !deps.allowed.has(parsed.toolName)) {
      sendError(id, 'tool_not_allowed', `tool '${parsed.toolName}' is not on the IPC allowlist`);
      return;
    }
    const tool = lookupByMcpName(parsed.toolName);
    if (!tool) {
      sendError(id, 'unknown_tool', `no projected tool named '${parsed.toolName}'`);
      return;
    }

    const abort = new AbortController();
    inFlight.set(id, abort);
    // Race: a CANCEL frame for this id may have arrived BEFORE the
    // REQUEST (pipelined writes). Pre-abort if so.
    if (preCancelledIds.delete(id)) {
      abort.abort();
    }

    // Synthetic operator principal. The webview is in-boundary; the
    // signed-URL model doesn't apply (see transports.mdx § Trust model).
    // workspaceId comes from the live registry (matches what the HTTP
    // route's `activeWorkspaceId()` returns) so per-workspace state and
    // RLS resolve correctly.
    const ctx: UnifiedToolContext = {
      log: (m) => deps.logger.info(`[${parsed.toolName}] ${m}`),
      signal: abort.signal,
      progress: () => { /* dispatchProjectedToolStream overrides this */ },
      emit: () => { /* dispatchProjectedToolStream overrides this */ },
      transport: 'ipc',
      workspaceId: activeWorkspaceId(),
      role: 'operator',
      // Phase 4 T2.2: UUIDs match the HTTP-side decision (reviewer
      // concern #4 in v1 plan review). The per-connection `id` is
      // already unique within one socket but multiple webviews to
      // one sidecar could conflict on `ipc-1` etc; UUIDs sidestep.
      runId: globalThis.crypto.randomUUID(),
      spawnId: globalThis.crypto.randomUUID(),
    };

    const wireKinds = tool.eventWireKinds ?? {};

    try {
      for await (const ev of dispatchProjectedToolStream(
        tool,
        parsed.toolName,
        parsed.input ?? {},
        ctx,
        deps.deps,
      )) {
        if (ev.kind === 'event') {
          const kind = wireKinds[ev.name];
          if (
            kind === 'binary' &&
            ev.data instanceof Uint8Array
          ) {
            writeFrame(
              FrameType.EVENT_BIN,
              encodeEventBinPayload(id, ev.name, ev.data),
            );
          } else {
            writeJson(FrameType.EVENT_JSON, {
              id: Number(id),
              name: ev.name,
              data: ev.data,
            });
          }
        } else if (ev.kind === 'done') {
          writeJson(FrameType.DONE, { id: Number(id), result: ev.result });
        } else {
          writeJson(FrameType.ERROR, { id: Number(id), error: ev.error });
        }
      }
    } catch (err) {
      sendError(
        id,
        'handler_error',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      inFlight.delete(id);
    }
  }

  function handleCancel(payload: Buffer): void {
    let parsed: { id: number };
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      deps.logger.warn('CANCEL payload not JSON; ignoring');
      return;
    }
    const id = BigInt(parsed.id ?? 0);
    const ac = inFlight.get(id);
    if (ac) {
      ac.abort();
    } else if (id > lastSeenId) {
      // CANCEL arrived ahead of its REQUEST. Remember so handleRequest
      // can pre-abort. Cap the set size defensively: only track ids
      // strictly ahead of lastSeenId (stale cancels are ignored).
      preCancelledIds.add(id);
    }
    // else: id ≤ lastSeenId AND not in flight → call already terminated.
    // Silently drop; idempotent.
  }
}
