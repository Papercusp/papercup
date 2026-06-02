/**
 * Next.js instrumentation hook — runs once at server startup, before any
 * route handler. Used to boot the pty WebSocket server alongside the
 * Next HTTP server.
 *
 * The pty WS server lives on a separate port (default 3056) rather than
 * sharing the Next server's port. This is the same shape as Wetty,
 * GoTTY, and ttyd: keeping `next dev` / Turbopack untouched is cheaper
 * than replacing the dev server with a custom `server.js` that hosts
 * both. In dev the second port is just `localhost:3056`; in production
 * nginx needs a `location /pty/` block that upgrades to ws://.
 *
 * Idempotent: re-runs (Next dev re-loads instrumentation on some
 * config changes) detect EADDRINUSE and skip.
 */
export async function register(): Promise<void> {
  // Edge / Workers runtime can't open sockets; skip.
  // process.env.NEXT_RUNTIME is "nodejs" in the Node runtime.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Register the desktop HostPlatform impl. Done first so any code path
  // that calls getHostPlatform() (prompt resolvers, hindsight readers,
  // etc.) sees a real platform from the first request. The operator is
  // always either Tauri-hosted or a local-dev Node process — both are
  // "desktop" for HostPlatform purposes. A future server host would
  // register `serverHostPlatform` instead from its own entry point.
  try {
    const [{ registerHostPlatform }, { desktopHostPlatform }] = await Promise.all([
      import('@papercusp/host-platform'),
      import('@papercusp/host-platform/desktop'),
    ]);
    registerHostPlatform(desktopHostPlatform);
  } catch (err) {
    console.warn('[host-platform] register failed (non-fatal):', err);
  }

  // Drop the omp-su wrapper + its deps into the user's home so /adv
  // OMP launches work out of the box. Fire-and-forget; never blocks
  // operator startup.
  try {
    const { ensureOmpSuInstalled } = await import('./lib/ensure-omp-su');
    ensureOmpSuInstalled().catch((e) =>
      console.warn('[ensure-omp-su] failed (non-fatal):', e),
    );
  } catch (e) {
    console.warn('[ensure-omp-su] import failed (non-fatal):', e);
  }

  // Ensure the papercusp-workspace sentinel exists in the workspace
  // registry (papercusp-dogfood-v5 §1 / P-006 / P-014). Synchronous,
  // idempotent, and small — never blocks startup measurably. Doesn't
  // touch registry.current for existing installs, so it can't disturb
  // an already-running session.
  try {
    const { ensurePapercuspWorkspace } = await import('./lib/harness/papercusp-workspace');
    ensurePapercuspWorkspace();
  } catch (e) {
    console.warn('[papercusp-workspace] ensure failed (non-fatal):', e);
  }

  // Auto-register the papercup repo as a harness in the sentinel
  // workspace if we're running from source (papercusp-dogfood-v5
  // Phase 4 / P-024). Fire-and-forget; no-op for packaged installs
  // where the repo isn't on disk. Idempotent: subsequent boots
  // detect the existing entry and return immediately.
  (async () => {
    try {
      const { registerPapercupHarness } = await import('./lib/harness/register-papercup');
      const result = await registerPapercupHarness();
      if (result.state === 'newly-registered') {
        console.log(`[register-papercup] registered as harness 'papercup' at ${result.path}`);
      } else if (result.state === 'skipped') {
        console.log(`[register-papercup] skipped: ${result.reason}`);
      }
    } catch (e) {
      console.warn('[register-papercup] failed (non-fatal):', e);
    }
  })();

  // Pty WS server: only when not opt-out and not running under Tauri.
  // Both early-exits below ONLY skip pty-ws — they fall through to the
  // schema pre-warm so desktop and PTY-disabled environments still get
  // the boot-time DDL warming.
  await maybeStartPtyWsServer();

  // Endpoint IPC server (opt-in). Tauri launches the sidecar with
  // PAPERCUSP_IPC_ENABLE=1; the bootstrap then watches the stdout
  // ready line and connects from Rust. Without the env var, this
  // is a no-op so the webapp and non-Tauri dev path are unchanged.
  await maybeStartEndpointIpcServer();

  // Boot-time self-repair: drizzle-kit pull periodically truncates the
  // PG default `((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint`
  // at the type-cast colon, producing unbalanced parens that crash
  // esbuild on every route compile. Detect-and-repair here so a stale
  // generated.ts doesn't silently 500 every API call until someone
  // notices. See pull-schema.mjs Fix 7.
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const fs = req('node:fs') as typeof import('node:fs');
    const path = req('node:path') as typeof import('node:path');
    const generatedPath = path.resolve(
      process.cwd(),
      'libs/papercusp/libs/db/src/schema/generated.ts',
    );
    if (fs.existsSync(generatedPath)) {
      const broken = '.default(sql`((EXTRACT(epoch FROM now()) * (1000)`)';
      const balanced = '.default(sql`(EXTRACT(epoch FROM now()) * 1000)::bigint`)';
      const txt = fs.readFileSync(generatedPath, 'utf8');
      if (txt.includes(broken)) {
        const repaired = txt.split(broken).join(balanced);
        fs.writeFileSync(generatedPath, repaired);
        const n = txt.split(broken).length - 1;
        console.warn(`[generated-self-repair] fixed ${n} truncated EXTRACT defaults in ${generatedPath}`);
      }
    }
  } catch (err) {
    console.warn('[generated-self-repair] non-fatal failure:', (err as Error)?.message ?? err);
  }

  // Apply pending SQL migrations against the harness-admin DB. The
  // embedded-postgres-server runs this on its own boot for Tauri desktop
  // bundles, but in dev (operator → native PG at :5432) and in any
  // deployment where PG is provisioned externally, nothing was applying
  // them — every new migration since 057 needed a manual apply-NNN.sh
  // script. Run it here so the operator stays in lock-step with the
  // SQL dir on every boot. Idempotent (schema_migrations tracker);
  // non-fatal so a permission-quirk or unreachable PG doesn't block
  // startup — the route would surface the real error anyway.
  void (async () => {
    try {
      // Subpath import — the package's main entry re-exports
      // applyPendingMigrations on tip of libs/papercusp, but the
      // submodule pointer on papercup main may lag that export. The
      // src/migration-runner.js file has been stable since the runner
      // was added, so importing it directly is robust to submodule drift.
      const { applyPendingMigrations } = await import('@papercusp/embedded-postgres-server/src/migration-runner.js');
      const { getHarnessAdminUrlWithSource } = await import('@/lib/embedded-pg-discovery');
      const postgres = (await import('postgres')).default;
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      const path = req('node:path') as typeof import('node:path');
      const fs = req('node:fs') as typeof import('node:fs');
      // Resolve relative to *repo root*, not process.cwd(). Next dev runs
      // from apps/operator/, monorepo scripts run from the root — both
      // must find libs/papercusp/libs/db/sql. Try cwd first, then walk up
      // to find the libs/papercusp marker.
      const candidates = [
        path.resolve(process.cwd(), 'libs/papercusp/libs/db/sql'),
        path.resolve(process.cwd(), '../../libs/papercusp/libs/db/sql'),
        path.resolve(process.cwd(), '../../../libs/papercusp/libs/db/sql'),
      ];
      const sqlDir = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
      const { url, source } = getHarnessAdminUrlWithSource();
      const sql = postgres(url, { max: 1, prepare: false });
      try {
        const result = await applyPendingMigrations({
          client: sql,
          sqlDir,
          log: (m: string) => console.log(`[migration-runner] ${m}`),
        });
        if (result.appliedCount > 0) {
          console.log(`[migration-runner] applied ${result.appliedCount} pending migration(s) from ${source} (${result.totalKnown} total known)`);
        }
      } finally {
        await sql.end({ timeout: 2 });
      }
      // P-006 (fleet-coordination-painpoints): after the boot apply, any
      // REMAINING drift means a migration failed to apply (or is manual-only)
      // — surface it loudly here rather than let an agent hit it at runtime.
      try {
        const { checkMigrationDrift } = await import('@/lib/migration-drift');
        const drift = await checkMigrationDrift();
        if (!drift.inSync) {
          console.warn(
            `[migration-drift] DB not in sync after boot apply — missing: ${drift.missing.join(', ') || '∅'}; extra: ${drift.extra.join(', ') || '∅'}. Inspect with db:check_drift.`,
          );
        }
      } catch {
        // best-effort — never block boot on the drift check.
      }
    } catch (err) {
      console.warn('[migration-runner] non-fatal failure:', (err as Error)?.message ?? err);
    }
  })();

  // Pre-warm common API routes so the first user fetch doesn't pay for
  // Turbopack's per-route lazy-compile (5-25s on this monorepo).
  // WebKitGTK aborts slow same-origin fetches with the misleading
  // "Fetch API cannot load … due to access control checks" devtools
  // message — those errors are dev-only timing, not CORS, but they
  // litter the user's console. Firing internal GETs ~2s after boot
  // forces compilation off the client's critical path.
  if (process.env.NODE_ENV !== 'production') {
    setTimeout(() => { void prewarmRoutes(); }, 2_000);
  }

  // Phase 4 T2.3: schedule the scratch-storage GC sweep so stale
  // tool-output dirs get cleaned every 1h. Idempotent; safe across
  // HMR reloads. Reads the workspace registry on each sweep so
  // dead-workspace dirs get reaped.
  try {
    const { startScratchGcScheduler } = await import('@/lib/scratch-gc');
    const { readRegistry } = await import('@/lib/workspace-registry');
    startScratchGcScheduler({
      getWorkspaceRegistry: () => readRegistry().workspaces.map((w) => w.id),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[scratch-gc] scheduler init failed (non-fatal):', (err as Error).message);
  }

  // One-shot grants backfill — Batch B3. After Migration 051 ships, every
  // existing (plugin, harness) pair in `enabled-plugins.json` needs a
  // grant row so the new Tier-2 check doesn't deny them all on first
  // reload. Idempotent (ON CONFLICT DO NOTHING). Skips silently when PG
  // is unavailable; subsequent boots retry.
  void backfillGrantsOnce().catch((err) => {
    console.warn('[plugin-grants-backfill] non-fatal failure:', err?.message ?? err);
  });

  // One-shot: bring legacy voice-prefs rows down to the credit-burn-batch
  // tightened defaults. Only touches rows whose value exactly equals the
  // OLD default — preserves explicit user choices. Idempotent: re-running
  // after the migration is a no-op (no rows will match the old default
  // anymore). Failures are non-fatal.
  void migrateVoicePrefsDefaults().catch((err) => {
    console.warn('[voice-prefs-defaults-migrate] non-fatal failure:', err?.message ?? err);
  });

  // Seed the `default` user on first boot. Idempotent. Required so that
  // routes calling getSessionUserOrDefault() have a user to fall back to
  // when no session cookie is present (single-user installs). See Plan 4
  // in PLAN-operator-arc-2026-05-12.md.
  void (async () => {
    try {
      const { ensureDefaultUser } = await import('@/lib/auth');
      await ensureDefaultUser();
    } catch (err) {
      console.warn('[ensure-default-user] non-fatal failure:', (err as Error).message);
    }
  })();

  // Plan 3.8 — periodic mem0 ephemeral-memory cleanup. Idempotent.
  // No-ops cleanly if mem0 deps aren't installed.
  void (async () => {
    try {
      const { startMemoryCleanup } = await import('@/lib/memory/cleanup-worker');
      startMemoryCleanup();
    } catch (err) {
      console.warn('[memory-cleanup] failed to start:', (err as Error).message);
    }
  })();

  // Plan 2B+C — one-shot embed-backfill sweep ~10s after boot. Fills
  // body_embedding / content_embedding / text_embedding columns for
  // any rows missing them. No-ops if pgvector ext missing OR
  // memoryEmbedderMode=disabled.
  void (async () => {
    try {
      const { startEmbedBackfillWorker } = await import('@/lib/search/embed-backfill');
      startEmbedBackfillWorker();
    } catch (err) {
      console.warn('[embed-backfill] failed to start:', (err as Error).message);
    }
  })();

  // Backup scheduler — per-workspace kopia snapshots on cadence + event.
  // Idempotent: noop if already started in this process. Failures
  // surface in the operator log; backup state is non-critical for
  // serving requests.
  // The DBOS backupCadence timer (periodic-workflows) owns this when DBOS timers
  // are the default; the legacy scheduler stands down unless they're disabled
  // (PAPERCUSP_DBOS_TIMERS=0 or the full revert _ORCHESTRATOR=0). The backup tick
  // itself is internally deduped, so this is belt-and-suspenders.
  if (process.env.PAPERCUSP_DBOS_ORCHESTRATOR === '0' || process.env.PAPERCUSP_DBOS_TIMERS === '0') {
    try {
      const { startBackupScheduler } = await import('@/lib/backup');
      startBackupScheduler();
    } catch (err) {
      console.warn('[backup-scheduler] failed to start:', err instanceof Error ? err.message : err);
    }
  }

  // Backup orphan-snapshot sweep. Marks `running` rows stuck >1h as
  // failed so the UI stops showing them as in-progress indefinitely
  // (round-13 collateral; step D of the Tier-1/Tier-2 follow-up arc).
  // Idempotent. Independent of the main scheduler so it runs even if
  // kopia is missing.
  try {
    const { startOrphanSweepWorker } = await import('@/lib/backup/orphan-cleanup');
    startOrphanSweepWorker();
  } catch (err) {
    console.warn('[backup-orphan-sweep] failed to start:', err instanceof Error ? err.message : err);
  }

  // Telemetry flush worker. Hourly drain of the in-app ring buffer
  // into the archive + (when configured) forward to remote sink.
  // Idempotent across re-registrations.
  try {
    const { startTelemetryFlushWorker } = await import('@/lib/telemetry-flush');
    startTelemetryFlushWorker();
  } catch (err) {
    console.warn('[telemetry-flush] failed to start:', err instanceof Error ? err.message : err);
  }

  // completion_ref verifier (dogfood-v5 Phase 2 P-016). Polls every
  // harness's pending_done / recently-shipped features against the
  // remote via `git ls-remote` and stamps verified_done_at_remote_ts.
  // Drives the tier-B ✓ badge per §17 / D-030. Idempotent across HMR.
  // 60s default interval; unref'd so it doesn't keep the process
  // alive in tests.
  try {
    const { startCompletionRefVerifier } = await import(
      '@/lib/harness/completion-ref-verifier'
    );
    startCompletionRefVerifier();
  } catch (err) {
    console.warn(
      '[completion-ref-verifier] failed to start:',
      err instanceof Error ? err.message : err,
    );
  }

  // NOTE: the Model B sync-substrate boot lives in the LIVE Hono host
  // (`bin/host-bootstrap.ts`), where it now always runs (the
  // PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE opt-in gate was removed in Stage 4d).
  // This Next.js instrumentation hook is the retired boot path, so the
  // duplicate substrate-boot block was dropped here rather than un-gated.

  // DBOS Transact durable-jobs substrate (dbos-durable-jobs-2026-05-31,
  // Phase 0). Gated by PAPERCUSP_DBOS_ENABLE=1; default OFF so the existing
  // boot path is unchanged until opted in. Dynamic import so the operator
  // does NOT require @dbos-inc/dbos-sdk to be installed when the flag is off
  // (it isn't a hard dep of the boot path — only of this opt-in block).
  if (process.env.PAPERCUSP_DBOS_ENABLE === '1') {
    void (async () => {
      try {
        const { startDbos } = await import('./lib/dbos/bootstrap');
        await startDbos();
      } catch (err) {
        console.warn('[dbos] boot failed (non-fatal):', err instanceof Error ? err.message : err);
      }
    })();
  }
}

let _backfillRan = false;
async function backfillGrantsOnce(): Promise<void> {
  if (_backfillRan) return;
  _backfillRan = true;
  const { backfillGrantsFromEnabledPluginsAndLegacyFile } = await import('./lib/plugin-grants');
  const { getPluginHost } = await import('./lib/plugin-host-runtime');
  const host = await getPluginHost();
  // Build the (harness, plugin[]) shape the backfill expects from the
  // loaded plugin list. Plugins surface in host.loaded once per discovery
  // root; we cross-product against the enabled-plugins.json files on disk.
  // Edge-runtime build refuses static-analysable node:* imports here
  // even though this code path only runs under NEXT_RUNTIME=nodejs (see
  // the guard in register()). createRequire escapes the analysis.
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const fsMod = req('node:fs') as typeof import('node:fs');
  const { existsSync, promises: fs } = fsMod;
  const { join } = req('node:path') as typeof import('node:path');
  const { papercuspRoot } = await import('./lib/papercusp-root');
  const harnessesDir = join(papercuspRoot(), 'harnesses');
  if (!existsSync(harnessesDir)) return;
  const harnessSlugs = (await fs.readdir(harnessesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const pluginsByName = new Map(host.loaded.map((lp) => [lp.plugin.name, lp]));
  const enabledHarnesses: { harnessSlug: string; plugins: { name: string; version: string; manifestCapabilities: string[] }[] }[] = [];
  for (const slug of harnessSlugs) {
    const epPath = join(harnessesDir, slug, 'enabled-plugins.json');
    if (!existsSync(epPath)) continue;
    let enabled: Record<string, { version?: string }> = {};
    try {
      const raw = await fs.readFile(epPath, 'utf8');
      enabled = (JSON.parse(raw) as { enabled?: Record<string, { version?: string }> }).enabled ?? {};
    } catch {
      continue;
    }
    const plugins: { name: string; version: string; manifestCapabilities: string[] }[] = [];
    for (const [name, meta] of Object.entries(enabled)) {
      const lp = pluginsByName.get(name);
      if (!lp) continue;
      plugins.push({
        name,
        version: meta.version ?? lp.plugin.version,
        manifestCapabilities: (lp.plugin.capabilities ?? []) as string[],
      });
    }
    if (plugins.length > 0) enabledHarnesses.push({ harnessSlug: slug, plugins });
  }
  const r = await backfillGrantsFromEnabledPluginsAndLegacyFile(enabledHarnesses);
  console.log(`[plugin-grants-backfill] inserted ${r.inserted} grant rows across ${enabledHarnesses.length} harness(es)`);
}

/**
 * Endpoint IPC server — webview→Tauri→Node fast path. Opt-in via
 * `PAPERCUSP_IPC_ENABLE=1`. The Tauri sidecar bootstrap sets this
 * before launching the operator and watches stdout for the
 * `PAPERCUSP_IPC_READY socket=<path>` handshake line.
 *
 * In dev (non-Tauri), the env stays unset and this is a no-op.
 * In the webapp prod surface, the env stays unset and this is a no-op.
 * In Tauri prod, the env is set + Rust connects post-handshake.
 */
async function maybeStartEndpointIpcServer(): Promise<void> {
  if (process.env.PAPERCUSP_IPC_ENABLE !== '1') return;
  try {
    const [{ startEndpointIpcServer }, { PROJECTED_DEPS }, { listAllProjectedTools }] =
      await Promise.all([
        import('./lib/endpoint-ipc/server'),
        import('./lib/projected-tool-deps'),
        import('@papercusp/tooldef'),
      ]);
    // Ensure every operator-side defineTool() side-effect has run so the
    // projection registry is populated before we read expose.ipc off it.
    await import('./lib/agent-tools');
    // Registry-driven IPC allowlist (Phase E8): a tool is IPC-eligible iff it
    // declares `expose: { ipc: true }`. `sys:http` — the privileged
    // HTTP-over-IPC bridge, not a defineTool projection — is added explicitly.
    const ipcEligible = listAllProjectedTools()
      .filter((t) => t.expose?.ipc === true)
      .map((t) => t.expose.mcp?.name)
      .filter((n): n is string => typeof n === 'string');
    const allowedTools = [...new Set([...ipcEligible, 'sys:http'])];
    await startEndpointIpcServer({
      // Default path: ~/.papercusp/sockets/<pid>.sock (Linux/macOS) or
      // \\\\.\\pipe\\papercusp-<pid> (Windows). The Rust client reads
      // the resolved path from the stdout PAPERCUSP_IPC_READY line.
      socketPath: process.env.PAPERCUSP_IPC_SOCKET || undefined,
      // Same telemetry + quota implementation the HTTP catch-all
      // route uses. Without this, IPC calls were invisible to
      // /dev → Sessions and /dev → Telemetry. Audit deferred item 4.
      deps: PROJECTED_DEPS,
      // IPC allowlist. Each tool here must be self-contained — every
      // safety check + persistence side-effect lives in the tool
      // handler, NOT the route. Adding a tool to this list without
      // verifying that property is the bug class the audit caught.
      //
      // dev:ipc_echo — liveness probe (/dev → IPC tab).
      // operator:scan — self-contained as of the post-deferred refactor:
      //                 budget check + scan lock + scan tracker + plugin
      //                 merge + snapshot + session bump all run inside
      //                 the tool. Route layer keeps only rate-limit
      //                 (DoS protection — irrelevant for in-boundary IPC)
      //                 and the idle-cache short-circuit (cheap cache
      //                 hit — IPC can pay the LLM cost; no harm).
      //
      // architect:chat / brainstorm:chat — self-contained as of
      //                 the prompts.ts extraction: tool resolves the
      //                 project + composes SPEC.md/features/brainstorm
      //                 prompt internally. Args are just the slug +
      //                 history + message.
      // operator:delegate — self-contained: principal load, session
      //                 pick/resume, mcpConfig assembly, post-stream
      //                 appendDelegateTurn + generateSessionTitle all
      //                 inside the handler. Route is a 100-line shim.
      // operator:converse — self-contained: buildOperatorPrompt
      //                 (role+memory+history+trigger), checkBudget,
      //                 mcpConfig assembly, recordSpend, post-turn
      //                 mem0.add, and <spawn>-tag dispatch all inside
      //                 the handler. Route is a ~130-line shim whose
      //                 only HTTP-specific step is resolving
      //                 sessionUser from cookies and passing it
      //                 through as an arg.
      //
      // All Phase-3 streaming tools are IPC-eligible.
      //
      // sys:http — privileged HTTP-over-IPC bridge for the webview's
      // fetch/EventSource polyfills. Not a defineTool projection; the
      // IPC server special-cases this name and dispatches into the
      // operator's own loopback HTTP port. Allowlist entry is uniform
      // gating, not a tool resolution. See the sys:http bridge in
      // @papercusp/ipc-endpoint-server (packages/ipc-endpoint-server/src/sys-http.ts).
      allowedTools,
    });
  } catch (err) {
    console.error('[endpoint-ipc] failed to start:', err);
  }
}

async function maybeStartPtyWsServer(): Promise<void> {
  // Allow opt-out for environments where we'd prefer the legacy SSE+POST
  // path only (e.g. behind a reverse proxy that doesn't pass upgrades).
  if (process.env.PAPERCUSP_PTY_WS === '0') {
    console.log('[pty-ws] PAPERCUSP_PTY_WS=0 — skipping pty WebSocket server');
    return;
  }

  // Tauri (the desktop) ships a native pty bridge over IPC and PiPanel.tsx
  // detects window.__PAPERCUSP_TAURI__ and routes spawn/write/resize/kill
  // through that bridge. The pty-ws server is therefore dead code on
  // desktop. Worse: with the dev-default port 3056, a desktop launched
  // alongside `bin/prod` (which also defaults PTY=3056) prints the
  // "[pty-ws] port 3056 in use" warning and noisily fails to bind.
  // Skip cleanly when running under Tauri.
  if (process.env.PAPERCUSP_DESKTOP === '1') {
    console.log('[pty-ws] PAPERCUSP_DESKTOP=1 — skipping pty WebSocket server (Tauri native pty handles this)');
    return;
  }

  const port = Number.parseInt(process.env.PAPERCUSP_PTY_WS_PORT ?? '3056', 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.warn(`[pty-ws] invalid PAPERCUSP_PTY_WS_PORT, skipping`);
    return;
  }

  // Production allow-list. In dev, allowLocalhost catches everything.
  const allowedHosts = (process.env.PAPERCUSP_PTY_WS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const { startPtyWsServer } = await import('./lib/pty-ws');
    startPtyWsServer({
      port,
      allowedHosts,
      allowLocalhost: process.env.NODE_ENV !== 'production' || allowedHosts.length === 0,
    });
  } catch (err) {
    console.error('[pty-ws] failed to start:', err);
  }
}

let _voicePrefsMigrateRan = false;
async function migrateVoicePrefsDefaults(): Promise<void> {
  if (_voicePrefsMigrateRan) return;
  _voicePrefsMigrateRan = true;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // Migrate ONLY rows where the field exactly equals the OLD default —
  // preserves explicit user choices (e.g. someone who actually wants 5).
  // Repeated runs no-op once the migration has touched a row.
  const rows = await sql<{ workspace_id: string }[]>`
    UPDATE harness_shared.operator_voice_prefs
       SET payload = jsonb_set(payload, '{fullAgentIdleTimeoutMin}', '2'::jsonb, false),
           updated_at = ${Date.now()}
     WHERE (payload->>'fullAgentIdleTimeoutMin')::int = 5
    RETURNING workspace_id
  `;
  if (rows.length > 0) {
    console.log(`[voice-prefs-defaults-migrate] tightened fullAgentIdleTimeoutMin 5→2 on ${rows.length} row(s)`);
  }
}

async function prewarmRoutes(): Promise<void> {
  // Routes the operator chrome hits on every page mount. First call to
  // each takes 5-25s under Turbopack lazy-compile in this monorepo;
  // WebKitGTK aborts those slow fetches with a misleading "access
  // control checks" devtools message. Pre-warming makes the user's
  // first request hit a cached compile and respond in <50ms.
  const ROUTES = [
    '/api/desktop/setup-status',
    '/api/desktop/setup-wizard-state',
    '/api/desktop/voice-configured',
    '/api/desktop/version',
    '/api/agent-mcp/operator-pause-flag',
    '/api/agent-mcp/operator-voice-prefs',
    '/api/agent-mcp/operator-trigger-state',
    '/api/agent-mcp/voice-debug',
    '/api/zero-harness/rest-query?name=toastLog.recent&args=%7B%22limit%22%3A50%7D',
    '/api/harness/projects/lite',
    '/api/profile',
    '/api/auth/me',
    '/api/provision/host-check',
    '/api/runtime-config',
  ];
  const host = process.env.PAPERCUSP_BIND_HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 3055;
  const base = `http://${host}:${port}`;
  const http = await import('node:http');
  const t0 = Date.now();
  // Sequential, not parallel — parallel saturates Turbopack's worker
  // pool and makes every route slow. One-at-a-time finishes in the
  // same total wall-time and keeps a CPU core free for any user
  // request that arrives during pre-warm.
  for (const path of ROUTES) {
    await new Promise<void>((resolve) => {
      const req = http.get(base + path, { headers: { 'x-prewarm': '1' } }, (res) => {
        res.resume();
        res.on('end', () => resolve());
        res.on('error', () => resolve());
      });
      req.on('error', () => resolve());
      req.setTimeout(60_000, () => { req.destroy(); resolve(); });
    });
  }
  console.log(`[prewarm-routes] done in ${Date.now() - t0}ms (${ROUTES.length} routes)`);
}
