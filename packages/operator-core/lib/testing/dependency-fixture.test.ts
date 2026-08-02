/**
 * dependency-fixture.test.ts — the factory's own tests.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-002).
 *
 * NO `@covers` CITATION, DELIBERATELY. An earlier revision of this header claimed
 * INV-01/02/03, and that claim was false in the way this whole plan is about: these tests
 * prove the FACTORY agrees with `canonicalRef`, which encodes INV-01 — a pure function
 * agreeing with itself. The citation would have registered as subsystem coverage while
 * proving nothing about the subsystem, and it would have stayed green with the production
 * dependency code deleted. The real proofs of INV-01/02/03 live in
 * dbos/work-item-deps-store.test.ts and scheduler/work-item-deps-integrity.integration.test.ts.
 *
 * This is the ONE place where asserting against `canonicalRef` is legitimate: the
 * factory is the subject here, not the production subsystem. Everywhere else, see
 * the tautology warning in dependency-fixture.ts — a test that generates a row with
 * this factory and then asserts the row matches the factory has proved nothing.
 *
 * Pure only: no PG, no processes. `seedScenario` is deliberately untested here —
 * it needs a live connection and belongs to the integration tier (P-006/P-007).
 *
 * Run: cd packages/operator-core && npx vitest run lib/testing/dependency-fixture.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalRef,
  defineScenario,
  expectedBlockedIds,
  expectedDefectiveEdges,
  projectEdgeRows,
  projectItemRows,
  standardScenario,
  type EdgeRow,
} from './dependency-fixture';

const H = 'papercusp';

/**
 * Select the ONE edge joining a given pair.
 *
 * Deliberately keyed on BOTH endpoints. An earlier version matched on the blocker
 * alone and silently returned the wrong row: `F-open-blocker` is the blocker of two
 * different edges in the standard scenario — one correct, one wrong-qualifier — so a
 * blocker-only lookup found the correct one and the defect assertion failed against
 * a row that was never the subject. A fixture selector that can quietly resolve to
 * the wrong row is the same class of bug this plan exists to catch.
 */
const edgeBetween = (rows: EdgeRow[], blockedId: string, blockerId: string) => {
  const hits = rows.filter((r) => r.blocked_ref.includes(blockedId) && r.blocker_ref.includes(blockerId));
  if (hits.length !== 1) {
    throw new Error(`edgeBetween(${blockedId}, ${blockerId}) matched ${hits.length} rows — expected exactly 1`);
  }
  return hits[0];
};

describe('canonicalRef — the INV-01 ref-form rule', () => {
  it('qualifies a feature endpoint and leaves an issue endpoint bare', () => {
    expect(canonicalRef('feature', H, 'WI-1')).toBe('papercusp#WI-1');
    expect(canonicalRef('issue', H, 'EI-1')).toBe('EI-1');
  });

  it('qualifies with the harness it is given, not a hardcoded one', () => {
    // The pot-rename class (INV-03) only reproduces if the harness is a real
    // parameter, so this pins that it is.
    expect(canonicalRef('feature', 'other-pot', 'WI-1')).toBe('other-pot#WI-1');
  });
});

describe('defineScenario — construction guards', () => {
  it('defaults to a NON-default workspace so the historical blind spot is not re-created', () => {
    const s = defineScenario({ items: [{ id: 'A', family: 'issue', status: 'open' }], edges: [] });
    expect(s.workspace).not.toBe('default');
    expect(s.harness).not.toBe('default');
  });

  it('honours an explicit tenant', () => {
    const s = defineScenario({
      workspace: 'ws-2',
      harness: 'h-2',
      items: [{ id: 'A', family: 'issue', status: 'open' }],
      edges: [],
    });
    expect([s.workspace, s.harness]).toEqual(['ws-2', 'h-2']);
  });

  it('rejects an edge naming an undeclared blocked item', () => {
    expect(() =>
      defineScenario({ items: [{ id: 'A', family: 'issue', status: 'open' }], edges: [{ blocked: 'NOPE', blocker: 'A' }] }),
    ).toThrow(/blocked 'NOPE' is not a declared item/);
  });

  it('rejects an undeclared blocker UNLESS dangling was asked for explicitly', () => {
    const items = [{ id: 'A', family: 'issue' as const, status: 'open' }];
    // A typo'd blocker would otherwise surface as a 'dangling' finding — a fixture
    // bug wearing the costume of the exact defect under test.
    expect(() => defineScenario({ items, edges: [{ blocked: 'A', blocker: 'GHOST' }] })).toThrow(
      /use defect:'dangling'/,
    );
    expect(() =>
      defineScenario({ items, edges: [{ blocked: 'A', blocker: 'GHOST', defect: 'dangling' }] }),
    ).not.toThrow();
  });
});

describe('projectItemRows', () => {
  it('carries the tenant onto every row and preserves family', () => {
    const s = standardScenario({ workspace: 'ws-x', harness: 'h-x' });
    const rows = projectItemRows(s);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.workspace_id === 'ws-x' && r.harness_slug === 'h-x')).toBe(true);
    expect(rows.find((r) => r.feature_id === 'EI-blocked')!.item_kind).toBe('issue');
    expect(rows.find((r) => r.feature_id === 'F-blocked')!.item_kind).toBe('feature');
  });
});

describe('projectEdgeRows — defect injection', () => {
  const spec = standardScenario();
  const rows = projectEdgeRows(spec);

  it('writes a correct mixed-family edge in each endpoint\'s own form', () => {
    // F-blocked (feature) ← EI-open-blocker (issue): qualified blocked side,
    // bare blocker side. Getting this asymmetry wrong is what D-017 was.
    const r = rows.find((x) => x.blocked_ref === 'papercusp#F-blocked' && x.blocker_ref === 'EI-open-blocker')!;
    expect(r).toBeDefined();
    expect(r.blocked_kind).toBe('feature');
    expect(r.blocker_kind).toBe('issue');
  });

  it('kind-mismatch declares the WRONG family and is self-consistently wrong', () => {
    // The real defect was self-consistent — kind and ref form agreed with each
    // other, and both disagreed with the target row. That is why it passed every
    // shape check. Reproduce it faithfully or the detector test proves nothing.
    const r = rows.find((x) => x.blocked_ref === 'EI-blocked' && x.blocker_ref.includes('EI-open-blocker'))!;
    expect(r.blocker_kind).toBe('feature'); // target is genuinely an issue
    expect(r.blocker_ref).toBe('papercusp#EI-open-blocker'); // written in feature form
  });

  it('wrong-qualifier keeps the right kind but names a stale slug', () => {
    const r = edgeBetween(rows, 'F-blocked', 'F-open-blocker');
    expect(r.blocker_kind).toBe('feature');
    expect(r.blocker_ref).toMatch(/-renamed#F-open-blocker$/);
    expect(r.blocker_ref).not.toBe(canonicalRef('feature', H, 'F-open-blocker'));
  });

  it('leaves the OTHER edge to the same blocker correct — defects are per-edge, not per-item', () => {
    // EI-blocked ← F-open-blocker is declared clean while F-blocked ← F-open-blocker
    // carries wrong-qualifier. If injection leaked across edges sharing a blocker,
    // every "clean" expectation built on this scenario would be quietly wrong.
    const r = edgeBetween(rows, 'EI-blocked', 'F-open-blocker');
    expect(r.blocker_ref).toBe(canonicalRef('feature', H, 'F-open-blocker'));
  });

  it('dangling points at an id no row will ever have', () => {
    const r = rows.find((x) => x.blocker_ref === 'WI-does-not-exist')!;
    expect(r).toBeDefined();
    expect(spec.items.some((i) => i.id === r.blocker_ref)).toBe(false);
  });

  it('always writes dep_type=blocks and the scenario workspace', () => {
    expect(rows.every((r) => r.dep_type === 'blocks')).toBe(true);
    expect(new Set(rows.map((r) => r.workspace_id)).size).toBe(1);
  });

  it('re-qualifies every ref when the tenant changes — the axis the old fixtures froze', () => {
    const other = projectEdgeRows(standardScenario({ harness: 'other-pot' }));
    expect(other.some((r) => r.blocked_ref === 'other-pot#F-blocked')).toBe(true);
    expect(other.some((r) => r.blocked_ref.startsWith('papercusp#'))).toBe(false);
  });
});

describe('expectations derived from the spec', () => {
  it('counts defective edges by class', () => {
    const d = expectedDefectiveEdges(standardScenario());
    expect(d.kindMismatch).toHaveLength(1);
    expect(d.wrongQualifier).toHaveLength(1);
    expect(d.dangling).toHaveLength(1);
    expect(d.total).toBe(3);
  });

  it('reports zero defects for an all-correct scenario — the detector negative control', () => {
    const clean = defineScenario({
      items: [
        { id: 'A', family: 'feature', status: 'open' },
        { id: 'B', family: 'issue', status: 'open' },
      ],
      edges: [{ blocked: 'A', blocker: 'B' }],
    });
    expect(expectedDefectiveEdges(clean).total).toBe(0);
  });

  it('expects only NON-defective, non-terminal blockers to withhold', () => {
    // F-blocked has 3 edges: one correct+open (withholds), one correct+done
    // (does not), one wrong-qualifier (gates nothing). EI-blocked has one
    // correct+open, plus a kind-mismatch and a dangling that both gate nothing.
    expect(expectedBlockedIds(standardScenario())).toEqual(['EI-blocked', 'F-blocked']);
  });

  it('treats an item whose ONLY edges are defective as CLAIMABLE — the cost of the bug', () => {
    const s = defineScenario({
      items: [
        { id: 'A', family: 'issue', status: 'open' },
        { id: 'B', family: 'issue', status: 'open' },
      ],
      edges: [{ blocked: 'A', blocker: 'B', defect: 'kind-mismatch' }],
    });
    // A has an open blocker and is still expected claimable. That is not a
    // tolerated quirk — it is the defect's cost, stated as an expectation so a
    // test can assert the system currently pays it.
    expect(expectedBlockedIds(s)).toEqual([]);
  });

  it('does not withhold on a terminal blocker', () => {
    const s = defineScenario({
      items: [
        { id: 'A', family: 'feature', status: 'open' },
        { id: 'B', family: 'feature', status: 'done' },
      ],
      edges: [{ blocked: 'A', blocker: 'B' }],
    });
    expect(expectedBlockedIds(s)).toEqual([]);
  });

  it('honours a caller-supplied terminal-state vocabulary', () => {
    const s = defineScenario({
      items: [
        { id: 'A', family: 'feature', status: 'open' },
        { id: 'B', family: 'feature', status: 'archived' },
      ],
      edges: [{ blocked: 'A', blocker: 'B' }],
    });
    expect(expectedBlockedIds(s)).toEqual(['A']); // 'archived' not terminal by default
    expect(expectedBlockedIds(s, ['archived'])).toEqual([]);
  });
});

/**
 * REGRESSION GUARD for a bug this factory shipped with (found by P-006, 2026-08-02).
 *
 * `projectEdgeRows` wrote edges into `spec.workspace`. But `work_item_deps` is keyed in
 * the COORDINATION workspace ('default') — migration 719 is explicit that the edge
 * lookup must NOT be scoped to the item workspace, because doing so "would match zero
 * rows and disable blocking entirely". Since this factory DEFAULTS to a non-'default'
 * tenant on purpose, every edge it seeded was invisible to the oracle and gated nothing:
 * the exact inert-edge class the factory exists to detect.
 *
 * Nothing here could catch it before, and that is the instructive part — these are pure
 * projection tests, so they compared the factory against itself and agreed. It took
 * driving the real oracle (dependency-tenant-matrix.integration.test.ts), whose seeded
 * POSITIVE control failed, to surface it. A suite of only-negative expectations would
 * have stayed green with blocking entirely disabled.
 */
describe('edge rows live in the COORD workspace, never the item workspace', () => {
  const twoAxis = defineScenario({
    workspace: 'tenant-x-ws',
    harness: 'tenant-x-pot',
    items: [
      { id: 'F-a', family: 'feature', status: 'open' },
      { id: 'F-b', family: 'feature', status: 'wip' },
    ],
    edges: [{ blocked: 'F-a', blocker: 'F-b' }],
  });

  it("defaults the coord workspace to 'default' even when the item workspace is not", () => {
    expect(twoAxis.workspace).toBe('tenant-x-ws');
    expect(twoAxis.coordWorkspace).toBe('default');
  });

  it('writes every edge row under the COORD workspace, not the item workspace', () => {
    const rows = projectEdgeRows(twoAxis);
    expect(rows).not.toHaveLength(0);
    for (const r of rows) expect(r.workspace_id).toBe('default');
  });

  it('keeps ITEM rows in the item workspace — the two axes must not be collapsed', () => {
    for (const r of projectItemRows(twoAxis)) expect(r.workspace_id).toBe('tenant-x-ws');
  });

  it('allows an explicit WRONG coord workspace, so a test can prove such an edge is inert', () => {
    const wrong = defineScenario({
      workspace: 'tenant-x-ws',
      coordWorkspace: 'tenant-x-ws', // the original bug, now expressible on purpose
      items: [
        { id: 'F-a', family: 'feature', status: 'open' },
        { id: 'F-b', family: 'feature', status: 'wip' },
      ],
      edges: [{ blocked: 'F-a', blocker: 'F-b' }],
    });
    for (const r of projectEdgeRows(wrong)) expect(r.workspace_id).toBe('tenant-x-ws');
  });
});
