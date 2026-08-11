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
 * TWO INDEPENDENT LEGS (EI-7518). The category-ceiling leg above walks
 * `computeStorageUsage()`, which iterates STORAGE_CATEGORIES — so it can only
 * ever see tables somebody REGISTERED. A table nobody registered produces no
 * row and therefore cannot breach at ANY size, which left this alarm unable to
 * catch its own motivating case: a table growing unwatched *because* it was
 * never declared. `detectUndeclaredGrowth` is the second leg — it sweeps the
 * catalog directly (`pg_stat_user_tables`, NOT the category list) for tables
 * over a floor that carry no recorded retention decision. Measured 2026-08-03,
 * five such tables held ~278 MB, the largest being `pot_throughput_ticks` at
 * 167 MB / 410,510 rows with zero DELETE sites anywhere in the tree.
 *
 * Read-only + best-effort: it never throws (mirrors the other periodic monitors),
 * so it can never affect the system it watches.
 */
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { escalateAlarm } from '../alarm-attention';
import { notifySyncInvalidate } from '../sync-sse';
import { isPgCategory, STORAGE_CATEGORIES } from './categories';
import { computeStorageUsage, type StorageUsageRow } from './usage';

const GIB = 1024 ** 3;
const TOAST_RING_BUFFER = 2000;
const STORAGE_GROWTH_ESCALATE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const STORAGE_GROWTH_ESCALATION_TITLE = 'Storage growth critical';

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
  /** Injectable for tests — defaults to a live `pg_stat_user_tables` size scan.
   *  Feeds the UNDECLARED sweep below, which deliberately does NOT go through
   *  `computeStorageUsage` (that is category-derived — the blind spot). */
  listTableSizes?: () => Promise<TableSizeRow[]>;
  /** Injectable for tests — defaults to the shared attention-notify rail. */
  escalate?: (t: { title: string; body: string }) => Promise<void>;
  /** Injectable for tests — the persistent cross-restart cooldown floor. */
  recentlyEscalated?: () => Promise<boolean>;
}

/** One physical table's size, straight from the catalog — NOT category-derived. */
export interface TableSizeRow {
  table: string;
  totalBytes: number;
  rows: number;
}

/** An undeclared table over the floor: growing, and owned by no retention policy. */
export interface UndeclaredGrowth {
  table: string;
  bytes: number;
  rows: number;
  floorBytes: number;
}

/**
 * Floor above which a `harness_shared` table is EXPECTED to carry a retention
 * decision. Deliberately far tighter than `categoryCeilingBytes` (GBs): a
 * declared table is watched and owned, so it earns a generous ceiling; an
 * UNDECLARED one is by definition unowned, which is the higher-risk class and
 * the one that historically ran to 102 GB unnoticed (EI-126).
 */
export function undeclaredFloorBytes(): number {
  return envNum('PAPERCUSP_STORAGE_ALARM_UNDECLARED_MB', 128) * 1024 * 1024;
}

/**
 * Tables that carry a retention decision made SOMEWHERE OTHER than
 * `STORAGE_CATEGORIES` — each with the evidence for it. Without this map the
 * sweep below would report a table as unowned merely because its owner is a
 * bespoke GC actor rather than a declared category, which is a FALSE "nothing
 * prunes this" — the precise error that makes a coverage audit untrustworthy.
 *
 * ⚠ An entry here is a CLAIM that something prunes the table. Add one only with
 * the deleting call site verified (`grep -n "delete from harness_shared.<t>"`),
 * never because a table "looks managed" or "is probably fine".
 *
 * Absence from this map is NOT an accusation — it means no retention decision
 * has been RECORDED for that table, which is exactly what the sweep surfaces.
 */
export const RETENTION_COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  operator_turns: 'pruned by operator-turns-gc.ts',
  operator_conversations: 'pruned by operator-turns-gc.ts',
  plan_revisions: 'pruned by agent-tools/plans/revisions-gc.ts',
  coord_thread_posts: 'pruned by agent-tools/coordination/message-log-gc.ts',
  work_items: 'canonical work ledger — not age-prunable by design',
  memory_canonical: 'canonical memory store — not age-prunable by design',
  memory_vec_harrier: 'canonical memory vectors — not age-prunable by design',
};

/** `bak_*` pre-migration snapshots are frozen undo trails, never live growth —
 *  skipped STRUCTURALLY rather than listed, mirroring the same carve-out in
 *  identity-keyed-state-inventory.test.ts (hand-listing each new one red the
 *  fleet gate four times there). */
const FROZEN_BACKUP_TABLE_RE = /^bak_/;

/**
 * Pure: which tables are over the floor with no recorded retention decision.
 *
 * This is the leg `detectBreaches` structurally cannot cover. `detectBreaches`
 * walks `computeStorageUsage()`, which iterates `STORAGE_CATEGORIES` — so a
 * table nobody registered produces NO row and can therefore never breach, at
 * ANY size. An alarm whose stated job is catching tables that grow unwatched
 * was itself scoped to the watched set; a gate conditioned on the very act
 * whose omission is the bug cannot catch the bug.
 *
 * Also returns `staleCovered`: entries in RETENTION_COVERED_ELSEWHERE matching
 * no live table (renamed/dropped), so the map cannot rot into fiction.
 */
export function detectUndeclaredGrowth(
  tables: TableSizeRow[],
  declaredTables: readonly string[],
  floorBytes: number = undeclaredFloorBytes(),
): { undeclared: UndeclaredGrowth[]; staleCovered: string[] } {
  const declared = new Set(declaredTables);
  const live = new Set(tables.map((t) => t.table));

  const undeclared = tables
    .filter(
      (t) =>
        t.totalBytes > floorBytes &&
        !declared.has(t.table) &&
        !(t.table in RETENTION_COVERED_ELSEWHERE) &&
        !FROZEN_BACKUP_TABLE_RE.test(t.table),
    )
    .map((t) => ({ table: t.table, bytes: t.totalBytes, rows: t.rows, floorBytes }))
    .sort((a, b) => b.bytes - a.bytes);

  // An EMPTY catalog is not evidence that every table was renamed — it means the
  // scan returned nothing (a transient read that resolved to [] rather than
  // throwing). Deriving staleness from it would name the whole map as rot and
  // fire a confident, entirely false alarm, so absence of data is treated as
  // "unknown" rather than "absent".
  const staleCovered =
    tables.length === 0
      ? []
      : Object.keys(RETENTION_COVERED_ELSEWHERE)
          .filter((t) => !live.has(t))
          .sort();

  return { undeclared, staleCovered };
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

/** Build the human-facing escalation for an explicit category ceiling breach. */
export function formatGrowthEscalation(breaches: StorageBreach[]): { title: string; body: string } {
  const worst = [...breaches].sort((a, b) => b.bytes - a.bytes)[0];
  const action = worst.trimmable
    ? 'Trim the category or investigate its retention path now.'
    : 'Investigate the read-only/federated retention path now.';
  return {
    title: STORAGE_GROWTH_ESCALATION_TITLE,
    body:
      `${worst.label} (${worst.id}) is ${fmtGb(worst.bytes)} over its ${fmtGb(worst.ceilingBytes)} ceiling. ` +
      `${action}`,
  };
}

function fmtSize(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Build ONE aggregated toast for the undeclared sweep. Pure — unit-testable.
 *  Deliberately one toast for the whole set, not one per table: a per-table
 *  alarm on a dozen unowned tables trains the reader to dismiss it. */
export function formatUndeclaredToast(
  found: UndeclaredGrowth[],
  staleCovered: string[] = [],
): { level: string; message: string; description: string } {
  const lines = found
    .map((u) => `• harness_shared.${u.table}: ${fmtSize(u.bytes)} / ${u.rows.toLocaleString()} rows`)
    .join('\n');
  const stale =
    staleCovered.length > 0
      ? `\n\n⚠ RETENTION_COVERED_ELSEWHERE names ${staleCovered.length} table(s) that no longer exist ` +
        `(renamed/dropped — remove or update): ${staleCovered.join(', ')}.`
      : '';
  return {
    level: 'warning',
    message:
      found.length === 0
        ? `Retention coverage map is stale — ${staleCovered.length} entry/entries name no live table`
        : `${found.length} unowned table(s) over ${fmtSize(found[0].floorBytes)} with no retention decision`,
    description:
      `These Postgres tables are over the floor and carry NO recorded retention decision — no storage ` +
      `category, and no entry in RETENTION_COVERED_ELSEWHERE. They are invisible to the category ceiling ` +
      `alarm by construction, so they can grow without bound unnoticed:\n${lines}\n\n` +
      `This is not an accusation that they are unpruned — it means nobody recorded a decision. Fix by ` +
      `either adding a category in storage/categories.ts (with an ageColumn + federation class), or, if ` +
      `something already prunes it, recording that in RETENTION_COVERED_ELSEWHERE with the verified call ` +
      `site. Tune the floor via PAPERCUSP_STORAGE_ALARM_UNDECLARED_MB.${stale}`,
  };
}

/** Default undeclared-table scan: the catalog, NOT the category list. */
async function defaultListTableSizes(): Promise<TableSizeRow[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql as unknown as (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => Promise<Array<{ table: string; total_bytes: string | number; rows: string | number }>>;
  const rows = await sql`
    SELECT relname AS table,
           pg_total_relation_size(relid) AS total_bytes,
           n_live_tup AS rows
      FROM pg_stat_user_tables
     WHERE schemaname = 'harness_shared'`;
  return rows.map((r) => ({
    table: String(r.table),
    totalBytes: Number(r.total_bytes),
    rows: Number(r.rows),
  }));
}

/** One read-only pass: size every storage category, toast on any breach. Never
 *  throws — observability is best-effort, mirroring the other periodic monitors. */
export async function runStorageGrowthAlarmOnce(
  deps: GrowthAlarmDeps = {},
): Promise<{ checked: number; breaches: StorageBreach[]; undeclared: UndeclaredGrowth[] }> {
  const computeUsage = deps.computeUsage ?? (() => computeStorageUsage({ sizesOnly: true }));
  const emitToast = deps.emitToast ?? defaultEmitToast;
  const listTableSizes = deps.listTableSizes ?? defaultListTableSizes;
  const escalate = deps.escalate;
  const recentlyEscalated = deps.recentlyEscalated;

  let rows: StorageUsageRow[] = [];
  try {
    rows = await computeUsage();
  } catch (err) {
    console.warn(`[storage-growth-alarm] usage scan skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    rows = [];
  }

  const breaches = detectBreaches(rows);
  if (breaches.length > 0) {
    try {
      await emitToast(formatBreachToast(breaches));
    } catch (err) {
      console.warn(`[storage-growth-alarm] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
    // A category ceiling is an explicit, actionable threshold. The separate
    // undeclared-table leg remains warning-only: missing retention metadata is
    // not proof that the table is already unhealthy.
    await escalateAlarm(
      {
        ...formatGrowthEscalation(breaches),
        cooldownMs: STORAGE_GROWTH_ESCALATE_COOLDOWN_MS,
        source: 'storage-growth-alarm',
      },
      { notify: escalate, recentlyEscalated },
    );
  }

  // ── The undeclared sweep (the leg detectBreaches structurally cannot cover) ──
  // Runs INDEPENDENTLY of the usage scan above: the category path is precisely
  // the blind spot, so a failure there must not also blind the catalog sweep.
  let undeclared: UndeclaredGrowth[] = [];
  try {
    const declaredTables = STORAGE_CATEGORIES.filter(isPgCategory).map((c) => c.table);
    const result = detectUndeclaredGrowth(await listTableSizes(), declaredTables);
    undeclared = result.undeclared;
    if (undeclared.length > 0 || result.staleCovered.length > 0) {
      await emitToast(formatUndeclaredToast(undeclared, result.staleCovered));
    }
  } catch (err) {
    console.warn(
      `[storage-growth-alarm] undeclared sweep skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
  }

  return { checked: rows.length, breaches, undeclared };
}
