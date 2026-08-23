/**
 * needs-human-work-items-source.integration.test.ts — WI-5981: a FINISHED
 * work-item must never demand the owner's attention.
 *
 * `readNeedsHumanWorkItems` feeds the owner's needs-you inbox (plans:attention
 * source 11 → tier `decision` → HudView's `.filter(i => i.needsHuman)`). It had
 * NO terminal-state filter and did not even SELECT `status`, so the row shape
 * could not express finishedness and nothing downstream was capable of dropping
 * a completed item. Because the Inbox scope predicate deliberately keeps every
 * Decision REGARDLESS OF AGE ("a decision doesn't expire"), a resolved item
 * stayed in the owner's inbox forever.
 *
 * Measured live on papercusp 2026-07-26 before the fix: of 249 rows matching the
 * source's own predicate, 161 (65%) were already terminal — done 143 · dropped 11
 * · closed 7 — i.e. ~2 of every 3 cards in the owner's decision feed were
 * finished work, while only 42 were genuinely open.
 *
 * The terminal cases below are DERIVED from ANY_FAMILY_TERMINAL_STATES rather
 * than re-listed: EI-18653071581558556 is the same bug class, where a
 * hand-copied union drifted (missing `done`/`dropped`) and scored ~88% of
 * finished units as phantom failures.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/attention/needs-human-work-items-source.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { readNeedsHumanWorkItems } = await import('./needs-human-work-items-source');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** An issue-family row (bug/change/task) carrying the payload.needsHuman dialect. */
async function seedIssue(
  id: string,
  opts: {
    status?: string;
    kind?: string;
    needsHuman?: boolean;
    updatedTs?: number;
    stateChangedAt?: string | null;
  } = {},
) {
  const payload = opts.needsHuman === false ? null : { needsHuman: true };
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id,
       created_ts, updated_ts, state_changed_at, payload)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${`title ${id}`}, ${opts.status ?? 'open'}, ${null},
       ${WS}, 0, ${opts.updatedTs ?? 0}, ${opts.stateChangedAt ?? null}, ${payload ? db.sql.json(payload) : null})`;
}

/** A feature-family row using the OTHER dialect: status = 'needs-human'. */
async function seedFeature(id: string, opts: { status?: string } = {}) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', ${`title ${id}`}, ${opts.status ?? 'needs-human'}, ${WS}, 0, 0)`;
}

const idsOf = (rows: Array<{ feature_id: string }>) => rows.map((r) => r.feature_id).sort();

beforeAll(async () => {
  db = await createFreshPgDb('needs-human-attention');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  // Migration 896 is newer than the shared minimal work-items fixture. Add the
  // lifecycle clock explicitly so this source test proves the production read
  // contract without widening every unrelated fixture consumer.
  await db.sql.unsafe(`ALTER TABLE harness_shared.work_items ADD COLUMN state_changed_at timestamptz`);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe('readNeedsHumanWorkItems — terminal rows never reach the owner (WI-5981)', () => {
  it.each([...ANY_FAMILY_TERMINAL_STATES])(
    'EXCLUDES an issue-family row in terminal state %s even though payload.needsHuman is true',
    async (terminal) => {
      await seedIssue('WI-TERM', { status: terminal });
      await seedIssue('WI-LIVE', { status: 'open' });

      const rows = await readNeedsHumanWorkItems({ workspaceId: WS, harness: H });

      expect(idsOf(rows)).toEqual(['WI-LIVE']);
    },
  );

  it('keeps genuinely unfinished issue-family rows, including non-open live states', async () => {
    await seedIssue('WI-OPEN', { status: 'open' });
    await seedIssue('WI-BLOCKED', { status: 'blocked' });
    await seedIssue('WI-DONE', { status: 'done' });

    const rows = await readNeedsHumanWorkItems({ workspaceId: WS, harness: H });

    expect(idsOf(rows)).toEqual(['WI-BLOCKED', 'WI-OPEN']);
  });

  it("does not regress the feature-family dialect: status='needs-human' still surfaces", async () => {
    await seedFeature('F-NEEDS');
    await seedIssue('WI-OPEN', { status: 'open' });

    const rows = await readNeedsHumanWorkItems({ workspaceId: WS, harness: H });

    expect(idsOf(rows)).toEqual(['F-NEEDS', 'WI-OPEN']);
  });

  it('ignores rows that never asked for a human at all', async () => {
    await seedIssue('WI-NOFLAG', { status: 'open', needsHuman: false });

    const rows = await readNeedsHumanWorkItems({ workspaceId: WS, harness: H });

    expect(rows).toHaveLength(0);
  });

  it('SELECTs status, so the shape can express finishedness downstream', async () => {
    await seedIssue('WI-OPEN', { status: 'open' });

    const [row] = await readNeedsHumanWorkItems({ workspaceId: WS, harness: H });

    expect(row.status).toBe('open');
  });

  it('orders newest-first so the LIMIT cap truncates deterministically, not arbitrarily', async () => {
    await seedIssue('WI-OLD', { updatedTs: 1_000 });
    await seedIssue('WI-NEW', { updatedTs: 3_000 });
    await seedIssue('WI-MID', { updatedTs: 2_000 });

    const rows = await readNeedsHumanWorkItems({ workspaceId: WS, harness: H });

    expect(rows.map((r) => r.feature_id)).toEqual(['WI-NEW', 'WI-MID', 'WI-OLD']);
  });

  it('respects the limit while still returning the NEWEST rows under the cap', async () => {
    await seedIssue('WI-OLD', { updatedTs: 1_000 });
    await seedIssue('WI-NEW', { updatedTs: 3_000 });
    await seedIssue('WI-MID', { updatedTs: 2_000 });

    const rows = await readNeedsHumanWorkItems({ workspaceId: WS, harness: H, limit: 2 });

    expect(rows.map((r) => r.feature_id)).toEqual(['WI-NEW', 'WI-MID']);
  });

  it('uses state_changed_at for stale reads and excludes legacy rows whose lifecycle age is unknown', async () => {
    await seedIssue('WI-OLD', { stateChangedAt: '2026-07-01T00:00:00.000Z', updatedTs: 9_000 });
    await seedIssue('WI-RECENT', { stateChangedAt: '2026-07-20T00:00:00.000Z', updatedTs: 1_000 });
    await seedIssue('WI-LEGACY-NULL', { stateChangedAt: null, updatedTs: 500 });

    const rows = await readNeedsHumanWorkItems({
      workspaceId: WS,
      harness: H,
      stateChangedBefore: '2026-07-10T00:00:00.000Z',
    });

    expect(idsOf(rows)).toEqual(['WI-OLD']);
    expect(rows[0]).toMatchObject({
      state_changed_at: expect.anything(),
      payload: { needsHuman: true },
    });
  });

  it('orders stale reminder candidates by oldest state episode, independent of updated_ts churn', async () => {
    await seedIssue('WI-OLDEST', { stateChangedAt: '2026-06-01T00:00:00.000Z', updatedTs: 9_000 });
    await seedIssue('WI-MIDDLE', { stateChangedAt: '2026-06-10T00:00:00.000Z', updatedTs: 1_000 });
    await seedIssue('WI-NEWEST-STALE', { stateChangedAt: '2026-06-20T00:00:00.000Z', updatedTs: 500 });

    const rows = await readNeedsHumanWorkItems({
      workspaceId: WS,
      harness: H,
      stateChangedBefore: '2026-07-01T00:00:00.000Z',
      oldestFirst: true,
    });

    expect(rows.map((row) => row.feature_id)).toEqual(['WI-OLDEST', 'WI-MIDDLE', 'WI-NEWEST-STALE']);
  });
});
