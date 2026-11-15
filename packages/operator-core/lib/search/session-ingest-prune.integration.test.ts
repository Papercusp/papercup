/**
 * pruneSessionTurnsOnce against a real migrated PostgreSQL (WI-6554700010009718).
 *
 * Pins the retention contract the daily tick enforces:
 *   delete exactly the rows with COALESCE(ts, ingested_at) < now() - window,
 *   however many there are, and say so when the budget runs out first.
 *
 * The prune now runs two passes per table (an indexed bulk pass on ingested_at,
 * then the exact predicate as a tail pass), so each population below exercises
 * one way that split could go wrong:
 *   - old ts, old ingest      -> bulk pass must delete it (and more than 40 batches of it).
 *     `tailDeleted` pins that split: if the bulk pass stopped short, the exact
 *     tail pass would quietly delete the rest and the totals would still match.
 *   - old ts, RECENT ingest   -> only the tail pass can delete it
 *   - NULL ts, old ingest     -> COALESCE falls back to ingested_at
 *   - RECENT ts, old ingest   -> must SURVIVE: the bulk pass keeps the exact filter
 *   - inside the window       -> must survive
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as org from '@papercusp/db-org';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { mockOrgPgSql } from '../testing/mock-org-pg';
import { pruneSessionTurnsOnce } from './session-ingest';

describe('pruneSessionTurnsOnce (real migrated PostgreSQL)', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    vi.spyOn(org, 'getOrgPg');
    mockOrgPgSql(vi.mocked(org.getOrgPg), db.adminSql);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.cleanup();
  });
  beforeEach(async () => {
    // DELETE, not TRUNCATE: session_turns is the target of a foreign key, which
    // TRUNCATE refuses outright even when the referencing table is empty.
    await db.adminSql`DELETE FROM harness_shared.session_turn_parts`;
    await db.adminSql`DELETE FROM harness_shared.session_turns`;
  });

  /** Insert `count` parts for one session. Ages are in days before now(); null ts = NULL. */
  async function parts(sessionId: string, count: number, tsDaysAgo: number | null, ingestedDaysAgo: number) {
    await db.adminSql`
      INSERT INTO harness_shared.session_turn_parts
        (source_kind, session_id, part_idx, ts, speaker, part_kind, text, ingested_at)
      SELECT 'claude', ${sessionId}, g,
             CASE WHEN ${tsDaysAgo}::int IS NULL THEN NULL
                  ELSE now() - make_interval(days => ${tsDaysAgo}::int) END,
             'assistant', 'text', 'x',
             now() - make_interval(days => ${ingestedDaysAgo}::int)
        FROM generate_series(1, ${count}::int) AS g
    `;
  }

  async function turns(sessionId: string, count: number, tsDaysAgo: number, ingestedDaysAgo: number) {
    await db.adminSql`
      INSERT INTO harness_shared.session_turns
        (source_kind, session_id, turn_idx, ts, speaker, text, ingested_at)
      SELECT 'claude', ${sessionId}, g,
             now() - make_interval(days => ${tsDaysAgo}::int),
             'assistant', 'x',
             now() - make_interval(days => ${ingestedDaysAgo}::int)
        FROM generate_series(1, ${count}::int) AS g
    `;
  }

  async function remainingBySession(table: 'parts' | 'turns'): Promise<Record<string, number>> {
    const rows = table === 'parts'
      ? await db.adminSql<{ session_id: string; n: number }[]>`
          SELECT session_id, count(*)::int AS n FROM harness_shared.session_turn_parts GROUP BY 1`
      : await db.adminSql<{ session_id: string; n: number }[]>`
          SELECT session_id, count(*)::int AS n FROM harness_shared.session_turns GROUP BY 1`;
    return Object.fromEntries(rows.map((r) => [r.session_id, r.n]));
  }

  it('deletes exactly the parts past the 14-day window, past the old 40-batch ceiling', async () => {
    await parts('old', 90, 20, 20);            // 45 full batches of 2: more than the old ceiling of 40
    await parts('late-ingested', 3, 20, 1);    // tail pass only
    await parts('null-ts', 2, null, 20);       // COALESCE -> ingested_at
    await parts('ts-newer-than-ingest', 1, 1, 20); // must survive the bulk pass's exact filter
    await parts('fresh', 4, 1, 1);
    await parts('inside-window', 2, 13, 13);

    const report = await pruneSessionTurnsOnce({ batchRows: 2 });

    expect(await remainingBySession('parts')).toEqual({
      'ts-newer-than-ingest': 1,
      fresh: 4,
      'inside-window': 2,
    });
    expect(report.partsDeleted).toBe(95);
    expect(report.parts.tailDeleted).toBe(3); // only the late-ingested rows
    expect(report.parts.exhausted).toBe(false);
  });

  it('deletes exactly the turns past the 45-day window, including late-ingested ones', async () => {
    await turns('old', 5, 50, 50);
    await turns('late-ingested', 1, 50, 1);
    await turns('fresh', 2, 1, 1);

    const report = await pruneSessionTurnsOnce({ batchRows: 2 });

    expect(await remainingBySession('turns')).toEqual({ fresh: 2 });
    expect(report.deleted).toBe(6);
    expect(report.turns.tailDeleted).toBe(1); // only the late-ingested turn
    expect(report.turns.exhausted).toBe(false);
  });

  /** Record an activation audit citing `refs` (EI-28854179946782151). Replica role
   * skips the plan-revision FK so the fixture needs no plan graph; the CHECKs on
   * activation rows still apply, so every activation column is supplied. */
  async function activationAuditCiting(refs: string[]) {
    const refOrigins = Object.fromEntries(refs.map((r) => [r, { verdict: 'owner-typed' }]));
    await db.adminSql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        INSERT INTO harness_shared.plan_audits
          (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, activation,
           audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash)
        VALUES ('ws-prune', 'h-prune', 'p-prune', 1, 'test', 'activation',
                ${tx.json({ itemProvenanceCheck: { version: 1, refOrigins } })}, 1, 1, ${'a'.repeat(64)})`;
    });
  }

  it('keeps past-window turns that an activation audit cites, and says how many it held', async () => {
    await db.adminSql`DELETE FROM harness_shared.plan_audits WHERE plan_slug = 'p-prune'`;
    await turns('owner:with:colons', 3, 50, 50); // turn_idx 1..3, all past the window
    await turns('late-cited', 2, 50, 1);         // tail-pass population, turn 2 cited
    await turns('fresh', 1, 1, 1);
    await activationAuditCiting([
      'session_turn:claude:owner:with:colons:2', // session id containing ':' (parseTurnRef semantics)
      'session_turn:claude:late-cited:2',
      'session_turn:claude:fresh:1',             // cited but inside the window: not "held"
      'session_turn:claude:gone:9',              // cited, never indexed: must not error
      'order:1072',                              // non-turn refs are ignored
    ]);

    const report = await pruneSessionTurnsOnce({ batchRows: 1 });

    const left = await db.adminSql<{ session_id: string; turn_idx: number }[]>`
      SELECT session_id, turn_idx FROM harness_shared.session_turns ORDER BY session_id, turn_idx`;
    expect(left).toEqual([
      { session_id: 'fresh', turn_idx: 1 },
      { session_id: 'late-cited', turn_idx: 2 },
      { session_id: 'owner:with:colons', turn_idx: 2 },
    ]);
    expect(report.deleted).toBe(3); // owner:with:colons 1+3, late-cited 1
    expect(report.turns.exhausted).toBe(false);
    expect(report.auditCited).toEqual({ citedRefs: 4, heldPastWindow: 2 });
    await db.adminSql`DELETE FROM harness_shared.plan_audits WHERE plan_slug = 'p-prune'`;
  });

  it('reports exhausted when the budget runs out with rows still past the window, and a later run finishes', async () => {
    await parts('old', 6, 20, 20);
    await turns('old', 3, 50, 50);

    const starved = await pruneSessionTurnsOnce({ batchRows: 2, budgetMs: 0, now: () => 0 });
    expect(starved.parts).toEqual({ deleted: 0, batches: 0, exhausted: true, tailDeleted: 0 });
    expect(starved.turns).toEqual({ deleted: 0, batches: 0, exhausted: true, tailDeleted: 0 });
    expect(await remainingBySession('parts')).toEqual({ old: 6 });

    const finished = await pruneSessionTurnsOnce({ batchRows: 2 });
    expect(finished.parts.exhausted).toBe(false);
    expect(finished.partsDeleted).toBe(6);
    expect(finished.deleted).toBe(3);
    expect(await remainingBySession('parts')).toEqual({});
    expect(await remainingBySession('turns')).toEqual({});
  });
});
