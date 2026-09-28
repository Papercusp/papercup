/**
 * LIVE population census for goal-agent-behavior-feedback-2026-09-06 AUTO-BAR-R-6
 * (P-004, evidence plane `live`, integration layer; rulings D-020, D-021/D-023, D-025):
 * "Each final acceptance verdict cites a reviewer outside the implementer's lineage."
 * Falsifier: "An implementer or its lineage supplies the required independent acceptance,
 * or original review obligations disappear."
 *
 * Population (fixed before counting, D-018 rules 3-4): every NON-retracted scorecard in the
 * live operator database that carries an author acceptance verdict
 * (`payload.observation.acceptance.verdict`) in workspace `papercusp-workspace`, created at or
 * after CUTOFF. CUTOFF is the instant the WI-10003534 fix (scorecards:emit stamps
 * `acceptance.independentGrading` on every author verdict, commit 640549ef6a) began serving on
 * the RELEASE operator (:3070). Agents emit verdicts through the MCP proxy, which forwards to
 * :3070, so a cutoff taken from :3170 alone would count pre-fix :3070 cards. Cards are NOT
 * filtered on whether they carry the citation: a verdict without one is a violation, not an
 * exclusion (D-018 rule 5).
 *
 * Property asserted over the whole population. N and the cutoff are reported; N is never
 * hard-coded. Each verdict must carry `acceptance.independentGrading` such that:
 *   citation   scorecardId and gradedBy are present
 *   outside    gradedBy is neither the verdict's author nor in the author's spawn/rebind
 *              lineage, judged by `areAcceptanceLineageRelated`, the same predicate
 *              scorecards:emit applies at admission
 *   real       the cited scorecard exists, was created by gradedBy, grades the same rubric,
 *              is not retracted and is not itself an author verdict
 * The in-file controls prove the checker rejects each failure, so a green run is not vacuous.
 *
 * NOT COVERED here: the falsifier's second half ("original review obligations disappear").
 * This census judges verdicts that exist; a plan shipped with no verdict at all is out of its
 * population.
 *
 * GUARDED: this asserts over LIVE behavior, so it must never enter the green-checkpoint gate.
 * It runs ONLY when PAPERCUSP_R6_CENSUS_LIVE=1 AND the operator database answers; otherwise the
 * census suite skips. The controls always run.
 *
 *   PAPERCUSP_R6_CENSUS_LIVE=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp \
 *     npm run test:file -- packages/operator-core/lib/behavior-grading-r6-independent-acceptance.live.test.ts
 */
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { areAcceptanceLineageRelated } from './acceptance-author-identity';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { allowRealPgForLiveSuite } from './testing/live-suite-real-pg';

const WORKSPACE = 'papercusp-workspace';
/**
 * The WI-10003534 fix-serve instant on :3070. Null until the release operator runs a build that
 * blob-contains emit.ts's `independentGrading` stamp; until then the live census refuses to run
 * rather than counting pre-fix verdicts. Measured 2026-09-28 05:3xZ: :3070 runs 7708e704d9, which
 * has 0 hits for `independentGrading`; :3170 (deb86d246e) has it.
 */
const CUTOFF: string | null = null;

export interface R6Card {
  card: string;
  author: string | null;
  rubricRef: string | null;
  acceptance: unknown;
}

export interface R6Cited {
  id: string;
  createdBy: string | null;
  rubricRef: string | null;
  retracted: boolean;
  isAcceptance: boolean;
}

export type LineageRelated = (a: string, b: string) => Promise<boolean>;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Per-verdict list of the R-6 properties the card fails. Empty means the card passes. */
export async function r6Problems(
  card: R6Card,
  cited: ReadonlyMap<string, R6Cited>,
  related: LineageRelated,
): Promise<string[]> {
  const ig = (card.acceptance as Record<string, any> | null | undefined)?.independentGrading;
  if (!ig || typeof ig !== 'object') return ['independentGrading'];
  const out: string[] = [];
  const author = str(card.author);
  const gradedBy = str(ig.gradedBy);
  const scorecardId = str(ig.scorecardId);
  if (!author) out.push('author');
  if (!gradedBy) out.push('gradedBy');
  if (!scorecardId) out.push('scorecardId');
  if (author && gradedBy && (gradedBy === author || (await related(gradedBy, author)))) {
    out.push('graderInImplementerLineage');
  }
  if (scorecardId) {
    const c = cited.get(scorecardId);
    if (!c) out.push('citedCardMissing');
    else {
      if (str(c.createdBy) !== gradedBy) out.push('citedCardNotByGrader');
      if (str(c.rubricRef) !== str(card.rubricRef)) out.push('citedCardOtherRubric');
      if (c.retracted) out.push('citedCardRetracted');
      if (c.isAcceptance) out.push('citedCardIsAuthorVerdict');
    }
  }
  return out;
}

export async function r6Violations(
  cards: R6Card[],
  cited: ReadonlyMap<string, R6Cited>,
  related: LineageRelated,
): Promise<string[]> {
  const out: string[] = [];
  for (const c of cards) {
    const p = await r6Problems(c, cited, related);
    if (p.length) out.push(`${c.card}:${p.join(',')}`);
  }
  return out;
}

const POPULATION_SQL = `
  SELECT e.issue_id AS card,
         e.created_by AS author,
         e.payload->'observation'->>'rubricRef' AS "rubricRef",
         e.payload->'observation'->'acceptance' AS acceptance
    FROM harness_shared.engineer_issues e
   WHERE e.workspace_id = $1
     AND e.payload->'observation'->'acceptance'->>'verdict' IS NOT NULL
     AND e.payload->'observation'->'retracted' IS NULL
     AND e.created_at >= $2::timestamptz
   ORDER BY e.issue_id`;

const CITED_SQL = `
  SELECT e.issue_id AS id,
         e.created_by AS "createdBy",
         e.payload->'observation'->>'rubricRef' AS "rubricRef",
         (e.payload->'observation'->'retracted') IS NOT NULL AS retracted,
         (e.payload->'observation'->'acceptance') IS NOT NULL AS "isAcceptance"
    FROM harness_shared.engineer_issues e
   WHERE e.workspace_id = $1
     AND e.issue_id = ANY($2::text[])`;

async function openLive(): Promise<Client | null> {
  if (process.env.PAPERCUSP_R6_CENSUS_LIVE !== '1') return null;
  const client = new Client({ connectionString: getHarnessAdminUrl(), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return client;
  } catch {
    await client.end().catch(() => undefined);
    return null;
  }
}

const LIVE = await openLive();
allowRealPgForLiveSuite(Boolean(LIVE));

describe('R-6 census checker controls (always run)', () => {
  const grading: R6Cited = {
    id: 'EI-g',
    createdBy: 'su-grader',
    rubricRef: 'acceptance-x',
    retracted: false,
    isAcceptance: false,
  };
  const cited = new Map([[grading.id, grading]]);
  const unrelated: LineageRelated = async () => false;
  const verdict = (independentGrading: unknown, author = 'su-impl'): R6Card => ({
    card: 'EI-v',
    author,
    rubricRef: 'acceptance-x',
    acceptance: { verdict: 'accept', reasoning: 'r', independentGrading },
  });
  const ig = { scorecardId: 'EI-g', gradedBy: 'su-grader', selectedBy: 'acceptanceOf' };

  it('accepts a verdict citing a real grading by an unrelated reviewer', async () => {
    expect(await r6Violations([verdict(ig)], cited, unrelated)).toEqual([]);
  });
  it('rejects a pre-fix verdict with no citation at all', async () => {
    expect(await r6Violations([verdict(undefined)], cited, unrelated)).toEqual(['EI-v:independentGrading']);
  });
  it('rejects a self-graded verdict and a grader in the implementer lineage', async () => {
    expect(await r6Violations([verdict(ig, 'su-grader')], cited, unrelated)).toEqual([
      'EI-v:graderInImplementerLineage',
    ]);
    const lineage: LineageRelated = async (a, b) => a === 'su-grader' && b === 'su-impl';
    expect(await r6Violations([verdict(ig)], cited, lineage)).toEqual(['EI-v:graderInImplementerLineage']);
  });
  it('rejects a citation that does not resolve to a real independent grading', async () => {
    expect(
      await r6Violations([verdict({ ...ig, scorecardId: 'EI-none' })], cited, unrelated),
    ).toEqual(['EI-v:citedCardMissing']);
    const forged = new Map([
      ['EI-g', { ...grading, createdBy: 'su-else', rubricRef: 'acceptance-y', retracted: true, isAcceptance: true }],
    ]);
    expect(await r6Violations([verdict(ig)], forged, unrelated)).toEqual([
      'EI-v:citedCardNotByGrader,citedCardOtherRubric,citedCardRetracted,citedCardIsAuthorVerdict',
    ]);
    expect(await r6Violations([verdict({ selectedBy: 'scan' })], cited, unrelated)).toEqual([
      'EI-v:gradedBy,scorecardId',
    ]);
  });
});

describe.skipIf(!LIVE)('LIVE: R-6 independent-acceptance census (AUTO-BAR-R-6)', () => {
  it('every post-fix author verdict cites a real grading by a reviewer outside the implementer lineage', async () => {
    // Refuse rather than count pre-fix verdicts: the population needs the :3070 fix-serve instant.
    expect(CUTOFF, 'CUTOFF (WI-10003534 :3070 fix-serve instant) is not set').not.toBeNull();
    const { rows } = await LIVE!.query<R6Card>(POPULATION_SQL, [WORKSPACE, CUTOFF]);
    const ids = rows
      .map((r) => str((r.acceptance as Record<string, any> | null)?.independentGrading?.scorecardId))
      .filter(Boolean);
    const citedRows = ids.length
      ? (await LIVE!.query<R6Cited>(CITED_SQL, [WORKSPACE, ids])).rows
      : [];
    await LIVE!.end();
    const cited = new Map(citedRows.map((c) => [c.id, c]));
    const related: LineageRelated = (a, b) => areAcceptanceLineageRelated(a, b, { workspaceId: WORKSPACE });
    const violations = await r6Violations(rows, cited, related);
    const split: Record<string, number> = {};
    for (const r of rows) for (const p of await r6Problems(r, cited, related)) split[p] = (split[p] ?? 0) + 1;
    console.info(
      `R6_CENSUS cutoff=${CUTOFF} verdicts=${rows.length} pass=${rows.length - violations.length} fail=${violations.length} problems=${JSON.stringify(split)}`,
    );
    // Non-vacuous: an empty population proves nothing about the property.
    expect(rows.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
