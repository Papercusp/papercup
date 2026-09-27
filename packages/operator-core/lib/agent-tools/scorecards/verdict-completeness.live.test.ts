/**
 * LIVE census for goal-agent-behavior-feedback-2026-09-06 AUTO-BAR-R-7-P-004:
 * "Each submitted run verdict contains every current GOAL criterion on the canonical
 * scorecard surface."
 *
 * Population: every revision-stamped `goal-mode-e2e` scorecard card in the live operator
 * database (harness_shared.engineer_issues, observation.rubricRef = 'goal-mode-e2e' and
 * observation.rubricRevision present). Cards without a rubricRevision cannot say which
 * revision they graded, so they are reported as unverifiable and never counted as passes.
 *
 * Oracle (independent of the emit path under test): the criterion key set of the
 * `goal-mode-e2e` plan_revisions snapshot in force at the card's created_at (latest seq
 * whose created_at <= the card's). Rubric history is read from those snapshots, never from
 * rubrics:get on a serving build (which relabels current content as history).
 *
 * The property: every card in the population rates EXACTLY the snapshot's key set. The
 * test reports N and the cutoff; it never asserts a hard-coded N. An empty population
 * FAILS rather than passing vacuously.
 *
 * Ruling: goal-agent-behavior-feedback-2026-09-06#D-023 rule 1 (a live census binds only in
 * ledger form, as a committed *.live.test.ts run through the test ledger).
 *
 * GUARDED: the live suite runs ONLY when PAPERCUSP_R7_VERDICT_CENSUS_LIVE=1 AND the
 * operator database answers; otherwise it skips. The pure oracle tests below always run.
 *
 *   PAPERCUSP_R7_VERDICT_CENSUS_LIVE=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp \
 *     npm run test:file -- packages/operator-core/lib/agent-tools/scorecards/verdict-completeness.live.test.ts
 */
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { allowRealPgForLiveSuite } from '../../testing/live-suite-real-pg';

export interface CensusCard {
  id: string;
  createdAt: string;
  rubricRevision: string;
  keys: string[];
  /** Criterion keys of the snapshot in force at createdAt; null when none precedes it. */
  snapshotKeys: string[] | null;
}

export interface CensusVerdict {
  n: number;
  exact: string[];
  mismatch: Array<{ id: string; missing: string[]; extra: string[] }>;
  noSnapshot: string[];
}

/** Pure oracle: compare each card's rated keys with the snapshot key set in force. */
export function judgeVerdictCompleteness(cards: CensusCard[]): CensusVerdict {
  const verdict: CensusVerdict = { n: cards.length, exact: [], mismatch: [], noSnapshot: [] };
  for (const card of cards) {
    if (card.snapshotKeys === null || card.snapshotKeys.length === 0) {
      verdict.noSnapshot.push(card.id);
      continue;
    }
    const rated = new Set(card.keys);
    const expected = new Set(card.snapshotKeys);
    const missing = [...expected].filter((k) => !rated.has(k)).sort();
    const extra = [...rated].filter((k) => !expected.has(k)).sort();
    if (missing.length === 0 && extra.length === 0) verdict.exact.push(card.id);
    else verdict.mismatch.push({ id: card.id, missing, extra });
  }
  return verdict;
}

describe('R-7 verdict-completeness oracle (pure)', () => {
  const card = (id: string, keys: string[], snapshotKeys: string[] | null): CensusCard => ({
    id,
    createdAt: '2026-09-27T00:00:00Z',
    rubricRevision: '1',
    keys,
    snapshotKeys,
  });

  it('accepts a card that rates exactly the snapshot key set, in any order', () => {
    const v = judgeVerdictCompleteness([card('A', ['b', 'a'], ['a', 'b'])]);
    expect(v.exact).toEqual(['A']);
    expect(v.mismatch).toEqual([]);
  });

  it('rejects a card missing a current criterion, naming the missing key', () => {
    const v = judgeVerdictCompleteness([card('B', ['a'], ['a', 'b'])]);
    expect(v.mismatch).toEqual([{ id: 'B', missing: ['b'], extra: [] }]);
  });

  it('rejects a card rating a key the snapshot does not contain', () => {
    const v = judgeVerdictCompleteness([card('C', ['a', 'b', 'z'], ['a', 'b'])]);
    expect(v.mismatch).toEqual([{ id: 'C', missing: [], extra: ['z'] }]);
  });

  it('reports a card with no preceding snapshot as unverifiable, never as a pass', () => {
    const v = judgeVerdictCompleteness([card('D', ['a'], null), card('E', ['a'], [])]);
    expect(v.exact).toEqual([]);
    expect(v.noSnapshot).toEqual(['D', 'E']);
  });
});

const WORKSPACE = process.env.PAPERCUSP_R7_CENSUS_WORKSPACE ?? 'papercusp-workspace';
const LIVE_REQUESTED = process.env.PAPERCUSP_R7_VERDICT_CENSUS_LIVE === '1';

async function openLiveDb(): Promise<postgres.Sql | null> {
  if (!LIVE_REQUESTED) return null;
  const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5, idle_timeout: 5 });
  try {
    await sql`SELECT 1`;
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    return null;
  }
}

const LIVE_DB = await openLiveDb();
allowRealPgForLiveSuite(Boolean(LIVE_DB));

describe.skipIf(!LIVE_DB)('LIVE: goal-mode-e2e verdicts carry every current criterion (AUTO-BAR-R-7-P-004)', () => {
  const sql = LIVE_DB as postgres.Sql;
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('every revision-stamped goal-mode-e2e card rates exactly the criteria in force at its creation', async () => {
    const rows = await sql<
      Array<{ id: string; created_at: Date; rev: string; keys: string[]; snapshot_keys: string[] | null }>
    >`
      WITH cards AS (
        SELECT issue_id AS id,
               created_at,
               payload->'observation'->>'rubricRevision' AS rev,
               CASE WHEN jsonb_typeof(payload->'observation'->'ratings') = 'object'
                    THEN ARRAY(SELECT k FROM jsonb_object_keys(payload->'observation'->'ratings') AS k ORDER BY 1)
                    ELSE ARRAY[]::text[] END AS keys
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${WORKSPACE}
           AND scope = 'harness:papercusp'
           AND payload->'observation'->>'rubricRef' = 'goal-mode-e2e'
           AND payload->'observation'->>'rubricRevision' IS NOT NULL
      )
      SELECT c.id, c.created_at, c.rev, c.keys,
             (SELECT ARRAY(SELECT DISTINCT m[1]
                             FROM regexp_matches(pr.content_snapshot, '"key": "([^"]+)"', 'g') AS m
                            ORDER BY 1)
                FROM harness_shared.plan_revisions pr
               WHERE pr.workspace_id = ${WORKSPACE}
                 AND pr.plan_slug = 'goal-mode-e2e'
                 AND to_timestamp(pr.created_at / 1000.0) <= c.created_at
               ORDER BY pr.seq DESC
               LIMIT 1) AS snapshot_keys
        FROM cards c
       ORDER BY c.created_at
    `;
    const cards: CensusCard[] = rows.map((r) => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      rubricRevision: r.rev,
      keys: r.keys,
      snapshotKeys: r.snapshot_keys,
    }));
    const verdict = judgeVerdictCompleteness(cards);
    const cutoff = cards.length > 0 ? cards[cards.length - 1].createdAt : 'none';
    process.stdout.write(
      `R7_CENSUS ${JSON.stringify({
        workspace: WORKSPACE,
        n: verdict.n,
        exact: verdict.exact.length,
        mismatch: verdict.mismatch,
        noSnapshot: verdict.noSnapshot,
        newestCard: cutoff,
        observedAt: new Date().toISOString(),
      })}\n`,
    );

    expect(verdict.n, 'empty population: the census would pass vacuously').toBeGreaterThan(0);
    expect(verdict.noSnapshot, 'cards with no rubric snapshot in force cannot be verified').toEqual([]);
    expect(verdict.mismatch, 'cards missing or adding criteria relative to the snapshot in force').toEqual([]);
    expect(verdict.exact).toHaveLength(verdict.n);
  });
});
