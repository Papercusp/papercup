/**
 * backfill-local-state — Stage 4 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * Stages 1-3 federate NEW feature/issue writes: the Stage-1 AFTER trigger
 * enqueues local-origin writes into `harness_shared.substrate_outbox`, and the
 * Stage-3 drain appends them to this device's own Hypercore log so peers'
 * read-side projections apply them. But rows that already EXISTED before
 * federation shipped never fired the capture trigger, so a later-joining peer
 * never sees them.
 *
 * `backfillLocalState` is the one-time catch-up: it enqueues every existing
 * LOCAL `*_consolidated` row for this (workspace, harness) into the outbox — the
 * SAME path a fresh write takes. It does NOT append to the log directly; the
 * drain owns the log (single writer, at-least-once, GC). After enqueueing, the
 * existing drain picks the rows up and federates them.
 *
 * IDEMPOTENT (the must-be-right property): guarded by a `backfill_done` marker
 * row in `harness_shared.substrate_meta` (migration 104). The first line checks
 * the marker; if present it returns `{ skipped: true }` so a second boot never
 * re-enqueues the whole table. The marker is written AFTER the enqueue (in the
 * same connection, so a crash mid-enqueue leaves it unmarked → the next boot
 * re-runs; the drain + LWW merge + idempotent `INSERT … ON CONFLICT` projection
 * tolerate the duplicate ops, so a partial re-run is safe).
 *
 * PER-AUTHOR CAP (user-approved cap-and-warn, plan open-question 2): a peer's
 * read-merge ingests at most `DEFAULT_MAX_OPS_PER_AUTHOR` (50k) ops from any one
 * author's log (read-merge.ts / boot.ts `MAX_OPS_PER_AUTHOR`). A backfill that
 * would push the own log past that cap is pointless beyond the cap (peers drop
 * the overflow anyway), so we enqueue up to the cap and `console.warn` a
 * `peer_capped`-style message naming how many rows were dropped. We do NOT chunk
 * (the cap is a hard ceiling per author, not a rate).
 *
 * NOT wired into boot here — Stage 5 calls this from boot-all.ts (best-effort,
 * before `startOutboxDrain`).
 */

import type postgres from 'postgres';
import type { BootedHarnessHandle } from './boot';
import { DEFAULT_MAX_OPS_PER_AUTHOR } from './read-merge';

/** The two consolidated tables backfilled, paired with their key column (the
 *  outbox `key` == the feature_id / issue_id, mirroring the capture trigger). */
const BACKFILL_TARGETS: ReadonlyArray<readonly [table: string, keyCol: string]> = [
  ['harness_features_consolidated', 'feature_id'],
  ['harness_issues_consolidated', 'issue_id'],
  // plans-pg-canonical-migration-2026-06-03 (Stage 2): PG-canonical plans federate
  // as papercup-harness content (key == plan_slug). NB: the one-time `backfill_done`
  // marker is per-(workspace,harness), so on an install that ALREADY federated
  // features/issues the marker short-circuits and pre-existing plans are not
  // re-enqueued — only ongoing plan writes federate (via the capture trigger,
  // migration 125). Fresh installs backfill plans here. (Clearing the marker forces
  // a one-time re-backfill of all targets; idempotent but re-enqueues everything.)
  ['harness_plans', 'plan_slug'],
  // shared-hive-federation-2026-06-08 (P-005): per-Hive settings federate as Hive
  // state (key == setting_key), scoped to the Hive home harness slug.
  ['hive_settings', 'setting_key'],
];

/** substrate_meta key for the one-time-done marker. */
const BACKFILL_MARKER_KEY = 'backfill_done';

export interface BackfillOptions {
  /**
   * Hard ceiling on rows enqueued, aligned with the Model B per-author ingest
   * cap (a peer won't read beyond it anyway). Default `DEFAULT_MAX_OPS_PER_AUTHOR`
   * (50k). Set 0 to disable the cap. When the local row count exceeds the cap,
   * enqueues up to it and warns about the dropped rows (cap-and-warn).
   */
  maxOpsPerAuthor?: number;
  /** Clock override (epoch ms) for the enqueued `ts` + marker value. Tests
   *  inject a fixed value; production omits it (Date.now). */
  now?: number;
}

export interface BackfillResult {
  /** True when the marker was already present and we did nothing. */
  skipped: boolean;
  /** Rows enqueued into the outbox this run (0 when skipped). */
  enqueued: number;
  /** Rows that existed but were NOT enqueued because they exceeded the cap. */
  dropped: number;
}

/**
 * One-time enqueue of existing LOCAL `*_consolidated` rows into
 * `substrate_outbox` for this handle's (workspace, harness). Idempotent via the
 * `substrate_meta` marker. Returns how many rows were enqueued / dropped, or
 * `{ skipped: true }` if the marker was already present.
 */
export async function backfillLocalState(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const { workspaceId, harnessSlug } = handle;

  // Marker check FIRST — a second boot must not re-enqueue the whole table.
  const marker = await pg<{ key: string }[]>`
    SELECT key FROM harness_shared.substrate_meta
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND key = ${BACKFILL_MARKER_KEY}
     LIMIT 1`;
  if (marker.length > 0) {
    return { skipped: true, enqueued: 0, dropped: 0 };
  }

  const now = opts.now ?? Date.now();
  const cap =
    opts.maxOpsPerAuthor === undefined ? DEFAULT_MAX_OPS_PER_AUTHOR : opts.maxOpsPerAuthor;
  // cap <= 0 means "no cap" — treat as Infinity for the budget math.
  let budget = cap > 0 ? cap : Number.POSITIVE_INFINITY;

  let enqueued = 0;
  let dropped = 0;

  for (const [tableName, keyCol] of BACKFILL_TARGETS) {
    // Count the local rows for this (workspace, harness) so we can attribute
    // drops even when the budget runs out (the INSERT below stops at the budget).
    const [{ total }] = await pg<{ total: number }[]>`
      SELECT count(*)::int AS total
        FROM harness_shared.${pg(tableName)}
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND COALESCE(origin, 'local') = 'local'`;

    if (total === 0) continue;

    const take = budget === Number.POSITIVE_INFINITY ? total : Math.min(total, budget);
    dropped += total - take;

    if (take > 0) {
      // INSERT-to-outbox (NOT a direct log append — the drain owns the log).
      // Mirror exactly what the capture trigger produces: op='put',
      // key=<keyCol>, row=to_jsonb(row), ts, drained_at NULL. ORDER BY the PK
      // for a deterministic which-rows-kept under the cap.
      const inserted = await pg<{ key: string }[]>`
        INSERT INTO harness_shared.substrate_outbox
          (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
        SELECT
          ${workspaceId}, ${harnessSlug}, ${tableName}, 'put',
          c.${pg(keyCol)}::text, to_jsonb(c), ${now}, NULL
          FROM harness_shared.${pg(tableName)} c
         WHERE c.workspace_id = ${workspaceId}
           AND c.harness_slug = ${harnessSlug}
           AND COALESCE(c.origin, 'local') = 'local'
         ORDER BY c.harness_slug, c.${pg(keyCol)}
         LIMIT ${take}
        RETURNING key`;
      enqueued += inserted.length;
      if (budget !== Number.POSITIVE_INFINITY) budget -= inserted.length;
    }
  }

  // Cap-and-warn: a peer's read-merge drops anything past the per-author cap, so
  // warn (rather than chunk) when we couldn't enqueue everything.
  if (dropped > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[backfill-local-state] peer_capped: ${workspaceId}::${harnessSlug} backfill ` +
        `exceeded the per-author cap (${cap}); enqueued ${enqueued}, DROPPED ${dropped} ` +
        `local row(s) — peers would not ingest them beyond the cap anyway.`,
    );
  }

  // Write the marker AFTER the enqueue so a crash mid-enqueue re-runs next boot.
  // ON CONFLICT keeps it idempotent if two boots race (the marker-check above
  // already short-circuits the common case).
  await pg`
    INSERT INTO harness_shared.substrate_meta (workspace_id, harness_slug, key, value)
    VALUES (${workspaceId}, ${harnessSlug}, ${BACKFILL_MARKER_KEY}, ${String(now)})
    ON CONFLICT (workspace_id, harness_slug, key) DO NOTHING`;

  return { skipped: false, enqueued, dropped };
}
