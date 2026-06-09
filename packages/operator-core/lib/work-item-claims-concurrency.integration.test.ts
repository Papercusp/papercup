/**
 * work-item-claims-concurrency.integration.test.ts — the C3 concurrency stress for the
 * decentralized dispatch backlog (coordination-test-suite-2026-06-08 P-010).
 *
 * The existing claim tests cover the 2-instance contend case
 * (`work-item-claims-two-instance.integration.test.ts`) + the pure deterministic reconcile
 * (`work-item-claim-reconcile.test.ts`). This file proves the C3 properties at N-WAY
 * concurrency against REAL Postgres:
 *
 *   1. N distinct owners fire `acquireClaimLocal` for ONE (workspace, harness, item) at
 *      once → EXACTLY ONE wins; the other N-1 get a conflict (no double-claim). The PK +
 *      the ON CONFLICT … WHERE (expires_ts <= now() OR owner = EXCLUDED.owner) guard is
 *      the atomicity point — this is the N-way generalization of the 2-instance test.
 *   2. N>M concurrent claimers over a backlog of M items via `claimNextWorkItem`
 *      (SELECT … FOR UPDATE SKIP LOCKED) → each item is claimed by AT MOST one owner, no
 *      owner gets the same item twice, exactly M distinct claims land.
 *   3. LEASE TTL: A claims, the lease lapses (forced expiry), B then STEALS the lapsed
 *      lease — and the claim_id rotates.
 *   4. HEARTBEAT extends the lease: a live (non-lapsed) lease can't be stolen by a
 *      concurrent B; a foreign owner's heartbeat is a no-op.
 *   5. FAIL-OPEN reconcile under partition: two partitioned authorities both granted an
 *      advisory lease on one item → `reconcileClaims` deterministically picks the winner
 *      (earliest acquiredTs → lowest holderPubkey → lowest claimId) and re-running it is
 *      idempotent. This is the partition-heal scenario, exercised against advisory rows
 *      read out of REAL PG (not hand-built objects).
 *
 * DB wiring mirrors `work-items-claim.integration.test.ts` (real PG via createFreshPgDb +
 * mocked workspace-registry/db-org). We set up BOTH the `work_item_claims` lease table
 * (tests 1/3/4/5) AND the `harness_features_consolidated` backlog (test 2's claim_next).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import type { AdvisoryClaim } from './work-item-claim-reconcile';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// The lease table (migration 188) — DDL inlined like the sibling claim tests so the
// suite does not depend on the full migration chain for this one table.
const WORK_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    hive_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

// The backlog table (claim_next via SKIP LOCKED) — same DDL shape as work-items-claim.
const HFC_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    harness_slug text NOT NULL, feature_id text NOT NULL, title text, summary text,
    status text NOT NULL DEFAULT 'todo', attempts bigint DEFAULT 0,
    item_kind text NOT NULL DEFAULT 'feature', payload jsonb, parent_id text,
    taken_by text, taken_at timestamptz, workspace_id text NOT NULL DEFAULT 'default',
    ts bigint, created_ts bigint, updated_ts bigint,
    PRIMARY KEY (harness_slug, feature_id))`;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const {
  acquireClaimLocal,
  heartbeatClaimLocal,
  getClaim,
  DEFAULT_WORK_ITEM_TTL_SEC,
} = await import('./work-item-claims');
const wi = await import('./work-items');
const { reconcileClaims } = await import('./work-item-claim-reconcile');

const WS = 'default';
const H = 'papercup';

let db: FreshPgDb;

async function seedFeature(id: string, createdTs: number) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'todo', NULL, ${WS}, ${createdTs}, 0)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claims-concurrency');
  h.sql = db.sql;
  await db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
  await db.sql.unsafe(HFC_DDL);
  // claim_next selects FEATURE_COLS (incl. assignee_rank/rank_writer/rank_updated_at from
  // migrations 131/142/152 + the local-hive rank cols) — replicate work-items-claim setup.
  await db.sql.unsafe(readMigration('131-engineer-issues.sql')).simple();
  await db.sql.unsafe(readMigration('142-work-items-unify.sql')).simple();
  await db.sql.unsafe(readMigration('152-delegate-task-workitems.sql')).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.harness_features_consolidated
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.engineer_issues
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;`).simple();
}, 90_000);

afterAll(async () => { await db?.cleanup(); });

afterEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_item_claims`;
  await db.sql`TRUNCATE harness_shared.harness_features_consolidated, harness_shared.engineer_issues`;
});

describe('C3 — N-way no-double-claim on ONE item (real PG)', () => {
  it('8 concurrent acquires for the same item ⇒ exactly ONE winner, 7 conflicts', async () => {
    const N = 8;
    const item = 'F-solo';
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: `owner-${i}` }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);

    // The PG row has exactly one holder, and it's the winner.
    const winner = winners[0];
    if (!winner.ok) throw new Error('unreachable');
    const held = await getClaim(WS, H, item);
    expect(held?.owner).toBe(winner.claim.owner);
    // Every loser's conflict points at that same single holder.
    for (const l of losers) {
      if (l.ok) throw new Error('unreachable');
      expect(l.conflict.owner).toBe(winner.claim.owner);
    }
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.work_item_claims WHERE work_item_id = ${item}`;
    expect(n).toBe(1);
  });
});

describe('C3 — N>M concurrent claimers over a backlog via claim_next (SKIP LOCKED, real PG)', () => {
  it('M items, N claimers ⇒ each item claimed at most once, exactly M distinct claims', async () => {
    const M = 5;
    const N = 12; // oversubscribed: more claimers than items
    for (let i = 0; i < M; i += 1) await seedFeature(`F-${i}`, 100 + i);

    const claimed = await Promise.all(
      Array.from({ length: N }, (_, i) => wi.claimNextWorkItem({ harness: H, assignee: `swarm-${i}` })),
    );

    const won = claimed.filter((c): c is NonNullable<typeof c> => c != null);
    // Exactly M claimers got an item; the surplus N-M got null (backlog drained).
    expect(won).toHaveLength(M);
    // No item claimed twice (distinct ids), and every seeded item was taken.
    const ids = won.map((w) => w.id).sort();
    expect(new Set(ids).size).toBe(M);
    expect(ids).toEqual(['F-0', 'F-1', 'F-2', 'F-3', 'F-4']);
    // No owner won two items (each got a distinct swarm id, and each id appears ≤ once).
    const owners = won.map((w) => w.assignee);
    expect(new Set(owners).size).toBe(M);

    // PG agrees: every backlog row is now taken by exactly its claimer, none double-taken.
    const rows = await db.sql<{ feature_id: string; taken_by: string | null }[]>`
      SELECT feature_id, taken_by FROM harness_shared.harness_features_consolidated ORDER BY feature_id`;
    expect(rows.every((r) => r.taken_by != null)).toBe(true);
    expect(new Set(rows.map((r) => r.taken_by)).size).toBe(M);
  });
});

describe('C3 — lease TTL expiry ⇒ reclaimable (real PG)', () => {
  it('a lapsed lease is STOLEN by another owner and the claim_id rotates', async () => {
    const item = 'F-lapse';
    const a = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-A' });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error('unreachable');
    const firstClaimId = a.claim.claimId;

    // While the lease is LIVE, a different owner cannot take it.
    const blocked = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-B' });
    expect(blocked.ok).toBe(false);

    // Force the lease to lapse (the locks-test trick — push expires_ts into the past).
    await db.sql`
      UPDATE harness_shared.work_item_claims
         SET expires_ts = clock_timestamp() - interval '1 second'
       WHERE work_item_id = ${item}`;
    expect((await getClaim(WS, H, item))?.expired).toBe(true);

    // Now B steals the lapsed lease; the claim_id rotates (a brand-new grip).
    const stolen = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-B' });
    expect(stolen.ok).toBe(true);
    if (!stolen.ok) throw new Error('unreachable');
    expect(stolen.claim.owner).toBe('owner-B');
    expect(stolen.claim.claimId).not.toBe(firstClaimId);
    expect(stolen.claim.expired).toBe(false);

    const held = await getClaim(WS, H, item);
    expect(held?.owner).toBe('owner-B');
  });

  it('a very-short ttl lapses on its own and is then reclaimable', async () => {
    const item = 'F-shortttl';
    const a = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-A', ttlSec: 1 });
    expect(a.ok).toBe(true);
    // clampTtl floors a 1s ttl to 1s; nudge expires_ts to simulate the elapsed second
    // deterministically (no real sleep — keeps the serial integration run fast).
    await db.sql`
      UPDATE harness_shared.work_item_claims
         SET expires_ts = clock_timestamp() - interval '1 second'
       WHERE work_item_id = ${item}`;
    const reclaimed = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-C' });
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) expect(reclaimed.claim.owner).toBe('owner-C');
  });
});

describe('C3 — heartbeat extends the lease (real PG)', () => {
  it('a heartbeated (live) lease cannot be stolen; a foreign heartbeat is a no-op', async () => {
    const item = 'F-hb';
    // A claims with a SHORT ttl so without a heartbeat it would be near-lapsed.
    const a = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-A', ttlSec: 60 });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error('unreachable');
    const beforeHb = (await getClaim(WS, H, item))!.expiresTs;

    // A heartbeats with a long ttl override → expires_ts moves FORWARD.
    const hb = await heartbeatClaimLocal({
      workspaceId: WS, harnessSlug: H, workItemId: item,
      claimId: a.claim.claimId, owner: 'owner-A', ttlSecOverride: DEFAULT_WORK_ITEM_TTL_SEC,
    });
    expect(hb.renewed).toBe(true);
    expect(hb.held).toBe(true);
    const afterHb = (await getClaim(WS, H, item))!.expiresTs;
    expect(Date.parse(afterHb)).toBeGreaterThan(Date.parse(beforeHb));

    // A concurrent B claim still loses — the lease is live (not lapsed).
    const blocked = await acquireClaimLocal({ workspaceId: WS, harnessSlug: H, workItemId: item, owner: 'owner-B' });
    expect(blocked.ok).toBe(false);

    // A FOREIGN owner's heartbeat is a no-op (wrong owner ⇒ not renewed/held).
    const foreign = await heartbeatClaimLocal({
      workspaceId: WS, harnessSlug: H, workItemId: item,
      claimId: a.claim.claimId, owner: 'owner-B', ttlSecOverride: DEFAULT_WORK_ITEM_TTL_SEC,
    });
    expect(foreign.renewed).toBe(false);
    expect(foreign.held).toBe(false);
    // The holder is unchanged.
    expect((await getClaim(WS, H, item))?.owner).toBe('owner-A');
  });
});

describe('C3 — fail-open reconcile under partition heals deterministically (real PG advisory rows)', () => {
  it('two partitioned advisory leases on one item ⇒ deterministic winner, idempotent', async () => {
    const item = 'F-partition';
    // Two partitioned authorities each fail-open to a LOCAL advisory lease on the SAME
    // item — bypass the PK by writing to two distinct (workspace) partitions, then read
    // them back as the two advisory claims the reconcile sees on heal. (We use the real
    // store to seed: distinct workspace_ids stand in for the two partitioned PGs.)
    const early = await acquireClaimLocal({
      workspaceId: 'part-A', harnessSlug: H, workItemId: item, owner: 'su-early', holderPubkey: 'pk-zzz',
    });
    const late = await acquireClaimLocal({
      workspaceId: 'part-B', harnessSlug: H, workItemId: item, owner: 'su-late', holderPubkey: 'pk-aaa',
    });
    expect(early.ok && late.ok).toBe(true);
    if (!early.ok || !late.ok) throw new Error('unreachable');

    // Force a strict acquiredTs ordering so "earliest wins" is unambiguous (clock_timestamp
    // can tie at sub-ms in a fast test). early = T+0, late = T+5s.
    await db.sql`UPDATE harness_shared.work_item_claims
                    SET acquired_ts = '2026-06-08T12:00:00.000Z'
                  WHERE workspace_id = 'part-A' AND work_item_id = ${item}`;
    await db.sql`UPDATE harness_shared.work_item_claims
                    SET acquired_ts = '2026-06-08T12:00:05.000Z'
                  WHERE workspace_id = 'part-B' AND work_item_id = ${item}`;

    // Read the two advisory rows back out of REAL PG as the reconcile input.
    const rows = await db.sql<
      { work_item_id: string; holder_pubkey: string; owner: string; claim_id: string; acquired_ts: string }[]
    >`SELECT work_item_id, holder_pubkey, owner, claim_id, acquired_ts
        FROM harness_shared.work_item_claims
       WHERE work_item_id = ${item} ORDER BY acquired_ts`;
    expect(rows).toHaveLength(2);
    const advisory: AdvisoryClaim[] = rows.map((r) => ({
      workItemId: r.work_item_id,
      holderPubkey: r.holder_pubkey,
      owner: r.owner,
      claimId: r.claim_id,
      acquiredTs: new Date(r.acquired_ts).toISOString(),
    }));

    // Earliest acquiredTs wins (su-early), regardless of input order.
    const resolved = reconcileClaims(advisory);
    expect(resolved?.winner.owner).toBe('su-early');
    expect(resolved?.losers.map((l) => l.owner)).toEqual(['su-late']);
    const resolvedReversed = reconcileClaims([...advisory].reverse());
    expect(resolvedReversed?.winner.owner).toBe('su-early'); // commutative

    // Idempotent: feeding the winner back yields the same winner, no losers (partition healed).
    const again = reconcileClaims([resolved!.winner]);
    expect(again?.winner.owner).toBe('su-early');
    expect(again?.losers).toEqual([]);
  });

  it('same-instant partition ⇒ lowest holderPubkey wins (matches the authority election)', async () => {
    const item = 'F-tie';
    await acquireClaimLocal({ workspaceId: 'part-A', harnessSlug: H, workItemId: item, owner: 'su-hi', holderPubkey: 'pk-zzz' });
    await acquireClaimLocal({ workspaceId: 'part-B', harnessSlug: H, workItemId: item, owner: 'su-lo', holderPubkey: 'pk-aaa' });
    // Identical acquiredTs ⇒ the pubkey tiebreak decides.
    await db.sql`UPDATE harness_shared.work_item_claims
                    SET acquired_ts = '2026-06-08T12:00:00.000Z' WHERE work_item_id = ${item}`;
    const rows = await db.sql<
      { holder_pubkey: string; owner: string; claim_id: string; acquired_ts: string }[]
    >`SELECT holder_pubkey, owner, claim_id, acquired_ts
        FROM harness_shared.work_item_claims WHERE work_item_id = ${item}`;
    const advisory: AdvisoryClaim[] = rows.map((r) => ({
      workItemId: item, holderPubkey: r.holder_pubkey, owner: r.owner,
      claimId: r.claim_id, acquiredTs: new Date(r.acquired_ts).toISOString(),
    }));
    expect(reconcileClaims(advisory)?.winner.owner).toBe('su-lo'); // pk-aaa < pk-zzz
  });
});
