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
import { tmpdir } from 'node:os';
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { escalateAlarm } from '../alarm-attention';
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
  /** CRITICAL tier (EI-20090527288494606): below this fraction, a breach stops
   *  being "getting full" and becomes "writes are about to fail" — it escalates
   *  to a human instead of only toasting. Must be TIGHTER than freePctMin. */
  criticalFreePctMin: number;
  /** …or below this absolute byte floor. Must be TIGHTER than freeBytesMin. */
  criticalFreeBytesMin: number;
}

export const DEFAULT_DISK_POLICY: DiskAlarmPolicy = {
  freePctMin: 0.1, // 10%
  freeBytesMin: 5 * GIB,
  freeInodesPctMin: 0.05, // 5%
  criticalFreePctMin: 0.02, // 2%
  criticalFreeBytesMin: 2 * GIB,
};

export function diskPolicyFromEnv(): DiskAlarmPolicy {
  return {
    freePctMin: envNum('PAPERCUSP_DISK_ALARM_FREE_PCT', DEFAULT_DISK_POLICY.freePctMin * 100) / 100,
    freeBytesMin: envNum('PAPERCUSP_DISK_ALARM_FREE_GB', DEFAULT_DISK_POLICY.freeBytesMin / GIB) * GIB,
    freeInodesPctMin: envNum('PAPERCUSP_DISK_ALARM_FREE_INODES_PCT', DEFAULT_DISK_POLICY.freeInodesPctMin * 100) / 100,
    criticalFreePctMin:
      envNum('PAPERCUSP_DISK_ALARM_CRITICAL_PCT', DEFAULT_DISK_POLICY.criticalFreePctMin * 100) / 100,
    criticalFreeBytesMin:
      envNum('PAPERCUSP_DISK_ALARM_CRITICAL_GB', DEFAULT_DISK_POLICY.criticalFreeBytesMin / GIB) * GIB,
  };
}

/** The watched filesystems (one statfs per path). Defaults to the workspaces root plus the
 *  process temp root: test module caches can live on a separate filesystem and fill it while the
 *  repo filesystem remains healthy (EI-21047688909295463). Extra paths via
 *  PAPERCUSP_DISK_ALARM_PATHS (comma-separated). */
export function watchedPaths(): string[] {
  const extra = (process.env.PAPERCUSP_DISK_ALARM_PATHS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const all = [workspacesRoot(), tmpdir(), ...extra];
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

/** 'warning' = getting full (toast only). 'critical' = writes are about to fail
 *  (escalates to a human). See EI-20090527288494606. */
export type DiskBreachSeverity = 'warning' | 'critical';

export interface DiskBreach {
  path: string;
  kinds: DiskBreachKind[];
  severity: DiskBreachSeverity;
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
      // Severity is a BYTES question only: an inode shortage is real but does not
      // mean the next multi-GB write dies mid-copy, which is what the critical tier
      // exists to escalate.
      const critical =
        s.freeBytes < policy.criticalFreeBytesMin || s.freePct < policy.criticalFreePctMin;
      out.push({
        path: s.path,
        kinds,
        severity: critical ? 'critical' : 'warning',
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

/**
 * Fail-closed write headroom for expensive jobs such as the green checkpoint.
 *
 * Reuse the standing disk alarm's CRITICAL byte thresholds: its warning band is
 * intentionally early enough for a human cleanup nudge, while a checkpoint only
 * needs to refuse when writes are plausibly about to fail. Inode exhaustion stays
 * at the alarm's ordinary floor because it produces ENOSPC just as surely as byte
 * exhaustion. Keeping this as a policy projection over {@link detectLowSpace}
 * prevents the gate and the alarm from inventing two definitions of a full disk.
 */
export function detectCriticalWriteHeadroom(
  snapshots: DiskSnapshot[],
  policy: DiskAlarmPolicy = DEFAULT_DISK_POLICY,
): DiskBreach[] {
  return detectLowSpace(snapshots, {
    ...policy,
    freePctMin: policy.criticalFreePctMin,
    freeBytesMin: policy.criticalFreeBytesMin,
  });
}

/**
 * Minimum free bytes that keep a filesystem OUTSIDE the alarm's critical byte
 * band. This is the scalar form of {@link detectCriticalWriteHeadroom} for a
 * writer that must budget its own transient demand before it starts.
 *
 * The alarm's byte rule is an OR (absolute floor OR percentage floor), so the
 * equivalent reserve is the larger threshold. Invalid totals retain the
 * absolute floor instead of manufacturing percentage headroom from bad input.
 */
export function criticalWriteHeadroomBytes(
  totalBytes: number,
  policy: DiskAlarmPolicy = DEFAULT_DISK_POLICY,
): number {
  const absolute =
    Number.isFinite(policy.criticalFreeBytesMin) && policy.criticalFreeBytesMin > 0
      ? policy.criticalFreeBytesMin
      : 0;
  const proportional =
    Number.isFinite(totalBytes) &&
    totalBytes > 0 &&
    Number.isFinite(policy.criticalFreePctMin) &&
    policy.criticalFreePctMin > 0
      ? totalBytes * policy.criticalFreePctMin
      : 0;
  return Math.max(absolute, proportional);
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
  /** Injectable for tests — defaults to notifyAttention (mobile push + desktop
   *  native notification + a durable attention_notifications row). */
  escalate?: (t: { title: string; body: string }) => Promise<void>;
  /** Injectable for tests — the persistent cross-restart cooldown floor. */
  recentlyEscalated?: () => Promise<boolean>;
}

/**
 * How often a still-critical filesystem may re-ping a human. The alarm TICKS
 * every 30min; without this floor a disk that stays full escalates 48×/day and
 * the human learns to ignore it — which is the same dead channel this escalation
 * exists to replace, just louder.
 */
const ESCALATE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

const ESCALATION_TITLE = 'Disk critically low';

/** Build the human-facing escalation body. Pure — unit-testable. */
export function formatDiskEscalation(critical: DiskBreach[]): { title: string; body: string } {
  const worst = [...critical].sort((a, b) => a.freePct - b.freePct)[0];
  const others = critical.length > 1 ? ` (+${critical.length - 1} more)` : '';
  return {
    title: ESCALATION_TITLE,
    body:
      `${worst.path}: ${fmtGb(worst.freeBytes)} free (${(worst.freePct * 100).toFixed(1)}% of ${fmtGb(worst.totalBytes)})${others}. ` +
      `Builds and writes will start failing mid-operation. Free space now.`,
  };
}

/** Sample explicit paths, or the standing watched-path set when omitted. Exported
 * so correctness-critical writers can reuse the alarm's statfs interpretation. */
export async function sampleDiskSnapshots(paths: string[] = watchedPaths()): Promise<DiskSnapshot[]> {
  const out: DiskSnapshot[] = [];
  for (const path of paths) {
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
): Promise<{ checked: number; breaches: DiskBreach[]; escalated: boolean }> {
  const sample = deps.sample ?? sampleDiskSnapshots;
  const emitToast = deps.emitToast ?? defaultEmitToast;
  const escalate = deps.escalate;
  const recentlyEscalated = deps.recentlyEscalated;

  let snapshots: DiskSnapshot[] = [];
  try {
    snapshots = await sample();
  } catch (err) {
    console.warn(`[disk-space-alarm] sample skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    return { checked: 0, breaches: [], escalated: false };
  }

  const breaches = detectLowSpace(snapshots, policy);
  if (breaches.length > 0) {
    try {
      await emitToast(formatDiskAlarmToast(breaches));
    } catch (err) {
      console.warn(`[disk-space-alarm] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
  }

  // CRITICAL tier (EI-20090527288494606): the toast above is a UI-only surface —
  // it fired 318 times over 8 days while this box sat under 1% free and NOTHING
  // consumed it, so the condition was only ever discovered by a build dying
  // mid-copy. A critical breach must reach a human on a rail that leaves a
  // durable record. Best-effort + never throws, exactly like the toast.
  let escalated = false;
  const critical = breaches.filter((b) => b.severity === 'critical');
  if (critical.length > 0) {
    const request = formatDiskEscalation(critical);
    escalated = await escalateAlarm(
      {
        ...request,
        cooldownMs: ESCALATE_COOLDOWN_MS,
        source: 'disk-space-alarm',
      },
      { notify: escalate, recentlyEscalated },
    );
  }
  return { checked: snapshots.length, breaches, escalated };
}
