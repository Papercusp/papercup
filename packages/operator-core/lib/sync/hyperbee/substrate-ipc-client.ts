/**
 * Substrate IPC client — calls the sidecar over JSON-RPC 2.0 Unix socket.
 *
 * When SUBSTRATE_SIDECAR flag is ON, bootAllHarnessesForActiveWorkspace
 * uses this client instead of in-process bootHarnessSubstrate calls.
 * Failures fall back to in-process (the sidecar is optional).
 */

import * as net from 'node:net';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

export interface SubstrateRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface SubstrateRpcResponse<T> {
  ok: boolean;
  result?: T;
  error?: SubstrateRpcError;
}

/**
 * Substrate IPC client: sends JSON-RPC 2.0 requests over Unix socket.
 * Line-based protocol: one JSON-RPC 2.0 per line.
 */
export class SubstrateIpcClient {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private connected = false;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = '';
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || path.join('.papercusp', 'substrate.sock');
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
        if (this.connectReject && !this.connectPromise) {
          this.connectReject(err);
        }
        // Reject all pending requests
        for (const [, { reject }] of this.pending) {
          reject(new Error(`Socket error: ${err.message}`));
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
   * Send an RPC request and wait for the response.
   */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();

    if (!this.socket) {
      throw new Error('Not connected to substrate sidecar');
    }

    const id = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      this.socket!.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });

      // Request timeout: 30s
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timeout: ${method}`));
      }, 30000);

      const originalResolve = resolve;
      const originalReject = reject;
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          originalResolve(value as T);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          originalReject(error);
        },
      });
    });
  }

  /**
   * Handle incoming data from the socket.
   */
  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    // Process complete lines (one JSON-RPC per line)
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const response = JSON.parse(line) as {
            jsonrpc?: string;
            id?: number;
            result?: unknown;
            error?: { code: number; message: string; data?: unknown };
          };

          const id = response.id;
          if (typeof id !== 'number') continue;

          const pending = this.pending.get(id);
          if (!pending) continue;

          this.pending.delete(id);

          if (response.error) {
            pending.reject(
              new Error(`RPC error ${response.error.code}: ${response.error.message}`),
            );
          } else {
            pending.resolve(response.result);
          }
        } catch (err) {
          console.warn('[substrate-ipc-client] failed to parse response:', err);
        }
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
  }
}

/**
 * Global IPC client instance (lazy-initialized).
 */
let globalClient: SubstrateIpcClient | null = null;

export function getSubstrateIpcClient(socketPath?: string): SubstrateIpcClient {
  if (!globalClient) {
    globalClient = new SubstrateIpcClient(socketPath);
  }
  return globalClient;
}

/**
 * Close the global client (for graceful shutdown).
 */
export function closeSubstrateIpcClient(): void {
  if (globalClient) {
    globalClient.close();
    globalClient = null;
  }
}
