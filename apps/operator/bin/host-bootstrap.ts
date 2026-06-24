/**
 * Side effects that the API entrypoint needs to run *once* per process:
 * plugin-route population, background watchers, sweepers, voice WS,
 * mobile push refreshers, the auto-loop ticker, the expirable registry.
 *
 * Split out from `app.ts` so that:
 *   - importing the Hono app for tests / operator-vite / IPC bridge is free
 *     of background-process side effects;
 *   - the route shim (`[[...route]]/route.ts`) and any future Hono host
 *     (`@hono/node-server` for operator-vite Phase C) call `runBootstrap()`
 *     explicitly, in the same order, on first request.
 *
 * `runBootstrap()` is idempotent — second and subsequent calls no-op via the
 * globalThis guard. Each underlying `start*()` / `ensure*()` is itself
 * idempotent (per their existing comments about Next dev module re-eval),
 * so even an accidental double-call from a different bootstrap path is safe.
 */
import { mountPluginApiRoutes } from '@papercusp/operator-core/lib/plugin-api-mount';
import { ensureHarnessFsWatcher } from '@papercusp/operator-core/lib/harness-fs-watcher';
import { ensureHarnessStatusSweep } from '@papercusp/operator-core/lib/harness-status-sweep';
// ensureWaveAdvanceSweep — RETIRED (P-044): the 30s wave-advance poll is no longer
// started; all-waves-up-front promotion + the dispatch frontier replace it.
import { registerAllExpirables } from '@papercusp/operator-core/lib/expirable-registrations';
import { backgroundWorkersEnabled, utilityHostEnabled } from '@papercusp/operator-core/lib/background-workers';
import { startClaudeCredentialSync } from '@papercusp/operator-core/lib/claude-credential-sync';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { startMobileVoiceWs } from '@papercusp/operator-core/lib/device-voice-ws';
import { startDesktopVoiceWs } from '@papercusp/operator-core/lib/voice-node/desktop-voice-ws';
import { startPushCredentialRefresher } from '@papercusp/operator-core/lib/device-push-credentials';
import { registerHostPlatform } from '@papercusp/host-platform';
import { desktopHostPlatform } from '@papercusp/host-platform/desktop';
import { runBootAddonPreflight } from '@papercusp/operator-core/lib/native-addon-preflight';
import { validateHomeHarnessResolution, homeHarnessValidationFatal } from '@papercusp/operator-core/lib/startup/validate-home-harness';

const GUARD_KEY = '__papercuspBootstrapRan__';

type GuardedGlobal = typeof globalThis & { [GUARD_KEY]?: boolean };

export function runBootstrap(): void {
  const g = globalThis as GuardedGlobal;
  if (g[GUARD_KEY]) return;
  g[GUARD_KEY] = true;

  // [A2 infra-fail-fast-build-integrity-2026-06-19] Boot native-addon self-check.
  // Test-loads the required native addons (better-sqlite3 / mem0's store) under
  // the runtime Node and logs LOUDLY if one won't load — turning the 2026-06-19
  // outage (ABI-mismatched addon → mem0 load fail → every memory handler hangs
  // behind a green health check) into a visible boot error. SAFE by default: it
  // never exits unless PAPERCUSP_ADDON_PREFLIGHT_FATAL=1 (flag-gated until
  // validated, so it can't crashloop a healthy / memory-disabled host).
  // try/catch so the check itself can never wedge boot.
  try {
    runBootAddonPreflight();
  } catch (e) {
    console.warn('[addon-preflight] boot self-check errored (non-fatal):', (e as Error)?.message ?? e);
  }

  // [EI-2224 startup validation] Home-harness slug resolution check. Fail-fast:
  // if the configured home harness slug doesn't resolve to a registered project,
  // fire-paths (dispatcher, overwatch, routines) will 404 silently and go dark.
  // This has happened twice (config drift + host restart). The validation
  // throws with a clear error if home harness is unregistered — loud failure
  // instead of silent 404 dispatcher dark.
  void (async () => {
    try {
      await validateHomeHarnessResolution();
      console.log('[home-harness] startup validation passed — home harness slug resolves');
    } catch (e) {
      console.error('[home-harness] STARTUP VALIDATION FAILED:', (e as Error)?.message ?? e);
      // [shared-hive-public-release-2026-06-22 BUG-1] Do NOT crash the operator by
      // default. A fresh PACKAGED desktop install legitimately has no registered
      // home-harness project yet (the baked default slug 'papercusp' doesn't resolve
      // in the 'default' workspace until setup), and re-throwing here is an UNHANDLED
      // promise rejection → Node process exit → embedded-PG down → the app is dead on
      // first launch for every new user (caught by the 2-machine release rig). Mirror
      // the sibling addon-preflight policy above: log LOUDLY (preserves the EI-2224
      // "don't go dark silently" intent) and only hard-fail when explicitly opted in
      // — the dev/server operator (and CI/green-gate) can set
      // PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL=1 to restore fail-fast.
      if (homeHarnessValidationFatal()) throw e;
    }
  })();

  // [ship-papercusp-as-single-hive 2026-06-23, owner-directed] On a PACKAGED desktop
  // install, ensure the `papercusp` dogfood hive exists — clone the repo on first
  // boot (too large to bundle, ~5GB) and home on it — so the app ships with
  // `papercusp` as its single hive instead of an empty/unresolved home (this is what
  // makes the home-harness validation ABOVE resolve on a fresh packaged install,
  // BUG-1). Desktop-only (never hijacks a dev/server operator's workspace),
  // flag-gated, fire-and-forget + non-fatal: a missing `gh` auth / no network / an
  // already-present hive all no-op cleanly and the NEXT boot retries.
  if (process.env.PAPERCUSP_DESKTOP === '1') {
    void (async () => {
      try {
        if (!(await getFlag(FLAGS.DOGFOOD_PAPERCUSP_HIVE, 'system'))) return;
        const { bootstrapPapercuspHive } = await import(
          '@papercusp/operator-core/lib/harness/bootstrap-papercusp-hive'
        );
        const res = await bootstrapPapercuspHive();
        if (res.state !== 'skipped') {
          console.log(
            `[papercusp-hive] ${res.state}: ${res.slug ?? '(none)'}${res.path ? ` @ ${res.path}` : ''}`,
          );
        } else if (res.reason) {
          console.log(`[papercusp-hive] not created this boot: ${res.reason}`);
        }
      } catch (e) {
        console.warn('[papercusp-hive] bootstrap failed (non-fatal):', (e as Error)?.message ?? e);
      }
    })();
  }

  // [power] P5-3 of operator-scalability-event-loop-2026-06-16 — detect the power
  // source ONCE and fold onBattery into the resource profile BEFORE the background
  // machinery reads it. Fire-and-forget + first thing at boot so it (a few fast fs
  // reads) almost always wins the race against the first getResourceProfile()
  // consumer; if it loses, or on a server we can't read, the profile defaults to
  // AC = full power — battery state never wrongly throttles a plugged-in host.
  void (async () => {
    try {
      const { primePowerSource } = await import('@papercusp/operator-core/lib/resource-profile');
      const source = await primePowerSource();
      if (source !== 'unknown') {
        console.log(`[power] source=${source} — P5-3 cadence/concurrency adjusted accordingly`);
      }
    } catch {
      /* non-fatal — defaults to AC / full power */
    }
  })();

  // [pg-budget] C0-4 of backend-connection-scaling-2026-06-17 — log this
  // process's worst-case PG connection ceiling vs the live max_connections, so a
  // future pool-sizing change can't silently re-create the 2026-06-17 connection
  // exhaustion. Fire-and-forget on EVERY host (the request-only :3170 was a top
  // holder); resilient if PG isn't ready yet.
  void (async () => {
    try {
      const { logConnectionBudget } = await import('@papercusp/db-org');
      await logConnectionBudget((m) => console.log(m));
    } catch {
      /* non-fatal diagnostic */
    }
  })();

  // HostPlatform registration — every getHostPlatform() consumer (agent:role,
  // operator:scanner prompt resolvers, …) throws without it. This call lived
  // ONLY in the retired instrumentation-node.ts (same story as the IPC server
  // start below) and was dropped, not ported, when that file was deleted
  // (5694e7d58) — prompts/get on every host threw from then on. The operator
  // is always either Tauri-hosted or a local-dev Node process — both are
  // "desktop" for HostPlatform purposes. A future server host would register
  // `serverHostPlatform` from its own entry point. try/catch: tests that
  // registered a mock before calling runBootstrap() must not crash the boot.
  try {
    registerHostPlatform(desktopHostPlatform);
  } catch (err) {
    console.warn('[host-platform] register failed (non-fatal):', err);
  }

  // Endpoint-IPC server — the webview→Tauri→Node fast path. The packaged
  // desktop spawns this sidecar with PAPERCUSP_IPC_ENABLE=1 and watches stdout
  // for the `PAPERCUSP_IPC_READY socket=<path>` handshake line within a 30s
  // window; the Rust client then connects and the operator SPA's /api fetch +
  // EventSource ride IPC. Under the papercusp:// origin (Phase 4, default-on)
  // this is load-bearing for STREAMING: if IPC never comes up, /api falls back
  // to the buffering custom_protocol handler and SSE stops streaming.
  //
  // This start used to live ONLY in the now-retired instrumentation-node.ts
  // (a Next hook the Hono host never runs), so packaged builds printed no
  // ready line → 30s timeout → IPC disabled → SSE buffered. Ported here, the
  // live boot path (mirrors the DBOS block below). Started first + fire-and-
  // forget so the handshake never waits on PG/migrations. Idempotent via the
  // runBootstrap guard above.
  //
  // Enablement: the packaged desktop sets PAPERCUSP_IPC_ENABLE=1 when it
  // spawns the sidecar. The DEV desktop (`npm run dev`) does NOT spawn the
  // packaged sidecar (it points the webview at an externally-run operator),
  // so it can't set that env — yet the webview still needs IPC to escape
  // libsoup's 6-socket-per-origin pool, or its on-demand /api fetches starve
  // behind the long-lived SSE streams and hang ("loading… forever"). So
  // default IPC ON in dev (NODE_ENV !== 'production'); opt out with
  // PAPERCUSP_IPC_ENABLE=0. The retired standalone webapp is the only other
  // dev consumer and an unused unix socket there is harmless.
  const ipcEnabled =
    process.env.PAPERCUSP_IPC_ENABLE === '1' ||
    (process.env.PAPERCUSP_IPC_ENABLE !== '0' && process.env.NODE_ENV !== 'production');
  if (ipcEnabled) {
    void (async () => {
      try {
        const [
          { startEndpointIpcServer },
          { PROJECTED_DEPS },
          { listAllProjectedTools },
          { writeEndpointIpcDiscovery },
        ] = await Promise.all([
          import('@papercusp/operator-core/lib/endpoint-ipc/server'),
          import('@papercusp/operator-core/lib/projected-tool-deps'),
          import('@papercusp/tooldef'),
          import('@papercusp/operator-core/lib/endpoint-ipc-discovery'),
        ]);
        // Populate the projection registry (defineTool side-effects) before
        // reading expose.ipc off it.
        await import('@papercusp/operator-core/lib/agent-tools');
        // Registry-driven IPC allowlist: a tool is IPC-eligible iff it declares
        // `expose: { ipc: true }` (must be self-contained — every safety check
        // + persistence side-effect in the tool, not the route). `sys:http` —
        // the privileged HTTP-over-IPC bridge, not a defineTool projection — is
        // added explicitly. (oracle:chat + agent_chats:chat are intentionally
        // NOT eligible — route-dependent; see their tool files.)
        const ipcEligible = listAllProjectedTools()
          .filter((t) => t.expose?.ipc === true)
          .map((t) => t.expose.mcp?.name)
          .filter((n): n is string => typeof n === 'string');
        const allowedTools = [...new Set([...ipcEligible, 'sys:http'])];
        const server = await startEndpointIpcServer({
          socketPath: process.env.PAPERCUSP_IPC_SOCKET || undefined,
          deps: PROJECTED_DEPS,
          allowedTools,
        });
        // Publish the resolved socket so the DEV desktop — which didn't spawn
        // us and so can't read our stdout PAPERCUSP_IPC_READY handshake — can
        // discover + connect. Harmless in the packaged build (that path uses
        // the stdout line); one code path beats gating the write.
        await writeEndpointIpcDiscovery(server.socketPath);
      } catch (err) {
        console.error('[endpoint-ipc] failed to start:', err);
      }
    })();
  }

  // Prewarm the OMP-SU bootstrap (file copies + `omp config set` shell-
  // outs). Runs once per process, fire-and-forget. Without this the
  // first /adv launch pays 5+ seconds of bootstrap synchronously on
  // the response path; with it, the work happens during startup and
  // the first user click is fast like every subsequent click.
  import('@papercusp/operator-core/lib/ensure-omp-su')
    .then(({ ensureOmpSuInstalled }) =>
      ensureOmpSuInstalled().catch((e) =>
        console.warn('[ensure-omp-su] prewarm failed (non-fatal):', e),
      ),
    )
    .catch((e) => console.warn('[ensure-omp-su] import failed (non-fatal):', e));

  // Plugin apiRoutes — populate the in-memory registry from disk. The
  // `/plugins/*` defineTool catch-all (routes/plugins/catchall.ts)
  // consults this registry per request via `dispatchPluginApiRoute`,
  // so hot-reload + post-boot symlinks work without the
  // Hono-route-snapshot footgun.
  //
  // KNOWN LIMITATION: Next.js's runtime cannot dynamic-import `.ts` plugin
  // files (works under tsx but not Next's bundler). Plugins must ship a
  // pre-compiled `.js` entry point to be reachable in-process.
  mountPluginApiRoutes()
    .then((r) => {
      console.log(`[plugin-mount] mounted=${r.mounted} skipped=${r.skipped} errors=${r.errors.length}`);
      for (const e of r.errors) {
        console.warn(`[plugin-mount] error: ${e}`);
      }
    })
    .catch((e) => {
      console.warn('[plugin-mount] unexpected rejection:', e);
    });

  // Eagerly warm the plugin host so plugin-contributed tools (repomix.pack,
  // gitnexus.*, design-phase.*) are in the projected-tool registry from boot.
  // Registration is otherwise lazy — it runs inside getPluginHost() on the
  // first plugin-dependent request — and this host restarts on every deploy,
  // so the fleet's first post-deploy plugin tool call landed in the
  // empty-registry window and failed `unknown_tool` (that window is how
  // gitnexus got misdiagnosed as down — plugin-system-hive-port-2026-06-11
  // P-012). Fire-and-forget: discovery errors stay visible via
  // plugins:runtime_status, and a failure here must not block boot.
  import('@papercusp/operator-core/lib/plugin-host-runtime')
    .then(({ getPluginHost }) => getPluginHost())
    .then((s) => {
      console.log(`[plugin-host] warmed at boot: loaded=${s.loaded.length} errors=${s.loadErrors.length}`);
    })
    .catch((e) => console.warn('[plugin-host] boot warm failed (non-fatal):', e));

  // The legacy in-process AutoLoop ticker is RETIRED (autoloop-pot-operator-
  // rebuild P-010 / D-009) — scheduled decider fires ride the durable routines
  // engine (blueprint triggers.schedule → system:blueprint-run).
  // EI-368: the whole voice cluster is skipped on a headless utility host (the
  // gym-operator) — no human ever talks to it, the legs port-scan, and they
  // pull in the holepunch native stack (part of the Napi-abort suspect set).
  const utilityHost = utilityHostEnabled();
  if (utilityHost) {
    console.log('[host] PAPERCUSP_UTILITY_HOST=1 — headless utility host: skipping voice cluster, hyperbee substrate, and embedder warm-up (EI-368)');
  } else {
    startMobileVoiceWs();
  }
  startPushCredentialRefresher();
  // data-sync-push-completion P-005/D-012: the DEBOUNCED append-heavy change-detector. ONE
  // host poll per append-heavy log table → a synthesized `<table>.changed` invalidation when
  // max(id) advances, so userActions.* / auditLog.* / toastLog.* consumers push-update WITHOUT
  // the per-row notify-storm the trigger exclusion (mig 376) avoids. It fires pg_notify, so it
  // serves clients on EVERY operator (incl. :3170, which runs no background workers) — hence NOT
  // gated on backgroundWorkersEnabled (resilient: no bg-host single point of failure). A 2nd host
  // also running it is harmless — the per-call short dedupe + react-query refetch-coalescing fold
  // the duplicate fires. Started UNCONDITIONALLY with the flag checked PER-TICK at runtime, not
  // here — getFlag is fragile at host-boot (see the INFERENCE_GATEWAY note below), so a boot-gate
  // risks "silently never started"; the per-tick check is the clean kill-switch.
  void (async () => {
    try {
      const { startAppendHeavyInvalidatorHost } = await import(
        '@papercusp/operator-core/lib/sync-resolver/append-heavy-invalidator'
      );
      startAppendHeavyInvalidatorHost({
        isEnabled: () => getFlag(FLAGS.APPEND_HEAVY_LIVE_INVALIDATION, 'operator-host'),
        log: (m) => console.log(m),
      });
      console.log('[append-heavy-invalidator] started — debounced live-invalidation for append-heavy logs');
    } catch (err) {
      console.error('[append-heavy-invalidator] failed to start:', err);
    }
  })();
  if (!utilityHost) {
    // P2P voice channels: the local binary audio socket (holepunch-voice-channels
    // P-006/D-010). Cheap to start; the voice swarm itself is lazy (first join).
    void (async () => {
      try {
        const { startLocalVoiceSocket } = await import('@papercusp/operator-core/lib/voice-node/local-audio-socket');
        const { socketPath } = startLocalVoiceSocket();
        console.log(`[voice-node] local audio socket at ${socketPath}`);
        // The ONE shared EL/operator voice session (universal-voice-interface-2026-06-05):
        // hosted here and attached to the same socket bus, so desktop + tui both stream
        // into one session and both receive the input + response (Model A).
        const { startOperatorVoiceHost } = await import('@papercusp/operator-core/lib/voice-node/operator-voice-host');
        startOperatorVoiceHost();
      } catch (err) {
        console.error('[voice-node] failed to start local audio socket / operator voice host:', err);
      }
    })();
    // Desktop voice surface (P-015): bridge the local audio socket over a loopback
    // WS so the Tauri webview's getUserMedia path can reach the same voice-node.
    startDesktopVoiceWs();
    // Voice relay (P-013/D-009): when PG `voice_relay.serve` opts this operator
    // in as the fleet's reachable peer, run the blind-relay server firewalled
    // peers fall back through. No-op (null) everywhere else.
    void (async () => {
      try {
        const { maybeStartVoiceRelayServer } = await import('@papercusp/operator-core/lib/voice-node/voice-relay');
        await maybeStartVoiceRelayServer();
      } catch (err) {
        console.error('[voice-relay] bootstrap check failed:', err);
      }
    })();
  }
  // hive-frame-desktops-live-view P-012: on a desktop-enabled FRAME (the
  // bootstrap advertised a display pool), publish each ACTIVE display as a
  // screen track on the harness's video channel. Viewer-driven — a track
  // encodes only while the channel has an audience. No-op everywhere else.
  if (process.env.PAPERCUSP_DESKTOP_DISPLAYS && process.env.PAPERCUSP_DESKTOP_SCREEN_TRACKS !== '0') {
    void (async () => {
      try {
        const slug = (process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES ?? '').split(',')[0]?.trim();
        if (!slug || slug === '*') return; // a Queen/control node hosts no displays
        const { startFrameScreenPublisher } = await import(
          '@papercusp/operator-core/lib/voice-node/screen-track/screen-publisher'
        );
        startFrameScreenPublisher({ harnessSlug: slug });
        console.log(`[screen-track] frame screen publisher up for '${slug}' (tracks follow the display-lease pool)`);
      } catch (err) {
        console.error('[screen-track] failed to start the frame screen publisher:', err);
      }
    })();
  }
  // device-intervention-watcher (60s poll) retired (P-021) — escalation /
  // smoke-fail now push at the source via notifyAttention from their
  // /api/internal/*-event producers; needs-human≥high from set-status.
  // (plan-review push retired with the harness_plan_review source — B-14/P-101.)

  // Harness FS watcher — mirrors .papercusp/{summary.md,pending-reviews,proposals}
  // to PG so panels can read via Zero push instead of polling. Idempotent;
  // pinned to globalThis to survive Next dev module re-evaluation.
  try {
    ensureHarnessFsWatcher();
  } catch (e) {
    console.warn('[api] harness-fs-watcher failed to start:', (e as Error)?.message ?? e);
  }

  // Phase 3: harness_status / harness_lanes sweeper. PID-liveness based —
  // clears stale `agent_runs.running` and `harness_lanes` rows whose
  // recorded PID is gone. (TTL-based sweeps for status/scan-locks/claims/
  // auth live in the expirable registry below.) Idempotent.
  try {
    ensureHarnessStatusSweep();
  } catch (e) {
    console.warn('[api] harness-status-sweep failed to start:', (e as Error)?.message ?? e);
  }

  // Wave-advance sweep — RETIRED (dbos-system-completion P-044 / Path A). Under
  // all-waves-up-front promotion (`plans:promote { all_waves: true }`), every
  // wave is promoted at once with cross-wave ordering written as feature
  // `blocked_by` edges, so the P-042 dispatch frontier sequences the waves and
  // the next-wave-on-drain promotion this 30s poll did is redundant. The
  // newly-filed-work backstop is the orchestrator tick (`runOrchestratorTick`),
  // and the stuck-wave signal is now raised by the frontier (computeFrontier's
  // `stuck` → an I-STUCK issue in dispatchOneHarness). The sweep module is kept
  // (not deleted) for the revert; it is simply no longer started.
  //   try { ensureWaveAdvanceSweep(); } catch { … }   // ← retired

  // Claude OAuth credential sync — keeps the claudeAiOauth bundle converged
  // across ~/.claude and every per-session CLAUDE_CONFIG_DIR fork so rotating
  // refresh tokens never mutually invalidate (the every-terminal-relogin
  // cascade, claude-credential-sync-2026-06-10). Flag is consulted per pass.
  try {
    startClaudeCredentialSync({
      isEnabled: () => getFlag(FLAGS.CLAUDE_CRED_SYNC, 'operator-host'),
    });
  } catch (e) {
    console.warn('[claude-cred-sync] failed to start:', (e as Error)?.message ?? e);
  }

  // TTL-based row expiry. Replaces ad-hoc lazy-deletes scattered across
  // operator-scan-lock, operator-claims, harness_status stalled-detection,
  // auth.magic_links, auth.sessions. One sweep loop, registered tables.
  try {
    registerAllExpirables();
  } catch (e) {
    console.warn('[api] expirable-registry failed to start:', (e as Error)?.message ?? e);
  }

  // Opt-in dev-mode hot-reload — watches ~/.papercusp/global-plugins/ and
  // resets the in-process runtime cache whenever a manifest or entry file
  // changes. Production hosts should leave this off (default).
  if (process.env.PAPERCUSP_DEV_PLUGIN_WATCH === '1') {
    // Lazy import so the watcher's fs.watch handle isn't held in tests
    // that don't import this module's bootstrap code.
    import('@papercusp/operator-core/lib/plugin-host-runtime')
      .then(({ watchPluginsForReload }) => watchPluginsForReload())
      .catch((e) => console.warn('[plugin-host-watch] failed to arm:', e));
  }

  // P-004 of desktop-app-install-integration-2026-05-23.
  // When the sidecar is running inside Papercusp.app (Tauri exports
  // PAPERCUSP_DESKTOP=1), self-install the engineer-collaborator
  // files into ~/.papercusp/ on boot. Mirrors what
  // install-standalone-mcp.sh does for dev — best-effort, logs on
  // failure, idempotent on token + agent_id (per a03fb875).
  //
  // Plain dev (`npm run dev` without Tauri) leaves PAPERCUSP_DESKTOP
  // unset, so dev users still use the shell script explicitly per the
  // unchanged dev workflow.
  if (process.env.PAPERCUSP_DESKTOP === '1') {
    import('@papercusp/operator-core/lib/desktop-install/papercusp-files')
      .then(({ installPapercuspFiles }) => installPapercuspFiles())
      .then((r) => {
        const minted = [
          r.minted.token ? 'token' : null,
          r.minted.agentId ? 'agent-id' : null,
        ]
          .filter(Boolean)
          .join('+') || 'reused';
        console.log(
          `[desktop-install] papercusp-files ok (${minted}; playbook=${r.playbookWritten} ext=${r.extensionWritten})`,
        );
      })
      .catch((e) => {
        console.warn('[desktop-install] papercusp-files failed:', (e as Error)?.message ?? e);
      });
  }

  // Model B sync substrate boot. Always runs (the
  // PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE opt-in gate was removed in Stage 4d —
  // the per-peer-log substrate is now the default). Awaits the dogfood schema
  // + boot-gate, then boots every harness in the active workspace. Failures
  // roll up but don't block the host (each harness boot is independently
  // defensive — a swarm/identity failure leaves it local-only).
  // [EI-126] Secondary/test hosts (e.g. the staging operator on :3170) must NOT
  // run the shared-DB background machinery — federation projections + outbox
  // drains (hyperbee substrate), git-export drains, and DBOS scheduled workflows.
  // Two hosts doing this against one papercusp DB caused a DBOS appVersion war,
  // doubled drain loops, and a plan-content federation echo that rewrote single
  // plans ~100k times (a 102 GB substrate_outbox, 2026-06-08). Default ON; the
  // staging systemd unit sets PAPERCUSP_BACKGROUND_WORKERS=0 to be request-only.
  // The release operator (:3070) + the desktop have no override → stay ON.
  //
  // Activation without a unit edit: the explicit flag wins when set; otherwise
  // default ON everywhere EXCEPT the dev-box staging operator, which already sets
  // PAPERCUSP_HONO_PORT=3170 and is request-only by design (the release operator
  // on :3070 owns the shared-DB background machinery). Production ships the
  // desktop app with no :3170, so this branch defaults ON there — correct.
  // EI-312 leg 1: the rule moved to the ONE shared evaluation so the
  // module-scope boot effects in agent-tools/index.ts gate on the same thing.
  const backgroundWorkers = backgroundWorkersEnabled();
  if (!backgroundWorkers) {
    console.log(
      '[host] PAPERCUSP_BACKGROUND_WORKERS=0 — secondary host: skipping hyperbee substrate, git-export, and DBOS background machinery (EI-126)',
    );
  }

  if (backgroundWorkers)
    void (async () => {
    try {
      // [A1 handoff-coordination-dx-followups] Apply pending sql/*.sql to the
      // operator DB on boot. Embedded-pg applies them when ITS server boots, but
      // the native :5432 dev box has no such runner — so without this, a
      // migration added since the last restart stays unapplied (the silent
      // "missing column" gap). Log-and-continue: a broken peer migration is
      // logged + coord-broadcast and left pending, never wedges boot. Awaited
      // here so migrations are in place BEFORE the boot-gate flips + the
      // substrate (which reads those tables) starts.
      const { applyPendingMigrationsAtBoot } = await import('@papercusp/operator-core/lib/db-boot-migrate');
      await applyPendingMigrationsAtBoot();

      // [EI-2048] Self-heal system-principal capability drift on boot. A cap added in
      // code (e.g. operator's memory + locks grant) reaches an ALREADY-provisioned row
      // only via a forceless provision — which used to be a no-op (so the live row stayed
      // stale until someone manually re-POSTed /api/agent-mcp/provision) and whose only
      // alternative (`force`) ROTATES the bearer and breaks live connections.
      // provisionSystemPrincipals now reconciles caps ADDITIVELY in place (no rotation;
      // see provisioning.ts), so calling it forceless per workspace here brings every
      // operator/oracle row up to the code-defined cap set on each deploy — no token
      // churn, no manual step. Runs only on a background-workers host (primary), after
      // migrations (DB ready). Best-effort: a failure logs and never wedges boot.
      try {
        const { provisionSystemPrincipals } = await import('@papercusp/operator-core/lib/ensure-system-principals');
        const { readRegistry } = await import('@papercusp/operator-core/lib/workspace-registry');
        const { papercuspRoot } = await import('@papercusp/operator-core/lib/papercusp-root');
        const root = papercuspRoot();
        let healed = 0;
        for (const ws of readRegistry().workspaces) {
          const ensured = await provisionSystemPrincipals({ workspaceId: ws.id, papercuspRoot: root });
          healed += ensured.filter((e) => e.reconciled || e.rotated).length;
        }
        if (healed > 0) console.warn(`[system-principals] boot reconcile updated ${healed} principal cap set(s) (EI-2048)`);
      } catch (e) {
        console.warn('[system-principals] boot reconcile failed (non-fatal):', e instanceof Error ? e.message : e);
      }

      // [B-TOK-ROLL token-tracking] Refresh the model_pricing projection (migration
      // 334) from the canonical in-code MODEL_PRICES, right after migrations create
      // the table. The DB table is a derived snapshot for SQL-side $-transparency;
      // this UPSERT keeps it from drifting when MODEL_PRICES changes. Best-effort —
      // the helper swallows its own errors and never wedges boot.
      try {
        const { syncModelPricingFromCode } = await import(
          '@papercusp/operator-core/lib/harness-insights/model-pricing-sync'
        );
        await syncModelPricingFromCode();
      } catch (e) {
        console.warn('[model-pricing-sync] boot sync failed (non-fatal):', e instanceof Error ? e.message : e);
      }

      // [benchmark-evaluation-ui P-005 / D-022] Spend-safety reaper — AWAITED here,
      // right after migrations and BEFORE the boot-gate flips (so it runs before
      // the routines engine could re-arm an orphan's wake/git-sync). A UI-launched
      // bench run in flight when a host CRASHED (SIGKILL bypasses its teardown
      // finally) leaves an orphan hive whose routines would re-spin opus on this
      // restart. Reap any run whose liveness heartbeat is stale (>180s): dissolve
      // its hive (clears the Queen wake + DELETES the gym/scout learning-loop rows
      // + drops the schema) and freeze its status. Heartbeat-gated so a run
      // legitimately in flight in another LIVE host is untouched. The no-orphan
      // case (the norm) is a single fast SELECT → ~0 boot cost. try/catch so a
      // failure never wedges boot (the next restart retries).
      try {
        const { reapStaleBenchRuns } = await import('@papercusp/operator-core/lib/external-bench/run-launcher');
        const { reaped } = await reapStaleBenchRuns();
        if (reaped.length > 0) {
          console.warn(`[bench-reaper] reaped ${reaped.length} stale bench run(s): ${reaped.join(', ')}`);
        }
      } catch (e) {
        console.warn('[bench-reaper] boot reap failed (non-fatal):', e instanceof Error ? e.message : e);
      }

      // Backfill the preserved file-dir benchmark runs (~/.papercusp/bench-results/<id>/) into the
      // operational store so the Evaluation UI's Compare view has runs to render. Idempotent
      // (upsert by run id), cheap (a handful of dirs), and the ONLY thing that populates bench_runs
      // for imported/reference runs — without it the store stays empty and Compare shows nothing.
      // try/catch so a malformed run dir never wedges boot.
      try {
        const { importAllPreservedRuns } = await import('@papercusp/operator-core/lib/external-bench/run-store');
        const { imported, skipped } = await importAllPreservedRuns();
        if (imported.length > 0) {
          console.warn(`[bench-import] imported ${imported.length} preserved run(s): ${imported.join(', ')}${skipped.length ? ` (skipped ${skipped.length})` : ''}`);
        }
      } catch (e) {
        console.warn('[bench-import] boot import failed (non-fatal):', e instanceof Error ? e.message : e);
      }

      // EI-368: a headless utility host (gym-operator) wants the migrations
      // above but neither the embedder warm-up (onnxruntime) nor the dogfood
      // substrate (holepunch natives) — both are in the Napi-abort suspect set
      // and neither serves a short-lived dedicated instance.
      if (utilityHost) return;

      // Best-effort embedder warm-up (memory-backend-improve-and-hybrid P-004a):
      // fire one throwaway memory search so the user's first turn doesn't pay the
      // embedder cold-start. Detached (never awaited) and fully self-contained —
      // warmMemoryEmbedder swallows every error, so it can't affect boot.
      void import('@papercusp/operator-core/lib/memory/warm')
        .then(({ warmMemoryEmbedder }) => warmMemoryEmbedder())
        .catch(() => {});

      // The dogfood PG schema + change-notify/capture triggers are defined
      // entirely by migrations (000-baseline + 107/108), now applied above (or
      // by the embedded-pg boot) — no runtime schema-ensure here. Flip the
      // boot-gate so the substrate can start.
      const { markSqlMigrationsComplete, markRuntimeEnsureComplete } =
        await import('@papercusp/operator-core/lib/sync/hyperbee/boot-gate');
      markSqlMigrationsComplete();
      markRuntimeEnsureComplete();
      const { bootSubstrateWithFallback } = await import(
        '@papercusp/operator-core/lib/sync/hyperbee/substrate-boot-wrapper'
      );
      const t0 = Date.now();
      const result = await bootSubstrateWithFallback({
        perHarnessTimeoutMs: 30_000,
      });
      console.log(
        `[hyperbee-substrate] boot complete in ${Date.now() - t0}ms — attempted=${result.attempted} booted=${result.booted} alreadyBooted=${result.alreadyBooted} failed=${result.failed}`,
      );
      if (result.failed > 0) {
        for (const r of result.results) {
          if (r.state === 'failed') {
            console.warn(
              `[hyperbee-substrate] (${r.workspaceId}::${r.harnessSlug}) failed: ${r.error}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        '[hyperbee-substrate] boot failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  })();

  // [harness-state P-003a] Registry coverage + peer-log drift guard (fail-loud,
  // non-fatal). Asserts every live harness_shared table is intentionally
  // classified by the two-axis registry (lib/harness-state/table-registry.ts)
  // and that the sync:'peer-log' set stays in lock-step with the hand-wired
  // Hyperbee projections. A new table that nobody classified, or a peer-log
  // table that lost its projection, logs loudly here.
  void (async () => {
    try {
      const { routeProjection, checkInventoryCoverage } = await import(
        '@papercusp/operator-core/lib/harness-state/projection-engine'
      );
      const { REGISTERED_PROJECTION_TAGS } = await import(
        '@papercusp/operator-core/lib/sync/hyperbee/projections/register-all'
      );
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      const rows = (await sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'harness_shared'
      `) as Array<{ table_name: string }>;
      const live = rows.map((r) => r.table_name);
      // P-003c: the ONE router partitions every live table across the 3 adapters
      // and folds in the peer-log drift guard.
      const route = routeProjection(live, REGISTERED_PROJECTION_TAGS);
      if (!route.peerLogConsistency.ok) {
        console.error(
          `[harness-state] PEER-LOG DRIFT — missingProjection=[${route.peerLogConsistency.missingProjection.join(',')}] orphanTag=[${route.peerLogConsistency.orphanTag.join(',')}]`,
        );
      }
      const cov = checkInventoryCoverage(live);
      if (cov.unreviewed.length > 0) {
        console.error(
          `[harness-state] ${cov.unreviewed.length} UNCLASSIFIED table(s) — add to table-registry.ts: ${cov.unreviewed.join(', ')}`,
        );
      } else {
        console.log(
          `[harness-state] routing OK — ${cov.total} tables → git-export=${route.gitExport.length} peer-log=${route.peerLog.length} local=${route.local.length} (${cov.defaulted.length} default); peer-log drift=${route.peerLogConsistency.ok ? 'none' : 'DETECTED'}`,
        );
      }
    } catch (err) {
      console.warn(
        '[harness-state] coverage check failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  })();

  // [harness-state P-003b] Git-export boot — LIVE-VERIFIED (2026-06-02: 15
  // harnesses / 16 git tables / 15 drain loops). Per workspace's harnesses:
  // ensure the git_export_outbox + reconcile capture triggers on the sync:'git'
  // tables (attach current set, DROP stale ones for tables removed from
  // GIT_TABLES), hydrate each from `.papercusp/state/` (clone-and-go), then start
  // its autonomous PG→file drain loop. Non-fatal: a failure leaves harnesses on
  // their existing PG-only behaviour (git-export simply doesn't run). The drain's
  // auto-commit (git-committer.ts) is real + scoped to `.papercusp/state` only and
  // never pushes, but FLAG-GATED OFF by default (PAPERCUSP_GIT_EXPORT_COMMIT=1 to
  // enable); until then the files are written + visible but left uncommitted.
  if (backgroundWorkers)
    void (async () => {
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readRegistry } = await import('@papercusp/operator-core/lib/workspace-registry');
      const { loadHarnessRegistry } = await import('@papercusp/operator-core/lib/harness-registry');
      const { bootGitExportForHarnesses } = await import('@papercusp/operator-core/lib/harness-state/git-export/boot');
      const { sql } = getOrgPg();
      const harnesses: { workspaceId: string; harnessSlug: string; harnessRoot: string }[] = [];
      for (const ws of readRegistry().workspaces) {
        const reg = await loadHarnessRegistry(ws.id);
        for (const p of reg.projects) {
          harnesses.push({ workspaceId: ws.id, harnessSlug: p.slug, harnessRoot: p.path });
        }
      }
      const res = await bootGitExportForHarnesses(sql, harnesses);
      console.log(
        `[git-export] boot: ${res.harnesses} harness(es), ${res.globals.attached.length} git table(s), ` +
          `${res.handles.length} drain loop(s)` +
          (res.globals.detached.length ? `, detached ${res.globals.detached.length} stale: ${res.globals.detached.join(',')}` : ''),
      );
    } catch (err) {
      console.warn(
        '[git-export] boot failed (non-fatal, draft):',
        err instanceof Error ? err.message : err,
      );
    }
  })();

  // gateway-rate-limit-stall-autowake (2026-06-23 fix): the stall-waker re-wakes a rate-limit-stalled session
  // when its account recovers, but it was started ONLY lazily from the bee-spawn path (operator-spawn:1056). So
  // if the operator restarts and no bee spawns (a quiet / capacity-throttled fleet), the loop never runs and
  // recorded stalls — including su/psu sessions, now role-agnostic — pile up UNPROCESSED → no auto-wake (the
  // su-3650b incident: 95 stalls, oldest 34 min, never woken). Start it on BOOT too, per workspace.
  // NO FLAG-GATE (2026-06-23): gating on getFlag(INFERENCE_GATEWAY) was FRAGILE — it resolved false in the host
  // context (PostHog distinct-id / unreachable → code default false), so the boot-start no-op'd and the backlog
  // never drained. The waker just polls the gateway's /admin/stalls and no-ops if it's unreachable, so it is
  // harmless to always run (lightweight + unref'd). ensureStallWakerLoop is idempotent (spawn-path call = no-op).
  if (backgroundWorkers)
    void (async () => {
      try {
        const { readRegistry } = await import('@papercusp/operator-core/lib/workspace-registry');
        const { ensureStallWakerLoop } = await import('@papercusp/operator-core/lib/inference-gateway/stall-waker-loop');
        const wss = readRegistry().workspaces;
        for (const ws of wss) ensureStallWakerLoop(ws.id);
        console.log(`[stall-waker] boot-start: ${wss.length} workspace(s)`);
      } catch (e) {
        console.warn(`[stall-waker] boot-start failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    })();

  // DBOS Transact durable-jobs substrate (dbos-durable-jobs-2026-05-31).
  // Gated by PAPERCUSP_DBOS_ENABLE=1; default OFF. Dynamic import so the host
  // doesn't require @dbos-inc/dbos-sdk when the flag is off. This is the LIVE
  // boot path (the Hono host) — the retired instrumentation-node.ts also has
  // this block, but startDbos() is globalThis-idempotent so a double-call is a
  // no-op. startDbos() itself conditionally loads the AutoLoop (PAPERCUSP_DBOS_AUTOLOOP)
  // and periodic-timer (PAPERCUSP_DBOS_TIMERS) workflows; the legacy setInterval
  // workers stand down via their own guards.
  if (backgroundWorkers && process.env.PAPERCUSP_DBOS_ENABLE === '1') {
    void (async () => {
      try {
        const { startDbos } = await import('@papercusp/operator-core/lib/dbos/bootstrap');
        await startDbos();
      } catch (err) {
        console.warn('[dbos] boot failed (non-fatal):', err instanceof Error ? err.message : err);
      }
    })();
  }

  // Red Queen engine-death sentinel (self-learning-frontier P-031 / FB-20): a
  // PLAIN interval, deliberately outside DBOS/routines, so it survives exactly
  // the failure it watches for — the swallowed '[dbos] boot failed' above left
  // every routine dead for 80+ min on 2026-06-12 with nothing detecting it.
  // Inert while the papercusp-red-queen flag is OFF (checked every pass).
  if (backgroundWorkers) {
    void (async () => {
      try {
        const { armEngineDeathSentinel } = await import('@papercusp/operator-core/lib/red-queen/engine-death');
        armEngineDeathSentinel();
      } catch (err) {
        console.warn('[red-queen-sentinel] arm failed (non-fatal):', err instanceof Error ? err.message : err);
      }
    })();
  }

  // EI-1622: lightweight in-process periodic checks — systemHealth,
  // harnessStatusSweep, connectionPressure, serviceHealth, completionRefVerify,
  // spawnReclaimSweep, staleClaimSweep, learningInfraHealth, steeringChurnSweep.
  // These ephemeral, idempotent probes were durable DBOS scheduled workflows that
  // each persisted a dbos.workflow_status row every 30–60s (~200k/day) → executor
  // starvation → routinesTick stall → Queen freeze. As plain unref'd intervals they
  // write ZERO workflow_status rows (the source fix). Gated on backgroundWorkers (like
  // the sentinel above) so a naive interval never runs N× across :3070 cluster request
  // workers (DBOS dedup'd by workflow-id, in-process does not); skipped on a utility
  // host (gym-operator) just as the former dbosPeriodicTimersActive did.
  if (backgroundWorkers && !utilityHost) {
    void (async () => {
      try {
        // EI-2186: BEFORE arming the periodic sweep, reconcile the spawn-admission
        // ceiling against reality. A host/process restart kills in-flight spawns
        // before their admission-release runs, leaving 'running' nursery rows that
        // jam `maxSimultaneousAgents` forever (the periodic reclaim can't clear them
        // — a stale launch row's reused pid reads as "alive" and its heartbeat is
        // bumped, so it never becomes a candidate). This boot reconcile frees every
        // same-host row owned by a dead prior incarnation (boot-id mismatch),
        // regardless of heartbeat freshness, then wakes any over-ceiling waiter.
        try {
          const { getOrgPg } = await import('@papercusp/db-org');
          const { reconcileSpawnAdmissionOnBoot } = await import('@papercusp/operator-core/lib/fleet/spawn-reclaim');
          // EI-85 (restart-kills): re-launch a reclaimed queen/bee whose durable
          // work-item is still non-terminal, instead of just killing it — so the
          // hive survives ANY host restart. Flag-gated: OFF ⇒ no relaunch seam ⇒
          // legacy reclaim-to-`failed` (byte-identical). Resolve the flag with the
          // host id as the distinct id (a host-level routine, not a per-user gate).
          let relaunch:
            | (typeof import('@papercusp/operator-core/lib/fleet/spawn-relaunch'))['relaunchReclaimedSpawn']
            | undefined;
          try {
            const { hostname } = await import('node:os');
            if (await getFlag(FLAGS.SPAWN_RECLAIM_RELAUNCH, `host:${hostname()}`)) {
              ({ relaunchReclaimedSpawn: relaunch } = await import(
                '@papercusp/operator-core/lib/fleet/spawn-relaunch'
              ));
            }
          } catch (e) {
            console.warn(
              `[spawn-reclaim] relaunch seam unavailable (reclaim-only this boot): ${e instanceof Error ? e.message : e}`,
            );
          }
          const r = await reconcileSpawnAdmissionOnBoot(getOrgPg().sql, relaunch ? { relaunch } : {});
          if (r.relaunched && r.relaunched.length > 0) {
            console.warn(
              `[spawn-reclaim] boot reconcile RE-LAUNCHED ${r.relaunched.length} queen/bee(s) with non-terminal work after a host restart (EI-85): ${r.relaunched.join(', ')}`,
            );
          }
          if (r.reclaimed > 0) {
            console.warn(
              `[spawn-reclaim] boot reconcile freed ${r.reclaimed} stale admission debit(s) from a prior incarnation: ${r.spawnIds.join(', ')}`,
            );
            try {
              const { emitAwaitedEvent } = await import('@papercusp/operator-core/lib/events/await/engine');
              const { spawnSlotEventKey } = await import('@papercusp/operator-core/lib/fleet/operator-spawn');
              for (const ws of r.workspaces) {
                await emitAwaitedEvent({
                  key: spawnSlotEventKey(ws),
                  summary: `${r.reclaimed} stale spawn slot(s) freed by the boot reconcile (host restart)`,
                  source: 'spawn-boot-reconcile',
                  workspaceId: ws,
                }).catch(() => undefined);
              }
            } catch {
              /* best-effort — waiters fall back to their await timeout / the periodic sweep */
            }
          }
        } catch (err) {
          console.warn('[spawn-reclaim] boot reconcile failed (non-fatal):', err instanceof Error ? err.message : err);
        }

        const { armInProcessPeriodicChecks } = await import('@papercusp/operator-core/lib/dbos/in-process-periodic');
        armInProcessPeriodicChecks();
      } catch (err) {
        console.warn('[in-process-periodic] arm failed (non-fatal):', err instanceof Error ? err.message : err);
      }
    })();
  }
}
