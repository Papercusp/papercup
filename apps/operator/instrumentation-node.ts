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

  // Pty WS server: only when not opt-out and not running under Tauri.
  // Both early-exits below ONLY skip pty-ws — they fall through to the
  // schema pre-warm so desktop and PTY-disabled environments still get
  // the boot-time DDL warming.
  await maybeStartPtyWsServer();

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

  // Pre-warm lazy schema-ensure tables so the first user request doesn't
  // pay for DDL + the first PG connection (~1.1s on a cold pool).
  // Diagnostic 2026-05-06: desktop's first /api/user-actions/<slug> hit
  // was 2.3s steady because the route's ensureUserActionsTable() ran
  // inline. Pre-warming overlaps with the rest of the boot sequence —
  // ensure-schema's `flags.*` (pinned to globalThis) make subsequent
  // calls no-ops across bundles. Don't await this — let it run
  // alongside the rest of boot. Failures (e.g. PG not yet reachable on
  // a desktop sidecar that starts before PG is ready) are non-fatal:
  // the lazy path will retry on first request and surface the real
  // error there.
  void prewarmSchema().catch((err) => {
    console.warn('[ensure-schema-prewarm] non-fatal failure:', err?.message ?? err);
  });

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
  try {
    const { startBackupScheduler } = await import('@/lib/backup');
    startBackupScheduler();
  } catch (err) {
    console.warn('[backup-scheduler] failed to start:', err instanceof Error ? err.message : err);
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

async function prewarmSchema(): Promise<void> {
  const t0 = Date.now();
  const { getOrgPg } = await import('@restart/db-org');
  // First touch establishes the PG pool; subsequent ensure calls reuse it.
  try {
    const { sql } = getOrgPg();
    await sql`SELECT 1`;
  } catch (err: unknown) {
    // PG not ready yet (desktop sidecar vs embedded-pg startup race).
    // Skip pre-warm; the lazy ensure path will run on first request and
    // surface the real error. Log so we can see when the race fires.
    const msg = (err as { message?: string })?.message ?? String(err);
    console.warn(
      `[ensure-schema-prewarm] PG SELECT 1 failed (${msg}) — skipping pre-warm; lazy ensure will run on first request`,
    );
    return;
  }
  console.log('[ensure-schema-prewarm] starting');
  const ensure = await import('./lib/ensure-schema');
  // Run pre-warms SEQUENTIALLY. The admin PG pool maxes at 4 connections
  // (per memory feedback_pg_pool_idle_timeout); 9 parallel ensures
  // saturate it and any user request that arrives during boot queues
  // behind the ensure work. Diagnostic 2026-05-06: parallel pre-warm
  // *regressed* /api/user-actions cold from 2.3s to 6.7s.
  // Each ensure is idempotent (CREATE TABLE IF NOT EXISTS + ALTERs); run
  // them one at a time with .catch so a single failure doesn't abort
  // the rest. Total wall-time on a fresh data dir is ~1-2s, and runs
  // without blocking incoming HTTP because we don't await prewarmSchema
  // from register().
  const fns: Array<[string, () => Promise<void>]> = [
    ['userActions', ensure.ensureUserActionsTable],
    ['toastLog', ensure.ensureToastLogTable],
    ['snapshotFeatures', ensure.ensureSnapshotFeaturesTable],
    ['operatorScans', ensure.ensureOperatorScansTable],
    ['harnessSummaries', ensure.ensureHarnessSummariesTable],
    ['pendingReviews', ensure.ensurePendingReviewsTable],
    ['harnessProposalsShared', ensure.ensureHarnessProposalsSharedTable],
    ['harnessStatus', ensure.ensureHarnessStatusTable],
    ['harnessLanes', ensure.ensureHarnessLanesTable],
    ['backup', ensure.ensureBackupTables],
  ];
  for (const [name, fn] of fns) {
    try {
      await fn();
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.warn(`[ensure-schema-prewarm] ${name} failed: ${msg}`);
    }
  }
  console.log(`[ensure-schema-prewarm] done in ${Date.now() - t0}ms`);
}

let _voicePrefsMigrateRan = false;
async function migrateVoicePrefsDefaults(): Promise<void> {
  if (_voicePrefsMigrateRan) return;
  _voicePrefsMigrateRan = true;
  const { getOrgPg } = await import('@restart/db-org');
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
