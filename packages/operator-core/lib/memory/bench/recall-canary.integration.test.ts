/**
 * recall-canary.integration.test.ts — `sampleCanaryCandidates` against REAL
 * Postgres (EI-18749575523514756 sibling sweep).
 *
 * THE GUARD (the bug this file exists to prevent recurring): `sampleCanaryCandidates`
 * ordered by `md5(id)`, but `harness_shared.memory_canonical.id` is `uuid` and
 * `md5()` has no `uuid` overload — every real call threw PG 42883
 * (`function md5(uuid) does not exist`). This was invisible to every existing
 * unit test in `recall-canary.test.ts` because they all inject a mocked
 * `sample`/`sql` and never execute the real query against a real schema — and
 * invisible in production because the scheduled step
 * (`memory-live-recall:canary`, cron `0 45 5 * * *`) runs inside
 * `runRecallCanary`'s outer try/catch, a never-throw contract that swallows the
 * failure to a console log nobody reads. Net effect: the routine fired daily
 * from 2026-07-14 onward and recorded ZERO rows to
 * harness_shared.memory_live_recall_canary_run the entire time — the live
 * memory-recall degradation alert was never actually armed.
 *
 * Fixed by casting explicitly: `ORDER BY md5(id::text)`. This test exercises
 * the real SQL against the real migrated schema so a reintroduced uuid/text
 * mismatch (here or in any future edit to this query) fails LOUD, not silent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { sampleCanaryCandidates, RECALL_CANARY_TARGET_PAIRS } from './recall-canary';

const SCOPE = 'recall-canary-it';
const OLD = '2026-01-01T00:00:00Z'; // well past the MIN_AGE_DAYS floor
const LONG_BODY =
  'the quick brown fox jumps over the lazy dog while the '.repeat(3) + 'canary probe body text';

describe('sampleCanaryCandidates (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function seed(
    scope: string,
    payload: Record<string, unknown>,
    created = OLD,
  ): Promise<string> {
    const rows = await db.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.memory_canonical (payload, state, created_at, updated_at)
      VALUES (${db.adminSql.json({ user_id: scope, data: LONG_BODY, ...payload })}, 'active', ${created}, ${created})
      RETURNING id::text AS id`;
    return rows[0].id;
  }

  it('does not throw, and returns the eligible candidate (the md5(uuid) regression guard)', async () => {
    const id = await seed(`${SCOPE}-basic`, {});
    const rows = await sampleCanaryCandidates(db.adminSql);
    expect(rows.map((r) => r.id)).toContain(id);
    expect(rows.length).toBeLessThanOrEqual(Math.max(RECALL_CANARY_TARGET_PAIRS, rows.length));
  });

  it('excludes entity rows, short bodies, and rows younger than the age floor', async () => {
    const scope = `${SCOPE}-filters`;
    const eligible = await seed(scope, {});
    const entity = await seed(scope, { entityType: 'person' }); // excluded: NOT (payload ? 'entityType')
    const tooShort = await seed(scope, { data: 'too short' }); // excluded: below MIN_BODY_CHARS
    const tooYoung = await seed(scope, {}, new Date().toISOString()); // excluded: below MIN_AGE_DAYS

    const rows = await sampleCanaryCandidates(db.adminSql);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(eligible);
    expect(ids).not.toContain(entity);
    expect(ids).not.toContain(tooShort);
    expect(ids).not.toContain(tooYoung);
  });
});
