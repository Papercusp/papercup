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
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm, rename, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ensureToolPathEnv } from '@papercusp/operator-core/lib/tool-path';
import { runShutdownWithDeadline } from '../lib/shutdown-deadline';
import { runSubstrateSidecarServer } from '@papercusp/operator-core/lib/sync/hyperbee/substrate-sidecar-server';
import { runSpawnerSidecarServer } from '@papercusp/operator-core/lib/fleet/spawner-sidecar-server';
import { runGatewaySidecarMain, gatewayLogLine } from '@papercusp/operator-core/lib/inference-gateway/sidecar-main';
import { getBuildInfo } from '@papercusp/operator-core/lib/build-info';

const PAPERCUSP_DIR = join(homedir(), '.papercusp');
const OPERATOR_JSON = join(PAPERCUSP_DIR, 'operator.json');
const EMBEDDED_PG_JSON = join(PAPERCUSP_DIR, 'embedded-pg.json');
const SUPERUSER_TOKEN = join(PAPERCUSP_DIR, 'superuser-token');
// WI-3287: a packaged env-sidecar sibling (env-operator-launcher.ts's bundled
// spawn — prod/staging running request-only alongside the primary, EI-126)
// re-execs THIS SAME serve.mjs under the SAME $HOME, identified by
// PAPERCUSP_ENV_OPERATOR_ID. Without scoping the lock file by that id, the
// sibling's acquireColdStartLock() call collides with the primary's — which
// holds `operator.lock` for its ENTIRE lifetime (only released on shutdown,
// never after a successful boot) — so every env-sidecar boot would
// permanently fail with "another `serve` holds the cold-start lock" the
// moment the primary is up (found live on the first real packaged-Linux
// env-switcher verify, 2026-07-07 — the switcher's staging button never
// lit because of this). Scoping by id gives each sibling (and the primary)
// its own lock, so they can legitimately cold-start concurrently.
const ENV_OPERATOR_ID = process.env.PAPERCUSP_ENV_OPERATOR_ID || null;
/** Pure — exported so the scoping rule is unit-testable without a full module
 *  re-import (serve.ts has non-idempotent module-load side effects — DBOS
 *  workflow registration — that a `vi.resetModules()` re-import re-triggers). */
export function lockFileNameForEnvId(envOperatorId: string | null): string {
  return envOperatorId ? `operator.lock.env-${envOperatorId}` : 'operator.lock';
}
const LOCK_PATH = join(PAPERCUSP_DIR, lockFileNameForEnvId(ENV_OPERATOR_ID));
// WI-2644: was `process.env.npm_package_version ?? '0.1.0-dev'` — npm never
// invokes the bundled sidecar, so this was ALWAYS the '0.1.0-dev' fallback on
// every packaged desktop build. build-info.ts already resolves the correct
// version (preferring PAPERCUSP_BUILD_VERSION, baked at compile time in
// main.rs and forwarded to the sidecar's env — see build-info.ts's docblock);
// reuse that single resolver instead of a second, divergent version read.
const VERSION = getBuildInfo().version;

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

// ── Sticky operator port (stale-port-pin class fix, 2026-07-07) ─────────────
// The packaged desktop launcher (main.rs spawn_serve) hands us a FRESH
// portpicker-picked port on every boot, so every app restart used to move the
// operator's address — and every long-lived URL pin (tutorial-runner's
// --operator-url, dock CLIs, spawned members' MCP configs) died with it
// ("can't reach the Papercusp server", dead member MCP — owner-reported).
// Remembering the last successfully-bound port and re-binding it when free
// keeps the address stable across restarts; pinned clients then ride through a
// restart on their normal connection retry (operator-discovery.mjs
// fetchResilient) instead of pointing at a dead port forever.
const OPERATOR_PORT_MEMORY = join(PAPERCUSP_DIR, 'operator-port.json');

/** Last successfully-bound HTTP port, or null. Unlike operator.json (unlinked
 *  on every shutdown), operator-port.json survives — it is the memory that
 *  makes the port sticky. */
export function readRememberedPort(): number | null {
  try {
    const j = JSON.parse(readFileSync(OPERATOR_PORT_MEMORY, 'utf8')) as { port?: unknown };
    const p = Number(j?.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch {
    /* missing / corrupt → no memory */
  }
  return null;
}

/** True when `port` can be bound on `host` right now (probe bind + close). */
export function portAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * The port to bind: on the packaged desktop (PAPERCUSP_DESKTOP=1, the one
 * environment whose launcher hint is a fresh random port each boot), prefer
 * the remembered port when it is still free; everywhere else — dev box,
 * tests, anyone pinning PAPERCUSP_HONO_PORT deliberately — the hint stands.
 */
export async function resolveStickyPort(
  hinted: number,
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (env.PAPERCUSP_DESKTOP !== '1') return hinted;
  const remembered = readRememberedPort();
  if (!remembered || remembered === hinted) return hinted;
  if (!(await portAvailable(remembered, hostname))) {
    log(`remembered operator port ${remembered} is taken — using launcher hint ${hinted}`);
    return hinted;
  }
  log(
    `re-binding remembered operator port ${remembered} (launcher hint ${hinted}) — pinned client URLs stay valid across restarts`,
  );
  return remembered;
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
 * True if something is accepting TCP connections on 127.0.0.1:`port` within
 * `timeoutMs`. Used by the orphan sweep as GROUND TRUTH for "is a postgres
 * actually up on the recorded port?" — more reliable than a pid/cmdline match
 * inside the WSL distro, where low pids get recycled fast (a dead postgres's
 * pid can already belong to an unrelated live process) and `/proc/<pid>/cmdline`
 * can read empty under load. Never throws.
 */
export async function isPortAccepting(port: number, timeoutMs = 750): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0) return false;
  return new Promise<boolean>((resolve) => {
    const sock = netConnect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
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
    // The pid is alive but does NOT look like our postgres. Two cases, and BOTH
    // mean the postmaster that wrote this lockfile is gone: (a) postgres died
    // and the WSL2 distro recycled its (low) pid to an unrelated process, or
    // (b) `/proc/<pid>/cmdline` read empty under load. Either way, leaving the
    // stale postmaster.pid in place is NOT harmless: embedded-postgres' next
    // `pg.start()` FATALs on "lock file already exists", which crash-loops the
    // operator and — on Windows — the respawn storm wedges the whole WSL distro
    // until a manual `wsl --terminate` (VM-observed 2026-07-08, WI-3360). So
    // clear the stale lockfile — but ONLY after confirming, via GROUND TRUTH,
    // that no postgres is actually accepting on the recorded port. If something
    // IS listening, a real server holds the dir (or a genuine port clash) and
    // we must NOT unlink; surface it by leaving the start to fail loudly.
    const recordedPort = Number((raw.split('\n')[3] ?? '').trim()) || 0;
    if (recordedPort > 0 && (await isPortAccepting(recordedPort))) {
      logFn(
        `sweepOrphanPostgres: pid ${pid} is alive but not our postgres, yet :${recordedPort} ` +
          `is accepting — a live server holds ${dataDir}; leaving it alone ` +
          `(cmdline=${JSON.stringify(cmdline.slice(0, 200))})`,
      );
      return;
    }
    logFn(
      `sweepOrphanPostgres: pid ${pid} alive but not our postgres and :${recordedPort || '?'} ` +
        `not accepting — stale postmaster.pid (postgres dead, pid reused); unlinking ${pidFile}`,
    );
    try {
      unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
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
  // Pre-migrated PGDATA seed (first-boot fast path). When present + the data dir
  // is fresh, embedded-postgres-server extracts it instead of running initdb +
  // the full migration replay (~11s → ~1s). Absent/unset ⇒ normal initdb path.
  const seedPath = process.env.PAPERCUSP_PG_SEED_PATH;

  log(`starting embedded Postgres on :${port} (data=${dataDir})`);
  if (!existsSync(dbSqlDir)) log(`warning: migrations dir not found at ${dbSqlDir}`);
  if (seedPath && existsSync(seedPath)) log(`pre-migrated seed available at ${seedPath} (used only on a fresh data dir)`);

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
    seedPath: seedPath && existsSync(seedPath) ? seedPath : undefined,
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
  // PACKAGED substrate-sidecar (P-006): the spawner re-execs THIS bundled
  // serve.mjs with PAPERCUSP_SUBSTRATE_SIDECAR_MODE=1 instead of `npx tsx`-ing a
  // .ts the bundle doesn't contain. Divert to the sidecar JSON-RPC server BEFORE
  // any embedded-PG / operator boot; the net server keeps the process alive.
  if (process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MODE === '1') {
    runSubstrateSidecarServer();
    return;
  }
  // PACKAGED spawner-sidecar (WI-344 ③): same re-exec divert for the agent-spawn
  // sidecar — serve.mjs is re-execed with PAPERCUSP_SPAWNER_SIDECAR_MODE=1.
  if (process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE === '1') {
    runSpawnerSidecarServer();
    return;
  }
  // PACKAGED inference-gateway sidecar (cross-platform-hardening P-006): same
  // re-exec divert — gateway-sidecar-spawn.ts re-execs THIS bundled serve.mjs
  // with PAPERCUSP_GATEWAY_SIDECAR_MODE=1 (a bundle has no tsx / no bin.ts on
  // disk). Mirror bin.ts's fatal policy: a startup failure exits 1 so the
  // supervisor's respawn loop restarts us, fail-closed. The gateway's HTTP
  // server keeps the process alive after a successful start.
  if (process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE === '1') {
    runGatewaySidecarMain().catch((e) => {
      try {
        gatewayLogLine(`fatal: ${(e as Error)?.stack || String(e)}`);
      } catch {
        console.error('[inference-gateway] fatal:', e);
      }
      process.exit(1);
    });
    return;
  }
  const args = new Set(process.argv.slice(2));
  const ensure = args.has('--ensure');
  // Headless by default; --ui (or a pre-set PAPERCUSP_SERVE_UI) keeps the SPA.
  if (!args.has('--ui') && process.env.PAPERCUSP_SERVE_UI == null) {
    process.env.PAPERCUSP_SERVE_UI = '0';
  }

  // Guarantee the user's CLI tools (git, gh credential-helper, kopia, …) are on
  // PATH for everything this operator spawns. TWO failure modes this fixes:
  //  - Windows/WSL: the launcher forwards only the bundled bin dir
  //    (PAPERCUSP_SIDECAR_BIN); /usr/bin et al must be re-added or distro-binary
  //    spawns die ENOENT (found 2026-06-11, windows-desktop-release-readiness).
  //  - macOS: a packaged app's launchd PATH is minimal (/usr/bin:/bin:…) and
  //    OMITS /opt/homebrew/bin (Apple-Silicon Homebrew) — so the dogfood
  //    `git clone` couldn't find gh/git → "workspace setup failed" (found
  //    2026-06-25 via an owner Mac-VM setup failure). ensureToolPathEnv()
  //    sources the ONE canonical dir list (tool-path.ts) incl. /opt/homebrew,
  //    so detection (preflight/agent-auth-detect) and execution never drift.
  // Runs on darwin even without PAPERCUSP_SIDECAR_BIN (a GUI-launched sidecar
  // still has the minimal launchd PATH); on Linux we keep prior behavior (only
  // recompose when the launcher trimmed PATH via PAPERCUSP_SIDECAR_BIN).
  if (process.platform !== 'win32' && (process.env.PAPERCUSP_SIDECAR_BIN || process.platform === 'darwin')) {
    ensureToolPathEnv();
  }

  const hostname =
    process.env.PAPERCUSP_BIND_HOST ?? process.env.HOSTNAME ?? '127.0.0.1';
  const honoPortHint = Number(process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? 3070);
  // WI-3287: an env-sidecar sibling has a FIXED, well-known port per the
  // env-switcher contract (env-operator-launcher.ts's PROVISIONABLE_ENV_OPERATORS)
  // — it must never wander onto the PRIMARY's remembered sticky port (which
  // operator-port.json records for the primary alone; siblings must not read
  // OR write it — see the OPERATOR_JSON/OPERATOR_PORT_MEMORY guard below).
  const port = ENV_OPERATOR_ID ? honoPortHint : await resolveStickyPort(honoPortHint, hostname);
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
    // WI-2667: a hung graceful stop must NEVER leave this process alive. On
    // 2026-07-04 (packaged Mac dogfood) SIGTERM ran this handler — the sync
    // cleanup below stopped PG, but the async `await pg.stop()` never resolved
    // (pg_ctl stalled on the already-dying postmaster), so `process.exit(0)`
    // never ran. The operator stayed alive ~1h45m with PG down and every
    // background loop (DBOS executor, append-heavy invalidator, watchdogs)
    // flailing against a dead DB — an endless error storm — AND, because the
    // process never exited, launchd KeepAlive never respawned it, so PG never
    // came back. A ref'd hard deadline guarantees exit regardless of any
    // stalled await, which also restores crash-recovery (exit → launchd
    // respawn → fresh boot brings PG back up). The orchestration is extracted
    // into runShutdownWithDeadline so the HANG path has a unit recurrence guard
    // (shutdown-deadline.test.ts) — see shutdown-deadline.ts.
    runShutdownWithDeadline({
      deadlineMs: 4000,
      onForceExit: () => log(`${sig} — shutdown deadline exceeded; force-exiting`),
      syncCleanup: () => {
        try {
          server?.close?.();
        } catch {
          /* ignore */
        }
        // WI-3287: never unlink the PRIMARY's discovery file from a sibling shutdown.
        if (!ENV_OPERATOR_ID) {
          try {
            unlinkSync(OPERATOR_JSON);
          } catch {
            /* already gone */
          }
        }
        if (pg) sigintPostmasterSync(resolvedPgDataDir());
        releaseColdStartLock();
      },
      // Best-effort graceful wait — a competing handler may kill us before this
      // completes; the sync work above already covered the essentials.
      gracefulStop: async () => {
        if (pg) await pg.stop().catch(() => {});
      },
      exit: (code) => process.exit(code),
    });
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
      // WI-3287: OPERATOR_JSON/OPERATOR_PORT_MEMORY are THE PRIMARY's discovery
      // records — Tauri's `--ensure` reuse check, the sticky-port memory, and
      // every external `--operator-url` consumer key off this ONE fixed path.
      // An env-sidecar sibling (ENV_OPERATOR_ID set) must never write it: it
      // would clobber the primary's own discovery with itself, breaking every
      // future `--ensure` / reconnect. Siblings are reached by direct port
      // navigation (the env switcher), not through this file.
      if (!ENV_OPERATOR_ID) {
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
        try {
          // Port memory for the next boot (sticky port — see resolveStickyPort).
          // Optional state: a failed write must never affect the running boot.
          await writeJsonAtomic(OPERATOR_PORT_MEMORY, { port: info.port, updatedAt: Date.now() });
        } catch (e) {
          log(`could not persist port memory (${(e as Error).message}) — next restart re-picks`);
        }
      }
    }) as unknown as { close?: () => void };
  } catch (e) {
    releaseColdStartLock();
    if (pg) await pg.stop().catch(() => {});
    throw e;
  }
}

// Only auto-run when executed directly (so tests / other modules can import
// the helpers without booting a server). Symlink-robust (WI-1443): node
// realpaths import.meta.url while argv[1] keeps the invoked path (papercup ->
// papercusp), so also compare the realpath'd form.
const invokedDirectly = ((): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    // EI-7099: a raw `console.error('[serve] fatal:', e)` printed a bare
    // "undefined" during a real restart-race failure (embedded-PG rejecting
    // startup with "pre-existing shared memory block still in use") — some
    // upstream rejection in the embedded-pg boot chain loses the Error object
    // (a non-Error rejection reason, or a rejection with none at all), so the
    // one-liner carried zero diagnostic value and the run sat wedged
    // undiagnosable. Make this LAST-LINE-OF-DEFENSE handler informative
    // regardless of what shape `e` arrives in, instead of chasing every
    // possible upstream swallow point.
    const detail =
      e instanceof Error
        ? (e.stack ?? e.message)
        : e === undefined
          ? '(no error object — an upstream rejection carried no reason; check the PG boot log, e.g. the embedded-pg data dir\'s log file or serve.log tail, for the actual FATAL)'
          : (() => {
              try {
                return JSON.stringify(e);
              } catch {
                return String(e);
              }
            })();
    console.error('[serve] fatal:', detail);
    process.exit(1);
  });
}
