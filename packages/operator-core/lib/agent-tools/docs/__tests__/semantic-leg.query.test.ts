/**
 * The real doc_sections query must run through pgvector's iterative scan.
 *
 * doc_sections holds every docs surface in ONE table, so the semantic leg's
 * read is a FILTERED nearest-neighbour query (`WHERE source_key = …`). When the
 * planner picks the HNSW index, a non-iterative scan stops after
 * hnsw.ef_search (40) whole-table candidates and filters afterwards, so a small
 * surface beside a big one gets 0-1 rows back and docs:search silently returns
 * long docs without their matching section. Measured 2026-09-30 on
 * harness:papercusp (1,425 of ~18.7K rows): the engine's LIMIT 72 read
 * returned 1 row without iterative scan and 72 with it; a live 10-doc battery
 * went from 4/10 to 10/10 docs returned with their section
 * (generic-rag-chunking-2026-09-29 P-013, R-29).
 *
 * The planner only picks HNSW on a large mixed table, which no fixture DB
 * reproduces, so the guard is here: the query must be issued on the
 * transaction-scoped handle `withIterativeScan` hands its body. The mock hands
 * the body a DIFFERENT handle from the pool's, so a query that bypasses the
 * wrapper (or runs on the outer handle inside it) is caught, not just a
 * missing wrapper call.
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const row = {
    slug: 'docs/long-report',
    anchor: 'findings~3',
    title: 'Long report',
    url: '/docs/long-report#findings',
    excerpt: 'past the cut',
    similarity: '0.61',
  };
  // The pool handle getOrgPg returns: must never issue the query itself.
  const poolSql = vi.fn(async () => [row]);
  // The transaction handle withIterativeScan hands its body.
  const txSql = vi.fn(async () => [row]);
  const withIterativeScan = vi.fn(
    async (_handle: unknown, body: (handle: unknown) => Promise<unknown>) => body(txSql),
  );
  return { poolSql, txSql, withIterativeScan };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.poolSql }),
}));
vi.mock('@papercusp/search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/search')>()),
  withIterativeScan: mocks.withIterativeScan,
}));

import { realDocSemanticDeps } from '../semantic-leg';

const GEMMA = { profileId: 'gemma-embeddinggemma-300m-768@v1', legacyMode: 'gemma' };

describe('docs semantic leg: real doc_sections query', () => {
  it('issues the filtered vector query on the iterative-scan transaction handle', async () => {
    const rows = await realDocSemanticDeps.querySections([0.1, 0.2], 'gemma', 'harness:papercusp', 72, GEMMA);

    expect(mocks.withIterativeScan).toHaveBeenCalledTimes(1);
    expect(mocks.withIterativeScan).toHaveBeenCalledWith(mocks.poolSql, expect.any(Function));
    expect(mocks.txSql).toHaveBeenCalledTimes(1);
    expect(mocks.poolSql).not.toHaveBeenCalled();
    // The query that ran is the source-filtered, distance-ordered read.
    const [strings, ...values] = mocks.txSql.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const text = strings.join('?');
    expect(text).toMatch(/FROM harness_shared\.doc_sections/);
    expect(text).toMatch(/WHERE source_key = \?/);
    expect(text).toMatch(/ORDER BY embedding <=> \?::vector/);
    expect(values).toContain('harness:papercusp');
    expect(values).toContain(72);
    // Rows keep their mapping: continuation-chunk anchors report their heading.
    expect(rows).toEqual([
      {
        slug: 'docs/long-report',
        anchor: 'findings',
        title: 'Long report',
        url: '/docs/long-report#findings',
        excerpt: 'past the cut',
        similarity: 0.61,
      },
    ]);
  });

  it('control: an unaccepted profile issues no query at all', async () => {
    mocks.withIterativeScan.mockClear();
    mocks.txSql.mockClear();
    const rows = await realDocSemanticDeps.querySections([0.1], 'gemma', 'harness:papercusp', 72, {
      profileId: 'not-a-profile@v0',
      legacyMode: null,
    });
    expect(rows).toEqual([]);
    expect(mocks.withIterativeScan).not.toHaveBeenCalled();
    expect(mocks.txSql).not.toHaveBeenCalled();
  });
});
