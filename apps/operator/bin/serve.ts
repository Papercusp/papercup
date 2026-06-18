/**
 * `papercusp serve` — headless operator boot (SP1 C1 + C3).
 *
 * Plan: operator-core-headless-serve-2026-06-04.
 *
 * This is the standalone, UI-less entry point for the operator core. Unlike
 * `hono-host.ts` (which assumes Postgres is already up and always serves the
 * SPA), `serve.ts` OWNS the whole headless lifecycle:
 *
 *   1. Start embedded Postgres in-process (`startEmbeddedPostgresServer`),
 *      applying migrations via the package's own runner (pass `dbSqlDir`).
 *   2. Resolve the admin URL into `HARNESS_ADMIN_DATABASE_URL` *before* any
 *      operator module reads it (getHarnessAdminUrl caches first-call).
 *   3. Write `~/.papercusp/embedded-pg.json` (the latent-bug fix: nothing
 *      wrote it before — see the plan's "Latent bug" note).
 *   4. `runBootstrap()` (background services) then `serve()` the Hono host
 *      with `PAPERCUSP_SERVE_UI=0` so NO SPA is mounted (Decision E).
 *   5. Write `~/.papercusp/operator.json` ({httpUrl,port,token,pid,...}) —
 *      the discovery file the SP3 plugin's headersHelper will read.
 *
 * Singleton (Decision C): `serve --ensure` reuses a healthy running operator
 * (pid alive + http reachable) and exits 0; otherwise an O_EXCL pidfile lock
 * (`~/.papercusp/operator.lock`) guards the cold-start race. The DB-backed
 * named resource locks can't guard cold start (they need the DB up), hence an
 * OS-level lock here.
 *
 * Run:  tsx apps/operator/bin/serve.ts [--ensure] [--ui]
 *
 * Env knobs (all optional):
 *   PAPERCUSP_HONO_PORT / PORT    HTTP port (default 3070)
 *   PAPERCUSP_BIND_HOST / HOSTNAME bind host (default 127.0.0.1)
 *   PAPERCUSP_PG_PORT             embedded-pg port (default 5532)
 *   PAPERCUSP_PG_DATA_DIR         embedded-pg data dir (default ~/.papercusp/embedded-pg-data)
 *   PAPERCUSP_PG_SQL_DIR          migrations dir (default: repo libs/papercusp/libs/db/sql)
 *   PAPERCUSP_USE_EMBEDDED_PG=0   attach external PG via HARNESS_*_DATABASE_URL instead
 *   PAPERCUSP_SERVE_UI=1          force the SPA on even under serve (default off here)
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm, rename, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const PAPERCUSP_DIR = join(homedir(), '.papercusp');
const OPERATOR_JSON = join(PAPERCUSP_DIR, 'operator.json');
const EMBEDDED_PG_JSON = join(PAPERCUSP_DIR, 'embedded-pg.json');
const SUPERUSER_TOKEN = join(PAPERCUSP_DIR, 'superuser-token');
const LOCK_PATH = join(PAPERCUSP_DIR, 'operator.lock');
const VERSION = process.env.npm_package_version ?? '0.1.0-dev';

export interface OperatorDiscovery {
  /** Base HTTP origin of the operator API, e.g. http://127.0.0.1:3070 */
  httpUrl: string;
  port: number;
  /** Superuser bearer token (from ~/.papercusp/superuser-token), or null. */
  token: string | null;
  pid: number;
  startedAt: number;
  version: string;
}

function log(msg: string): void {
  console.log(`[serve] ${msg}`);
}

/** True if a process with `pid` exists (signal 0 probe). */
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but not ours.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the current operator.json discovery, or null. */
export function readOperatorDiscovery(): OperatorDiscovery | null {
  try {
    const j = JSON.parse(readFileSync(OPERATOR_JSON, 'utf8')) as Partial<OperatorDiscovery>;
    if (typeof j?.httpUrl === 'string' && j.httpUrl && typeof j.pid === 'number') {
      return {
        httpUrl: j.httpUrl,
        port: Number(j.port) || 0,
        token: typeof j.token === 'string' ? j.token : null,
        pid: j.pid,
        startedAt: Number(j.startedAt) || 0,
        version: typeof j.version === 'string' ? j.version : 'unknown',
      };
    }
  } catch {
    /* missing / corrupt */
  }
  return null;
}

/** Best-effort HTTP liveness probe — any response (even 404) means "up". */
async function httpAlive(httpUrl: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(httpUrl + '/api/', { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Read the superuser bearer token if present. */
export function readToken(): string | null {
  try {
    const t = readFileSync(SUPERUSER_TOKEN, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Cold-start singleton guard. Atomically create the lockfile (O_EXCL) with our
 * pid. Returns true if acquired. If a *live* owner holds it, returns false.
 * A stale lock (owner dead) is reclaimed and re-attempted once.
 *
 * Liveness = pid alive AND its cmdline looks like a serve/node process —
 * bare pid-aliveness is defeated by pid reuse, which is near-CERTAIN in a
 * restarted WSL distro (serve gets a single-digit pid; after
 * `wsl --terminate` / host reboot the distro's own init session occupies
 * it, and an unreleased lock then wedges every future boot — found live on
 * Windows 2026-06-11). Same guard sweepOrphanPostgres already uses.
 */
export function acquireColdStartLock(retried = false): boolean {
  try {
    // ~/.papercusp may not exist yet on a fresh machine, and this runs before
    // any other writer mkdir's it — create it owner-only first.
    mkdirSync(PAPERCUSP_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const ownerPid = Number((() => {
      try {
        return readFileSync(LOCK_PATH, 'utf8').trim();
      } catch {
        return '';
      }
    })()) || 0;
    // Our own pid = we already hold it; never reclaim out from under
    // ourselves.
    if (ownerPid === process.pid) return false;
    // Foreign pids must look like serve SPECIFICALLY — a loose pattern
    // (node, or any .papercusp path mention) false-positives on whatever
    // unrelated process reused the pid, e.g. a `cat
    // ~/.papercusp/operator.json` health probe (observed live: the probe's
    // own cmdline contains "papercusp" and occupied the reclaimed pid,
    // wedging boot exactly like the stale lock it was checking for).
    const ownerIsServe =
      pidAlive(ownerPid)
      && /serve\.(mjs|ts)/i.test(processCommandLine(ownerPid) ?? '');
    if (ownerIsServe) return false;
    if (retried) return false;
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* someone else reclaimed */
    }
    return acquireColdStartLock(true);
  }
}

export function releaseColdStartLock(): void {
  try {
    const owner = Number(readFileSync(LOCK_PATH, 'utf8').trim()) || 0;
    if (owner === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
}

/** Default migrations dir: repo `libs/papercusp/libs/db/sql` relative to this file. */
function defaultSqlDir(): string {
  return fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql', import.meta.url));
}

/** The embedded-PG data dir as ensurePostgres resolves it (env or default). */
function resolvedPgDataDir(): string {
  return process.env.PAPERCUSP_PG_DATA_DIR ?? join(PAPERCUSP_DIR, 'embedded-pg-data');
}

/**
 * Synchronously SIGINT the postmaster named in `<dataDir>/postmaster.pid` —
 * PG's "fast shutdown". Used by the signal handler, which cannot rely on
 * surviving past its first await (see the shutdown comment). PG finishes the
 * shutdown on its own and removes postmaster.pid; we don't wait.
 */
export function sigintPostmasterSync(dataDir: string): void {
  try {
    const raw = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8');
    const pid = Number((raw.split('\n')[0] ?? '').trim());
    if (Number.isInteger(pid) && pid > 0) {
      log(`fast-shutdown signal to postmaster pid=${pid}`);
      process.kill(pid, 'SIGINT');
    }
  } catch {
    /* no postmaster.pid / already gone */
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  // ~/.papercusp holds credentials — operator.json carries the superuser bearer
  // token, embedded-pg.json carries a DSN with the PG password (the `url` field
  // can't be redacted; external clients connect with it). Keep the dir + files
  // owner-only (0700/0600) so the secrets aren't world/group-readable.
  await mkdir(PAPERCUSP_DIR, { recursive: true, mode: 0o700 });
  await chmod(PAPERCUSP_DIR, 0o700).catch(() => {}); // tighten even if it pre-existed
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {}); // deterministic even if tmp pre-existed
  // rename is atomic on the same filesystem and preserves the 0600 mode.
  await rename(tmp, path);
}

interface PgHandle {
  port: number;
  urls: { admin: string; app: string; zero: string };
  stop: () => Promise<void>;
}

/** Best-effort command line of a live process, or null. Linux reads
 * /proc/<pid>/cmdline; macOS falls back to `ps`. */
function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    }
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}

/**
 * Sweep an orphaned postgres process holding `dataDir` (left by a prior
 * unclean exit) before we start a fresh one. Ported from the desktop
 * embedder's Rust `sweep_orphan_postgres` (SP1 C5 — PG lifecycle ownership
 * moved here, so the orphan problem moved with it).
 *
 * PG writes its own PID into `<dataDir>/postmaster.pid` on startup and
 * removes it on clean shutdown. If the file exists and the PID is alive AND
 * its command line names postgres + our exact data dir, it's a leftover from
 * a prior session — kill it. If the PID is dead, unlink the stale lockfile so
 * embedded-postgres doesn't reject the dir as already-running.
 *
 * Defensive about misidentifying live processes: only kill when the cmdline
 * has `postgres`/`embedded-pg` in it AND references our data dir. Otherwise
 * leave it alone and let the start surface its own error — better to fail
 * loud than nuke an unrelated process.
 */
export async function sweepOrphanPostgres(
  dataDir: string,
  logFn: (m: string) => void = log,
): Promise<void> {
  const pidFile = join(dataDir, 'postmaster.pid');
  let raw: string;
  try {
    raw = readFileSync(pidFile, 'utf8');
  } catch {
    return; // No lockfile, no orphan to worry about.
  }
  // postmaster.pid format: PID is line 1.
  const pidStr = (raw.split('\n')[0] ?? '').trim();
  const pid = Number(pidStr);
  if (!Number.isInteger(pid) || pid <= 0) {
    logFn(`sweepOrphanPostgres: malformed pid '${pidStr}' in ${pidFile}`);
    return;
  }
  if (!pidAlive(pid)) {
    // Stale lockfile from a crashed prior session — embedded-postgres usually
    // handles this itself, but unlink eagerly to be safe.
    logFn(`sweepOrphanPostgres: stale postmaster.pid (pid=${pid} dead), unlinking`);
    try {
      unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
    return;
  }
  // Live: confirm it's actually a postgres pointed at OUR data dir before
  // terminating.
  const cmdline = processCommandLine(pid) ?? '';
  const isPg = /postgres|embedded-pg/i.test(cmdline);
  if (!isPg || !cmdline.includes(dataDir)) {
    logFn(
      `sweepOrphanPostgres: pid ${pid} is alive but does not look like our postgres ` +
        `(cmdline=${JSON.stringify(cmdline.slice(0, 200))}) — leaving it alone`,
    );
    return;
  }
  logFn(`sweepOrphanPostgres: killing orphaned postgres pid=${pid} holding ${dataDir}`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* raced to death */
  }
  // Up to 5s for a graceful exit, then SIGKILL.
  for (let i = 0; i < 50 && pidAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* raced */
    }
  }
  try {
    unlinkSync(pidFile);
  } catch {
    /* postgres removed it on clean exit */
  }
}

/** Start (or attach to) Postgres and ensure HARNESS_ADMIN_DATABASE_URL is set. */
async function ensurePostgres(): Promise<PgHandle | null> {
  if (process.env.PAPERCUSP_USE_EMBEDDED_PG === '0') {
    const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
    if (!admin) {
      throw new Error(
        'PAPERCUSP_USE_EMBEDDED_PG=0 requires HARNESS_ADMIN_DATABASE_URL (and HARNESS_DATABASE_URL) to be set.',
      );
    }
    log(`attaching to external Postgres via HARNESS_ADMIN_DATABASE_URL`);
    return null; // external PG; nothing for us to manage/stop
  }

  const { startEmbeddedPostgresServer } = await import(
    '@papercusp/embedded-postgres-server'
  );
  const port = Number(process.env.PAPERCUSP_PG_PORT ?? 5532);
  const dataDir =
    process.env.PAPERCUSP_PG_DATA_DIR ?? join(PAPERCUSP_DIR, 'embedded-pg-data');
  const dbSqlDir = process.env.PAPERCUSP_PG_SQL_DIR ?? defaultSqlDir();

  log(`starting embedded Postgres on :${port} (data=${dataDir})`);
  if (!existsSync(dbSqlDir)) log(`warning: migrations dir not found at ${dbSqlDir}`);

  // Kill/clear any orphaned postgres from a prior unclean exit before the
  // fresh start — otherwise the spawn fails with "lock file already exists"
  // or silently serves stale data on another port.
  await sweepOrphanPostgres(dataDir);

  // Autoadjust the embedded PG to the host: derive server knobs (max_connections,
  // shared_buffers, parallelism, work_mem, …) from detected cores/RAM and pass
  // them as `-c` flags. embeddedPg:true — the DB shares this box with the operator
  // + agents, so it takes a gentler RAM slice (see deriveDatabaseTuning). Without
  // this the desktop's embedded PG runs on laptop-sized stock defaults
  // (max_connections=100 / shared_buffers=128MB), which a busy fleet exhausts.
  const { deriveDatabaseTuning, databaseTuningToSettings, detectResourceSignals } =
    await import('@papercusp/resource-profile');
  const extraPostgresSettings = databaseTuningToSettings(
    deriveDatabaseTuning(detectResourceSignals({ embeddedPg: true })),
  );
  log(
    `embedded PG host-tuning: max_connections=${extraPostgresSettings.max_connections}, ` +
      `shared_buffers=${extraPostgresSettings.shared_buffers}, ` +
      `effective_cache_size=${extraPostgresSettings.effective_cache_size}`,
  );

  const pg = (await startEmbeddedPostgresServer({
    port,
    dataDir,
    dbSqlDir: existsSync(dbSqlDir) ? dbSqlDir : undefined,
    extraPostgresSettings,
    onLog: (m: string) => log(`pg: ${m}`),
  })) as PgHandle;

  // Make the admin URL the #1 resolution source BEFORE any operator module
  // calls getHarnessAdminUrl() (it caches the first result).
  process.env.HARNESS_ADMIN_DATABASE_URL = pg.urls.admin;
  if (!process.env.HARNESS_DATABASE_URL) {
    process.env.HARNESS_DATABASE_URL = pg.urls.app;
  }
  // Stamp the env to match REALITY for env-keyed consumers. Embedded is
  // serve's default, so the desktop launcher often doesn't set the flag —
  // but setup-status's probePostgres branches on PAPERCUSP_USE_EMBEDDED_PG
  // === '1' and otherwise probes native :5432, painting the wizard's
  // database step red while embedded PG is healthy (found live on Windows
  // 2026-06-11). PG_PORT likewise: the launcher's value is a HINT; record
  // the port actually bound.
  process.env.PAPERCUSP_USE_EMBEDDED_PG = '1';
  process.env.PAPERCUSP_PG_PORT = String(pg.port);

  // Write the embedded-pg discovery file (the latent-bug fix). The generic
  // resolver reads the `url` field; extra fields are diagnostics.
  await writeJsonAtomic(EMBEDDED_PG_JSON, {
    url: pg.urls.admin,
    port: pg.port,
    pid: process.pid,
    startedAt: Date.now(),
  });
  log(`wrote ${EMBEDDED_PG_JSON}`);
  return pg;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const ensure = args.has('--ensure');
  // Headless by default; --ui (or a pre-set PAPERCUSP_SERVE_UI) keeps the SPA.
  if (!args.has('--ui') && process.env.PAPERCUSP_SERVE_UI == null) {
    process.env.PAPERCUSP_SERVE_UI = '0';
  }

  // Windows/WSL boundary: the desktop used to forward the WINDOWS PATH via
  // WSLENV `PATH/l`, which REPLACED the distro PATH here — /usr/bin et al
  // vanished and every distro-binary spawn (kopia, locale, git) died ENOENT
  // (found live 2026-06-11, P-010a @ windows-desktop-release-readiness).
  // The launcher now sends only the bundled bin dir (PAPERCUSP_SIDECAR_BIN,
  // WSLENV /p-translated); compose the real PATH ourselves: bundled bin
  // first, then the session PATH, with the standard system dirs guaranteed.
  if (process.platform !== 'win32' && process.env.PAPERCUSP_SIDECAR_BIN) {
    const systemDirs = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const merged = [process.env.PAPERCUSP_SIDECAR_BIN, process.env.PATH ?? '', systemDirs]
      .flatMap((p) => p.split(':'))
      .filter(Boolean);
    process.env.PATH = [...new Set(merged)].join(':');
  }

  const port = Number(process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? 3070);
  const hostname =
    process.env.PAPERCUSP_BIND_HOST ?? process.env.HOSTNAME ?? '127.0.0.1';
  const httpUrl = `http://${hostname}:${port}`;

  // --ensure: reuse a healthy running operator and exit 0.
  if (ensure) {
    const existing = readOperatorDiscovery();
    if (existing && pidAlive(existing.pid) && (await httpAlive(existing.httpUrl))) {
      log(`already running (pid ${existing.pid}) at ${existing.httpUrl} — reusing`);
      process.stdout.write(JSON.stringify(existing) + '\n');
      return;
    }
  }

  // Cold-start race guard.
  if (!acquireColdStartLock()) {
    if (ensure) {
      // Another serve is starting — poll briefly for its operator.json.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const d = readOperatorDiscovery();
        if (d && pidAlive(d.pid) && (await httpAlive(d.httpUrl))) {
          log(`another serve won the race (pid ${d.pid}) — reusing`);
          process.stdout.write(JSON.stringify(d) + '\n');
          return;
        }
      }
    }
    throw new Error('another `serve` holds the cold-start lock; aborting');
  }

  let pg: PgHandle | null = null;
  let server: { close?: () => void } | null = null;
  let shuttingDown = false;

  // ⚠ The critical cleanup below is SYNCHRONOUS by design. The async
  // version of this handler was observed (2026-06-06, bundled serve.mjs)
  // dying mid-shutdown: operator.json got removed but the process never
  // came back from `await pg.stop()` — the cold-start lock stayed held and
  // in one variant the postmaster was orphaned. The host graph bundles
  // signal-exit (via execa et al.), whose re-raise can kill the process at
  // the first yield; pg_ctl can also stall on an already-dying PG. Rather
  // than depend on surviving any await: remove the discovery file, release
  // the lock, and fast-shutdown the postmaster (SIGINT) all synchronously,
  // then attempt the graceful async stop as best-effort.
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} — shutting down`);
    try {
      server?.close?.();
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(OPERATOR_JSON);
    } catch {
      /* already gone */
    }
    if (pg) sigintPostmasterSync(resolvedPgDataDir());
    releaseColdStartLock();
    // Best-effort graceful wait — a competing handler may kill us before
    // this completes; the sync work above already covered the essentials.
    void (async () => {
      if (pg) await pg.stop().catch(() => {});
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    pg = await ensurePostgres();
    // Explicit readiness marker. The desktop smoke harness
    // (papercusp-desktop/bin/lib/federation-asserts.sh fed_wait_boot) greps
    // 'ready on localhost:<port> db=papercusp' to learn the PG port — the
    // standalone embedded-postgres-server bin used to print it; in-process
    // ownership (SP1 C5) moved the line here.
    if (pg) log(`embedded Postgres ready on localhost:${pg.port} db=papercusp`);

    // Import AFTER env is set: host-handler builds the Hono app at module load
    // (reading PAPERCUSP_SERVE_UI), and bootstrap/handler resolve the admin URL.
    const { runBootstrap } = await import('./host-bootstrap');
    const { handler } = await import('./host-handler');
    const { serve } = await import('@hono/node-server');

    process.env.PORT = String(port); // selfUrl() origin (mirrors hono-host.ts)
    runBootstrap();

    server = serve({ fetch: handler, port, hostname }, async (info) => {
      log(`listening on http://${hostname}:${info.port} (UI ${process.env.PAPERCUSP_SERVE_UI === '0' ? 'OFF' : 'ON'})`);
      const discovery: OperatorDiscovery = {
        httpUrl,
        port: info.port,
        token: readToken(),
        pid: process.pid,
        startedAt: Date.now(),
        version: VERSION,
      };
      await writeJsonAtomic(OPERATOR_JSON, discovery);
      log(`wrote ${OPERATOR_JSON}`);
    }) as unknown as { close?: () => void };
  } catch (e) {
    releaseColdStartLock();
    if (pg) await pg.stop().catch(() => {});
    throw e;
  }
}

// Only auto-run when executed directly (so tests / other modules can import
// the helpers without booting a server).
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('[serve] fatal:', e);
    process.exit(1);
  });
}
