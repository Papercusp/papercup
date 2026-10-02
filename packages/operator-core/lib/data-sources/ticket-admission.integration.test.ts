/**
 * Ticket admission into work against real Postgres (plan enterprise-data-sources-2026-10-01
 * P-020, D-004, D-030; acceptance spec AUTO-BAR-R-14-P-020). The REAL GitHub Issues connector,
 * admission rules, admitWorkItem, createWorkItem and linkWorkItem run; only GitHub is faked.
 *
 * Properties under test:
 *   - an ingested ticket becomes work ONLY through an admission: a rule of its data source that
 *     matches it, or a person promoting it. An unmatched ticket stays a record;
 *   - every work item minted from a ticket carries exactly one work_admissions row naming the
 *     rule (admitted_via 'rule', rule_id) or the person (admitted_via 'person', admitted_by);
 *   - admission is idempotent: a re-poll and a second promote return the existing admission;
 *   - field authority: a Papercusp patch of an external-owned field (title, description) is
 *     refused, and a re-sync updates those fields without touching Papercusp-owned state;
 *   - a rule cannot admit outside its data source, and an event row is never admitted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getExternalTriggerSource, type ExternalTriggerSourceRow } from '../external-triggers/source-store';
import {
  connectGitHubIssuesSource,
  pollGitHubIssuesOnce,
  ticketWorkItemId,
  type GitHubIssue,
  type GitHubIssuesClient,
} from './github-issues-connector';
import { setAdmissionRule } from '../work-admission/admission-rules';
import { admitWorkItem, refuseExternalOwnedPatch } from '../work-admission/admit';
import '../work-admission/record-source';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const OWNER = 'acme';
const REPO = 'tulip';
const T0 = new Date('2026-10-01T12:00:00.000Z');
const CONNECTOR_ID_RE = '^TK[TS]-';
const PERSON = 'su-ticket-admission-test';

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let startedAt: Date;

function issue(n: number, title: string, assignees: string[], updatedAt = '2026-10-01T10:00:00Z'): GitHubIssue {
  return {
    id: 7000 + n, number: n, title, body: `body of #${n}`, state: 'open', user: { login: 'alice-gh', id: 1001 },
    assignees: assignees.map((login, i) => ({ login, id: 2000 + i })), labels: [],
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${n}`,
    created_at: '2026-10-01T08:00:00Z', updated_at: updatedAt,
  };
}

/** One page of issues, no comments or events; enough for admission. */
function fakeGitHub(issues: GitHubIssue[]): { client: GitHubIssuesClient; issues: GitHubIssue[] } {
  const state = { issues, client: undefined as unknown as GitHubIssuesClient };
  state.client = {
    issues: {
      listForRepo: async (p) => ({ data: p.page === 1 ? state.issues : [] }),
      listCommentsForRepo: async () => ({ data: [] }),
      listEventsForRepo: async () => ({ data: [] }),
    },
    repos: { listCollaborators: async () => ({ data: [] }) },
  };
  return state;
}

async function connect(): Promise<ExternalTriggerSourceRow> {
  return connectGitHubIssuesSource(sql, {
    workspaceId: WS, ownerUserId: alice, owner: OWNER, repo: REPO, harnessSlug: HARNESS, createdBy: 'ticket-admission-test',
  });
}

async function reread(source: ExternalTriggerSourceRow): Promise<ExternalTriggerSourceRow> {
  const row = await getExternalTriggerSource(sql, source.workspaceId, source.id);
  if (!row) throw new Error('source vanished');
  return row;
}

interface AdmissionDb {
  work_item_id: string; source_kind: string; source_key: string; data_source_id: string | null;
  admitted_via: string; admitted_by: string; rule_id: string | null;
}

async function admissions(): Promise<AdmissionDb[]> {
  return sql<AdmissionDb[]>`
    SELECT work_item_id, source_kind, source_key, data_source_id::text AS data_source_id,
           admitted_via, admitted_by, rule_id::text AS rule_id
      FROM harness_shared.work_admissions WHERE workspace_id = ${WS} ORDER BY created_at`;
}

/** Every non-connector work item this test minted, with its admission count. */
async function mintedWork(): Promise<Array<{ feature_id: string; created_by: string | null; admission_count: number }>> {
  return sql<Array<{ feature_id: string; created_by: string | null; admission_count: number }>>`
    SELECT w.feature_id, w.created_by,
           (SELECT count(*)::int FROM harness_shared.work_admissions a
             WHERE a.workspace_id = w.workspace_id AND a.work_item_id = w.feature_id) AS admission_count
      FROM harness_shared.work_items w
     WHERE w.workspace_id = ${WS} AND w.feature_id !~ ${CONNECTOR_ID_RE} AND w.created_at >= ${startedAt}
     ORDER BY w.feature_id`;
}

async function clean(): Promise<void> {
  await sql`
    DELETE FROM harness_shared.work_items w
     USING harness_shared.work_admissions a
     WHERE a.workspace_id = ${WS} AND w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id`;
  await sql`DELETE FROM harness_shared.work_admissions WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id ~ ${CONNECTOR_ID_RE}`;
  await sql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`ticket-admission-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;
});

afterAll(async () => {
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await clean();
  startedAt = new Date(Date.now() - 1000);
});

describe('ticket admission into work (P-020, R-14)', () => {
  it('admits only tickets a rule matches, attributes every admission, and stays idempotent on re-poll', async () => {
    const gh = fakeGitHub([issue(1, 'Agents should fix the tulip build', ['papercusp-agents']), issue(2, 'Human-only ticket', ['carol-gh'])]);
    let source = await connect();
    const rule = await setAdmissionRule(
      { workspaceId: WS, dataSourceId: source.id, title: 'Assigned to the agents user', match: { assignees: { contains: 'papercusp-agents' } }, harness: HARNESS, createdBy: PERSON },
      sql,
    );

    const first = await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    expect(first.tickets).toEqual({ created: 2, updated: 0 });
    expect(first.admissions).toEqual({ matched: 1, admitted: 1, existing: 0, refused: 0, refreshed: 0, failed: 0, lastError: null });

    const matchedRecord = ticketWorkItemId(WS, source.id, `${OWNER}/${REPO}#1`);
    const unmatchedRecord = ticketWorkItemId(WS, source.id, `${OWNER}/${REPO}#2`);
    const rows = await admissions();
    expect(rows).toEqual([
      {
        work_item_id: expect.any(String), source_kind: 'record', source_key: matchedRecord, data_source_id: source.id,
        admitted_via: 'rule', admitted_by: `admission-rule:${rule.id}`, rule_id: rule.id,
      },
    ]);
    // The unmatched ticket is still only a record.
    expect(rows.some((r) => r.source_key === unmatchedRecord)).toBe(false);

    const minted = await mintedWork();
    expect(minted).toEqual([{ feature_id: rows[0]!.work_item_id, created_by: `admission-rule:${rule.id}`, admission_count: 1 }]);
    const [item] = await sql<Array<{ title: string; nature: string }>>`
      SELECT title, nature FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${rows[0]!.work_item_id}`;
    expect(item).toEqual({ title: `${OWNER}/${REPO}#1: Agents should fix the tulip build`, nature: 'work' });

    // A Papercusp-owned field set on the admitted item survives the re-sync below.
    await sql`UPDATE harness_shared.work_items SET assignee = ${PERSON} WHERE workspace_id = ${WS} AND feature_id = ${rows[0]!.work_item_id}`;

    source = await reread(source);
    gh.issues[0] = { ...gh.issues[0]!, title: 'Agents should fix the tulip build (retitled)', updated_at: '2026-10-01T11:00:00Z' };
    const again = await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    expect(again.admissions).toEqual({ matched: 1, admitted: 0, existing: 1, refused: 0, refreshed: 1, failed: 0, lastError: null });
    expect(await admissions()).toHaveLength(1);
    expect(await mintedWork()).toHaveLength(1);
    const [resynced] = await sql<Array<{ title: string; assignee: string | null }>>`
      SELECT title, assignee FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${rows[0]!.work_item_id}`;
    expect(resynced).toEqual({ title: `${OWNER}/${REPO}#1: Agents should fix the tulip build (retitled)`, assignee: PERSON });
  });

  it('a person promotes an unmatched ticket by hand; a second promote returns the same admission', async () => {
    const gh = fakeGitHub([issue(3, 'Promote me by hand', [])]);
    const source = await connect();
    await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    const recordId = ticketWorkItemId(WS, source.id, `${OWNER}/${REPO}#3`);
    expect(await admissions()).toEqual([]);

    const promote = () =>
      admitWorkItem({ workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId }, admitter: { via: 'person', actorId: PERSON } }, { sql });
    const first = await promote();
    expect(first).toMatchObject({ ok: true, reason: 'admitted', linkedRecord: recordId });
    const second = await promote();
    expect(second).toMatchObject({ ok: true, reason: 'existing' });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.workItemId).toBe(first.workItemId);

    expect(await admissions()).toEqual([
      {
        work_item_id: first.workItemId, source_kind: 'record', source_key: recordId, data_source_id: source.id,
        admitted_via: 'person', admitted_by: PERSON, rule_id: null,
      },
    ]);
    expect(await mintedWork()).toEqual([{ feature_id: first.workItemId, created_by: PERSON, admission_count: 1 }]);

    // Field authority: the source owns title and description; Papercusp-owned fields stay editable.
    expect(await refuseExternalOwnedPatch(WS, first.workItemId, ['title'], sql)).toMatchObject({
      code: 'field_owned_by_source', fields: ['title'],
    });
    expect(await refuseExternalOwnedPatch(WS, first.workItemId, ['body'], sql)).toMatchObject({ fields: ['body'] });
    expect(await refuseExternalOwnedPatch(WS, first.workItemId, ['priority', 'status'], sql)).toBeNull();
    // A work item that was never admitted has no external owner.
    expect(await refuseExternalOwnedPatch(WS, recordId, ['title'], sql)).toBeNull();
  });

  it('refuses a rule admission outside the rule’s data source and never admits an event row', async () => {
    const gh = fakeGitHub([issue(4, 'Scoped ticket', ['papercusp-agents'])]);
    const source = await connect();
    await pollGitHubIssuesOnce(sql, source, { client: gh.client, now: () => T0 });
    const recordId = ticketWorkItemId(WS, source.id, `${OWNER}/${REPO}#4`);

    const foreignRule = await admitWorkItem(
      {
        workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId },
        admitter: { via: 'rule', ruleId: '00000000-0000-4000-8000-000000000001', dataSourceId: '00000000-0000-4000-8000-000000000002' },
      },
      { sql },
    );
    expect(foreignRule).toMatchObject({ ok: false, code: 'outside_rule_scope' });

    const [event] = await sql<Array<{ feature_id: string }>>`
      SELECT feature_id FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id ~ '^TKS-' LIMIT 1`;
    expect(event).toBeDefined();
    const notRecord = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: { kind: 'record', recordId: event!.feature_id }, admitter: { via: 'person', actorId: PERSON } },
      { sql },
    );
    expect(notRecord).toMatchObject({ ok: false, code: 'not_a_record' });

    expect(await admissions()).toEqual([]);
    expect(await mintedWork()).toEqual([]);
  });
});
