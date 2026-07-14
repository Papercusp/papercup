/**
 * cold-boot-drill — the carry-sufficiency GRADER for P-020 (deterministic-context-
 * carry-2026-07-14, Phase 7 — cold-auto expansion).
 *
 * P-020: "periodically force a cold resume on a live session class and grade carry
 * sufficiency (what did the successor have to search for?) — chaos-engineering for
 * tracking." It is the CONSUMER-SIDE complement to P-019's producer-side miss-rate:
 * P-019 asks "did stage-1 drop material at the compaction boundary?"; P-020 asks
 * "did the cold successor actually have to SEARCH BACK for state the carry should
 * have carried?" — the stronger evidence, because it is what the successor really
 * needed, not what a grader guessed it might.
 *
 * P-026 pins the metric and the interpretation: "what successors had to search for;
 * a needed recall fold = a BUILDER gap to fix, not a reason to keep the fold" — with
 * live evidence that post-compaction orient auto-recall hits at 0.023–0.033 cosine
 * are NOISE. So a cold successor's recovery lookup is graded against the carry's
 * RESPONSIBILITIES: a search-back for CARRY-CLASS state (identity, held-WI, loop
 * note, facts, walls, plan state, recent tail, an owner directive) is a builder gap;
 * a cross-session mem0 lookup is ORTHOGONAL (mem0 is not a compaction responsibility,
 * P-026 keeps it); a sub-noise-floor recall fold proves nothing.
 *
 * Split exactly like residual-carry-pass.ts (P-019) / carry-respawn.ts (P-018) /
 * maintenance-carry.ts (P-017): the PURE grader + scorer live + are unit-tested
 * here; the LIVE legs — the chaos ACTUATION that forces a cold resume on a live
 * session, and the trace-extraction that turns a successor's post-resume tool calls
 * into {@link RecoveryLookup} records — need a running host, ride the actual drill
 * rollout, and land DEFAULT-OFF (a drill that kills a live session is opt-in and
 * rate-limited). This grader is the reusable heart both the live drill AND its tests
 * share, and the `sufficient`-per-class verdict is what P-021 (cold-by-default once
 * drills pass) and P-026 (retire the hole-patch auto-recall fold) consume.
 */

/** Carry slots the deterministic builder (P-009/P-010/P-011) is RESPONSIBLE for.
 *  A cold successor searching back for one of these is a candidate builder gap. */
export type CarryClass =
  | 'identity'
  | 'held-wi'
  | 'loop-note'
  | 'facts'
  | 'walls'
  | 'plan-state'
  | 'recent-tail'
  | 'owner-directive';

export const CARRY_CLASSES: ReadonlySet<CarryClass> = new Set<CarryClass>([
  'identity',
  'held-wi',
  'loop-note',
  'facts',
  'walls',
  'plan-state',
  'recent-tail',
  'owner-directive',
]);

/** The kind of recovery lookup a cold successor made in its first window. */
export type RecoveryKind =
  | 'self-search' // sessions:search { session:'self' } — the canonical "I lost it" signal
  | 'self-read' // sessions:read { session:'self' } — reading own tail
  | 'reread-state' // re-fetching a WI / plan / file the carry should have summarized
  | 'mem0-search' // cross-session memory:search — ORTHOGONAL to compaction (P-026)
  | 'orient-recall-fold' // an auto-recall hit folded into the post-compaction orient
  | 'other';

/**
 * The similarity below which an orient auto-recall fold is NOISE and proves nothing
 * about carry sufficiency (P-026 live evidence: 0.023–0.033 observed). A fold at or
 * above it that targets a carry-class is a builder gap (the builder should have
 * carried that typed state, not left it to a speculative recall).
 */
export const RECALL_NOISE_FLOOR = 0.05;

/** One recovery lookup the LIVE trace-extraction emits from a cold successor. */
export interface RecoveryLookup {
  kind: RecoveryKind;
  /** Which carry slot the lookup was recovering, if the extraction could classify it. */
  targetClass?: CarryClass | null;
  /** True when the recovered content was ALREADY present in the carry document — the
   *  successor searched anyway (a SURFACING gap: carried but not salient), vs a hard
   *  gap where the carry lacked it entirely. */
  recoveredInCarry?: boolean;
  /** For 'orient-recall-fold': the recall's cosine similarity (noise-floor gate). */
  similarity?: number;
}

/** How one recovery lookup grades against the carry's responsibilities. */
export type GapVerdict =
  | 'gap' // carry-class state the carry lacked → a builder gap to fix
  | 'surfacing-gap' // carry-class state the carry HAD but did not surface saliently
  | 'orthogonal' // not a compaction responsibility (cross-session mem0, genuine fresh work)
  | 'noise'; // a sub-noise-floor recall fold — proves nothing

/**
 * Grade one recovery lookup. PURE + exported for direct test. The core judgement:
 * a search-back for CARRY-CLASS state is a builder gap (hard if the carry lacked it,
 * surfacing if it had it); cross-session mem0 and non-carry-class lookups are
 * orthogonal; a sub-noise-floor recall fold is noise.
 */
export function classifyRecoveryLookup(lookup: RecoveryLookup): GapVerdict {
  const targetClass = lookup.targetClass ?? null;
  const isCarryClass = targetClass !== null && CARRY_CLASSES.has(targetClass);

  if (lookup.kind === 'mem0-search') return 'orthogonal'; // mem0 is orthogonal to compaction

  if (lookup.kind === 'orient-recall-fold') {
    const sim = typeof lookup.similarity === 'number' ? lookup.similarity : 0;
    if (sim < RECALL_NOISE_FLOOR) return 'noise'; // P-026: sub-floor recall proves nothing
    // A fold that actually mattered AND targets a carry slot = a builder gap (carry it
    // as typed state, don't lean on speculative recall). Above-floor but non-carry =
    // legitimate cross-session enrichment.
    return isCarryClass ? 'gap' : 'orthogonal';
  }

  // self-search / self-read / reread-state / other: a carry-class target is a gap.
  if (!isCarryClass) return 'orthogonal';
  return lookup.recoveredInCarry === true ? 'surfacing-gap' : 'gap';
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-class carry-sufficiency scorer (drives P-021 cold-by-default + P-026)
// ─────────────────────────────────────────────────────────────────────────────

export interface CarrySufficiencyParams {
  /** Max builder gaps per drill that still counts as "carry proven" (default 0). */
  maxGapsPerDrill: number;
  /** Minimum drills for a class before a `sufficient` verdict is allowed. */
  minDrills: number;
  /** Count surfacing-gaps (carried-but-not-salient) toward the gap total. Default
   *  true — conservative: a search-back the carry could have prevented is a signal
   *  to improve the carry, even when the state was technically present. */
  countSurfacingGaps: boolean;
}

export const DEFAULT_SUFFICIENCY_PARAMS: CarrySufficiencyParams = {
  maxGapsPerDrill: 0,
  minDrills: 10,
  countSurfacingGaps: true,
};

/** One cold-resume drill: the recovery lookups its successor made. */
export interface DrillSample {
  sessionClass: string;
  lookups: RecoveryLookup[];
}

export interface ClassSufficiency {
  sessionClass: string;
  drills: number;
  /** Hard builder gaps (carry lacked the state). */
  gaps: number;
  /** Surfacing gaps (carry had it, successor searched anyway). */
  surfacingGaps: number;
  /** Gaps counted per the params (hard + optionally surfacing) ÷ drills. */
  gapsPerDrill: number;
  /** True ⇒ the carry is proven for this class: enough drills, gaps within bound.
   *  P-021 flips the class cold-by-default; P-026 retires its hole-patch recall. */
  sufficient: boolean;
}

export interface CarrySufficiencyReport {
  perClass: ClassSufficiency[];
  params: CarrySufficiencyParams;
  /** Classes whose carry is proven — the ones P-021/P-026 may act on. */
  sufficientClasses: string[];
}

/**
 * Grade a batch of cold-boot drills into a per-class carry-sufficiency report. PURE.
 * A class's carry is `sufficient` when it has ≥ minDrills drills and its counted
 * gaps-per-drill is ≤ maxGapsPerDrill. Noise and orthogonal lookups never count;
 * surfacing-gaps count only when countSurfacingGaps is set.
 */
export function gradeColdBootDrills(
  samples: DrillSample[],
  params: CarrySufficiencyParams = DEFAULT_SUFFICIENCY_PARAMS,
): CarrySufficiencyReport {
  const byClass = new Map<string, { drills: number; gaps: number; surfacing: number }>();

  for (const s of samples) {
    if (!s || typeof s.sessionClass !== 'string' || !s.sessionClass) continue;
    const agg = byClass.get(s.sessionClass) ?? { drills: 0, gaps: 0, surfacing: 0 };
    agg.drills += 1;
    for (const lookup of s.lookups ?? []) {
      const verdict = classifyRecoveryLookup(lookup);
      if (verdict === 'gap') agg.gaps += 1;
      else if (verdict === 'surfacing-gap') agg.surfacing += 1;
    }
    byClass.set(s.sessionClass, agg);
  }

  const perClass: ClassSufficiency[] = [];
  for (const [sessionClass, agg] of byClass) {
    const counted = agg.gaps + (params.countSurfacingGaps ? agg.surfacing : 0);
    const gapsPerDrill = agg.drills > 0 ? counted / agg.drills : Infinity;
    const sufficient = agg.drills >= params.minDrills && gapsPerDrill <= params.maxGapsPerDrill;
    perClass.push({
      sessionClass,
      drills: agg.drills,
      gaps: agg.gaps,
      surfacingGaps: agg.surfacing,
      gapsPerDrill,
      sufficient,
    });
  }
  perClass.sort((a, b) => a.sessionClass.localeCompare(b.sessionClass));

  return {
    perClass,
    params,
    sufficientClasses: perClass.filter((c) => c.sufficient).map((c) => c.sessionClass),
  };
}
