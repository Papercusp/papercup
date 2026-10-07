/**
 * runtime-vintage.ts — the CURRENT build identity every runtime self-reports at
 * boot (fleet-reliability-verification-2026-07-10 P-008; mig 542
 * `harness_shared.runtime_vintage`).
 *
 * Problem this answers: "is the fix actually RUNNING there?" was asked ~5x by
 * manual ssh + log-tailing during the 2026-07-09/10 night-shift outage (a Mac
 * desktop bundle predating a landed fix; a tower bundle mid half-rename break;
 * a watchdog silently auto-deploying an instrumented build). One row per
 * (workspace, unit, host) — an upserted CURRENT-vintage ledger, not a full
 * history — refreshed every time that runtime boots. `deploys:vintage` (agent
 * tool) reads this table and diffs `treeSha` against `origin/staging` HEAD to
 * report commit-lag per unit.
 *
 * Store shape mirrors read-cursors.ts / watermarks.ts: a module-level default
 * Pg store with configure/reset seams so tests inject the in-memory variant
 * and never touch the live row.
 */

import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { coerceJson } from './pg-jsonb';
import { readProcessIdentity, linuxProcStateFromStat, linuxStartTicksFromProcStat } from './process-identity';

/** The tagged org-PG client, optionally supplied by a caller's read transaction. */
export type RuntimeVintageSql = ReturnType<typeof getOrgPg>['sql'];

export interface RuntimeVintageReport {
  /** Free-form reporting-process label — e.g. 'bg-host', 'staging-api',
   *  'dev-api', 'desktop-sidecar', 'watchdog', 'gateway'. Not an enum: new
   *  runtime kinds must never block on a migration to be recorded. */
  unit: string;
  /** Defaults to os.hostname() when omitted. */
  host?: string;
  treeSha?: string | null;
  /** ISO timestamp; defaults to now() when omitted. */
  buildTime?: string | null;
  bundleVersion?: string | null;
  pid?: number | null;
  /** Best-effort extra context (platform, arch, envOperatorId, …) — additive,
   *  never load-bearing for the commit-lag computation. */
  extra?: Record<string, unknown>;
  workspaceId?: string;
}

export interface RuntimeVintageRow {
  workspaceId: string;
  unit: string;
  host: string;
  treeSha: string | null;
  buildTime: string | null;
  bundleVersion: string | null;
  pid: number | null;
  extra: Record<string, unknown>;
  reportedAt: string;
}

export interface RuntimeVintageStore {
  report(input: RuntimeVintageReport): Promise<void>;
  list(workspaceId?: string, client?: RuntimeVintageSql): Promise<RuntimeVintageRow[]>;
}

class PgRuntimeVintageStore implements RuntimeVintageStore {
  async report(input: RuntimeVintageReport): Promise<void> {
    const { sql } = getOrgPg();
    const ws = input.workspaceId ?? activeWorkspaceId();
    const host = input.host?.trim() || defaultHost();
    // `${JSON.stringify(x)}::jsonb`, NOT sql.json() — sql.json() THROWS on the
    // getOrgPg client ("Buffer.byteLength received Object"; see pg-jsonb.ts /
    // dock-layouts.ts's matching comment / agent-insights
    // postgres-js-jsonb-binding). sql.json() is only correct on the OTHER
    // (db()) postgres-js pool, which this store does not use.
    const extraJson = JSON.stringify(input.extra ?? {});
    await sql`
      INSERT INTO harness_shared.runtime_vintage
             (workspace_id, unit, host, tree_sha, build_time, bundle_version, pid, extra, reported_at)
      VALUES (${ws}, ${input.unit}, ${host}, ${input.treeSha ?? null},
              ${input.buildTime ?? new Date().toISOString()}, ${input.bundleVersion ?? null},
              ${input.pid ?? null}, ${extraJson}::text::jsonb, now())
      ON CONFLICT (workspace_id, unit, host) DO UPDATE SET
        tree_sha = EXCLUDED.tree_sha,
        build_time = EXCLUDED.build_time,
        bundle_version = EXCLUDED.bundle_version,
        pid = EXCLUDED.pid,
        extra = EXCLUDED.extra,
        reported_at = now()
    `;
  }

  async list(workspaceId?: string, client?: RuntimeVintageSql): Promise<RuntimeVintageRow[]> {
    const sql = client ?? getOrgPg().sql;
    const ws = workspaceId ?? activeWorkspaceId();
    const rows = await sql<Array<{
      workspace_id: string;
      unit: string;
      host: string;
      tree_sha: string | null;
      build_time: string | null;
      bundle_version: string | null;
      pid: number | null;
      extra: Record<string, unknown>;
      reported_at: string;
    }>>`
      SELECT workspace_id, unit, host, tree_sha, build_time, bundle_version, pid, extra, reported_at
        FROM harness_shared.runtime_vintage
       WHERE workspace_id = ${ws}
       ORDER BY unit, host
    `;
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      unit: r.unit,
      host: r.host,
      treeSha: r.tree_sha,
      buildTime: r.build_time,
      bundleVersion: r.bundle_version,
      pid: r.pid,
      // Defensive decode (pg-jsonb.ts): a jsonb column reads back as an
      // object under the prod getOrgPg client but as a raw JSON STRING under
      // some other pool configs (e.g. testcontainers) — coerceJson handles
      // both so this never silently ships a stringified blob as `extra`.
      extra: coerceJson<Record<string, unknown>>(r.extra) ?? {},
      reportedAt: r.reported_at,
    }));
  }
}

/** In-memory variant for tests (mirrors InMemoryReadCursorStore's contract). */
export class InMemoryRuntimeVintageStore implements RuntimeVintageStore {
  rows = new Map<string, RuntimeVintageRow>();
  private key(ws: string, unit: string, host: string): string {
    return `${ws}\0${unit}\0${host}`;
  }
  async report(input: RuntimeVintageReport): Promise<void> {
    const ws = input.workspaceId ?? activeWorkspaceId();
    const host = input.host?.trim() || defaultHost();
    this.rows.set(this.key(ws, input.unit, host), {
      workspaceId: ws,
      unit: input.unit,
      host,
      treeSha: input.treeSha ?? null,
      buildTime: input.buildTime ?? new Date().toISOString(),
      bundleVersion: input.bundleVersion ?? null,
      pid: input.pid ?? null,
      extra: input.extra ?? {},
      reportedAt: new Date().toISOString(),
    });
  }
  async list(workspaceId?: string): Promise<RuntimeVintageRow[]> {
    const ws = workspaceId ?? activeWorkspaceId();
    return Array.from(this.rows.values())
      .filter((r) => r.workspaceId === ws)
      .sort((a, b) => (a.unit === b.unit ? a.host.localeCompare(b.host) : a.unit.localeCompare(b.unit)));
  }
}

function defaultHost(): string {
  try {
    return hostname();
  } catch {
    return 'unknown-host';
  }
}

let store: RuntimeVintageStore = new PgRuntimeVintageStore();

/** Swap the backing store (tests inject InMemoryRuntimeVintageStore). */
export function configureRuntimeVintageStore(next: RuntimeVintageStore): void {
  store = next;
}

/** Restore the default Pg store (afterEach in tests). */
export function resetRuntimeVintageStore(): void {
  store = new PgRuntimeVintageStore();
}

/** Upsert this runtime's current build identity. */
export async function reportRuntimeVintage(input: RuntimeVintageReport): Promise<void> {
  // This reserved field is a kernel measurement, never a remote caller's claim.
  const extra = { ...input.extra };
  delete extra.kernelProcessIdentity;
  delete extra.kernelExecutableDigest;
  delete extra.kernelExecutableStat;
  delete extra.kernelNodeEntryDigest;
  if ((input.host?.trim() || defaultHost()) === defaultHost() && input.pid != null) {
    const identity = liveProcessIdentity(input.pid);
    if (identity) {
      extra.kernelProcessIdentity = identity;
      // A native binary may have no baked Git revision. Its loaded executable,
      // rather than today's checkout, can still supply an exact artifact identity.
      // Only opt into hashing for explicit digest reports; normal boot reports
      // keep their existing inexpensive source-revision path.
      const expected = executableBundleDigest(input.bundleVersion);
      if (expected) {
        const before = liveExecutableStat(input.pid);
        if (before && await liveExecutableDigest(input.pid) === expected
          && liveExecutableStat(input.pid) === before && liveProcessIdentity(input.pid) === identity) {
          extra.kernelExecutableDigest = expected;
          extra.kernelExecutableStat = before;
        }
      }
      const entry = nodeEntryBundleDigest(input.bundleVersion);
      if (entry && liveNodeEntryDigest(input.pid) === entry
        && liveProcessIdentity(input.pid) === identity) extra.kernelNodeEntryDigest = entry;
    }
  }
  return store.report({ ...input, extra });
}

function executableBundleDigest(version: string | null | undefined): string | null {
  return /^executable-sha256:[a-f0-9]{64}$/.test(version ?? '')
    ? version!.slice('executable-sha256:'.length) : null;
}

function nodeEntryBundleDigest(version: string | null | undefined): string | null {
  return /^node-entry-sha256:[a-f0-9]{64}$/.test(version ?? '')
    ? version!.slice('node-entry-sha256:'.length) : null;
}

/** Only a direct Node bundle entry written before this process started is proven. */
function liveNodeEntryDigest(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    if (!/^node(?:js)?$/.test(basename(readlinkSync(`/proc/${pid}/exe`)))) return null;
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (argv.length !== 2 || !/\.(?:c|m)?js$/.test(argv[1])) return null;
    const entry = realpathSync(resolve(readlinkSync(`/proc/${pid}/cwd`), argv[1]));
    const before = statSync(entry);
    const ticks = Number(linuxStartTicksFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8')));
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    // USER_HZ=100 on the Linux targets we ship, also used by the existing
    // systemd-service-probe and release-checkpoint-launch process readers.
    const startedAt = Date.now() - uptime * 1000 + ticks * 10;
    if (!Number.isFinite(ticks) || ticks <= 0 || !Number.isFinite(uptime)
      || !before.isFile() || before.mtimeMs > startedAt - 25 || before.ctimeMs > startedAt - 25) return null;
    const digest = createHash('sha256').update(readFileSync(entry)).digest('hex');
    const after = statSync(entry);
    return before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs
      && before.ctimeMs === after.ctimeMs ? digest : null;
  } catch { return null; }
}

/** /proc exposes the loaded inode even after its original path is replaced. */
async function liveExecutableDigest(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(`/proc/${pid}/exe`)) hash.update(chunk);
    return hash.digest('hex');
  }
  catch { return null; }
}

function liveExecutableStat(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = statSync(`/proc/${pid}/exe`, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch { return null; }
}

function liveProcessIdentity(pid: number): string | null {
  const identity = readProcessIdentity(pid);
  if (!identity) return null;
  if (process.platform === 'linux') {
    try {
      const state = linuxProcStateFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (!state || state === 'Z' || state === 'X' || state === 'x') return null;
    } catch { return null; }
  }
  // Refuse a process replacement between the identity and state reads, too.
  return readProcessIdentity(pid) === identity ? identity : null;
}

/**
 * Re-measure named local runtimes against the boot-time kernel pin. Historical
 * rows, remote hosts and PID reuse remain unproven; a boot ledger is not liveness.
 * Capture this value at execution time AND independently at evidence-read time.
 * It must never be used to restamp a historical run at binding time.
 */
export function measureRuntimeVintageEnvironment(
  rows: readonly RuntimeVintageRow[],
  units: readonly string[],
  deps: { host: string; identity: (pid: number) => string | null;
    executableStat?: (pid: number) => string | null } = {
    host: defaultHost(), identity: liveProcessIdentity, executableStat: liveExecutableStat,
  },
): string | null {
  if (units.length === 0 || units.length > 32 || new Set(units).size !== units.length) return null;
  const pins: Array<[string, string, string, string | null, number, string]> = [];
  for (const unit of [...units].sort()) {
    const matches = rows.filter(row => row.unit === unit && row.host === deps.host);
    if (matches.length !== 1) return null;
    const row = matches[0];
    if (!Number.isSafeInteger(row.pid) || row.pid! <= 0) return null;
    const pinned = row.extra.kernelProcessIdentity;
    if (typeof pinned !== 'string' || !pinned || deps.identity(row.pid!) !== pinned) return null;
    let codeIdentity = row.treeSha;
    const executable = executableBundleDigest(row.bundleVersion);
    const entry = nodeEntryBundleDigest(row.bundleVersion);
    if (executable) {
      if (row.extra.kernelExecutableDigest !== executable
        || typeof row.extra.kernelExecutableStat !== 'string' || !row.extra.kernelExecutableStat
        || !deps.executableStat || deps.executableStat(row.pid!) !== row.extra.kernelExecutableStat
        || deps.identity(row.pid!) !== pinned) return null;
      codeIdentity = `executable-sha256:${executable}`;
    } else if (entry) {
      if (row.extra.kernelNodeEntryDigest !== entry || liveNodeEntryDigest(row.pid!) !== entry
        || deps.identity(row.pid!) !== pinned) return null;
      codeIdentity = `node-entry-sha256:${entry}`;
    } else if (!codeIdentity || !/^[a-f0-9]{7,64}$/.test(codeIdentity)) return null;
    // Shared and caller-owned PG clients can decode timestamptz as either
    // PostgreSQL text or ISO text. Hash the instant, not the driver's encoding.
    // The constructor also copies driver-returned Date objects without their
    // toString coercion, which would discard the boot's milliseconds.
    const buildTimeMs = row.buildTime === null ? null : new Date(row.buildTime).getTime();
    if (buildTimeMs !== null && !Number.isFinite(buildTimeMs)) return null;
    const buildTime = buildTimeMs === null ? null : new Date(buildTimeMs).toISOString();
    pins.push([unit, row.host, codeIdentity!, buildTime, row.pid!, pinned]);
  }
  return createHash('sha256').update(JSON.stringify(pins)).digest('hex');
}

/** List every reported runtime's current vintage for a workspace. */
export async function listRuntimeVintage(
  workspaceId?: string,
  client?: RuntimeVintageSql,
): Promise<RuntimeVintageRow[]> {
  return store.list(workspaceId, client);
}

/**
 * Fire-and-forget boot-time self-report, built from build-info.ts's
 * getBuildInfo() (the same sha/version resolver /api/health already exposes).
 * Never throws, never blocks boot — a failed report just means this runtime's
 * row stays stale until its next successful boot, not a crashed process.
 */
export function reportRuntimeVintageOnBoot(unit: string, extra?: Record<string, unknown>): void {
  void (async () => {
    try {
      const { getBuildInfo } = await import('./build-info');
      const info = getBuildInfo();
      await reportRuntimeVintage({
        unit,
        treeSha: info.sha,
        bundleVersion: info.version,
        buildTime: new Date().toISOString(),
        pid: process.pid,
        extra,
      });
    } catch (e) {
      console.warn(
        `[runtime-vintage] self-report failed for unit=${unit} (non-fatal):`,
        (e as Error)?.message ?? e,
      );
    }
  })();
}
