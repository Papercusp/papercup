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
 * HALF 2 — "original review obligations disappear". The verdict census above judges verdicts
 * that exist, so a plan shipped with no verdict at all is outside its population. The ship
 * census covers it. Population: every observed ship TRANSITION at or after CUTOFF of a plan the
 * ship gate does not exempt (plan-acceptance-gate.ts exempts only rubric-template plans and
 * template instances; `force` never waives the rubric family). A transition is a plan_revisions
 * row whose frontmatter says `status: shipped` while the revision at seq-1 does not. This is not
 * harness_plans.updated_at and not the earliest surviving shipped revision. plan-item-reflect-sweep
 * rewrites shipped plans about every 15 min, and revisions-gc keeps only the newest 100 per plan,
 * so neither of those is a ship time. Property per ship: the plan has an acceptance rubric; before
 * the ship that rubric carries a non-retracted grading card AND an author verdict; the latest
 * verdict is `accept`; and at least one grading comes from someone outside that verdict author's
 * lineage. A shipped plan whose transition is no longer retained is reported as UNOBSERVABLE and
 * never counted as a pass. Known leniency: a card on any of the plan's acceptance rubrics counts,
 * because retirement at ship makes the ship-time rubric indistinguishable from an older superseded one.
 * The live historical control pins a real instance (owner-directive-delivery-redesign-2026-09-22,
 * shipped 2026-09-24T05:32:04Z with its rubric retired 19s earlier and no grading or verdict), so
 * the ship census is shown to catch a real disappearance, not only fixtures.
 *
 * GUARDED: this asserts over LIVE behavior, so it must never enter the green-checkpoint gate.
 * It runs ONLY when PAPERCUSP_R6_CENSUS_LIVE=1 AND the operator database answers; otherwise the
 * census suite skips. The controls always run.
 *
 *   PAPERCUSP_R6_CENSUS_LIVE=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp \
 *     npm run test:file -- packages/operator-core/lib/behavior-grading-r6-independent-acceptance.live.test.ts
 */
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
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

/** One observed ship transition of a non-exempt plan, with every acceptance rubric for it. */
export interface R6Ship {
  plan: string;
  harness: string;
  shippedAt: string | Date;
  rubrics: string[];
}

/** A non-retracted scorecard on one of a shipped plan's acceptance rubrics. */
export interface R6RubricCard {
  card: string;
  rubricRef: string;
  author: string | null;
  isAcceptance: boolean;
  verdict: string | null;
  createdAt: string | Date;
}

const ms = (v: string | Date): number => new Date(v).getTime();

/** Per-ship list of the review obligations that did not survive to the ship. Empty means it passes. */
export async function r6ShipProblems(
  ship: R6Ship,
  cards: readonly R6RubricCard[],
  related: LineageRelated,
): Promise<string[]> {
  if (!ship.rubrics.length) return ['noAcceptanceRubric'];
  const before = cards.filter((c) => ship.rubrics.includes(c.rubricRef) && ms(c.createdAt) <= ms(ship.shippedAt));
  const gradings = before.filter((c) => !c.isAcceptance);
  const verdicts = before.filter((c) => c.isAcceptance).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const out: string[] = [];
  if (!gradings.length) out.push('noGrading');
  const latest = verdicts[verdicts.length - 1];
  if (!latest) return [...out, 'noAuthorVerdict'];
  if (str(latest.verdict) !== 'accept') out.push('latestVerdictNotAccept');
  const author = str(latest.author);
  let independent = false;
  for (const g of gradings) {
    const by = str(g.author);
    if (by && author && by !== author && !(await related(by, author))) {
      independent = true;
      break;
    }
  }
  if (gradings.length && !independent) out.push('noIndependentGrading');
  return out;
}

export async function r6ShipViolations(
  ships: readonly R6Ship[],
  cards: readonly R6RubricCard[],
  related: LineageRelated,
): Promise<string[]> {
  const out: string[] = [];
  for (const s of ships) {
    const p = await r6ShipProblems(s, cards, related);
    if (p.length) out.push(`${s.plan}:${p.join(',')}`);
  }
  return out;
}

const FM_SHIPPED = (alias: string) =>
  `(substring(${alias}.content_snapshot from '^---\\n(.*?)\\n---') ~ '(^|\\n)status:\\s*shipped')`;

/** Observed ship transitions in [$2, $3) of plans the ship gate does not exempt. */
const SHIPS_SQL = `
  SELECT c.plan_slug AS plan,
         c.harness_slug AS harness,
         to_timestamp(c.created_at / 1000.0) AS "shippedAt",
         COALESCE((SELECT array_agg(rb.plan_slug ORDER BY rb.plan_slug)
                     FROM harness_shared.harness_plans rb
                    WHERE rb.workspace_id = $1
                      AND rb.template = 'rubric'
                      AND rb.template_slug IS NULL
                      AND rb.template_data->>'kind' = 'acceptance'
                      AND rb.template_data->>'subjectPlan' = c.plan_slug
                      AND (rb.template_data->>'subjectHarnessSlug' IS NULL
                           OR rb.template_data->>'subjectHarnessSlug' = c.harness_slug)),
                  '{}') AS rubrics
    FROM harness_shared.plan_revisions c
    JOIN harness_shared.plan_revisions prev
      ON prev.workspace_id = c.workspace_id AND prev.harness_slug = c.harness_slug
     AND prev.plan_slug = c.plan_slug AND prev.seq = c.seq - 1
    JOIN harness_shared.harness_plans p
      ON p.workspace_id = c.workspace_id AND p.harness_slug = c.harness_slug AND p.plan_slug = c.plan_slug
   WHERE c.workspace_id = $1
     AND c.created_at >= extract(epoch FROM $2::timestamptz) * 1000
     AND c.created_at < extract(epoch FROM $3::timestamptz) * 1000
     AND ${FM_SHIPPED('c')} AND NOT ${FM_SHIPPED('prev')}
     AND p.template IS DISTINCT FROM 'rubric' AND p.template_slug IS NULL
   ORDER BY c.plan_slug, c.seq`;

const RUBRIC_CARDS_SQL = `
  SELECT e.issue_id AS card,
         e.payload->'observation'->>'rubricRef' AS "rubricRef",
         e.created_by AS author,
         (e.payload->'observation'->'acceptance') IS NOT NULL AS "isAcceptance",
         e.payload->'observation'->'acceptance'->>'verdict' AS verdict,
         e.created_at AS "createdAt"
    FROM harness_shared.engineer_issues e
   WHERE e.workspace_id = $1
     AND e.payload->'observation'->>'rubricRef' = ANY($2::text[])
     AND e.payload->'observation'->'retracted' IS NULL`;

/** Currently-shipped, non-exempt plans touched since $2 with NO retained ship transition. */
const UNOBSERVABLE_SQL = `
  SELECT p.plan_slug AS plan
    FROM harness_shared.harness_plans p
   WHERE p.workspace_id = $1 AND p.status = 'shipped'
     AND p.template IS DISTINCT FROM 'rubric' AND p.template_slug IS NULL
     AND p.updated_at >= $2::timestamptz
     AND NOT EXISTS (
       SELECT 1 FROM harness_shared.plan_revisions c
         JOIN harness_shared.plan_revisions prev
           ON prev.workspace_id = c.workspace_id AND prev.harness_slug = c.harness_slug
          AND prev.plan_slug = c.plan_slug AND prev.seq = c.seq - 1
        WHERE c.workspace_id = p.workspace_id AND c.harness_slug = p.harness_slug
          AND c.plan_slug = p.plan_slug AND ${FM_SHIPPED('c')} AND NOT ${FM_SHIPPED('prev')})
   ORDER BY p.plan_slug`;

async function shipCensus(client: Client, from: string, to: string) {
  const ships = (await client.query<R6Ship>(SHIPS_SQL, [WORKSPACE, from, to])).rows;
  const refs = [...new Set(ships.flatMap((s) => s.rubrics))];
  const cards = refs.length
    ? (await client.query<R6RubricCard>(RUBRIC_CARDS_SQL, [WORKSPACE, refs])).rows
    : [];
  const related: LineageRelated = (a, b) => areAcceptanceLineageRelated(a, b, { workspaceId: WORKSPACE });
  const problems = new Map<string, string[]>();
  for (const s of ships) problems.set(`${s.plan}@${ms(s.shippedAt)}`, await r6ShipProblems(s, cards, related));
  return { ships, problems, violations: await r6ShipViolations(ships, cards, related) };
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

describe('R-6 ship-census checker controls (always run)', () => {
  const unrelated: LineageRelated = async () => false;
  const ship = (rubrics = ['acc-x']): R6Ship => ({
    plan: 'p',
    harness: 'h',
    shippedAt: '2026-09-28T10:00:00Z',
    rubrics,
  });
  const card = (over: Partial<R6RubricCard>): R6RubricCard => ({
    card: 'EI-c',
    rubricRef: 'acc-x',
    author: 'su-grader',
    isAcceptance: false,
    verdict: null,
    createdAt: '2026-09-28T09:00:00Z',
    ...over,
  });
  const grading = card({});
  const accept = card({ card: 'EI-v', author: 'su-impl', isAcceptance: true, verdict: 'accept' });

  it('accepts a ship whose rubric carries an independent grading and an accepting author verdict', async () => {
    expect(await r6ShipViolations([ship()], [grading, accept], unrelated)).toEqual([]);
  });
  it('rejects a ship with no acceptance rubric at all', async () => {
    expect(await r6ShipViolations([ship([])], [grading, accept], unrelated)).toEqual(['p:noAcceptanceRubric']);
  });
  it('rejects a ship whose rubric was never graded or accepted (the obligation disappeared)', async () => {
    expect(await r6ShipViolations([ship()], [], unrelated)).toEqual(['p:noGrading,noAuthorVerdict']);
  });
  it('ignores cards emitted after the ship, on other rubrics, and a superseded accept', async () => {
    const late = [card({ createdAt: '2026-09-28T11:00:00Z' }), { ...accept, createdAt: '2026-09-28T11:00:00Z' }];
    expect(await r6ShipViolations([ship()], late, unrelated)).toEqual(['p:noGrading,noAuthorVerdict']);
    const elsewhere = [card({ rubricRef: 'acc-y' }), { ...accept, rubricRef: 'acc-y' }];
    expect(await r6ShipViolations([ship()], elsewhere, unrelated)).toEqual(['p:noGrading,noAuthorVerdict']);
    const reject = { ...accept, card: 'EI-r', verdict: 'reject', createdAt: '2026-09-28T09:30:00Z' };
    expect(await r6ShipViolations([ship()], [grading, accept, reject], unrelated)).toEqual([
      'p:latestVerdictNotAccept',
    ]);
  });
  it('rejects a ship graded only by the implementer or its lineage', async () => {
    expect(await r6ShipViolations([ship()], [card({ author: 'su-impl' }), accept], unrelated)).toEqual([
      'p:noIndependentGrading',
    ]);
    const lineage: LineageRelated = async (a, b) => a === 'su-grader' && b === 'su-impl';
    expect(await r6ShipViolations([ship()], [grading, accept], lineage)).toEqual(['p:noIndependentGrading']);
  });
});

describe.skipIf(!LIVE)('LIVE: R-6 independent-acceptance census (AUTO-BAR-R-6)', () => {
  afterAll(async () => {
    await LIVE?.end();
  });

  it('historical control: the ship census catches a real disappeared obligation in live data', async () => {
    // owner-directive-delivery-redesign-2026-09-22 shipped 2026-09-24T05:32:04Z (plan_revisions
    // seq 44 -> 45) with its acceptance rubric superseded 19s earlier and no grading or verdict.
    const { ships, problems } = await shipCensus(LIVE!, '2026-09-24T05:00:00Z', '2026-09-24T06:00:00Z');
    const hit = ships.find((s) => s.plan === 'owner-directive-delivery-redesign-2026-09-22');
    expect(hit, 'the pinned transition is no longer retained in plan_revisions').toBeDefined();
    expect(problems.get(`${hit!.plan}@${ms(hit!.shippedAt)}`)).toEqual(['noGrading', 'noAuthorVerdict']);
  });

  it('every post-fix ship transition kept its review obligation (falsifier half 2)', async () => {
    expect(CUTOFF, 'CUTOFF (WI-10003534 :3070 fix-serve instant) is not set').not.toBeNull();
    const now = new Date().toISOString();
    const { ships, problems, violations } = await shipCensus(LIVE!, CUTOFF!, now);
    const unobservable = (await LIVE!.query<{ plan: string }>(UNOBSERVABLE_SQL, [WORKSPACE, CUTOFF])).rows;
    const split: Record<string, number> = {};
    for (const p of problems.values()) for (const k of p) split[k] = (split[k] ?? 0) + 1;
    console.info(
      `R6_SHIP_CENSUS cutoff=${CUTOFF} to=${now} ships=${ships.length} pass=${ships.length - violations.length} ` +
        `fail=${violations.length} problems=${JSON.stringify(split)} unobservable=${unobservable.length} ` +
        `unobservableSample=${JSON.stringify(unobservable.slice(0, 10).map((u) => u.plan))}`,
    );
    expect(ships.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

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
