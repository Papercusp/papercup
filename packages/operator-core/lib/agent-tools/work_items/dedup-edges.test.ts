/**
 * dedup-edges.test — `buildDedupEdgeRows`' filtering contract, which is the whole
 * reason this module exists as its own file rather than an inline block in
 * `_create-core`: `harness_shared.dedup_edges.cos` carries ONE metric (cosine in the
 * migration-548 space) and the P-001 census counts pairs off it, so a lexical Jaccard
 * or pg_trgm score written into that column would not read as a bad edge — it would
 * read as a REAL one, and silently move the corpus metric the plan is measured by.
 *
 * The cosine-only rule therefore gets a permanently-in-tree falsifiability control:
 * `buildRowsAcceptingEverything` below is a deliberately-wrong implementation of the
 * same function, kept here so "the assertions can fail" is a fact this file proves on
 * every run rather than a claim (repo discipline: prove a guard is falsifiable without
 * mutating the shared tree). If the real builder ever starts admitting lexical
 * candidates, its assertions and the control's converge — which is exactly the
 * regression the control is watching for.
 */
import { describe, expect, it } from 'vitest';
import { buildDedupEdgeRows, DEDUP_EDGE_FLOOR, PRESCREEN_RUN_ID, type DedupEdgeCandidate } from './dedup-edges';

const base = { itemId: 'WI-500', harness: 'papercusp', workspaceId: 'default' };

const cosine = (id: string, similarity: number, extra: Partial<DedupEdgeCandidate> = {}): DedupEdgeCandidate => ({
  id,
  harness: 'papercusp',
  similarity,
  ...extra,
});

/** DELIBERATELY WRONG control: the naive "persist every candidate" builder this
 *  module exists to not be. Never used by production code. */
function buildRowsAcceptingEverything(candidates: readonly DedupEdgeCandidate[]): { a: string; b: string }[] {
  return candidates.map((c) => (base.itemId < c.id ? { a: base.itemId, b: c.id } : { a: c.id, b: base.itemId }));
}

describe('buildDedupEdgeRows', () => {
  it('keeps a cosine candidate at/above the floor, ordered a < b, with the prescreen run id', () => {
    const rows = buildDedupEdgeRows({ ...base, candidates: [cosine('WI-100', 0.91, { titleSimilarity: 0.42 })] });
    expect(rows).toEqual([
      {
        workspace_id: 'default',
        harness_slug: 'papercusp',
        a: 'WI-100',
        b: 'WI-500',
        cos: 0.91,
        trgm: 0.42,
        run_id: PRESCREEN_RUN_ID,
      },
    ]);
  });

  it('DROPS both lexical legs — their scores are not cosine and would corrupt the census', () => {
    const candidates = [
      cosine('WI-100', 0.97, { source: 'lexical-recent' }),
      cosine('WI-101', 0.99, { source: 'lexical-fulltext' }),
    ];
    expect(buildDedupEdgeRows({ ...base, candidates })).toEqual([]);
    // CONTROL: the naive builder keeps them — so an empty result above is this
    // module's filter working, not an inert test.
    expect(buildRowsAcceptingEverything(candidates)).toHaveLength(2);
  });

  it('drops a candidate below the table floor, keeps one exactly at it', () => {
    expect(buildDedupEdgeRows({ ...base, candidates: [cosine('WI-100', DEDUP_EDGE_FLOOR - 0.01)] })).toEqual([]);
    expect(buildDedupEdgeRows({ ...base, candidates: [cosine('WI-100', DEDUP_EDGE_FLOOR)] })).toHaveLength(1);
  });

  it('drops a cross-harness candidate (the table is harness-scoped) but keeps a harness-less one', () => {
    expect(
      buildDedupEdgeRows({ ...base, candidates: [cosine('WI-100', 0.95, { harness: 'other-pot' })] }),
    ).toEqual([]);
    expect(buildDedupEdgeRows({ ...base, candidates: [cosine('WI-100', 0.95, { harness: null })] })).toHaveLength(1);
  });

  it('drops a self-edge and de-duplicates a repeated pair (the PK would reject both)', () => {
    const rows = buildDedupEdgeRows({
      ...base,
      candidates: [cosine('WI-500', 0.99), cosine('WI-100', 0.95), cosine('WI-100', 0.88)],
    });
    expect(rows.map((r) => [r.a, r.b])).toEqual([['WI-100', 'WI-500']]);
    expect(rows[0].cos).toBe(0.95);
  });

  it('writes nothing without a workspace (the column is NOT NULL) or without candidates', () => {
    expect(buildDedupEdgeRows({ ...base, workspaceId: undefined, candidates: [cosine('WI-100', 0.95)] })).toEqual([]);
    expect(buildDedupEdgeRows({ ...base, candidates: undefined })).toEqual([]);
    expect(buildDedupEdgeRows({ ...base, candidates: [] })).toEqual([]);
  });

  it('leaves trgm NULL when the guard supplied no title similarity', () => {
    const rows = buildDedupEdgeRows({ ...base, candidates: [cosine('WI-100', 0.95)] });
    expect(rows[0].trgm).toBeNull();
  });

  it('honours an explicit runId (a census run reusing this builder)', () => {
    const rows = buildDedupEdgeRows({ ...base, candidates: [cosine('WI-100', 0.95)], runId: 'census-7' });
    expect(rows[0].run_id).toBe('census-7');
  });
});
