/**
 * Storage growth alarm (infra-perf-reliability-audit-round4-2026-06-19 P-017,
 * lane su-61e7e). The 102 GB substrate_outbox incident (EI-126) grew SILENTLY —
 * the one-time reclaim left recurrence unguarded, and nothing watches PG table
 * growth. This is the missing guard: a periodic READ-ONLY size check that emits a
 * `notifications:recent` toast when any storage category crosses an absolute byte
 * ceiling, so a runaway table is surfaced at GBs, not hundreds of GBs.
 *
 * Stateless by design — an absolute per-category ceiling cannot false-NEGATIVE on
 * a runaway the way a growth-RATE heuristic (which would need persisted history)
 * can. The default ceiling is generous (the telemetry tables are legitimately
 * multi-GB and already retention-bounded); the federation bloat-queue
 * (substrate_outbox) gets a tighter ceiling because it should stay small while
 * draining — that is the exact table that ran away in EI-126.
 *
 * Verify-before-fix (round-2 D-001): the round-4 audit confirmed the existing
 * "unbounded" tables are mostly TOAST-heavy + low-row (activity-bounded, not
 * runaway), so this PREVENTS a future recurrence rather than reclaiming today.
 *
 * Read-only + best-effort: it never throws (mirrors the other periodic monitors),
 * so it can never affect the system it watches.
 */
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { notifySyncInvalidate } from '../sync-sse';
import { computeStorageUsage, type StorageUsageRow } from './usage';

const GIB = 1024 ** 3;
const TOAST_RING_BUFFER = 2000;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Absolute ceiling (GiB) above which a PG category is flagged. The bloat-queue
 *  (substrate_outbox) is the EI-126 102 GB class — it should stay small while
 *  draining, so a much tighter ceiling. Both env-overridable. */
export function categoryCeilingBytes(id: string): number {
  if (id === 'substrate-outbox') return envNum('PAPERCUSP_STORAGE_ALARM_OUTBOX_GB', 3) * GIB;
  return envNum('PAPERCUSP_STORAGE_ALARM_DEFAULT_GB', 10) * GIB;
}

export interface StorageBreach {
  id: string;
  label: string;
  bytes: number;
  ceilingBytes: number;
  trimmable: boolean;
}

export interface GrowthAlarmDeps {
  /** Injectable for tests — defaults to a sizes-only (cheap) usage scan. */
  computeUsage?: () => Promise<StorageUsageRow[]>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

function fmtGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** Pure breach detection over a usage snapshot — unit-testable without PG. Only
 *  PG tables are guarded (the runaway class is a Postgres table, EI-126). */
export function detectBreaches(rows: StorageUsageRow[]): StorageBreach[] {
  const breaches: StorageBreach[] = [];
  for (const r of rows) {
    if (r.kind !== 'pg') continue;
    const ceilingBytes = categoryCeilingBytes(r.id);
    if (r.totalBytes > ceilingBytes) {
      breaches.push({ id: r.id, label: r.label, bytes: r.totalBytes, ceilingBytes, trimmable: r.trimmable });
    }
  }
  return breaches;
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
  // Bound the ring buffer (mirrors agent-governor-observer).
  void (async () => {
    const stale = await db
      .select({ id: tl.id })
      .from(tl)
      .orderBy(desc(tl.createdAt))
      .offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

/** Build the toast body for a set of breaches. Pure — unit-testable. */
export function formatBreachToast(breaches: StorageBreach[]): { level: string; message: string; description: string } {
  const lines = breaches
    .map(
      (b) =>
        `• ${b.label} (${b.id}): ${fmtGb(b.bytes)} > ${fmtGb(b.ceilingBytes)} ceiling${b.trimmable ? '' : ' — read-only/federated'}`,
    )
    .join('\n');
  return {
    level: 'warning',
    message: `Storage growth alarm — ${breaches.length} table(s) over threshold`,
    description:
      `These Postgres tables crossed their size ceiling (the silent-growth guard for the EI-126 102 GB class):\n${lines}\n\n` +
      `Review in Settings → Storage. Tune a ceiling via PAPERCUSP_STORAGE_ALARM_DEFAULT_GB / PAPERCUSP_STORAGE_ALARM_OUTBOX_GB.`,
  };
}

/** One read-only pass: size every storage category, toast on any breach. Never
 *  throws — observability is best-effort, mirroring the other periodic monitors. */
export async function runStorageGrowthAlarmOnce(
  deps: GrowthAlarmDeps = {},
): Promise<{ checked: number; breaches: StorageBreach[] }> {
  const computeUsage = deps.computeUsage ?? (() => computeStorageUsage({ sizesOnly: true }));
  const emitToast = deps.emitToast ?? defaultEmitToast;

  let rows: StorageUsageRow[] = [];
  try {
    rows = await computeUsage();
  } catch (err) {
    console.warn(`[storage-growth-alarm] usage scan skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    return { checked: 0, breaches: [] };
  }

  const breaches = detectBreaches(rows);
  if (breaches.length > 0) {
    try {
      await emitToast(formatBreachToast(breaches));
    } catch (err) {
      console.warn(`[storage-growth-alarm] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
  }
  return { checked: rows.length, breaches };
}
