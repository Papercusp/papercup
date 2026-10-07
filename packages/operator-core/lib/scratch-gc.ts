/**
 * Scratch storage garbage collection + quota — Phase 4 T2.3.
 *
 * Sweep policy (runs on SCRATCH_GC_CRONTAB — daily — so a run-dir lives up to
 * SCRATCH_RUN_DIR_MAX_AGE_MS = RETENTION_MS + one sweep period, i.e. 24–48h):
 *   1. Walk ~/.papercusp/scratch/<workspace>/<toolName>/<runId>/ dirs;
 *      delete any older than RETENTION_MS (24h default).
 *   2. List ~/.papercusp/scratch/ top-level entries; drop a whole tree ONLY
 *      when it is PROVABLY a dead workspace scratch root (WI-10006512):
 *      not in the registry, carries a valid WORKSPACE_SCRATCH_MARKER naming
 *      itself, nothing in it changed for DEAD_WORKSPACE_QUIET_MS, and a
 *      fail-closed /proc scan finds no process with a file open (or its cwd)
 *      inside it. Anything else at the top level — agent scratch dirs,
 *      `packs`, a benchmark's PG datadir — is not ours and is never deleted.
 *      The marker is written when a workspace root is created (the scratch
 *      writers) and backfilled onto every registered root each sweep.
 *   3. After deletion, check per-workspace usage against
 *      WORKSPACE_QUOTA_BYTES; FIFO-evict by run-dir mtime until
 *      under quota.
 *
 * Single-write overflow:
 *   - reserveScratchSpace(workspaceId, bytes) checks the workspace
 *     quota WITHOUT writing. Throws ScratchQuotaError on overflow.
 *   - The agent-tools route layer responds 507 Insufficient Storage
 *     when this throws on a tool's write path.
 *
 * The GC is conservative: it never deletes the currently-active run
 * of any tool (relies on mtime; the dispatcher bumps mtime on every
 * write). Acceptable race: a stale 24h+1min run with a slow trailing
 * write could be evicted mid-write; in practice tools either write
 * fast or extend mtime via fs.utimes if they keep the dir around.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.3.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  readdir as readdirAsync,
  stat as statAsync,
  lstat as lstatAsync,
  rm as rmAsync,
  readFile as readFileAsync,
  writeFile as writeFileAsync,
  realpath as realpathAsync,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { openWriterPidsMany, NATIVE_BG_SCAN_DEADLINE_MS, type OpenWriterScan } from './native-bg-task-ledger';
import { scratchRoot, scratchRootForWorkspace } from './scratch-uri';

/** Retention window for run-dirs since last mtime. 24h default. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Per-workspace quota. 5 GB default. */
export const WORKSPACE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * GC sweep schedule — the ONE source for it. `dbos/periodic-workflows.ts` registers the
 * `scratchGc` DBOS workflow with exactly this crontab (6-field, seconds first: daily 03:00
 * host-local). It replaces a hand-maintained `GC_INTERVAL_MS = 1h` that nothing read: the
 * sweep had been daily all along, and that constant led an investigation (WI-10004532) to
 * report retention as unenforced when the GC was working.
 */
export const SCRATCH_GC_CRONTAB = '0 0 3 * * *';

/** Interval between sweeps implied by SCRATCH_GC_CRONTAB (daily). */
export const SCRATCH_GC_SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * The oldest a run-dir can legitimately get. The sweep only removes dirs already past
 * RETENTION_MS at the moment it runs, so a dir that crosses RETENTION_MS just after a sweep
 * survives one more full period. Counting "run dirs older than RETENTION_MS" therefore
 * measures the sweep cadence, not a GC failure. A dir older than THIS bound means the GC is
 * not running or not deleting.
 */
export const SCRATCH_RUN_DIR_MAX_AGE_MS = RETENTION_MS + SCRATCH_GC_SWEEP_PERIOD_MS;

/* ─── Workspace-root proof (WI-10006512) ─────────────────────────────────
 *
 * The dead-workspace pass used to treat EVERY top-level entry of the scratch root that was not a
 * registered workspace id as a dead workspace and `rm -rf` it, with no age or open-file check. The
 * scratch root is also where agents are told to put their own scratch (the bash resource gate
 * names `~/.papercusp/scratch/<session-or-task>/`) and where `packs` lives, so the 03:00 sweep
 * deleted a running benchmark's PG datadir mid-run (2026-10-06). A name is not proof: an agent dir
 * matches the workspace-id grammar. So a workspace root now carries a marker naming its workspace,
 * and the sweep deletes only a tree that carries one.
 */

/** File in a workspace scratch root that proves the dir belongs to that workspace. */
export const WORKSPACE_SCRATCH_MARKER = '.papercusp-workspace-scratch-root';

const WORKSPACE_SCRATCH_MARKER_KIND = 'papercusp-workspace-scratch-root';

/**
 * A provably-dead workspace root is kept while anything in it changed this recently. Same window
 * as run-dir retention: a workspace that stopped writing a day ago is as dead as an expired run.
 */
export const DEAD_WORKSPACE_QUIET_MS = RETENTION_MS;

function workspaceScratchMarkerBody(workspaceId: string, now = Date.now()): string {
  return `${JSON.stringify({ kind: WORKSPACE_SCRATCH_MARKER_KIND, workspaceId, markedAt: new Date(now).toISOString() })}\n`;
}

/**
 * Mark a workspace scratch root that a `mkdir(..., { recursive: true })` call just created.
 * `firstCreated` is that call's return value (the first directory it created, or undefined when
 * the whole chain already existed). The marker is written only when the workspace root itself was
 * created by that call, so the steady-state write path costs nothing. A root that pre-existed is
 * marked by the sweep's backfill instead. Best-effort: a marker failure never fails the write.
 */
export function markNewWorkspaceScratchRootSync(workspaceId: string, firstCreated: string | undefined): void {
  if (!firstCreated) return;
  try {
    const wsRoot = scratchRootForWorkspace(workspaceId);
    if (wsRoot !== firstCreated && !wsRoot.startsWith(firstCreated + sep)) return;
    writeFileSync(join(wsRoot, WORKSPACE_SCRATCH_MARKER), workspaceScratchMarkerBody(workspaceId), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    /* EEXIST (already marked), an invalid workspace id, or a vanished root: nothing to mark. */
  }
}

/** Async twin of markNewWorkspaceScratchRootSync, for the non-blocking write path. */
export async function markNewWorkspaceScratchRoot(workspaceId: string, firstCreated: string | undefined): Promise<void> {
  if (!firstCreated) return;
  try {
    const wsRoot = scratchRootForWorkspace(workspaceId);
    if (wsRoot !== firstCreated && !wsRoot.startsWith(firstCreated + sep)) return;
    await writeMarkerIfAbsent(wsRoot, workspaceId);
  } catch {
    /* see markNewWorkspaceScratchRootSync */
  }
}

/** Write the marker into an EXISTING root. Returns true when it wrote one. Never creates the root. */
async function writeMarkerIfAbsent(wsRoot: string, workspaceId: string): Promise<boolean> {
  try {
    await writeFileAsync(join(wsRoot, WORKSPACE_SCRATCH_MARKER), workspaceScratchMarkerBody(workspaceId), {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch {
    return false; // EEXIST = already marked; ENOENT = no root to mark
  }
}

/**
 * True only when `dir` is a real directory (not a symlink) whose marker names `name` as its
 * workspace. A copied or renamed tree carries a marker naming a different workspace, so it fails.
 */
async function isProvenWorkspaceScratchRoot(dir: string, name: string): Promise<boolean> {
  try {
    if (!(await lstatAsync(dir)).isDirectory()) return false;
    const marker = JSON.parse(await readFileAsync(join(dir, WORKSPACE_SCRATCH_MARKER), 'utf8')) as {
      kind?: unknown;
      workspaceId?: unknown;
    };
    return marker.kind === WORKSPACE_SCRATCH_MARKER_KIND && marker.workspaceId === name;
  } catch {
    return false;
  }
}

/** Why a provably-dead workspace root was kept this sweep. */
export type DeadWorkspaceDeferral = 'recent-write' | 'open-writer' | 'process-scan-incomplete';

/** Default open-writer scan: descendants + cwd, fail-closed, deadline-bounded (as fleet-logs-gc). */
function defaultScanOpenPaths(paths: readonly string[]): Promise<OpenWriterScan> {
  return openWriterPidsMany(paths, {
    descendants: true,
    includeCwd: true,
    failClosed: true,
    deadlineMs: NATIVE_BG_SCAN_DEADLINE_MS,
  });
}

export class ScratchQuotaError extends Error {
  readonly code = 'SCRATCH_QUOTA_EXCEEDED';
  constructor(message: string) {
    super(message);
    this.name = 'ScratchQuotaError';
  }
}

/** Telemetry: total bytes evicted by FIFO sweeps since process start. */
let evictedBytesTotal = 0;

export function scratchEvictionBytes(): number {
  return evictedBytesTotal;
}

/** Reset the eviction counter — test-only. */
export function _resetScratchGcCountersForTests(): void {
  evictedBytesTotal = 0;
}

/**
 * Run one full GC sweep over the scratch tree.
 *
 *   workspaceRegistry: list of known workspace IDs. A top-level dir not
 *     in the registry is removed wholesale ONLY when it is provably a dead
 *     workspace root (marker), quiet, and held by no process (WI-10006512);
 *     every other top-level entry is left alone and counted.
 *
 * Returns a summary for logging / tests. Designed to be safe even if
 * the scratch root doesn't exist (no-op).
 *
 * ASYNC and SEQUENTIAL (WI-10005135): every readdir / stat / rm is an awaited fs/promises call,
 * one in flight at a time, so the sweep never blocks the event loop and occupies at most one
 * libuv threadpool thread. It used to be a synchronous readdirSync+statSync walk of the whole
 * tree (several passes: dead workspaces, retention, quota) on the DBOS worker's main thread,
 * measured at ~1 s per warm walk; under ext4 contention a single readdir can block for seconds
 * (the WI-10004513 D-state class), and a blocked main thread is what times out Jev memory calls.
 */
export interface ScratchGcSummary {
  retentionEvictions: number;
  retentionEvictedBytes: number;
  deadWorkspaces: number;
  deadWorkspaceBytes: number;
  quotaEvictions: number;
  quotaEvictedBytes: number;
  /** Registered workspace roots that got their WORKSPACE_SCRATCH_MARKER this sweep (backfill). */
  markersWritten: number;
  /**
   * Top-level entries that are neither registered nor provably a workspace scratch root (agent
   * scratch, `packs`, ...). Counted so growth stays visible; NEVER deleted by this sweep.
   */
  unprovenEntries: number;
  /** Provably-dead workspace roots this sweep kept, and why. */
  deadWorkspacesDeferred: Array<{ workspaceId: string; reason: DeadWorkspaceDeferral }>;
}

export async function runScratchGc(opts: {
  workspaceRegistry: ReadonlyArray<string>;
  now?: number;
  /** Test seam for the /proc open-writer scan. Missing or partial evidence always keeps a tree. */
  scanOpenPaths?: (paths: readonly string[]) => Promise<OpenWriterScan>;
}): Promise<ScratchGcSummary> {
  const now = opts.now ?? Date.now();
  const root = scratchRoot();
  const summary: ScratchGcSummary = {
    retentionEvictions: 0,
    retentionEvictedBytes: 0,
    deadWorkspaces: 0,
    deadWorkspaceBytes: 0,
    quotaEvictions: 0,
    quotaEvictedBytes: 0,
    markersWritten: 0,
    unprovenEntries: 0,
    deadWorkspacesDeferred: [],
  };

  const registrySet = new Set(opts.workspaceRegistry);

  // Backfill: every registered workspace root that exists gets its marker, so that once the
  // workspace leaves the registry its root is provably ours. Never creates a root.
  for (const workspaceId of opts.workspaceRegistry) {
    let wsRoot: string;
    try {
      wsRoot = scratchRootForWorkspace(workspaceId);
    } catch {
      continue; // an id with no valid scratch shape has no scratch root
    }
    if (await writeMarkerIfAbsent(wsRoot, workspaceId)) summary.markersWritten += 1;
  }

  // Step 2 (before step 1 so we don't waste work on dead workspaces): remove PROVABLY dead
  // workspace roots wholesale (WI-10006512). A missing root lists as empty.
  const candidates: Array<{ workspaceId: string; dir: string; realDir: string; bytes: number }> = [];
  for (const name of await listDir(root)) {
    if (registrySet.has(name)) continue;
    const dir = join(root, name);
    if (!(await isProvenWorkspaceScratchRoot(dir, name))) {
      summary.unprovenEntries += 1;
      continue;
    }
    const tree = await treeStatsAsync(dir);
    if (now - tree.newestMtimeMs < DEAD_WORKSPACE_QUIET_MS) {
      summary.deadWorkspacesDeferred.push({ workspaceId: name, reason: 'recent-write' });
      continue;
    }
    // /proc fd and cwd links name REAL paths, so the scan must be given the real path too.
    let realDir: string;
    try {
      realDir = await realpathAsync(dir);
    } catch {
      continue; // vanished mid-sweep
    }
    candidates.push({ workspaceId: name, dir, realDir, bytes: tree.bytes });
  }
  if (candidates.length > 0) {
    let scan: OpenWriterScan = { byPath: new Map(), complete: false };
    try {
      scan = await (opts.scanOpenPaths ?? defaultScanOpenPaths)(candidates.map((c) => c.realDir));
    } catch {
      /* no process evidence is not permission to delete */
    }
    for (const c of candidates) {
      if (scan.byPath.get(c.realDir)?.length) {
        summary.deadWorkspacesDeferred.push({ workspaceId: c.workspaceId, reason: 'open-writer' });
        continue;
      }
      if (!scan.complete) {
        summary.deadWorkspacesDeferred.push({ workspaceId: c.workspaceId, reason: 'process-scan-incomplete' });
        continue;
      }
      await rmAsync(c.dir, { recursive: true, force: true });
      summary.deadWorkspaces += 1;
      summary.deadWorkspaceBytes += c.bytes;
    }
  }

  // Step 1: retention sweep, per-workspace.
  for (const workspaceId of opts.workspaceRegistry) {
    for (const run of await runDirsOf(scratchRootForWorkspace(workspaceId))) {
      if (now - run.mtimeMs > RETENTION_MS) {
        const bytes = await sizeOfDirAsync(run.dir);
        await rmAsync(run.dir, { recursive: true, force: true });
        summary.retentionEvictions += 1;
        summary.retentionEvictedBytes += bytes;
      }
    }
  }

  // Step 3: per-workspace quota check + FIFO eviction by mtime.
  for (const workspaceId of opts.workspaceRegistry) {
    const reclaimed = await evictWorkspaceQuota(workspaceId, () => WORKSPACE_QUOTA_BYTES);
    summary.quotaEvictions += reclaimed.evictions;
    summary.quotaEvictedBytes += reclaimed.bytes;
  }

  return summary;
}

/** Entry names of `dir`, or [] when it is missing or unreadable. Never blocks the event loop. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdirAsync(dir);
  } catch {
    return [];
  }
}

/** Child DIRECTORIES of `dir` with their mtimes; files and entries that vanish mid-walk are skipped. */
async function childDirs(dir: string): Promise<Array<{ dir: string; mtimeMs: number }>> {
  const out: Array<{ dir: string; mtimeMs: number }> = [];
  for (const name of await listDir(dir)) {
    const child = join(dir, name);
    let st;
    try {
      st = await statAsync(child);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push({ dir: child, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** Every `<toolName>/<runId>/` run dir under a workspace root (empty when the root is missing). */
async function runDirsOf(wsRoot: string): Promise<Array<{ dir: string; mtimeMs: number }>> {
  const runs: Array<{ dir: string; mtimeMs: number }> = [];
  for (const toolDir of await childDirs(wsRoot)) {
    runs.push(...(await childDirs(toolDir.dir)));
  }
  return runs;
}

/**
 * How stale a workspace's cached usage total may get before the next reservation kicks off a
 * background re-measure. Between measurements the total tracks this process's own reservations;
 * other processes' writes and GC deletions are picked up on the next re-measure. The quota is a
 * coarse disk-safety net (5 GB vs ~0.4 GB in practice), so minutes of drift are immaterial.
 */
export const USAGE_REFRESH_MS = 5 * 60 * 1000;

interface ScratchUsageEntry {
  /** Best-known bytes used: last async measurement + reservations made since. */
  bytes: number;
  /** When the last completed measurement finished (0 = never measured). */
  measuredAt: number;
  /** In-flight background measurement, if any (at most one per workspace). */
  refreshing: Promise<void> | null;
  /** One shared pressure recovery; subsequent writers await it before touching disk. */
  recovering: Promise<void> | null;
  writes: Map<symbol, { filePath: string; bytes: number; reserved: boolean }>;
}

/** Per-process cached usage per workspace (WI-10004513). Pinned so a split module record can't
 *  fork it into two caches that each under-count. */
const usageState = pinModuleState('@papercusp/operator-core.scratch-gc.usage', () => ({
  byWorkspace: new Map<string, ScratchUsageEntry>(),
}));

function usageEntry(workspaceId: string): ScratchUsageEntry {
  let entry = usageState.byWorkspace.get(workspaceId);
  if (!entry) {
    entry = { bytes: 0, measuredAt: 0, refreshing: null, recovering: null, writes: new Map() };
    usageState.byWorkspace.set(workspaceId, entry);
  }
  return entry;
}

function reservedWriteBytes(entry: ScratchUsageEntry): number {
  return [...entry.writes.values()].reduce((sum, write) => sum + (write.reserved ? write.bytes : 0), 0);
}

/** The same FIFO phase serves the daily sweep and request-time async quota recovery. */
async function evictWorkspaceQuota(workspaceId: string, targetBytes: () => number): Promise<{
  used: number; evictions: number; bytes: number;
}> {
  const wsRoot = scratchRootForWorkspace(workspaceId);
  const entry = usageEntry(workspaceId);
  let used = await sizeOfDirAsync(wsRoot);
  let evictions = 0;
  let bytes = 0;
  if (used > targetBytes()) {
    const runs = await runDirsOf(wsRoot);
    runs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const run of runs) {
      if (used <= targetBytes()) break;
      const runBytes = await sizeOfDirAsync(run.dir);
      // Recheck after the walk: a writer may have arrived while it was in flight.
      if ([...entry.writes.values()].some((write) => write.filePath.startsWith(run.dir + sep))) continue;
      await rmAsync(run.dir, { recursive: true, force: true });
      used -= runBytes;
      evictions += 1;
      bytes += runBytes;
      evictedBytesTotal += runBytes;
    }
  }
  entry.bytes = used + reservedWriteBytes(entry);
  entry.measuredAt = Date.now();
  return { used, evictions, bytes };
}

/**
 * Measure a directory tree's size ASYNCHRONOUSLY and SEQUENTIALLY (one fs op in flight at a
 * time): it never blocks the event loop, and it occupies at most one libuv threadpool thread,
 * so a slow disk can't starve the pool other async I/O shares.
 */
async function sizeOfDirAsync(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdirAsync(dir, { withFileTypes: true });
  } catch {
    return 0; // missing or unreadable — counts as empty
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sizeOfDirAsync(child);
    } else {
      try {
        total += (await statAsync(child)).size;
      } catch {
        /* vanished mid-walk (GC) — skip */
      }
    }
  }
  return total;
}

/**
 * Bytes AND the newest mtime anywhere in a tree, the root included, in one sequential async walk.
 * lstat throughout: a symlink is judged by itself, never by what it points at. A missing or
 * unreadable tree reports { bytes: 0, newestMtimeMs: 0 } (nothing recent in it).
 */
async function treeStatsAsync(dir: string): Promise<{ bytes: number; newestMtimeMs: number }> {
  let newestMtimeMs = 0;
  let bytes = 0;
  try {
    newestMtimeMs = (await lstatAsync(dir)).mtimeMs;
  } catch {
    return { bytes: 0, newestMtimeMs: 0 };
  }
  for (const name of await listDir(dir)) {
    const child = join(dir, name);
    let st;
    try {
      st = await lstatAsync(child);
    } catch {
      continue; // vanished mid-walk
    }
    if (st.isDirectory()) {
      const sub = await treeStatsAsync(child);
      bytes += sub.bytes;
      if (sub.newestMtimeMs > newestMtimeMs) newestMtimeMs = sub.newestMtimeMs;
    } else {
      bytes += st.size;
      if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
    }
  }
  return { bytes, newestMtimeMs };
}

/**
 * Re-measure a workspace's scratch usage in the background and replace the cached total.
 * Concurrent callers share the one in-flight measurement. Exported for tests and for any host
 * that wants to warm the cache.
 */
export function refreshScratchUsage(workspaceId: string, now: () => number = Date.now): Promise<void> {
  const entry = usageEntry(workspaceId);
  if (entry.refreshing) return entry.refreshing;
  const run = (async () => {
    try {
      const measured = await sizeOfDirAsync(scratchRootForWorkspace(workspaceId));
      // A measurement can race a deferred write; conservatively retain its reservation.
      entry.bytes = measured + reservedWriteBytes(entry);
      entry.measuredAt = now();
    } finally {
      entry.refreshing = null;
    }
  })();
  entry.refreshing = run;
  return run;
}

/** This process's current best-known usage total for a workspace (0 before any measurement). */
export function scratchUsageBytes(workspaceId: string): number {
  return usageState.byWorkspace.get(workspaceId)?.bytes ?? 0;
}

/** Test-only: seed a workspace's cached usage total (skips the measurement). */
export function _setScratchUsageForTests(workspaceId: string, bytes: number, measuredAt = Date.now()): void {
  const entry = usageEntry(workspaceId);
  entry.bytes = bytes;
  entry.measuredAt = measuredAt;
}

/** Test-only: forget every cached usage total. */
export function _resetScratchUsageForTests(): void {
  usageState.byWorkspace.clear();
}

/**
 * Single-write reservation. Throws ScratchQuotaError if writing
 * `bytes` would push the workspace past WORKSPACE_QUOTA_BYTES.
 * Caller is responsible for actually performing the write.
 * Doesn't reserve atomically — concurrent writes could race past
 * the quota by a small margin; acceptable for the chat-tool use
 * case (we're not transactional).
 *
 * O(1) and touches NO filesystem (WI-10004513, owner Avi 2026-10-01). It used to recompute usage
 * with a synchronous recursive readdir+stat of the whole workspace tree on EVERY spill write — ~70k
 * blocking syscalls at 17k run dirs, on the request worker's main thread. Under ext4 contention one
 * of those readdirs blocked >20s in D-state and the event-loop sentinel SIGKILLed the :3070 worker
 * with every in-flight MCP call (61 kills in 6h). It now checks a cached per-workspace total that a
 * background, non-blocking re-measure refreshes every USAGE_REFRESH_MS. Until the first measure
 * lands (just after boot) the total starts at 0, so only the single-write cap applies — the daily
 * runScratchGc quota eviction still bounds the tree.
 */
export function reserveScratchSpace(opts: {
  workspaceId: string;
  bytes: number;
}): void {
  if (opts.bytes < 0) {
    throw new ScratchQuotaError(`scratch reservation: bytes must be non-negative (got ${opts.bytes})`);
  }
  if (opts.bytes > WORKSPACE_QUOTA_BYTES) {
    throw new ScratchQuotaError(
      `scratch reservation: single write of ${opts.bytes} bytes exceeds workspace quota ${WORKSPACE_QUOTA_BYTES}`,
    );
  }
  const entry = usageEntry(opts.workspaceId);
  if (!entry.refreshing && Date.now() - entry.measuredAt >= USAGE_REFRESH_MS) {
    // Fire-and-forget: the caller never waits on the disk. A failed measure keeps the old total.
    void refreshScratchUsage(opts.workspaceId).catch(() => {});
  }
  const used = entry.bytes;
  if (used + opts.bytes > WORKSPACE_QUOTA_BYTES) {
    throw new ScratchQuotaError(
      `scratch reservation: workspace ${opts.workspaceId} used ${used} + ${opts.bytes} > quota ${WORKSPACE_QUOTA_BYTES}`,
    );
  }
  entry.bytes = used + opts.bytes;
}

/**
 * Deferred reference writes recover quota pressure via the existing asynchronous FIFO phase.
 * No synchronous tree scan, no quota increase, and no eviction for an impossible single write.
 * Active/waiting reference paths are protected; concurrent callers share one recovery.
 */
export async function writeWithScratchQuota(
  opts: { workspaceId: string; filePath: string; bytes: number },
  write: () => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(opts.bytes) || opts.bytes < 0 || opts.bytes > WORKSPACE_QUOTA_BYTES) {
    throw new ScratchQuotaError(`scratch reservation: invalid single write of ${opts.bytes} bytes`);
  }
  const entry = usageEntry(opts.workspaceId);
  const token = Symbol();
  const pending = { filePath: opts.filePath, bytes: opts.bytes, reserved: false };
  entry.writes.set(token, pending);
  let succeeded = false;
  try {
    if (entry.recovering) await entry.recovering;
    try {
      reserveScratchSpace(opts);
    } catch (err) {
      if (!(err instanceof ScratchQuotaError)) throw err;
      if (!entry.recovering) {
        entry.recovering = (async () => {
          if (entry.refreshing) await entry.refreshing;
          await evictWorkspaceQuota(opts.workspaceId, () => Math.max(0, WORKSPACE_QUOTA_BYTES -
            [...entry.writes.values()].reduce((sum, request) => sum + request.bytes, 0)));
        })().finally(() => { entry.recovering = null; });
      }
      await entry.recovering;
      reserveScratchSpace(opts); // still full/protected/unreclaimable ⇒ explicit, bounded refusal
    }
    pending.reserved = true;
    await write();
    succeeded = true;
  } finally {
    entry.writes.delete(token);
    if (pending.reserved && !succeeded) entry.bytes = Math.max(0, entry.bytes - opts.bytes);
  }
}

/** Ensure the scratch directory chain exists for a (workspace, tool, run). */
export function ensureScratchRunDir(opts: {
  workspaceId: string;
  toolName: string;
  runId: string;
}): string {
  const dir = join(scratchRootForWorkspace(opts.workspaceId), opts.toolName, opts.runId);
  markNewWorkspaceScratchRootSync(opts.workspaceId, mkdirSync(dir, { recursive: true, mode: 0o700 }));
  return dir;
}

/* ─── GC scheduler ───────────────────────────────────────────────────── */

/**
 * Start the periodic GC sweep. Idempotent — calling twice is a no-op.
 * Hosts call this from instrumentation-node so it survives Next dev
 * HMR / module reloads.
 *
 * The workspace registry getter is passed in (not imported directly)
 * so this module stays free of any operator-side dependencies.
 */
// Legacy startScratchGcScheduler removed (dbos-scheduler-consolidation P-005): DBOS
// owns the schedule (periodic-workflows.ts `scratchGc`). `runScratchGc` above is the
// single-run tick that workflow calls.
