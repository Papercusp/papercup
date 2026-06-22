/**
 * feature-queue-workingset-two-peer-federation.integration.test.ts — closes the
 * last two Brief B B-003 gaps: the `feature_queue` and `feature_working_set`
 * log-first work-pointer tables.
 *
 * Both federate via a DIRECT `ownLog.append` (NOT substrate-outbox) — the
 * orchestrator's `enqueueFeature`/`dequeueFeature` (write-feature-queue.ts) and
 * `setActiveFeature`/`clearActiveFeature` (write-working-set.ts) append an op
 * keyed `<github_user_id>/<feature_id>` whose value is the pointer row. Before
 * this test each had only single-PG projection/LWW-guard unit tests — the real
 * TWO-PEER crossing (append on A → swarm → apply on B) was unproven. These are
 * the lowest-risk federated tables (small derived pointers), but a real crossing
 * test closes the matrix.
 *
 * One real two-peer rig (mutual admission, loopback testnet DHT) wires BOTH
 * projections (via `_cross-peer-rig`'s `extraProjections` seam) and proves, for
 * each table, that a put crosses A→B and a `del` tombstone crosses A→B. The
 * working_set projection also reconciles `harness_features_consolidated.
 * working_users` on apply, so a minimal real-shape features table is present for
 * that recompute (it matches 0 rows here — the point is the recompute runs
 * without error on the peer).
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  federateTwoPeerPresence,
  pollUntil,
  rigAfterEach,
  WORKSPACE_ID,
  HARNESS_SLUG,
} from './_cross-peer-rig';
import { buildFeatureQueueProjection, type FeatureQueueRow } from '../projections/feature-queue';
import {
  buildFeatureWorkingSetProjection,
  type FeatureWorkingSetRow,
} from '../projections/feature-working-set';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

afterEach(rigAfterEach);

/** Real-shape DDL (000-baseline columns + the fed_ts LWW column + the PK the
 *  projection ON CONFLICT requires). NOT a hand-rolled subset of the content. */
const FEATURE_QUEUE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.feature_queue (
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    github_user_id bigint NOT NULL,
    feature_id text NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    author_pubkey text,
    origin text DEFAULT 'local'::text NOT NULL,
    schema_version bigint DEFAULT 1 NOT NULL,
    fed_ts bigint,
    fed_hlc text,
    PRIMARY KEY (workspace_id, harness_slug, github_user_id, feature_id)
  )`;
const FEATURE_WORKING_SET_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.feature_working_set (
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    github_user_id bigint NOT NULL,
    feature_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_at timestamp with time zone,
    author_pubkey text,
    origin text DEFAULT 'local'::text NOT NULL,
    schema_version bigint DEFAULT 1 NOT NULL,
    fed_ts bigint,
    fed_hlc text,
    PRIMARY KEY (workspace_id, harness_slug, github_user_id, feature_id)
  )`;
/** Minimal real-shape features table so the working_set apply's working_users[]
 *  recompute (UPDATE … SET working_users) runs on the peer (matches 0 rows here). */
const HARNESS_FEATURES_MIN_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    working_users bigint[] DEFAULT '{}'::bigint[],
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
  )`;

const GH = 321;
const FEATURE = 'F-pointer';
const KEY = `${GH}/${FEATURE}`;

const queueRow = (): FeatureQueueRow => ({
  harness_slug: HARNESS_SLUG,
  github_user_id: GH,
  feature_id: FEATURE,
  queued_at: 1000,
  removed_at: null,
  schema_version: CURRENT_SCHEMA_VERSION,
});
const workingSetRow = (): FeatureWorkingSetRow => ({
  harness_slug: HARNESS_SLUG,
  github_user_id: GH,
  feature_id: FEATURE,
  started_at: 1000,
  cleared_at: null,
  schema_version: CURRENT_SCHEMA_VERSION,
});

async function countRow(sql: import('postgres').Sql, table: string): Promise<number> {
  const [{ n }] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM ${sql(`harness_shared.${table}`)}
     WHERE harness_slug = ${HARNESS_SLUG} AND github_user_id = ${GH} AND feature_id = ${FEATURE}
  `;
  return n;
}

describe('feature_queue + feature_working_set — two-peer federation (B-003)', () => {
  it(
    'each work-pointer (put + del tombstone) federates A→B',
    async () => {
      const { dbA, dbB, peerA, peerB, federated } = await federateTwoPeerPresence((sql) => [
        buildFeatureQueueProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }),
        buildFeatureWorkingSetProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }),
      ]);
      expect(federated, 'the two peers never connected/federated presence (rig precondition)').toBeTruthy();

      for (const db of [dbA, dbB]) {
        await db.sql.unsafe(FEATURE_QUEUE_DDL);
        await db.sql.unsafe(FEATURE_WORKING_SET_DDL);
        await db.sql.unsafe(HARNESS_FEATURES_MIN_DDL);
      }

      const writer = peerA.handle.ownLog.keyHex;

      // ── A enqueues + sets-active the same (user, feature) pointer. ──
      await peerA.handle.append({
        type: 'put', table: 'queue', hbKey: KEY, value: queueRow(),
        ts: 1000, schema_version: CURRENT_SCHEMA_VERSION, writerPubkey: writer,
      });
      await peerA.handle.append({
        type: 'put', table: 'working-set', hbKey: KEY, value: workingSetRow(),
        ts: 1000, schema_version: CURRENT_SCHEMA_VERSION, writerPubkey: writer,
      });

      // ── PROOF 1: both pointers cross A→B. ──
      const landed = await pollUntil(
        async () => {
          await peerA.handle.mergeNow();
          await peerB.handle.mergeNow();
          const q = await countRow(dbB.sql, 'feature_queue');
          const w = await countRow(dbB.sql, 'feature_working_set');
          return q === 1 && w === 1 ? { q, w } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(landed, 'a work-pointer (queue/working-set) never crossed A→B').toBeTruthy();

      // ── A dequeues + clears (del tombstones, newer ts to win the EI-79 guard). ──
      await peerA.handle.append({
        type: 'del', table: 'queue', hbKey: KEY,
        ts: 2000, schema_version: CURRENT_SCHEMA_VERSION, writerPubkey: writer,
      });
      await peerA.handle.append({
        type: 'del', table: 'working-set', hbKey: KEY,
        ts: 2000, schema_version: CURRENT_SCHEMA_VERSION, writerPubkey: writer,
      });

      // ── PROOF 2: both tombstones cross A→B (the pointers are removed on B). ──
      const removed = await pollUntil(
        async () => {
          await peerA.handle.mergeNow();
          await peerB.handle.mergeNow();
          const q = await countRow(dbB.sql, 'feature_queue');
          const w = await countRow(dbB.sql, 'feature_working_set');
          return q === 0 && w === 0 ? { gone: true } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(
        removed,
        'a work-pointer tombstone never crossed A→B — a dequeued/cleared pointer would linger on the peer',
      ).toBeTruthy();
    },
    90_000,
  );
});
