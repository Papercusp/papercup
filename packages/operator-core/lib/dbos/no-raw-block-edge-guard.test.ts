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
import * as rawBlockEdgeGuard from '../../../../scripts/check-no-raw-block-edge.mjs';

const {
  RAW_WORK_ITEM_DEPS_CAPABILITIES,
  canonicalFacadeRoutingOffenders,
  canonicalLinkFacadeRoutingOffenders,
  usesDependencyAdmissionBypass,
  writesRawBlocksEdge,
  writesRawWorkItemDependency,
} = rawBlockEdgeGuard;

describe('no-raw-block-edge guard predicate (P-007 / D-013)', () => {
  describe('FLAGS a bypassing write — the direction the guard exists for', () => {
    it('flags a raw INSERT INTO coord_links carrying a blocks rel', () => {
      expect(
        writesRawBlocksEdge(
          "await sql`INSERT INTO harness_shared.coord_links (workspace_id, rel) VALUES ('default', 'blocks')`;",
        ),
      ).toBe(true);
    });

    it('flags a low-level links.link(...) call with a blocks rel', () => {
      expect(writesRawBlocksEdge("await links.link(src, dst, 'blocks', { created_by: by });")).toBe(true);
    });

    it('flags a MULTI-LINE low-level link call — a reformat must not defeat it', () => {
      expect(
        writesRawBlocksEdge("await links.link(\n  sourceRef,\n  targetRef,\n  'blocks',\n  { created_by: by },\n);"),
      ).toBe(true);
    });

    it('flags regardless of quoting style', () => {
      expect(writesRawBlocksEdge('await links.link(src, dst, "blocks");')).toBe(true);
      expect(writesRawBlocksEdge('await links.link(src, dst, `blocks`);')).toBe(true);
    });

    /**
     * The case that killed the first, tighter implementation of this predicate.
     * An argument-level match ("is 'blocks' inside the call's own parens?") looked
     * more precise and was measurably WORSE: the one real in-tree caller
     * (agent-tools/work_items/link.ts) passes the rel as a VARIABLE, so the tight
     * form missed the only shape that actually occurs. These lock the variable form
     * so nobody "tightens" the predicate back into that blind spot.
     */
    it('flags the VARIABLE rel form — the shape the real caller uses', () => {
      expect(writesRawBlocksEdge("const rel = 'blocks';\nawait links.link(src, dst, rel, { created_by: by });")).toBe(
        true,
      );
    });

    it('flags a rel reached via a branch, not a literal argument (the link.ts shape)', () => {
      expect(
        writesRawBlocksEdge(
          "if (it.rel === 'blocks') { /* ... */ }\nawait links.link(src, dst, it.rel, { created_by: by });",
        ),
      ).toBe(true);
    });
  });

  describe('does NOT flag canonical work-item link facades', () => {
    it('trusts linkWorkItem and linkIssue callers; their definitions are checked separately', () => {
      expect(writesRawBlocksEdge("await linkWorkItem(id, dst, 'blocks', { harness });")).toBe(false);
      expect(writesRawBlocksEdge("const rel = 'blocks';\nawait linkIssue(id, dst, rel, by);")).toBe(false);
    });
  });

  describe('does NOT flag reads — reading a blocker set cannot create a cycle', () => {
    it('ignores listIn(ref, { rel: blocks })', () => {
      expect(writesRawBlocksEdge("const edges = await listIn(ref, { rel: 'blocks' });")).toBe(false);
    });

    it('ignores listInMany(dsts, { rel: blocks }) — the live work-items-events.ts shape', () => {
      expect(writesRawBlocksEdge("const inEdges = await listInMany(dsts, { rel: 'blocks' });")).toBe(false);
    });
  });

  describe('does NOT flag a write that APPLIES the policy', () => {
    it('clears a file routing through the authoritative writer', () => {
      expect(writesRawBlocksEdge('await syncFeatureBlockEdges(harness, featureId, blockedBy);')).toBe(false);
    });

    it('clears a raw single-edge write guarded by guardFeatureBlockEdgeAcyclic (the link.ts shape)', () => {
      expect(
        writesRawBlocksEdge(
          'const err = await guardFeatureBlockEdgeAcyclic(srcRef.ref, dst.ref);\n' +
            'if (err) return { ok: false, error: err };\n' +
            "await links.link(srcRef, dst, 'blocks', { created_by: by });",
        ),
      ).toBe(false);
    });
  });

  describe('does NOT flag non-writes', () => {
    it('ignores prose in comments that mentions the edge', () => {
      expect(
        writesRawBlocksEdge("// we INSERT INTO harness_shared.coord_links with rel='blocks' elsewhere\nconst x = 1;"),
      ).toBe(false);
      expect(
        writesRawBlocksEdge(
          "/* Blocking is the uniform rel='blocks' edge; INSERT INTO harness_shared.coord_links */\nexport const K = 1;",
        ),
      ).toBe(false);
    });

    it('ignores a rel OTHER than blocks — only feature blocking deadlocks the frontier', () => {
      expect(writesRawBlocksEdge("await links.link(src, dst, 'relates', { created_by: by });")).toBe(false);
      expect(writesRawBlocksEdge("await links.link(src, dst, 'duplicates', { created_by: by });")).toBe(false);
    });

    it('ignores a coord_links INSERT that carries no blocks rel at all', () => {
      expect(writesRawBlocksEdge("await sql`INSERT INTO harness_shared.coord_links (rel) VALUES ('relates')`;")).toBe(
        false,
      );
    });
  });

  /**
   * The KNOWN, ACCEPTED coarseness of the file-level match, pinned deliberately so it
   * is a documented property rather than a surprise to the next reader.
   *
   * A file that writes some OTHER rel and separately mentions 'blocks' is flagged.
   * That is the price of catching the variable-rel form above, and it was paid with
   * eyes open: measured against the live tree (5680 scanned files, 2026-08-02) this
   * costs exactly ONE file — work-items.ts, the linkWorkItem definition site — which
   * is allowlisted with a reason. If a future file trips this legitimately, the fix is
   * to reference the policy or add a REASONED allowlist entry; the fix is NOT to
   * tighten the predicate back to argument-level matching, which would reopen the
   * blind spot that the real caller already lives in.
   */
  it('KNOWN TRADE: flags a non-blocks write in a file that also mentions blocks', () => {
    expect(writesRawBlocksEdge("await links.link(src, dst, 'relates');\nconst label = 'blocks';")).toBe(true);
  });
});

describe('P-006 canonical work_item_deps admission guard', () => {
  it('flags physical INSERT, DELETE, and UPDATE DML but not a read', () => {
    expect(
      writesRawWorkItemDependency('await sql`INSERT INTO harness_shared.work_item_deps (workspace_id) VALUES (ws)`;'),
    ).toBe(true);
    expect(
      writesRawWorkItemDependency("await sql`DELETE FROM harness_shared.work_item_deps WHERE dep_type = 'blocks'`;"),
    ).toBe(true);
    expect(writesRawWorkItemDependency('await sql`UPDATE harness_shared.work_item_deps SET blocked_ref = ref`;')).toBe(
      true,
    );
    expect(writesRawWorkItemDependency('await sql`SELECT * FROM harness_shared.work_item_deps`;')).toBe(false);
  });

  it('does not mistake TS or SQL comments for a physical write', () => {
    expect(writesRawWorkItemDependency('// INSERT INTO harness_shared.work_item_deps\nconst x = 1;')).toBe(false);
    expect(writesRawWorkItemDependency('-- DELETE FROM harness_shared.work_item_deps\nSELECT 1')).toBe(false);
  });

  it('detects the retired blanket acyclicity bypass', () => {
    expect(usesDependencyAdmissionBypass('syncFeatureBlockEdges(h, id, deps, { enforceAcyclicity: false })')).toBe(
      true,
    );
    expect(usesDependencyAdmissionBypass('syncFeatureBlockEdges(h, id, deps)')).toBe(false);
  });

  it('requires every compatibility facade to submit through mutateWorkItemDependencies', () => {
    const routed = [
      'export async function mirrorWorkItemBlockingEdge() { await mutateWorkItemDependencies(input); }',
      'export async function removeMirroredWorkItemBlockingEdge() { await mutateWorkItemDependencies(input); }',
      'export async function syncWorkItemDepEdges() { await mutateWorkItemDependencies(input); }',
    ].join('\n');
    expect(canonicalFacadeRoutingOffenders(routed)).toEqual([]);
    expect(
      canonicalFacadeRoutingOffenders(
        routed.replace('await mutateWorkItemDependencies(input);', 'await sql`INSERT INTO x VALUES (1)`;'),
      ),
    ).toEqual(['mirrorWorkItemBlockingEdge']);
  });

  it('requires both work-item families to keep link and unlink on the canonical mirror facades', () => {
    const workItems = [
      'export async function linkWorkItem() { await linkIssue(); await mirrorWorkItemBlockingEdge(); }',
      'export async function unlinkWorkItem() { await unlinkIssue(); await removeMirroredWorkItemBlockingEdge(); }',
    ].join('\n');
    const issues = [
      'export async function linkIssue() { await mirrorWorkItemBlockingEdge(); }',
      'export async function unlinkIssue() { await removeMirroredWorkItemBlockingEdge(); }',
    ].join('\n');
    expect(canonicalLinkFacadeRoutingOffenders(workItems, issues)).toEqual([]);
    expect(
      canonicalLinkFacadeRoutingOffenders(
        workItems.replace('await mirrorWorkItemBlockingEdge();', "await links.link(src, dst, 'blocks');"),
        issues,
      ),
    ).toEqual(['linkWorkItem']);
    expect(
      canonicalLinkFacadeRoutingOffenders(
        workItems,
        issues.replace('await removeMirroredWorkItemBlockingEdge();', "await links.unlink(src, dst, 'blocks');"),
      ),
    ).toEqual(['unlinkIssue']);
  });

  it('every raw-DML capability carries a reviewable reason — the floor proven on FIXTURES', () => {
    // The floor is stated once, as a predicate, so its teeth are proven against synthetic
    // values rather than against `RAW_WORK_ITEM_DEPS_CAPABILITIES.size > 0`. Retiring the
    // last raw-DML site is the whole point of the canonical-facade design this guard
    // enforces, and `.every()` is VACUOUSLY true on an empty map — so the size control was
    // load-bearing AND self-defeating: it reds the guard at the exact moment the cleanup it
    // tracks succeeds. WI-1556492.
    const hasReviewableReason = (reason: string): boolean => reason.trim().length >= 40;

    expect(hasReviewableReason('x'.repeat(40)), 'a 40-char reason clears the floor').toBe(true);
    expect(hasReviewableReason('too terse to review'), 'a terse reason does not').toBe(false);
    expect(hasReviewableReason(`   ${'x'.repeat(39)}   `), 'padding does not buy length').toBe(false);

    for (const [path, reason] of RAW_WORK_ITEM_DEPS_CAPABILITIES) {
      expect(hasReviewableReason(reason), `${path} reason`).toBe(true);
    }
  });
});
