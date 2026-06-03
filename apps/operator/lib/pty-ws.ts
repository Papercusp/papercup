/**
 * pty-ws.ts — WebSocket transport for the embedded pty bridge.
 *
 * Client connects to ws://<host>:<PAPERCUSP_PTY_WS_PORT>/pty/<id> after
 * a successful POST /api/harness/:slug/pty/spawn. The id comes from
 * that response. The HTTP control plane (spawn/prewarm/kill) is
 * unchanged — this just replaces the SSE output + POST input data
 * channels with one full-duplex WebSocket.
 *
 * Wire format:
 *   server → client : binary frames, raw pty bytes (no base64).
 *                     xterm.js's AttachAddon is the canonical consumer
 *                     and decodes Uint8Array as UTF-8.
 *   client → server : binary frames are user input bytes (forwarded to
 *                     writePty). text frames are JSON control messages:
 *                       {type:"resize", cols, rows}
 *                       {type:"ack",    bytes}     // flow control
 *                       {type:"kill"}
 *
 * Flow control (VS Code shape, not Wetty's): coalesce server→client
 * data via a 5 ms throttle, and pause the pty when more than 100 KB
 * of output is unacknowledged by the client. Resume when it drains
 * back below the low watermark. node-pty's own handleFlowControl is
 * also enabled at spawn so pty children that emit XOFF/XON cooperate.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  getPty,
  writePty,
  resizePty,
  killPty,
  markActive,
  getScreenSerialization,
} from './pty-bridge';

// VS Code's terminal flow-control numbers, from
// vscode/src/vs/platform/terminal/common/terminal.ts FlowControlConstants.
// Flow-control watermarks for pty -> ws. Aligned with wetty's defaults
// (2 MB high / 512 KB low) — large enough that interactive pty echo
// never trips pause/resume. Earlier 100 KB cap was tight enough that a
// few omp prompt-redraws filled it, paused the pty mid-burst, and
// produced perceptible jitter on chatty sessions. Client must ack at
// least every (HIGH - LOW) bytes for flow control to work.
const HIGH_WATERMARK_BYTES = 2_097_152;
const LOW_WATERMARK_BYTES = 524_288;

// 2 ms tinybuffer-style coalesce of pty -> ws output. Lifted from
// wetty (mature Node + node-pty browser-terminal); below human
// perception (one frame is 16 ms) and short enough that keystroke
// echo never feels delayed, but long enough to batch the ~7 sub-
// chunks an omp prompt redraw emits per keystroke into one ws
// message. Without it, the 7 chunks become 7 separate term.write
// calls inside one rAF window — measurably stalls that frame on
// the client (51 ms vs 17 ms baseline rAF gap, observed in browser).
//
// Native impls (ttyd, gotty) skip this because their TCP layer
// coalesces with kernel-side TCP_CORK; Node + ws + a chatty shell
// like omp benefit from an explicit JS-side batcher.
const COALESCE_INTERVAL_MS = 2;

interface OriginCheckOptions {
  /** Hosts (without scheme) that may originate WS upgrades. Production. */
  allowedHosts: string[];
  /** Whether to additionally allow localhost-family hosts. Dev. */
  allowLocalhost: boolean;
}

function isAllowedOrigin(origin: string | undefined, opts: OriginCheckOptions): boolean {
  if (!origin) return opts.allowLocalhost; // some clients omit Origin on same-origin
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (opts.allowedHosts.includes(host)) return true;
  if (opts.allowLocalhost) {
    if (host.startsWith('localhost:') || host === 'localhost') return true;
    if (host.startsWith('127.0.0.1:') || host === '127.0.0.1') return true;
    if (host.startsWith('[::1]:') || host === '[::1]') return true;
  }
  return false;
}

export interface PtyWsServerOptions {
  port: number;
  /** Production hosts to allow (e.g. ['operator.papercup.ai']). */
  allowedHosts?: string[];
  /** Allow localhost / loopback origins. Default true; set false in prod. */
  allowLocalhost?: boolean;
}

// Pin started/serverRef on globalThis so HMR re-imports of this module
// (Next dev) don't double-bind the port. Same trick pty-bridge.ts uses
// for the handles map.
type WsGlobals = typeof globalThis & {
  __papercuspPtyWs?: { started: boolean; serverRef: WebSocketServer | null };
};
const _wsGlobals = globalThis as WsGlobals;
const wsState = _wsGlobals.__papercuspPtyWs ?? { started: false, serverRef: null as WebSocketServer | null };
_wsGlobals.__papercuspPtyWs = wsState;

/**
 * Start the pty WS server. Idempotent: a second call (typical under
 * Next dev's instrumentation re-register) is a no-op.
 */
export function startPtyWsServer(opts: PtyWsServerOptions): WebSocketServer | null {
  if (wsState.started) return wsState.serverRef;
  wsState.started = true;

  const wss = new WebSocketServer({
    port: opts.port,
    // We do our own origin check rather than relying on `verifyClient`
    // (which runs synchronously during the upgrade handshake) so the
    // logging path is a normal request handler.
    perMessageDeflate: false, // we send mostly small frames, deflate adds latency
  });
  // EADDRINUSE recovery — if HMR re-imports this module and the
  // globalThis guard above doesn't carry across the new instance, the
  // bind will fail. Tear down cleanly so we don't accumulate orphan
  // listeners and reset wsState so a subsequent restart can rebind.
  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[pty-ws] port ${opts.port} already in use — skipping`);
      try { wss.close(); } catch { /* */ }
      wsState.started = false;
      wsState.serverRef = null;
    } else {
      console.error('[pty-ws] server error:', err);
    }
  });
  wsState.serverRef = wss;

  const originOpts: OriginCheckOptions = {
    allowedHosts: opts.allowedHosts ?? [],
    allowLocalhost: opts.allowLocalhost ?? true,
  };

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, originOpts)) {
      ws.close(4403, 'origin not allowed');
      return;
    }

    // URL is `/pty/<id>`. Anything else is rejected.
    const url = req.url ?? '';
    const m = url.match(/^\/pty\/([a-f0-9-]{8,})\/?$/i);
    if (!m) {
      ws.close(4404, 'unknown route');
      return;
    }
    const ptyId = m[1];

    const handle = getPty(ptyId);
    // Accept a connection to an already-EXITED pty while its handle is still in
    // the 30 s grace window (pty-bridge reaps killed handles 30 s after exit
    // precisely so a late subscriber can read the final screen + exit code).
    // attachWsToPty serves an exited handle correctly: it replays the screen
    // serialization and, because handle.exitCode is set, delivers the `exit`
    // frame and closes. Rejecting `handle.killed` here defeated that grace
    // window and raced a fast `exit`-ing command — if the pty won the race
    // against this connection handler the exit frame was dropped (the client
    // saw `open` but never an `exit` frame). Only a missing/reaped handle is a
    // real 4410.
    if (!handle) {
      ws.close(4410, 'pty not found');
      return;
    }

    void attachWsToPty(ws, ptyId);
  });

  // ── Heartbeat (gotty / ttyd shape) ──────────────────────────────────
  // Server pings every PING_INTERVAL_MS. If a client misses two pongs
  // in a row, the connection is terminate()d so we don't accumulate
  // half-open sockets behind reverse proxies that silently drop idle
  // connections after N minutes. ws library tracks pong responses via
  // `isAlive` flag (canonical pattern from the README).
  const PING_INTERVAL_MS = 30_000;
  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      const tagged = ws as WebSocket & { _isAlive?: boolean };
      if (tagged._isAlive === false) {
        try { ws.terminate(); } catch { /* */ }
        continue;
      }
      tagged._isAlive = false;
      try { ws.ping(); } catch { /* */ }
    }
  }, PING_INTERVAL_MS);
  pingInterval.unref?.();
  wss.on('connection', (ws) => {
    const tagged = ws as WebSocket & { _isAlive?: boolean };
    tagged._isAlive = true;
    ws.on('pong', () => { tagged._isAlive = true; });
  });
  wss.on('close', () => clearInterval(pingInterval));

  wss.on('listening', () => {
    const addr = wss.address();
    const where = typeof addr === 'string' ? addr : `:${addr?.port}`;
    console.log(`[pty-ws] listening on ${where}`);
  });

  wss.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Likely a stale instrumentation re-run from a previous process —
      // give up silently rather than crash the whole operator.
      console.warn(`[pty-ws] port ${opts.port} in use; another operator instance may be running`);
      wsState.started = false;
      return;
    }
    console.error('[pty-ws] server error:', err);
  });

  return wss;
}

async function attachWsToPty(ws: WebSocket, ptyId: string): Promise<void> {
  const handle = getPty(ptyId);
  if (!handle) { ws.close(); return; }

  // ── Server → client coalesce + flow control ─────────────────────────
  // Outgoing chunks are coalesced for COALESCE_INTERVAL_MS into one
  // binary frame (VS Code's TerminalDataBufferer pattern). When the
  // unacknowledged byte count exceeds HIGH_WATERMARK_BYTES we pause
  // the pty (writes from the child block at the kernel pty buffer);
  // the client sends {type:"ack", bytes} as it consumes data, and we
  // resume once back below LOW_WATERMARK_BYTES. node-pty's pause/
  // resume is documented as the right primitive for this.
  let unacked = 0;
  let paused = false;
  // Tinybuffer state: any pending chunks that arrived inside the
  // current 2 ms window. The first chunk after an idle period sets
  // the timer; subsequent chunks within the window get appended.
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let flushTimer: NodeJS.Timeout | null = null;

  const flush = () => {
    flushTimer = null;
    if (pendingChunks.length === 0) return;
    const merged = pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks);
    pendingChunks = [];
    pendingBytes = 0;
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(merged, { binary: true }); } catch { /* socket likely closing */ }
  };

  const onData = (chunk: Buffer) => {
    unacked += chunk.length;
    pendingChunks.push(chunk);
    pendingBytes += chunk.length;
    if (!flushTimer) flushTimer = setTimeout(flush, COALESCE_INTERVAL_MS);
    if (!paused && unacked > HIGH_WATERMARK_BYTES) {
      paused = true;
      try { handle.pty.pause(); } catch { /* node-pty may not support pause on all platforms */ }
    }
  };

  let exitDelivered = false;
  const onExit = (code: number) => {
    if (exitDelivered) return; // idempotent — handle both the live event and the already-exited replay below
    exitDelivered = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush();
    try { ws.send(JSON.stringify({ type: 'exit', code }), { binary: false }); } catch { /* */ }
    try { ws.close(1000, 'pty exited'); } catch { /* */ }
  };

  // Replay current screen state (P4): a string of ANSI escapes that,
  // written into a fresh client xterm, reproduces the canonical screen
  // including scrollback. Bounded by terminal size, not session bytes
  // — orders of magnitude smaller than the byte history for any pty
  // that has run more than a few seconds, and inherently
  // geometry-correct for vim/htop because the headless Terminal
  // resizes alongside the pty.
  const replay = await getScreenSerialization(ptyId);
  if (replay && replay.length > 0) {
    const buf = Buffer.from(replay, 'utf8');
    unacked += buf.length;
    if (ws.readyState === ws.OPEN) {
      try { ws.send(buf, { binary: true }); } catch { /* socket closing */ }
    }
  }

  handle.onData.add(onData);
  handle.onExit.add(onExit);
  // The pty may have already exited during the `await getScreenSerialization`
  // above (e.g. a fast `exit`-ing command). In that case the exit event already
  // fired and handle.onExit was cleared, so the handler we just added will
  // never run — deliver the exit frame + close now from the recorded exitCode.
  if (handle.exitCode !== null) {
    onExit(handle.exitCode);
  }

  // ── Client → server input + control frames ──────────────────────────
  ws.on('message', (data, isBinary) => {
    markActive(ptyId);
    if (isBinary) {
      // Raw bytes from xterm input.
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      writePty(ptyId, buf);
      return;
    }
    // Text frame: JSON control message.
    let msg: { type?: string; cols?: number; rows?: number; bytes?: number };
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch { return; }
    switch (msg.type) {
      case 'resize':
        if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          resizePty(ptyId, Math.floor(msg.cols), Math.floor(msg.rows));
        }
        break;
      case 'ack':
        if (typeof msg.bytes === 'number' && msg.bytes > 0) {
          unacked = Math.max(0, unacked - msg.bytes);
          if (paused && unacked < LOW_WATERMARK_BYTES) {
            paused = false;
            try { handle.pty.resume(); } catch { /* see pause */ }
          }
        }
        break;
      case 'kill':
        killPty(ptyId);
        break;
      // Unknown types are ignored — forward-compat.
    }
  });

  ws.on('close', () => {
    handle.onData.delete(onData);
    handle.onExit.delete(onExit);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (paused) {
      // Don't leave the pty paused if the only consumer disconnected.
      try { handle.pty.resume(); } catch { /* */ }
    }
    // Intentionally NOT calling killPty: the pty stays alive on the
    // server so a remount (tab switch back) can resume it via the
    // existing resumePtyId path. Same policy as the SSE handler.
  });

  ws.on('error', () => { /* let close handler do cleanup */ });
}
