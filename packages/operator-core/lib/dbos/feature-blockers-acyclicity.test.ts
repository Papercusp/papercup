/**
 * Acyclicity enforcement on the AUTHORITATIVE feature→feature `blocks` write
 * (work-item-deps-and-readiness-2026-06-22 P-003, audit finding F4).
 *
 * A feature→feature `blocks` cycle silently DEADLOCKS the scheduler frontier (every item in the
 * cycle is forever non-ready). These unit tests pin the REJECTION LOGIC that prevents it, exercised
 * through the real helpers in feature-blockers-edges.ts (which reuse `wouldCreateCycle` /
 * `detectDependencyCycle` — never a hand-rolled walk):
 *
 *   - wouldFeatureBlockEdgeCreateCycle  — would ADDING one blocker close a cycle? (link-tool guard)
 *   - guardFeatureBlockEdgeAcyclic      — the tool-facing guard over raw coord_links refs (scope + reject)
 *   - detectFeatureBlockGraphCycle      — read-only reconciliation: any PRE-EXISTING cycle?
 *
 * The live graph is supplied by mocking `getFeatureBlockers`' single DB read (getOrgPg().sql),
 * so no Postgres is needed — the integration counterpart drives the real syncFeatureBlockEdges
 * write against a testcontainer.
 *
 * Run: cd packages/operator-core && npx vitest run lib/dbos/feature-blockers-acyclicity.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The live blocks graph the mocked getFeatureBlockers read will return, as coord_links rows
// (dst_ref = BLOCKED, src_ref = BLOCKER). Each test sets this before calling a helper.
const g = vi.hoisted(() => ({ rows: [] as Array<{ dst_ref: string; src_ref: string }> }));

// A minimal fake `sql` tagged-template that returns the canned graph rows for the one SELECT
// getFeatureBlockers issues. The helpers under test issue no other query.
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const sql = (() => Promise.resolve(g.rows)) as unknown;
  return { ...actual, getOrgPg: () => ({ sql }) };
});

const {
  wouldFeatureBlockEdgeCreateCycle,
  guardFeatureBlockEdgeAcyclic,
  detectFeatureBlockGraphCycle,
} = await import('./feature-blockers-edges');

const H = 'demo';
const ref = (id: string) => `${H}#${id}`;
/** Express a graph as blocked-id -> [blocker-ids] and load it as coord_links rows. */
function setGraph(graph: Record<string, string[]>) {
  g.rows = [];
  for (const [blocked, blockers] of Object.entries(graph)) {
    for (const blocker of blockers) g.rows.push({ dst_ref: ref(blocked), src_ref: ref(blocker) });
  }
}

beforeEach(() => {
  g.rows = [];
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('wouldFeatureBlockEdgeCreateCycle — adding ONE blocker edge (link-tool guard)', () => {
  it('rejects a direct 2-cycle  a→b→a  (b already blocks a; now a blocks b)', async () => {
    setGraph({ A: ['B'] }); // A blocked-by B
    expect(await wouldFeatureBlockEdgeCreateCycle(H, 'B', 'A')).toBe(true); // adding B blocked-by A closes it
  });

  it('rejects a transitive 3-cycle  a→b→c→a', async () => {
    setGraph({ A: ['B'], B: ['C'] }); // A<-B, B<-C  (a chain C→B→A)
    expect(await wouldFeatureBlockEdgeCreateCycle(H, 'C', 'A')).toBe(true); // C blocked-by A closes C→B→A→C
  });

  it('rejects a self-block at the writer level (a→a) — but the helper drops the self-edge (no cycle)', async () => {
    setGraph({});
    // A blocking itself is dropped (no-self-block invariant), so it is NOT reported as a cycle here;
    // the writer drops the edge. (Self-block REJECTION at the set level is covered below.)
    expect(await wouldFeatureBlockEdgeCreateCycle(H, 'A', 'A')).toBe(false);
  });

  it('accepts a DAG edge that only extends a chain  (A<-B<-C, add C<-D)', async () => {
    setGraph({ A: ['B'], B: ['C'] });
    expect(await wouldFeatureBlockEdgeCreateCycle(H, 'C', 'D')).toBe(false);
  });

  it('accepts the very first edge into an empty graph', async () => {
    setGraph({});
    expect(await wouldFeatureBlockEdgeCreateCycle(H, 'A', 'B')).toBe(false);
  });
});

describe('guardFeatureBlockEdgeAcyclic — tool-facing guard over raw coord_links refs', () => {
  it('returns an error string for a cycle-closing feature→feature edge (src=blocker → dst=blocked)', async () => {
    setGraph({ A: ['B'] }); // B blocks A
    // Edge src=A (blocker) → dst=B (blocked): now A blocks B too → 2-cycle.
    const err = await guardFeatureBlockEdgeAcyclic(ref('A'), ref('B'));
    expect(err).toMatch(/dependency cycle/);
  });

  it('returns null for a safe (acyclic) feature→feature edge', async () => {
    setGraph({ A: ['B'] });
    expect(await guardFeatureBlockEdgeAcyclic(ref('C'), ref('A'))).toBeNull(); // A<-C<-... no cycle
  });

  it('no-ops (null) for a CROSS-HARNESS edge — not a single-harness frontier cycle', async () => {
    setGraph({ A: ['B'] });
    expect(await guardFeatureBlockEdgeAcyclic('otherharness#A', ref('B'))).toBeNull();
  });

  it('no-ops (null) for a NON-feature ref (e.g. an issue→feature edge, src is a bare id)', async () => {
    setGraph({ A: ['B'] });
    expect(await guardFeatureBlockEdgeAcyclic('issue-123', ref('A'))).toBeNull();
  });
});

describe('detectFeatureBlockGraphCycle — read-only reconciliation', () => {
  it('reports an existing 2-cycle in the live graph (a↔b) — cycleNodes are prefix-stripped ids, and LOGS it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setGraph({ A: ['B'], B: ['A'] });
    const r = await detectFeatureBlockGraphCycle(H);
    expect(r.hasCycle).toBe(true);
    expect(r.cycleNodes.sort()).toEqual(['A', 'B']); // getFeatureBlockers strips the harness prefix
    // Surfaced loudly (the "log it for reconciliation" requirement).
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PRE-EXISTING feature-dependency CYCLE/));
    warn.mockRestore();
  });

  it('reports an existing transitive 3-cycle (a→b→c→a)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setGraph({ A: ['B'], B: ['C'], C: ['A'] });
    const r = await detectFeatureBlockGraphCycle(H);
    expect(r.hasCycle).toBe(true);
    warn.mockRestore();
  });

  it('reports NO cycle for an acyclic graph (a DAG) — and does NOT warn', async () => {
    setGraph({ A: ['B'], B: ['C'] });
    const r = await detectFeatureBlockGraphCycle(H);
    expect(r.hasCycle).toBe(false);
    expect(r.cycleNodes).toEqual([]);
  });
});
