/**
 * LIVE population census for goal-agent-behavior-feedback-2026-09-06 AUTO-BAR-R-1
 * (P-004 / P-001 / P-002 / P-014, evidence plane `live`, rulings D-018, D-020, D-023 rule 1):
 * "Each sampled run has an evidence record containing its goal, holder, observation window,
 * source generation and instruction exposure."
 * Falsifier: "Any sampled run lacks its actual consumed payload, subject/window or
 * source/runtime generation."
 *
 * Population (fixed before counting, D-018 rules 3-4): every NON-retracted behavior-grading card
 * in the live operator database whose subject is an agent run, i.e. observation-lane
 * `harness_shared.work_items` rows in workspace `papercusp-workspace` with
 * `payload.observation.rubricRef = 'goal-mode-e2e'` and `payload.observation.subject.kind =
 * 'agent-run'`, created at or after CUTOFF. CUTOFF is the instant the WI-10003539 fix (the
 * server-derived `observation.evidenceRecord`, agent-run-evidence-record.ts) began serving on the
 * runtime that emitted the cards; earlier cards measure the pre-fix build and never count.
 * Cards are NOT filtered on whether they carry a record: a card without one is a violation, not
 * an exclusion (D-018 rule 5: never narrow the population until it passes).
 *
 * Property asserted over the whole population. N and the cutoff are reported; N is never
 * hard-coded. Each card must carry, in `observation.evidenceRecord`:
 *   goal     goalId non-empty
 *   holder   holder equal to the subject ref
 *   window   window.start and window.end
 *   source   sourceGeneration.advSessionId (the holder's launch running at the window end)
 *   exposure instructionExposure.status = 'recorded' with a consumedPayloadHash. An honest
 *            `not-recorded` still falsifies R-1: the clause requires the ACTUAL consumed payload.
 * The in-file controls prove the checker rejects each missing field, so a green run is not
 * a vacuous one.
 *
 * GUARDED: this asserts over LIVE behavior, so it must never enter the green-checkpoint gate
 * (a new card could freeze main fleet-wide). It runs ONLY when PAPERCUSP_R1_CENSUS_LIVE=1 AND
 * the operator database answers; otherwise the census suite skips. The controls always run.
 *
 *   PAPERCUSP_R1_CENSUS_LIVE=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp \
 *     npm run test:file -- packages/operator-core/lib/behavior-grading-r1-evidence-record.live.test.ts
 */
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { allowRealPgForLiveSuite } from './testing/live-suite-real-pg';

const WORKSPACE = 'papercusp-workspace';
const RUBRIC_REF = 'goal-mode-e2e';
/**
 * The WI-10003539 fix-serve instant. Set when the leader fires `p004:d020-fixes-serve-3170`
 * (D-020 rule 2); until then it is null and the live census refuses to run rather than
 * counting pre-fix cards.
 */
// :3170 (papercup-staging-api) ActiveEnterTimestamp for build 03a7577eb6, which blob-contains the
// fix (agent-run-evidence-record.ts e4c8e4ff). Measured 2026-09-28 by su-25eb2e26.
const CUTOFF: string | null = '2026-09-27T23:18:39Z';

export interface CensusCard {
  card: string;
  subjectRef: string | null;
  evidenceRecord: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Per-card list of the R-1 fields the card's evidence record lacks. */
export function r1Missing(card: CensusCard): string[] {
  const er = card.evidenceRecord as Record<string, any> | null | undefined;
  if (!er || typeof er !== 'object') return ['evidenceRecord'];
  const missing: string[] = [];
  if (!str(er.goalId)) missing.push('goal');
  if (!str(er.holder) || (card.subjectRef && er.holder !== card.subjectRef)) missing.push('holder');
  if (!str(er.window?.start) || !str(er.window?.end)) missing.push('window');
  if (!str(er.sourceGeneration?.advSessionId)) missing.push('sourceGeneration');
  const ex = er.instructionExposure;
  if (ex?.status !== 'recorded' || !str(ex.consumedPayloadHash)) {
    missing.push(`instructionExposure:${str(ex?.status) || 'absent'}`);
  }
  return missing;
}

export function r1Violations(cards: CensusCard[]): string[] {
  const out: string[] = [];
  for (const c of cards) {
    const m = r1Missing(c);
    if (m.length) out.push(`${c.card}:${m.join(',')}`);
  }
  return out;
}

const POPULATION_SQL = `
  SELECT w.feature_id AS card,
         w.payload->'observation'->'subject'->>'ref' AS "subjectRef",
         w.payload->'observation'->'evidenceRecord' AS "evidenceRecord"
    FROM harness_shared.work_items w
   WHERE w.workspace_id = $1
     AND w.lane = 'observation'
     AND w.payload->'observation'->>'rubricRef' = $2
     AND w.payload->'observation'->'subject'->>'kind' = 'agent-run'
     AND w.payload->'observation'->'retracted' IS NULL
     AND w.created_ts >= (extract(epoch FROM $3::timestamptz) * 1000)::bigint
   ORDER BY w.feature_id`;

async function openLive(): Promise<Client | null> {
  if (process.env.PAPERCUSP_R1_CENSUS_LIVE !== '1') return null;
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

const COMPLETE = {
  schemaVersion: 1,
  derivedBy: 'server',
  holder: 'su-h',
  window: { start: '2026-09-27T21:00:00Z', end: '2026-09-27T21:10:00Z' },
  goalId: 'goal-1',
  goalSource: 'goals.agentOwnerId',
  sourceGeneration: { advSessionId: 'adv-1', startedAt: '2026-09-27T20:59:00Z', model: null },
  instructionExposure: {
    status: 'recorded',
    generation: 'rev-1',
    consumedPayloadHash: 'sha256:abc',
    source: 'adv_sessions.launch_spec',
    observedAt: 'launch',
  },
};

describe('R-1 census checker controls (always run)', () => {
  const card = (evidenceRecord: unknown) => ({ card: 'EI-x', subjectRef: 'su-h', evidenceRecord });
  it('accepts a complete server-derived record', () => {
    expect(r1Violations([card(COMPLETE)])).toEqual([]);
  });
  it('rejects a pre-fix card with no evidence record at all', () => {
    expect(r1Violations([card(undefined)])).toEqual(['EI-x:evidenceRecord']);
  });
  it('rejects each missing R-1 field', () => {
    expect(
      r1Violations([
        card({
          ...COMPLETE,
          goalId: null,
          holder: 'su-other',
          window: { start: null, end: '2026-09-27T21:10:00Z' },
          sourceGeneration: null,
        }),
      ]),
    ).toEqual(['EI-x:goal,holder,window,sourceGeneration']);
  });
  it('rejects an honest not-recorded exposure: R-1 needs the actual consumed payload', () => {
    expect(
      r1Violations([card({ ...COMPLETE, instructionExposure: { status: 'not-recorded', reason: 'no launch' } })]),
    ).toEqual(['EI-x:instructionExposure:not-recorded']);
    expect(
      r1Violations([card({ ...COMPLETE, instructionExposure: { status: 'recorded', consumedPayloadHash: '' } })]),
    ).toEqual(['EI-x:instructionExposure:recorded']);
  });
});

describe.skipIf(!LIVE)('LIVE: R-1 evidence-record census (AUTO-BAR-R-1)', () => {
  it('every post-fix agent-run card carries goal, holder, window, source generation and exposure', async () => {
    // Refuse rather than count pre-fix cards: the population needs the fix-serve instant.
    expect(CUTOFF, 'CUTOFF (WI-10003539 fix-serve instant) is not set').not.toBeNull();
    const { rows } = await LIVE!.query<CensusCard>(POPULATION_SQL, [WORKSPACE, RUBRIC_REF, CUTOFF]);
    await LIVE!.end();
    const violations = r1Violations(rows);
    const split: Record<string, number> = {};
    for (const r of rows) for (const m of r1Missing(r)) split[m] = (split[m] ?? 0) + 1;
    console.info(
      `R1_CENSUS cutoff=${CUTOFF} rubric=${RUBRIC_REF} cards=${rows.length} pass=${rows.length - violations.length} fail=${violations.length} missing=${JSON.stringify(split)}`,
    );
    // Non-vacuous: an empty population proves nothing about the property.
    expect(rows.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
