/**
 * work-items-audit-reconciler-sourced.integration.test.ts — the `reconciler-sourced`
 * completion-integrity bucket, end-to-end against real Postgres.
 *
 * ## Why this file exists (P-006 / D-012)
 *
 * P-006 DELETED the `no-evidence` bareness audit per D-003: P-004 made structured
 * evidence required at write time, so an evidence-less close lands
 * `authority:'proposed'` and there is no longer a wrong value for a later sweep to
 * re-verify. This file is the REPLACEMENT for the integration suite that covered it
 * (`work-items-audit-no-evidence.integration.test.ts`, deleted with the predicate).
 *
 * The reason it is not simply a deletion: the `no-evidence` branch was also the
 * FALLBACK branch of `auditPredicateSql`, and it carried a second, unrelated rule —
 * EI-18677799334390930's always-flag on {@link RECONCILER_SYSTEM_ACTOR}. Removing the
 * branch wholesale would have dropped that detector with NO test failing anywhere.
 * D-012 rescued it as its own named bucket; this suite is the guard that the rescue
 * actually works against a real database, not just in the type system.
 *
 * `plan-items/reconcile-linked-work-items.ts` terminal-closes a work-item by MIRRORING
 * its linked plan item's status: it calls `setWorkItemState` with
 * `completionAuthority:'proposed'` and no completionRef. The proposed judgement is the
 * write-time signal that this is not independent verification, while the actor-keyed
 * `reconciler-sourced` audit remains visible. It must not be mistaken for a
 * `no-completion-record` hit, because an authority judgement is itself a completion
 * record — the failure mode is a mis-flipped plan item silently marking a live defect
 * "fixed".
 *
 * Proves (testcontainer; Docker required):
 *   • a terminal row credited to the reconciler IS listed, in BOTH families;
 *   • an ordinary terminal row is NOT listed, even carrying a synthetic-looking ref;
 *   • a NON-terminal reconciler row is never listed (an open item owes no evidence yet);
 *   • ⚠ the load-bearing one: a reconciler row that DOES carry structured
 *     `_completionEvidence` is STILL flagged — the bucket keys on the ACTOR, so a
 *     future caller adding a well-meaning evidence stamp to that write path cannot
 *     silently defeat it;
 *   • `audit` composes with an explicit `state`;
 *   • omitted `audit` still lists everything.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-audit-reconciler-sourced.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { RECONCILER_SYSTEM_ACTOR } from './completion-audit';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** Seed one work_items base row (either family — item_kind decides). */
async function seed(
  id: string,
  opts: {
    kind?: string;
    status?: string;
    terminalRef?: string | null;
    terminalOwner?: string | null;
    authority?: string | null;
    createdTs?: number;
    hasEvidence?: boolean;
  } = {},
) {
  const payload = opts.hasEvidence
    ? { _completionEvidence: { verifiedHow: 'unit', testsRun: `${id} test suite` } }
    : {};
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts,
       terminal_completion_ref, terminal_owner, authority, payload)
    VALUES (${H}, ${id}, ${opts.kind ?? 'feature'}, ${`title ${id}`}, ${opts.status ?? 'open'},
       ${WS}, ${opts.createdTs ?? 0}, ${opts.createdTs ?? 0}, ${opts.terminalRef ?? null},
       ${opts.terminalOwner ?? null}, ${opts.authority ?? null}, ${JSON.stringify(payload)}::text::jsonb)`;
}

/** The exact shape reconcile-linked-work-items.ts writes: proposed authority + the
 * reconciler actor, and NO completion ref. */
const reconciled = (over: { kind?: string; status?: string; hasEvidence?: boolean } = {}) => ({
  terminalRef: null,
  terminalOwner: RECONCILER_SYSTEM_ACTOR,
  authority: 'proposed',
  ...over,
});

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

beforeAll(async () => {
  db = await createFreshPgDb('wi-audit-reconciler-sourced');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe("listWorkItems { audit: 'reconciler-sourced' } (P-006/D-012, EI-18677799334390930)", () => {
  it('lists TERMINAL reconciler closes in BOTH families; excludes ordinary and open rows', async () => {
    await seed('F-reconciled', reconciled({ kind: 'feature', status: 'done' })); // HIT
    await seed('WI-reconciled', reconciled({ kind: 'change', status: 'resolved' })); // HIT
    // An ordinary agent close — carries a ref, a real owner: NOT this bucket's business.
    await seed('F-agent-close', {
      kind: 'feature',
      status: 'done',
      terminalRef: 'completion:abc',
      terminalOwner: 'su-1234',
      hasEvidence: true,
    });
    // A reconciler-owned row that never went terminal owes nothing yet.
    await seed('F-open-reconciled', reconciled({ kind: 'feature', status: 'in-progress' }));

    const audited = await wi.listWorkItems({ harness: H, audit: 'reconciler-sourced' });
    expect(ids(audited)).toEqual(['F-reconciled', 'WI-reconciled']);

    // The proposed authority is a completion record, so these rows are intentionally
    // absent from the separate bare-write audit bucket.
    const bare = await wi.listWorkItems({ harness: H, audit: 'no-completion-record' });
    expect(ids(bare)).toEqual([]);
  });

  it('a dropped/deprecated reconciler close is audit material too (the whole terminal set)', async () => {
    await seed('F-dropped', reconciled({ kind: 'feature', status: 'dropped' }));
    await seed('WI-deprecated', reconciled({ kind: 'change', status: 'deprecated' }));
    const audited = await wi.listWorkItems({ harness: H, audit: 'reconciler-sourced' });
    expect(ids(audited)).toEqual(['F-dropped', 'WI-deprecated']);
  });

  /**
   * The regression this bucket exists for. The rule is keyed on the ACTOR, never on an
   * evidence key — so stamping `_completionEvidence` onto the reconcile write path
   * (a plausible future "improvement") must NOT make these rows disappear from the
   * audit. A reconcile close mirrors an adjacent plan item's status; it is not
   * independent verification no matter what it claims about itself.
   */
  it('STILL flags a reconciler close that carries structured evidence (actor-keyed, not evidence-keyed)', async () => {
    await seed('F-reconciled-evidenced', reconciled({ kind: 'feature', status: 'done', hasEvidence: true }));
    const audited = await wi.listWorkItems({ harness: H, audit: 'reconciler-sourced' });
    expect(ids(audited)).toEqual(['F-reconciled-evidenced']);
  });

  it('composes with an explicit `state` — audit narrowed to that close state only', async () => {
    await seed('F-reconciled', reconciled({ kind: 'feature', status: 'done' }));
    await seed('WI-reconciled', reconciled({ kind: 'change', status: 'resolved' }));
    const onlyDone = await wi.listWorkItems({ harness: H, audit: 'reconciler-sourced', state: 'done' });
    expect(ids(onlyDone)).toEqual(['F-reconciled']);
  });

  it('omitted audit is unaffected — reconciler and ordinary rows both list', async () => {
    await seed('F-reconciled', reconciled({ kind: 'feature', status: 'done' }));
    await seed('F-agent-close', {
      kind: 'feature',
      status: 'done',
      terminalRef: 'completion:abc',
      terminalOwner: 'su-1234',
      hasEvidence: true,
    });
    const plain = await wi.listWorkItems({ harness: H, state: 'done' });
    expect(ids(plain)).toEqual(['F-agent-close', 'F-reconciled']);
  });

  it('an empty backlog audits to an empty list (never throws)', async () => {
    expect(await wi.listWorkItems({ harness: H, audit: 'reconciler-sourced' })).toEqual([]);
  });
});
