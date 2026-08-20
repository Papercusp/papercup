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

describe('toPathPattern', () => {
  it('matches a memorable path FRAGMENT as a substring — the corpus shape', () => {
    // Corpus: WHERE file_path LIKE '%release-submodule-freshness-fail-closed%'
    expect(toPathPattern('release-submodule-freshness')).toBe('%release-submodule-freshness%');
  });

  it('honours an explicit pattern verbatim', () => {
    expect(toPathPattern('packages/%/lib/x.test.ts')).toBe('packages/%/lib/x.test.ts');
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
