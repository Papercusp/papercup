/**
 * acceptance-grading-authority — which of several grading cards the acceptance
 * gate is entitled to read as THE grading
 * (unified-responder-selection-critique-and-grading-2026-08-30 P-004).
 *
 * WHY THIS EXISTS. Until D-002/D-003 of that plan, acceptance grading was n=1:
 * exactly one grader, so the gate's pick — `complete.filter(non-implementer)
 * .sort(desc createdAt)[0]` at `plan-acceptance-gate.ts` — had nothing to
 * choose between and its latest-wins ordering was inert. Two rulings changed
 * that together:
 *
 *  - D-003 [owner] made grading a CASCADE of up to two graders, where grader 2
 *    is woken holding grader 1's card. That is what makes latest-wins coherent
 *    rather than arbitrary: the latest card is also the most-informed one.
 *  - D-002 [owner] replaced the below-floor fresh-mint with MINIMUM-FILL, so
 *    the menu may contain a grader who did NOT clear the relevance floor,
 *    labelled `via:'minimum'`.
 *
 * Combined, they leave one residual that D-003 names explicitly: grader 2 can
 * be the below-floor pick, and unqualified latest-wins would then hand the
 * verdict to the less-qualified party. This module is that residual's fix — the
 * gate ranks by SELECTION AUTHORITY first (`outranks` from
 * `@papercusp/ranked-selection`, the generic kernel of "a below-floor
 * participant must not silently supersede a qualified one") and only then by
 * recency.
 *
 * TWO THINGS THIS MODULE IS DELIBERATE ABOUT.
 *
 * 1. THE DURABLE ROW IS THE AUTHORITY, NOT THE LIFECYCLE (D-006). `via` exists
 *    in two places: `AcceptanceGraderLifecycle.graders[].via`, which is a
 *    return value nobody persists, and `routing.selection.selected[].via` on
 *    the grading cascade's `harness_shared.consult_state` row, which survives
 *    the process that selected it. The gate runs long after selection — often
 *    in a different process entirely — so only the row can answer it.
 *
 * 2. UNKNOWN IS NOT 'minimum'. A card whose author appears in no grading
 *    cascade row — an owner-filed card, a card predating the cascade, a card
 *    from a hand-dispatched grader, or any card at all when the row read fails
 *    — is ranked as if it cleared the floor. Only a card KNOWN to have come
 *    from a below-floor fill may lose authority. The opposite default would let
 *    an unreadable row silently demote a legitimate grading and strand a
 *    shippable plan, which is the more expensive error and the harder one to
 *    diagnose.
 */
import { getOrgPg } from '@papercusp/db-org';
import { outranks, type SelectionVia } from '@papercusp/ranked-selection';
import { GRADING_CASCADE_FLAVOR } from './consult/grading-cascade';

/** The `via` labels the selector emits. Anything else on a row is treated as
 * unknown rather than coerced — a future third label must be ranked
 * deliberately, not silently folded into one of these two. */
const KNOWN_VIA: ReadonlySet<string> = new Set<SelectionVia>(['floor', 'minimum']);

/**
 * Fold the persisted selection provenance of one or more grading cascade rows
 * into `graderOwnerId → via`. Pure: the caller supplies the routing snapshots.
 *
 * WHEN ONE GRADER APPEARS TWICE, THE BEST LABEL WINS. A re-grade after a reject
 * opens a second cascade over the same rubric, and a peer who cleared the floor
 * in one round can be a minimum-fill in another (the pool shrinks — D-006
 * records that answering a grading makes you an excluded heavy consult
 * participant for later rounds on the same plan). Demotion is a claim that must
 * be earned; a grader who cleared the floor in any round has earned the
 * opposite, so ambiguity resolves upward.
 */
export function graderSelectionVia(routingSnapshots: readonly unknown[]): Map<string, SelectionVia> {
  const byOwner = new Map<string, SelectionVia>();
  for (const routing of routingSnapshots) {
    const selected = (routing as { selection?: { selected?: unknown } } | null | undefined)?.selection?.selected;
    if (!Array.isArray(selected)) continue;
    for (const entry of selected) {
      const ownerId = (entry as { ownerId?: unknown } | null)?.ownerId;
      const via = (entry as { via?: unknown } | null)?.via;
      if (typeof ownerId !== 'string' || ownerId === '') continue;
      if (typeof via !== 'string' || !KNOWN_VIA.has(via)) continue;
      const current = byOwner.get(ownerId);
      if (current == null || outranks(via as SelectionVia, current)) byOwner.set(ownerId, via as SelectionVia);
    }
  }
  return byOwner;
}

/** How many grading cascade rows one rubric's authority read looks back over.
 * A rubric accumulates one row per grading round (open → graded → closed →
 * re-grade after a reject). Bounded because the map is only ever consulted for
 * authors of cards that are already in hand; a grader from an eighth-round-ago
 * cascade whose card still stands is a shape nothing else in the gate survives
 * either. */
export const GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS = 8;

/**
 * Read the durable selection provenance for a rubric's grading cascade(s).
 *
 * ⚠ DELIBERATELY DOES NOT FILTER `closed_at IS NULL`, unlike the two other
 * readers of these rows (`prodOpenGradingCascade`'s idempotency probe and
 * `advanceGradingCascadeOnCard`, both in `acceptance-grader.ts`). Those two ask
 * "is a cascade LIVE?" and must ignore finished ones. This asks "how was the
 * author of this card selected?", and by the time the gate runs the cascade has
 * usually done its job and closed. Copying the liveness predicate here would
 * make the map empty in exactly the common case, and — because unknown ranks as
 * 'floor' — the failure would present as the gate silently reverting to the
 * pre-P-004 latest-wins it was built to replace, with nothing red anywhere.
 *
 * FAIL-SOFT. A read fault yields an empty map, which ranks every card as
 * floor-qualified: the pre-P-004 behaviour. That is the status quo rather than
 * a new hazard, and it is the right direction for a gate whose other failure
 * mode is refusing every ship in the workspace over a transient database fault.
 */
export async function readGraderSelectionVia(
  workspaceId: string,
  rubricId: string,
): Promise<Map<string, SelectionVia>> {
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT routing
        FROM harness_shared.consult_state
       WHERE workspace_id = ${workspaceId}
         AND routing -> 'cascade' ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
         AND routing -> 'cascade' ->> 'rubricId' = ${rubricId}
       ORDER BY created_at DESC
       LIMIT ${GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS}
    `) as unknown as Array<{ routing: unknown }>;
    return graderSelectionVia((rows ?? []).map((r) => r?.routing));
  } catch {
    return new Map();
  }
}

/** A grading card, reduced to what ranking needs. */
export interface RankableGrading {
  createdBy?: string | null;
  createdAt: string;
}

/**
 * Order grading cards by the authority of HOW their author was selected, then
 * by recency — the comparator behind the gate's pick.
 *
 * `outranks` is the kernel rather than an inline `via === 'minimum'` test on
 * purpose: the rule "a below-floor participant must not silently supersede a
 * qualified one" is owned by `@papercusp/ranked-selection` alongside the label
 * it ranks, so a third `via` gains its ordering in one place instead of in
 * every consumer that thought it knew the whole union.
 */
export function compareGradingAuthority<T extends RankableGrading>(
  viaOf: (card: T) => SelectionVia | null,
): (a: T, b: T) => number {
  return (a, b) => {
    // Unknown ranks with 'floor': see this module's header — only a card KNOWN
    // to be a below-floor fill is demoted.
    const va = viaOf(a) ?? 'floor';
    const vb = viaOf(b) ?? 'floor';
    if (outranks(va, vb)) return -1;
    if (outranks(vb, va)) return 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  };
}

/**
 * The one grading card no other card outranks — the gate's `independent` pick.
 * Returns `undefined` for an empty list, mirroring the `[0]` it replaces.
 */
export function pickAuthoritativeGrading<T extends RankableGrading>(
  cards: readonly T[],
  viaOf: (card: T) => SelectionVia | null,
): T | undefined {
  return cards.slice().sort(compareGradingAuthority(viaOf))[0];
}

/** Resolve one card's selection provenance against a map from
 * {@link readGraderSelectionVia}. `null` means "not attributable to a cascade
 * selection", which ranks as floor and is reported as such — never asserted to
 * BE floor. */
export function gradingViaOf(
  card: RankableGrading,
  byOwner: ReadonlyMap<string, SelectionVia>,
): SelectionVia | null {
  return (card.createdBy != null ? byOwner.get(card.createdBy) : undefined) ?? null;
}
