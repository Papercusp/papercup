import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { AgentIdentity } from '../coordination/identity';
import { recordOwnerSelectedReviewInTransaction, type OwnerSelectedReviewReceipt } from './plan-start-owner-review';
import { listSpecClauses, type SpecClauseSql } from './spec-clauses-store';

let db: FreshPgDb;
const identity: AgentIdentity = { ownerId: 'implementer', ownerLabel: 'Implementer',
  source: 'omp-hook-session', workspaceId: 'review-binding', userId: null };
function receipt(overrides: Partial<OwnerSelectedReviewReceipt> = {}): OwnerSelectedReviewReceipt {
  return { schema: 'plan-owner-selected-review-v2',
    scope: { workspaceId: 'review-binding', harnessSlug: 'project', planSlug: 'migration' },
    requestedBy: identity.ownerId, reviewerId: 'independent-reviewer', reviewedAt: '2026-10-03T00:00:00Z',
    request: { directiveId: 42, reportId: 'report-a', bodySha256: 'a'.repeat(64),
      barSetHash: 'b'.repeat(64), specSetHash: 'c'.repeat(64),
      selectionText: 'Accept your review as adequate.', reviewConclusion: 'Approve the reviewed contract.',
      dispositions: 'Retain independent product acceptance.' },
    contract: [{ specId: 'S-1', semanticHash: 'd'.repeat(64), live: true }], ...overrides };
}
const bind = (value = receipt(), author = identity) =>
  db.sql.begin(tx => recordOwnerSelectedReviewInTransaction(tx, value, author));
async function count() {
  const [row] = await db.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM harness_shared.plan_revisions`;
  return row!.count;
}

beforeAll(async () => {
  db = await createFreshPgDb('ownerreview');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.plan_revisions (
      workspace_id text, harness_slug text, plan_slug text, seq integer,
      content_hash text, content_snapshot text, rationale text,
      author_kind text, author_id text CHECK (author_id <> 'fail'), session_id text,
      session_kind text, created_at bigint,
      UNIQUE (workspace_id, harness_slug, plan_slug, seq));
    CREATE TABLE harness_shared.plan_spec_clauses (
      workspace_id text, harness_slug text, plan_slug text, spec_id text, source_val_id text,
      current_revision integer);
    CREATE TABLE harness_shared.plan_spec_clause_revisions (
      workspace_id text, harness_slug text, plan_slug text, spec_id text, revision integer,
      plan_item_id text DEFAULT 'P-001', behavior text, behavior_class text DEFAULT 'happy-path',
      required_evidence text[] DEFAULT '{}', required_test_layers text[] DEFAULT '{}',
      mutation_required boolean DEFAULT false, lifecycle_status text DEFAULT 'active',
      supersedes_spec_id text, supersedes_revision integer, exemption jsonb, falsifier jsonb,
      content_hash text DEFAULT 'hash', created_by text DEFAULT 'implementer',
      created_at timestamptz DEFAULT now(), accepted_by text, accepted_at timestamptz,
      acceptance_ref text, source_bar_key text, source_bar_hash text, source_bar_set_hash text,
      source_rubric_slug text, source_rubric_revision integer, evidence_plane text);
  `);
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.plan_revisions, harness_shared.plan_spec_clauses, harness_shared.plan_spec_clause_revisions');
});

describe('verified owner-review binding on the real revision spine', () => {
  it('idempotent concurrent retries create one immutable receipt', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => bind()));
    expect(results.every(result => result.ok)).toBe(true);
    expect(await count()).toBe(1);
  });

  it.each(['report', 'body', 'plan', 'harness', 'reviewer', 'contract'])(
    'cannot reuse one selection for a different %s', async kind => {
      expect((await bind()).ok).toBe(true);
      const next = receipt();
      if (kind === 'report') next.request.reportId = 'report-b';
      if (kind === 'body') next.request.bodySha256 = 'e'.repeat(64);
      if (kind === 'plan') next.scope.planSlug = 'other-plan';
      if (kind === 'harness') next.scope.harnessSlug = 'other-project';
      if (kind === 'reviewer') next.reviewerId = 'other-reviewer';
      if (kind === 'contract') next.contract[0]!.semanticHash = 'e'.repeat(64);
      expect(await bind(next)).toEqual({ ok: false, reason: 'owner_selection_already_bound' });
      expect(await count()).toBe(1);
    });

  it('simultaneous competing plans have exactly one winner', async () => {
    const second = receipt();
    second.scope.planSlug = 'other-plan';
    second.request.reportId = 'report-b';
    const results = await Promise.all([bind(), bind(second)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'owner_selection_already_bound' }]);
    expect(await count()).toBe(1);
  });

  it('does not consume a selection when its enclosing transaction rolls back', async () => {
    await expect(db.sql.begin(async tx => {
      await recordOwnerSelectedReviewInTransaction(tx, receipt(), identity);
      throw new Error('rollback after binding');
    })).rejects.toThrow('rollback after binding');
    expect(await count()).toBe(0);
    expect((await bind()).ok).toBe(true);
  });

  it('strict revision failure leaves no partial binding and can be retried', async () => {
    await expect(bind(receipt(), { ...identity, ownerId: 'fail' })).rejects.toThrow('plan revision unavailable');
    expect(await count()).toBe(0);
    expect((await bind()).ok).toBe(true);
    expect(await count()).toBe(1);
  });

  it('keeps same-number directives in different workspaces independent', async () => {
    const second = receipt();
    second.scope.workspaceId = 'other-workspace';
    expect((await bind()).ok).toBe(true);
    expect((await bind(second)).ok).toBe(true);
    expect(await count()).toBe(2);
  });

  it('does not upgrade an old unbound receipt into authority', async () => {
    const old = { ...receipt(), schema: 'plan-owner-selected-review-v1' };
    await db.sql`INSERT INTO harness_shared.plan_revisions
      (workspace_id, harness_slug, plan_slug, seq, content_snapshot, rationale)
      VALUES ('review-binding', 'project', 'migration', 1, ${JSON.stringify(old)},
        'plans:start owner-selected pre-implementation review')`;
    expect(await bind()).toEqual({ ok: false, reason: 'owner_selection_already_bound' });
    expect(await count()).toBe(1);
  });
});

describe('clause reads inside the verification transaction', () => {
  it('sees uncommitted clauses through the caller transaction and rolls them back', async () => {
    await expect(db.sql.begin(async tx => {
      await tx`INSERT INTO harness_shared.plan_spec_clauses VALUES
        ('review-binding', 'project', 'migration', 'S-1', NULL, 1)`;
      await tx`INSERT INTO harness_shared.plan_spec_clause_revisions
        (workspace_id, harness_slug, plan_slug, spec_id, revision, behavior)
        VALUES ('review-binding', 'project', 'migration', 'S-1', 1, 'Uncommitted behavior')`;
      const scope = { workspaceId: 'review-binding', harnessSlug: 'project', planSlug: 'migration' };
      const clauses = await listSpecClauses(scope, { ...scope, executor: tx as unknown as SpecClauseSql });
      expect(clauses).toHaveLength(1);
      expect(clauses[0]!.behavior).toBe('Uncommitted behavior');
      throw new Error('rollback private clauses');
    })).rejects.toThrow('rollback private clauses');
    const [row] = await db.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM harness_shared.plan_spec_clauses`;
    expect(row!.count).toBe(0);
  });

  it('refuses a mismatched transaction scope before any read', async () => {
    const scope = { workspaceId: 'review-binding', harnessSlug: 'project', planSlug: 'migration' };
    await expect(listSpecClauses(scope, { ...scope, workspaceId: 'foreign',
      executor: db.sql as unknown as SpecClauseSql })).rejects.toThrow('spec_snapshot_transaction_scope_mismatch');
  });
});
