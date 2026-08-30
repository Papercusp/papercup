/**
 * Fleet-logs retention GC — WI-224710 cause #2 ("`fleet-logs` grows without
 * bound").
 *
 * Every headless-spawn launch path backs its session with a log file instead
 * of a desktop window under `papercuspPathForWorkspace(workspaceId,
 * 'fleet-logs')` (launch-agent, launch-on-plan, goals/start,
 * fleet-headcount-action, delegated-spawn-honor, goal-auto-start, launch-su,
 * console-launch, revive-responder). None of those writers ever deletes
 * anything, so the directory grows forever. Measured live 2026-08-30 on
 * papercusp: 25G / 2,946 files in ONE such directory, on a filesystem sitting
 * at 98% used with only ~46.5G of the required 2%-floor headroom left — this
 * one directory alone was over half the remaining disk margin the
 * green-checkpoint gate needs to render a verdict at all (a prior
 * "unbounded fleet-logs" re-validation checked the wrong, non-existent
 * `~/.papercusp/fleet-logs` path and concluded this cause was minor; the real
 * per-workspace path was never actually measured — see WI-224710 comment
 * history).
 *
 * Two independent bounds, matching WI-224710's originally proposed fix:
 *   1. AGE — delete any file whose mtime is older than `retentionMs`.
 *   2. TOTAL-BYTES CEILING — after the age pass, if a directory is still over
 *      `maxTotalBytes`, delete additional files OLDEST-mtime-first until
 *      under it. The safety net against a burst of spawns outrunning the age
 *      window between sweeps.
 *
 * Deliberately NOT scoped here: a per-file size cap / truncation of an
 * individual huge (multi-GB) log. Doing that safely requires knowing the
 * file is not still open for append by a live writer — getting that wrong
 * corrupts a live agent's log mid-write. The two bounds above already evict
 * an outlier once it ages out or the directory crosses the ceiling; a single
 * runaway writer producing a multi-GB log is a separate bug in whatever
 * produces it (WI-224710 thread comment 78848's decomposition item (b), "the
 * actual disk drivers" — not gate-owned, needs its own lane).
 *
 * Best-effort, never throws: a vanished/locked file is skipped, one
 * unreadable directory doesn't abort the sweep (readdir failure → treated as
 * an empty directory), and every deletion failure is collected in the result
 * rather than raised. Purely mtime-based (matches the existing
 * `pruneOldLogs` used for checkpoint-logs retention, apps/operator's
 * green-checkpoint.ts): a live, actively-written log's mtime keeps advancing,
 * so a genuinely in-use file is never caught by the age bound.
 */
import { readdirSync, statSync, unlinkSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { workspacesRoot } from './workspace-registry';

/** 3 days: long enough to debug a recent spawn, short enough to keep the
 *  steady-state footprint well clear of the disk-headroom floor. */
export const FLEET_LOGS_GC_DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** 10 GiB per fleet-logs directory: a burst safety net independent of age. */
export const FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;

export interface FleetLogsGcOptions {
  retentionMs?: number;
  maxTotalBytes?: number;
  dryRun?: boolean;
  /** Injectable for tests: sweep exactly these directories instead of
   *  discovering them from the on-disk workspace registry. */
  dirs?: string[];
}

export interface FleetLogsGcDirResult {
  dir: string;
  scanned: number;
  removedByAge: number;
  removedByCeiling: number;
  bytesFreed: number;
  bytesRemaining: number;
  errors: Array<{ path: string; error: string }>;
}

export interface FleetLogsGcResult {
  dirs: FleetLogsGcDirResult[];
  dryRun: boolean;
}

/** Every `fleet-logs` directory that plausibly exists on this host: one per
 *  workspace dir actually present on disk, plus the legacy home-root path.
 *  Discovered from the filesystem itself (not `backgroundWorkspaceIds()`,
 *  which reflects which workspace this PROCESS is scoped to, not which
 *  workspace DIRECTORIES exist) so an orphaned/inactive workspace's logs are
 *  swept too — the disk doesn't care which workspace is active. A missing
 *  directory is simply never discovered; sweeping it is a no-op regardless
 *  (readdirSync failure inside gcOneDir is treated as "nothing to scan"). */
function discoverFleetLogsDirs(): string[] {
  const dirs = new Set<string>();
  dirs.add(join(homedir(), '.papercusp', 'fleet-logs'));
  let entries: Dirent[];
  try {
    entries = readdirSync(workspacesRoot(), { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    dirs.add(join(workspacesRoot(), entry.name, '.papercusp', 'fleet-logs'));
  }
  return [...dirs];
}

function listFilesWithStat(dir: string): Array<{ path: string; mtimeMs: number; size: number }> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // fleet-logs is a flat directory of *.log files
    const p = join(dir, entry.name);
    try {
      const st = statSync(p);
      out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* vanished between readdir and stat — skip, not an error */
    }
  }
  return out;
}

function gcOneDir(
  dir: string,
  retentionMs: number,
  maxTotalBytes: number,
  dryRun: boolean,
): FleetLogsGcDirResult {
  const files = listFilesWithStat(dir);
  const errors: Array<{ path: string; error: string }> = [];
  const cutoff = Date.now() - retentionMs;
  let removedByAge = 0;
  let removedByCeiling = 0;
  let bytesFreed = 0;

  // Pass 1: age. Whatever survives goes into `remaining` for the ceiling pass.
  const remaining: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const f of files) {
    if (f.mtimeMs >= cutoff) {
      remaining.push(f);
      continue;
    }
    if (!dryRun) {
      try {
        unlinkSync(f.path);
      } catch (e) {
        errors.push({ path: f.path, error: (e as Error)?.message ?? String(e) });
        remaining.push(f); // failed to remove — still occupies bytes
        continue;
      }
    }
    removedByAge++;
    bytesFreed += f.size;
  }

  // Pass 2: total-bytes ceiling, oldest-mtime-first, over whatever the age
  // pass left behind (including anything a dry run "would have" removed —
  // a dry run reports what pass 1 alone would free plus what pass 2 would
  // additionally free from the age-surviving set, which is the accurate
  // picture: pass 2 never needs to reconsider a file pass 1 already marked).
  remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = remaining.reduce((s, f) => s + f.size, 0);
  for (const f of remaining) {
    if (total <= maxTotalBytes) break;
    if (!dryRun) {
      try {
        unlinkSync(f.path);
      } catch (e) {
        errors.push({ path: f.path, error: (e as Error)?.message ?? String(e) });
        continue; // still occupies bytes — leave it in `total`
      }
    }
    total -= f.size;
    bytesFreed += f.size;
    removedByCeiling++;
  }

  return {
    dir,
    scanned: files.length,
    removedByAge,
    removedByCeiling,
    bytesFreed,
    bytesRemaining: total,
    errors,
  };
}

/** Run one sweep. Pure w.r.t. its inputs (`dirs` overrides discovery), so a
 *  test never has to mock the workspace registry — it just points at a tmp
 *  dir. Never throws. */
export function runFleetLogsGc(opts: FleetLogsGcOptions = {}): FleetLogsGcResult {
  const retentionMs = opts.retentionMs ?? FLEET_LOGS_GC_DEFAULT_RETENTION_MS;
  const maxTotalBytes = opts.maxTotalBytes ?? FLEET_LOGS_GC_DEFAULT_MAX_TOTAL_BYTES;
  const dryRun = opts.dryRun === true;
  const dirs = opts.dirs ?? discoverFleetLogsDirs();
  return {
    dirs: dirs.map((d) => gcOneDir(d, retentionMs, maxTotalBytes, dryRun)),
    dryRun,
  };
}
