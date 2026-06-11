/**
 * operator Hono host — `@hono/node-server`.
 *
 * Serves the operator's full Hono API (`_hono/app.ts`, basePath `/api`) plus
 * the page-namespace handlers (`/wiki`, `/drizzle-studio`). Replaces the Next
 * route shim (`app/api/[[...route]]/route.ts`).
 *
 * Run:  tsx apps/operator/bin/hono-host.ts        (cwd: apps/operator)
 * Port: PAPERCUSP_HONO_PORT (default 3070 — the production operator host).
 *
 * This file is a pure entrypoint — it always boots when executed. The
 * side-effect-free request handler lives in `./host-handler.ts`.
 *
 * Final home (Phase H): moves to `apps/operator-vite/server/` once `_hono/`
 * relocates there. See operator-vite-migration-2026-05-20.md (Phase C/H).
 */
import { serve } from '@hono/node-server';
import { runBootstrap } from './host-bootstrap';
import { handler } from './host-handler';
import { workspacePinWarning } from '@papercusp/operator-core/lib/workspace-pin-guard';
import { startEventLoopLagMonitor } from '@papercusp/operator-core/lib/event-loop-lag-monitor';
import { startMemoryWatchdog } from '@papercusp/operator-core/lib/memory-watchdog';
import { gracefulHostRecycle } from '@papercusp/operator-core/lib/host-recycle';
import { startPtyWsServer } from '@papercusp/operator-core/lib/pty-ws';

// Resilience guard: when an MCP/SSE client disconnects mid-stream, the
// `mcp-handler` dependency's response adapter enqueues onto an already-closed
// ReadableStream controller → `ERR_INVALID_STATE: Controller is already closed`,
// surfacing as an unhandled rejection that (Node ≥15) terminates the WHOLE host —
// so one agent dropping a connection crash-loops :3070 for the entire fleet. That
// client is already gone; the only casualty should be its one request. Swallow
// ONLY this known-benign stream-close class; preserve fail-fast (exit) for
// everything else so real bugs still surface.
function isBenignStreamClose(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null;
  return (
    !!x &&
    (x.code === 'ERR_INVALID_STATE' || /Controller is already closed/i.test(x.message ?? ''))
  );
}
process.on('unhandledRejection', (reason) => {
  if (isBenignStreamClose(reason)) {
    console.warn('[hono-host] ignored benign stream-close (client disconnected mid-MCP/SSE):', (reason as Error)?.message);
    return;
  }
  console.error('[hono-host] fatal unhandledRejection — exiting:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  if (isBenignStreamClose(err)) {
    console.warn('[hono-host] ignored benign stream-close (uncaught):', err.message);
    return;
  }
  console.error('[hono-host] fatal uncaughtException — exiting:', err);
  process.exit(1);
});

runBootstrap();

// Port/host: `PAPERCUSP_HONO_PORT`/`PAPERCUSP_BIND_HOST` are the explicit
// knobs (dev). The packaged desktop's Tauri main spawns the sidecar with
// the generic `PORT` it already sets for every sidecar — accept that as a
// fallback so G4 needs no extra env wiring. The bind host is deliberately
// NOT read from `HOSTNAME`: that generic var is routinely the machine's
// name in shells/containers, which silently turned the default into a
// non-loopback bind (audit P-027). Binding off-loopback now requires the
// explicit `PAPERCUSP_BIND_HOST` opt-in. (The packaged desktop set
// HOSTNAME=127.0.0.1 anyway, so it is unaffected.)
const port = Number(
  process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? 3070,
);
const hostname = process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1';

// Export the resolved port so selfUrl() builds correct server-side
// self-fetch origins inside this host (the operator brain's agentmcp
// MCP URL, the <spawn> dispatch). Without it selfUrl() falls back to
// the :3055 dev default — post-Vite-migration :3055 is the frontend
// SPA, not this API host, so self-fetches would hit the wrong server.
process.env.PORT = String(port);

// EI-79 observability: a standing event-loop-lag gauge. Silent on a healthy
// host; logs a single structured warning when p95 loop delay over a 10s window
// crosses 100ms — the signal that the main thread is CPU-bound (the exact shape
// that degraded agent-mcp routes to 12-30s while /api/health stayed fast).
startEventLoopLagMonitor();

const server = serve({ fetch: handler, port, hostname }, (info) => {
  console.log(`[hono-host] listening on http://${hostname}:${info.port}`);

  // Guardrail: a stray PAPERCUSP_WORKSPACE_ID pin silently rebinds every
  // non-request path on this multi-workspace host. Warn loudly at boot — a bare
  // `# TEMPORARY` comment in .env.local was not enough to stop one surviving.
  // (Logic + rationale in lib/workspace-pin-guard.ts, unit-tested.)
  const pinWarning = workspacePinWarning();
  if (pinWarning) console.warn(pinWarning);
});

// PTY WebSocket data plane (opt-in via PAPERCUSP_PTY_WS_PORT — bin/dev sets
// 3056). The HTTP control plane (/pty/spawn|input|resize|kill) lives in this
// host's routes, and PiPanel PREFERS ws://:<port>/pty/<id> (AttachAddon) over
// the SSE fallback — but the server lost its boot wiring when the Next
// instrumentation.ts path was retired, leaving the WS transport silently dead
// (pty-stack.integration.test.ts pins it). Must run in THIS process: the pty
// registry the WS attaches to is in-process state shared with the spawn
// routes. Fail-soft on EADDRINUSE (a sibling host already bound it).
const ptyWsPort = Number(process.env.PAPERCUSP_PTY_WS_PORT ?? '');
if (Number.isFinite(ptyWsPort) && ptyWsPort > 0) {
  startPtyWsServer({ port: ptyWsPort });
}

// Bounded-RSS self-recycle: the host leaks retained heap under fleet load
// (~0.2 GB/min, no plateau); past ~4 GB the GC pauses stall the event loop and
// intermittently break MCP mounts / invokes / health (2026-06-07). Recycle at a
// high-water mark BELOW the stall zone — drain in-flight HTTP, then exit; the
// systemd unit's `Restart=always` (RestartSec=5s) brings up a fresh low-RSS
// process. The PAPERCUSP_* env knobs let an operator tune/disable without a
// redeploy. See lib/memory-watchdog.ts.
if (process.env.PAPERCUSP_MEMORY_WATCHDOG !== '0') {
  const limitMb = Number(process.env.PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB) || 3200;
  startMemoryWatchdog({
    rssLimitMb: limitMb,
    onTrip: ({ rssMb }) => {
      console.warn(
        '[memory-watchdog] RSS high-water mark tripped — draining + recycling host (systemd will restart)',
        { rssMb, rssLimitMb: limitMb },
      );
      // Drain in-flight HTTP + tear down the P2P substrate (Hypercores,
      // Hyperswarm sockets, PG LISTEN close-hooks) before exit — a bare
      // process.exit() abandons those handles (audit P-002, EI-127). The
      // helper hard-exits after 8s if either side hangs.
      gracefulHostRecycle({ server: server as { close?: (cb?: () => void) => void } });
    },
  });
}
