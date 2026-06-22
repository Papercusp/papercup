/**
 * engineer-issues projection — the Hyperbee→PG read side for work-queue federation
 * (fed-reanchor brief B5; closes engineer-issues-2026-06-03 D-009). Real PG: applies
 * migs 131 (engineer_issues) + 142 (kind/seq) + 152 (task/payload) + 197 (fed col +
 * capture) and exercises the projection's writeToPg LWW + per-harness demux + delete.
 * The capture/op-key (write side) is proven in __tests__/engineer-issues-federation-
 * trigger.integration.test.ts; this proves the read side applies a remote op where the
 * issues:* surface reads it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, SUBSTRATE_OUTBOX_DDL } from '../../../../test/_work-items-schema';
import { buildEngineerIssuesProjection, _testing, type EngineerIssueRow } from './engineer-issues';

const WS = 'ws-ei-proj';
const SLUG = 'papercup';

function issueRow(over: Partial<EngineerIssueRow> = {}): EngineerIssueRow {
  return {
    harness_slug: SLUG,
    issue_id: 'EI-1',
    scope: `harness:${SLUG}`,
    kind: 'bug',
    title: 'a bug',
    body: 'details',
    severity: 'minor',
    source: 'engineer',
    state: 'open',
    assignee: null,
    assigned_by: null,
    assigned_at: null,
    payload: null,
    found_during: null,
    linked_feature_id: null,
    created_by: null,
    created_at: new Date(1000).toISOString(),
    ...over,
  };
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('engineer-issues-proj');
  await db.sql.unsafe(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
    END $r$;
  `);
  // P-010 unification: work_items base + hfc/ei compat views + the outbox table. The
  // projection applies REMOTE-origin ops (echo-guarded), so no capture trigger is needed.
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(SUBSTRATE_OUTBOX_DDL);
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.engineer_issues`;
  await db.sql`DELETE FROM harness_shared.substrate_outbox`;
});

const proj = () => buildEngineerIssuesProjection({ workspaceId: WS, harnessSlug: SLUG, sql: db.sql });

async function getIssue(id: string) {
  const rows = await db.sql<{ issue_id: string; scope: string; state: string; title: string; origin: string; fed_ts: number | null }[]>`
    SELECT issue_id, scope, state, title, origin, fed_ts FROM harness_shared.engineer_issues
     WHERE workspace_id = ${WS} AND issue_id = ${id}`;
  return rows[0] ?? null;
}

describe('engineer-issues projection — pure helpers', () => {
  it('isEngineerIssueRow / decodeValue accept a valid row, reject malformed', () => {
    expect(_testing.decodeValue(issueRow())).not.toBeNull();
    expect(_testing.decodeValue({ ...issueRow(), harness_slug: '' })).toBeNull();
    expect(_testing.decodeValue({ ...issueRow(), issue_id: 123 })).toBeNull();
    expect(_testing.decodeValue({ ...issueRow(), scope: '' })).toBeNull();
    expect(_testing.decodeValue({ ...issueRow(), assignee: 5 })).toBeNull();
    expect(_testing.decodeValue(null)).toBeNull();
    // payload is jsonb-opaque — a value is fine.
    expect(_testing.decodeValue(issueRow({ payload: { agentSessionId: 'x' } }))).not.toBeNull();
  });
  it('composeKey is the issue_id', () => {
    expect(_testing.composeKey(issueRow({ issue_id: 'EI-42' }))).toBe('EI-42');
  });
});

describe('engineer-issues projection — writeToPg / deleteFromPg (real PG)', () => {
  it('applies a remote op into engineer_issues (issues:* reads it); origin=remote, fed_ts set', async () => {
    await proj().writeToPg(issueRow({ issue_id: 'EI-7', state: 'open', title: 'remote bug' }), {
      ts: 100,
      origin: 'remote',
      authorPubkey: 'peer',
    });
    const r = await getIssue('EI-7');
    expect(r?.title).toBe('remote bug');
    expect(r?.scope).toBe(`harness:${SLUG}`);
    expect(r?.origin).toBe('remote'); // so a local re-edit re-stamps origin=local to refederate
    expect(r?.fed_ts).toBe(100);
  });

  it('drops an op for a different harness (demuxed by harness_slug)', async () => {
    await proj().writeToPg(issueRow({ harness_slug: 'other', issue_id: 'EI-8' }), {
      ts: 1,
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect(await getIssue('EI-8')).toBeNull();
  });

  it('LWW: a newer fed_ts wins, an older one is dropped', async () => {
    const p = proj();
    await p.writeToPg(issueRow({ issue_id: 'EI-9', title: 'v200' }), { ts: 200, origin: 'remote', authorPubkey: 'peer' });
    await p.writeToPg(issueRow({ issue_id: 'EI-9', title: 'v100-stale' }), { ts: 100, origin: 'remote', authorPubkey: 'peer' });
    expect((await getIssue('EI-9'))?.title).toBe('v200'); // newer held
    await p.writeToPg(issueRow({ issue_id: 'EI-9', title: 'v300' }), { ts: 300, origin: 'remote', authorPubkey: 'peer' });
    expect((await getIssue('EI-9'))?.title).toBe('v300');
  });

  it('deleteFromPg removes by issue_id (ts-guarded)', async () => {
    const p = proj();
    await p.writeToPg(issueRow({ issue_id: 'EI-11' }), { ts: 100, origin: 'remote', authorPubkey: 'peer' });
    await p.deleteFromPg('EI-11', 50); // stale del — guarded out
    expect(await getIssue('EI-11')).not.toBeNull();
    await p.deleteFromPg('EI-11', 200); // newer del — applies
    expect(await getIssue('EI-11')).toBeNull();
  });
});
