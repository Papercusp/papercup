/** Explicit workspace custody through the real manual-binding producer and migrated PG. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async orig => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(workspace: string, callback: (tx: postgres.Sql) => Promise<T>) =>
    h.sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx as unknown as postgres.Sql);
    }),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { runWithWorkspaceIfConcrete } = await import('../../workspace-als');
const { prepareManualCoverageFixture } = await import('../../../test/rubric-coverage-http-scenario');
const { resolvePlanScope } = await import('./source');
const { bindSpecEvidenceItems } = await import('./bind-spec-evidence');
const { listSpecEvidence, measureWorkItemsEvidenceForScope } = await import('./spec-evidence-store');

let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); h.sql = db.adminSql; });
afterAll(async () => { vi.unstubAllEnvs(); await db?.cleanup(); });

it('keeps private operator-home receipt measurement and persisted binding in the explicit workspace', async () => {
  const workspace = 'test-runtime-manual-bind';
  const otherWorkspace = 'test-runtime-manual-bind-other';
  const home = 'private-manual-bind-home';
  const planSlug = 'private-workspace-manual-binding';
  const rubricRef = 'acceptance-private-workspace-manual-binding';
  const measuredAt = '2026-11-01T12:00:00Z';
  vi.stubEnv('PAPERCUSP_POT_HOME_SLUG', home);
  // The implicit operator-home branch deliberately defaults to the dogfood
  // workspace. The explicit private workspace must survive every binder stage.
  expect((await resolvePlanScope({ harnessSlug: home })).workspaceId).toBe('papercusp-workspace');
  await runWithWorkspaceIfConcrete(workspace, () => prepareManualCoverageFixture({
    workspace, harness: home, planSlug, rubricRef, measuredAt, actorId: 'su-private-bind',
  }));
  const measurement = { schemaVersion: 1 as const, kind: 'work-items' as const,
    workItemIds: ['WI-901002'], successfulCompletionReceipts: true as const };
  const expected = await measureWorkItemsEvidenceForScope(workspace, home, measurement);
  const bind = (selected: string) => runWithWorkspaceIfConcrete(selected, () => bindSpecEvidenceItems({
    workspaceId: selected, harnessSlug: home, actorId: 'su-private-bind', slug: planSlug,
    items: [{ workItemId: 'WI-901001', specId: 'AUTO-BAR-R-1-P-001', evidenceKind: 'manual',
      evidenceRef: 'archive:private-workspace-review', measurement,
      details: { subject: { ref: 'audit:manual-coverage-fixture', windowStart: '2026-11-01T00:00:00Z',
        windowEnd: '2026-11-02T00:00:00Z' },
      instrument: { none: true, reason: 'Measure the stored successful completion receipt.' } } }],
  }));
  const result = await bind(workspace);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, results: [{ ok: true, status: 'created' }] });
  const rows = await listSpecEvidence({ workspaceId: workspace, harnessSlug: home,
    planSlugs: [planSlug], measurementMode: 'metadata' });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.fingerprints.sourceFingerprint).toBe(expected.sourceFingerprint);
  expect(rows[0]!.details.historicalMeasurement).toMatchObject({ workspaceId: workspace, harnessSlug: home });
  // Work-item IDs are globally unique. Moving this successful receipt to a
  // different workspace must prevent a replay from borrowing it by id alone.
  await db.adminSql`UPDATE harness_shared.work_items SET workspace_id=${otherWorkspace}
    WHERE workspace_id=${workspace} AND feature_id='WI-901002'`;
  expect(await bind(workspace)).toMatchObject({ ok: false, results: [{ ok: false,
    error: 'successful_completion_receipt_unavailable:WI-901002' }] });
  expect(await listSpecEvidence({ workspaceId: otherWorkspace, harnessSlug: home,
    planSlugs: [planSlug], measurementMode: 'metadata' })).toEqual([]);
}, 180_000);
