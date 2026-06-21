/**
 * Disk / inode low-free-space tripwire
 * (infra-fail-fast-build-integrity-2026-06-19 P-018 / D5).
 *
 * Today the only defense against a full filesystem is one-time manual prunes —
 * there is NO standing signal, so a disk filling from logs / scratch / build
 * artifacts / kopia backups / PG WAL goes silent until writes start failing
 * (which on this single-Node operator means wedged handlers behind a green health
 * check, the exact silent-hang class this plan exists to kill). `storage:usage`
 * measures directory/table SIZES; `backups/healthcheck` reads free space but only
 * on-demand. This is the missing periodic GUARD: a read-only `statfs` probe that
 * emits a `notifications:recent` toast when free BYTES or free INODES on a watched
 * filesystem fall below a floor — surfaced at "getting full", not at "full".
 *
 * Mirrors its siblings (storage-growth-alarm, test-desktop-reaper): pure detection
 * + an injectable, never-throws one-shot, wired as a shed-gated periodic tick.
 * Read-only — it can never affect the system it watches.
 */
import { promisify } from 'node:util';
import { statfs as statfsCb } from 'node:fs';
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { notifySyncInvalidate } from '../sync-sse';
import { workspacesRoot } from '../workspace-registry';

const statfs = promisify(statfsCb);
const GIB = 1024 ** 3;
const TOAST_RING_BUFFER = 2000;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Policy ─────────────────────────────────────────────────────────────────────

export interface DiskAlarmPolicy {
  /** Flag when free space drops below this fraction of total (0–1). */
  freePctMin: number;
  /** …or below this absolute byte floor (catches a huge disk that is %-fine but
   *  nearly out in absolute terms). */
  freeBytesMin: number;
  /** Flag when free inodes drop below this fraction of total (0–1). Skipped on
   *  filesystems that do not report inodes (totalInodes === 0, e.g. btrfs). */
  freeInodesPctMin: number;
}

export const DEFAULT_DISK_POLICY: DiskAlarmPolicy = {
  freePctMin: 0.1, // 10%
  freeBytesMin: 5 * GIB,
  freeInodesPctMin: 0.05, // 5%
};

export function diskPolicyFromEnv(): DiskAlarmPolicy {
  return {
    freePctMin: envNum('PAPERCUSP_DISK_ALARM_FREE_PCT', DEFAULT_DISK_POLICY.freePctMin * 100) / 100,
    freeBytesMin: envNum('PAPERCUSP_DISK_ALARM_FREE_GB', DEFAULT_DISK_POLICY.freeBytesMin / GIB) * GIB,
    freeInodesPctMin: envNum('PAPERCUSP_DISK_ALARM_FREE_INODES_PCT', DEFAULT_DISK_POLICY.freeInodesPctMin * 100) / 100,
  };
}

/** The watched filesystems (one statfs per path). Defaults to the workspaces root
 *  — repo, PG, scratch and backups all live under it on this host. Extra paths via
 *  PAPERCUSP_DISK_ALARM_PATHS (comma-separated). */
export function watchedPaths(): string[] {
  const extra = (process.env.PAPERCUSP_DISK_ALARM_PATHS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const all = [workspacesRoot(), ...extra];
  return [...new Set(all)]; // dedup identical paths
}

// ── Pure detection ─────────────────────────────────────────────────────────────

export interface DiskSnapshot {
  path: string;
  totalBytes: number;
  freeBytes: number;
  /** 0–1, freeBytes/totalBytes. */
  freePct: number;
  /** 0 when the filesystem does not report inodes. */
  totalInodes: number;
  freeInodes: number;
  /** 0–1, freeInodes/totalInodes (0 when totalInodes === 0). */
  freeInodesPct: number;
}

export type DiskBreachKind = 'low-bytes' | 'low-inodes';

export interface DiskBreach {
  path: string;
  kinds: DiskBreachKind[];
  freeBytes: number;
  totalBytes: number;
  freePct: number;
  freeInodes: number;
  totalInodes: number;
  freeInodesPct: number;
}

/** Pure low-space detection over a snapshot — unit-testable without a real FS. A
 *  filesystem breaches on low BYTES (below the % floor OR the absolute floor) or
 *  low INODES (below the inode % floor, only when inodes are reported). */
export function detectLowSpace(snapshots: DiskSnapshot[], policy: DiskAlarmPolicy = DEFAULT_DISK_POLICY): DiskBreach[] {
  const out: DiskBreach[] = [];
  for (const s of snapshots) {
    const kinds: DiskBreachKind[] = [];
    if (s.freeBytes < policy.freeBytesMin || s.freePct < policy.freePctMin) kinds.push('low-bytes');
    if (s.totalInodes > 0 && s.freeInodesPct < policy.freeInodesPctMin) kinds.push('low-inodes');
    if (kinds.length > 0) {
      out.push({
        path: s.path,
        kinds,
        freeBytes: s.freeBytes,
        totalBytes: s.totalBytes,
        freePct: s.freePct,
        freeInodes: s.freeInodes,
        totalInodes: s.totalInodes,
        freeInodesPct: s.freeInodesPct,
      });
    }
  }
  return out;
}

function fmtGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** Build the alarm toast body. Pure — unit-testable. */
export function formatDiskAlarmToast(breaches: DiskBreach[]): { level: string; message: string; description: string } {
  const lines = breaches
    .map((b) => {
      const bits: string[] = [];
      if (b.kinds.includes('low-bytes')) {
        bits.push(`${fmtGb(b.freeBytes)} free (${(b.freePct * 100).toFixed(1)}% of ${fmtGb(b.totalBytes)})`);
      }
      if (b.kinds.includes('low-inodes')) {
        bits.push(`${(b.freeInodesPct * 100).toFixed(1)}% inodes free`);
      }
      return `• ${b.path}: ${bits.join(', ')}`;
    })
    .join('\n');
  return {
    level: 'warning',
    message: `Disk space alarm — ${breaches.length} filesystem(s) low`,
    description:
      `A watched filesystem is running low (the silent-disk-full guard — a full FS wedges the single-Node operator behind a green health check):\n${lines}\n\n` +
      `Free space (prune scratch / old backups / logs) before writes start failing. ` +
      `Tune via PAPERCUSP_DISK_ALARM_FREE_PCT / _FREE_GB / _FREE_INODES_PCT; add paths with PAPERCUSP_DISK_ALARM_PATHS; disable with PAPERCUSP_DISK_SPACE_ALARM=0.`,
  };
}

// ── Impure sampling + emit (injectable; never throws) ──────────────────────────

export interface DiskAlarmDeps {
  /** Injectable for tests — defaults to a `statfs` probe of watchedPaths(). */
  sample?: () => Promise<DiskSnapshot[]>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

async function defaultSample(): Promise<DiskSnapshot[]> {
  const out: DiskSnapshot[] = [];
  for (const path of watchedPaths()) {
    try {
      const fsst = await statfs(path);
      const bsize = Number(fsst.bsize) || 0;
      const blocks = Number(fsst.blocks) || 0;
      const bavail = Number(fsst.bavail) || 0;
      const files = Number(fsst.files) || 0;
      const ffree = Number(fsst.ffree) || 0;
      const totalBytes = blocks * bsize;
      const freeBytes = bavail * bsize;
      out.push({
        path,
        totalBytes,
        freeBytes,
        freePct: totalBytes > 0 ? freeBytes / totalBytes : 1,
        totalInodes: files,
        freeInodes: ffree,
        freeInodesPct: files > 0 ? ffree / files : 0,
      });
    } catch (err) {
      // A single unreadable path must not sink the whole probe.
      console.warn(`[disk-space-alarm] statfs(${path}) failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
  }
  return out;
}

async function defaultEmitToast(t: { level: string; message: string; description: string }): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors storage-growth-alarm / agent-governor-observer).
  void (async () => {
    const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

/**
 * One read-only pass: statfs the watched filesystems, toast on any low-space
 * breach. Never throws — observability is best-effort, mirroring the other
 * periodic monitors.
 */
export async function runDiskSpaceAlarmOnce(
  deps: DiskAlarmDeps = {},
  policy: DiskAlarmPolicy = diskPolicyFromEnv(),
): Promise<{ checked: number; breaches: DiskBreach[] }> {
  const sample = deps.sample ?? defaultSample;
  const emitToast = deps.emitToast ?? defaultEmitToast;

  let snapshots: DiskSnapshot[] = [];
  try {
    snapshots = await sample();
  } catch (err) {
    console.warn(`[disk-space-alarm] sample skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    return { checked: 0, breaches: [] };
  }

  const breaches = detectLowSpace(snapshots, policy);
  if (breaches.length > 0) {
    try {
      await emitToast(formatDiskAlarmToast(breaches));
    } catch (err) {
      console.warn(`[disk-space-alarm] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
  }
  return { checked: snapshots.length, breaches };
}
