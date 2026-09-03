import { beforeEach, describe, expect, it, vi } from 'vitest';

// projectFeatureCounts (WI-5383: migrated off getLegacyClient) now reads via
// harnessQuery — mock it explicitly, or the REAL implementation runs here and
// tries to reach live Postgres, which this unit test environment has none of.
// Mirrors the mockHarnessQuerySequence idiom in harness-core-parse-features.test.ts,
// adapted for this function's single `?` -> `$1` positional param.
const dbMocks = vi.hoisted(() => ({
  harnessQuery: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  harnessQuery: dbMocks.harnessQuery,
}));

import { projectFeatureCounts } from './projects-data';

describe('projectFeatureCounts', () => {
  const unsafe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // harnessQuery's callback receives a postgres.js-shaped `sql` handle;
    // projectFeatureCounts only calls `.unsafe(text, params)` on it, so a fake
    // exposing just that method is enough to observe what was sent.
    dbMocks.harnessQuery.mockImplementation(async (_slug: string, fn: any) => fn({ unsafe }));
  });

  it('groups by status, coercing bigint counts, and rolls up total', async () => {
    unsafe.mockResolvedValueOnce([
      { status: 'passed', n: 3n },
      { status: 'todo', n: 2 },
      { status: 'blocked', n: 1n },
    ]);

    const counts = await projectFeatureCounts('h1', 'proj-1');

    expect(dbMocks.harnessQuery).toHaveBeenCalledWith('h1', expect.any(Function));
    const sql = String(unsafe.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
    expect(sql).toContain('FROM harness_features WHERE project_id = $1 GROUP BY status');
    // Direct-mode regression: the same single positional bind the old
    // `.prepare(...).all(projectId)` (`?` placeholder) sent.
    expect(unsafe.mock.calls[0]?.[1]).toEqual(['proj-1']);
    expect(counts).toEqual({
      todo: 2,
      in_progress: 0,
      validating: 0,
      failing: 0,
      blocked: 1,
      passed: 3,
      rejected: 0,
      total: 6,
    });
  });

  it('ignores an unrecognized status for the per-status bucket but still counts it in total', async () => {
    unsafe.mockResolvedValueOnce([{ status: 'some_future_status', n: 4n }]);

    const counts = await projectFeatureCounts('h1', 'proj-1');

    expect(counts.total).toBe(4);
    expect(counts).not.toHaveProperty('some_future_status');
  });

  it('swallows a query failure and returns all-zero counts (behavior unchanged from the getLegacyClient path)', async () => {
    unsafe.mockRejectedValueOnce(new Error('boom'));

    const counts = await projectFeatureCounts('h1', 'proj-1');

    expect(counts).toEqual({
      todo: 0,
      in_progress: 0,
      validating: 0,
      failing: 0,
      blocked: 0,
      passed: 0,
      rejected: 0,
      total: 0,
    });
  });
});
