/**
 * scorecards.trend-provisional.test.ts — P-008 (EI-20581177540737568): a PROVISIONAL
 * scorecard (mid-run rating of 'violatable' criteria, stamped by scorecards:emit) is a
 * working note (D-004) — it must NOT move the trend, and its exclusion must be
 * REPORTED, never silent (same contract as supersededExcluded / preContractResetExcluded).
 *
 * The fixture is the measured WI-39348 shape: an interim card graded the run 'broken'
 * mid-run; the terminal cards say 'healthy'. Pre-P-008 the interim entered the series
 * and flipped the direction — here it is excluded and counted.
 */
import { describe, it, expect, vi } from 'vitest';

const DB_ROWS = [
  // newest-first, as the real SELECT returns them
  {
    issue_id: 'EI-final-2',
    created_by: 'agent-a',
    created_at: '2026-08-03T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'healthy', evidence: 'e' } },
      },
    },
  },
  {
    issue_id: 'EI-interim',
    created_by: 'agent-a',
    created_at: '2026-08-02T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'broken', evidence: 'e' } },
        provisional: { violatableKeys: ['alpha'], stampedAt: '2026-08-02T00:00:00.000Z' },
      },
    },
  },
  {
    issue_id: 'EI-final-1',
    created_by: 'agent-a',
    created_at: '2026-08-01T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'healthy', evidence: 'e' } },
      },
    },
  },
];

const ALL_PROVISIONAL_ROWS = DB_ROWS.map((row) => ({
  ...row,
  payload: {
    ...row.payload,
    observation: {
      ...row.payload.observation,
      provisional: { violatableKeys: ['alpha'], stampedAt: row.created_at },
    },
  },
}));

let rowsForQuery = DB_ROWS;

const RUBRIC_DEFINITION = {
  rubricId: 'test-rubric',
  workspaceId: 'test-workspace',
  kind: 'standard',
  characteristic: 'test-quality',
  title: 'Test rubric',
  description: 'Definition payload fixture',
  criteria: [
    {
      key: 'alpha',
      title: 'Alpha',
      model: 'Expected alpha behavior',
      method: 'Run the alpha test',
      driftMarkers: 'The alpha test fails',
    },
  ],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'agent-a',
  proposedBy: 'agent-a',
  ratifiedBy: 'agent-b',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
} as const;

const sqlTag = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
  const text = strings.join(' ? ');
  if (text.includes('FROM harness_shared.engineer_issues')) {
    return Promise.resolve(rowsForQuery) as unknown as Promise<unknown[]>;
  }
  return { __sqlFragment: text } as unknown as Promise<unknown[]>;
};

// scorecards.ts now reads through boundedPgReadTxn. Execute that callback on
// the tagged mock and absorb its READ ONLY/session setup statements so the
// fixture returns rowsForQuery instead of the old empty-begin undefined.
const sqlMock = Object.assign(sqlTag, {
  begin: vi.fn(async <T>(transaction: (tx: unknown) => Promise<T>) => transaction(sqlMock)),
  unsafe: vi.fn(async () => []),
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

vi.mock('./issues-engineer', () => ({
  issuesScopeWorkspace: () => 'test-workspace',
  issuesOutLinksMany: async () => new Map(),
  issuesSupersededByRevision: async () => new Set<string>(),
}));

vi.mock('./rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rubrics')>()),
  getRubric: async () => RUBRIC_DEFINITION,
  getRubricWithoutSeeding: async () => RUBRIC_DEFINITION,
  rubricInstrumentContract: () => null,
}));

describe('scorecardTrend — provisional cards are excluded and the exclusion reported (P-008)', () => {
  it('drops the provisional interim from the series and counts it in provisionalExcluded', async () => {
    const { scorecardTrend, listScorecards } = await import('./scorecards');

    // The LIST keeps the interim (a real, auditable filing, provisional flag projected)…
    const rows = await listScorecards({ rubricRef: 'test-rubric', limit: 100 });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.issueId === 'EI-interim')?.provisional).toMatchObject({
      violatableKeys: ['alpha'],
    });
    expect(rows.find((r) => r.issueId === 'EI-final-2')?.provisional).toBeUndefined();

    // …the TREND excludes it, reported.
    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });
    expect(trend.provisionalExcluded).toBe(1);
    expect(trend.supersededExcluded).toBe(0);
    expect(trend.scorecardCount).toBe(2);

    const alpha = trend.criteria.find((c) => c.criterion === 'alpha')!;
    // The interim's 'broken' never entered: two 'healthy' samples, stable direction.
    expect(alpha.count).toBe(2);
    expect(alpha.distribution).toEqual({ healthy: 2 });
    expect(alpha.direction).toBe('stable');
    expect(alpha.latest.at).toBe('2026-08-03T00:00:00.000Z');
  });

  it('includes the already-resolved rubric definition only when requested', async () => {
    const { scorecardTrend } = await import('./scorecards');

    const compact = await scorecardTrend({ rubricRef: 'test-rubric' });
    const definitionAware = await scorecardTrend({
      rubricRef: 'test-rubric',
      includeDefinition: true,
    });

    expect(compact.definition).toBeUndefined();
    expect(definitionAware.definition).toEqual(RUBRIC_DEFINITION);
  });

  it('names a provisional-only window instead of claiming the rubric was never graded', async () => {
    rowsForQuery = ALL_PROVISIONAL_ROWS;
    const { scorecardTrend } = await import('./scorecards');

    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });

    expect(trend.scorecardCount).toBe(0);
    expect(trend.provisionalExcluded).toBe(3);
    expect(trend.staleness.reason).toContain('3 scorecards in the window were excluded');
    expect(trend.staleness.reason).toContain('3 provisional');
    expect(trend.staleness.reason).not.toContain('never been graded');

    rowsForQuery = DB_ROWS;
  });
});
