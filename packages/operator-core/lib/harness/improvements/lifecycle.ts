/**
 * Idea lifecycle state machine — P-030/P-031 from self-learning-central-2026-06-06.
 *
 * Tracks the journey of a captured idea from initial capture through verification.
 * Distinct from work-item.state (which is todo/done/etc for regular tasks).
 *
 * Idea lifecycle (on payload.ideaLifecycle):
 * - `open` — just captured, waiting for Queen triage
 * - `triaged` — Queen decided (do/gate/verify/reject)
 * - `applied` — idea implemented (issue resolved/closed)
 * - `verified` — friction signature stopped recurring (decay ≥ 14 days, product class)
 * - `recurred` — friction signature re-surfaced (watchdog filed regression)
 *
 * Recurrence-decay (P-030) is the outcome edge for PRODUCT-class ideas:
 * - If the friction signature stops recurring after implementation → "it worked"
 * - If it re-surfaces → reopen as regression (watchdog re-files with source: 'recurrence')
 *
 * The process/prompt class uses gym A/B instead (D-003).
 */

import type { IdeaType } from './triage';

export type IdeaLifecycleState =
  | 'open'
  | 'triaged'
  | 'applied'
  | 'verified'
  | 'recurred';

export interface IdeaLifecyclePayload {
  /** Current lifecycle state */
  state: IdeaLifecycleState;
  /** When state was set */
  stateUpdatedAt: string;
  /** The Queen's triage decision (if triaged) */
  triageDecision?: 'place' | 'gate' | 'gym' | 'reject';
  /** Reason for the decision */
  triageReason?: string;
  /** The D-005 routing taxonomy (consume-edges P-021). Rows persisted before the
   *  taxonomy landed may carry the legacy 'product'/'process' strings — 'product'
   *  keeps its decay behavior; 'process' is inert (never decay-verified), same as
   *  before. The one-time retriage rewrites OPEN items to the new vocabulary. */
  ideaType?: IdeaType;
  /** For recurrence tracking: the original idea ID (if this is a recurrence) */
  originalIdeaId?: string;
  /** Decay result (for product class, after verification) */
  decayResult?: 'worked' | 'regressed';
  /** Days since last seen (for decay analysis) */
  decayDays?: number;
}

/**
 * Initialize an idea's lifecycle on capture.
 */
export function initializeIdeaLifecycle(): IdeaLifecyclePayload {
  return {
    state: 'open',
    stateUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Update an idea's lifecycle state with optional context.
 */
export function updateIdeaLifecycle(
  current: IdeaLifecyclePayload,
  newState: IdeaLifecycleState,
  context?: {
    triageDecision?: 'place' | 'gate' | 'gym' | 'reject';
    triageReason?: string;
    ideaType?: IdeaType;
    decayResult?: 'worked' | 'regressed';
    decayDays?: number;
  },
): IdeaLifecyclePayload {
  return {
    ...current,
    state: newState,
    stateUpdatedAt: new Date().toISOString(),
    ...(context?.triageDecision && { triageDecision: context.triageDecision }),
    ...(context?.triageReason && { triageReason: context.triageReason }),
    ...(context?.ideaType && { ideaType: context.ideaType }),
    ...(context?.decayResult && { decayResult: context.decayResult }),
    ...(context?.decayDays !== undefined && { decayDays: context.decayDays }),
  };
}

/**
 * State machine validation: is the transition valid?
 */
export function isValidTransition(
  from: IdeaLifecycleState,
  to: IdeaLifecycleState,
): boolean {
  // Valid transitions:
  // open → triaged (Queen decides)
  // triaged → applied (idea implemented; work-item resolved)
  // applied → verified (friction decayed after 14+ days)
  // applied → recurred (friction re-surfaced; watchdog re-filed)
  // triaged → triaged (Queen changes decision before applying)
  // recurred → triaged (re-triage the regression)
  // verified → recurred (friction re-surfaced after apparent decay)

  const validTransitions: Record<IdeaLifecycleState, IdeaLifecycleState[]> = {
    open: ['triaged'],
    triaged: ['triaged', 'applied'],
    applied: ['verified', 'recurred'],
    verified: ['recurred'],
    recurred: ['triaged', 'applied'],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

/**
 * Decay outcome for an APPLIED idea (called by the decay sweep on the watchdog
 * cadence — learning-system-audit-improvements-2026-06-09 P-013).
 *
 * Class asymmetry (self-learning D-003):
 *   - `recurred` fires for ANY class — a friction signature re-surfacing after the
 *     fix is regression evidence regardless of product/process.
 *   - `verified` fires ONLY for the code-change classes ('product' + 'code-bug',
 *     incl. legacy 'product' rows) — absence-of-recurrence is too weak a positive
 *     for process/prompt ideas (those earn the gym's A/B instead) and meaningless
 *     for infra-environment / needs-design routes.
 *
 * `count` is the POST-RESOLUTION recurrence count + 1 (i.e. 1 = no recurrence
 * since the fix); `decayDays` is days since the item was resolved.
 */
export function checkDecayOutcome(
  lifecycle: IdeaLifecyclePayload,
  recurrenceData?: {
    count: number;
    decayDays: number;
    resolvedCount: number;
  },
): IdeaLifecyclePayload | null {
  if (lifecycle.state !== 'applied' || !recurrenceData) {
    return null;
  }

  // Regression (any class): the signature re-surfaced after the fix.
  if (recurrenceData.count > 1) {
    return updateIdeaLifecycle(lifecycle, 'recurred', {
      decayResult: 'regressed',
      decayDays: recurrenceData.decayDays,
    });
  }

  // Positive decay-verification: code-change classes only (D-003 / D-005) —
  // 'product' (external Hive code, incl. legacy rows) and 'code-bug' (papercusp
  // code), where a friction signature going quiet after the fix means it worked.
  const decayVerifiable = lifecycle.ideaType === 'product' || lifecycle.ideaType === 'code-bug';
  if (decayVerifiable && recurrenceData.count === 1 && recurrenceData.decayDays >= 14) {
    return updateIdeaLifecycle(lifecycle, 'verified', {
      decayResult: 'worked',
      decayDays: recurrenceData.decayDays,
    });
  }

  return null;
}
