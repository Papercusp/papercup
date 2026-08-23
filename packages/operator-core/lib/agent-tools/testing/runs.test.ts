/**
 * testing:runs — plan sql-escape-tool-routing-2026-08-12 P-004.
 *
 * The matcher shapes and the saturation classifier are the parts that decide
 * whether a caller gets the right ROWS; the SQL around them is exercised
 * against the live table during development. The classifier's NULL case is the
 * one with a documented failure mode, so it is asserted directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultRollupSource, isSaturationSuspect, toPathPattern, toShaPattern } from './runs';
import runsTool from './runs';
import { CRITICAL_P95_MS } from '../../event-loop-lag-monitor';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

/** Render the SQL text carried by postgres.js tagged fragments in the mock. */
function renderSqlFragment(fragment: unknown): string {
  if (!fragment || typeof fragment !== 'object') return '';
  const value = fragment as { strings?: unknown[]; args?: unknown[]; values?: unknown[] };
  if (!Array.isArray(value.strings)) return '';
  const args = value.args ?? value.values ?? [];
  return value.strings
    .map((part, index) => `${String(part)}${renderSqlFragment(args[index])}`)
    .join('');
}

describe('toPathPattern', () => {
  it('matches a memorable path FRAGMENT as a substring — the corpus shape', () => {
    // Corpus: WHERE file_path LIKE '%release-submodule-freshness-fail-closed%'
    expect(toPathPattern('release-submodule-freshness')).toBe('%release-submodule-freshness%');
  });

  it('escapes LIKE metacharacters while keeping the fragment a substring', () => {
    expect(toPathPattern('sync/hyperbee/__tests__')).toBe('%sync/hyperbee/\\_\\_tests\\_\\_%');
    expect(toPathPattern('packages/%/lib/x.test.ts')).toBe('%packages/\\%/lib/x.test.ts%');
  });

  it('escapes a literal backslash before wrapping', () => {
    expect(toPathPattern('dir\\name%part')).toBe('%dir\\\\name\\%part%');
  });
});

describe('toShaPattern', () => {
  it('treats a short sha as a PREFIX — the column holds the full 40 chars', () => {
    // Corpus: WHERE commit_sha LIKE '362398846fd2%'
    expect(toShaPattern('362398846fd2')).toBe('362398846fd2%');
  });

  it('honours an explicit pattern verbatim', () => {
    expect(toShaPattern('%362398%')).toBe('%362398%');
  });
});

describe('defaultRollupSource', () => {
  it('isolates commit rollups to CI rows by default', () => {
    expect(defaultRollupSource('commit')).toBe('ci');
  });

  it('honors an explicit source for commit rollups', () => {
    expect(defaultRollupSource('commit', 'local')).toBe('local');
    expect(defaultRollupSource('commit', 'admin-ui')).toBe('admin-ui');
  });

  it('leaves non-commit rollups unscoped when no source is named', () => {
    expect(defaultRollupSource('runGroup')).toBeNull();
    expect(defaultRollupSource(undefined)).toBeNull();
  });
});

describe('testing:runs rollup source isolation', () => {
  const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

  beforeEach(() => {
    sqlCalls.length = 0;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      sqlCalls.push(call);
      if (call.strings.some((part) => part.includes('WITH filtered'))) {
        return Promise.resolve([
          {
            key: 'abc123',
            total: '1',
            failed: '0',
            failed_files: '0',
            files: '1',
            first_start: '2026-08-14T13:14:24.555Z',
            last_finish: '2026-08-14T13:14:24.563Z',
            group_count: '1',
          },
        ]);
      }
      return call;
    });
  });

  it('passes source:ci into an omitted-source commit rollup and reports it', async () => {
    const result = (await runsTool.handler({ commitSha: 'abc123', rollup: 'commit' } as never, {} as never)) as {
      data?: { source?: string; groups?: Array<{ failed: number }> };
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    const whereCall = sqlCalls.find((call) => call.strings.some((part) => part.includes('file_path')));

    expect(JSON.stringify(whereCall)).toContain('ci');
    expect(data).toMatchObject({ source: 'ci', groups: [{ failed: 0 }] });
  });

  it('collapses a superseded fail before aggregating a commit rollup', async () => {
    const result = (await runsTool.handler({ commitSha: 'abc123', rollup: 'commit' } as never, {} as never)) as {
      data?: { latestPerFile?: boolean; groups?: Array<{ failed: number; failedFiles: number }> };
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    const rollupCall = sqlCalls.find((call) => call.strings.some((part) => part.includes('WITH filtered')));
    const queryText = rollupCall ? renderSqlFragment({ strings: rollupCall.strings, args: rollupCall.values }) : '';

    // The fixture returned by this mock represents a file whose older fail was
    // superseded by a newer pass. The query must explicitly select the latest
    // row per rollup key + file before counting red statuses; otherwise the
    // pre-fix aggregate would report failed=1/failedFiles=1.
    expect(queryText).toContain('DISTINCT ON (');
    expect(queryText).toContain('latest_rows');
    expect(data).toMatchObject({ latestPerFile: true, groups: [{ failed: 0, failedFiles: 0 }] });
    expect(data).not.toHaveProperty('notRecorded');
    expect(data).not.toHaveProperty('reason');
  });
});

describe('testing:runs empty results', () => {
  beforeEach(() => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      if (call.strings.some((part) => part.includes('WITH filtered'))) return Promise.resolve([]);
      return call;
    });
  });

  it('marks an empty row list as not recorded instead of a clean result', async () => {
    const result = (await runsTool.handler({ filePath: 'missing.test.ts', sinceHours: 1 } as never, {} as never)) as {
      data?: Record<string, unknown>;
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');

    expect(data).toMatchObject({
      count: 0,
      total: 0,
      truncatedByLimit: false,
      latestPerFile: false,
      runs: [],
      notRecorded: true,
      reason: 'no_runs_recorded',
    });
  });

  it('marks an empty rollup as not recorded instead of a zero-failure verdict', async () => {
    const result = (await runsTool.handler({ commitSha: 'missing', rollup: 'commit' } as never, {} as never)) as {
      data?: Record<string, unknown>;
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');

    expect(data).toMatchObject({
      rollup: 'commit',
      source: 'ci',
      latestPerFile: true,
      count: 0,
      total: 0,
      truncatedByLimit: false,
      groups: [],
      notRecorded: true,
      reason: 'no_runs_recorded',
    });
  });
});

describe('testing:runs filePath matching', () => {
  const filePathSqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

  it('uses the escaped literal substring pattern and declares its LIKE escape character', async () => {
    filePathSqlCalls.length = 0;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      filePathSqlCalls.push(call);
      // The handler only needs an empty result for this SQL-construction test;
      // the nested `where` fragment remains available for inspection below.
      if (call.strings.some((part) => part.includes('WITH filtered'))) return Promise.resolve([]);
      return call;
    });

    await runsTool.handler({ filePath: 'sync/hyperbee/__tests__', limit: 1 } as never, {} as never);

    const whereCall = filePathSqlCalls.find((call) => call.strings.some((part) => part.includes('file_path ILIKE')));
    expect(whereCall).toBeDefined();
    expect(whereCall?.values).toContain('%sync/hyperbee/\\_\\_tests\\_\\_%');
    expect(renderSqlFragment({ strings: whereCall?.strings ?? [], args: whereCall?.values ?? [] })).toContain(
      "file_path ILIKE ",
    );
    expect(renderSqlFragment({ strings: whereCall?.strings ?? [], args: whereCall?.values ?? [] })).toContain(
      "ESCAPE '\\'",
    );
  });
});

describe('isSaturationSuspect', () => {
  it('does NOT treat a NULL lag sample as suspect', () => {
    // The column comment is emphatic: NULL means no monitor was running on
    // that process — it is NOT a claim the host was calm. Treating NULL as
    // suspect would quietly mark most historical rows unreliable and give
    // every red an excuse, which is the "blame high load" failure inverted.
    expect(isSaturationSuspect(null)).toBe(false);
  });

  it('flags a sample at or past the critical band', () => {
    expect(isSaturationSuspect(CRITICAL_P95_MS)).toBe(true);
    expect(isSaturationSuspect(CRITICAL_P95_MS + 500)).toBe(true);
  });

  it('leaves a calm sample unflagged', () => {
    // Real observed values on this box sit around 20-25ms.
    expect(isSaturationSuspect(25)).toBe(false);
    expect(isSaturationSuspect(CRITICAL_P95_MS - 1)).toBe(false);
  });

  it('classifies against the monitor’s own tunable, not a hardcoded 600', () => {
    // Guards the drift this import exists to prevent: if the monitor's band
    // moves (PAPERCUSP_LOOP_CRITICAL_MS), the ledger reader must move with it.
    // A control value derived from the constant cannot pass against a
    // hardcoded threshold unless the two agree.
    expect(CRITICAL_P95_MS).toBeGreaterThan(0);
    expect(isSaturationSuspect(CRITICAL_P95_MS - 0.5)).toBe(false);
    expect(isSaturationSuspect(CRITICAL_P95_MS + 0.5)).toBe(true);
  });
});
