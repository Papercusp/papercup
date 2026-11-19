import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const ctx = { workspaceId: 'design-review-workspace', harnessSlug: 'design-review-harness', progress: () => {} };
type ToolName = 'submit_spec' | 'record_review' | 'get_accepted_spec';
type Tool = (input: Record<string, unknown>, context: typeof ctx) => Promise<{
  isError?: boolean; content: Array<{ text: string }>;
}>;
const plugin = createRequire(import.meta.url)('../../../libs/papercusp/plugins/design-phase/index.cjs') as {
  tools: Record<ToolName, Tool>;
};

describe('design-phase review of submitted editions', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', db.adminDsn);
  }, 180_000);
  afterAll(async () => { vi.unstubAllEnvs(); await db?.cleanup(); });

  async function seed(feature: string) {
    await db.adminSql`INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, design_status)
      VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${feature}, ${feature}, 'todo', 'feature', 'pending')`;
  }
  async function call(name: ToolName, input: Record<string, unknown>) {
    const response = await plugin.tools[name](input, ctx);
    expect(response.isError, response.content[0].text).not.toBe(true);
    return JSON.parse(response.content[0].text);
  }
  async function submit(featureId: string, surface: string): Promise<string> {
    const ir = { irVersion: '0.1', ecosystem: 'react-tailwind', surface, layout: { kind: 'stack' } };
    return (await call('submit_spec', { featureId, ir })).specId;
  }

  it('retains old and unbound feedback while a successor remains accepted', async () => {
    const featureId = 'two-editions';
    await seed(featureId);
    const first = await submit(featureId, 'original');
    expect((await call('get_accepted_spec', { featureId })).specId).toBe(first);
    const second = await submit(featureId, 'successor');
    const late = await call('record_review', { featureId, specId: first, verdict: 'changes-requested', notes: 'Earlier edition' });
    expect(late).toMatchObject({ disposition: 'stale', reviewedSpecId: first, designStatusAfter: 'accepted' });
    const unbound = await call('record_review', { featureId, verdict: 'rejected' });
    expect(unbound).toMatchObject({ disposition: 'unbound', reviewedSpecId: null, designStatusAfter: 'accepted' });
    expect((await call('get_accepted_spec', { featureId })).specId).toBe(second);
    const reviews = await db.adminSql`SELECT id, payload FROM harness_shared.harness_design_artifacts
      WHERE harness_slug = ${ctx.harnessSlug} AND feature_id = ${featureId} AND kind = 'review'`;
    expect(reviews).toHaveLength(2);
    expect(reviews.find(row => row.id === late.reviewId)?.payload).toMatchObject({ reviewedSpecId: first, notes: 'Earlier edition', disposition: 'stale' });
    expect(reviews.find(row => row.id === unbound.reviewId)?.payload).toMatchObject({ reviewedSpecId: null, disposition: 'unbound' });
  });

  it('binds an unpinned review to the sole edition and applies one of two concurrent rejections', async () => {
    const featureId = 'concurrent-reviews';
    await seed(featureId);
    const specId = await submit(featureId, 'only-edition');
    expect(await call('record_review', { featureId, verdict: 'approved' }))
      .toMatchObject({ disposition: 'applied', reviewedSpecId: specId, designStatusAfter: 'accepted' });
    const results = await Promise.all(['rejected', 'changes-requested'].map(verdict =>
      call('record_review', { featureId, specId, verdict })));
    expect(results.map(row => row.disposition).sort()).toEqual(['applied', 'stale']);
    expect(results.map(row => row.designStatusAfter)).toEqual(['pending', 'pending']);
    const [feature] = await db.adminSql`SELECT design_status, design_spec_id FROM harness_shared.harness_features_consolidated
      WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${ctx.harnessSlug} AND feature_id = ${featureId}`;
    expect(feature).toMatchObject({ design_status: 'pending', design_spec_id: null });
  });

  it('preserves a successor when submission and an earlier review overlap', async () => {
    const featureId = 'concurrent-submission';
    await seed(featureId);
    const first = await submit(featureId, 'original');
    const [second] = await Promise.all([submit(featureId, 'successor'),
      call('record_review', { featureId, specId: first, verdict: 'rejected' })]);
    expect((await call('get_accepted_spec', { featureId })).specId).toBe(second);
  });
});
