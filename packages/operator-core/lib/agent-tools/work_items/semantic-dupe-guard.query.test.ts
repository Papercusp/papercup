/**
 * The real semantic-dupe query must opt into pgvector's iterative scan.
 * Without it, a selective post-filter can exhaust hnsw.ef_search before it
 * finds an eligible row and the caller reads NULL as "no candidate".
 */
import { describe, expect, it, vi } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { resolveProseProfileSelection } from '../../search/prose-vector-dims';

const mocks = vi.hoisted(() => {
  const sql = vi.fn(async () => [
    {
      id: 'EI-1',
      title: 'candidate',
      state: 'open',
      harness_slug: 'papercusp',
      similarity: 0.91,
      title_similarity: 0.51,
    },
  ]);
  Object.assign(sql, { unsafe: vi.fn((value: string) => value) });
  const withIterativeScan = vi.fn(
    async (_handle: unknown, body: (handle: unknown) => Promise<unknown>) => body(sql),
  );
  return { sql, withIterativeScan };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));
vi.mock('../search/hnsw-iterative-scan', () => ({
  withIterativeScan: mocks.withIterativeScan,
}));

import { queryCandidatesReal } from './semantic-dupe-guard';

describe('semantic-dupe-guard real ANN query', () => {
  it('runs the selective work_items query through the iterative-scan wrapper', async () => {
    const result = await queryCandidatesReal(
      [0.1, 0.2],
      'gemma',
      'papercusp',
      'new title',
      resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!,
    );

    expect(mocks.withIterativeScan).toHaveBeenCalledTimes(1);
    expect(mocks.withIterativeScan).toHaveBeenCalledWith(mocks.sql, expect.any(Function));
    // postgres.js invokes the same transaction-scoped tag for the main query
    // and each interpolated fragment; all invocations must use that handle.
    expect(mocks.sql.mock.calls.length).toBeGreaterThan(0);
    expect(result).toEqual([
      {
        id: 'EI-1',
        title: 'candidate',
        state: 'open',
        harness: 'papercusp',
        similarity: 0.91,
        titleSimilarity: 0.51,
      },
    ]);
  });
});
