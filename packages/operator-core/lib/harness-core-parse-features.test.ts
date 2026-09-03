import { beforeEach, describe, expect, it, vi } from 'vitest';

// parseFeatures (WI-5383: migrated off getLegacyClient) now reads via
// harnessQuery — mock it explicitly, or the REAL implementation runs here
// (spread from the original module) and tries to reach live Postgres, which
// this unit test environment has none of. Mirrors the mockHarnessQuerySequence
// idiom in harness-feature-approve.test.ts, adapted for the `sql.unsafe(text,
// params)` shape parseFeatures uses (a single positional `$1` param) rather
// than a tagged-template call.
const dbMocks = vi.hoisted(() => ({
  harnessQuery: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  harnessQuery: dbMocks.harnessQuery,
}));

import { parseFeatures, STREAM_FEATURE_SELECT_COLUMNS } from './harness-core';

describe('parseFeatures projections', () => {
  const unsafe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    unsafe.mockResolvedValue([]);
    // harnessQuery's callback receives a postgres.js-shaped `sql` handle;
    // parseFeatures only calls `.unsafe(text, params)` on it, so a fake
    // exposing just that method is enough to observe what was sent.
    dbMocks.harnessQuery.mockImplementation(async (_slug: string, fn: any) => fn({ unsafe }));
  });

  it('uses the bounded Run-view column set for the stream projection', async () => {
    await parseFeatures(
      { slug: 'large-harness' } as never,
      { projection: 'stream' },
    );

    expect(dbMocks.harnessQuery).toHaveBeenCalledWith('large-harness', expect.any(Function));
    const sql = String(unsafe.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
    expect(sql).toContain(`SELECT ${STREAM_FEATURE_SELECT_COLUMNS} FROM harness_features`);
    expect(sql).not.toContain('SELECT *');
    expect(sql).toContain('WHERE harness_slug = $1');
    // Direct-mode regression: the same single positional bind that the old
    // `.prepare(...).all(project.slug)` (`?` placeholder) sent — proving the
    // `?` -> `$1` translation preserved both the parameter and its binding,
    // not just the SQL text.
    expect(unsafe.mock.calls[0]?.[1]).toEqual(['large-harness']);
  });

  it('preserves the full-row default for existing callers', async () => {
    await parseFeatures({ slug: 'ordinary-harness' } as never);

    const sql = String(unsafe.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
    expect(sql).toContain('SELECT * FROM harness_features');
    expect(unsafe.mock.calls[0]?.[1]).toEqual(['ordinary-harness']);
  });

  it('swallows a query failure and returns [] (behavior unchanged from the getLegacyClient path)', async () => {
    unsafe.mockRejectedValueOnce(new Error('boom'));

    const rows = await parseFeatures({ slug: 'broken-harness' } as never);

    expect(rows).toEqual([]);
  });
});
