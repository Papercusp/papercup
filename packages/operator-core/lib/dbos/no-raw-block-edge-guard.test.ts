/**
 * no-raw-block-edge-guard.test.ts — the no-raw-blocks-edge CI guard's detection
 * predicate (work-item-dependency-edges-2026-08-02, P-007 / D-013).
 *
 * The guard (`scripts/check-no-raw-block-edge.mjs`) runs green on the clean tree,
 * which only exercises the no-false-positive direction. A guard nobody has ever
 * seen FAIL is not a guard, so this locks the direction P-007 actually asks for:
 * that it FLAGS a NEW feature→feature `blocks` edge write which bypasses the
 * acyclicity policy, while NOT flagging reads, sanctioned writes, or prose.
 *
 * Why it matters: a feature→feature `blocks` CYCLE permanently deadlocks the
 * dispatch frontier — every feature in the cycle is forever non-ready because its
 * blocker never terminates. The behaviour tests
 * (feature-blockers-acyclicity{,.integration}.test.ts) cover the policy functions
 * thoroughly, but cannot observe a call site that never calls them; that is the
 * gap this guard closes and this test verifies.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { writesRawBlocksEdge } from '../../../../scripts/check-no-raw-block-edge.mjs';

describe('no-raw-block-edge guard predicate (P-007 / D-013)', () => {
  describe('FLAGS a bypassing write — the direction the guard exists for', () => {
    it('flags a raw INSERT INTO coord_links carrying a blocks rel', () => {
      expect(
        writesRawBlocksEdge(
          "await sql`INSERT INTO harness_shared.coord_links (workspace_id, rel) VALUES ('default', 'blocks')`;",
        ),
      ).toBe(true);
    });

    it('flags a linkWorkItem(...) call with a blocks rel', () => {
      expect(writesRawBlocksEdge("await linkWorkItem(id, dst, 'blocks', { harness });")).toBe(true);
    });

    it('flags a MULTI-LINE linkWorkItem call — a reformat must not defeat it', () => {
      expect(
        writesRawBlocksEdge(
          "await linkWorkItem(\n  item.id,\n  targetRef,\n  'blocks',\n  { harness, by },\n);",
        ),
      ).toBe(true);
    });

    it('flags regardless of quoting style', () => {
      expect(writesRawBlocksEdge('await linkWorkItem(id, dst, "blocks");')).toBe(true);
      expect(writesRawBlocksEdge('await linkWorkItem(id, dst, `blocks`);')).toBe(true);
    });
  });

  describe('does NOT flag reads — reading a blocker set cannot create a cycle', () => {
    it('ignores listIn(ref, { rel: blocks })', () => {
      expect(writesRawBlocksEdge("const edges = await listIn(ref, { rel: 'blocks' });")).toBe(false);
    });

    it('ignores listInMany(dsts, { rel: blocks }) — the live work-items-events.ts shape', () => {
      expect(writesRawBlocksEdge("const inEdges = await listInMany(dsts, { rel: 'blocks' });")).toBe(
        false,
      );
    });
  });

  describe('does NOT flag a write that APPLIES the policy', () => {
    it('clears a file routing through the authoritative writer', () => {
      expect(writesRawBlocksEdge('await syncFeatureBlockEdges(harness, featureId, blockedBy);')).toBe(
        false,
      );
    });

    it('clears a raw single-edge write guarded by guardFeatureBlockEdgeAcyclic (the link.ts shape)', () => {
      expect(
        writesRawBlocksEdge(
          "const err = await guardFeatureBlockEdgeAcyclic(srcRef.ref, dst.ref);\n" +
            "if (err) return { ok: false, error: err };\n" +
            "await linkWorkItem(it.id, dst, 'blocks', { harness });",
        ),
      ).toBe(false);
    });
  });

  describe('does NOT flag non-writes', () => {
    it('ignores prose in comments that mentions the edge', () => {
      expect(
        writesRawBlocksEdge(
          "// we INSERT INTO harness_shared.coord_links with rel='blocks' elsewhere\nconst x = 1;",
        ),
      ).toBe(false);
      expect(
        writesRawBlocksEdge(
          "/* Blocking is the uniform rel='blocks' edge; INSERT INTO harness_shared.coord_links */\nexport const K = 1;",
        ),
      ).toBe(false);
    });

    it('ignores a rel OTHER than blocks — only feature blocking deadlocks the frontier', () => {
      expect(writesRawBlocksEdge("await linkWorkItem(id, dst, 'relates', { harness });")).toBe(false);
      expect(writesRawBlocksEdge("await linkWorkItem(id, dst, 'duplicates', { harness });")).toBe(
        false,
      );
    });

    it('ignores a coord_links INSERT that carries no blocks rel at all', () => {
      expect(
        writesRawBlocksEdge(
          "await sql`INSERT INTO harness_shared.coord_links (rel) VALUES ('relates')`;",
        ),
      ).toBe(false);
    });

    it('does not let a distant unrelated blocks string arm a linkWorkItem call', () => {
      // The call itself uses 'relates'; the word 'blocks' appears in a LATER statement.
      // Bounded matching (stops at `;`) is what keeps this from being a false positive.
      expect(
        writesRawBlocksEdge(
          "await linkWorkItem(id, dst, 'relates');\nconst label = 'blocks';",
        ),
      ).toBe(false);
    });
  });
});
