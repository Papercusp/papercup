/**
 * work-item-readiness-maintenance.integration.test.ts — migration 379's MAINTAINED
 * readiness sidecar against REAL Postgres (work-item-deps-and-readiness-2026-06-22 P-005).
 *
 * Migration 379 (379-maintained-ready-column.sql) added a LOCAL, non-federated
 * readiness sidecar `harness_shared.work_item_blocked`: PRESENCE of a row = the
 * feature-family work-item is NOT ready (>=1 unsatisfied blocks-edge); ABSENCE = ready.
 * It is maintained by triggers on work_item_deps (edge churn), work_items
 * (status terminal-boundary crossings + insert + delete), and the oracle predicate
 * `work_item_is_blocked(harness, feature)` mirrors the scheduler claim's inline
 * NOT EXISTS.
 *
 * This proves the trigger maintenance is correct end-to-end by inserting rows
 * DIRECTLY into work_items + work_item_deps and asserting the sidecar / oracle:
 *  (a) a feature with no blockers is NOT in work_item_blocked (ready).
 *  (b) adding a blocks-edge with a non-terminal feature blocker makes it APPEAR.
 *  (c) flipping that blocker to 'passed' REMOVES it (wir_status re-syncs dependents).
 *  (d) an ISSUE blocker (bug, 'open') blocks; flip to 'resolved' → unblocked.
 *  (e) DELETE the blocked feature → its sidecar row is gone.
 *  (f) reconciliation invariant: on a random graph, work_item_blocked's contents
 *      == EXACTLY the feature rows where work_item_is_blocked()=true.
 *
 * Applies the migration-379 SQL on boot (over the canonical work_items + deps DDL
 * fixtures), so the triggers/functions/table are exactly the shipped ones.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

// Strip psql \meta, GRANTs (no roles in the throwaway test db) and the explicit
// BEGIN;/COMMIT; transaction markers (the pooled client rejects them) — but NOT a
// plpgsql function body's bare `BEGIN` (no trailing semicolon). Same shape as the
// other operator-core integration tests' readMigration.
const readMigration = (f: string): string =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter(
      (line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line),
    )
    .join('\n');

let db: FreshPgDb;
const sql = () => db.sql;

/** A feature-family work_items row (item_kind defaults to 'feature' in the fixture). */
async function insertFeature(harness: string, feature: string, status = 'todo'): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items (harness_slug, feature_id, title, status, item_kind)
    VALUES (${harness}, ${feature}, ${`${harness}#${feature}`}, ${status}, 'feature')`;
}

/** An issue-family work_items row (item_kind in bug/change/task). ref = bare feature_id. */
async function insertIssue(feature: string, status = 'open', kind = 'bug'): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items (harness_slug, feature_id, title, status, item_kind)
    VALUES ('', ${feature}, ${feature}, ${status}, ${kind})`;
}

/** A blocks-edge: blocked_ref is blocked until blocker_ref is terminal. */
async function addBlocksEdge(
  blockedRef: string,
  blockerRef: string,
  blockedKind = 'feature',
  blockerKind = 'feature',
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES ('default', ${blockedKind}, ${blockedRef}, ${blockerKind}, ${blockerRef}, 'blocks')`;
}

/** The maintained sidecar contents as a sorted set of "harness#feature" refs. */
async function blockedSet(): Promise<string[]> {
  const rows = await db.sql<{ ref: string }[]>`
    SELECT harness_slug || '#' || feature_id AS ref
      FROM harness_shared.work_item_blocked`;
  return rows.map((r) => r.ref).sort();
}

/** The oracle predicate over EVERY feature-family item — the reconciliation truth. */
async function oracleBlockedSet(): Promise<string[]> {
  const rows = await db.sql<{ ref: string }[]>`
    SELECT f.harness_slug || '#' || f.feature_id AS ref
      FROM harness_shared.work_items f
     WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
       AND harness_shared.work_item_is_blocked(f.harness_slug, f.feature_id)`;
  return rows.map((r) => r.ref).sort();
}

async function isBlocked(harness: string, feature: string): Promise<boolean> {
  const [{ b }] = await db.sql<{ b: boolean }[]>`
    SELECT harness_shared.work_item_is_blocked(${harness}, ${feature}) AS b`;
  return b;
}

beforeAll(async () => {
  db = await createFreshPgDb('wirr');
  // Canonical work_items base + views + the deps table fixtures.
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL);
  // The SHIPPED migration under test — creates work_item_blocked + work_item_is_blocked
  // + sync_work_item_blocked + the wir_* triggers, and backfills (over the empty graph).
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql'));
});

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  // Clear edges first (their trigger touches the sidecar), then items (delete-cleanup
  // trigger fires), then any stragglers in the sidecar itself.
  await db.sql`TRUNCATE harness_shared.work_item_deps`;
  await db.sql`TRUNCATE harness_shared.work_items`;
  await db.sql`TRUNCATE harness_shared.work_item_blocked`;
});

describe('migration 379 — maintained readiness sidecar (work_item_blocked)', () => {
  it('(a) a feature with no blockers is NOT in work_item_blocked (ready)', async () => {
    await insertFeature('h', 'F1');
    expect(await isBlocked('h', 'F1')).toBe(false);
    expect(await blockedSet()).toEqual([]);
  });

  it('(b) adding a blocks-edge with a non-terminal feature blocker makes the blocked feature APPEAR', async () => {
    await insertFeature('h', 'F1'); // blocked
    await insertFeature('h', 'F2', 'in_progress'); // non-terminal blocker
    expect(await blockedSet()).toEqual([]); // no edge yet → ready

    await addBlocksEdge('h#F1', 'h#F2');

    expect(await isBlocked('h', 'F1')).toBe(true);
    expect(await blockedSet()).toEqual(['h#F1']);
  });

  it('(c) flipping the blocker to passed REMOVES the blocked feature (wir_status re-syncs the dependent)', async () => {
    await insertFeature('h', 'F1');
    await insertFeature('h', 'F2', 'in_progress');
    await addBlocksEdge('h#F1', 'h#F2');
    expect(await blockedSet()).toEqual(['h#F1']);

    // Terminal-boundary crossing in_progress -> passed; the AFTER UPDATE OF status
    // trigger re-syncs F2's dependents (F1).
    await db.sql`UPDATE harness_shared.work_items SET status = 'passed'
                  WHERE harness_slug = 'h' AND feature_id = 'F2'`;

    expect(await isBlocked('h', 'F1')).toBe(false);
    expect(await blockedSet()).toEqual([]);
  });

  it('(d) an ISSUE blocker (bug/open) blocks the feature; flipping it to resolved unblocks', async () => {
    await insertFeature('h', 'F1');
    await insertIssue('BUG-1', 'open', 'bug'); // issue blocker, ref = bare feature_id
    await addBlocksEdge('h#F1', 'BUG-1', 'feature', 'issue');

    expect(await isBlocked('h', 'F1')).toBe(true);
    expect(await blockedSet()).toEqual(['h#F1']);

    // open -> resolved is a terminal-boundary crossing for issues too (status col).
    await db.sql`UPDATE harness_shared.work_items SET status = 'resolved'
                  WHERE harness_slug = '' AND feature_id = 'BUG-1'`;

    expect(await isBlocked('h', 'F1')).toBe(false);
    expect(await blockedSet()).toEqual([]);
  });

  it('(e) DELETE the blocked feature → its work_item_blocked row is gone', async () => {
    await insertFeature('h', 'F1');
    await insertFeature('h', 'F2', 'in_progress');
    await addBlocksEdge('h#F1', 'h#F2');
    expect(await blockedSet()).toEqual(['h#F1']);

    await db.sql`DELETE FROM harness_shared.work_items
                  WHERE harness_slug = 'h' AND feature_id = 'F1'`;

    expect(await blockedSet()).toEqual([]);
  });

  it('(f) reconciliation invariant: sidecar contents == EXACTLY the oracle-blocked feature set, on a random graph', async () => {
    // Build a small random DAG of features + a couple of issues, randomized statuses,
    // and random blocks-edges (acyclic by construction: a node may only be blocked by a
    // lower-indexed node). Every mutation runs through the live triggers; then assert the
    // maintained sidecar matches the oracle predicate exactly.
    const FEATURES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const ISSUES = ['I1', 'I2', 'I3'];
    const featureStatuses = ['todo', 'in_progress', 'passed', 'deprecated'];
    const issueStatuses = ['open', 'in_progress', 'resolved', 'closed'];

    // Deterministic PRNG (mulberry32) so a failure is reproducible.
    let s = 0x9e3779b9 >>> 0;
    const rnd = (): number => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

    for (let i = 0; i < FEATURES.length; i++) {
      await insertFeature('hx', FEATURES[i]!, pick(featureStatuses));
    }
    for (const id of ISSUES) {
      await insertIssue(id, pick(issueStatuses), 'bug');
    }

    // Feature->feature edges (acyclic: blocker index < blocked index).
    for (let blocked = 1; blocked < FEATURES.length; blocked++) {
      for (let blocker = 0; blocker < blocked; blocker++) {
        if (rnd() < 0.25) {
          await addBlocksEdge(`hx#${FEATURES[blocked]}`, `hx#${FEATURES[blocker]}`);
        }
      }
    }
    // Issue->feature edges.
    for (let i = 0; i < FEATURES.length; i++) {
      for (const issue of ISSUES) {
        if (rnd() < 0.2) {
          await addBlocksEdge(`hx#${FEATURES[i]}`, issue, 'feature', 'issue');
        }
      }
    }

    // Now perturb: flip a random subset of statuses (exercises the status triggers).
    for (let i = 0; i < FEATURES.length; i++) {
      if (rnd() < 0.5) {
        await db.sql`UPDATE harness_shared.work_items SET status = ${pick(featureStatuses)}
                      WHERE harness_slug = 'hx' AND feature_id = ${FEATURES[i]!}`;
      }
    }
    for (const id of ISSUES) {
      if (rnd() < 0.5) {
        await db.sql`UPDATE harness_shared.work_items SET status = ${pick(issueStatuses)}
                      WHERE harness_slug = '' AND feature_id = ${id}`;
      }
    }

    const maintained = await blockedSet();
    const oracle = await oracleBlockedSet();
    expect(maintained).toEqual(oracle);

    // And the sidecar must contain ONLY feature-family refs (never an issue ref).
    for (const ref of maintained) expect(ref.startsWith('hx#')).toBe(true);
  });
});
