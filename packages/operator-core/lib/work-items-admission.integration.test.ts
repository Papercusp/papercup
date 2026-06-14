/**
 * work-items-admission.integration.test.ts — the G2 admission gate enforced on EVERY
 * claim path, against real Postgres (shared-hive-trust-admission-2026-06-14, Phase 1).
 *
 * The predecessor (papercusp-user-protection-gate-2026-05-31) pinned the gate on the
 * FRONTIER read only (user-protection-gate.integration.test.ts). The audit found the
 * Hive's fleet/blackboard distribution layer — claim_next, explicit claim, replica
 * fan-out, place_batch — read the consolidated table directly and BYPASSED the gate,
 * so un-screened remote work was claimable + runnable. This pins the gate on those
 * paths against a real testcontainer PG; a mock-pg test structurally cannot catch a
 * missing WHERE clause, only a real filter can. Gated on Docker like the other *-pg
 * integration tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { claimNextWorkItem, claimWorkItem, listWorkItems } = await import('./work-items');
const { claimReplicaSlot } = await import('./work-item-redundancy');

const WS = 'default';
const HARNESS = 'h1';

const HFC_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    workspace_id text NOT NULL DEFAULT 'default',
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text, summary text, status text DEFAULT 'todo',
    item_kind text DEFAULT 'feature',
    taken_by text, taken_at timestamptz,
    parent_id text, payload jsonb,
    assignee_rank integer, rank_writer text, rank_updated_at timestamptz,
    swarm_affinity text, feature_order integer,
    redundancy integer,
    origin text NOT NULL DEFAULT 'local',
    audit_verdict text,
    verified_author_github_user_id bigint,
    created_ts bigint, updated_ts bigint,
    PRIMARY KEY (harness_slug, feature_id))`;

// Phase 3 / P-009: the owner-keyed LOCAL trust list the admission predicate consults.
const USER_TRUST_LIST_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.user_trust_list (
    workspace_id text NOT NULL,
    trusted_github_user_id bigint NOT NULL,
    note text,
    created_ts bigint NOT NULL,
    PRIMARY KEY (workspace_id, trusted_github_user_id))`;

const REPLICAS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_replicas (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    work_item_id text NOT NULL,
    replica_index integer NOT NULL,
    redundancy integer NOT NULL,
    claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL,
    owner_label text,
    holder_pubkey text,
    ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    status text DEFAULT 'claimed' NOT NULL,
    result jsonb,
    judge_composite double precision, judge_rationale text, judge_model text,
    rubric_hash text, judge_cost_usd double precision, judged_ts timestamptz,
    created_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    updated_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_replicas_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id, replica_index),
    CONSTRAINT work_item_replicas_status_check CHECK (status IN ('claimed','complete','winner','loser')))`;

// getWorkItem (called by claimWorkItem) checks getIssue FIRST for every id — issue ids are
// globally unique — so the table must exist. Left EMPTY: getIssue returns null and the lookup
// falls through to the feature row. Minimal columns = exactly what ISSUE_COLS selects.
const ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default',
    issue_id text NOT NULL,
    kind text, scope text, title text, body text, severity text, source text, state text,
    assignee text, assigned_by text, assigned_at timestamptz, payload jsonb,
    found_during text, linked_feature_id text, created_by text, signal_origin text,
    assignee_rank integer, rank_writer text, rank_updated_at timestamptz,
    created_at timestamptz, updated_at timestamptz,
    PRIMARY KEY (workspace_id, issue_id))`;

/** Seed one todo feature row differing ONLY in origin / audit_verdict (+ optional redundancy). */
function ins(fid: string, origin: string, verdict: string | null, ts: number, redundancy: number | null = null) {
  return h.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, audit_verdict, redundancy, created_ts, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${fid}, ${fid}, 'todo', 'feature', ${origin}, ${verdict}, ${redundancy}, ${ts}, ${ts})`;
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-admission');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  await db.sql.unsafe(REPLICAS_DDL);
  await db.sql.unsafe(ISSUES_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
  await db.sql`DELETE FROM harness_shared.work_item_replicas`;
  await db.sql`DELETE FROM harness_shared.user_trust_list`;
});

/** Seed a feature with a VERIFIED author id (what P-008 stamps) — for the trust-leg cases. */
function insVerified(fid: string, origin: string, verdict: string | null, ts: number, verifiedAuthorId: number | null) {
  return h.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, audit_verdict, verified_author_github_user_id, created_ts, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${fid}, ${fid}, 'todo', 'feature', ${origin}, ${verdict}, ${verifiedAuthorId}, ${ts}, ${ts})`;
}

/** Add a trusted github id to a workspace's local trust list (defaults to the test WS). */
function trust(githubId: number, ws: string = WS) {
  return h.sql`
    INSERT INTO harness_shared.user_trust_list (workspace_id, trusted_github_user_id, created_ts)
    VALUES (${ws}, ${githubId}, 1)`;
}

describe('G2 admission gate — every claim path (real PG)', () => {
  it('claim_next (self-selection) never grabs a remote, un-admitted item', async () => {
    await ins('F-LOCAL', 'local', null, 1);
    await ins('F-ADMITTED', 'remote', 'admit', 2);
    await ins('F-PENDING', 'remote', null, 3);
    await ins('F-REJECTED', 'remote', 'reject', 4);

    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const wi = await claimNextWorkItem({ harness: HARNESS, assignee: `bee-${i}` });
      if (wi) got.push(wi.id);
    }
    expect(got.sort()).toEqual(['F-ADMITTED', 'F-LOCAL']);
    expect(got).not.toContain('F-PENDING');
    expect(got).not.toContain('F-REJECTED');
  });

  it('explicit named claim of a remote, un-admitted item returns null; local + admitted succeed', async () => {
    await ins('F-LOCAL', 'local', null, 1);
    await ins('F-ADMITTED', 'remote', 'admit', 2);
    await ins('F-PENDING', 'remote', null, 3);

    expect(await claimWorkItem('F-PENDING', 'bee', { harness: HARNESS })).toBeNull();
    expect(await claimWorkItem('F-LOCAL', 'bee', { harness: HARNESS })).not.toBeNull();
    expect(await claimWorkItem('F-ADMITTED', 'bee', { harness: HARNESS })).not.toBeNull();
  });

  it('replica fan-out refuses a remote, un-admitted item (not-admitted); admits an admitted one', async () => {
    await ins('F-PENDING', 'remote', null, 1, 3);
    await ins('F-ADMITTED', 'remote', 'admit', 2, 3);

    const refused = await claimReplicaSlot({ harnessSlug: HARNESS, workItemId: 'F-PENDING', owner: 'bee' });
    expect(refused).toEqual({ ok: false, reason: 'not-admitted' });

    const ok = await claimReplicaSlot({ harnessSlug: HARNESS, workItemId: 'F-ADMITTED', owner: 'bee' });
    expect(ok.ok).toBe(true);
  });

  it('surfaces origin + auditVerdict on the WorkItem (placement visibility, P-005)', async () => {
    await ins('F-PENDING', 'remote', null, 1);
    const [wi] = await listWorkItems({ harness: HARNESS, kind: 'feature' });
    expect(wi.origin).toBe('remote');
    expect(wi.auditVerdict).toBeNull();
  });

  it('ANTI-TAUTOLOGY: the un-admitted rows are otherwise valid todo items — only the gate skips them', async () => {
    await ins('F-PENDING', 'remote', null, 1);
    await ins('F-REJECTED', 'remote', 'reject', 2);
    // Both surface in the unified list (todo, unassigned) — so a difference in the
    // CLAIMED set is attributable solely to the admission gate, not status/assignment.
    const items = await listWorkItems({ harness: HARNESS, kind: 'feature' });
    expect(items.map((i) => i.id).sort()).toEqual(['F-PENDING', 'F-REJECTED']);
    // ...yet neither is claimable.
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'bee' })).toBeNull();
  });
});

describe('G2 trust leg — owner-keyed LOCAL trust list (Phase 3 / P-010, real PG)', () => {
  it('claim_next: a remote+un-admitted item whose VERIFIED author is trusted IS claimable', async () => {
    await insVerified('F-TRUSTED', 'remote', null, 1, 42);
    await trust(42);
    const wi = await claimNextWorkItem({ harness: HARNESS, assignee: 'bee' });
    expect(wi?.id).toBe('F-TRUSTED');
  });

  it('claim_next: a remote+un-admitted item whose verified author is NOT trusted stays unclaimable', async () => {
    await insVerified('F-UNTRUSTED', 'remote', null, 1, 99);
    await trust(42); // a different id is trusted, not 99
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'bee' })).toBeNull();
  });

  it('explicit claim: trusted verified author succeeds; untrusted fails', async () => {
    await insVerified('F-TRUSTED', 'remote', null, 1, 42);
    await insVerified('F-UNTRUSTED', 'remote', null, 2, 99);
    await trust(42);
    expect(await claimWorkItem('F-UNTRUSTED', 'bee', { harness: HARNESS })).toBeNull();
    expect(await claimWorkItem('F-TRUSTED', 'bee', { harness: HARNESS })).not.toBeNull();
  });

  it('SECURITY: an UNVERIFIED remote item (NULL verified author — unverified/revoked binding) is never trust-admitted', async () => {
    await insVerified('F-UNVERIFIED', 'remote', null, 1, null);
    await trust(42); // ids are trusted, but the item has no verified author
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'bee' })).toBeNull();
    expect(await claimWorkItem('F-UNVERIFIED', 'bee', { harness: HARNESS })).toBeNull();
  });

  it('SECURITY (D-004): trust does NOT leak across workspaces — an author trusted in ANOTHER workspace is refused here', async () => {
    await insVerified('F-OTHERWS', 'remote', null, 1, 42); // feature lives in WS 'default'
    await trust(42, 'other-workspace'); // 42 trusted ONLY in a different workspace
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'bee' })).toBeNull();
    expect(await claimWorkItem('F-OTHERWS', 'bee', { harness: HARNESS })).toBeNull();
  });

  it('replica fan-out: a trusted verified author is admitted', async () => {
    await insVerified('F-TRUSTED', 'remote', null, 1, 42);
    await h.sql`UPDATE harness_shared.harness_features_consolidated SET redundancy = 3 WHERE harness_slug = ${HARNESS} AND feature_id = 'F-TRUSTED'`;
    await trust(42);
    const ok = await claimReplicaSlot({ harnessSlug: HARNESS, workItemId: 'F-TRUSTED', owner: 'bee' });
    expect(ok.ok).toBe(true);
  });
});
