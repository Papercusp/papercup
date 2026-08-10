/**
 * THE DEAD-DERIVED-SIGNAL CENSUS — the runtime half of the detector D-088 asked
 * for (auto-coupling-delivery-and-correctness-2026-08-09 P-007).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The agent-state plane already ships three probes and NONE of them can see a
 * dead DERIVED signal:
 *
 *   · check-plane-producers.mjs   — is the FIELD written?      (a DB column fact)
 *   · check-declared-consumed.mjs — is the field READ in source? (a static fact)
 *   · check-plane-adoption.mjs    — does an AGENT ever call it? (a call count)
 *
 * A derived coupling relation has no column (so the census is blind to it), is
 * plainly read in source (so the sweep is green), and its enclosing TOOL does get
 * called (so the adoption probe is green) — while the relation itself emits
 * nothing, ever. Three green ticks over a dead signal.
 *
 * That is not hypothetical; it has now happened TWICE to the same dimension of
 * this same feature, and both times a human found it by hand-querying live data:
 *
 *   · `current_files` — a real roster field, 119 live rows, ZERO populated
 *     (EI-18772330418885814). The `shared-file` relation reads a field nothing
 *     writes.
 *   · `holds-a-lock-on` — introduced specifically to REPLACE that dead signal,
 *     and just as dead for a different reason: it silently inherited an unrelated
 *     flag's gate, so its input leg required `include_coupling` AND
 *     `include_detail`, a combination passed ZERO times in the entire retained
 *     history. Shipped, tested, documented, and silent for 12 days (D-088).
 *
 * Every unit test passed throughout, both times, because the fixtures supply the
 * input directly — which is exactly the blind spot: a test proves the derivation
 * is CORRECT GIVEN INPUT and can say nothing about whether production ever hands
 * it any.
 *
 * ── THE LOAD-BEARING DISTINCTION: `armed` IS NOT `emitted` ───────────────────
 *
 * A bare firing count cannot tell these two apart, and they have opposite
 * remedies:
 *
 *   · the leg was never WIRED into the call     → a dead gate. A code defect.
 *                                                 (`holds-a-lock-on`'s shape)
 *   · the leg was wired, ran, and had nothing   → honest scarcity, or a dead
 *     to work with                                UPSTREAM producer.
 *                                                 (`current_files`'s shape)
 *
 * So the census records both, per relation, per run: whether the input was
 * SUPPLIED (`armed`), how much input it delivered (`inputs`), and how many edges
 * actually reached the caller (`edges`). `scripts/check-derived-signal-firings.mjs`
 * turns a window of these into the verdict.
 *
 * ── WHY IT SHIPS ON `tool_invocations.metadata_json` ────────────────────────
 *
 * Deliberately no new table, no migration and no new write path: the per-call
 * structured metadata channel already exists, is heavily used (75k+ rows carrying
 * it in three days, measured 2026-08-09), and already carries retention,
 * indexing and workspace scoping. A dead-signal detector that needed a whole new
 * durable surface of its own would be the reuse-first smell this repo's own guide
 * names — and a new surface nobody writes to is the very failure being detected.
 */
import { DERIVED_COUPLING_RELATIONS, type DerivedCoupling, type DerivedCouplingRelation } from './couplings';

/** Schema tag on the emitted record, so a reader can tell a census apart from any
 *  other metadata and a future shape change is detectable rather than silent. */
export const DERIVED_SIGNAL_CENSUS_VERSION = 1;

/** The key this census is published under inside `tool_invocations.metadata_json`. */
export const DERIVED_SIGNAL_CENSUS_KEY = 'derivedSignals';

/** The INPUTS the derivation computes its relations from. */
export type DerivedSignalLeg = 'roster' | 'heldFiles' | 'planEdges' | 'recentPartners';

/**
 * Which input each derived relation is computed FROM.
 *
 * ⚠ THIS IS A RECURRENCE GUARD, not a lookup table. `satisfies Record<
 * DerivedCouplingRelation, …>` makes it a TYPE ERROR to add a relation to
 * `DERIVED_COUPLING_RELATIONS` without declaring the input it depends on — so a
 * new derived signal cannot be born unobservable, which is the condition that
 * produced both incidents above.
 */
export const DERIVED_SIGNAL_LEGS = {
  'holds-a-lock-on': 'heldFiles',
  awaits: 'roster',
  'blocks-me': 'planEdges',
  'blocked-by-me': 'planEdges',
  'coord-exchange': 'recentPartners',
} as const satisfies Record<DerivedCouplingRelation, DerivedSignalLeg>;

/** What one input leg did on one run. */
export interface DerivedSignalLegState {
  /**
   * The input was SUPPLIED to this call at all — i.e. the gate that decides
   * whether the signal can fire was reachable. This is the bit that was silently
   * `false` on every production call for 12 days (D-088).
   */
  armed: boolean;
  /** How many input rows the leg actually delivered (0 is meaningful, not absent). */
  inputs: number;
}

/** One relation's observation on one run. */
export interface DerivedSignalObservation {
  armed: boolean;
  inputs: number;
  /** Edges that actually REACHED the caller — post-filter, never the raw emit. */
  edges: number;
}

export interface DerivedSignalCensus {
  v: number;
  relations: Record<string, DerivedSignalObservation>;
}

function countEdgesByRelation(emitted: readonly DerivedCoupling[]): Map<string, number> {
  const byRelation = new Map<string, number>();
  for (const edge of emitted) {
    const relation = edge?.relation;
    if (typeof relation !== 'string' || !relation) continue;
    byRelation.set(relation, (byRelation.get(relation) ?? 0) + 1);
  }
  return byRelation;
}

/**
 * Census one derivation run. PURE (legs + emitted edges -> record), so every
 * branch is testable with no database and no presence snapshot.
 *
 * ⚠ `emitted` MUST be the FILTERED result — the edges that actually reach the
 * caller — never the pre-filter union. An edge dropped by the roster access
 * boundary was never delivered to anybody, and counting it as a firing would
 * report a signal as alive on the strength of output nobody received.
 *
 * EVERY relation appears in the output, including the ones at zero. A census that
 * omitted its zeros would be unable to report the only thing it exists to report.
 */
export function censusDerivedSignals(
  legs: Readonly<Record<DerivedSignalLeg, DerivedSignalLegState>>,
  emitted: readonly DerivedCoupling[],
): DerivedSignalCensus {
  const byRelation = countEdgesByRelation(emitted);
  const relations: Record<string, DerivedSignalObservation> = {};
  for (const relation of DERIVED_COUPLING_RELATIONS) {
    const leg = legs[DERIVED_SIGNAL_LEGS[relation]];
    relations[relation] = {
      armed: leg?.armed === true,
      inputs: Number.isFinite(leg?.inputs) ? Math.max(0, Math.trunc(leg!.inputs)) : 0,
      edges: byRelation.get(relation) ?? 0,
    };
  }
  return { v: DERIVED_SIGNAL_CENSUS_VERSION, relations };
}
