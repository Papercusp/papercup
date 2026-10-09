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
 * Reserve 256 MiB below the hard quota so the existing background usage refresh can
 * reclaim old runs before a result spill needs request-time FIFO candidate work.
 */
export const SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES = 256 * 1024 * 1024;

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
  /** Live scan counters, exposed to writers waiting for this refresh. */
  refreshDiagnostics: ScratchQuotaRecoveryDiagnostics | null;
  /** One shared pressure recovery; subsequent writers await it before touching disk. */
  recovering: Promise<void> | null;
  writes: Map<symbol, { filePath: string; bytes: number; reserved: boolean }>;
  /** Changes on reservations and deferred write settlement so walks reject mixed snapshots. */
  writeGeneration: number;
  /** A mixed write/measurement snapshot needs one clean re-measurement after writers settle. */
  refreshDeferred: boolean;
  /** Last stable per-run sizes; request-time recovery remeasures FIFO candidates on demand. */
  runBytesByPath: Map<string, number>;
  /** False when the per-run index does not cover a stable, complete workspace measurement. */
  runBytesValid: boolean;
}

/** Per-process cached usage per workspace (WI-10004513). Pinned so a split module record can't
 *  fork it into two caches that each under-count. */
const usageState = pinModuleState('@papercusp/operator-core.scratch-gc.usage', () => ({
  byWorkspace: new Map<string, ScratchUsageEntry>(),
}));

function usageEntry(workspaceId: string): ScratchUsageEntry {
  let entry = usageState.byWorkspace.get(workspaceId);
  if (!entry) {
    entry = {
      bytes: 0, measuredAt: 0, refreshing: null, refreshDiagnostics: null,
      recovering: null, writes: new Map(),
      writeGeneration: 0, refreshDeferred: false, runBytesByPath: new Map(), runBytesValid: false,
    };
    usageState.byWorkspace.set(workspaceId, entry);
  } else {
    // The cache is module-pinned across HMR. Initialize fields added by newer module versions.
    entry.refreshDiagnostics ??= null;
    entry.recovering ??= null;
    entry.writes ??= new Map();
    entry.writeGeneration ??= 0;
    entry.refreshDeferred ??= false;
    entry.runBytesByPath ??= new Map();
    entry.runBytesValid ??= false;
  }
  return entry;
}

function scratchRunDirForFile(workspaceId: string, filePath: string): string | null {
  const root = scratchRootForWorkspace(workspaceId);
  const prefix = `${root}${sep}`;
  if (!filePath.startsWith(prefix)) return null;
  const parts = filePath.slice(prefix.length).split(sep);
  // Scratch writers store files below <workspace>/<tool>/<runId>/.
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  return join(root, parts[0], parts[1]);
}

function adjustCachedRunBytes(
  entry: ScratchUsageEntry,
  workspaceId: string,
  filePath: string,
  delta: number,
): void {
  if (!entry.runBytesValid) return;
  const runDir = scratchRunDirForFile(workspaceId, filePath);
  if (!runDir) {
    entry.runBytesValid = false;
    return;
  }
  const next = (entry.runBytesByPath.get(runDir) ?? 0) + delta;
  if (next <= 0) entry.runBytesByPath.delete(runDir);
  else entry.runBytesByPath.set(runDir, next);
}

function scheduleDeferredUsageRefresh(workspaceId: string, entry: ScratchUsageEntry): void {
  if (!entry.refreshDeferred || entry.writes.size > 0 || entry.refreshing) return;
  entry.refreshDeferred = false;
  void refreshScratchUsage(workspaceId).catch(() => {});
}

/** The same FIFO phase serves the daily sweep and request-time async quota recovery. */
async function evictWorkspaceQuota(
  workspaceId: string,
  targetBytes: () => number,
  reconcileReservations = false,
  diagnostics?: ScratchQuotaRecoveryDiagnostics,
  now: () => number = Date.now,
): Promise<{
  used: number; evictions: number; bytes: number;
}> {
  const wsRoot = scratchRootForWorkspace(workspaceId);
  const entry = usageEntry(workspaceId);
  const writeGeneration = entry.writeGeneration;
  const hadActiveWrites = [...entry.writes.values()].some((write) => write.reserved);
  // Request-time recovery blocks new reservations until this walk finishes. Keep references
  // to existing writers even if they complete during the walk, and account only for bytes
  // the walk did not see. Retaining the old cache here would retain other hosts' deleted runs
  // and falsely refuse every spill while a writer is active.
  const writers = reconcileReservations ? [...entry.writes.values()].filter((write) => write.reserved) : [];
  const observedWriterBytes = new Map(writers.map((write) => [write.filePath, 0]));
  let useCachedRunSizes = reconcileReservations && entry.runBytesValid && !entry.refreshDeferred;
  let entryBytesAtStart = entry.bytes;
  let runs: Array<{ dir: string; mtimeMs: number }> | null = null;
  let cacheChanged = false;
  // Keep a full-walk index for background refreshes and for the conservative fallback when no
  // stable per-run measurement exists. Request-time recovery uses the stable index instead.
  const runBytesByPath = new Map<string, number>();
  let used: number;
  if (useCachedRunSizes) {
    const runListingStartedAt = performance.now();
    runs = await runDirsOf(wsRoot);
    if (diagnostics) {
      diagnostics.runListingMs += Math.max(0, performance.now() - runListingStartedAt);
      diagnostics.runsListed += runs.length;
    }
    if (!entry.runBytesValid || entry.refreshDeferred || runs.some((run) => !entry.runBytesByPath.has(run.dir))) {
      // A synchronous reservation may have invalidated the index while the directory listing
      // yielded, or another process may have added an unindexed run. Fall back to a complete
      // measurement and refresh the candidate listing later.
      useCachedRunSizes = false;
      runs = null;
    }
  }
  if (useCachedRunSizes && runs) {
    const liveRuns = new Set(runs.map((run) => run.dir));
    used = entry.bytes;
    entryBytesAtStart = entry.bytes;
    for (const [runDir, cachedBytes] of entry.runBytesByPath) {
      if (liveRuns.has(runDir)) continue;
      // Another process may have already reclaimed this run. Correct the stale total before
      // deciding how much FIFO eviction is still needed.
      if ([...entry.writes.values()].some((write) => write.filePath.startsWith(runDir + sep))) continue;
      used -= cachedBytes;
      entry.runBytesByPath.delete(runDir);
      cacheChanged = true;
    }
    used = Math.max(0, used);
    if (runs.some((run) => !entry.runBytesByPath.has(run.dir))) cacheChanged = true;
  } else {
    const sizeWalkStartedAt = performance.now();
    try {
      used = await sizeOfDirAsync(wsRoot, observedWriterBytes, runBytesByPath, 0, undefined, diagnostics);
    } finally {
      if (diagnostics) diagnostics.sizeWalkMs += Math.max(0, performance.now() - sizeWalkStartedAt);
    }
  }
  let evictions = 0;
  let bytes = 0;
  const evictedRuns: string[] = [];
  if (used > targetBytes()) {
    if (!runs) {
      const runListingStartedAt = performance.now();
      runs = await runDirsOf(wsRoot);
      if (diagnostics) {
        diagnostics.runListingMs += Math.max(0, performance.now() - runListingStartedAt);
        diagnostics.runsListed += runs.length;
      }
    }
    runs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const run of runs) {
      if (used <= targetBytes()) break;
      if (diagnostics) diagnostics.runsConsidered += 1;
      // A current or waiting write owns its run even when its reservation has not landed yet.
      if ([...entry.writes.values()].some((write) => write.filePath.startsWith(run.dir + sep))) continue;
      // Symlinked tool/run directories are discovered by runDirsOf but are not traversed by
      // the workspace size walk; retain the old fallback for those paths.
      const runSizingStartedAt = performance.now();
      let bytesInRun: number;
      try {
        if (useCachedRunSizes) {
          const cachedBytes = entry.runBytesByPath.get(run.dir) ?? 0;
          // Recheck only the FIFO candidates we may delete. This catches cross-process changes
          // to those runs without recursively sizing every run in the workspace.
          bytesInRun = await sizeOfDirAsync(run.dir, observedWriterBytes);
          if (bytesInRun !== cachedBytes) cacheChanged = true;
          used += bytesInRun - cachedBytes;
          entry.runBytesByPath.set(run.dir, bytesInRun);
        } else {
          const indexedBytes = runBytesByPath.get(run.dir);
          if (indexedBytes === undefined && diagnostics) diagnostics.fallbackRunSizes += 1;
          bytesInRun = indexedBytes ?? await sizeOfDirAsync(run.dir);
          if (indexedBytes === undefined) runBytesByPath.set(run.dir, bytesInRun);
        }
      } finally {
        if (diagnostics) diagnostics.selectedRunSizingMs += Math.max(0, performance.now() - runSizingStartedAt);
      }
      // A writer can join while candidate sizing yields. Preserve its run just as we do for
      // writers already present when the candidate was selected.
      if ([...entry.writes.values()].some((write) => write.filePath.startsWith(run.dir + sep))) continue;
      // The cached total may already be under target once a candidate's stale size is corrected.
      if (used <= targetBytes()) break;
      if (diagnostics) diagnostics.deleteAttempts += 1;
      const deletionStartedAt = performance.now();
      try {
        await rmAsync(run.dir, { recursive: true, force: true });
      } finally {
        if (diagnostics) diagnostics.deletionMs += Math.max(0, performance.now() - deletionStartedAt);
      }
      used -= bytesInRun;
      evictedRuns.push(run.dir);
      if (useCachedRunSizes) entry.runBytesByPath.delete(run.dir);
      else runBytesByPath.delete(run.dir);
      evictions += 1;
      bytes += bytesInRun;
      if (diagnostics) {
        diagnostics.runsDeleted += 1;
        diagnostics.deletedBytes += bytesInRun;
      }
      evictedBytesTotal += bytesInRun;
    }
  }
  const activeWritesAtEnd = [...entry.writes.values()].some((write) => write.reserved);
  const overlappingWrites = hadActiveWrites || activeWritesAtEnd || entry.writeGeneration !== writeGeneration;
  if (reconcileReservations) {
    if (useCachedRunSizes) {
      // The cached total already includes all local reservations. Preserve concurrent settlement
      // deltas if a writer completed while the candidate paths were being remeasured.
      entry.bytes = Math.max(0, overlappingWrites ? entry.bytes + used - entryBytesAtStart : used);
    } else {
      entry.bytes = used + writers.reduce((sum, write) => {
        // A failed writer drops its reservation; a completed writer's run may have been evicted.
        if (!write.reserved || evictedRuns.some((run) => write.filePath.startsWith(run + sep))) return sum;
        return sum + Math.max(0, write.bytes - (observedWriterBytes.get(write.filePath) ?? 0));
      }, 0);
    }
    entry.measuredAt = now();
    entry.refreshDeferred = overlappingWrites || cacheChanged;
    if (useCachedRunSizes) {
      entry.runBytesValid = !entry.refreshDeferred;
    } else if (overlappingWrites) {
      entry.runBytesValid = false;
    } else {
      entry.runBytesByPath = runBytesByPath;
      entry.runBytesValid = [...runBytesByPath.values()].every(Number.isFinite)
        && (!diagnostics || (diagnostics.directoryReadErrors === 0 && diagnostics.fileStatErrors === 0));
    }
  } else if (overlappingWrites) {
    // The size walk may have included only part of an in-flight write. Adjust the prior
    // reservation-based total by exactly the bytes evicted, then re-measure once writers settle.
    entry.bytes = Math.max(0, entry.bytes - bytes);
    entry.refreshDeferred = true;
    entry.runBytesValid = false;
  } else {
    entry.bytes = used;
    entry.measuredAt = now();
    entry.refreshDeferred = false;
    entry.runBytesByPath = runBytesByPath;
    entry.runBytesValid = [...runBytesByPath.values()].every(Number.isFinite)
      && (!diagnostics || (diagnostics.directoryReadErrors === 0 && diagnostics.fileStatErrors === 0));
  }
  scheduleDeferredUsageRefresh(workspaceId, entry);
  return { used, evictions, bytes };
}

const SCRATCH_SIZE_SCAN_MAX_IN_FLIGHT = 2;
let scratchSizeScanInFlight = 0;
const scratchSizeScanWaiters: Array<() => void> = [];

async function withScratchSizeScanSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (scratchSizeScanInFlight < SCRATCH_SIZE_SCAN_MAX_IN_FLIGHT) {
    scratchSizeScanInFlight += 1;
  } else {
    await new Promise<void>((resolve) => scratchSizeScanWaiters.push(resolve));
  }
  try {
    return await operation();
  } finally {
    const next = scratchSizeScanWaiters.shift();
    if (next) next(); // transfer the held slot directly to the next queued filesystem operation
    else scratchSizeScanInFlight -= 1;
  }
}

/**
 * Measure a directory tree asynchronously with a small process-wide I/O bound. Independent
 * entries overlap, while concurrent workspace walks cannot multiply their filesystem pressure
 * without limit; the walk never blocks the event loop.
 */
async function sizeOfDirAsync(
  dir: string,
  observedFileBytes?: Map<string, number>,
  runBytesByPath?: Map<string, number>,
  depth = 0,
  runDir?: string,
  diagnostics?: ScratchQuotaRecoveryDiagnostics,
): Promise<number> {
  if (diagnostics) diagnostics.sizeWalkDirectories += 1;
  let entries;
  try {
    entries = await withScratchSizeScanSlot(() => readdirAsync(dir, { withFileTypes: true }));
  } catch {
    if (diagnostics) diagnostics.directoryReadErrors += 1;
    return 0; // missing or unreadable — counts as empty
  }
  if (diagnostics) diagnostics.sizeWalkEntries += entries.length;
  let total = 0;
  let nextEntry = 0;
  const workerCount = Math.min(SCRATCH_SIZE_SCAN_MAX_IN_FLIGHT, entries.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextEntry < entries.length) {
      const entry = entries[nextEntry++];
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Scratch run directories are exactly the directory level below each tool directory.
        // Record their totals as this normal size walk visits files, so FIFO recovery can reuse
        // them without a second recursive stat pass.
        const childRunDir = runBytesByPath && depth === 1 ? child : runDir;
        if (runBytesByPath && depth === 1) runBytesByPath.set(child, 0);
        const childBytes = await sizeOfDirAsync(child, observedFileBytes, runBytesByPath, depth + 1, childRunDir, diagnostics);
        total += childBytes;
      } else {
        if (runBytesByPath && depth <= 1 && entry.isSymbolicLink()) {
          // The workspace walk counts symlinks as entries rather than traversing them. A
          // per-run index cannot safely represent a symlinked tool/run directory.
          runBytesByPath.set(child, Number.NaN);
        }
        if (diagnostics) diagnostics.sizeWalkFiles += 1;
        try {
          const bytes = (await withScratchSizeScanSlot(() => statAsync(child))).size;
          total += bytes;
          if (observedFileBytes?.has(child)) observedFileBytes.set(child, bytes);
          if (runDir && runBytesByPath) {
            runBytesByPath.set(runDir, (runBytesByPath.get(runDir) ?? 0) + bytes);
          }
        } catch {
          if (diagnostics) diagnostics.fileStatErrors += 1;
          /* vanished mid-walk (GC) — skip */
        }
      }
    }
  }));
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
 * When the tree approaches the hard quota, this same walk also evicts oldest runs to restore
 * headroom. Concurrent callers share the one in-flight measurement. Exported for tests and for
 * any host that wants to warm the cache.
 */
export function refreshScratchUsage(workspaceId: string, now: () => number = Date.now): Promise<void> {
  const entry = usageEntry(workspaceId);
  if (entry.refreshing) return entry.refreshing;
  const diagnostics = newScratchQuotaRecoveryDiagnostics();
  entry.refreshDiagnostics = diagnostics;
  const run = (async () => {
    try {
      await evictWorkspaceQuota(
        workspaceId,
        () => WORKSPACE_QUOTA_BYTES - SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES,
        false,
        diagnostics,
        now,
      );
    } finally {
      entry.refreshDiagnostics = null;
      entry.refreshing = null;
      scheduleDeferredUsageRefresh(workspaceId, entry);
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
export function _setScratchUsageForTests(
  workspaceId: string,
  bytes: number,
  measuredAt = Date.now(),
  preserveRunBytes = false,
): void {
  const entry = usageEntry(workspaceId);
  entry.bytes = bytes;
  entry.measuredAt = measuredAt;
  if (!preserveRunBytes) {
    entry.runBytesByPath.clear();
    entry.runBytesValid = false;
  }
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
  /** Pass the target so a stable per-run usage index can track this reservation. */
  filePath?: string;
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
  const trackedWrite = opts.filePath !== undefined
    && [...entry.writes.values()].some((write) => write.filePath === opts.filePath);
  const refreshDue = !entry.refreshing && !entry.refreshDeferred && Date.now() - entry.measuredAt >= USAGE_REFRESH_MS;
  const used = entry.bytes;
  if (used + opts.bytes > WORKSPACE_QUOTA_BYTES) {
    if (refreshDue) void refreshScratchUsage(opts.workspaceId).catch(() => {});
    throw new ScratchQuotaError(
      `scratch reservation: workspace ${opts.workspaceId} used ${used} + ${opts.bytes} > quota ${WORKSPACE_QUOTA_BYTES}`,
    );
  }
  entry.bytes = used + opts.bytes;
  entry.writeGeneration += 1;
  if (opts.filePath) adjustCachedRunBytes(entry, opts.workspaceId, opts.filePath, opts.bytes);
  else entry.runBytesValid = false;
  // Start after this reservation: only later reservations can invalidate the new walk.
  // Fire-and-forget keeps both accepted and rejected reservations free of filesystem waits.
  // An untracked synchronous writer will call noteScratchWriteSettled after touching disk; defer
  // its refresh until then so the measurement cannot snapshot a half-finished write.
  if (refreshDue && (!opts.filePath || trackedWrite)) void refreshScratchUsage(opts.workspaceId).catch(() => {});
}

/** Notify the usage cache after a synchronous scratch write has settled. */
export function noteScratchWriteSettled(workspaceId: string, needsRefresh = false): void {
  const entry = usageEntry(workspaceId);
  entry.writeGeneration += 1;
  if (needsRefresh || entry.refreshing) {
    entry.runBytesValid = false;
    entry.refreshDeferred = true;
  }
  if (entry.refreshDeferred) {
    scheduleDeferredUsageRefresh(workspaceId, entry);
    return;
  }
  if (!entry.runBytesValid || Date.now() - entry.measuredAt >= USAGE_REFRESH_MS) {
    void refreshScratchUsage(workspaceId).catch(() => {});
  }
}

/**
 * Deferred reference writes recover quota pressure via the existing asynchronous FIFO phase.
 * No synchronous tree scan, no quota increase, and no eviction for an impossible single write.
 * Active/waiting reference paths are protected; concurrent callers share one recovery.
 */
/** Per-write, disjoint elapsed phases. Recovery work belongs to its initiating writer;
 * other writers record the time awaiting that shared recovery as quotaWaitMs. */
export interface ScratchWriteTimings {
  quotaWaitMs: number;
  refreshWaitMs: number;
  quotaRecoveryMs: number;
  writeMs: number;
  totalMs: number;
  /** Present when this write initiated an actual request-time quota-recovery scan. */
  quotaRecoveryDiagnostics?: ScratchQuotaRecoveryDiagnostics;
  /** Present only for the one-shot progress notification while a phase is still pending. */
  progress?: ScratchWriteProgress;
}

export interface ScratchQuotaRecoveryDiagnostics {
  sizeWalkMs: number;
  sizeWalkDirectories: number;
  sizeWalkEntries: number;
  sizeWalkFiles: number;
  directoryReadErrors: number;
  fileStatErrors: number;
  runListingMs: number;
  runsListed: number;
  selectedRunSizingMs: number;
  runsConsidered: number;
  fallbackRunSizes: number;
  deletionMs: number;
  deleteAttempts: number;
  runsDeleted: number;
  deletedBytes: number;
}

function newScratchQuotaRecoveryDiagnostics(): ScratchQuotaRecoveryDiagnostics {
  return {
    sizeWalkMs: 0,
    sizeWalkDirectories: 0,
    sizeWalkEntries: 0,
    sizeWalkFiles: 0,
    directoryReadErrors: 0,
    fileStatErrors: 0,
    runListingMs: 0,
    runsListed: 0,
    selectedRunSizingMs: 0,
    runsConsidered: 0,
    fallbackRunSizes: 0,
    deletionMs: 0,
    deleteAttempts: 0,
    runsDeleted: 0,
    deletedBytes: 0,
  };
}

export interface ScratchWriteProgress {
  phase: 'quota-wait' | 'usage-refresh-wait' | 'quota-recovery' | 'file-write';
  phaseElapsedMs: number;
  totalElapsedMs: number;
  bytes: number;
  pendingWrites: number;
  recoveryActive: boolean;
  refreshActive: boolean;
  quotaRecoveryDiagnostics?: ScratchQuotaRecoveryDiagnostics;
  usageRefreshDiagnostics?: ScratchQuotaRecoveryDiagnostics;
}

const SCRATCH_WRITE_PROGRESS_AFTER_MS = 5_000;

export async function writeWithScratchQuota(
  opts: { workspaceId: string; filePath: string; bytes: number;
    onTiming?: (timings: ScratchWriteTimings) => void },
  write: () => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(opts.bytes) || opts.bytes < 0 || opts.bytes > WORKSPACE_QUOTA_BYTES) {
    throw new ScratchQuotaError(`scratch reservation: invalid single write of ${opts.bytes} bytes`);
  }
  const entry = usageEntry(opts.workspaceId);
  const token = Symbol();
  const pending = { filePath: opts.filePath, bytes: opts.bytes, reserved: false };
  entry.writes.set(token, pending);
  const startedAt = performance.now();
  const timings: ScratchWriteTimings = {
    quotaWaitMs: 0, refreshWaitMs: 0, quotaRecoveryMs: 0, writeMs: 0, totalMs: 0,
  };
  let activeRecoveryDiagnostics: ScratchQuotaRecoveryDiagnostics | undefined;
  const timed = async (
    phase: 'quotaWaitMs' | 'refreshWaitMs' | 'quotaRecoveryMs' | 'writeMs',
    run: () => Promise<void>,
  ) => {
    const start = performance.now();
    const progressPhase = {
      quotaWaitMs: 'quota-wait',
      refreshWaitMs: 'usage-refresh-wait',
      quotaRecoveryMs: 'quota-recovery',
      writeMs: 'file-write',
    }[phase] as ScratchWriteProgress['phase'];
    const progressTimer = opts.onTiming
      ? setTimeout(() => {
          const phaseElapsedMs = Math.max(0, performance.now() - start);
          try {
            opts.onTiming?.({
              ...timings,
              progress: {
                phase: progressPhase,
                phaseElapsedMs,
                totalElapsedMs: Math.max(0, performance.now() - startedAt),
                bytes: opts.bytes,
                pendingWrites: entry.writes.size,
                recoveryActive: Boolean(entry.recovering),
                refreshActive: Boolean(entry.refreshing),
                ...(phase === 'quotaRecoveryMs' && activeRecoveryDiagnostics
                  ? { quotaRecoveryDiagnostics: { ...activeRecoveryDiagnostics } }
                  : {}),
                ...(phase === 'refreshWaitMs' && entry.refreshDiagnostics
                  ? { usageRefreshDiagnostics: { ...entry.refreshDiagnostics } }
                  : {}),
              },
            });
          } catch {
            // Diagnostics must never replace a write failure or invalidate a cursor.
          }
        }, SCRATCH_WRITE_PROGRESS_AFTER_MS)
      : undefined;
    (progressTimer as { unref?: () => void } | undefined)?.unref?.();
    try {
      await run();
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
      timings[phase] += Math.max(0, performance.now() - start);
    }
  };
  let succeeded = false;
  try {
    if (entry.recovering) await timed('quotaWaitMs', () => entry.recovering!);
    try {
      reserveScratchSpace({ workspaceId: opts.workspaceId, bytes: opts.bytes, filePath: opts.filePath });
    } catch (err) {
      if (!(err instanceof ScratchQuotaError)) throw err;
      const startsRecovery = !entry.recovering;
      if (!entry.recovering) {
        entry.recovering = (async () => {
          if (entry.refreshing) await timed('refreshWaitMs', () => entry.refreshing!);
          // Waiters have not touched disk, so they do not invalidate a background walk.
          // Reuse its reconciled total when it already makes room for the queued writes;
          // otherwise every stale-quota spill pays for the same full-tree scan twice.
          const waitingBytes = [...entry.writes.values()].reduce((sum, request) =>
            sum + (request.reserved ? 0 : request.bytes), 0);
          if (entry.bytes + waitingBytes <= WORKSPACE_QUOTA_BYTES) return;
          await timed('quotaRecoveryMs', async () => {
            const diagnostics = newScratchQuotaRecoveryDiagnostics();
            activeRecoveryDiagnostics = diagnostics;
            try {
              await evictWorkspaceQuota(opts.workspaceId, () => Math.max(0,
                WORKSPACE_QUOTA_BYTES - SCRATCH_QUOTA_RECOVERY_HEADROOM_BYTES -
                [...entry.writes.values()].reduce((sum, request) => sum + request.bytes, 0)), true, diagnostics);
            } finally {
              timings.quotaRecoveryDiagnostics = { ...diagnostics };
              activeRecoveryDiagnostics = undefined;
            }
          });
        })().finally(() => { entry.recovering = null; });
      }
      if (startsRecovery) await entry.recovering;
      else await timed('quotaWaitMs', () => entry.recovering!);
      reserveScratchSpace({ workspaceId: opts.workspaceId, bytes: opts.bytes, filePath: opts.filePath }); // still full/protected/unreclaimable ⇒ explicit, bounded refusal
    }
    pending.reserved = true;
    await timed('writeMs', write);
    succeeded = true;
  } finally {
    entry.writes.delete(token);
    if (pending.reserved) entry.writeGeneration += 1;
    if (pending.reserved && !succeeded) {
      entry.bytes = Math.max(0, entry.bytes - opts.bytes);
      pending.reserved = false;
      adjustCachedRunBytes(entry, opts.workspaceId, opts.filePath, -opts.bytes);
    }
    scheduleDeferredUsageRefresh(opts.workspaceId, entry);
    timings.totalMs = Math.max(0, performance.now() - startedAt);
    // Diagnostic observers must never replace a write failure or invalidate a readable cursor.
    try { opts.onTiming?.(timings); } catch { /* diagnostics only */ }
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
