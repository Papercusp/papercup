/**
 * owner-directive-status.ts — P-006 of plan
 * `directive-visibility-and-ownership-2026-09-22`.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 *
 * ONE pure function that answers "what is the state of this owner directive",
 * DERIVED from the two inputs that already exist, and stored nowhere.
 *
 * Per D-001 (derived-truth ladder): a `status` column on `owner_directives`
 * would be a second copy of a truth the ledger already owns, and it would
 * drift. Drift between two independently-maintained status fields is not a
 * hypothetical here — it is the measured defect this module exists to remove
 * (D-007, below).
 *
 * ── WHY TWO INPUTS AND NOT ONE ──────────────────────────────────────────────
 *
 * Both readings are individually wrong, and each is wrong in a way that looks
 * right from inside its own surface:
 *
 *  · WORK-ITEM REFS ALONE. Every directive that legitimately never spawns work
 *    — a question answered in chat, a standing rule absorbed as a fact, a
 *    correction — would sit `unclaimed` forever and pollute the exact view
 *    meant to show what needs doing.
 *
 *  · CAPTURE STATUS ALONE. This is the live defect. Measured 2026-09-22 on the
 *    plan author's own queue: directives #86 and #87 carry
 *    `dispositionStatus:'done'` (dispositioned by their own recording session,
 *    with substantive notes) AND `captureStatus:'pending'` simultaneously. The
 *    obligation reader filters on `state:['pending','open']` — the CAPTURE
 *    field — so both rows were re-delivered as
 *    `[DUE] Owner directive #86: … — promote or dismiss` for at least four
 *    consecutive wakes AFTER being finished.
 *
 *    That is not a cosmetic nag: owner directives carry `causalRank: 0` and
 *    outrank the loop agenda, so a finished directive sits at the TOP of the
 *    agenda above real work, permanently. The predictable adaptation is the
 *    damaging part — an agent that watches a row survive its own correct
 *    disposition learns to discount the whole class, which is the same erosion
 *    that let an unlabelled foreign directive be read as actionable.
 *
 * `captureStatus` answers "did the hook capture get triaged"; `disposition`
 * answers "is the WORK finished". Nothing reconciles them. This function is
 * that reconciliation, and it is deliberately the ONLY place it happens.
 *
 * ── WHY TERMINAL WORK-ITEMS DO NOT CLOSE A DIRECTIVE ────────────────────────
 *
 * Work-item refs answer exactly one question: is someone ACTIVELY on it, and
 * who. They never answer "is it finished" — that is the disposition's job
 * alone. A completed work-item therefore returns the directive to `unclaimed`
 * rather than `done`.
 *
 * That is correct but easy to misread as a bug, so the verdict carries
 * `workedButUndispositioned` to distinguish it from a directive nobody has
 * ever touched. Rendering those two identically would recreate the very noise
 * D-007 describes, one layer up: the agent did the work, closed the item, and
 * the banner goes back to shouting as though nothing happened. The caller
 * should nudge for a disposition, NOT re-issue a carry-out imperative.
 */

import { TERMINAL_WORK_ITEM_STATES } from './work-items';
import type { OwnerDirectiveCaptureStatus, OwnerDirectiveDisposition } from './owner-directives';

/**
 * The four states from D-001. Deliberately NOT a superset of
 * `OwnerDirectiveState` — that type reports the CAPTURE lifecycle
 * (`pending | open | dismissed | done | declined`), which is one of this
 * function's inputs. Two names for two different questions.
 */
export type DirectiveStatusKind = 'unclaimed' | 'claimed' | 'done' | 'declined';

/** Why a terminal verdict was reached — never inferred by the caller. */
export type DirectiveTerminalSource = 'disposition' | 'capture-dismissed';

/** The minimum a caller must supply about the directive row itself. */
export interface DirectiveStatusDirectiveInput {
  /** Hook-capture lifecycle. Absent is treated as `open` (pre-capture rows). */
  captureStatus?: OwnerDirectiveCaptureStatus;
  /** Work lifecycle. `null` until `orders:disposition` runs. */
  dispositionStatus: OwnerDirectiveDisposition | null;
  /** Present iff a disposition was recorded; the tie-breaker against capture. */
  dispositionedAtMs?: number | null;
}

/** One work-item carrying `directive_ref = <this directive>`. */
export interface DirectiveLinkedWorkItem {
  id: string;
  /** Canonical work-item status; compared against TERMINAL_WORK_ITEM_STATES. */
  state: string;
  /** Who holds it. Absent/empty is a real case — an unassigned linked item. */
  assignee?: string | null;
}

export interface DirectiveStatus {
  kind: DirectiveStatusKind;
  /**
   * Set ONLY when `kind === 'claimed'`. The owner actively carrying it; when
   * several hold non-terminal items, this is the first in the supplied order
   * and `holders` carries the rest.
   */
  claimedBy?: string;
  /** Every owner on a NON-TERMINAL linked work-item, de-duplicated, in order. */
  holders: string[];
  /** Ids of the non-terminal linked work-items, in the supplied order. */
  activeWorkItemIds: string[];
  /** Set on a terminal verdict; absent otherwise. */
  terminalSource?: DirectiveTerminalSource;
  /**
   * TRUE when the row is terminal by disposition while its capture lifecycle
   * still reads `pending` — the measured D-007 shape. The caller MUST NOT
   * render an imperative for these; the flag exists so the condition is
   * reportable rather than silently swallowed by the correct verdict.
   */
  captureLagging: boolean;
  /**
   * TRUE when the directive has linked work-items but all of them are
   * terminal, and no disposition was ever recorded. Still `unclaimed` — but
   * the honest prompt is "disposition this", not "carry this out".
   */
  workedButUndispositioned: boolean;
}

function isTerminal(state: string): boolean {
  return TERMINAL_WORK_ITEM_STATES.includes(state);
}

/**
 * Derive a directive's status from the directive row plus every work-item that
 * points back at it. PURE — no IO, no clock, no ambient state.
 *
 * Precedence, and each rung is load-bearing:
 *   1. DISPOSITION wins over everything. It is the only explicit statement
 *      about the WORK, and it is what `captureStatus` fails to observe.
 *   2. A dismissed CAPTURE is terminal-`declined`. The capture was triaged as
 *      not-a-directive; there is nothing to carry out.
 *   3. A non-terminal linked work-item means someone is on it.
 *   4. Otherwise unclaimed — the DEFAULT at capture, and the most important
 *      bucket to render (D-005), never a degenerate case.
 */
export function deriveDirectiveStatus(
  directive: DirectiveStatusDirectiveInput,
  linkedWorkItems: readonly DirectiveLinkedWorkItem[] = [],
): DirectiveStatus {
  const active = linkedWorkItems.filter((item) => !isTerminal(item.state));
  const activeWorkItemIds = active.map((item) => item.id);
  const holders = [...new Set(active.map((item) => item.assignee).filter((a): a is string => !!a))];

  // (1) A recorded disposition is the authoritative statement about the work.
  // Guarded on the TIMESTAMP as well as the status so a row that somehow
  // carries a status with no recorded disposition is not read as terminal.
  const dispositioned = directive.dispositionStatus !== null && directive.dispositionedAtMs != null;
  if (dispositioned) {
    return {
      kind: directive.dispositionStatus === 'declined' ? 'declined' : 'done',
      holders,
      activeWorkItemIds,
      terminalSource: 'disposition',
      // The measured D-007 shape: finished work, un-triaged capture.
      captureLagging: directive.captureStatus === 'pending',
      workedButUndispositioned: false,
    };
  }

  // (2) The capture was dismissed: triaged as not-a-directive. Terminal.
  if (directive.captureStatus === 'dismissed') {
    return {
      kind: 'declined',
      holders,
      activeWorkItemIds,
      terminalSource: 'capture-dismissed',
      captureLagging: false,
      workedButUndispositioned: false,
    };
  }

  // (3) Someone holds a live work-item pointing at this directive.
  if (active.length > 0) {
    const claimedBy = holders[0];
    return {
      kind: 'claimed',
      ...(claimedBy ? { claimedBy } : {}),
      holders,
      activeWorkItemIds,
      captureLagging: false,
      workedButUndispositioned: false,
    };
  }

  // (4) Unclaimed — the default, and the bucket the whole plan exists to show.
  return {
    kind: 'unclaimed',
    holders,
    activeWorkItemIds,
    captureLagging: false,
    workedButUndispositioned: linkedWorkItems.length > 0,
  };
}

/**
 * TRUE when the directive still needs SOMEBODY to act — the predicate a
 * renderer uses to decide whether a row belongs in an imperative bucket at all.
 *
 * Exported as its own function rather than left to each caller to re-derive:
 * the D-007 bug was precisely a caller re-deriving "is this live?" from one
 * field, and a second re-derivation elsewhere is how that returns.
 */
export function directiveNeedsAction(status: DirectiveStatus): boolean {
  return status.kind === 'unclaimed' || status.kind === 'claimed';
}

/**
 * The stable label form named in the plan (`claimed-by:<ownerId>`). Kept beside
 * the structured verdict so a line renderer never hand-concatenates its own
 * variant of it.
 */
export function directiveStatusLabel(status: DirectiveStatus): string {
  if (status.kind === 'claimed') return status.claimedBy ? `claimed-by:${status.claimedBy}` : 'claimed';
  return status.kind;
}
