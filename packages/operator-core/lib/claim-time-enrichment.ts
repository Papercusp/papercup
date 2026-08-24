/**
 * claim-time-enrichment — the ONE definition of the trap-guard set every claim
 * surface attaches, and the one place a new guard has to be wired.
 *
 * WI-41182. Six independent guards accumulated here over ~6 weeks, each added by
 * hand at whichever claim surfaces its author happened to be looking at. There
 * was no definition of "the set", so the honest answer to "which guards does a
 * claim carry?" was *it depends which verb you claimed with* — measured in source
 * before this module existed:
 *
 *   scheduler:get_next      6/6
 *   work_items:claim        6/6  (plus its own surface-specific hints)
 *   work_items:claim_next   5/6  — no planContradiction
 *   plan_items:claim        2/6  — no premises, retraction, authorship, planContradiction
 *
 * That drift is silent in both directions: an agent claiming through
 * `plan_items:claim` (the natural verb right after `coord:orient { planItems }`
 * declines to claim) got no premise check and no plan-says-done contradiction,
 * and nothing in the result said a guard had been skipped rather than passed.
 * WI-39498 is the zombie class planContradiction exists to stop — 9 successive
 * claimants on WI-36047 — and two of the four surfaces were still exposed to it.
 *
 * ⚠ THE POINT OF THIS MODULE IS THE REGISTRY, NOT THE CONVENIENCE. Adding a
 * seventh guard by hand at three surfaces and forgetting the fourth is exactly
 * how the four counts above diverged. `CLAIM_TIME_ENRICHMENT_LEGS` is what
 * `claim-time-enrichment-parity.test.ts` enumerates, so a leg added to the type
 * but not attached everywhere fails the build instead of shipping half-wired.
 *
 * ⚠ ADVISORY, TOTAL, NEVER THROWS. Every leg is independently fail-soft and the
 * result is a spreadable object with absent keys omitted, so this can never
 * change a claim's `ok` verdict or its payload shape. Saying nothing asserts
 * nothing — a swallowed read must never render as "the guard passed" (the
 * WI-6737 lesson: a null that means "the read failed" must not be read as a
 * null that means "there is nothing there"). Callers that need to distinguish
 * those two cases must do so at their own seam, as work_items:claim does for
 * its checkpoint hint.
 *
 * Surface-specific hints deliberately DO NOT live here: work_items:claim's
 * checkpoint hint, prior-work hint, concurrency, dependency blockers, suggested
 * watches and plan-lane collision are each a function of that surface's own
 * arguments or of state only it has resolved. This module holds exactly the legs
 * that are a pure function of the claimed subject, which is what makes them the
 * set that SHOULD be identical everywhere.
 */


import type { ClaimTimeStalePathHint } from './stale-path-hints-claim-port';

/**
 * The registry. Order is the order the guards were added; it carries no meaning
 * beyond keeping diffs small.
 *
 * ⚠ Adding a member here without attaching it in `buildClaimTimeEnrichment`
 * fails the parity test by design — that failure IS the wiring reminder.
 */
export const CLAIM_TIME_ENRICHMENT_LEGS = [
  'planDecisions',
  'priorAttemptBrief',
  'premises',
  'retraction',
  'authorship',
  'planContradiction',
  // P-011: WHICH promises a claimed item is on the hook for, at WHICH revision.
  // Registered here only once all four surfaces attach it — the three hand-wiring
  // surfaces call `getClaimTimeBehaviorContract` directly, plan_items:claim gets it
  // by delegating to this port. Registering earlier would have made the parity guard
  // assert a coverage the tree did not have.
  'behaviorContract',
  // EI-21267393427094356: which stored payload paths are dead at HEAD, and where
  // each moved to — a bounded git rename walk at the moment of the claim.
  'pathHints',
] as const;

export type ClaimTimeEnrichmentLeg = (typeof CLAIM_TIME_ENRICHMENT_LEGS)[number];

/**
 * The claimed subject. Every field is optional because the four surfaces resolve
 * different amounts of the row: `scheduler:get_next` and `work_items:claim` hold
 * a full work-item, while `plan_items:claim`'s bare (non-converting) path holds
 * only a plan pointer and no work-item at all. A leg whose inputs are absent
 * returns nothing rather than guessing — see `buildClaimTimeEnrichment`.
 */
export interface ClaimTimeEnrichmentSubject {
  id?: string | null;
  payload?: unknown;
  harness?: string | null;
  title?: string | null;
  summary?: string | null;
  state?: string | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
}

/**
 * The decoration. Field names are load-bearing: they are the names the four
 * surfaces already emitted, so rewiring them onto this port is a pure
 * de-duplication with no change to any caller's observed payload.
 */
export interface ClaimTimeEnrichment {
  planDecisions?: unknown;
  planDecisionsNote?: string;
  priorAttemptBrief?: unknown;
  premises?: unknown;
  retractionWarning?: string;
  authorshipRevalidation?: unknown;
  authorshipRevalidationWarning?: string;
  planItemContradiction?: unknown;
  planItemContradictionWarning?: string;
  /**
   * P-011: WHICH behavior clauses this item is on the hook for, at WHICH revision.
   * ⚠ ADVISORY (D-017) — the resolver reports; P-013 owns turning any of it into a
   * refusal. A consumer must not render it as a blocker.
   */
  behaviorContract?: unknown;
  behaviorContractNote?: string;
  /**
   * EI-21267393427094356: stored payload paths that no longer exist at HEAD, each
   * resolved to its current location when git can follow the renames. Advisory:
   * the claimant works from resolvedTo instead of taking the stored hint literally
   * and falling back to a repository-wide search.
   */
  pathHints?: ClaimTimeStalePathHint[];
  pathHintsNote?: string;
}

export interface ClaimTimeEnrichmentOpts {
  /** The claimed work-item, when the surface has one. */
  workItem?: ClaimTimeEnrichmentSubject | null;
  /** Explicit plan pointer — `plan_items:claim` knows these from its own args. */
  planSlug?: string | null;
  planItemId?: string | null;
  harness?: string | null;
  workspaceId?: string | null;
}

/**
 * Run every registered guard against the claimed subject, in parallel.
 *
 * Parallel because the legs are independent reads with no ordering between them;
 * serial would pay six round-trips on the one call an agent is waiting on before
 * it can start work. Each leg is separately `.catch`ed so one slow or broken
 * guard cannot take down the other five — or the claim.
 */
export async function buildClaimTimeEnrichment(opts: ClaimTimeEnrichmentOpts): Promise<ClaimTimeEnrichment> {
  const wi = opts.workItem ?? null;
  const harness = wi?.harness ?? opts.harness ?? null;
  const workspaceId = opts.workspaceId ?? undefined;
  const workItemId = wi?.id ?? null;
  // The behavior-contract resolver needs an id to read explicit edges. Keep the
  // partial-subject contract for the other legs, but only expose an identified
  // subject to this leg so an absent id cannot become a fabricated lookup key.
  const behaviorContractWorkItem = wi?.id ? { ...wi, id: wi.id } : null;

  const [
    planDecisions,
    priorAttemptBrief,
    premises,
    retractionWarning,
    authorship,
    planContradiction,
    behaviorContract,
    pathHintsEntry,
  ] = await Promise.all([
      // What OTHERS ruled that governs this item. Available from either a
      // work-item payload stamp or an explicit plan pointer.
      import('./plan-decisions-claim-port')
        .then(async (m) => {
          // Takes both keys; the port prefers an explicit `planSlug` and falls
          // back to deriving one from the work-item payload stamp, so passing
          // whichever the surface has (or both) is correct.
          const brief = await m.getClaimTimePlanDecisions({
            ...(opts.planSlug ? { planSlug: opts.planSlug } : {}),
            ...(wi ? { workItem: { payload: wi.payload } } : {}),
            harness,
            workspaceId,
          });
          return brief ? { planDecisions: brief.decisions, planDecisionsNote: m.renderPlanDecisionsNote(brief) } : null;
        })
        .catch(() => null),

      // What was already TRIED on this lane. The only leg that works from a bare
      // plan pointer with no work-item, which is why `plan_items:claim` had it.
      import('./prior-attempt-context')
        .then((m) =>
          m.getClaimTimePriorAttemptBrief({
            ...(opts.planSlug ? { planSlug: opts.planSlug } : {}),
            ...(opts.planItemId ? { planItemId: opts.planItemId } : {}),
            // Passed explicitly (not omitted-when-absent like its siblings): the
            // port resolves `opts.workItemId ?? opts.workItem?.id ?? <synthetic>`,
            // so an explicit null still falls through to the work-item's own id
            // when there is one — while on the bare plan-item path it STATES that
            // no work-item exists, rather than leaving that to be inferred from a
            // missing key.
            workItemId,
            ...(wi
              ? {
                  workItem: {
                    ...(wi.id ? { id: wi.id } : {}),
                    payload: wi.payload,
                    harness: wi.harness,
                    sourcePlanSlug: wi.sourcePlanSlug,
                    sourcePlanItemIds: wi.sourcePlanItemIds,
                  },
                }
              : {}),
            harness,
          }),
        )
        .then((brief) => (brief ? { priorAttemptBrief: brief } : null))
        .catch(() => null),

      // What THIS item's own text assumes. An unverified absence premise ("X does
      // not exist yet") is the measured way a claimant rebuilds something that is
      // already there, so this fires on the item's own body, not on history.
      wi
        ? import('./premises-claim-port')
            .then((m) =>
              m.getClaimTimePremises({
                workItem: { id: wi.id, payload: wi.payload, title: wi.title, summary: wi.summary },
                harness,
                workspaceId,
              }),
            )
            .then((brief) => (brief ? { premises: brief } : null))
            .catch(() => null)
        : Promise.resolve(null),

      // Whether a finding this item rests on has since been RETRACTED in its own
      // thread. Needs a live (non-settled) work-item row.
      wi
        ? import('./agent-tools/work_items/retraction-advisory')
            .then((m) => m.getClaimTimeRetractionAdvisory(wi, harness))
            .then((advisory) => (advisory ? { retractionWarning: advisory.retractionWarning } : null))
            .catch(() => null)
        : Promise.resolve(null),

      // Whether the item's stated author is still the right one to revalidate it.
      workItemId
        ? import('./work-item-prior-work')
            .then(async (m) => {
              const hint = await m.getClaimTimeAuthorshipRevalidationHint({
                harness,
                workItemId,
                workspaceId,
              });
              const warning = m.authorshipRevalidationWarning(hint);
              return hint && warning
                ? { authorshipRevalidation: hint, authorshipRevalidationWarning: warning }
                : null;
            })
            .catch(() => null)
        : Promise.resolve(null),

      // WI-39498: the plan says this is already DONE while the row is still open,
      // so the work may already be finished. The zombie guard.
      workItemId
        ? import('./work-item-plan-contradiction')
            .then(async (m) => {
              const hint = await m.getClaimTimePlanItemContradiction({ workItemId, payload: wi?.payload });
              const warning = m.planItemContradictionWarning(hint, workItemId);
              return hint && warning
                ? { planItemContradiction: hint, planItemContradictionWarning: warning }
                : null;
            })
            .catch(() => null)
        : Promise.resolve(null),

      // P-011: WHICH promises this item is on the hook for, at WHICH revision.
      //
      // The claimant is exactly who needs this and the claim is exactly when — until
      // now the resolved contract was legible only to the COMPLETION gate, so an agent
      // discovered which clauses it had to satisfy by being REFUSED at the end, after
      // the work was done. Same port the gate uses (`resolveWorkItemBehaviorContract`),
      // so what a claimant is told cannot drift from what they will be held to.
      //
      // ⚠ ADVISORY (D-017): reported, never enforced here. P-013 owns any refusal.
      // Needs a live work-item — a bare plan-item claim has no item to resolve edges for.
      behaviorContractWorkItem
        ? import('./behavior-contract-claim-port')
            .then((m) => m.getClaimTimeBehaviorContract(behaviorContractWorkItem, harness))
            .catch(() => null)
        : Promise.resolve(null),

      // EI-21267393427094356: which stored payload paths are dead at HEAD, and where
      // each moved to. Hints freeze at filing time while modules relocate (hive/* →
      // pot/* being the measured instance); without this resolution the claimant's
      // literal affected-path check fails into a repository-wide fallback search.
      // Needs a work-item payload — a bare plan-item claim carries none.
      wi?.payload
        ? import('./stale-path-hints-claim-port')
            .then(async (m) => {
              const hints = await m.getClaimTimeStalePathHints({ payload: wi.payload });
              // `stalePathHintsNote` returns string | null; ClaimTimeEnrichment's
              // optional field is `string | undefined`, and a null would be spread
              // onto the result as a present-but-null key. Coerce so an absent note
              // is genuinely absent.
              return hints
                ? { pathHints: hints, pathHintsNote: m.stalePathHintsNote(hints) ?? undefined }
                : null;
            })
            .catch(() => null)
        : Promise.resolve(null),
    ]);

  return {
    ...(planDecisions ?? {}),
    ...(priorAttemptBrief ?? {}),
    ...(premises ?? {}),
    ...(retractionWarning ?? {}),
    ...(authorship ?? {}),
    ...(planContradiction ?? {}),
    ...(behaviorContract ?? {}),
    ...(pathHintsEntry ?? {}),
  };
}
