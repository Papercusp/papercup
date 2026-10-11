/** Actual work_items:complete → audit capture → immutable Reports store (P-012). */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: fixture.sql }),
  withWorkspace: async <T>(workspaceId: string, callback: (sql: postgres.Sql) => Promise<T>): Promise<T> =>
    fixture.sql.begin(async (transaction) => {
      await transaction`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return callback(transaction as unknown as postgres.Sql);
    }) as Promise<T>,
}));
// A fixture completion must not release this host's real edit locks.
vi.mock('./work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: async () => ({ releases: [], failures: 0, skipped: null }),
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { activeWorkspaceId } = await import('./workspace-registry');
const { createWorkItem, getWorkItem } = await import('./work-items');
const { drainDetached } = await import('./detached-imports');
const { getReport } = await import('./report-library');
const { modeById, axisKeyFor } = await import('./modes/registry');
const { default: complete } = await import('./agent-tools/work_items/complete');

const OWNER = 'su-reports-audit-producer-fixture';
const SESSION = 'reports-audit-producer-fixture-session';
const HARNESS = 'papercusp';
const auditMode = modeById('audit');
if (!auditMode) throw new Error('Audit mode fixture requires the registered audit definition');
const auditAxis = axisKeyFor(auditMode);
const note = {
  summary: 'The private audit fixture preserves its exact verdict.',
  testsRun: 'Private PostgreSQL audit fixture readback',
  testResult: 'Fixture observation recorded',
  verifiedHow: 'integration' as const,
  filesChanged: [],
};
// Reject fixture schema errors before allocating a database.
const terminalTemplate = complete.args.parse({ id: 'WI-123', harness: HARNESS, state: 'done',
  assumptions: 'none', completion: note });
const progressTemplate = complete.args.parse({ id: 'WI-123', harness: HARNESS, recordOnly: true,
  completion: note });

describe('Reports audit producer against migrated private PostgreSQL', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    fixture.sql = db.adminSql;
  }, 180_000);
  afterAll(async () => {
    await drainDetached();
    await db?.cleanup();
  });
  beforeEach(async () => {
    await drainDetached();
    await db.adminSql`TRUNCATE harness_shared.report_library CASCADE`;
    await db.adminSql`DELETE FROM harness_shared.agent_modes WHERE owner_id = ${OWNER}`;
  });

  async function seed(audit: boolean) {
    if (audit) await db.adminSql`
      INSERT INTO harness_shared.agent_modes
        (workspace_id, owner_id, axis_key, mode, reason, set_by)
      VALUES (${activeWorkspaceId()}, ${OWNER}, ${auditAxis}, 'audit', 'Private test fixture', ${OWNER})`;
    return createWorkItem({ kind: 'task', title: 'Reports audit producer fixture', harness: HARNESS,
      workspaceId: activeWorkspaceId(), createdBy: OWNER, assignee: OWNER });
  }

  async function finish(id: string, terminal = true) {
    const args = structuredClone(terminal ? terminalTemplate : progressTemplate);
    args.id = id;
    const response = await complete.handler(args as never, {
      uiClientId: OWNER, isSuperuser: true, workspaceId: activeWorkspaceId(), harnessSlug: HARNESS,
      runId: SESSION, log: () => {},
    } as never);
    expect(response, JSON.stringify(response)).toMatchObject({ data: { results: [{ ok: true }] } });
    await drainDetached();
    return args;
  }

  it('publishes an actual terminal audit completion with persisted source and exact verdict', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      const item = await seed(true);
      const args = await finish(item.id);
      const stored = await getWorkItem(item.id, HARNESS);
      expect(stored).toMatchObject({ state: 'done', terminalOwner: OWNER });
      // The terminal evidence writer omits empty file lists. The report below
      // separately preserves the full normalized completion payload.
      expect(stored!.terminalCompletionEvidence).toMatchObject({ summary: note.summary,
        testsRun: note.testsRun, testResult: note.testResult, verifiedHow: note.verifiedHow });
      expect(stored!.terminalCompletionEvidence?.filesChanged).toBeUndefined();
      const reference = stored!.terminalCompletionRef ?? item.id;
      const requestKey = `capture:audit:${createHash('sha256').update(reference).digest('hex')}`;
      const rows = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`;
      expect(rows).toHaveLength(1);
      const report = await getReport(db.adminSql, activeWorkspaceId(), rows[0].report_id, { isOwner: true });
      expect(report).toMatchObject({ title: item.title, kind: 'audit', visibility: 'owner',
        source: 'capture:audit', requestKey, subject: { kind: 'work_item', ref: item.id },
        origin: { authorOwnerId: OWNER, harnessSlug: HARNESS, authorSessionRef: SESSION } });
      expect(report!.bodyMd).toContain(note.summary);
      expect(report!.bodyMd).toContain(`Source reference: ${reference}`);
      const verdict = report!.bodyMd.match(/```json\n([\s\S]*?)\n```/);
      expect(verdict).not.toBeNull();
      expect(JSON.parse(verdict![1])).toEqual(args.completion);

      await finish(item.id);
      const retry = await db.adminSql<Array<{ report_id: string }>>`
        SELECT report_id FROM harness_shared.report_library WHERE request_key = ${requestKey}`;
      expect(retry).toEqual(rows);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not publish an ordinary terminal completion outside audit mode', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      const item = await seed(false);
      await finish(item.id);
      expect(await getWorkItem(item.id, HARNESS)).toMatchObject({ state: 'done' });
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library`).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not publish a record-only non-terminal audit progress note', async () => {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    try {
      const item = await seed(true);
      await finish(item.id, false);
      expect(await getWorkItem(item.id, HARNESS)).toMatchObject({ state: 'open' });
      expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library`).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
