import { describe, expect, it } from 'vitest';

import type { CodeSearchDeps } from './code-existence-probe';
import { screenIdeaClusters, type ScreenableIdea } from './idea-cluster-screen';
import {
  DEFAULT_COHORT,
  buildCohortQuery,
  formatScreenReport,
  loadCohort,
  makeRefStateResolver,
  type QueryRunner,
} from './screen-backlog';

/** Records every query it is handed so the predicate can be asserted. */
function fakeDb(rows: Record<string, unknown>[] = []): QueryRunner & {
  calls: { sql: string; params?: unknown[] }[];
} {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

const noCode: CodeSearchDeps = { search: async () => [] };

describe('buildCohortQuery — the predicate that prose cannot state unambiguously', () => {
  it('applies the upper date bound EXCLUSIVELY', () => {
    // "07-04→07-17" reads as either < 07-17 (157 rows) or < 07-18 (279), because
    // 07-17 alone holds a 124-item spike. The bound must be exclusive and must
    // bind `toExclusive` — not a day either side of it.
    const { sql, params } = buildCohortQuery();
    expect(sql).toContain('created_at < $3');
    expect(sql).toContain('created_at >= $2');
    expect(params[1]).toBe(DEFAULT_COHORT.fromInclusive);
    expect(params[2]).toBe(DEFAULT_COHORT.toExclusive);
  });

  it('pins the canonical cohort bound so a runner cannot drift from its own docs', () => {
    // The scratch runner had drifted to `< 2026-07-16` while the documented
    // canonical bound was `< 2026-07-17` — silently, because nothing asserted it.
    expect(DEFAULT_COHORT.fromInclusive).toBe('2026-07-04');
    expect(DEFAULT_COHORT.toExclusive).toBe('2026-07-17');
  });

  it('restricts to EI- ideas, so the screen does not also swallow WI- work-items', () => {
    // Regression: the scratch runner omitted this filter entirely.
    const { sql, params } = buildCohortQuery();
    expect(sql).toContain('issue_id LIKE $1');
    expect(params[0]).toBe('EI-%');
  });

  it('excludes the lane=observation corpus (a different, ~5,340-row population)', () => {
    expect(buildCohortQuery().sql).toContain('lane IS NULL');
  });

  it('scopes the multi-tenant table on workspace AND harness scope', () => {
    const { sql } = buildCohortQuery();
    expect(sql).toContain("workspace_id = 'papercusp-workspace'");
    expect(sql).toContain("scope = 'harness:papercusp'");
  });

  it('honours overridden bounds rather than silently using the defaults', () => {
    const { params } = buildCohortQuery({
      ...DEFAULT_COHORT,
      fromInclusive: '2026-01-01',
      toExclusive: '2026-02-01',
      limit: 7,
    });
    expect(params[1]).toBe('2026-01-01');
    expect(params[2]).toBe('2026-02-01');
    expect(params[4]).toBe(7);
  });
});

describe('loadCohort', () => {
  it('shapes rows into ScreenableIdea with title and body joined', async () => {
    const db = fakeDb([
      { issue_id: 'EI-1', title: 'A title', body: 'A body', created_at: '2026-07-05T00:00:00Z' },
    ]);
    const ideas = await loadCohort(db);
    expect(ideas).toHaveLength(1);
    expect(ideas[0].id).toBe('EI-1');
    expect(ideas[0].text).toContain('A title');
    expect(ideas[0].text).toContain('A body');
    expect(ideas[0].createdAt).toBe('2026-07-05T00:00:00.000Z');
  });
});

describe('makeRefStateResolver', () => {
  it('short-circuits on an empty id set instead of issuing `= ANY({})`', async () => {
    const db = fakeDb();
    const out = await makeRefStateResolver(db)([]);
    expect(out.size).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it('maps ids to their state', async () => {
    const db = fakeDb([{ issue_id: 'EI-9', state: 'done' }]);
    const out = await makeRefStateResolver(db)(['EI-9']);
    expect(out.get('EI-9')).toBe('done');
  });
});

describe('formatScreenReport', () => {
  /** Two ideas: one citing a DONE item (prior art), one citing nothing. */
  async function twoVerdictRows() {
    const ideas: ScreenableIdea[] = [
      {
        id: 'EI-100',
        text: 'This is already handled by EI-900 which shipped the mechanism.',
        createdAt: '2026-07-05T00:00:00.000Z',
      },
      {
        id: 'EI-101',
        text: 'A wholly unrelated proposal citing no prior work at all.',
        createdAt: '2026-07-06T00:00:00.000Z',
      },
    ];
    return screenIdeaClusters(ideas, noCode, {
      maxTerms: 8,
      resolveRefStates: async () => new Map([['EI-900', 'done']]),
    });
  }

  it('prints the coverage header at BOTH ends', async () => {
    // The header is the only thing separating "found prior art" from "a
    // retrieval reaching ~9% of items found nothing". Emitted once at the top,
    // a tail-read consumes GREENLIGHTs uncaveated as "novel" — the real defect
    // this guards (the runner shipped without it and printed 43 such rows).
    const report = formatScreenReport(await twoVerdictRows());
    const occurrences = report.split('SCREEN COVERAGE').length - 1;
    expect(occurrences).toBe(2);
    expect(report.trimStart().startsWith('SCREEN COVERAGE')).toBe(true);
    expect(report.trimEnd().endsWith('Nothing here closes anything.')).toBe(true);
  });

  it('ranks DROP above GREENLIGHT so the reviewable rows lead', async () => {
    const rows = await twoVerdictRows();
    const report = formatScreenReport(rows);
    const body = report.slice(report.indexOf('\n\n'));
    const drop = body.indexOf('EI-100');
    const green = body.indexOf('EI-101');
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(green).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(green);
  });

  it('does not lose any screened cluster from the report', async () => {
    const rows = await twoVerdictRows();
    const report = formatScreenReport(rows);
    for (const row of rows) {
      for (const id of row.memberIds) expect(report).toContain(id);
    }
  });
});
