/**
 * coupling-sources-grading.test.ts — P-006, the grading obligation.
 *
 * ⚠ SCOPE IS DELIBERATE (D-014). Only `agent-run` and `work-item` subjects emit. Measured
 * over 281 scorecards in 7 days, the item's phrase "the graded subject's author" resolves
 * for only 13% of cards; the dominant kind is `plan` (54%), where "author" would mean the
 * plan's OWNER — frequently not whoever did the graded work. A guessed counterpart is the
 * failure D-011 exists to prevent, so plan/rubric subjects are deferred, not inferred.
 *
 * ⚠ THE SELF-GRADE CASE IS CONSTRUCTED, AND THAT IS THE POINT. `grader = subject_ref` is
 * **0 across all 281 live cards** — the upstream forbid works. So a test that asserted the
 * guard against live data would be green because the input set is EMPTY, not because the
 * guard works: the exact vacuous-pass shape this codebase keeps getting bitten by. Every
 * self-grade assertion below therefore feeds a fixture, and each is paired with a positive
 * control proving the same code path DOES emit when grader and author differ — otherwise
 * "it emitted nothing" would be indistinguishable from a broken query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  handle: string | null;
  created_ts: number | string | null;
  grader: string | null;
  author: string | null;
}

let nextRows: Row[] = [];
let hasPgFastPath = true;
let sqlThrows = false;
let lastSqlText = '';
let lastSqlValues: unknown[] = [];
let livenessVerdicts = new Map<string, { ownerId: string; sessionState: string | null }>();

vi.mock('./log', () => ({
  coordHasPgFastPath: () => hasPgFastPath,
  coordWorkspaceId: () => 'papercusp-workspace',
  coordSql: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    lastSqlText = strings.join('?');
    lastSqlValues = values;
    if (sqlThrows) throw new Error('pg down');
    return Promise.resolve(nextRows);
  },
}));

vi.mock('./presence-fleet', () => ({
  fetchFleetSupervisionRows: () => Promise.resolve(new Map()),
}));

vi.mock('./liveness-oracle', () => ({
  resolveSessionStates: (subjects: readonly { ownerId: string }[]) => {
    const out = new Map<string, { ownerId: string; sessionState: string | null }>();
    for (const s of subjects) {
      const v = livenessVerdicts.get(s.ownerId);
      if (v) out.set(s.ownerId, v);
    }
    return Promise.resolve(out);
  },
}));

const { fetchGradingObligations, GRADING_OBLIGATION_HORIZON_MS } =
  await import('./coupling-sources');

const NOW = Date.parse('2026-08-25T07:30:00.000Z');
const GRADER = 'su-grader-0001';
const AUTHOR = 'su-author-0002';
const CARD = 'EI-21389737020572400';
const CREATED = NOW - 3 * 60 * 60 * 1000; // 3h old — comfortably inside the horizon

const card = (over: Partial<Row> = {}): Row => ({
  handle: CARD,
  created_ts: CREATED,
  grader: GRADER,
  author: AUTHOR,
  ...over,
});

beforeEach(() => {
  nextRows = [];
  hasPgFastPath = true;
  sqlThrows = false;
  lastSqlText = '';
  lastSqlValues = [];
  livenessVerdicts = new Map([
    [GRADER, { ownerId: GRADER, sessionState: 'live' as string | null }],
    [AUTHOR, { ownerId: AUTHOR, sessionState: 'live' as string | null }],
  ]);
});

describe('P-006 — after a grade lands, the AUTHOR owes the response', () => {
  it('emits `i-owe` to the author, pointing at the grader', async () => {
    nextRows = [card()];
    expect(await fetchGradingObligations(AUTHOR, NOW)).toEqual([
      {
        ownerId: GRADER,
        direction: 'i-owe',
        what: 'a response to a grade',
        since: new Date(CREATED).toISOString(),
        handle: CARD,
        counterpartLiveness: 'live',
      },
    ]);
  });

  it('emits `owes-me` to the grader for the SAME card — one fact, two readings', async () => {
    nextRows = [card()];
    const edges = await fetchGradingObligations(GRADER, NOW);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.direction).toBe('owes-me');
    expect(edges[0]?.ownerId).toBe(AUTHOR);
  });

  it('carries the counterpart’s liveness, reporting `unknown` rather than `live`', async () => {
    nextRows = [card()];
    livenessVerdicts.delete(GRADER);
    const edges = await fetchGradingObligations(AUTHOR, NOW);
    expect(edges[0]?.counterpartLiveness).toBe('unknown');
  });

  it('uses the scorecard id as the handle — what a reader can open', async () => {
    nextRows = [card()];
    const edges = await fetchGradingObligations(AUTHOR, NOW);
    expect(edges[0]?.handle).toBe(CARD);
  });
});

describe('P-006 — the self-grade guard, proved on a CONSTRUCTED fixture', () => {
  it('REFUSES an edge when grader === author', async () => {
    // Cannot occur in live data (0 of 281), so it is constructed here on purpose.
    nextRows = [card({ grader: AUTHOR, author: AUTHOR })];
    expect(await fetchGradingObligations(AUTHOR, NOW)).toEqual([]);
  });

  it('POSITIVE CONTROL: the same call emits when grader and author DIFFER', async () => {
    // Without this, the assertion above is satisfied by any broken query that returns
    // nothing — "emitted nothing" would prove the guard only if emission is possible.
    nextRows = [card()];
    expect(await fetchGradingObligations(AUTHOR, NOW)).toHaveLength(1);
  });

  it('asks the DATABASE to exclude self-grades too, not only the JS filter', async () => {
    nextRows = [];
    await fetchGradingObligations(AUTHOR, NOW);
    expect(lastSqlText.replace(/\s+/g, ' ')).toContain('grader <> author');
  });
});

describe('P-006 — discharge: terminal cards and stale grades are not open debts', () => {
  it('asks the database to exclude terminal scorecard statuses', async () => {
    nextRows = [];
    await fetchGradingObligations(AUTHOR, NOW);
    const sql = lastSqlText.replace(/\s+/g, ' ');
    // 47 of 53 in-scope cards are already terminal; without this the relation would
    // report long-settled grades as outstanding debts.
    expect(sql).toContain('NOT (sc.status = ANY(');
    expect(lastSqlValues.some((v) => Array.isArray(v) && v.includes('done') && v.includes('resolved'))).toBe(true);
  });

  it('bounds the read by the staleness horizon, passed as a real cutoff', async () => {
    nextRows = [];
    await fetchGradingObligations(AUTHOR, NOW);
    // One live open card is 218h old; a nine-day-old unanswered grade is history.
    expect(lastSqlValues).toContain(NOW - GRADING_OBLIGATION_HORIZON_MS);
  });

  it('restricts subjects to the two kinds whose author actually resolves (D-014)', async () => {
    nextRows = [];
    await fetchGradingObligations(AUTHOR, NOW);
    const kinds = lastSqlValues.find((v) => Array.isArray(v) && v.includes('agent-run'));
    expect(kinds).toEqual(['agent-run', 'work-item']);
    // `plan` is 54% of cards and is deliberately NOT here — see D-014.
    expect(kinds).not.toContain('plan');
  });

  it('drops a row whose created_ts is unusable rather than inventing an age', async () => {
    nextRows = [card({ created_ts: null })];
    expect(await fetchGradingObligations(AUTHOR, NOW)).toEqual([]);
  });
});

describe('P-006 — scope and fail-soft', () => {
  it('is CALLER-SCOPED — binds self on both sides of the pair', async () => {
    nextRows = [];
    await fetchGradingObligations(AUTHOR, NOW);
    const sql = lastSqlText.replace(/\s+/g, ' ');
    expect(sql).toContain('grader = ?');
    expect(sql).toContain('author = ?');
    expect(lastSqlValues.filter((v) => v === AUTHOR)).toHaveLength(2);
    expect(sql).not.toContain(AUTHOR);
  });

  it('returns [] when the query throws', async () => {
    sqlThrows = true;
    expect(await fetchGradingObligations(AUTHOR, NOW)).toEqual([]);
  });

  it('returns [] with no PG fast path, without touching the store', async () => {
    hasPgFastPath = false;
    nextRows = [card()];
    expect(await fetchGradingObligations(AUTHOR, NOW)).toEqual([]);
    expect(lastSqlText).toBe('');
  });

  it('returns [] for a blank caller id', async () => {
    nextRows = [card()];
    expect(await fetchGradingObligations('   ', NOW)).toEqual([]);
  });

  it('keeps two grades from the same peer as two debts', async () => {
    nextRows = [card(), card({ handle: 'EI-second' })];
    const edges = await fetchGradingObligations(AUTHOR, NOW);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.handle)).toEqual([CARD, 'EI-second']);
  });
});
