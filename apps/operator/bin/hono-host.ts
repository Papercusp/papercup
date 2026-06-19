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
import cluster from 'node:cluster';
import { serve, createAdaptorServer } from '@hono/node-server';
import { runBootstrap } from './host-bootstrap';
import { handler } from './host-handler';
import { workspacePinWarning } from '@papercusp/operator-core/lib/workspace-pin-guard';
import { startEventLoopLagMonitor } from '@papercusp/operator-core/lib/event-loop-lag-monitor';
import { startLoopPressureGovernor } from '@papercusp/operator-core/lib/loop-pressure-governor';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { startMemoryWatchdog } from '@papercusp/operator-core/lib/memory-watchdog';
import { gracefulHostRecycle } from '@papercusp/operator-core/lib/host-recycle';
import { startInfraLivenessAlarm } from '@papercusp/operator-core/lib/system-health/liveness-alarm';
import { startLagSelfRestart } from '@papercusp/operator-core/lib/system-health/lag-self-restart';
import { startSinglePrimaryGuard } from '@papercusp/operator-core/lib/system-health/single-primary-check';
import { startPtyWsServer } from '@papercusp/operator-core/lib/pty-ws';
import {
  startCluster,
  resolveClusterWorkers,
  resolveExpectedOperatorProcs,
} from '@papercusp/operator-core/lib/cluster-fork';
import { getResourceProfile } from '@papercusp/operator-core/lib/resource-profile';
import { isBenignHostError } from './host-benign-errors';

// Resilience guard: the multi-tenant host must never let ONE bad inbound frame
// crash-loop :3070 for the entire fleet. Two known classes originate inside the
// `mcp-handler` dependency's detached write/parse pump and reach us as unhandled
// rejections we can't try/catch at the call site:
//   • EI-12  — a client disconnects mid-stream → enqueue onto an already-closed
//              ReadableStream controller (ERR_INVALID_STATE).
//   • EI-714 — a malformed JSON-RPC body → a JSON.parse SyntaxError in the pump.
// Both are client-caused + request-scoped (the only casualty should be that one
// request), so SWALLOW them; preserve fail-fast (exit) for everything else so
// real host bugs still surface. Classification lives in host-benign-errors.ts
// (unit-tested) so the predicate set is auditable, not buried inline.
process.on('unhandledRejection', (reason) => {
  if (isBenignHostError(reason)) {
    console.warn(
      '[hono-host] ignored benign client-caused error (request-scoped, host kept alive):',
      (reason as Error)?.message ?? reason,
    );
    return;
  }
  console.error('[hono-host] fatal unhandledRejection — exiting:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  if (isBenignHostError(err)) {
    console.warn(
      '[hono-host] ignored benign client-caused error (uncaught, host kept alive):',
      err.message,
    );
    return;
  }
  console.error('[hono-host] fatal uncaughtException — exiting:', err);
  process.exit(1);
});

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

/**
 * Start the request-serving plane: the HTTP server + per-process loop monitors +
 * (opt-in) the PTY WS data plane + the RSS self-recycle watchdog. Runs in EACH
 * cluster worker — and, in single-process mode, in the one process. Everything
 * here is per-process state; the background machinery (runBootstrap) is separate.
 */
function startRequestServers(): void {
  // Export the resolved port so selfUrl() builds correct server-side self-fetch
  // origins inside this host (the operator brain's agentmcp MCP URL, the <spawn>
  // dispatch). Without it selfUrl() falls back to the :3055 dev default — post-
  // Vite-migration :3055 is the frontend SPA, not this API host.
  process.env.PORT = String(port);

  // EI-79 observability: a standing event-loop-lag gauge. Silent on a healthy
  // host; logs a single structured warning when p95 loop delay over a 10s window
  // crosses 100ms — the signal that the main thread is CPU-bound. Per-process:
  // each worker has its own event loop to watch.
  // infra round-3 F1: on the production host, also capture a short CPU profile
  // when the loop saturates (≥ critical p95), so the synchronous culprit is
  // identifiable instead of re-investigated from scratch each time. Rate-limited
  // (≤1 / 5 min), best-effort, off by default elsewhere (perf suite / tests).
  // PAPERCUSP_LOOP_PROFILER=0 kills it.
  startEventLoopLagMonitor({
    profileOnSaturation: process.env.PAPERCUSP_LOOP_PROFILER !== '0',
  });

  // P5-2: closed-loop concurrency feedback. Reads the lag monitor's loopPressure()
  // (above) and, when this process's event loop is CRITICALLY saturated, makes the
  // fleet shed effective agent concurrency (AIMD multiplicative-decrease), ramping
  // back as the loop clears. Bounded under the user's cap + self-recovering.
  // Gated by LOOP_PRESSURE_GOVERNOR (default ON) — the operator's kill-switch.
  // getFlag is async (env override + PG-stored /admin/features override + default);
  // start the governor when it resolves true. Fire-and-forget — a few ms of start
  // latency at boot is harmless. Fail-OPEN to the default-on behavior if the flag
  // read fails (e.g. PG not ready yet): the governor is safe always-on (bounded
  // under the user's cap, self-recovering), so a read error must not silently
  // disable it.
  void getFlag(FLAGS.LOOP_PRESSURE_GOVERNOR, 'operator-host')
    .then((on) => {
      if (on) startLoopPressureGovernor();
    })
    .catch(() => startLoopPressureGovernor());

  const onListening = (boundPort: number): void => {
    console.log(`[hono-host] listening on http://${hostname}:${boundPort} (pid=${process.pid})`);

    // Guardrail: a stray PAPERCUSP_WORKSPACE_ID pin silently rebinds every
    // non-request path on this multi-workspace host. Warn loudly at boot — a bare
    // `# TEMPORARY` comment in .env.local was not enough to stop one surviving.
    // (Logic + rationale in lib/workspace-pin-guard.ts, unit-tested.)
    const pinWarning = workspacePinWarning();
    if (pinWarning) console.warn(pinWarning);
  };

  // P3-2 cluster-worker listen (INCIDENT 2026-06-18 fix): a cluster WORKER must bind
  // its OWN SO_REUSEPORT socket so the KERNEL load-balances accepts directly across
  // workers — INDEPENDENT of the primary. node:cluster's DEFAULT scheme round-robins
  // every accept THROUGH the primary, but the primary runs the heavy background
  // machinery (substrate/DBOS/git-sync) and can't service the accept-distribution IPC
  // when its loop is busy → workers never bind (the observed 0-listeners / ~150s hang).
  // `@hono/node-server` serve() can't forward `reusePort` (it calls listen(port,host,cb)),
  // so we build the server via createAdaptorServer and listen() ourselves with reusePort.
  // SINGLE-PROCESS / primary path is unchanged: the original serve() call, byte-identical.
  let server: ReturnType<typeof serve>;
  if (cluster.isWorker) {
    server = createAdaptorServer({ fetch: handler });
    (server as import('node:http').Server).listen({ port, host: hostname, reusePort: true }, () =>
      onListening(port),
    );
  } else {
    server = serve({ fetch: handler, port, hostname }, (info) => onListening(info.port));
  }

  // PTY WebSocket data plane (opt-in via PAPERCUSP_PTY_WS_PORT — bin/dev sets
  // 3056). The HTTP control plane (/pty/spawn|input|resize|kill) lives in this
  // host's routes, and PiPanel PREFERS ws://:<port>/pty/<id> (AttachAddon) over
  // the SSE fallback. Must run in THIS process: the pty registry the WS attaches
  // to is in-process state shared with the spawn routes — which is precisely why
  // PTY is INCOMPATIBLE with multi-worker clustering (spawn + WS could land on
  // different workers). It's desktop/dev-only (off on the server cluster target),
  // so the two never coexist. Fail-soft on EADDRINUSE (a sibling already bound it).
  const ptyWsPort = Number(process.env.PAPERCUSP_PTY_WS_PORT ?? '');
  if (Number.isFinite(ptyWsPort) && ptyWsPort > 0) {
    startPtyWsServer({ port: ptyWsPort });
  }

  // Bounded-RSS self-recycle (per-process): the host leaks retained heap under
  // fleet load (~0.2 GB/min, no plateau); past ~4 GB the GC pauses stall the event
  // loop and intermittently break MCP mounts / invokes / health (2026-06-07).
  // Recycle at a high-water mark BELOW the stall zone — drain in-flight HTTP, then
  // exit; the systemd unit's `Restart=always` (RestartSec=5s) brings up a fresh
  // low-RSS process. See lib/memory-watchdog.ts.
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

  // infra-self-healing-supervision-2026-06-19 (R4-2/R4-3/R4-4/R4-8): request-path
  // supervision. These run on a REQUEST worker — independent of the background DBOS
  // primary they watch — so they keep working when that primary freezes (the exact
  // failure that blinds the in-engine watchdog, 2026-06-19). All read-only + debounced
  // + env-killable; every failure degrades silently (best-effort, never crashes serving).
  //  • infra-liveness alarm (R4-3/R4-8): escalates to the owner when the routine engine
  //    or Queen goes dark, accounts are starved, or any health panel is critical — incl.
  //    a STALE health snapshot, which itself is the "bg tick frozen" signal.
  //  • single-primary guard (R4-2): escalates on != 1 live background primary (the silent
  //    0-primary routine death AND the >1 split-brain / appVersion-war catastrophe).
  //  • lag self-restart (R4-4 / EI-1598): recycles THIS worker when its loop stays
  //    critical for a sustained window — DEFAULT-OFF, arm with PAPERCUSP_LAG_SELF_RESTART=1
  //    once validated under load (the other reusePort workers serve through the recycle).
  startInfraLivenessAlarm();
  startSinglePrimaryGuard();
  startLagSelfRestart();
}

// P3-2 (operator-scalability-event-loop-2026-06-16): optional node:cluster. DEFAULT
// OFF → single process: startCluster runs onPrimary() then onWorker() inline, and
// runBootstrap() is idempotent (globalThis guard), so the net boot is byte-identical
// to the pre-cluster sequence (runBootstrap → request servers). When PAPERCUSP_CLUSTER
// is enabled on a server-class host, the PRIMARY runs the background machinery
// (DBOS/git-sync/substrate — which MUST be exactly one process) and forks N
// request-only WORKERS — each a PAPERCUSP_BACKGROUND_WORKERS=0 host (the battle-tested
// :3170 request-only mode) that shares the port via cluster's built-in round-robin.
// Workers carry PAPERCUSP_EXPECTED_OPERATOR_PROCS so their PG pools are sized for the
// fleet and can't multiply past max_connections (the 2026-06-17 exhaustion).
// ENABLING is owner-gated: cross-process sync-invalidate needs the pg-listen-hub on,
// and it should be validated under the Tauri shell / a staging restart first.
const clusterWorkers = resolveClusterWorkers(process.env, getResourceProfile().httpWorkers);
// PG-pool budget (R1 — infra-perf-robustness-audit-2026-06-18 conn-saturation). Every
// process sizes its org pools so `pool·procs ≤ max_connections`; the divisor is the
// count of operator processes sharing this PG. The bug it fixes: on an EMBEDDED-PG host
// `resource-profile.processCount` pins to ~1 (httpWorkers clamps to 1), so a clustered
// host sized each pool for ~1 proc → 68-conn pools across 3 cluster procs that each used
// <10 → ~89% saturation (the audit's R1). Size for the REAL cluster topology instead —
// `clusterWorkers + 1` (the N request workers + the background primary) — and honor an
// explicit operator override (the systemd drop-in, which can raise it to also account
// for the co-resident staging/aux operators on this box). `max(...)` so we never size
// for FEWER procs than actually exist (which would re-create the over-provisioning).
const expectedOperatorProcs = resolveExpectedOperatorProcs({
  clusterWorkers,
  profileProcessCount: getResourceProfile().processCount,
  explicit: process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS,
});
if (clusterWorkers > 1) {
  // Size THIS (primary) process's pools for the whole cluster; workers inherit via
  // the fork env below.
  process.env.PAPERCUSP_EXPECTED_OPERATOR_PROCS = String(expectedOperatorProcs);
}
const clusterHandle = startCluster({
  workers: clusterWorkers,
  workerEnv: {
    PAPERCUSP_BACKGROUND_WORKERS: '0',
    PAPERCUSP_EXPECTED_OPERATOR_PROCS: String(expectedOperatorProcs),
  },
  onPrimary: () => runBootstrap(), // background machinery (single process in cluster mode)
  onWorker: () => {
    // A worker is request-only: runBootstrap with background gated off (fork env),
    // then start the HTTP/loop servers. In single mode this is the same process as
    // onPrimary, so runBootstrap no-ops the second call.
    runBootstrap();
    startRequestServers();
  },
});

// Graceful drain on shutdown — PRIMARY ONLY (single/worker keep Node's default
// SIGTERM = exit, so a plain `systemctl restart` still works). The primary stops
// respawning + signals workers to exit, then exits itself so systemd restarts clean.
if (clusterHandle.role === 'primary') {
  const shutdown = (sig: 'SIGTERM' | 'SIGINT'): void => {
    console.log(`[cluster] ${sig} — draining ${clusterHandle.workerCount} worker(s) + exiting primary`);
    clusterHandle.drain?.(sig);
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
