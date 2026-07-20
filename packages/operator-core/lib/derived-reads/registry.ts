/**
 * The precompute substrate for expensive DERIVED sync-resolver reads
 * (precompute-derived-sync-reads-2026-07-19 P-002, WI-5460).
 *
 * ── The problem this exists to remove ────────────────────────────────────────
 * An audit timed all 200 registered sync `queryName`s. Three exceeded 12s
 * (`learning.soakReport` 27.3s, `storage.usage` 20.0s, `plans.lint` 13.8s) while
 * pure DB reads on the same host were 3-20ms. Each ran expensive derived work --
 * a `journalctl` subprocess, a recursive du-style disk walk, a full-corpus plan
 * lint -- SYNCHRONOUSLY on a user-facing read, per page load, uncached.
 *
 * ── The shape of the fix ─────────────────────────────────────────────────────
 * A producer registers its compute here. A scheduled routine
 * (`system:precompute-derived-reads`) runs the due producers and writes each
 * result to `harness_shared.derived_read_snapshots`. The resolver then does a
 * plain SELECT. The cost moves to write-time, where no user is waiting.
 *
 * ── Why not a cache (D-001, owner-chosen) ────────────────────────────────────
 * A cache still pays the FULL cost on cold load, so the first user of every TTL
 * window eats the 20s. And decisively: the shipped desktop app runs embedded
 * Postgres on hosts with no systemd (macOS, containers), where `journalctl` does
 * not exist at all -- a read path that shells out to a host binary there does not
 * degrade, it fails permanently. Precompute + a capability-detecting producer is
 * the only shape that is correct on the real shipping target.
 *
 * ── The invariant that keeps this honest (D-003) ─────────────────────────────
 * A READ NEVER COMPUTES. `readDerivedSnapshot` returns the last snapshot, or an
 * empty result with a staleness marker, and lets the routine fill it. A
 * compute-on-miss path would reintroduce exactly the cold-load stall this exists
 * to remove -- it is the single most tempting wrong turn here, so it is stated
 * as an invariant rather than left to judgment.
 *
 * The one exception is the explicit flag-OFF escape hatch: with
 * FLAGS.PRECOMPUTE_DERIVED_READS off, reads fall back to inline compute, i.e.
 * the exact pre-fix behavior. That is a deliberate kill-switch, not a miss path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from '../flag-distinct-id';
import { activeWorkspaceId } from '../workspace-registry';

/** Sentinel `harness_slug` for a workspace-global producer (see the migration). */
const GLOBAL_SCOPE = '';

export interface DerivedReadProducer<T = unknown> {
  /** Stable key; by convention the sync queryName it serves (e.g. 'storage.usage'). */
  key: string;
  /**
   * How stale a snapshot may get before the routine recomputes it. The routine's
   * own cron sets the FLOOR on freshness; this sets the ceiling on how often an
   * expensive producer actually runs.
   */
  ttlMs: number;
  /**
   * Bump when the payload SHAPE changes. A snapshot written by an older version
   * is ignored by readers rather than fed to a client that no longer understands
   * it (it reads as a miss, and the routine overwrites it on the next fire).
   */
  producerVersion: number;
  /** 'workspace' ⇒ one snapshot per workspace; 'harness' ⇒ one per harness. */
  scope: 'workspace' | 'harness';
  /** The expensive computation. Runs on the routine's thread, never a read. */
  compute: (ctx: { workspaceId: string; harnessSlug: string }) => Promise<T>;
}

const REGISTRY = new Map<string, DerivedReadProducer>();

export function registerDerivedRead<T>(producer: DerivedReadProducer<T>): void {
  if (REGISTRY.has(producer.key)) {
    // Not fatal: module re-entry under a hot reload re-registers. Last wins.
    console.warn(`[derived-reads] re-registering producer "${producer.key}"`);
  }
  REGISTRY.set(producer.key, producer as DerivedReadProducer);
}

export function listDerivedReadProducers(): DerivedReadProducer[] {
  return [...REGISTRY.values()];
}

/** Test seam — drop registrations between cases. */
export function __clearDerivedReadRegistryForTest(): void {
  REGISTRY.clear();
}

export interface DerivedSnapshotMeta {
  /** Epoch ms the payload was computed; null when no snapshot exists yet. */
  computedAt: number | null;
  /** How long that compute took, for the Settings/observability surfaces. */
  computeMs: number | null;
  /** True when there is no usable snapshot (never computed, or shape-superseded). */
  missing: boolean;
  /** True when the snapshot is older than the producer's ttl (still served). */
  stale: boolean;
  /** Last compute error, if the most recent refresh failed. */
  error: string | null;
  /** False when the flag is OFF and this result came from an inline compute. */
  precomputed: boolean;
}

export interface DerivedSnapshotResult<T> {
  payload: T | null;
  meta: DerivedSnapshotMeta;
}

/**
 * Keys with a background warm-up in flight. Without this, every viewer of a cold
 * panel — and every 3s sync poll — would each kick off its own 70s disk walk, so
 * the miss path would DDoS the operator precisely when it is least able to cope.
 * Module-scoped because the stampede to prevent is within one process.
 */
const warmingKeys = new Set<string>();

/** Fire-and-forget fill for a missed snapshot. Never awaited by a read. */
function warmMissedSnapshot(key: string, workspaceId: string, harnessSlug: string): void {
  const guard = `${workspaceId}::${harnessSlug}::${key}`;
  if (warmingKeys.has(guard)) return;
  warmingKeys.add(guard);
  void refreshDerivedReads({ workspaceId, harnessSlug, only: [key], force: true })
    .catch((err) => {
      console.warn(`[derived-reads] background warm-up for "${key}" failed:`, err instanceof Error ? err.message : err);
    })
    .finally(() => {
      warmingKeys.delete(guard);
    });
}

/** Test seam — drop in-flight warm-up guards between cases. */
export function __clearWarmingKeysForTest(): void {
  warmingKeys.clear();
}

const MISSING_META: DerivedSnapshotMeta = {
  computedAt: null,
  computeMs: null,
  missing: true,
  stale: false,
  error: null,
  precomputed: true,
};

/**
 * Read a producer's latest snapshot. NEVER computes (D-003) unless the flag is
 * explicitly OFF, in which case it falls back to inline compute -- the pre-fix
 * behavior, kept as a live escape hatch.
 */
export async function readDerivedSnapshot<T>(
  key: string,
  opts: { harnessSlug?: string } = {},
): Promise<DerivedSnapshotResult<T>> {
  const producer = REGISTRY.get(key);
  if (!producer) {
    console.warn(`[derived-reads] read of unregistered producer "${key}"`);
    return { payload: null, meta: MISSING_META };
  }

  const workspaceId = activeWorkspaceId();
  const harnessSlug = producer.scope === 'workspace' ? GLOBAL_SCOPE : (opts.harnessSlug ?? GLOBAL_SCOPE);

  let enabled = true;
  try {
    enabled = await getFlag(FLAGS.PRECOMPUTE_DERIVED_READS, systemDistinctId());
  } catch {
    // Flag read failed -- prefer the precomputed path (the correct behavior on
    // the shipping target) rather than silently falling back to a 20s inline walk.
    enabled = true;
  }

  if (!enabled) {
    const startedAt = Date.now();
    const payload = (await producer.compute({ workspaceId, harnessSlug })) as T;
    return {
      payload,
      meta: {
        computedAt: startedAt,
        computeMs: Date.now() - startedAt,
        missing: false,
        stale: false,
        error: null,
        precomputed: false,
      },
    };
  }

  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT payload, computed_at, compute_ms, producer_version, error
      FROM harness_shared.derived_read_snapshots
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND key = ${key}
     LIMIT 1
  `) as Array<{
    payload: unknown;
    computed_at: string | number | null;
    compute_ms: number | null;
    producer_version: number | null;
    error: string | null;
  }>;

  const row = rows[0];
  // A snapshot from an older producer version is treated as absent: serving a
  // superseded SHAPE to a client is worse than serving nothing.
  if (!row || Number(row.producer_version ?? 1) !== producer.producerVersion) {
    // Kick a BACKGROUND fill so a cold database heals itself instead of showing
    // an empty panel until the next cron tick (up to 5 minutes on a fresh
    // install, or right after a producerVersion bump).
    //
    // This does NOT violate D-003: the read still returns immediately and never
    // awaits the compute. The invariant is "a read never WAITS on the expensive
    // work", not "a miss is never noticed" — a read that blocked here would be
    // exactly the cold-load stall precompute exists to remove.
    void warmMissedSnapshot(producer.key, workspaceId, harnessSlug);
    return { payload: null, meta: MISSING_META };
  }

  const computedAt = Number(row.computed_at ?? 0) || null;
  return {
    payload: row.payload as T,
    meta: {
      computedAt,
      computeMs: row.compute_ms ?? null,
      missing: false,
      stale: computedAt !== null && Date.now() - computedAt > producer.ttlMs,
      error: row.error ?? null,
      precomputed: true,
    },
  };
}

/**
 * Convenience for the common resolver shape: a snapshot holding an ARRAY of rows.
 * Returns `[]` on a miss so a panel renders empty rather than throwing, and
 * attaches the staleness meta to `rows[0]._meta` following the house
 * `attachListMeta` convention so a panel can show "as of HH:MM".
 */
export async function readDerivedSnapshotRows<T>(
  key: string,
  opts: { harnessSlug?: string } = {},
): Promise<T[]> {
  const { payload, meta } = await readDerivedSnapshot<T[]>(key, opts);
  const rows = Array.isArray(payload) ? payload : [];
  if (rows.length > 0 && rows[0] && typeof rows[0] === 'object') {
    (rows[0] as Record<string, unknown>)._meta = {
      ...((rows[0] as Record<string, unknown>)._meta as Record<string, unknown> | undefined),
      derivedRead: meta,
    };
  }
  return rows;
}

export interface RefreshOutcome {
  key: string;
  harnessSlug: string;
  refreshed: boolean;
  skippedFresh: boolean;
  computeMs: number | null;
  error: string | null;
}

/**
 * Compute + persist every producer whose snapshot is due. Called by the
 * `system:precompute-derived-reads` routine action.
 *
 * Replay-safe (routine handlers re-run from the top on recovery): every write is
 * an idempotent upsert, and a producer whose snapshot is still fresh is skipped,
 * so a replay costs a few SELECTs rather than re-running a 20s walk.
 *
 * A FAILING producer never clears a good payload. The last-known-good snapshot
 * keeps serving and the error is recorded alongside it -- a transient
 * `journalctl` hiccup must not blank the panel.
 */
export async function refreshDerivedReads(ctx: {
  workspaceId: string;
  harnessSlug: string;
  /** Recompute regardless of ttl (used by the seed/backfill path). */
  force?: boolean;
  /** Restrict to these keys; default all registered. */
  only?: string[];
}): Promise<RefreshOutcome[]> {
  const { sql } = getOrgPg();
  const outcomes: RefreshOutcome[] = [];
  // Shortest-ttl FIRST (WI-5471): producers run sequentially, so a heavy long-walk
  // producer must never head-of-line-block the liveness-sensitive short-ttl ones in
  // the same pass. ttl already encodes "how fresh this must be" (see producers.ts
  // header), and the heavy producers (storage.usage 30m, plans.lint 6h) have the
  // longest ttls precisely because their signal moves slowly — so ordering by ttl
  // ascending refreshes serviceHealth/gitPipeline/dev.* (90s) before the multi-second
  // walks even on a pass where those walks are due. Producers are independent (each
  // writes its own snapshot key), so the order is free to choose.
  const producers = listDerivedReadProducers()
    .filter((p) => !ctx.only || ctx.only.includes(p.key))
    .sort((a, b) => a.ttlMs - b.ttlMs);

  for (const producer of producers) {
    const harnessSlug = producer.scope === 'workspace' ? GLOBAL_SCOPE : ctx.harnessSlug;

    if (!ctx.force) {
      const existing = (await sql`
        SELECT computed_at, producer_version
          FROM harness_shared.derived_read_snapshots
         WHERE workspace_id = ${ctx.workspaceId}
           AND harness_slug = ${harnessSlug}
           AND key = ${producer.key}
         LIMIT 1
      `) as Array<{ computed_at: string | number | null; producer_version: number | null }>;
      const row = existing[0];
      const fresh =
        row &&
        Number(row.producer_version ?? 1) === producer.producerVersion &&
        Date.now() - (Number(row.computed_at ?? 0) || 0) < producer.ttlMs;
      if (fresh) {
        outcomes.push({
          key: producer.key,
          harnessSlug,
          refreshed: false,
          skippedFresh: true,
          computeMs: null,
          error: null,
        });
        continue;
      }
    }

    const startedAt = Date.now();
    try {
      const payload = await producer.compute({ workspaceId: ctx.workspaceId, harnessSlug });
      const computeMs = Date.now() - startedAt;
      await sql`
        INSERT INTO harness_shared.derived_read_snapshots
          (workspace_id, harness_slug, key, payload, computed_at, compute_ms, producer_version, error, error_at, updated_at)
        VALUES (${ctx.workspaceId}, ${harnessSlug}, ${producer.key},
                ${JSON.stringify(payload ?? null)}::text::jsonb,
                ${startedAt}, ${computeMs}, ${producer.producerVersion}, NULL, NULL, ${Date.now()})
        ON CONFLICT (workspace_id, harness_slug, key) DO UPDATE SET
          payload = EXCLUDED.payload,
          computed_at = EXCLUDED.computed_at,
          compute_ms = EXCLUDED.compute_ms,
          producer_version = EXCLUDED.producer_version,
          error = NULL,
          error_at = NULL,
          updated_at = EXCLUDED.updated_at
      `;
      outcomes.push({
        key: producer.key,
        harnessSlug,
        refreshed: true,
        skippedFresh: false,
        computeMs,
        error: null,
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      // Record the failure WITHOUT touching payload/computed_at, so the
      // last-known-good result keeps serving.
      await sql`
        INSERT INTO harness_shared.derived_read_snapshots
          (workspace_id, harness_slug, key, payload, computed_at, producer_version, error, error_at, updated_at)
        VALUES (${ctx.workspaceId}, ${harnessSlug}, ${producer.key}, 'null'::jsonb, 0,
                ${producer.producerVersion}, ${message}, ${Date.now()}, ${Date.now()})
        ON CONFLICT (workspace_id, harness_slug, key) DO UPDATE SET
          error = EXCLUDED.error,
          error_at = EXCLUDED.error_at,
          updated_at = EXCLUDED.updated_at
      `;
      outcomes.push({
        key: producer.key,
        harnessSlug,
        refreshed: false,
        skippedFresh: false,
        computeMs: Date.now() - startedAt,
        error: message,
      });
    }
  }

  return outcomes;
}
