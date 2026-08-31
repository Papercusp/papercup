/**
 * work-items-audit-worked-then-abandoned.integration.test.ts — the FIRST audit bucket
 * defined over OPEN rows, end-to-end against real Postgres.
 *
 * ## The defect it detects (EI-19320339017813143)
 *
 * `work_items:release` is the correct verb for "I am stopping work on this", and after
 * confirming an item needs no change, "I am stopping work" feels accurate. But the item
 * is DONE, and releasing it returns it to the backlog as unclaimed work — so the next
 * agent to scan the queue re-derives the same conclusion and releases it again. WI-5623
 * sat `open` + `critical` for 6 days after being verified fixed, its evidence unread in
 * its own checkpoint. Three items from one 2026-08-01 retrospective cluster
 * (EI-19278588744322125 / -89690487622 / -90581840106) each sat open ~1 month after the
 * work they asked for had shipped; closing all three needed no code, only someone
 * reading the record.
 *
 * ## Why this file exists SEPARATELY from the SQL-fragment unit tests
 *
 * `completion-audit.test.ts` proves the fragment's TEXT. It cannot prove which rows come
 * back, and the failure mode here is specifically a query that runs fine and returns
 * nothing. Until this bucket, the state scope was not part of an audit's definition at
 * all: eleven call sites each re-typed `state = ANY(<TERMINAL>) AND <predicate>`. AND
 * that terminal-only clause onto an open-only predicate and you get ZERO ROWS, forever,
 * with no error — and an audit reporting "nothing to see" is indistinguishable from an
 * audit that is clean. That is the exact confusion EI-10867 was filed for, one module
 * over. Only a real query against real rows falsifies it.
 *
 * Proves (testcontainer; Docker required):
 *   • MUST FLAG: an open row released beyond the staleness floor — in BOTH families,
 *     which is load-bearing because 94% of the live population is issue-family and
 *     reaches this through the `engineer_issues` view that migration 1041 widened;
 *   • MUST NOT FLAG: a FRESHLY released row (worked, but still plausibly in flight);
 *   • MUST NOT FLAG: a NEVER-worked row (open and stale, but nobody ever held it) —
 *     the discriminator that separates this bucket from "the backlog";
 *   • MUST NOT FLAG: a TERMINAL row that was released long ago — the open-scope guard;
 *   • the terminal buckets still behave after the shared-helper refactor;
 *   • `audit` composes with an explicit `state`, and omitting it changes nothing.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-audit-worked-then-abandoned.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { WORKED_THEN_ABANDONED_STALE_DAYS } from './completion-audit';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/**
 * Seed one work_items base row. `releasedDaysAgo` writes the stamps the release path
 * writes (assignee cleared, `last_released_by`/`last_released_at` set) — see the
 * fixture's own UPDATE trigger, which sets exactly this pair when an assignee goes NULL.
 */
async function seed(
  id: string,
  opts: {
    kind?: string;
    status?: string;
    releasedDaysAgo?: number | null;
    releasedBy?: string | null;
  } = {},
) {
  const days = opts.releasedDaysAgo ?? null;
  // A release stamps BOTH columns together. `releasedBy` is separable only so the
  // half-stamped row below can be constructed deliberately.
  const by = opts.releasedBy === undefined ? (days == null ? null : 'su-prior-holder') : opts.releasedBy;
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts,
       last_released_by, last_released_at)
    VALUES (${H}, ${id}, ${opts.kind ?? 'feature'}, ${`title ${id}`}, ${opts.status ?? 'open'},
       ${WS}, 0, 0, ${by},
       ${days == null ? null : db.sql`now() - make_interval(days => ${days})`})`;
}

const STALE = WORKED_THEN_ABANDONED_STALE_DAYS + 9; // comfortably past the floor
const FRESH = 2; // worked recently — still plausibly in flight

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
const audited = () => wi.listWorkItems({ harness: H, audit: 'worked-then-abandoned' });

beforeAll(async () => {
  db = await createFreshPgDb('wi-audit-worked-then-abandoned');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe("listWorkItems { audit: 'worked-then-abandoned' } (EI-19320339017813143)", () => {
  it('FLAGS a stale worked-then-released open row in BOTH families', async () => {
    await seed('F-abandoned', { kind: 'feature', status: 'open', releasedDaysAgo: STALE });
    // Issue-family reaches the release columns only through the engineer_issues view
    // that migration 1041 widened. 94% of the live population is this family, so a
    // regression here would leave the bucket LOOKING correct while missing almost
    // everything — hence one row per issue kind rather than a token single case.
    await seed('WI-abandoned-change', { kind: 'change', status: 'open', releasedDaysAgo: STALE });
    await seed('WI-abandoned-bug', { kind: 'bug', status: 'open', releasedDaysAgo: STALE });
    await seed('WI-abandoned-task', { kind: 'task', status: 'open', releasedDaysAgo: STALE });

    expect(ids(await audited())).toEqual([
      'F-abandoned',
      'WI-abandoned-bug',
      'WI-abandoned-change',
      'WI-abandoned-task',
    ]);
  });

  it('does NOT flag a FRESHLY released row — that release may still be in flight', async () => {
    await seed('F-just-released', { kind: 'feature', status: 'open', releasedDaysAgo: FRESH });
    await seed('WI-just-released', { kind: 'change', status: 'open', releasedDaysAgo: FRESH });
    expect(ids(await audited())).toEqual([]);
  });

  /**
   * The discriminator that makes this bucket an audit rather than a synonym for "the
   * backlog". An old, open, never-claimed item is ordinary un-started work and says
   * nothing about the release-instead-of-complete failure. If this ever starts matching,
   * the bucket has degenerated into a list of everything and is worse than useless —
   * a reader would have to adjudicate thousands of rows to find the real ones.
   */
  it('does NOT flag a NEVER-worked row, however old and open it is', async () => {
    await seed('F-never-worked', { kind: 'feature', status: 'open', releasedDaysAgo: null });
    await seed('WI-never-worked', { kind: 'change', status: 'open', releasedDaysAgo: null });
    expect(ids(await audited())).toEqual([]);
  });

  /**
   * The open-scope guard, and the regression this bucket's plumbing exists to prevent in
   * REVERSE: a terminal row released long ago is somebody's completed work, not an
   * abandonment. Before EI-19320339017813143 every call site hard-coded a terminal-only
   * clause; the failure it caused was the empty-result direction (asserted below), and
   * this is the other side of the same boundary.
   */
  it('does NOT flag TERMINAL rows, however long ago they were released', async () => {
    await seed('F-done', { kind: 'feature', status: 'done', releasedDaysAgo: STALE });
    await seed('F-dropped', { kind: 'feature', status: 'dropped', releasedDaysAgo: STALE });
    await seed('WI-resolved', { kind: 'change', status: 'resolved', releasedDaysAgo: STALE });
    await seed('WI-closed', { kind: 'change', status: 'closed', releasedDaysAgo: STALE });
    expect(ids(await audited())).toEqual([]);
  });

  /**
   * ⚠ THE FALSE-POSITIVE REGRESSION, caught on live data before this shipped.
   *
   * `ISSUE_TERMINAL_STATES` omitted `dropped` until EI-21921121818266895 (now fixed),
   * so at the time this shipped, negating the issue family's OWN list reclassified
   * every dropped issue as open. Measured live 2026-08-30: 645 issue-family hits of
   * which 263 (41%, the largest single category) were `dropped` — deliberately closed
   * work handed to a reader as abandoned. `auditWhereSql` negates the CROSS-FAMILY
   * union instead — belt-and-suspenders even now that ISSUE_TERMINAL_STATES itself
   * is complete, since a future per-family list is exactly this bug waiting to recur.
   *
   * This is its own test rather than another row in the case above because it is the
   * one that fails if the open branch ever goes back to the caller's family list, and
   * it must not be able to hide behind three sibling assertions.
   */
  it('does NOT flag a DROPPED issue-family row — the negation scopes on the cross-family union, not the caller-family list', async () => {
    await seed('WI-dropped-change', { kind: 'change', status: 'dropped', releasedDaysAgo: STALE });
    await seed('WI-dropped-bug', { kind: 'bug', status: 'dropped', releasedDaysAgo: STALE });
    await seed('WI-dropped-task', { kind: 'task', status: 'dropped', releasedDaysAgo: STALE });
    // Paired with a genuine hit, so a bucket that returns nothing AT ALL cannot pass.
    await seed('WI-really-abandoned', { kind: 'change', status: 'open', releasedDaysAgo: STALE });

    expect(ids(await audited())).toEqual(['WI-really-abandoned']);
  });

  /**
   * THE LOAD-BEARING CASE. Everything above could pass while the bucket returns nothing
   * for a reason no other assertion notices — a reinstated terminal-only conjunct makes
   * EVERY test that asserts an empty list still pass. This one fails if the scope is
   * ever reverted, and it is the only one that does.
   */
  it('a stale open row and a stale terminal row TOGETHER: exactly the open one is returned', async () => {
    await seed('F-open-abandoned', { kind: 'feature', status: 'open', releasedDaysAgo: STALE });
    await seed('F-terminal-released', { kind: 'feature', status: 'done', releasedDaysAgo: STALE });
    await seed('WI-open-abandoned', { kind: 'change', status: 'open', releasedDaysAgo: STALE });
    await seed('WI-terminal-released', { kind: 'change', status: 'resolved', releasedDaysAgo: STALE });

    const hits = ids(await audited());
    expect(hits).toEqual(['F-open-abandoned', 'WI-open-abandoned']);
    expect(hits).not.toHaveLength(0); // an empty result is the reverted-scope signature
  });

  it('requires BOTH release stamps — a half-stamped row is not evidence of a release', async () => {
    // last_released_at set, last_released_by NULL. Neither column alone establishes that
    // a holder worked and let go, and the predicate says so explicitly rather than
    // relying on the write path always setting the pair.
    await seed('F-half-stamped', { kind: 'feature', status: 'open', releasedDaysAgo: STALE, releasedBy: null });
    expect(ids(await audited())).toEqual([]);
  });

  it('composes with an explicit `state`', async () => {
    await seed('F-open', { kind: 'feature', status: 'open', releasedDaysAgo: STALE });
    await seed('F-in-progress', { kind: 'feature', status: 'in-progress', releasedDaysAgo: STALE });
    const onlyOpen = await wi.listWorkItems({ harness: H, audit: 'worked-then-abandoned', state: 'open' });
    expect(ids(onlyOpen)).toEqual(['F-open']);
  });

  it('omitting `audit` is unaffected — abandoned and never-worked rows both list', async () => {
    await seed('F-abandoned', { kind: 'feature', status: 'open', releasedDaysAgo: STALE });
    await seed('F-never-worked', { kind: 'feature', status: 'open', releasedDaysAgo: null });
    expect(ids(await wi.listWorkItems({ harness: H }))).toEqual(['F-abandoned', 'F-never-worked']);
  });

  /**
   * The refactor that made this bucket possible rewrote the state clause at all eleven
   * audit call sites. This asserts a TERMINAL bucket still selects terminal rows through
   * the shared helper — the two scopes are computed by one function now, so a mistake in
   * it would break both directions at once.
   */
  it('the terminal buckets still work after the shared state-scope refactor', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts,
         terminal_completion_ref, authority)
      VALUES (${H}, 'F-bare-close', 'feature', 'bare close', 'done', ${WS}, 0, 0, NULL, NULL),
             (${H}, 'F-open-bare', 'feature', 'still open', 'open', ${WS}, 0, 0, NULL, NULL)`;
    const bare = await wi.listWorkItems({ harness: H, audit: 'no-completion-record' });
    // The terminal one only: an open row has no close to judge.
    expect(ids(bare)).toEqual(['F-bare-close']);
  });

  /**
   * `countWorkItems` mirrors the list's WHERE so "N of TOTAL" stays honest (the
   * count-vs-list parity discipline WI-5512/P-013 established). A new scope is exactly
   * the kind of change that drifts the two apart.
   */
  it('countWorkItems agrees with the list for this bucket', async () => {
    await seed('F-abandoned', { kind: 'feature', status: 'open', releasedDaysAgo: STALE });
    await seed('WI-abandoned', { kind: 'change', status: 'open', releasedDaysAgo: STALE });
    await seed('F-terminal', { kind: 'feature', status: 'done', releasedDaysAgo: STALE });
    await seed('F-never-worked', { kind: 'feature', status: 'open', releasedDaysAgo: null });

    const rows = await audited();
    const total = await wi.countWorkItems({ harness: H, audit: 'worked-then-abandoned' });
    expect(total).toBe(rows.length);
    expect(total).toBe(2);
  });
});
