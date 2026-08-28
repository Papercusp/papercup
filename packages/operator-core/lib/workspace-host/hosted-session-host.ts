/**
 * Workspace-host half of the outbound hosted terminal/file relay.
 *
 * The control plane owns the WebSocket and forwards generation-bound relay
 * envelopes here. This module never listens on a VM port. It binds every PTY
 * to the authenticated connector identity + browser principal and constrains
 * generic file operations to one server-selected project root.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { getScreenSerialization, spawnPty, type PtyHandle } from '../pty-bridge';
import type { PtyAccessScope } from '../pty-ticket';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';

export const HOSTED_HOST_MAX_MESSAGE_BYTES = 1024 * 1024;
export const HOSTED_HOST_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const HOSTED_HOST_MAX_PTY_INPUT_BYTES = 64 * 1024;
export const HOSTED_HOST_SESSION_IDLE_MS = 15 * 60_000;

const OUTPUT_CHUNK_BYTES = 48 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_000;
const SAFE_SIGNAL = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL']);

export type HostedHostTabRole = 'controller' | 'observer';

export interface HostedHostRelayOpen {
  type: 'relay.open';
  channelId: string;
  userId: string;
  hostedSessionId: string;
  audience: string;
  role: HostedHostTabRole;
}

export interface HostedHostRelayMessage {
  type: 'relay';
  channelId: string;
  payload: unknown;
}

export interface HostedHostRelayClose {
  type: 'relay.close';
  channelId: string;
  reason?: string;
}

export type HostedHostRelayEnvelope = HostedHostRelayOpen | HostedHostRelayMessage | HostedHostRelayClose;

export type HostedHostOutboundEnvelope =
  | { type: 'relay'; channelId: string; payload: unknown }
  | { type: 'relay.close'; channelId: string; reason: string };

export interface HostedHostAuditEvent {
  action: string;
  organizationId: string;
  customerWorkspaceId: string;
  hostId: string;
  generation: number;
  userId?: string;
  hostedSessionId?: string;
  channelId?: string;
  detail?: string;
}

export interface HostedHostPty {
  write(data: Buffer): boolean;
  resize(cols: number, rows: number): boolean;
  signal(signal: string): boolean;
  kill(): void;
  snapshot(): Promise<string | null>;
  onData(listener: (data: Buffer) => void): () => void;
  onExit(listener: (code: number, signal: number) => void): () => void;
}

export interface HostedHostPtyFactoryInput {
  scope: PtyAccessScope;
  hostedSessionId: string;
  workspaceRoot: string;
  cols: number;
  rows: number;
}

export interface HostedWorkspaceHostOptions {
  binding: HostedConnectorBinding;
  workspaceRoot: string;
  send: (message: HostedHostOutboundEnvelope) => void;
  createPty?: (input: HostedHostPtyFactoryInput) => HostedHostPty;
  files?: SafeRootFileService;
  idleMs?: number;
  maxMessageBytes?: number;
  onAudit?: (event: HostedHostAuditEvent) => void;
}

type HostSession = {
  key: string;
  userId: string;
  hostedSessionId: string;
  channels: Set<string>;
  pty: HostedHostPty;
  idleTimer: ReturnType<typeof setTimeout> | null;
  mutationResults: Map<string, { digest: string; payload: unknown }>;
  removeData: () => void;
  removeExit: () => void;
  closed: boolean;
};

type Channel = {
  sessionKey: string;
  role: HostedHostTabRole;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function string(value: unknown, max = 512): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** File payloads may be empty: an empty base64/utf8 string is a valid zero-byte file. */
function filePayload(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function integer(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sessionKey(userId: string, hostedSessionId: string): string {
  return `${userId.length}:${userId}${hostedSessionId.length}:${hostedSessionId}`;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function safeRelativePath(value: unknown): string {
  const path = string(value, 4_096);
  if (!path || path.includes('\0') || isAbsolute(path)) throw new SafeRootFileError('invalid_path');
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some((part) => part === '..')) throw new SafeRootFileError('path_escape');
  const normalized = parts.filter((part) => part !== '' && part !== '.').join('/');
  if (!normalized) throw new SafeRootFileError('invalid_path');
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (
      lower === '.git' ||
      lower === '.ssh' ||
      lower === '.aws' ||
      lower === '.mcp.json' ||
      lower === '.npmrc' ||
      lower === '.netrc' ||
      lower === 'credentials.json' ||
      lower === 'service-account.json' ||
      lower === '.env' ||
      lower.startsWith('.env.')
    )
      throw new SafeRootFileError('secret_path_denied');
  }
  return normalized;
}

export class SafeRootFileError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SafeRootFileError';
  }
}

/**
 * A generic file plane with no ambient cwd or caller-selected root.
 *
 * Reads validate the opened file descriptor via `/proc/self/fd` so a symlink
 * swap between path validation and open cannot disclose an outside target.
 * Writes open without truncation, validate that same descriptor, and only then
 * mutate bytes. The parent must already exist; directory creation is excluded
 * from this generic surface.
 */
export class SafeRootFileService {
  constructor(
    readonly root: string,
    readonly maxFileBytes = HOSTED_HOST_MAX_FILE_BYTES,
  ) {}

  async read(path: unknown): Promise<{ data: string; bytes: number; sha256: string }> {
    const { handle } = await this.openValidated(path, constants.O_RDONLY);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new SafeRootFileError('not_a_file');
      if (stat.size > this.maxFileBytes) throw new SafeRootFileError('file_too_large');
      const data = await handle.readFile();
      if (data.byteLength > this.maxFileBytes) throw new SafeRootFileError('file_too_large');
      return {
        data: data.toString('base64'),
        bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
    } finally {
      await handle.close();
    }
  }

  async write(path: unknown, data: Buffer): Promise<{ bytes: number; sha256: string }> {
    if (data.byteLength > this.maxFileBytes) throw new SafeRootFileError('file_too_large');
    const { handle } = await this.openValidated(path, constants.O_WRONLY | constants.O_CREAT, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new SafeRootFileError('not_a_file');
      await handle.truncate(0);
      await handle.writeFile(data);
      await handle.sync();
      return { bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
    } finally {
      await handle.close();
    }
  }

  async list(path: unknown): Promise<Array<{ name: string; kind: 'file' | 'directory'; bytes?: number }>> {
    const relativePath = path === '' || path === '.' ? '.' : safeRelativePath(path);
    const root = await realpath(resolve(this.root));
    const candidate = resolve(root, relativePath);
    if (!inside(root, candidate)) throw new SafeRootFileError('path_escape');
    const resolved = await realpath(candidate).catch(() => {
      throw new SafeRootFileError('not_found');
    });
    if (!inside(root, resolved)) throw new SafeRootFileError('path_escape');
    const entries = await readdir(resolved, { withFileTypes: true });
    const visible = entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .filter((entry) => {
        try {
          safeRelativePath(entry.name);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_DIRECTORY_ENTRIES);
    const result: Array<{ name: string; kind: 'file' | 'directory'; bytes?: number }> = [];
    for (const entry of visible) {
      if (entry.isDirectory()) result.push({ name: entry.name, kind: 'directory' });
      else {
        const file = await open(resolve(resolved, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
          () => null,
        );
        if (!file) continue;
        try {
          await this.validateOpenFile(file.fd, root);
          const stat = await file.stat();
          if (stat.isFile()) result.push({ name: entry.name, kind: 'file', bytes: stat.size });
        } catch {
          /* a raced/symlinked entry is intentionally invisible */
        } finally {
          await file.close();
        }
      }
    }
    return result;
  }

  private async openValidated(path: unknown, flags: number, mode?: number) {
    const relativePath = safeRelativePath(path);
    const root = await realpath(resolve(this.root)).catch(() => {
      throw new SafeRootFileError('root_unavailable');
    });
    const candidate = resolve(root, relativePath);
    if (!inside(root, candidate)) throw new SafeRootFileError('path_escape');
    const parent = await realpath(dirname(candidate)).catch(() => {
      throw new SafeRootFileError('parent_not_found');
    });
    if (!inside(root, parent)) throw new SafeRootFileError('path_escape');
    const finalPath = resolve(parent, basename(candidate));
    const handle = await open(finalPath, flags | constants.O_NOFOLLOW, mode).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ELOOP') throw new SafeRootFileError('symlink_denied');
      if (error.code === 'ENOENT') throw new SafeRootFileError('not_found');
      throw error;
    });
    try {
      await this.validateOpenFile(handle.fd, root);
      return { handle, root };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async validateOpenFile(fd: number, root: string): Promise<void> {
    if (process.platform !== 'linux') return;
    const opened = await realpath(`/proc/self/fd/${fd}`).catch(() => {
      throw new SafeRootFileError('file_identity_unavailable');
    });
    if (!inside(root, opened)) throw new SafeRootFileError('path_escape');
  }
}

function defaultPty(input: HostedHostPtyFactoryInput): HostedHostPty {
  const handle = spawnPty({
    accessScope: input.scope,
    command: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
    args: process.platform === 'win32' ? ['-NoLogo'] : ['--noprofile', '--norc'],
    cwd: input.workspaceRoot,
    inheritEnv: false,
    taskId: input.hostedSessionId,
    cols: input.cols,
    rows: input.rows,
    env: {
      HOME: input.workspaceRoot,
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: 'xterm-256color',
    },
  });
  return ptyHandleAdapter(handle, input.scope);
}

function ptyHandleAdapter(handle: PtyHandle, scope: PtyAccessScope): HostedHostPty {
  return {
    write: (data) => {
      if (handle.killed) return false;
      handle.lastActivityMs = Date.now();
      handle.pty.write(data.toString('utf8'));
      return true;
    },
    resize: (cols, rows) => {
      if (handle.killed) return false;
      try {
        handle.pty.resize(cols, rows);
        handle.headless.resize(cols, rows);
        return true;
      } catch {
        return false;
      }
    },
    signal: (signal) => {
      if (handle.killed) return false;
      try {
        handle.pty.kill(signal);
        return true;
      } catch {
        return false;
      }
    },
    kill: () => {
      if (!handle.killed) {
        try {
          handle.pty.kill();
        } catch {
          /* already exited */
        }
      }
    },
    snapshot: () => getScreenSerialization(handle.id, scope),
    onData: (listener) => {
      handle.onData.add(listener);
      return () => handle.onData.delete(listener);
    },
    onExit: (listener) => {
      handle.onExit.add(listener);
      return () => handle.onExit.delete(listener);
    },
  };
}

export class HostedWorkspaceHostSessionAdapter {
  private readonly sessions = new Map<string, HostSession>();
  private readonly channels = new Map<string, Channel>();
  private readonly files: SafeRootFileService;
  private readonly createPty: (input: HostedHostPtyFactoryInput) => HostedHostPty;
  private readonly idleMs: number;
  private readonly maxMessageBytes: number;
  private readonly onAudit: (event: HostedHostAuditEvent) => void;
  private closed = false;

  constructor(private readonly options: HostedWorkspaceHostOptions) {
    this.files = options.files ?? new SafeRootFileService(options.workspaceRoot);
    this.createPty = options.createPty ?? defaultPty;
    this.idleMs = options.idleMs ?? HOSTED_HOST_SESSION_IDLE_MS;
    this.maxMessageBytes = options.maxMessageBytes ?? HOSTED_HOST_MAX_MESSAGE_BYTES;
    this.onAudit = options.onAudit ?? (() => {});
  }

  async accept(envelope: unknown): Promise<void> {
    if (this.closed || byteLength(envelope) > this.maxMessageBytes) return;
    const message = object(envelope);
    if (!message) return;
    const type = string(message.type, 64);
    if (type === 'relay.open') await this.open(message);
    else if (type === 'relay') await this.relay(message);
    else if (type === 'relay.close')
      this.detach(string(message.channelId, 256), string(message.reason, 256) ?? 'remote_closed');
  }

  close(reason = 'connector_closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const channelId of [...this.channels.keys()]) this.options.send({ type: 'relay.close', channelId, reason });
    for (const session of [...this.sessions.values()]) this.destroySession(session, reason);
    this.channels.clear();
  }

  private async open(message: Record<string, unknown>): Promise<void> {
    const channelId = string(message.channelId, 256);
    const userId = string(message.userId);
    const hostedSessionId = string(message.hostedSessionId);
    const audience = string(message.audience);
    const role = message.role === 'controller' || message.role === 'observer' ? message.role : null;
    if (!channelId || !userId || !hostedSessionId || audience !== 'workspace-operator' || !role) return;
    if (this.channels.has(channelId)) {
      this.options.send({ type: 'relay.close', channelId, reason: 'channel_already_open' });
      return;
    }

    const key = sessionKey(userId, hostedSessionId);
    let session = this.sessions.get(key);
    const resumed = Boolean(session);
    if (!session) {
      const scope: PtyAccessScope = {
        tenantId: this.options.binding.organizationId,
        workspaceId: this.options.binding.customerWorkspaceId,
        harnessSlug: 'hosted',
        hostId: this.options.binding.hostId,
        principalId: userId,
      };
      const pty = this.createPty({
        scope,
        hostedSessionId,
        workspaceRoot: this.options.workspaceRoot,
        cols: 120,
        rows: 32,
      });
      session = {
        key,
        userId,
        hostedSessionId,
        channels: new Set(),
        pty,
        idleTimer: null,
        mutationResults: new Map(),
        removeData: () => {},
        removeExit: () => {},
        closed: false,
      };
      session.removeData = pty.onData((data) => this.broadcastOutput(session!, data));
      session.removeExit = pty.onExit((code, signal) => {
        this.broadcast(session!, { type: 'pty.exit', code, signal });
        this.destroySession(session!, 'pty_exited', false);
      });
      this.sessions.set(key, session);
      this.audit('pty_started', session);
    }

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    session.channels.add(channelId);
    this.channels.set(channelId, { sessionKey: key, role });
    this.send(channelId, { type: 'pty.ready', resumed, role });
    const snapshot = await session.pty.snapshot();
    if (snapshot && this.channels.get(channelId)?.sessionKey === key) {
      this.send(channelId, { type: 'pty.snapshot', data: Buffer.from(snapshot, 'utf8').toString('base64') });
    }
    this.audit(resumed ? 'pty_resumed' : 'channel_attached', session, channelId);
  }

  private async relay(message: Record<string, unknown>): Promise<void> {
    const channelId = string(message.channelId, 256);
    if (!channelId) return;
    const channel = this.channels.get(channelId);
    const session = channel ? this.sessions.get(channel.sessionKey) : null;
    if (!channel || !session || session.closed) return;
    const payload = object(message.payload);
    if (!payload) return;
    const type = string(payload.type, 64);
    if (!type) return;

    try {
      if (type === 'pty.input') {
        const encoded = string(payload.data, Math.ceil((HOSTED_HOST_MAX_PTY_INPUT_BYTES * 4) / 3) + 8);
        if (!encoded) throw new SafeRootFileError('invalid_pty_input');
        const data = Buffer.from(encoded, 'base64');
        if (data.byteLength > HOSTED_HOST_MAX_PTY_INPUT_BYTES || !session.pty.write(data))
          throw new SafeRootFileError('pty_unavailable');
        this.audit('pty_input', session, channelId);
        return;
      }
      if (type === 'pty.resize') {
        const cols = integer(payload.cols, 2, 500);
        const rows = integer(payload.rows, 2, 300);
        if (!cols || !rows || !session.pty.resize(cols, rows)) throw new SafeRootFileError('invalid_pty_size');
        this.audit('pty_resize', session, channelId);
        return;
      }
      if (type === 'pty.signal') {
        const signal = string(payload.signal, 16);
        if (!signal || !SAFE_SIGNAL.has(signal) || !session.pty.signal(signal))
          throw new SafeRootFileError('invalid_pty_signal');
        this.audit('pty_signal', session, channelId, signal);
        return;
      }
      if (type === 'pty.kill') {
        session.pty.kill();
        this.audit('pty_killed', session, channelId);
        return;
      }
      if (type === 'file.list') {
        const requestId = this.requestId(payload);
        const entries = await this.files.list(payload.path ?? '.');
        this.send(channelId, { type: 'file.result', requestId, operation: 'list', entries });
        this.audit('file_list', session, channelId);
        return;
      }
      if (type === 'file.read' || type === 'file.download') {
        const requestId = this.requestId(payload);
        const result = await this.files.read(payload.path);
        this.send(channelId, {
          type: 'file.result',
          requestId,
          operation: type === 'file.read' ? 'read' : 'download',
          ...result,
        });
        this.audit(type.replace('.', '_'), session, channelId);
        return;
      }
      if (type === 'file.write' || type === 'file.upload') {
        const requestId = this.requestId(payload);
        const encoded = filePayload(payload.data, Math.ceil((this.files.maxFileBytes * 4) / 3) + 8);
        const encoding = payload.encoding === 'utf8' ? 'utf8' : 'base64';
        if (encoded === null) throw new SafeRootFileError('invalid_file_data');
        const data = Buffer.from(encoded, encoding);
        const requestDigest = digest({ type, path: payload.path, data: encoded, encoding });
        const prior = session.mutationResults.get(requestId);
        if (prior) {
          if (prior.digest !== requestDigest) throw new SafeRootFileError('idempotency_conflict');
          this.send(channelId, prior.payload);
          return;
        }
        const result = await this.files.write(payload.path, data);
        const response = {
          type: 'file.result',
          requestId,
          operation: type === 'file.write' ? 'write' : 'upload',
          ...result,
        };
        session.mutationResults.set(requestId, { digest: requestDigest, payload: response });
        if (session.mutationResults.size > 256)
          session.mutationResults.delete(session.mutationResults.keys().next().value!);
        this.send(channelId, response);
        this.audit(type.replace('.', '_'), session, channelId);
      }
    } catch (error) {
      const code = error instanceof SafeRootFileError ? error.code : 'host_operation_failed';
      this.send(channelId, {
        type: 'operation.error',
        requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
        operation: type,
        code,
      });
      this.audit('operation_denied', session, channelId, code);
    }
  }

  private requestId(payload: Record<string, unknown>): string {
    const requestId = string(payload.requestId, 256);
    if (!requestId) throw new SafeRootFileError('request_id_required');
    return requestId;
  }

  private detach(channelId: string | null, reason: string): void {
    if (!channelId) return;
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    const session = this.sessions.get(channel.sessionKey);
    if (!session) return;
    session.channels.delete(channelId);
    this.audit('channel_detached', session, channelId, reason);
    if (session.channels.size === 0 && !session.closed) {
      session.idleTimer = setTimeout(() => this.destroySession(session, 'session_idle_expired'), this.idleMs);
      session.idleTimer.unref?.();
    }
  }

  private destroySession(session: HostSession, reason: string, kill = true): void {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.removeData();
    session.removeExit();
    if (kill) session.pty.kill();
    this.sessions.delete(session.key);
    for (const channelId of session.channels) {
      this.channels.delete(channelId);
      this.options.send({ type: 'relay.close', channelId, reason });
    }
    session.channels.clear();
    this.audit('pty_closed', session, undefined, reason);
  }

  private broadcastOutput(session: HostSession, data: Buffer): void {
    for (let offset = 0; offset < data.byteLength; offset += OUTPUT_CHUNK_BYTES) {
      const chunk = data.subarray(offset, Math.min(data.byteLength, offset + OUTPUT_CHUNK_BYTES));
      this.broadcast(session, { type: 'pty.output', data: chunk.toString('base64') });
    }
  }

  private broadcast(session: HostSession, payload: unknown): void {
    for (const channelId of session.channels) this.send(channelId, payload);
  }

  private send(channelId: string, payload: unknown): void {
    this.options.send({ type: 'relay', channelId, payload });
  }

  private audit(action: string, session: HostSession, channelId?: string, detail?: string): void {
    const binding = this.options.binding;
    this.onAudit({
      action,
      organizationId: binding.organizationId,
      customerWorkspaceId: binding.customerWorkspaceId,
      hostId: binding.hostId,
      generation: binding.generation,
      userId: session.userId,
      hostedSessionId: session.hostedSessionId,
      channelId,
      detail,
    });
  }
}
