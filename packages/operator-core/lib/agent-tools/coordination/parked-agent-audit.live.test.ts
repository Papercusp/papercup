/**
 * P-001 / R-1 of parked-agent-census-resumption-and-root-cause-2026-10-09.
 * Re-read the complete frozen population from PG, independently of the disk projections
 * and disposition writer. Missing, duplicate, foreign or unexplained rows fail closed.
 * The controls always run; the read-only live check requires an explicit opt-in:
 *
 * PAPERCUSP_PARKED_AUDIT_LIVE=1 PAPERCUSP_SKIP_PG_DISCOVERY=1
 *   npm run test:file -- <this file>
 *
 * Reuses the canonical artifact store and live-suite PG gate. It creates no watchdog,
 * alternative census, or changes to the archived start population.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { allowRealPgForLiveSuite } from '../../testing/live-suite-real-pg';

interface Census {
  asOf: string;
  startCount: number;
  records: Array<{ presence: { ownerId: string; sessionState: string } }>;
}
interface Dispositions {
  asOf: string;
  population: number;
  decisions: Array<{
    ownerId: string;
    decision: string;
    reason: string;
    evidence: string[];
    reviewed: boolean;
  }>;
}
interface Review {
  asOf: string;
  population: number;
  rows: Array<{
    ownerId: string;
    work: Array<{
      id: string;
      next: { status: string };
      blockers: { status: string };
      left: { status: string };
    }>;
  }>;
}

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
}

/** Independent set oracle; the declared counts are checked against the actual rows. */
export function auditPopulationViolations(census: Census, dispositions: Dispositions, review: Review): string[] {
  const errors: string[] = [];
  const owners = census.records.map((row) => row.presence.ownerId);
  const population = new Set(owners);
  if (!owners.length) errors.push('empty-population');
  if (owners.length !== census.startCount) errors.push('census-count-mismatch');
  if (duplicates(owners).length) errors.push('duplicate-census-owner');
  if (census.records.some((row) => !row.presence.ownerId || row.presence.sessionState !== 'parked')) {
    errors.push('invalid-start-population');
  }
  for (const [name, rows, count, asOf] of [
    ['dispositions', dispositions.decisions, dispositions.population, dispositions.asOf],
    ['review', review.rows, review.population, review.asOf],
  ] as const) {
    const ids = rows.map((row) => row.ownerId);
    if (asOf !== census.asOf) errors.push(`${name}:snapshot-mismatch`);
    if (count !== census.startCount || ids.length !== count) errors.push(`${name}:count-mismatch`);
    if (duplicates(ids).length) errors.push(`${name}:duplicate-owner`);
    for (const id of population) if (!ids.includes(id)) errors.push(`${name}:missing:${id}`);
    for (const id of ids) if (!population.has(id)) errors.push(`${name}:foreign:${id}`);
  }
  for (const row of dispositions.decisions) {
    if (!row.reviewed || !row.decision?.trim() || !row.reason?.trim() || !row.evidence?.length) {
      errors.push(`dispositions:unexplained:${row.ownerId}`);
    }
  }
  for (const row of review.rows) {
    for (const work of row.work) {
      for (const field of ['next', 'blockers', 'left'] as const) {
        if (!['known', 'unknown'].includes(work[field]?.status)) {
          errors.push(`review:unlabelled:${row.ownerId}:${work.id}:${field}`);
        }
      }
    }
  }
  return errors.sort();
}

const AS_OF = '2026-10-10T01:09:46.552Z';
function fixture(): [Census, Dispositions, Review] {
  return [
    { asOf: AS_OF, startCount: 2, records: ['a', 'b'].map((ownerId) => ({ presence: { ownerId, sessionState: 'parked' } })) },
    { asOf: AS_OF, population: 2, decisions: ['a', 'b'].map((ownerId) => ({ ownerId, decision: 'justified-scoped-wait', reason: 'Named dependency', evidence: ['census.json', 'review-data.json'], reviewed: true })) },
    { asOf: AS_OF, population: 2, rows: ['a', 'b'].map((ownerId) => ({ ownerId, work: [{ id: 'WI-1', next: { status: 'unknown' }, blockers: { status: 'known' }, left: { status: 'unknown' } }] })) },
  ];
}

describe('parked audit population oracle controls', () => {
  it('accepts an exact evidence-backed partition with explicit unknowns', () => {
    expect(auditPopulationViolations(...fixture())).toEqual([]);
  });
  it('rejects a missing disposition even when its declared count is unchanged', () => {
    const [census, dispositions, review] = fixture();
    dispositions.decisions.pop();
    expect(auditPopulationViolations(census, dispositions, review)).toContain('dispositions:missing:b');
  });
  it('rejects duplicate rows that preserve the declared count but omit an agent', () => {
    const [census, dispositions, review] = fixture();
    dispositions.decisions[1] = { ...dispositions.decisions[0] };
    const errors = auditPopulationViolations(census, dispositions, review);
    expect(errors).toContain('dispositions:duplicate-owner');
    expect(errors).toContain('dispositions:missing:b');
  });
  it('rejects a foreign agent and a mismatched observation window', () => {
    const [census, dispositions, review] = fixture();
    review.rows[1].ownerId = 'foreign';
    dispositions.asOf = '2026-10-11T01:09:46.552Z';
    const errors = auditPopulationViolations(census, dispositions, review);
    expect(errors).toContain('review:foreign:foreign');
    expect(errors).toContain('dispositions:snapshot-mismatch');
  });
  it('rejects an unexplained decision and an unlabelled unknown', () => {
    const [census, dispositions, review] = fixture();
    dispositions.decisions[0].reason = '';
    review.rows[0].work[0].next.status = '';
    const errors = auditPopulationViolations(census, dispositions, review);
    expect(errors).toContain('dispositions:unexplained:a');
    expect(errors).toContain('review:unlabelled:a:WI-1:next');
  });
  it('rejects an empty population instead of passing vacuously', () => {
    const [census, dispositions, review] = fixture();
    census.records = [];
    census.startCount = 0;
    expect(auditPopulationViolations(census, dispositions, review)).toContain('empty-population');
  });
});

const LIVE_REQUESTED = process.env.PAPERCUSP_PARKED_AUDIT_LIVE === '1';
allowRealPgForLiveSuite(LIVE_REQUESTED);
describe.skipIf(!LIVE_REQUESTED)('LIVE: R-1 complete parked-agent census partition', () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5, idle_timeout: 5 });
    await sql`SELECT 1`;
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  it('every frozen start-population agent has exactly one disposition and explicit evidence unknowns', async () => {
    const prefix = 'audits/parked-agent-resumption-2026-10-09/';
    const paths = ['census.json', 'dispositions.json', 'review-data.json'].map((name) => prefix + name);
    const rows = await sql<Array<{ rel_path: string; content: string }>>`
      SELECT rel_path, content FROM harness_shared.harness_text_artifacts
       WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
         AND rel_path IN ${sql(paths)}
    `;
    expect(rows.map((row) => row.rel_path).sort(), 'the canonical audit artifacts must all exist').toEqual([...paths].sort());
    const byPath = new Map(rows.map((row) => [row.rel_path, JSON.parse(row.content)]));
    const census = byPath.get(paths[0]) as Census;
    const dispositions = byPath.get(paths[1]) as Dispositions;
    const review = byPath.get(paths[2]) as Review;
    expect(census.asOf, 'the audit must keep its original start population').toBe(AS_OF);
    const errors = auditPopulationViolations(census, dispositions, review);
    const unknowns = review.rows.flatMap((row) => row.work.flatMap((work) =>
      ['next', 'blockers', 'left'].filter((field) => work[field as keyof Pick<typeof work, 'next' | 'blockers' | 'left'>].status === 'unknown')
        .map((field) => `${row.ownerId}:${work.id}:${field}`),
    ));
    process.stdout.write(`PARKED_AUDIT_R1 ${JSON.stringify({ asOf: census.asOf, observedAt: new Date().toISOString(), population: census.records.length, dispositions: dispositions.decisions.length, reviewRows: review.rows.length, explicitlyUnknownFields: unknowns.length, errors })}\n`);
    expect(errors).toEqual([]);
  });
});
