import { describe, expect, it } from 'vitest';
import { computeFacets, type CompanionListSummary, type FacetDef, type FacetSelection } from '@papercusp/facets';
import {
  assertCompanionPredicateParity,
  assertPairConvergesAfterInvalidation,
  seedCorpusBeyondCap,
  type CompanionPredicateParityProbe,
} from './count-contract-testkit';

interface Row {
  id: string;
  state: 'open' | 'done';
  kind: 'bug' | 'change';
  target: boolean;
}

interface Args {
  states: string[];
  kinds: string[];
  targetOnly?: boolean;
  impossible?: boolean;
}

const PAGE_CAP = 3;
const seeded = seedCorpusBeyondCap<Row>({
  pageCap: PAGE_CAP,
  makeRow: (index) => ({
    id: `r${index}`,
    state: index % 2 === 0 ? 'open' : 'done',
    kind: index % 3 === 0 ? 'bug' : 'change',
    target: false,
  }),
  makeBeyondPageRow: (index) => ({ id: `r${index}`, state: 'open', kind: 'bug', target: true }),
});

const defs: readonly FacetDef<Row>[] = [
  { key: 'state', extract: (row) => row.state },
  { key: 'kind', extract: (row) => row.kind },
];

const selection = (args: Args): FacetSelection =>
  new Map([
    ['state', new Set(args.states)],
    ['kind', new Set(args.kinds)],
  ]);

const predicate = (row: Row, args: Args): boolean =>
  !args.impossible &&
  (!args.targetOnly || row.target) &&
  (args.states.length === 0 || args.states.includes(row.state)) &&
  (args.kinds.length === 0 || args.kinds.includes(row.kind));

function summaryFor(args: Args, corpus: readonly Row[] = seeded.rows): CompanionListSummary {
  return {
    total: corpus.length,
    matched: corpus.filter((row) => predicate(row, args)).length,
    facets: computeFacets(corpus, defs, { minDistinctValues: 1, selection: selection(args) }),
  };
}

type BrokenMode = 'none' | 'filter-after-cap' | 'page-facets' | 'missing-zero' | 'repeated-cursor';

function probe(mode: BrokenMode = 'none'): CompanionPredicateParityProbe<Row, Args> {
  const args: Args = { states: ['open'], kinds: ['bug'], targetOnly: true };
  return {
    corpus: seeded.rows,
    pageCap: PAGE_CAP,
    args,
    zeroMatchArgs: { states: [], kinds: [], impossible: true },
    beyondPageRowId: seeded.beyondPageRow.id,
    rowId: (row) => row.id,
    predicate,
    facetDefs: defs,
    selection,
    readPage: async (pageArgs, cursor) => {
      const start = cursor == null ? 0 : Number(cursor);
      const source =
        mode === 'filter-after-cap'
          ? seeded.rows.slice(0, PAGE_CAP).filter((row) => predicate(row, pageArgs))
          : seeded.rows.filter((row) => predicate(row, pageArgs));
      const rows = source.slice(start, start + PAGE_CAP);
      const hasMore = mode === 'repeated-cursor' ? true : start + rows.length < source.length;
      return {
        rows,
        hasMore,
        nextCursor: hasMore ? (mode === 'repeated-cursor' ? (cursor ?? '0') : String(start + rows.length)) : null,
      };
    },
    readSummary: async (summaryArgs) => {
      if (mode === 'missing-zero' && summaryArgs.impossible) {
        return undefined as unknown as CompanionListSummary;
      }
      if (mode === 'page-facets') {
        const full = summaryFor(summaryArgs);
        return { ...full, facets: summaryFor(summaryArgs, seeded.rows.slice(0, PAGE_CAP)).facets };
      }
      return summaryFor(summaryArgs);
    },
  };
}

describe('count-contract testkit', () => {
  it('seeds the distinguished match strictly beyond the configured page cap', () => {
    expect(seeded.rows).toHaveLength(PAGE_CAP + 2);
    expect(seeded.rows.indexOf(seeded.beyondPageRow)).toBeGreaterThanOrEqual(PAGE_CAP);
  });

  it('accepts one normalized predicate shared by rows, totals, and drill-down facets', async () => {
    await expect(assertCompanionPredicateParity(probe())).resolves.toBeUndefined();
  });

  it.each([
    ['a match exists only beyond page one', 'filter-after-cap'],
    ['facet counts describe only loaded rows', 'page-facets'],
    ['a zero-row result loses its summary/reset path', 'missing-zero'],
    ['pagination repeats a cursor while claiming more', 'repeated-cursor'],
  ] as const)('bites when %s', async (_label, mode) => {
    await expect(assertCompanionPredicateParity(probe(mode))).rejects.toThrow(/companion count contract/);
  });

  it('accepts adjacent snapshots only when one paired invalidation converges them', async () => {
    let rows = [{ id: 'a' }];
    let summary: CompanionListSummary = { total: 1, matched: 1, facets: [] };
    await expect(
      assertPairConvergesAfterInvalidation({
        readRowsBeforeWrite: async () => rows,
        writeBetweenQueries: async () => {
          summary = { total: 2, matched: 2, facets: [] };
        },
        readRacedSummary: async () => summary,
        refetchPairAfterInvalidation: async () => {
          rows = [{ id: 'a' }, { id: 'b' }];
          return { rows, summary };
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('bites when paired rows and summary do not converge after invalidation', async () => {
    await expect(
      assertPairConvergesAfterInvalidation({
        readRowsBeforeWrite: async () => [{ id: 'a' }],
        writeBetweenQueries: async () => {},
        readRacedSummary: async () => ({ total: 2, matched: 2, facets: [] }),
        refetchPairAfterInvalidation: async () => ({
          rows: [{ id: 'a' }],
          summary: { total: 2, matched: 2, facets: [] },
        }),
      }),
    ).rejects.toThrow(/did not converge/);
  });
});
