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
// MUST be first: runs the release-integrity preflight before the heavy import graph
// (host-bootstrap → @papercusp/plugin-loader → MCP SDK → mem0 …) evaluates, so an
// inconsistent checkout fails fast + named instead of crash-looping every worker on
// MODULE_NOT_FOUND. See boot-integrity-first.ts / the 2026-06-25 incident.
import './boot-integrity-first';
import cluster from 'node:cluster';
import { serve, createAdaptorServer } from '@hono/node-server';
import { BOOT_INTEGRITY_EXIT_CODE } from '@papercusp/operator-core/lib/boot-integrity-preflight';
import { runBootstrap } from './host-bootstrap';
import { handler } from './host-handler';
import { workspacePinWarning } from '@papercusp/operator-core/lib/workspace-pin-guard';
import { startEventLoopLagMonitor } from '@papercusp/operator-core/lib/event-loop-lag-monitor';
import { startLoopPressureGovernor } from '@papercusp/operator-core/lib/loop-pressure-governor';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  startMemoryWatchdog,
  resolveMemoryWatchdogLimitMb,
} from '@papercusp/operator-core/lib/memory-watchdog';
import { gracefulHostRecycle, installGracefulShutdown } from '@papercusp/operator-core/lib/host-recycle';
import { markShuttingDown } from '@papercusp/operator-core/lib/shutdown-state';
// infra-fail-fast P-015 / D2 — canonical loopback-default bind host (locks P-027).
import { resolveBindHost } from '@papercusp/operator-core/lib/resolve-bind-host';
import { startInfraLivenessAlarm } from '@papercusp/operator-core/lib/system-health/liveness-alarm';
import { startConditionStalenessAlarm } from '@papercusp/operator-core/lib/system-health/condition-staleness-alarm';
import { startLagSelfRestart } from '@papercusp/operator-core/lib/system-health/lag-self-restart';
import {
  startWorkerHeartbeat,
  startClusterLagWatchdog,
  clusterLagWatchdogArmed,
} from '@papercusp/operator-core/lib/system-health/cluster-lag-watchdog';
import {
  startBootedHandlesBroadcaster,
  startWorkerBootedHandlesCache,
} from '@papercusp/operator-core/lib/sync/hyperbee/cluster-booted-handles-sync';
import nodeCluster from 'node:cluster';
import { startSinglePrimaryGuard } from '@papercusp/operator-core/lib/system-health/single-primary-check';
import { startPtyWsServer } from '@papercusp/operator-core/lib/pty-ws';
import { ensureInvalidationListener } from '@papercusp/operator-core/lib/sync-sse';
import {
  startCluster,
  resolveClusterWorkers,
  describeClusterWorkersSource,
  resolveExpectedOperatorProcs,
} from '@papercusp/operator-core/lib/cluster-fork';
import { getResourceProfile } from '@papercusp/operator-core/lib/resource-profile';
import { isBenignHostError } from './host-benign-errors';
import { applyServerTimeouts } from './host-request-deadline';
import { pinSubstrateSocketForCluster } from '@papercusp/operator-core/lib/sync/hyperbee/substrate-socket-path';
import { runSubstrateSidecarServer } from '@papercusp/operator-core/lib/sync/hyperbee/substrate-sidecar-server';
import { runSpawnerSidecarServer } from '@papercusp/operator-core/lib/fleet/spawner-sidecar-server';
import { runGatewaySidecarMain } from '@papercusp/operator-core/lib/inference-gateway/sidecar-main';
import { runEmbedSidecarServer } from '@papercusp/operator-core/lib/memory/embed-sidecar-server';

// ── EI-8810: sidecar re-exec divert ─────────────────────────────────────────
// The sidecar spawners (substrate / spawner / inference-gateway / embed) re-exec
// THEIR OWN bundle with a *_SIDECAR_MODE env var. On the packaged desktop that
// bundle is serve.mjs, whose main() carries this divert — but on the systemd
// bg-host deployment the bundle is THIS entry (dist-host/hono-host.mjs), which
// ignored the mode vars: the re-exec'd child booted the FULL host with the
// PARENT's inherited PAPERCUSP_HONO_PORT → EADDRINUSE → fatal exit → warm-up
// respawn — the all-day :3270 crash-loop that destabilized the substrate
// primary (2026-07-09, EI-8810). Divert BEFORE any host boot side-effect; each
// sidecar server keeps the process alive. Mirrors serve.ts main() exactly.
const sidecarMode: 'substrate' | 'spawner' | 'gateway' | 'embed' | null =
  process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MODE === '1'
    ? 'substrate'
    : process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE === '1'
      ? 'spawner'
      : process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE === '1'
        ? 'gateway'
        : process.env.PAPERCUSP_EMBED_SIDECAR_MODE === '1'
          ? 'embed'
          : null;
if (sidecarMode === 'substrate') runSubstrateSidecarServer();
if (sidecarMode === 'spawner') runSpawnerSidecarServer();
if (sidecarMode === 'gateway') {
  runGatewaySidecarMain().catch((e) => {
    console.error('[inference-gateway] fatal:', e);
    process.exit(1);
  });
}
if (sidecarMode === 'embed') runEmbedSidecarServer();

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
const hostname = resolveBindHost();

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

  // WI-1547: eagerly start the `sync_invalidate` LISTEN in THIS process. The
  // cache-ECA invalidation (change stream → cache.bumpTags) rides the SSE
  // invalidation bus's single PG LISTEN, which otherwise starts lazily on the
  // first SSE subscribe — a reuseport cluster worker that only ever serves
  // MCP/tool HTTP never subscribes, so its L1 never saw a bump and cachedRead's
  // SWR served arbitrarily stale entries (the plans:get ~45-min-stale flap: 16
  // workers on :3070, exactly ONE holding the LISTEN). Fire-and-forget; the
  // helper retries with backoff and is loud on exhaustion.
  void ensureInvalidationListener();

  // EI-79 observability: a standing event-loop-lag gauge. Silent on a healthy
  // host; logs a single structured warning when p95 loop delay over a 10s window
  // crosses 100ms — the signal that the main thread is CPU-bound. Per-process:
  // each worker has its own event loop to watch.
  // infra round-3 F1: on the production host, also capture a short CPU profile
  // when the loop saturates (≥ critical p95), so the synchronous culprit is
  // identifiable instead of re-investigated from scratch each time. Rate-limited
  // (≤1 / 5 min), best-effort — EXCEPT under genuinely extreme, sustained lag
  // (WI-3797, 2026-07-10): captureCpuProfile()'s node:inspector Profiler
  // session relies on its own async post()/response completing over the SAME
  // event loop it's diagnosing, and this host's crash logs show 8x
  // `terminate called after throwing an instance of 'Napi::Error'` (native
  // abort — NOT a catchable JS exception, so the try/catch in
  // captureCpuProfile() cannot save it) landing immediately after
  // `[event-loop-lag]` p95 readings in the seconds range, correlated across
  // many cluster-worker PIDs during the same host-wide overload window. The
  // module's own header already documents this exact posture ("DELIBERATELY
  // DEFAULT-OFF... opt-in until validated under load") — this caller inverted
  // that default to on-by-default, and it has now failed that validation by
  // crash-looping the whole green-release operator. Reverting to the
  // module's own documented default (explicit opt-in only) until the
  // inspector-session crash itself is hardened. PAPERCUSP_LOOP_PROFILER=1 to
  // re-enable explicitly (e.g. for a controlled, low-load debugging session).
  startEventLoopLagMonitor({
    profileOnSaturation: process.env.PAPERCUSP_LOOP_PROFILER === '1' || process.env.PAPERCUSP_LOOP_PROFILER === 'true',
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

  // B2 (infra-fail-fast-build-integrity P-006) — the "safe half": explicit inbound
  // Node server timeouts. OPT-IN (PAPERCUSP_HTTP_REQUEST_TIMEOUT_MS /
  // PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS); unset → Node defaults unchanged. Marginal on
  // Node 25 (they bound request RECEIPT, not handler runtime — the handler-deadline
  // middleware in host-handler.ts covers the wedge), but the knobs let ops tune the
  // slow-loris / stuck-body ceiling without a code change.
  const appliedTimeouts = applyServerTimeouts(server as unknown as import('node:http').Server);
  if (
    appliedTimeouts.requestTimeout !== undefined ||
    appliedTimeouts.headersTimeout !== undefined ||
    appliedTimeouts.keepAliveTimeout !== undefined
  ) {
    console.log('[hono-host] applied inbound server timeouts (ms):', appliedTimeouts);
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
    // Role-aware default (EI-1613): the dedicated BACKGROUND primary (the
    // bg-host, BG=1) boots the substrate + DBOS recovery and needs a far higher
    // limit (12288) than a request-only worker (3200). The old flat `|| 3200`
    // default trips the bg-host within minutes → recycle loop / (pre-fix) stay
    // dead → routine-engine freeze. Resolved in code so a FRESH box is correct
    // without a box-local systemd drop-in; an explicit env still wins.
    const limitMb = resolveMemoryWatchdogLimitMb(process.env);
    // Proactive GC (the ROOT bg-host-freeze fix): force a full GC in the safe band
    // (default 60% of the recycle limit) so the heap never reaches the multi-GB
    // old-gen regime where a V8 mark-compact pause freezes the single event loop —
    // the "bg-host ticker frozen ~27 min" incident that reclaim-massacred queen/bee
    // spawns (EI-2186). `--max-old-space-size=131072` (box-wide) defeats V8's own
    // heap-paced GC, so this proactive sweep is what keeps the ticker alive. The
    // watchdog runtime-enables `--expose-gc` if NODE_OPTIONS lacks it (fresh-box
    // correct). Kill-switch: PAPERCUSP_MEMORY_PROACTIVE_GC=0. An explicit
    // PAPERCUSP_MEMORY_PROACTIVE_GC_MB overrides the threshold.
    const proactiveGcOff = process.env.PAPERCUSP_MEMORY_PROACTIVE_GC === '0';
    const proactiveGcMbEnv = Number(process.env.PAPERCUSP_MEMORY_PROACTIVE_GC_MB);
    startMemoryWatchdog({
      rssLimitMb: limitMb,
      proactiveGcMb: proactiveGcOff
        ? 0
        : Number.isFinite(proactiveGcMbEnv) && proactiveGcMbEnv > 0
          ? proactiveGcMbEnv
          : undefined,
      onTrip: ({ rssMb }) => {
        // INVOCATION_ID = running under systemd (Restart=always). The tauri-dev
        // OWN-PORT operator is instead supervised by dev-operator-ifneeded.sh's
        // restart loop (WI-3042) — name the actual supervisor so a recycle in
        // either context reads correctly in the log.
        const supervisor = process.env.INVOCATION_ID
          ? 'systemd will restart'
          : 'expecting the spawning wrapper (dev-operator-ifneeded.sh restart loop) to restart';
        console.warn(
          `[memory-watchdog] RSS high-water mark tripped — draining + recycling host (${supervisor})`,
          { rssMb, rssLimitMb: limitMb },
        );
        // Drain in-flight HTTP before exit; the helper hard-exits after 8s if
        // the drain hangs. EI-9649: SKIP the P2P substrate teardown on a memory
        // recycle. A bare process.exit() abandoning those handles is the EI-127
        // resource-leak this drain exists to prevent — BUT a memory recycle
        // trips because RSS is over the cap, i.e. the substrate is large, and
        // tearing that much native Hypercore/Hyperswarm state down concurrently
        // throws an uncaught Napi::Error → SIGABRT below the JS layer (same
        // binding root cause as WI-3795/WI-3848/WI-3849). Unlike the SIGTERM +
        // lag-recycle paths, a memory recycle can fire while the loop is NOT
        // elevated, so gracefulHostRecycle's isSaturated skip does not catch it
        // and the crash turns a routine recycle into a hard SIGABRT + webview
        // reconnect flash. The process is fully exiting, so the OS reclaims the
        // sockets/fds/LISTEN backends anyway — skipping only defers the same
        // peer-timeout socket-linger the saturated path already accepts.
        gracefulHostRecycle({
          server: server as { close?: (cb?: () => void) => void },
          skipSubstrateTeardown: true,
        });
      },
    });
  }

  // D4 (infra-fail-fast-build-integrity P-017): graceful HTTP connection-drain on
  // SIGTERM/SIGINT for the HTTP-SERVING process — the single-process host AND each
  // cluster worker. Node's default SIGTERM is an immediate exit that severs in-flight
  // requests, so a deploy / `systemctl restart` 502s anything mid-flight. Reuse the
  // memory-watchdog's bounded-drain idiom (stop accepting → drain in-flight HTTP →
  // tear down substrate → exit, 8s hard-exit backstop) but exit 0 (an intentional
  // stop, not the non-zero recycle code). The true-cluster PRIMARY serves no HTTP and
  // keeps its own worker-draining handler (gated to cluster mode below). Kill-switch:
  // PAPERCUSP_SIGTERM_DRAIN=0 restores Node's default immediate exit.
  if (process.env.PAPERCUSP_SIGTERM_DRAIN !== '0') {
    installGracefulShutdown({ server: server as { close?: (cb?: () => void) => void } });
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
  //  • condition-staleness alarm (WI-2965): the periodic ACTOR for coord:conditions —
  //    a condition-keyed severe-event that stays OPEN past a threshold gets ONE reminder
  //    escalation, durably deduped/auto-resolved (mirrors the liveness alarm's EI-2146
  //    dedup shape). Closes the coord-conditions signal-actor-registry waiver.
  startInfraLivenessAlarm();
  startConditionStalenessAlarm();
  startSinglePrimaryGuard();
  // P-002 (mcp-reliability-hardening-2026-07-11): recycle GRACEFULLY. The seam's
  // default is a bare process.exit(75), which severs every in-flight request on
  // this worker — measured 2026-07-10/11: 303 lag-recycles/24h, and 41.3% of all
  // agent-visible mcp-proxy 502s (read ECONNRESET / socket hang up) landed within
  // ±5s of one (vs 7.5% chance coverage). Route the exit through the SAME bounded
  // drain the memory-watchdog and SIGTERM paths use: markShuttingDown (stop
  // STARTING background work) → stop accepting → drain in-flight HTTP → exit 75
  // (8s hard backstop). gracefulHostRecycle's saturated-skip already avoids the
  // WI-3795 native substrate-teardown crash — which a lag-recycle would otherwise
  // ALWAYS risk, since its loop is 'critical' by definition at recycle time.
  startLagSelfRestart({
    // P-003: desynchronize sibling workers' recycles — pressure is box-correlated,
    // so without jitter many workers trip the identical sustain window in the same
    // beat (7 recycles in ~4 min observed 2026-07-10). +0..4 extra 15s checks.
    jitterChecks: 4,
    exit: (code) => {
      markShuttingDown();
      gracefulHostRecycle({
        server: server as { close?: (cb?: () => void) => void },
        recycleExitCode: code,
      });
    },
  });
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
// EI-8817/EI-8818: name the exact env var + value that drove this so a wrong
// resolution (e.g. an unintended multi-worker fork storm) is one-glance diagnosable
// from the boot log instead of ~30min of forensics re-deriving CLUSTER_WORKERS'
// precedence over CLUSTER by hand.
console.log(`[cluster] resolved ${clusterWorkers} worker(s) (source: ${describeClusterWorkersSource(process.env)})`);
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
// WI-1879: pin the substrate sidecar's IPC socket path BEFORE forking — see
// pinSubstrateSocketForCluster's doc for the full race (the substrate boots
// asynchronously deep inside onPrimary's runBootstrap(), well after cluster.fork()
// has already forked every worker off the pre-substrate-boot env, so each worker used
// to fall back to its OWN pid-keyed — nonexistent — socket path and the
// dogfood-substrate-boot-history route always degraded to `source:'main-fallback'`
// with an empty ring on every clustered host; found during P-059 / WI-1837).
const substrateSocketWorkerEnv = sidecarMode ? {} : pinSubstrateSocketForCluster(clusterWorkers);
// EI-8810: in sidecar mode the divert above already started the sidecar server
// (which keeps the process alive) — the host boot below must not run at all.
const clusterHandle = sidecarMode ? null : startCluster({
  workers: clusterWorkers,
  workerEnv: {
    PAPERCUSP_BACKGROUND_WORKERS: '0',
    PAPERCUSP_EXPECTED_OPERATOR_PROCS: String(expectedOperatorProcs),
    ...substrateSocketWorkerEnv,
  },
  onPrimary: () => runBootstrap(), // background machinery (single process in cluster mode)
  onWorker: () => {
    // A worker is request-only: runBootstrap with background gated off (fork env),
    // then start the HTTP/loop servers. In single mode this is the same process as
    // onPrimary, so runBootstrap no-ops the second call.
    runBootstrap();
    startRequestServers();
    // Heartbeat the primary so the cluster-lag-watchdog can detect a SYNCHRONOUS wedge
    // (which freezes the worker-side lag-self-restart too) by heartbeat ABSENCE
    // (EI-1598/1608). DEFAULT-OFF; only meaningful in a forked worker (process.send).
    if (clusterWorkers > 1 && clusterLagWatchdogArmed()) startWorkerHeartbeat();
    // EI-8816: cache the primary's periodic booted-handles broadcast so this
    // request-only worker's substrate-status reads aren't a silent blind spot
    // (the substrate boots only on the primary; this worker's own listBootedHandles()
    // map is always empty). ALWAYS-ON when true-clustered — a correctness fix, not an
    // opt-in perf feature (unlike the lag watchdog above).
    if (clusterWorkers > 1) startWorkerBootedHandlesCache();
  },
  // Boot-failure backstop (2026-06-25 incident): if a whole generation of workers
  // exits within the boot grace window and NONE ever stays up — an UNBOOTABLE build
  // (MODULE_NOT_FOUND / a boot-time throw the preflight manifest didn't enumerate) —
  // halt the respawn storm and exit the primary with the integrity code. A clean,
  // fast, distinct failure lets systemd/deploy-cli surface it and roll back to the
  // last-good build, instead of flapping every worker for ~35 min (the all-pages
  // outage). A worker that crashes AFTER serving still respawns normally.
  onUnbootable: ({ consecutiveBootFailures, lastCode, lastSignal }) => {
    console.error(
      `[hono-host] cluster UNBOOTABLE: ${consecutiveBootFailures} worker(s) failed to boot and none ` +
        `stayed up (last exit code=${lastCode} signal=${lastSignal}). Exiting the primary (${BOOT_INTEGRITY_EXIT_CODE}) ` +
        `so the supervisor/deploy rolls back to the last-good build rather than crash-looping. See the ` +
        `[boot-integrity] line above for the likely missing module(s); run \`npm ci\` in this checkout if persistent.`,
    );
    process.exit(BOOT_INTEGRITY_EXIT_CODE);
  },
});

// Graceful drain on shutdown.
//  • The HTTP-serving processes — the single-process host AND each cluster WORKER —
//    drain in-flight HTTP on SIGTERM inside startRequestServers (D4/P-017), exiting 0.
//  • The TRUE-CLUSTER PRIMARY serves no HTTP; it stops respawning + signals workers to
//    drain, then exits so systemd restarts clean. Single-process is ALSO role 'primary'
//    but serves HTTP, so it must NOT take this 2s-exit path (it would preempt the HTTP
//    drain) — hence the `clusterWorkers > 1` guard.
if (clusterHandle && clusterHandle.role === 'primary' && clusterWorkers > 1) {
  // Cluster-lag watchdog (EI-1598/1608): the primary SIGKILLs a worker that stops
  // heart-beating (a synchronous wedge the worker-side lag-self-restart can't catch);
  // the startCluster exit handler then respawns it (respawn-budget-aware). DEFAULT-OFF
  // — arm with PAPERCUSP_CLUSTER_LAG_WATCHDOG=1 once validated under load.
  const watchdog =
    clusterLagWatchdogArmed() && clusterHandle.workerById
      ? startClusterLagWatchdog({
          cluster: nodeCluster as unknown as Parameters<typeof startClusterLagWatchdog>[0]['cluster'],
          workerById: clusterHandle.workerById,
        })
      : undefined;
  // EI-8816: broadcast this primary's booted-handles snapshot to every worker so their
  // substrate-status reads aren't a silent blind spot. ALWAYS-ON (not gated behind an
  // arm flag like the lag watchdog above) — this closes a correctness bug, not an
  // opt-in perf feature.
  const bootedHandlesBroadcaster = clusterHandle.broadcast
    ? startBootedHandlesBroadcaster({ broadcast: clusterHandle.broadcast })
    : undefined;
  const shutdown = (sig: 'SIGTERM' | 'SIGINT'): void => {
    // P-005: the true-cluster PRIMARY is the process that runs the auto-implement
    // dispatch loop (it owns the background machinery). It serves no HTTP, so it
    // does NOT go through installGracefulShutdown — mark the drain here too, so the
    // loop stops claiming new minutes-long workers as this primary exits.
    markShuttingDown();
    console.log(`[cluster] ${sig} — draining ${clusterHandle.workerCount} worker(s) + exiting primary`);
    watchdog?.stop(); // stop watching first so it doesn't fight the graceful drain
    bootedHandlesBroadcaster?.stop();
    clusterHandle.drain?.(sig);
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
