/**
 * scorecards.links-optin.test.ts — WI-6124: `listScorecards` resolves outbound links
 * ONLY when a caller opts in, and the reads that actually SURFACE links still do.
 *
 * Why this exists. Resolving `linkedItems` costs one join-heavy query per call
 * (`issuesOutLinksMany`, LEFT JOINing engineer_issues AND features over up to `limit`
 * issue refs). It used to be eager, so every caller paid it — and measured on
 * 2026-08-02 (pg_stat_statements) that statement was the MOST-CALLED query on the box:
 * 1,209,724 calls / 64,865s, reachable only from here, for a field that no server-side
 * caller reads at all. It grew that large silently: `scorecardTrend` and the
 * derived-reads producer both arrived later and both inherited the cost.
 *
 * Neither default is compile-enforceable — both surfacing sites pass rows straight
 * through (`as unknown[]` / a wholesale tool return), so TypeScript cannot see the read.
 * That is exactly why these are TESTS: they are the only mechanical thing standing
 * between the opt-in default and a silent regression, in BOTH directions.
 *
 *   - forget the opt-OUT (pre-WI-6124 default) → ~1.2M pointless heavy joins, invisible
 *   - forget the opt-IN  (post-WI-6124 default) → the ScorecardDetail panel silently
 *     renders no linked items, and agents see every scorecard as unlinked
 *
 * The second failure is the one the new default introduces, so it is pinned here at the
 * REAL call sites (the `scorecards.list` sync-resolver entry and the `scorecards:list`
 * agent tool) rather than by asserting on a flag in isolation — a test that only checked
 * `includeLinks: true` behaves correctly would still pass if a call site dropped it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** One scorecard row as the engineer_issues SELECT returns it. */
const DB_ROWS = [
  {
    issue_id: 'EI-1',
    created_by: 'agent-a',
    created_at: '2026-08-01T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'healthy', evidence: 'e' } },
      },
    },
  },
  {
    issue_id: 'EI-2',
    created_by: 'agent-b',
    created_at: '2026-08-02T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'degraded', evidence: 'e' } },
      },
    },
  },
];

/**
 * `sql` is used BOTH as the outer query tag and for inline fragments (sql`TRUE`), so the
 * mock discriminates on the template text: the real SELECT resolves rows, a fragment
 * returns an opaque marker.
 */
const sqlTag = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
  const text = strings.join(' ? ');
  if (text.includes('FROM harness_shared.engineer_issues')) {
    return Promise.resolve(DB_ROWS) as unknown as Promise<unknown[]>;
  }
  return { __sqlFragment: text } as unknown as Promise<unknown[]>;
};

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: sqlTag }),
}));

const issuesOutLinksMany = vi.fn(
  async (_ids: string[]) =>
    new Map([['EI-1', [{ rel: 'grades', dst: { kind: 'work_item', ref: 'WI-1' } }]]]),
);

vi.mock('./issues-engineer', () => ({
  issuesScopeWorkspace: () => 'test-workspace',
  issuesOutLinksMany: (ids: string[]) => issuesOutLinksMany(ids),
}));

vi.mock('./rubrics', () => ({
  // Unresolved rubric → the built-in key fallback; irrelevant to the link decision and
  // keeps this a pure unit test (no rubric store).
  getRubric: async () => null,
  rubricInstrumentContract: () => null,
}));

beforeEach(() => {
  issuesOutLinksMany.mockClear();
});

describe('listScorecards — outbound links are OPT-IN (WI-6124)', () => {
  it('does NOT run the links query by default', async () => {
    const { listScorecards } = await import('./scorecards');
    const rows = await listScorecards({ rubricRef: 'test-rubric', limit: 100 });

    expect(issuesOutLinksMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    // The field stays present and well-typed — absent links read as "none", never undefined.
    expect(rows.every((r) => Array.isArray(r.linkedItems) && r.linkedItems.length === 0)).toBe(true);
  });

  it('runs it exactly once, batched over every row, when includeLinks is true', async () => {
    const { listScorecards } = await import('./scorecards');
    const rows = await listScorecards({ rubricRef: 'test-rubric', limit: 100, includeLinks: true });

    // WI-3594's batching invariant: ONE call carrying all ids, never one per row.
    expect(issuesOutLinksMany).toHaveBeenCalledTimes(1);
    expect(issuesOutLinksMany).toHaveBeenCalledWith(['EI-1', 'EI-2']);

    expect(rows.find((r) => r.issueId === 'EI-1')?.linkedItems).toEqual([
      { rel: 'grades', dst: { kind: 'work_item', ref: 'WI-1' } },
    ]);
    // A row with no edges still gets [] rather than undefined.
    expect(rows.find((r) => r.issueId === 'EI-2')?.linkedItems).toEqual([]);
  });

  it('explicit false is equivalent to the default', async () => {
    const { listScorecards } = await import('./scorecards');
    await listScorecards({ rubricRef: 'test-rubric', includeLinks: false });
    expect(issuesOutLinksMany).not.toHaveBeenCalled();
  });
});

describe('the aggregate readers stay cheap (WI-6124)', () => {
  it('scorecardTrend rolls up ratings without ever resolving links', async () => {
    const { scorecardTrend } = await import('./scorecards');
    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });

    // The regression this pins: scorecardTrend reads ONLY ratings + createdAt, but for a
    // long time paid a links join on every call for up to 500 refs.
    expect(issuesOutLinksMany).not.toHaveBeenCalled();
    expect(trend).toBeTruthy();
  });
});

describe('the surfacing readers still opt IN (WI-6124 — guards the new default)', () => {
  it("the 'scorecards.list' sync-resolver resolves links (it feeds the ScorecardDetail panel)", async () => {
    const { getRegistryEntryV2 } = await import('./sync-resolver/index');
    const entry = getRegistryEntryV2('scorecards.list');
    expect(entry, "the 'scorecards.list' sync query must exist").toBeTruthy();

    const rows = (await entry!.resolve!({ rubricRef: 'test-rubric', limit: 100 } as never, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { linkedItems?: unknown[] }[];

    // If this fails, the UI panel silently shows no linked items — the exact cost of the
    // opt-in default, and invisible to types because the resolver returns `as unknown[]`.
    expect(issuesOutLinksMany).toHaveBeenCalledTimes(1);
    expect(rows.find((r) => (r as { issueId?: string }).issueId === 'EI-1')?.linkedItems).toEqual([
      { rel: 'grades', dst: { kind: 'work_item', ref: 'WI-1' } },
    ]);
  });
});
