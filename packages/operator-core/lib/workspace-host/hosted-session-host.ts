/**
 * Workspace-host half of the outbound hosted terminal/file/desktop relay.
 *
 * The control plane owns the WebSocket and forwards generation-bound relay
 * envelopes here. This module never listens on a VM port. It binds every PTY
 * to the authenticated connector identity + browser principal and constrains
 * generic file operations to one server-selected project root.
 *
 * ## Desktop channels (P-013 / D-023)
 *
 * A channel is a PTY or a DESKTOP. Because the host never listens, a desktop
 * viewer is not a listener we expose: the adapter DIALS the sandbox's
 * loopback-bound KasmVNC websocket as a CLIENT and pumps bytes over the existing
 * outbound relay. D-020's "loopback-only" property is therefore preserved by
 * construction rather than by configuration.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getScreenSerialization, spawnPty, type PtyHandle } from '../pty-bridge';
import type { PtyAccessScope } from '../pty-ticket';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import type { KasmvncSessionCredentials } from '../desktop/kasmvnc-credentials';
import {
  assertLoopbackDesktopEndpoint,
  desktopViewersHold,
  desktopViewerHeartbeatMs,
  hostedDesktopGrant,
  HostedDesktopEndpointError,
  type HostedDesktopAction,
  type HostedDesktopAttachment,
  type HostedDesktopEndpoint,
  type HostedDesktopGrant,
} from '../desktop/hosted-desktop-channel';

export const HOSTED_HOST_MAX_MESSAGE_BYTES = 1024 * 1024;
export const HOSTED_HOST_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const HOSTED_HOST_MAX_PTY_INPUT_BYTES = 64 * 1024;
export const HOSTED_HOST_SESSION_IDLE_MS = 15 * 60_000;
/**
 * Cap on ONE viewer→sandbox RFB write.
 *
 * Client→server RFB messages are small (key, pointer, encoding and update
 * requests); the one that can grow is a clipboard paste. 256 KiB is far above a
 * legitimate paste and far below `HOSTED_HOST_MAX_MESSAGE_BYTES`, so a hostile
 * viewer cannot use the desktop plane to push megabyte envelopes at the sandbox.
 */
export const HOSTED_HOST_MAX_DESKTOP_FRAME_BYTES = 256 * 1024;

const OUTPUT_CHUNK_BYTES = 48 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_000;
const SAFE_SIGNAL = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL']);

export type HostedHostTabRole = 'controller' | 'observer';

/**
 * What a channel carries. `observer`/`controller` says WHO the viewer is; this
 * says WHAT they attached to.
 */
export type HostedHostChannelKind = 'pty' | 'desktop';

export interface HostedHostRelayOpen {
  type: 'relay.open';
  channelId: string;
  userId: string;
  hostedSessionId: string;
  audience: string;
  role: HostedHostTabRole;
  /**
   * Absent means `'pty'`.
   *
   * NOT a back-compat shim for dead code: the control plane and the workspace
   * host are SEPARATELY deployed across a real version skew (the host runs in
   * the customer's VM on a pinned generation). An envelope minted by a control
   * plane that predates this field must keep opening terminals, or updating the
   * host would break every live terminal tab. The default is therefore part of
   * the wire contract, and is pinned by a test.
   */
  kind?: HostedHostChannelKind;
  /** Required when `kind === 'desktop'`; ignored otherwise. */
  desktopSessionId?: string;
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

/** One live byte pipe to the sandbox's loopback KasmVNC websocket. */
export interface HostedDesktopSocket {
  /** Forward viewer→sandbox RFB bytes. `false` means the pipe is gone. */
  send(data: Buffer): boolean;
  close(): void;
  onData(listener: (data: Buffer) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
}

/** What the adapter needs about a sandbox desktop before it may dial one. */
export interface HostedDesktopSessionRecord {
  /**
   * Where the session listens, or null when it serves none (an Xvfb backend is
   * started `-nolisten tcp`). Never trusted blindly — `assertLoopbackDesktopEndpoint`
   * re-checks it at the moment of dialling.
   */
  endpoint: HostedDesktopEndpoint | null;
  /** The session's view-only and control users (P-012, D-020). */
  credentials: Pick<KasmvncSessionCredentials, 'view' | 'control'>;
}

export interface HostedDesktopDialInput {
  desktopSessionId: string;
  /** Already asserted loopback by the adapter — the dialler need not re-check. */
  endpoint: HostedDesktopEndpoint;
  /** Carries exactly ONE of the session's two secrets. Never both. */
  grant: HostedDesktopGrant;
}

/**
 * The side-effecting half of the desktop plane, injected so the adapter itself
 * stays socket-free and unit-testable.
 *
 * Deliberately NOT the desktop session registry: the adapter must not learn how
 * sessions are stored, and the composition root is where a registry read becomes
 * one of these. That keeps the workspace host free of control-plane schema.
 */
export interface HostedDesktopBackend {
  /** Resolve a desktop session id; null when unknown, ended, or not this host's. */
  lookup(desktopSessionId: string): Promise<HostedDesktopSessionRecord | null>;
  /** Dial the sandbox's loopback websocket as a CLIENT (D-023 ruling 1). */
  dial(input: HostedDesktopDialInput): Promise<HostedDesktopSocket>;
  /** Touch `last_active_at` on the registry row while a viewer is attached (D-008 rule 4). */
  heartbeat(desktopSessionId: string): void;
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
  /**
   * Omitted on a host with no desktop pack installed. A `kind:'desktop'` open is
   * then REFUSED rather than silently opening a channel that can never carry
   * pixels.
   */
  desktop?: HostedDesktopBackend;
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

/**
 * The channel index, discriminated so one `channelId` namespace covers both
 * planes — which is what makes the `channel_already_open` check and `relay.close`
 * dispatch uniform instead of two half-checks that can disagree.
 */
type Channel =
  | { kind: 'pty'; sessionKey: string; role: HostedHostTabRole }
  | { kind: 'desktop'; desktopSessionId: string; role: HostedHostTabRole };

type DesktopChannel = {
  channelId: string;
  userId: string;
  hostedSessionId: string;
  desktopSessionId: string;
  role: HostedHostTabRole;
  /**
   * The grant's non-secret residue. The SECRET is deliberately not kept: it is
   * consumed by the dial and then unreachable, so a later bug in this file
   * cannot log, serialise, or re-send it. Tranche 1 keeps a grant from ever
   * holding both secrets; this keeps it from outliving its single use.
   */
  action: HostedDesktopAction;
  inputAllowed: boolean;
  /** null while the dial is still in flight. */
  socket: HostedDesktopSocket | null;
  closed: boolean;
  teardown: Array<() => void>;
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
  private readonly desktopChannels = new Map<string, DesktopChannel>();
  /**
   * Only channels whose dial SUCCEEDED. Kept separate from `desktopChannels` (which
   * includes in-flight dials) because this is what `desktopViewersHold` is asked
   * about: a viewer that is still connecting is not yet holding the desktop awake.
   */
  private readonly attachments = new Map<string, HostedDesktopAttachment>();
  private desktopHeartbeat: ManagedHandle | null = null;
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
    // notify:false — the broadcast above already told the control plane about
    // every channel, including these.
    for (const desktop of [...this.desktopChannels.values()]) this.closeDesktopChannel(desktop, reason, false);
    for (const session of [...this.sessions.values()]) this.destroySession(session, reason);
    this.desktopHeartbeat?.stop();
    this.desktopHeartbeat = null;
    this.channels.clear();
  }

  private async open(message: Record<string, unknown>): Promise<void> {
    const channelId = string(message.channelId, 256);
    const userId = string(message.userId);
    const hostedSessionId = string(message.hostedSessionId);
    const audience = string(message.audience);
    const role = message.role === 'controller' || message.role === 'observer' ? message.role : null;
    // Absent `kind` is 'pty' (wire contract, see HostedHostRelayOpen); an
    // UNRECOGNISED kind is rejected rather than defaulted, so a future channel
    // type can never silently open a terminal.
    const kind: HostedHostChannelKind | null =
      message.kind === undefined || message.kind === 'pty' ? 'pty' : message.kind === 'desktop' ? 'desktop' : null;
    if (!channelId || !userId || !hostedSessionId || audience !== 'workspace-operator' || !role || !kind) return;
    if (this.channels.has(channelId)) {
      this.options.send({ type: 'relay.close', channelId, reason: 'channel_already_open' });
      return;
    }

    if (kind === 'desktop') {
      await this.openDesktop(channelId, userId, hostedSessionId, role, string(message.desktopSessionId));
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
    this.channels.set(channelId, { kind: 'pty', sessionKey: key, role });
    this.send(channelId, { type: 'pty.ready', resumed, role });
    const snapshot = await session.pty.snapshot();
    // Re-entrancy guard: the channel may have been detached — or reused by a
    // different session, or by a DESKTOP open — while the snapshot was awaited.
    const current = this.channels.get(channelId);
    if (snapshot && current?.kind === 'pty' && current.sessionKey === key) {
      this.send(channelId, { type: 'pty.snapshot', data: Buffer.from(snapshot, 'utf8').toString('base64') });
    }
    this.audit(resumed ? 'pty_resumed' : 'channel_attached', session, channelId);
  }

  /**
   * Attach one viewer to a sandbox desktop.
   *
   * ## Why the role is fixed here and never upgraded in place
   *
   * `watch` and `takeover` are distinguished by WHICH credential authenticated
   * the dial, so a channel cannot change privilege without a new dial. There is
   * deliberately no "promote this observer" path: a takeover is a fresh
   * `relay.open` that mints its own audit event. That makes privilege escalation
   * impossible to express rather than merely disallowed, and it is what gives the
   * hosted path audit parity with the local one.
   *
   * ## Why an observer's bytes are not filtered
   *
   * The relay carries the RFB protocol, in which input (KeyEvent, PointerEvent)
   * is interleaved with traffic an observer legitimately MUST send —
   * FramebufferUpdateRequest is how it receives pixels at all. RFB messages are
   * variable-length and stateful, so a per-chunk byte filter cannot align with
   * message boundaries and would be security theatre. View-only is enforced where
   * it is actually decidable: KasmVNC drops input from the `-r` view user
   * (P-012 / D-020). `inputAllowed` is reported to the viewer so it can disable
   * its own input affordances, and is NOT a gate.
   */
  private async openDesktop(
    channelId: string,
    userId: string,
    hostedSessionId: string,
    role: HostedHostTabRole,
    desktopSessionId: string | null,
  ): Promise<void> {
    const backend = this.options.desktop;
    if (!desktopSessionId || !backend) {
      this.options.send({
        type: 'relay.close',
        channelId,
        reason: desktopSessionId ? 'desktop_unsupported' : 'desktop_session_required',
      });
      return;
    }

    // Reserve the id SYNCHRONOUSLY, before the first await: a second open for the
    // same channelId must lose the `channel_already_open` race rather than run a
    // parallel dial that leaks a socket.
    const channel: DesktopChannel = {
      channelId,
      userId,
      hostedSessionId,
      desktopSessionId,
      role,
      action: role === 'controller' ? 'takeover' : 'watch',
      inputAllowed: role === 'controller',
      socket: null,
      closed: false,
      teardown: [],
    };
    this.channels.set(channelId, { kind: 'desktop', desktopSessionId, role });
    this.desktopChannels.set(channelId, channel);

    try {
      const record = await backend.lookup(desktopSessionId);
      if (!record) throw new SafeRootFileError('desktop_session_unknown');
      const endpoint = assertLoopbackDesktopEndpoint(record.endpoint);
      const grant = hostedDesktopGrant(role, record.credentials);
      const socket = await backend.dial({ desktopSessionId, endpoint, grant });
      // A detach that landed while we were dialling wins: drop the socket we just
      // opened rather than attaching it to a channel nobody is holding.
      if (channel.closed || this.desktopChannels.get(channelId) !== channel) {
        socket.close();
        return;
      }
      channel.socket = socket;
      channel.teardown.push(socket.onData((data) => this.sendDesktopFrames(channel, data)));
      channel.teardown.push(socket.onClose((reason) => this.closeDesktopChannel(channel, reason || 'desktop_closed')));
      this.attachments.set(channelId, {
        channelId,
        desktopSessionId,
        action: grant.action,
        endpoint,
      });
      this.send(channelId, {
        type: 'desktop.ready',
        action: grant.action,
        inputAllowed: grant.inputAllowed,
      });
      this.audit(grant.auditAction, channel, channelId, `desktop=${desktopSessionId}`);
      this.startDesktopHeartbeat();
    } catch (error) {
      const code =
        error instanceof HostedDesktopEndpointError || error instanceof SafeRootFileError
          ? error.code
          : 'desktop_dial_failed';
      this.audit('desktop_denied', channel, channelId, code);
      this.closeDesktopChannel(channel, code);
    }
  }

  private async relay(message: Record<string, unknown>): Promise<void> {
    const channelId = string(message.channelId, 256);
    if (!channelId) return;
    const channel = this.channels.get(channelId);
    if (!channel) return;
    const payload = object(message.payload);
    if (!payload) return;
    const type = string(payload.type, 64);
    if (!type) return;

    if (channel.kind === 'desktop') {
      this.relayDesktop(channelId, type, payload);
      return;
    }

    const session = this.sessions.get(channel.sessionKey);
    if (!session || session.closed) return;

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

  /**
   * Viewer→sandbox. One opaque RFB byte stream, deliberately unparsed (see
   * `openDesktop`), so the only operation on this plane is `desktop.data`.
   *
   * Frames are NOT audited individually: an interactive desktop emits input at
   * pointer-motion rate, and an audit line per frame would bury the events that
   * matter (attach, takeover, detach, denial) in noise. That is a different
   * choice from the PTY plane on purpose — a keystroke there is a discrete
   * auditable command, a mouse move here is not.
   */
  private relayDesktop(channelId: string, type: string, payload: Record<string, unknown>): void {
    const channel = this.desktopChannels.get(channelId);
    if (!channel || channel.closed) return;
    if (type !== 'desktop.data') {
      this.send(channelId, { type: 'operation.error', operation: type, code: 'invalid_desktop_operation' });
      this.audit('operation_denied', channel, channelId, 'invalid_desktop_operation');
      return;
    }
    // Still dialling: drop. RFB clients re-request the framebuffer, so a dropped
    // pre-attach write costs a repaint, never correctness.
    if (!channel.socket) return;
    const encoded = string(payload.data, Math.ceil((HOSTED_HOST_MAX_DESKTOP_FRAME_BYTES * 4) / 3) + 8);
    if (!encoded) {
      this.send(channelId, { type: 'operation.error', operation: type, code: 'invalid_desktop_data' });
      return;
    }
    const data = Buffer.from(encoded, 'base64');
    if (data.byteLength > HOSTED_HOST_MAX_DESKTOP_FRAME_BYTES || !channel.socket.send(data)) {
      this.closeDesktopChannel(channel, 'desktop_unavailable');
    }
  }

  /** Sandbox→viewer, chunked like PTY output so one large update cannot exceed the envelope cap. */
  private sendDesktopFrames(channel: DesktopChannel, data: Buffer): void {
    if (channel.closed) return;
    for (let offset = 0; offset < data.byteLength; offset += OUTPUT_CHUNK_BYTES) {
      const chunk = data.subarray(offset, Math.min(data.byteLength, offset + OUTPUT_CHUNK_BYTES));
      this.send(channel.channelId, { type: 'desktop.data', data: chunk.toString('base64') });
    }
  }

  /**
   * One heartbeat for the whole adapter, armed while ANY viewer is attached
   * (D-008 rule 4). This is what lets the idle-freeze window drop from hours to
   * minutes: a desktop somebody is watching must never be reaped as idle.
   *
   * `managedSetInterval` rather than a bare timer so it is visible in
   * `schedule:inventory`; `instanced` because an adapter is per-connector and
   * several can share a process.
   */
  private startDesktopHeartbeat(): void {
    if (this.desktopHeartbeat || !desktopViewersHold(this.attachments)) return;
    this.desktopHeartbeat = managedSetInterval(
      'hosted-desktop-viewer-heartbeat',
      desktopViewerHeartbeatMs(),
      () => this.beatDesktops(),
      { category: 'lifecycle', instanced: true, classification: 'must-sample' },
    );
  }

  private beatDesktops(): void {
    const backend = this.options.desktop;
    if (!backend) return;
    // De-duplicated by desktop: two tabs watching one desktop is ONE beat.
    const beaten = new Set<string>();
    for (const attachment of this.attachments.values()) {
      if (beaten.has(attachment.desktopSessionId)) continue;
      beaten.add(attachment.desktopSessionId);
      try {
        backend.heartbeat(attachment.desktopSessionId);
      } catch {
        /* a failed beat must never tear down a working viewer */
      }
    }
  }

  private stopDesktopHeartbeatIfIdle(): void {
    if (desktopViewersHold(this.attachments)) return;
    this.desktopHeartbeat?.stop();
    this.desktopHeartbeat = null;
  }

  /**
   * Tear one desktop channel down exactly once.
   *
   * `notify` is false when the control plane already knows (it asked for the
   * close, or `close()` is broadcasting), true when the sandbox end went away and
   * the viewer must be told.
   */
  private closeDesktopChannel(channel: DesktopChannel, reason: string, notify = true): void {
    if (channel.closed) return;
    channel.closed = true;
    this.channels.delete(channel.channelId);
    this.desktopChannels.delete(channel.channelId);
    this.attachments.delete(channel.channelId);
    for (const off of channel.teardown.splice(0)) {
      try {
        off();
      } catch {
        /* a listener that is already gone is not an error */
      }
    }
    try {
      channel.socket?.close();
    } catch {
      /* already closed */
    }
    if (notify) this.options.send({ type: 'relay.close', channelId: channel.channelId, reason });
    this.audit('desktop_detached', channel, channel.channelId, reason);
    this.stopDesktopHeartbeatIfIdle();
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
    if (channel.kind === 'desktop') {
      const desktop = this.desktopChannels.get(channelId);
      // The control plane initiated this close, so it needs no echo back.
      if (desktop) this.closeDesktopChannel(desktop, reason, false);
      return;
    }
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

  /**
   * `identity` is widened to the two fields actually read rather than a
   * `HostSession`, so a desktop channel — which has no PTY session — audits
   * through the SAME path with the same connector binding. Both channel state
   * types satisfy it structurally, so every existing call site is unchanged.
   */
  private audit(
    action: string,
    identity: { userId: string; hostedSessionId: string },
    channelId?: string,
    detail?: string,
  ): void {
    const binding = this.options.binding;
    this.onAudit({
      action,
      organizationId: binding.organizationId,
      customerWorkspaceId: binding.customerWorkspaceId,
      hostId: binding.hostId,
      generation: binding.generation,
      userId: identity.userId,
      hostedSessionId: identity.hostedSessionId,
      channelId,
      detail,
    });
  }
}
