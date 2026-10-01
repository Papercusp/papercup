import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { humanAssignee, readHumanMarketJob } from './work-items-human-market';

const dbHandle = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: dbHandle.sql }),
}));
const store = await import('./work-items-human-market-store');
const owner = '00000000-0000-4000-8000-000000000001';
const human = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const scope = { workspaceId: 'default', harness: 'pilot', id: 'WI-pilot' };
const job = {
  route: 'market', version: 0, ownerUserId: owner, brief: 'Review public onboarding.',
  rubricRef: 'review@1', amountCents: 500, currency: 'USD',
};
let db: FreshPgDb;
// Hold the row until every adapter has read the old offer and reached UPDATE.
// This makes the CAS test exercise a real stale-read race, not lucky scheduling.
async function withBlockedWrites<T>(count: number, start: () => Promise<T>, changeTerms = false): Promise<T> {
  let release!: () => void;
  let ready!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { ready = resolve; });
  const blocker = db.sql.begin(async tx => {
    await tx`SELECT feature_id FROM harness_shared.work_items WHERE feature_id = 'WI-pilot' FOR UPDATE`;
    ready();
    await released;
    if (changeTerms) await tx`UPDATE harness_shared.work_items SET payload =
      jsonb_set(payload, '{humanWork,amountCents}', '900'::jsonb) WHERE feature_id = 'WI-pilot'`;
  });
  await locked;
  const work = start();
  // Observe rejections immediately even if the precondition check fails.
  void work.catch(() => undefined);
  try {
    await vi.waitFor(async () => {
      const waiting = await db.sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%UPDATE harness_shared.work_items%'`;
      expect(waiting[0].n).toBe(count);
    }, { timeout: 5000, interval: 20 });
  } finally {
    release();
    await blocker;
  }
  return work;
}
beforeAll(async () => {
  db = await createFreshPgDb('human-market');
  dbHandle.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
});
afterAll(async () => db?.cleanup());
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_items`;
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, payload)
    VALUES ('default', 'pilot', 'WI-pilot', 'task', 'needs-human', 'admitted', 'Internal title', 'Internal summary',
      ${JSON.stringify({ humanWork: job, _ei: { severity: 'low' }, internalSecret: 'private' })}::text::jsonb)`;
  // postgres-js serializes a string bound directly as jsonb a second time.
  // Assert the real storage shape before testing the adapter's predicates.
  const shape = await db.sql`SELECT jsonb_typeof(payload) AS kind FROM harness_shared.work_items`;
  expect(shape[0].kind).toBe('object');
});

describe('human market canonical persistence', () => {
  it('persists the claim and immutable submission, preserves internal payload and stamps claim identity', async () => {
    const claimed = await store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' });
    expect(claimed).toMatchObject({ state: 'wip', assignee: humanAssignee(human) });
    expect(claimed.payload).toMatchObject({ internalSecret: 'private', _ei: { severity: 'low' },
      _claimSubjectBaseline: { kind: 'task', title: 'Internal title', summary: 'Internal summary' } });
    const submitted = await store.actOnHumanMarketItem({ ...scope, userId: human, version: 1, action: 'submit', result: 'Reviewed.' });
    expect(readHumanMarketJob(submitted)).toMatchObject({ version: 2, submission: { result: 'Reviewed.' } });
    const reread = await store.getHumanMarketItem(scope);
    expect(reread).toEqual(submitted);
    await expect(store.actOnHumanMarketItem({ ...scope, userId: human, version: 2, action: 'submit', result: 'Changed.' }))
      .rejects.toThrow('submission_already_recorded');
  });

  it('allows exactly one concurrent claimant and rejects stale displayed terms', async () => {
    const results = await withBlockedWrites(2, () => Promise.allSettled([human, other].map(userId =>
      store.actOnHumanMarketItem({ ...scope, userId, version: 0, action: 'claim' }))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(readHumanMarketJob((await store.getHumanMarketItem(scope))!)?.version).toBe(1);
    await expect(store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' }))
      .rejects.toThrow('market_offer_changed');
  });

  it('compares the full offer even when terms change without a version bump', async () => {
    const results = await withBlockedWrites(1, () => Promise.allSettled([
      store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' }),
    ]), true);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('market_offer_changed') });
    const row = await store.getHumanMarketItem(scope);
    expect(row?.assignee).toBeNull();
    expect(readHumanMarketJob(row!)?.amountCents).toBe(900);
  });

  it('cannot cross workspace/harness boundaries, agent claims, pending admission, remote origin or claim holds', async () => {
    expect(await store.getHumanMarketItem({ ...scope, workspaceId: 'other' })).toBeNull();
    expect(await store.getHumanMarketItem({ ...scope, harness: 'other' })).toBeNull();
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'su-worker'`;
    await expect(store.actOnHumanMarketItem({ ...scope, userId: human, version: 0, action: 'claim' })).rejects.toThrow('claim_conflict');
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL, admission = 'pending'`;
    expect(await store.getHumanMarketItem(scope)).toBeNull();
    await db.sql`UPDATE harness_shared.work_items SET admission = 'admitted', origin = 'remote'`;
    expect(await store.getHumanMarketItem(scope)).toBeNull();
    await db.sql`UPDATE harness_shared.work_items SET origin = 'local', payload = payload || '{"_claimHold":true}'::jsonb`;
    expect(await store.getHumanMarketItem(scope)).toBeNull();
  });

  it('rejects owner and non-human identities before any mutation', async () => {
    for (const userId of [owner, 'su-agent']) {
      await expect(store.actOnHumanMarketItem({ ...scope, userId, version: 0, action: 'claim' })).rejects.toThrow();
    }
    expect((await store.getHumanMarketItem(scope))?.assignee).toBeNull();
  });
});
