/**
 * Disk consumer census — the I/O half (disk-headroom-standing-reclaim-2026-10-12
 * P-001, R-1; WI-6554700010008933). The pure attribution + 24h growth join live in
 * ./usage.ts.
 *
 * One pass, per watched device (the disk-space alarm's `watchedPaths()`, grouped by
 * st_dev and resolved to the mount that shows the whole filesystem):
 *   1. statfs → size / used / avail.
 *   2. `du -x -0 -B1 --max-depth=6 <mount>` at low priority (best-effort I/O level 7,
 *      nice 19 — not the idle I/O class, which mq-deadline starves; see usage.ts), streamed into
 *      the consumer tree (every directory ≥ 1 GiB down to depth 6, plus the large
 *      files inside any directory whose own files reach 1 GiB).
 *      The walk runs as root through `sudo -n` when that works non-interactively
 *      (resolveCensusSudo, probed once per pass), so root-owned trees are measured
 *      rather than lost to "Permission denied"; otherwise it walks unprivileged and
 *      the run note says so.
 *   3. On an unprivileged walk, stores the operator user cannot read are sized through
 *      their own APIs instead of being lost: the Postgres cluster (pg_database_size +
 *      WAL) and Docker (Engine API /system/df). They are added only when du could not
 *      read their root, so nothing is counted twice.
 *   4. used − attributed = the device's `(unattributed)` row. At or above 10 GiB the
 *      read flags a coverage gap: a consumer that large could be missing (R-1 falsifier).
 *   5. One disk_census_runs row + its disk_census_consumers rows, in one transaction.
 * Then rows older than 30 days are pruned.
 *
 * Linux-only (GNU du flags, /proc/self/mountinfo); other platforms skip with a reason.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fsp, statfs as statfsCb } from 'node:fs';
import { request } from 'node:http';
import { hostname } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { watchedPaths } from './disk-space-alarm';
import {
  attributeOwnFiles,
  CENSUS_COVERAGE_GAP_BYTES,
  CENSUS_FLOOR_BYTES,
  CENSUS_MAX_DEPTH,
  censusDepth,
  censusDuCommand,
  deviceMountRoot,
  devToMajorMinor,
  DuTreeAccumulator,
  joinCensusGrowth,
  parseMountInfo,
  sortCensusRows,
  type CensusConsumer,
  type CensusConsumerKind,
  type CensusGrowthRow,
  type DuTreeSummary,
} from './usage';

const statfs = promisify(statfsCb);

export const CENSUS_RETENTION_DAYS = 30;
/** Hard cap on one device's du walk. A killed walk still writes a run, marked incomplete. */
export const CENSUS_DU_TIMEOUT_MS = 90 * 60 * 1000;
/** A device whose latest run is older than this is reported stale (R-1 falsifier). */
export const CENSUS_STALE_MS = 24 * 60 * 60 * 1000;

/** The minimal postgres.js surface the census uses — injectable for tests. */
export interface CensusSql {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  begin<T>(fn: (tx: CensusSql) => Promise<T>): Promise<T>;
}

export interface CensusDevice {
  /** Mount point that shows the whole filesystem. */
  device: string;
  majorMinor: string;
  sizeBytes: number;
  usedBytes: number;
  availBytes: number;
}

async function readMountInfo(): Promise<string> {
  try {
    return await fsp.readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    return '';
  }
}

/** Walk up from `path` to the highest ancestor still on the same device. */
async function walkUpMountPoint(path: string, dev: number): Promise<string> {
  let cur = path;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    try {
      if ((await fsp.stat(parent)).dev !== dev) return cur;
    } catch {
      return cur;
    }
    cur = parent;
  }
}

/** The watched devices (one per st_dev) with their whole-filesystem mount root and statfs numbers. */
export async function resolveCensusDevices(paths: readonly string[] = watchedPaths()): Promise<CensusDevice[]> {
  const mounts = parseMountInfo(await readMountInfo());
  const out: CensusDevice[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    let dev: number;
    try {
      dev = (await fsp.stat(path)).dev;
    } catch {
      continue;
    }
    const majorMinor = devToMajorMinor(dev);
    if (seen.has(majorMinor)) continue;
    seen.add(majorMinor);
    const device = deviceMountRoot(mounts, majorMinor) ?? (await walkUpMountPoint(path, dev));
    try {
      out.push({ device, majorMinor, ...(await statCensusDevice(device)) });
    } catch {
      continue;
    }
  }
  return out;
}

export type CensusDeviceUsage = Pick<CensusDevice, 'sizeBytes' | 'usedBytes' | 'availBytes'>;

/** statfs numbers for one mount root (throws when the mount is unreadable). */
export async function statCensusDevice(mountRoot: string): Promise<CensusDeviceUsage> {
  const st = await statfs(mountRoot);
  const bsize = Number(st.bsize) || 0;
  return {
    sizeBytes: Number(st.blocks) * bsize,
    usedBytes: (Number(st.blocks) - Number(st.bfree)) * bsize,
    availBytes: Number(st.bavail) * bsize,
  };
}

/** Used bytes that moved by at least this much during a walk get a run note. */
export const CENSUS_USAGE_DRIFT_NOTE_BYTES = 1024 ** 3;

/**
 * The device numbers to reconcile a walk against. `du` reads the tree over minutes while
 * the filesystem keeps changing, so `used` is taken as the midpoint of the statfs samples
 * just before and just after the walk; size and avail come from the latest sample. With
 * no sample, the resolved numbers stand.
 */
export function reconcileWalkUsage(
  resolved: CensusDevice,
  before: CensusDeviceUsage | null,
  after: CensusDeviceUsage | null,
): { device: CensusDevice; note: string | null } {
  const latest = after ?? before;
  if (!latest) return { device: resolved, note: null };
  const usedBytes = before && after ? Math.round((before.usedBytes + after.usedBytes) / 2) : latest.usedBytes;
  const device = { ...resolved, sizeBytes: latest.sizeBytes, availBytes: latest.availBytes, usedBytes };
  const drift = before && after ? after.usedBytes - before.usedBytes : 0;
  const note =
    Math.abs(drift) >= CENSUS_USAGE_DRIFT_NOTE_BYTES
      ? `used moved ${drift > 0 ? '+' : '-'}${(Math.abs(drift) / 1024 ** 3).toFixed(1)} GiB during the walk; reconciled against the midpoint`
      : null;
  return { device, note };
}

/** Bound on the one `sudo -n true` probe per census pass. */
export const CENSUS_SUDO_PROBE_TIMEOUT_MS = 5_000;

/**
 * The sudo binary to run the census du through, or null to walk as the current user.
 * Null when already root (nothing to elevate), when sudo is not installed, or when it
 * cannot run non-interactively (no NOPASSWD rule, or a NoNewPrivileges sandbox) — the
 * census then still runs and its `unreadable path(s)` note + coverage gap say what it missed.
 */
export async function resolveCensusSudo(
  probe: (bin: string) => Promise<boolean> = probeSudo,
): Promise<string | null> {
  if (process.getuid?.() === 0) return null;
  const bin = await resolveBin('sudo');
  if (!bin) return null;
  return (await probe(bin)) ? bin : null;
}

function probeSudo(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-n', 'true'], { timeout: CENSUS_SUDO_PROBE_TIMEOUT_MS }, (err) => resolve(!err));
  });
}

async function resolveBin(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const candidate = join(dir, name);
    try {
      await fsp.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export interface DuRun {
  summary: DuTreeSummary;
  deniedCount: number;
  deniedSample: string[];
  timedOut: boolean;
  exitCode: number | null;
  error?: string;
  /** The walk ran as root (via sudo, or the process is root): every store root was readable to du. */
  privileged?: boolean;
}

/** Run du over one mount at low priority and stream it into a consumer tree. */
export async function runDuTree(
  root: string,
  opts: { floorBytes?: number; maxDepth?: number; timeoutMs?: number; sudo?: string | null } = {},
): Promise<DuRun> {
  const floorBytes = opts.floorBytes ?? CENSUS_FLOOR_BYTES;
  const maxDepth = opts.maxDepth ?? CENSUS_MAX_DEPTH;
  const acc = new DuTreeAccumulator(root, { floorBytes, maxDepth });
  const duArgs = ['-x', '-0', '-B1', `--max-depth=${maxDepth}`, root];
  const privileged = Boolean(opts.sudo) || process.getuid?.() === 0;
  // Best-effort I/O at the lowest level, not the idle class: see CENSUS_IONICE_ARGS.
  // sudo relays the timeout's SIGTERM to du, so the 90 min cap still ends the walk.
  const [cmd, args] = censusDuCommand(duArgs, {
    ionice: await resolveBin('ionice'),
    nice: await resolveBin('nice'),
    sudo: opts.sudo ?? null,
  });
  return new Promise<DuRun>((resolve) => {
    let deniedCount = 0;
    const deniedSample: string[] = [];
    let pending = '';
    let errPending = '';
    let timedOut = false;
    let error: string | undefined;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? CENSUS_DU_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const parts = pending.split('\0');
      pending = parts.pop() ?? '';
      for (const record of parts) acc.addRecord(record);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errPending += chunk;
      const lines = errPending.split('\n');
      errPending = lines.pop() ?? '';
      for (const line of lines) {
        if (!/Permission denied/.test(line)) continue;
        deniedCount += 1;
        const m = /'([^']+)'/.exec(line);
        if (m && deniedSample.length < 10) deniedSample.push(m[1]!);
      }
    });
    child.on('error', (err) => {
      error = err.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending) acc.addRecord(pending);
      resolve({
        summary: acc.result(),
        deniedCount,
        deniedSample,
        timedOut,
        exitCode: code,
        privileged,
        ...(error ? { error } : {}),
      });
    });
  });
}

/** The immediate regular files of `dir` with their ALLOCATED size (du's unit). */
async function listOwnFiles(dir: string): Promise<Array<{ path: string; bytes: number }>> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; bytes: number }> = [];
  for (const name of names) {
    const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
    try {
      const st = await fsp.lstat(path);
      if (st.isFile()) out.push({ path, bytes: Number(st.blocks) * 512 });
    } catch {
      continue;
    }
  }
  return out;
}

/** A store sized through its own API because the operator user cannot read its files. */
export interface ApiSizedStore {
  kind: Extract<CensusConsumerKind, 'postgres' | 'docker'>;
  /** Filesystem root of the store (decides which device it lives on). */
  rootDir: string;
  parts: Array<{ consumer: string; bytes: number }>;
}

/** Postgres cluster size: every connectable database plus WAL. Null when unmeasurable. */
export async function measurePostgres(sql: CensusSql): Promise<ApiSizedStore | null> {
  let rootDir: string | null = null;
  try {
    const rows = await sql<{ setting: string }>`SELECT setting FROM pg_settings WHERE name = 'data_directory'`;
    rootDir = rows[0]?.setting ?? null;
  } catch {
    rootDir = null;
  }
  if (!rootDir) return null; // without the data directory the device cannot be known
  const dbRows = await sql<{ bytes: string | number | null }>`
    SELECT coalesce(sum(pg_database_size(datname)), 0)::bigint AS bytes
      FROM pg_database
     WHERE datallowconn AND has_database_privilege(datname, 'CONNECT')`;
  const parts = [{ consumer: `postgres:${rootDir} databases`, bytes: Number(dbRows[0]?.bytes ?? 0) }];
  try {
    const wal = await sql<{ bytes: string | number | null }>`SELECT coalesce(sum(size), 0)::bigint AS bytes FROM pg_ls_waldir()`;
    parts.push({ consumer: `postgres:${rootDir} wal`, bytes: Number(wal[0]?.bytes ?? 0) });
  } catch {
    // pg_ls_waldir needs pg_monitor; the database sizes alone still attribute most of the cluster.
  }
  return { kind: 'postgres', rootDir, parts };
}

function dockerSocketPath(): string {
  const host = process.env.DOCKER_HOST ?? '';
  return host.startsWith('unix://') ? host.slice('unix://'.length) : '/var/run/docker.sock';
}

function dockerGet(socketPath: string, path: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`docker ${path} HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err as Error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`docker ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

const sumOf = <T>(items: readonly T[] | null | undefined, f: (t: T) => number): number =>
  (items ?? []).reduce((a, t) => a + Math.max(0, Number(f(t)) || 0), 0);

/** Docker disk use from the Engine API (/system/df takes ~20s here). Null when docker is absent. */
export async function measureDocker(timeoutMs = 180_000): Promise<ApiSizedStore | null> {
  const socketPath = dockerSocketPath();
  try {
    await fsp.access(socketPath, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return null;
  }
  const info = (await dockerGet(socketPath, '/info', 10_000)) as { DockerRootDir?: string };
  const df = (await dockerGet(socketPath, '/system/df', timeoutMs)) as {
    LayersSize?: number;
    Containers?: Array<{ SizeRw?: number }>;
    Volumes?: Array<{ UsageData?: { Size?: number } }>;
    BuildCache?: Array<{ Size?: number }>;
  };
  return {
    kind: 'docker',
    rootDir: info.DockerRootDir ?? '/var/lib/docker',
    parts: [
      { consumer: 'docker:images', bytes: Math.max(0, Number(df.LayersSize) || 0) },
      { consumer: 'docker:containers', bytes: sumOf(df.Containers, (c) => c.SizeRw ?? 0) },
      { consumer: 'docker:volumes', bytes: sumOf(df.Volumes, (v) => v.UsageData?.Size ?? 0) },
      { consumer: 'docker:build-cache', bytes: sumOf(df.BuildCache, (b) => b.Size ?? 0) },
    ],
  };
}

/** Device of the nearest ancestor of `path` we may stat. */
async function deviceOf(path: string): Promise<string | null> {
  let cur = path;
  for (;;) {
    try {
      return devToMajorMinor((await fsp.stat(cur)).dev);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

async function readableByDu(dir: string): Promise<boolean> {
  try {
    await fsp.access(dir, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * API-sized rows that belong on `device`: only stores du could not read (no double count).
 * A privileged walk read every store root itself, so it takes none.
 */
export async function apiStoreConsumers(
  device: CensusDevice,
  stores: ReadonlyArray<ApiSizedStore | null>,
  duPrivileged = false,
): Promise<CensusConsumer[]> {
  if (duPrivileged) return [];
  const out: CensusConsumer[] = [];
  for (const store of stores) {
    if (!store) continue;
    if ((await deviceOf(store.rootDir)) !== device.majorMinor) continue;
    if (await readableByDu(store.rootDir)) continue;
    for (const p of store.parts) if (p.bytes > 0) out.push({ consumer: p.consumer, kind: store.kind, depth: 0, bytes: p.bytes });
  }
  return out;
}

export function unattributedKey(device: string): string {
  return `${device} (unattributed)`;
}

export interface CensusRunResult {
  runId: string;
  device: string;
  complete: boolean;
  consumers: number;
  usedBytes: number;
  attributedBytes: number;
  unattributedBytes: number;
  durationMs: number;
}

export interface CensusDeps {
  sql?: CensusSql;
  host?: string;
  devices?: CensusDevice[];
  runDu?: typeof runDuTree;
  measurePostgres?: (sql: CensusSql) => Promise<ApiSizedStore | null>;
  measureDocker?: () => Promise<ApiSizedStore | null>;
  /** sudo binary for a privileged walk, or null for unprivileged; probed once per pass. */
  resolveSudo?: () => Promise<string | null>;
  /** statfs sampler used around each walk; null keeps the resolved device numbers (synthetic devices in tests). */
  statDevice?: ((mountRoot: string) => Promise<CensusDeviceUsage>) | null;
  floorBytes?: number;
  maxDepth?: number;
  now?: () => Date;
}

async function defaultSql(): Promise<CensusSql> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql as unknown as CensusSql;
}

/** Build one device's consumer list from a du run plus the API-sized stores. */
export async function buildDeviceConsumers(
  device: CensusDevice,
  du: DuRun,
  stores: ReadonlyArray<ApiSizedStore | null>,
  floorBytes: number,
): Promise<{ consumers: CensusConsumer[]; attributedBytes: number; unattributedBytes: number }> {
  const consumers: CensusConsumer[] = [...du.summary.consumers];
  for (const own of du.summary.ownFiles) consumers.push(...attributeOwnFiles(own, await listOwnFiles(own.dir), floorBytes));
  const api = await apiStoreConsumers(device, stores, du.privileged === true);
  consumers.push(...api);
  // A killed walk never printed the mount total; the depth-1 directories it did finish are a lower bound.
  const duBytes =
    du.summary.rootBytes ??
    du.summary.consumers.filter((c) => censusDepth(device.device, c.consumer) === 1).reduce((a, c) => a + c.bytes, 0);
  const attributedBytes = duBytes + api.reduce((a, c) => a + c.bytes, 0);
  const unattributedBytes = Math.max(0, device.usedBytes - attributedBytes);
  if (unattributedBytes > 0) {
    consumers.push({ consumer: unattributedKey(device.device), kind: 'unattributed', depth: 0, bytes: unattributedBytes });
  }
  return { consumers, attributedBytes, unattributedBytes };
}

/** One census pass over every watched device, then the 30-day prune. Never throws per device. */
export async function runDiskConsumerCensusOnce(
  deps: CensusDeps = {},
): Promise<{ skipped?: string; runs: CensusRunResult[]; failures: Array<{ device: string; error: string }>; pruned: number }> {
  if (process.platform !== 'linux' && !deps.runDu) return { skipped: `unsupported platform ${process.platform}`, runs: [], failures: [], pruned: 0 };
  const sql = deps.sql ?? (await defaultSql());
  const host = deps.host ?? hostname();
  const now = deps.now ?? (() => new Date());
  const floorBytes = deps.floorBytes ?? CENSUS_FLOOR_BYTES;
  const maxDepth = deps.maxDepth ?? CENSUS_MAX_DEPTH;
  const devices = deps.devices ?? (await resolveCensusDevices());
  const stores = await Promise.all([
    (deps.measurePostgres ?? measurePostgres)(sql).catch(() => null),
    (deps.measureDocker ?? measureDocker)().catch(() => null),
  ]);
  const sudo = await (deps.resolveSudo ?? resolveCensusSudo)().catch(() => null);
  const runs: CensusRunResult[] = [];
  const failures: Array<{ device: string; error: string }> = [];
  const statDevice = deps.statDevice === null ? null : (deps.statDevice ?? statCensusDevice);
  for (const resolved of devices) {
    const startedAt = now();
    try {
      // Devices are resolved once per pass but walked one after another (a `/` walk takes
      // ~40 min), so the resolved used bytes are stale by the time a later device is walked.
      // Re-sample statfs around this walk and reconcile against the midpoint.
      const before = statDevice ? await statDevice(resolved.device).catch(() => null) : null;
      const du = await (deps.runDu ?? runDuTree)(resolved.device, { floorBytes, maxDepth, sudo });
      const after = statDevice ? await statDevice(resolved.device).catch(() => null) : null;
      const { device, note: usageNote } = reconcileWalkUsage(resolved, before, after);
      const { consumers, attributedBytes, unattributedBytes } = await buildDeviceConsumers(device, du, stores, floorBytes);
      const finishedAt = now();
      const complete = !du.timedOut && !du.error && du.summary.rootBytes !== null;
      const notes = [
        du.privileged ? 'du walked as root (sudo -n)' : 'du walked unprivileged (sudo -n unavailable)',
        usageNote,
        du.timedOut ? 'du timed out; sizes are lower bounds' : null,
        du.error ? `du failed: ${du.error}` : null,
        du.deniedCount > 0 ? `${du.deniedCount} unreadable path(s), e.g. ${du.deniedSample.slice(0, 5).join(', ')}` : null,
        // Shared extents (XFS/btrfs reflink clones) are counted once per FILE by du but
        // once on disk, so consumer sizes can sum past the device's used bytes.
        attributedBytes > device.usedBytes
          ? `attributed exceeds used by ${((attributedBytes - device.usedBytes) / 1024 ** 3).toFixed(1)} GiB: shared (reflinked) extents are counted per file`
          : null,
      ].filter(Boolean);
      const runId = randomUUID();
      await writeCensusRun(sql, {
        runId,
        host,
        device,
        startedAt,
        finishedAt,
        attributedBytes,
        complete,
        note: notes.length ? notes.join('; ') : null,
        consumers,
      });
      runs.push({
        runId,
        device: device.device,
        complete,
        consumers: consumers.length,
        usedBytes: device.usedBytes,
        attributedBytes,
        unattributedBytes,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    } catch (err) {
      failures.push({ device: resolved.device, error: (err as Error)?.message ?? String(err) });
    }
  }
  const pruned = await pruneDiskCensus(sql, now());
  return { runs, failures, pruned };
}

export async function writeCensusRun(
  sql: CensusSql,
  run: {
    runId: string;
    host: string;
    device: CensusDevice;
    startedAt: Date;
    finishedAt: Date;
    attributedBytes: number;
    complete: boolean;
    note: string | null;
    consumers: readonly CensusConsumer[];
  },
): Promise<void> {
  // One row per consumer key: du never repeats a path, but keep the PK safe regardless.
  const unique = [...new Map(run.consumers.map((c) => [c.consumer, c])).values()];
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.disk_census_runs
        (run_id, host, device, started_at, finished_at, size_bytes, used_bytes, avail_bytes, attributed_bytes, complete, note)
      VALUES (${run.runId}, ${run.host}, ${run.device.device}, ${run.startedAt}, ${run.finishedAt},
              ${run.device.sizeBytes}, ${run.device.usedBytes}, ${run.device.availBytes},
              ${run.attributedBytes}, ${run.complete}, ${run.note})`;
    for (let i = 0; i < unique.length; i += 500) {
      const batch = unique.slice(i, i + 500);
      await tx`
        INSERT INTO harness_shared.disk_census_consumers (run_id, consumer, kind, depth, bytes)
        SELECT ${run.runId}::uuid, c.consumer, c.kind, c.depth, c.bytes
          FROM unnest(${batch.map((c) => c.consumer)}::text[], ${batch.map((c) => c.kind)}::text[],
                      ${batch.map((c) => c.depth)}::smallint[], ${batch.map((c) => c.bytes)}::bigint[])
            AS c(consumer, kind, depth, bytes)`;
    }
  });
}

export async function pruneDiskCensus(sql: CensusSql, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CENSUS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await sql<{ n: string | number }>`
    WITH gone AS (DELETE FROM harness_shared.disk_census_runs WHERE finished_at < ${cutoff} RETURNING 1)
    SELECT count(*)::int AS n FROM gone`;
  return Number(rows[0]?.n ?? 0);
}

export interface CensusDeviceView {
  device: string;
  /** No census run has ever been written for this watched device on this host. */
  missing?: true;
  sampledAt?: string;
  /** Latest run older than 24h. */
  stale?: boolean;
  complete?: boolean;
  note?: string | null;
  sizeBytes?: number;
  usedBytes?: number;
  availBytes?: number;
  attributedBytes?: number;
  unattributedBytes?: number;
  /** unattributed ≥ 10 GiB: a consumer that large could be missing from the list. */
  coverageGap?: boolean;
  /** The run the 24h growth is measured against (18–30h before the latest); null when none. */
  baselineAt?: string | null;
  consumers?: CensusGrowthRow[];
  consumersTotal?: number;
  truncatedByLimit?: boolean;
}

interface RunRow {
  run_id: string;
  device: string;
  finished_at: Date;
  size_bytes: string | number;
  used_bytes: string | number;
  avail_bytes: string | number;
  attributed_bytes: string | number;
  complete: boolean;
  note: string | null;
}

async function consumersOf(sql: CensusSql, runId: string): Promise<CensusConsumer[]> {
  const rows = await sql<{ consumer: string; kind: CensusConsumerKind; depth: number; bytes: string | number }>`
    SELECT consumer, kind, depth, bytes FROM harness_shared.disk_census_consumers WHERE run_id = ${runId}`;
  return rows.map((r) => ({ consumer: r.consumer, kind: r.kind, depth: Number(r.depth), bytes: Number(r.bytes) }));
}

/** The census read: per device, each consumer's size and its growth over the last ~24h. */
export async function readDiskConsumerCensus(
  sql: CensusSql,
  opts: {
    host?: string;
    device?: string;
    orderBy?: 'bytes' | 'growth';
    limit?: number;
    /** Watched devices expected to have rows; one with none is reported `missing`. */
    expectedDevices?: readonly string[];
    now?: Date;
  } = {},
): Promise<{ host: string; devices: CensusDeviceView[] }> {
  const host = opts.host ?? hostname();
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 500));
  const latest = await sql<RunRow>`
    SELECT DISTINCT ON (device) run_id, device, finished_at, size_bytes, used_bytes, avail_bytes, attributed_bytes, complete, note
      FROM harness_shared.disk_census_runs
     WHERE host = ${host} ${opts.device ? sql`AND device = ${opts.device}` : sql``}
     ORDER BY device, finished_at DESC`;
  const devices: CensusDeviceView[] = [];
  for (const run of latest) {
    const finishedAt = new Date(run.finished_at);
    const target = new Date(finishedAt.getTime() - 24 * 3600_000);
    const base = await sql<{ run_id: string; finished_at: Date }>`
      SELECT run_id, finished_at FROM harness_shared.disk_census_runs
       WHERE host = ${host} AND device = ${run.device} AND complete
         AND finished_at BETWEEN ${new Date(finishedAt.getTime() - 30 * 3600_000)} AND ${new Date(finishedAt.getTime() - 18 * 3600_000)}
       ORDER BY abs(extract(epoch FROM (finished_at - ${target}::timestamptz)))
       LIMIT 1`;
    const rows = joinCensusGrowth(await consumersOf(sql, run.run_id), base[0] ? await consumersOf(sql, base[0].run_id) : null);
    const sorted = sortCensusRows(rows, opts.orderBy);
    const used = Number(run.used_bytes);
    const attributed = Number(run.attributed_bytes);
    const unattributed = Math.max(0, used - attributed);
    devices.push({
      device: run.device,
      sampledAt: finishedAt.toISOString(),
      stale: now.getTime() - finishedAt.getTime() > CENSUS_STALE_MS,
      complete: run.complete,
      note: run.note,
      sizeBytes: Number(run.size_bytes),
      usedBytes: used,
      availBytes: Number(run.avail_bytes),
      attributedBytes: attributed,
      unattributedBytes: unattributed,
      coverageGap: unattributed >= CENSUS_COVERAGE_GAP_BYTES,
      baselineAt: base[0] ? new Date(base[0].finished_at).toISOString() : null,
      consumers: sorted.slice(0, limit),
      consumersTotal: sorted.length,
      truncatedByLimit: sorted.length > limit,
    });
  }
  for (const expected of opts.expectedDevices ?? []) {
    if (opts.device && expected !== opts.device) continue;
    if (!devices.some((d) => d.device === expected)) devices.push({ device: expected, missing: true });
  }
  return { host, devices };
}
