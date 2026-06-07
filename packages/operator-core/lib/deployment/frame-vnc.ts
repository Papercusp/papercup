/**
 * On-demand frame VNC sessions
 * (`hive-frame-desktops-live-view-2026-06-06` P-008/P-010, D-002).
 *
 * The live-view click-through: a noVNC client in the operator webview connects
 * to a loopback WebSocket here; each accepted connection spawns
 * `x11vnc -inetd` on the frame OVER THE DEPLOY LAYER'S SSH CHANNEL and pipes
 * RFB bytes WS ↔ ssh-child-stdio. Properties this buys:
 *
 *   - **No VNC listener on the frame, ever.** `-inetd` speaks RFB on
 *     stdin/stdout of the per-session process — there is no 5900, not even on
 *     localhost. (Stronger than the plan's "localhost-only" floor.)
 *   - **On-demand lifecycle**: the x11vnc process exists exactly while a
 *     viewer's WS is open (`-once`); WS close kills the ssh child (P-010 idle
 *     teardown), plus a hard max-session TTL.
 *   - **Ticketed auth** (P-010): sessions are minted by the authenticated
 *     HTTP route (session cookie) and the WS connect must present the
 *     single-use ticket within 30s. The WS itself binds loopback-only (the
 *     desktop-voice-ws model).
 *   - **Read-only by default** (D-002): `-viewonly` unless the session was
 *     explicitly created with mode 'takeover'; takeover start/stop is written
 *     to the workspace audit_log.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { buildSshStreamArgs } from './remote-exec';
import { sshTargetForFrame } from './frame-installer';
import { loadDeployedFrame } from './deployed-frame';

export type VncMode = 'watch' | 'takeover';

export interface VncSessionRequest {
  slug: string;
  workspaceId: string;
  display: number;
  mode: VncMode;
  /** Who asked (the session user) — recorded on the audit events. */
  actor: string;
}

export interface VncTicket {
  ticket: string;
  wsPath: string;
  /** Loopback WS port (null until the server bound). */
  wsPort: number | null;
  mode: VncMode;
  display: number;
  slug: string;
}

interface PendingSession extends VncSessionRequest {
  ticket: string;
  createdAt: number;
  sshCmd: { cmd: string; args: string[] };
}

export interface ActiveVncSession {
  slug: string;
  display: number;
  mode: VncMode;
  actor: string;
  sinceMs: number;
}

/** Unconsumed tickets expire after this long (P-010). */
export const VNC_TICKET_TTL_MS = 30_000;
/** Hard cap on a connected session (safety net over idle teardown). */
export const VNC_MAX_SESSION_MS = 2 * 60 * 60 * 1000;
export const VNC_WS_PATH = '/api/deploy/vnc';

export interface FrameVncDeps {
  loadFrame?: typeof loadDeployedFrame;
  spawn?: typeof nodeSpawn;
  /** Audit sink — defaults to the workspace audit_log writer. */
  audit?: (ev: { action: string; actor: string; subject: string; details: Record<string, unknown> }) => void;
  now?: () => number;
}

const pending = new Map<string, PendingSession>();
const active = new Map<string, ActiveVncSession>();

let depsOverride: FrameVncDeps = {};
export function _setFrameVncDepsForTests(d: FrameVncDeps): void {
  depsOverride = d;
}
export function _resetFrameVncForTests(): void {
  depsOverride = {};
  pending.clear();
  active.clear();
}

const now = () => (depsOverride.now ?? Date.now)();

/** Default audit sink: the workspace audit_log (same table audit:list reads). */
function defaultAudit(ev: { action: string; actor: string; subject: string; details: Record<string, unknown> }): void {
  void (async () => {
    try {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const { withWorkspace, generated } = await import('@papercusp/db-org');
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const al = generated.auditLogInHarnessShared;
      const workspaceId = activeWorkspaceId();
      await withWorkspace(workspaceId, async (tx) => {
        const txDb = drizzle(tx as never);
        await txDb.insert(al).values({
          id: `vnc-${now().toString(36)}-${randomBytes(4).toString('hex')}`,
          ts: now(),
          actor: ev.actor,
          action: ev.action,
          subject: ev.subject,
          details: ev.details as never,
          workspaceId,
        });
      });
    } catch (err) {
      console.warn('[frame-vnc] audit write failed:', err);
    }
  })();
}

const audit = (ev: { action: string; actor: string; subject: string; details: Record<string, unknown> }) =>
  (depsOverride.audit ?? defaultAudit)(ev);

/**
 * The command a session runs on the frame (exported for tests).
 *
 * x11vnc's `-inetd` mode does NOT work over an SSH channel: it does socket
 * syscalls (getnameinfo/setsockopt TCP_NODELAY) on stdin/stdout, but SSH gives
 * PIPES, not sockets, so it bails before the RFB greeting ("Socket operation
 * on non-socket" — verified live 2026-06-06). So instead: x11vnc listens on a
 * fresh LOCALHOST-only autoport (never 0.0.0.0 — not network-exposed), and
 * `socat` bridges that port to the SSH stdio. Properties preserved:
 *   - no network-exposed VNC port (x11vnc `-localhost`, autoport ≥5900),
 *   - on-demand (`-once` → x11vnc exits when socat, its one client, leaves;
 *     `-timeout 30` → self-exit if the bridge never connects),
 *   - read-only via `-viewonly` for watch mode (D-002).
 * The whole thing is a `bash -c` so buildSshStreamArgs can prefix `sudo -H`.
 */
export function vncRemoteCommand(display: number, mode: VncMode): string {
  const viewonly = mode === 'takeover' ? '' : ' -viewonly';
  // No single quotes inside the script (it's wrapped in single quotes here).
  const script =
    `P=$(x11vnc -display :${display} -localhost -nopw${viewonly} -once -timeout 30 -autoport 5900 -bg 2>/dev/null ` +
    `| sed -n "s/.*PORT=\\([0-9]*\\).*/\\1/p"); ` +
    `[ -n "$P" ] || { echo "x11vnc-no-port" >&2; exit 9; }; ` +
    `exec socat STDIO TCP:127.0.0.1:$P`;
  return `bash -c '${script}'`;
}

/**
 * Mint a single-use VNC session ticket for a deployed frame's display. The
 * authenticated HTTP route calls this; the returned ticket is consumed by the
 * WS connect. Throws if the harness has no deployed frame.
 */
export async function createVncSession(req: VncSessionRequest): Promise<VncTicket> {
  const loadFrame = depsOverride.loadFrame ?? loadDeployedFrame;
  const loaded = await loadFrame(req.slug, req.workspaceId);
  if (!loaded) throw new Error(`harness '${req.slug}' has no deployed frame`);
  const target = sshTargetForFrame(loaded.frame, loaded.config);
  const sshCmd = buildSshStreamArgs(target, vncRemoteCommand(req.display, req.mode));
  const ticket = randomBytes(24).toString('hex');
  pending.set(ticket, { ...req, ticket, createdAt: now(), sshCmd });
  audit({
    action: `frame-vnc.${req.mode === 'takeover' ? 'takeover-requested' : 'watch-requested'}`,
    actor: req.actor,
    subject: `${req.slug}:${req.display}`,
    details: { slug: req.slug, display: req.display, mode: req.mode },
  });
  // GC stale pending tickets opportunistically.
  for (const [t, s] of pending) {
    if (now() - s.createdAt > VNC_TICKET_TTL_MS) pending.delete(t);
  }
  return {
    ticket,
    wsPath: VNC_WS_PATH,
    wsPort: getFrameVncPort(),
    mode: req.mode,
    display: req.display,
    slug: req.slug,
  };
}

/** Consume a ticket (single-use, TTL-bounded). Exported for the WS handler + tests. */
export function consumeTicket(ticket: string): PendingSession | undefined {
  const s = pending.get(ticket);
  if (!s) return undefined;
  pending.delete(ticket);
  if (now() - s.createdAt > VNC_TICKET_TTL_MS) return undefined;
  return s;
}

/** Active sessions for a slug — the D-002 session indicator the live view shows. */
export function activeVncSessions(slug?: string): ActiveVncSession[] {
  const all = [...active.values()];
  return slug ? all.filter((s) => s.slug === slug) : all;
}

/** The minimal WS surface the RFB byte-pipe needs (satisfied by `ws.WebSocket`). */
export interface VncBridgeWs {
  on(event: 'message', cb: (data: Buffer) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * Bridge an accepted (ticket-validated) WS to the session's ssh `x11vnc -inetd`
 * child: WS messages → child stdin, child stdout → WS binary frames. Teardown
 * is symmetric and kills the WHOLE child tree (the ssh process group).
 * Exported for unit tests (driven with a fake spawn + fake WS).
 */
export function bridgeVncSession(ws: VncBridgeWs, session: PendingSession): ChildProcess {
  const spawn = depsOverride.spawn ?? nodeSpawn;
  const child = spawn(session.sshCmd.cmd, session.sshCmd.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group → tree-kill on teardown
  });
  const key = session.ticket;
  active.set(key, {
    slug: session.slug,
    display: session.display,
    mode: session.mode,
    actor: session.actor,
    sinceMs: now(),
  });
  audit({
    action: `frame-vnc.${session.mode === 'takeover' ? 'takeover-started' : 'watch-started'}`,
    actor: session.actor,
    subject: `${session.slug}:${session.display}`,
    details: { slug: session.slug, display: session.display, mode: session.mode },
  });

  let open = true;
  const endSession = (why: string) => {
    if (!open) return;
    open = false;
    clearTimeout(maxTimer);
    active.delete(key);
    audit({
      action: 'frame-vnc.ended',
      actor: session.actor,
      subject: `${session.slug}:${session.display}`,
      details: { slug: session.slug, display: session.display, mode: session.mode, why },
    });
    // Kill the whole ssh process group; fall back to a single-PID kill when
    // the group send fails OR the child never got a pid (early spawn failure).
    let killed = false;
    const pid = child.pid;
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
        killed = true;
      } catch {
        /* fall through to single-PID kill */
      }
    }
    if (!killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
    try {
      ws.close();
    } catch {
      /* gone */
    }
  };

  const maxTimer = setTimeout(() => endSession('max-session-ttl'), VNC_MAX_SESSION_MS);

  child.stdout?.on('data', (chunk: Buffer) => {
    try {
      ws.send(chunk);
    } catch {
      /* ws gone */
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = String(chunk).trim();
    if (line) console.warn(`[frame-vnc] ${session.slug}:${session.display} ssh: ${line.slice(0, 300)}`);
  });
  child.on('close', () => endSession('remote-closed'));
  child.on('error', () => endSession('spawn-error'));
  ws.on('message', (data: Buffer) => {
    try {
      child.stdin?.write(data);
    } catch {
      /* child gone */
    }
  });
  ws.on('close', () => endSession('viewer-left'));
  return child;
}

// ── loopback WS server (the desktop-voice-ws model) ─────────────────────────

const BASE_PORT = Number(process.env.PAPERCUSP_FRAME_VNC_WS_PORT ?? 3078);
const PORT_RANGE = 8;

type FrameVncGlobals = typeof globalThis & {
  __papercuspFrameVncWs?: { started: boolean; chosenPort: number | null; wss: unknown };
};
const _g = globalThis as FrameVncGlobals;
const state = _g.__papercuspFrameVncWs ?? { started: false, chosenPort: null as number | null, wss: null as unknown };
_g.__papercuspFrameVncWs = state;

export function getFrameVncPort(): number | null {
  return state.chosenPort;
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

let startingPromise: Promise<number | null> | null = null;

/** Lazy-start the loopback VNC WS bridge (first vnc-session request). Concurrent
 *  callers share ONE in-flight bind (no TOCTOU on `state.started` → null port). */
export async function startFrameVncWs(): Promise<number | null> {
  if (state.chosenPort !== null) return state.chosenPort;
  if (!startingPromise) {
    startingPromise = doStartFrameVncWs().finally(() => {
      startingPromise = null;
    });
  }
  return startingPromise;
}

async function doStartFrameVncWs(): Promise<number | null> {
  if (state.chosenPort !== null) return state.chosenPort;
  state.started = true;
  const { WebSocketServer } = await import('ws');
  await new Promise<void>((resolve) => {
    const tryListen = (port: number, attempt: number) => {
      const wss = new WebSocketServer({ port, host: '127.0.0.1', path: VNC_WS_PATH });
      wss.on('connection', (ws, req) => {
        if (!isLoopback(req)) {
          ws.close(1008, 'loopback only');
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const session = consumeTicket(url.searchParams.get('ticket') ?? '');
        if (!session) {
          ws.close(1008, 'invalid or expired ticket');
          return;
        }
        bridgeVncSession(ws as unknown as VncBridgeWs, session);
      });
      wss.on('listening', () => {
        state.chosenPort = port;
        state.wss = wss;
        console.log(`[frame-vnc] listening on 127.0.0.1:${port}${VNC_WS_PATH}`);
        resolve();
      });
      wss.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && attempt + 1 < PORT_RANGE) {
          try {
            wss.close();
          } catch {
            /* ignore */
          }
          tryListen(port + 1, attempt + 1);
          return;
        }
        console.error('[frame-vnc] ws server failed to bind:', e.message);
        state.started = false; // allow a later retry to re-attempt the bind
        resolve();
      });
    };
    tryListen(BASE_PORT, 0);
  });
  return state.chosenPort;
}
