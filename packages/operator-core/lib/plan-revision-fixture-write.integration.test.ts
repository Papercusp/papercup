import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFixtureWriteRevisions, submitFixturePlanWrite, type FixturePlanWrite,
  type FixtureWriteEvidence } from '../../../apps/operator/e2e/_fake-llm-fixture';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

describe('native Plans fixture write recovery in private Postgres', () => {
  let db: OrgTestDb;
  const scope = { workspace: 'fixture-write-test', harness: 'private-harness', slug: 'private-plan' };
  const title = 'Fixture creation';
  const content = '# Plan\n\nOriginal citation changed.\n';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const item = { text: 'Review the generated citation', phase: 'Reference check', importance: 'normal' };

  async function seedPlan(slug: string, revisions: string[], hasItem = false) {
    const latest = revisions[revisions.length - 1]!;
    await db.adminSql`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,title,status,version,content,content_hash,items)
      VALUES (${scope.workspace},${scope.harness},${slug},${title},'draft',${revisions.length},${latest},${digest(latest)},
        ${db.adminSql.json(hasItem ? [item] : [])})`;
    for (const [index, body] of revisions.entries()) {
      const rationale = index === revisions.length - 1 ? 'expected write' : 'created';
      await db.adminSql`INSERT INTO harness_shared.plan_revisions
        (workspace_id,harness_slug,plan_slug,seq,content_hash,content_snapshot,rationale,author_kind,author_id,created_at)
        VALUES (${scope.workspace},${scope.harness},${slug},${index + 1},${digest(body)},${body},${rationale},'agent','fixture',${Date.now()})`;
    }
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    await seedPlan(scope.slug, ['# Plan\n', content]);
    await seedPlan('creation', ['# Plan\n']);
    await seedPlan('addition', ['# Plan\n', '# Plan\n\n' + item.text], true);
  });

  afterAll(async () => { await db?.cleanup(); });

  const save: FixturePlanWrite = { verb: 'set-content', content, expectedVersion: 1, expectedHash: digest('# Plan\n') };
  const lookup = (write: FixturePlanWrite, rationale = 'expected write') =>
    readFixtureWriteRevisions(db.adminSql, scope, rationale, write);

  it('recovers a lost acknowledgement using the actual original and prior revisions', async () => {
    const failedResponse = vi.fn().mockRejectedValue(new Error('Connection closed after commit'));
    const evidence: FixtureWriteEvidence = { verb: save.verb, rationale: 'expected write', outcome: 'submitted',
      startedAt: new Date().toISOString() };
    await submitFixturePlanWrite(evidence, failedResponse, () => lookup(save));
    expect(failedResponse).toHaveBeenCalledTimes(1);
    expect(evidence).toMatchObject({ outcome: 'recovered', revisions: [{ revisionHash: digest(content),
      headHash: digest(content), exactDocument: true, matchesRequest: true }] });
  });

  it('requires the exact operation marker, workspace, predecessor, and content', async () => {
    expect(await lookup(save, 'another write')).toEqual([]);
    expect(await readFixtureWriteRevisions(db.adminSql, { ...scope, workspace: 'other' }, 'expected write', save)).toEqual([]);
    expect(await lookup({ ...save, expectedHash: digest('wrong') })).toMatchObject([{ matchesRequest: false }]);
    expect(await lookup({ ...save, content: content + '\n' })).toMatchObject([{ matchesRequest: false }]);
    expect(await lookup({ ...save, expectedVersion: 2 })).toMatchObject([{ matchesRequest: false }]);
    expect(await lookup(save, 'created')).toMatchObject([{ exactDocument: false }]);
  });

  it('checks the creation and item postconditions independently of acknowledgement', async () => {
    const probe = (slug: string, write: FixturePlanWrite) =>
      readFixtureWriteRevisions(db.adminSql, { ...scope, slug }, 'expected write', write);
    const create = { verb: 'new', title, status: 'draft' } as const;
    expect(await probe('creation', create)).toMatchObject([{ matchesRequest: true }]);
    expect(await probe('creation', { ...create, title: 'wrong' })).toMatchObject([{ matchesRequest: false }]);
    expect(await lookup(create)).toMatchObject([{ matchesRequest: false }]);
    expect(await probe('addition', { verb: 'add-item', ...item })).toMatchObject([{ matchesRequest: true }]);
    expect(await probe('addition', { verb: 'add-item', ...item, phase: 'other' })).toMatchObject([{ matchesRequest: false }]);
  });
});
