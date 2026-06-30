/**
 * Spawner IPC client — calls the SPAWNER sidecar over a JSON-RPC 2.0 Unix socket
 * (WI-344 ③, plan spawner-sidecar-offload-2026-06-30).
 *
 * Cloned from sync/hyperbee/substrate-ipc-client.ts. When the OFF-by-default
 * SPAWNER_SIDECAR flag is ON, spawnInvokeOnceWithFallback (orchestrator-runner.ts)
 * routes the agent-spawn fork/exec + buildInvokeOnce OFF the bg-host main loop and
 * over this client into the sidecar. Failures fall back to in-process (the sidecar
 * is optional) — same posture as the substrate client.
 *
 * EXTENSION over the substrate client — a server→client PUSH (notification)
 * channel. A message carrying a `method` + `params` and NO top-level `id` is a
 * JSON-RPC NOTIFICATION (not a response). The sidecar pushes two while a
 * `spawn:invokeOnce` is in flight, both carrying the originating request's id in
 * `params.requestId`:
 *   - `spawn:pid`            { requestId, pid }  — the child OS pid right after spawn (EI-85)
 *   - `spawn:outputActivity` { requestId }       — every stdout/stderr chunk (liveness, P-008)
 * The client routes each to per-request callbacks registered at `call()` time
 * (`onPid` / `onOutputActivity`), keyed by the request id — so the in-process
 * caller gets the SAME mid-turn signals it would from a local spawnInvokeOnce.
 */

import * as net from 'node:net';
import { resolveSpawnerSocketPath } from './spawner-socket-path';

export interface SpawnerRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Per-request push callbacks, registered at call() time, keyed by request id. */
export interface SpawnerCallOpts {
  /** Fired once with the child OS pid (the sidecar's `spawn:pid` notification). */
  onPid?: (pid: number) => void;
  /** Fired on every child stdout/stderr chunk (the `spawn:outputActivity` push). */
  onOutputActivity?: () => void;
  /** Surfaces the assigned request id back to the caller synchronously, BEFORE
   *  the call resolves — so an aborting caller can `call('spawn:cancel',{requestId})`. */
  onRequestId?: (id: number) => void;
}

/**
 * Spawner IPC client: sends JSON-RPC 2.0 requests over a Unix socket.
 * Line-based protocol: one JSON-RPC message per line. Correlates responses by id
 * and routes server→client notifications to per-request callbacks.
 */
export class SpawnerIpcClient {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private connected = false;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** Per-request push-notification callbacks, keyed by request id. */
  private callbacks = new Map<number, { onPid?: (pid: number) => void; onOutputActivity?: () => void }>();
  private buffer = '';
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(socketPath?: string) {
    // Absolute, env-pinned path (the spawner sets PAPERCUSP_SPAWNER_IPC_SOCKET
    // before forking, so client + child agree). Never CWD-relative — see P-006.
    this.socketPath = socketPath || resolveSpawnerSocketPath();
  }

  /**
   * Ensure connected to the sidecar socket.
   */
  async ensureConnected(): Promise<void> {
    if (this.connected) return;

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      this.socket = net.createConnection(this.socketPath, () => {
        this.connected = true;
        if (this.connectResolve) this.connectResolve();
      });

      this.socket.on('data', (chunk: Buffer) => this.handleData(chunk));
      this.socket.on('error', (err) => {
        this.connected = false;
        if (this.connectReject) {
          this.connectReject(err);
        }
        // Reject all pending requests + drop their callbacks.
        for (const [id, { reject: rej }] of this.pending) {
          rej(new Error(`Socket error: ${err.message}`));
          this.callbacks.delete(id);
        }
        this.pending.clear();
      });

      this.socket.on('end', () => {
        this.connected = false;
      });

      // Connection timeout: 5s
      const timeout = setTimeout(() => {
        if (this.socket && !this.connected) {
          this.socket.destroy();
          if (this.connectReject) {
            this.connectReject(new Error('Connection timeout'));
          }
        }
      }, 5000);

      this.socket.once('connect', () => clearTimeout(timeout));
    });

    return this.connectPromise;
  }

  /**
   * Send an RPC request and wait for the response. Optional `opts` registers the
   * per-request push callbacks (onPid / onOutputActivity) and surfaces the
   * assigned request id (onRequestId) for cancellation wiring.
   */
  async call<T = unknown>(method: string, params?: unknown, opts?: SpawnerCallOpts): Promise<T> {
    await this.ensureConnected();

    if (!this.socket) {
      throw new Error('Not connected to spawner sidecar');
    }

    const id = ++this.requestId;
    if (opts?.onPid || opts?.onOutputActivity) {
      this.callbacks.set(id, { onPid: opts.onPid, onOutputActivity: opts.onOutputActivity });
    }
    // Hand the id back synchronously so the caller can correlate a later
    // `spawn:cancel` to THIS request before it resolves.
    opts?.onRequestId?.(id);

    const request = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<T>((resolve, reject) => {
      // Request timeout: 30s
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.callbacks.delete(id);
        reject(new Error(`RPC request timeout: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          this.callbacks.delete(id);
          resolve(value as T);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          this.callbacks.delete(id);
          reject(error);
        },
      });

      this.socket!.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(id);
          this.callbacks.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Handle incoming data from the socket — one JSON-RPC message per line. A
   * message with a numeric top-level `id` is a RESPONSE (correlated to a pending
   * request); a message with a `method` and NO `id` is a NOTIFICATION (routed to
   * the per-request push callbacks via `params.requestId`).
   */
  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;
      let msg: {
        jsonrpc?: string;
        id?: number;
        method?: string;
        params?: { requestId?: number; pid?: number } & Record<string, unknown>;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      };
      try {
        msg = JSON.parse(line);
      } catch (err) {
        console.warn('[spawner-ipc-client] failed to parse message:', err);
        continue;
      }

      // NOTIFICATION (server→client PUSH): method present, no top-level id.
      if (typeof msg.method === 'string' && msg.id === undefined) {
        const requestId = msg.params?.requestId;
        if (typeof requestId !== 'number') continue;
        const cb = this.callbacks.get(requestId);
        if (!cb) continue;
        if (msg.method === 'spawn:pid' && typeof msg.params?.pid === 'number') {
          try { cb.onPid?.(msg.params.pid); } catch { /* best-effort */ }
        } else if (msg.method === 'spawn:outputActivity') {
          try { cb.onOutputActivity?.(); } catch { /* best-effort */ }
        }
        continue;
      }

      // RESPONSE: correlate by id.
      const id = msg.id;
      if (typeof id !== 'number') continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);

      if (msg.error) {
        pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  /**
   * Close the connection.
   */
  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.connectPromise = null;
    this.callbacks.clear();
  }
}

/**
 * Global IPC client instance (lazy-initialized).
 */
let globalClient: SpawnerIpcClient | null = null;

export function getSpawnerIpcClient(socketPath?: string): SpawnerIpcClient {
  if (!globalClient) {
    globalClient = new SpawnerIpcClient(socketPath);
  }
  return globalClient;
}

/**
 * Close the global client (for graceful shutdown).
 */
export function closeSpawnerIpcClient(): void {
  if (globalClient) {
    globalClient.close();
    globalClient = null;
  }
}
