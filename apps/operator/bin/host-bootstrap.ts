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
import { mountPluginApiRoutes } from '../lib/plugin-api-mount';
import { startAutoLoopOnce } from '../lib/autoloop';
import { ensureHarnessFsWatcher } from '../lib/harness-fs-watcher';
import { ensureHarnessStatusSweep } from '../lib/harness-status-sweep';
import { ensureWaveAdvanceSweep } from '../lib/harness/wave-advance-sweep-live';
import { registerAllExpirables } from '../lib/expirable-registrations';
import { startMobileVoiceWs } from '../lib/device-voice-ws';
import { startPushCredentialRefresher } from '../lib/device-push-credentials';
import { startMobileInterventionWatcher } from '../lib/device-intervention-watcher';
import { ensureMobileDevicesTable } from '../lib/ensure-schema';

const GUARD_KEY = '__papercuspBootstrapRan__';

type GuardedGlobal = typeof globalThis & { [GUARD_KEY]?: boolean };

export function runBootstrap(): void {
  const g = globalThis as GuardedGlobal;
  if (g[GUARD_KEY]) return;
  g[GUARD_KEY] = true;

  // Prewarm the OMP-SU bootstrap (file copies + `omp config set` shell-
  // outs). Runs once per process, fire-and-forget. Without this the
  // first /adv launch pays 5+ seconds of bootstrap synchronously on
  // the response path; with it, the work happens during startup and
  // the first user click is fast like every subsequent click.
  import('../lib/ensure-omp-su')
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

  // AutoLoop ticker — periodic fires of harnesses with autoLoop=true. Idempotent.
  startAutoLoopOnce();
  startMobileVoiceWs();
  startPushCredentialRefresher();
  startMobileInterventionWatcher();

  // Mobile DDL at host startup (Phase E3, endpoint-unification-2026-05-21).
  // Previously ran lazily on the first `/api/device/*` request inside the
  // legacy `_hono/mobile.ts` router; moved here so a mobile `defineTool`
  // (which never touches that router) finds the tables already present.
  // `ensureMobileDevicesTable` is globalThis-guarded + `CREATE … IF NOT
  // EXISTS`, so this is idempotent and safe alongside the legacy lazy call
  // that remains until `_hono/mobile.ts` is deleted (Phase E5).
  void ensureMobileDevicesTable().catch((e) => {
    console.warn('[api] ensureMobileDevicesTable failed:', (e as Error)?.message ?? e);
  });

  // Harness FS watcher — mirrors .harness/{summary.md,pending-reviews,proposals}
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

  // Wave-advance sweep (promote-policy-and-waves P-009): per started plan with a
  // `## Promote` policy, auto-promote the next wave when the current one drains.
  // No-op for plans without a policy. Idempotent.
  try {
    ensureWaveAdvanceSweep();
  } catch (e) {
    console.warn('[api] wave-advance-sweep failed to start:', (e as Error)?.message ?? e);
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
    import('../lib/plugin-host-runtime')
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
    import('../lib/desktop-install/papercusp-files')
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

  // dogfood-v5 Phase 5a — Hyperbee substrate boot. Gated by
  // PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1; default OFF so the dev loop is
  // unchanged until explicit opt-in. Same wiring as the (retired)
  // instrumentation-node.ts: await boot-gate, then boot every harness
  // in the active workspace. Failures roll up but don't block the host.
  if (process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE === '1') {
    void (async () => {
      try {
        // host-bootstrap.ts doesn't run a separate migrations / schema-
        // ensure phase the way the retired Next instrumentation did.
        // The dogfood projection writers handle their own ensure on
        // first write, so mark the gate complete here and proceed.
        const { markSqlMigrationsComplete, markRuntimeEnsureComplete } =
          await import('../lib/sync/hyperbee/boot-gate');
        markSqlMigrationsComplete();
        markRuntimeEnsureComplete();
        const { bootAllHarnessesForActiveWorkspace } = await import(
          '../lib/sync/hyperbee/boot-all'
        );
        const t0 = Date.now();
        const result = await bootAllHarnessesForActiveWorkspace({
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
  }
}
