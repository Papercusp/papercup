/**
 * dependency-invariants.ts — the dependency subsystem's invariants, named and executable.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-001).
 *
 * WHY THIS FILE EXISTS. The dependency subsystem is not under-tested by volume:
 * ~85 test files and 1,500+ tests touch it. It is heavily tested and it still
 * shipped, for months, an oracle hardcoded to workspace 'default'; six promotion
 * edges that gated nothing; and every issue-family edge `syncFeatureBlockEdges`
 * wrote, inert by construction. Every one of those escapes had green coverage at
 * the time.
 *
 * The reason coverage could not help is that the CLAIMS were never written down.
 * "A written edge gates nothing" was not a proposition anyone had stated, so no
 * test could be said to be missing it. This registry states them. Each entry is a
 * proposition that is either true of the system or is a bug — never a description
 * of how the code currently behaves.
 *
 * HOW IT IS USED. Tests cite the invariants they prove via `@covers INV-NN` in a
 * describe/it title or a comment, and `coveredInvariants()` extracts them. Coverage
 * then reads as "which invariants are PROVEN", not as a line percentage — the
 * escaped bugs were all inside covered lines, so a line percentage was exactly the
 * metric that could not see them.
 *
 * THIS FILE IS DATA, NOT LOGIC. It imports nothing from the subsystem it describes,
 * so it can never drift into asserting the implementation against itself, and a test
 * may import it without pulling in PG or the claim path.
 */

/** Which part of the subsystem an invariant binds. */
export type InvariantArea =
  | 'ref-vocabulary'
  | 'effectiveness'
  | 'claim-doors'
  | 'graph-shape'
  | 'tenancy'
  | 'observability';

export interface DependencyInvariant {
  /** Stable id. NEVER renumber or reuse — tests cite these by string. */
  readonly id: string;
  readonly area: InvariantArea;
  /** One sentence, stated as a proposition that is true of a correct system. */
  readonly statement: string;
  /**
   * What going wrong looks like in production — concrete, and drawn from a real
   * incident wherever one exists. This is the field that makes an invariant
   * testable: it names the observable, not the intention.
   */
  readonly violationLooksLike: string;
  /** Code paths bound by this invariant. Repo-relative, no globs. */
  readonly binds: readonly string[];
  /** Incident/decision refs that motivated it, for anyone tempted to relax it. */
  readonly provenance: readonly string[];
  /**
   * Set when an invariant has been CORRECTED — what it used to say, why that was wrong, and
   * how the correct statement was established.
   *
   * An invariant is a claim about the system, so it can be wrong, and a silently-edited one
   * is worse than a wrong one: the next reader sees a confident proposition with no trace of
   * the reasoning that moved it, and the natural next edit moves it back. Provenance covers
   * "why does this exist"; this covers "why does it say THIS and not the obvious thing".
   */
  readonly note?: string;
}

/**
 * The invariants.
 *
 * Ordering is by area, not importance. INV-01..INV-04 are the ones with a
 * documented escape behind them; treat a proposed change to those as a design
 * change, not a test change.
 */
export const DEPENDENCY_INVARIANTS: readonly DependencyInvariant[] = [
  // ---- ref vocabulary -----------------------------------------------------
  {
    id: 'INV-01',
    area: 'ref-vocabulary',
    statement:
      "A dependency endpoint's ref FORM is determined by that endpoint's OWN family: feature-family endpoints are harness-qualified ('<harness>#<id>'), issue-family endpoints are bare ('<id>').",
    violationLooksLike:
      "An edge row is written whose blocker_ref is harness-qualified while the blocker is an issue-family row. The row is well-formed, passes count and symmetry checks, and the blocking oracle's join never matches it — so the edge exists and withholds nothing.",
    binds: [
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
      'packages/operator-core/lib/dbos/feature-blockers-edges.ts',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#D-009', 'work-item-dependency-edges-2026-08-02#D-017'],
  },
  {
    id: 'INV-02',
    area: 'ref-vocabulary',
    statement:
      "An edge endpoint's declared *_kind agrees with the family of the row it actually resolves to.",
    violationLooksLike:
      "An edge declares kind 'feature' while its target id resolves to an engineer_issues row. Form-valid, inert. Three such rows were live on 2026-08-02.",
    binds: ['packages/operator-core/lib/dbos/work-item-deps-store.ts'],
    provenance: ['EI-19325959789634791', 'work-item-dependency-edges-2026-08-02#D-017'],
  },
  {
    id: 'INV-03',
    area: 'ref-vocabulary',
    statement:
      'Renaming a pot/harness leaves NO dependency edge or coord_link still naming the old slug.',
    violationLooksLike:
      "After a rename, 8 edges still carried 'papercusp-public-site#WI-54xx' while the items lived under 'papercusp-public-site-pot'. Every one of those blocking relationships was silently deactivated, and the items became claimable.",
    binds: [
      'packages/operator-core/lib/repoint-qualified-refs-on-rehome.ts',
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
    ],
    provenance: ['EI-19374236094682800'],
  },

  // ---- effectiveness ------------------------------------------------------
  {
    id: 'INV-04',
    area: 'effectiveness',
    statement:
      'Every dependency edge that EXISTS and whose blocker is non-terminal is EFFECTIVE — it causes the blocked item to be withheld by every claim door.',
    violationLooksLike:
      'The whole point. An edge is present in work_item_deps, mirrors correctly, and the graph is acyclic — and the blocked item is served anyway. Row-shape evidence cannot distinguish this from correct behaviour, which is why three green checks missed six such edges.',
    binds: [
      'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/scheduler/claim-spec-store.ts',
      'libs/papercusp/libs/db/sql (work_item_is_blocked)',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#D-017', 'work-item-dependency-edges-2026-08-02#D-019'],
  },
  {
    id: 'INV-05',
    area: 'effectiveness',
    statement:
      'When the last non-terminal blocker of an item becomes terminal, the item becomes claimable — blocking is released, not merely recorded.',
    violationLooksLike:
      'An item stays unclaimable after its blockers are all done: work silently stalls and no error is raised anywhere. The inverse of INV-04 and equally invisible to row-shape checks.',
    binds: ['packages/operator-core/lib/work-items.ts', 'packages/operator-core/lib/scheduler/readiness-reconcile.ts'],
    provenance: ['work-item-deps-and-readiness-2026-06-22'],
  },

  // ---- claim doors --------------------------------------------------------
  {
    id: 'INV-06',
    area: 'claim-doors',
    statement:
      'EVERY claim entry point applies the SAME blocking verdict for the same item — there is no door through which a blocked item can be claimed.',
    violationLooksLike:
      'scheduler:get_next withholds an item while a direct claim-by-id hands it out. The audit that proves this is point-in-time and rots the moment someone adds a door.',
    binds: [
      'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/scheduler/claim-spec-store.ts',
      'packages/operator-core/lib/scheduler/get-next.ts',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#P-012', 'work-item-dependency-edges-2026-08-02#P-014'],
  },
  {
    id: 'INV-07',
    area: 'claim-doors',
    statement:
      'The post-claim plan-item lane guard never SERVES a row it has confirmed blocked — on retry-budget exhaustion it fails CLOSED and releases.',
    violationLooksLike:
      'WI-3503/P-401 was handed out via scheduler:get_next with a 7-deep blockedBy chain still open, because exhaustion used to fail OPEN and serve the last candidate.',
    binds: [
      'packages/operator-core/lib/scheduler/claim-spec-store.ts',
      'packages/operator-core/lib/scheduler/plan-item-lane-guard.ts',
    ],
    provenance: ['EI-9108'],
  },

  // ---- graph shape --------------------------------------------------------
  {
    id: 'INV-08',
    area: 'graph-shape',
    statement:
      'The blocks graph is acyclic, and a write that would introduce a cycle is rejected at EDGE granularity — the offending edges are refused, never the whole promotion.',
    violationLooksLike:
      'A cycle makes every item in it permanently unclaimable with no diagnostic; or an over-broad rejection drops a whole promotion because one edge was bad.',
    binds: [
      'packages/operator-core/lib/dbos/work-item-deps-store.ts',
      'packages/operator-core/lib/plan-workitem-promotion-run.ts',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#D-012'],
  },
  {
    id: 'INV-09',
    area: 'graph-shape',
    statement:
      'An item is withheld while ANY DIRECT blocker is non-terminal. Chains of unfinished work are therefore withheld to arbitrary depth (a blocked item is itself non-terminal), and the release frontier advances ONE link per completion — but a blocker that has REACHED a terminal state releases its dependent regardless of that blocker\'s own upstream.',
    violationLooksLike:
      "Either direction is a bug, and they are opposite. Too weak: the frontier collapses — satisfying a chain's ROOT frees the whole chain at once, serving work whose immediate prerequisite was never done. Too strong: a genuinely FULLY-transitive rule, which deadlocks any item whose completed prerequisite happens to sit downstream of an abandoned root, and which no correct implementation should have.",
    binds: ['libs/papercusp/libs/db/sql (work_item_is_blocked)', 'packages/operator-core/lib/work-items.ts'],
    provenance: ['dependency-subsystem-thorough-testing-2026-08-02#D-001'],
    note:
      "CORRECTED 2026-08-02 (P-005). This invariant was first written as 'blocking is transitive: an item with a BLOCKED blocker is itself withheld', citing EI-9108. Both halves were wrong. (1) The system is one-hop-with-terminality, and that is CORRECT, not a leak — 'terminal' means the work is done, so a completed prerequisite satisfies its dependent whatever sits behind it; the transitive reading would deadlock legitimate work. Verified live: claim-respects-blocking.integration.test.ts, 'THE DISCRIMINATING CASE'. (2) EI-9108 was never a depth leak in the oracle — it was the lane guard's retry-budget exhaustion failing OPEN, which is INV-07. The mis-citation mattered: as written, INV-09 was unfalsifiable by depth alone (every intermediate in an unfinished chain is non-terminal, so one-hop and transitive agree on every chain anyone would naturally seed), so a test could look like it proved it while proving nothing.",
  },
  {
    id: 'INV-10',
    area: 'graph-shape',
    statement:
      'A backfill UNIONs with existing edges; it never REPLACES them. Replace-semantics is safe only at promotion, where the item was just minted.',
    violationLooksLike:
      'A backfill run silently deletes hand-authored or previously-repaired edges, and the graph quietly loses gating it used to have.',
    binds: ['packages/operator-core/lib/dbos/feature-blockers-edges.ts'],
    provenance: ['work-item-dependency-edges-2026-08-02#D-015'],
  },

  // ---- tenancy ------------------------------------------------------------
  {
    id: 'INV-11',
    area: 'tenancy',
    statement:
      "Every dependency read and write is scoped by (workspace_id, harness) — none assumes the 'default' workspace.",
    violationLooksLike:
      "The SQL oracle hardcoded workspace 'default'. Every test constructed its fixture in 'default', so the suite was green for months while blocking was inert for every other tenant. The bug lived on the axis the tests held constant.",
    binds: [
      'libs/papercusp/libs/db/sql (work_item_is_blocked)',
      'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/scheduler/readiness-reconcile.ts',
    ],
    provenance: ['work-item-dependency-edges-2026-08-02#P-001'],
  },

  // ---- observability ------------------------------------------------------
  {
    id: 'INV-12',
    area: 'observability',
    statement:
      'The endpoint detector FIRES on a seeded defect and stays SILENT on a clean graph — both halves, or its zero means nothing.',
    violationLooksLike:
      'A detector run against already-repaired data returns 0 whether or not it works. Indistinguishable from working, and reported as health.',
    binds: ['packages/operator-core/lib/scheduler/work-item-deps-integrity.ts'],
    provenance: ['work-item-dependency-edges-2026-08-02#D-019', 'work-item-dependency-edges-2026-08-02#D-020'],
  },
  {
    id: 'INV-13',
    area: 'observability',
    statement:
      "The detector distinguishes an endpoint that exists NOWHERE (stale ⇒ delete the edge) from one that exists under ANOTHER slug (⇒ re-point it).",
    violationLooksLike:
      'Both report as "resolves to nothing", so the natural repair (delete) destroys live dependencies. This nearly removed 8 real blocking edges on 2026-08-02.',
    binds: ['packages/operator-core/lib/scheduler/work-item-deps-integrity.ts'],
    provenance: ['EI-19374236094682800'],
  },
  {
    id: 'INV-14',
    area: 'observability',
    statement:
      'Every lane-guard bounce is recorded with its lane verdict, and a clear lane records nothing — so the bounce COUNT is the churn count.',
    violationLooksLike:
      'The bounce was invisible by construction: claim, check, release, return nothing, record nowhere. "Has churn dropped?" was unanswerable rather than merely hard, and any number reported for it was fabricated.',
    binds: ['packages/operator-core/lib/scheduler/claim-spec-store.ts'],
    provenance: ['work-item-dependency-edges-2026-08-02#D-020', 'WI-7141'],
  },
  {
    id: 'INV-15',
    area: 'observability',
    statement:
      'The SQL oracle and the maintained readiness sidecar agree for every item; disagreement is drift and is reported, never silently reconciled away.',
    violationLooksLike:
      'The cache says claimable, the oracle says blocked. Whichever the claim path consults wins, and the other is a latent second source of truth.',
    binds: ['packages/operator-core/lib/scheduler/readiness-reconcile.ts'],
    provenance: ['work-item-dependency-edges-2026-08-02#P-004'],
  },
] as const;

/** Total count, exported so a test can assert the registry did not silently shrink. */
export const DEPENDENCY_INVARIANT_COUNT = DEPENDENCY_INVARIANTS.length;

const BY_ID: ReadonlyMap<string, DependencyInvariant> = new Map(
  DEPENDENCY_INVARIANTS.map((i) => [i.id, i]),
);

/** Look one up by id. Returns undefined for an unknown id — callers decide whether that is fatal. */
export function getInvariant(id: string): DependencyInvariant | undefined {
  return BY_ID.get(id);
}

/** All invariants binding a given area. */
export function invariantsByArea(area: InvariantArea): readonly DependencyInvariant[] {
  return DEPENDENCY_INVARIANTS.filter((i) => i.area === area);
}

/**
 * Every invariant id that names `path` in its `binds` list.
 *
 * Substring match on purpose: `binds` entries carry a parenthetical for SQL
 * objects (e.g. 'libs/.../sql (work_item_is_blocked)'), so an exact compare
 * would silently return nothing for precisely the paths that matter most.
 */
export function invariantsBindingPath(path: string): readonly DependencyInvariant[] {
  return DEPENDENCY_INVARIANTS.filter((i) => i.binds.some((b) => b.includes(path) || path.includes(b)));
}

/** Matches `@covers INV-01`, `@covers INV-01, INV-02`, `@covers INV-01 INV-02`. */
const COVERS_RE = /@covers\s+((?:INV-\d+[\s,]*)+)/g;

/**
 * Extract the invariant ids a source text claims to cover.
 *
 * Deliberately a pure string function over text the CALLER read: it does no IO,
 * so it is unit-testable and cannot be blamed for a missing file. Unknown ids are
 * returned as-is — `unknownCoveredIds` is what separates a typo from a real claim,
 * and a typo'd citation must never read as coverage.
 */
export function coveredInvariants(source: string): readonly string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(COVERS_RE)) {
    for (const id of m[1].split(/[\s,]+/)) {
      if (id) found.add(id);
    }
  }
  return [...found].sort();
}

/** Cited ids that are not in the registry — a typo, or a renumbered invariant. */
export function unknownCoveredIds(source: string): readonly string[] {
  return coveredInvariants(source).filter((id) => !BY_ID.has(id));
}

/** Registry ids with no citation anywhere in `sources`. The coverage question, answered by name. */
export function uncoveredInvariantIds(sources: readonly string[]): readonly string[] {
  const covered = new Set<string>();
  for (const s of sources) for (const id of coveredInvariants(s)) covered.add(id);
  return DEPENDENCY_INVARIANTS.map((i) => i.id).filter((id) => !covered.has(id));
}
