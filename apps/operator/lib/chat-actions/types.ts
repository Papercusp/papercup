/**
 * ChatAction — the declarative unit behind the chat action bar
 * (gui-chat-session-controls-2026-07-25 P-002).
 *
 * Adding a new bottom-of-chat action (a posture toggle, the grade rubric
 * picker, resume/fork/focus, …) means registering ONE descriptor via
 * `registerChatAction` (lib/chat-actions/registry.ts) — the bar component
 * (ChatActionBar) never grows a per-action branch.
 *
 * Value collection reuses the SAME CardSpec / askUserLocal / LocalCardHost
 * plumbing the agent-initiated card path already uses
 * (apps/operator/app/_components/chat/LocalCardHost.tsx,
 * apps/operator/lib/chat-cards/ask-user-local.ts) — there is no second card
 * vocabulary (plan D-001). The distinction from an agent-initiated card: an
 * action-bar card resolves a LOCAL promise, and the action's `run` then
 * sends a directive to an agent that never asked — it does NOT resolve the
 * agent question-gate an agent-initiated `ctx.askUser` card would.
 */
import type { ReactNode } from 'react';
import type { CardSpec } from '@papercusp/agent-mcp';
// askUserLocal (lib/chat-cards/ask-user-local.ts) — the host every params()
// card is rendered through — is typed `TSchema extends ZodTypeAny`, not
// CardSpec's generic StandardSchemaV1 default; pin the same bound here so a
// params() CardSpec type-checks straight into askUserLocal without a cast.
import type { ZodTypeAny } from 'zod';

/**
 * Context handed to every hook on a ChatAction. Deliberately an open bag
 * beyond the two fields every action can rely on — concrete lanes (posture
 * P-004, grade P-005, session actions P-006, identity P-012) each need
 * different session/roster/mode-registry facts and shouldn't force a
 * registry-wide type change just to add one.
 */
export interface ChatActionContext {
  /** su ownerId of the agent session this chat is attached to. */
  sessionOwnerId: string;
  /** Friendly display label, when the caller has one. */
  ownerLabel?: string | null;
  /** Lane-specific extension fields (session roster row, mode state, …). */
  [extra: string]: unknown;
}

/** A lightweight confirm-before-run step — no payload collected. */
export interface ChatActionConfirm {
  /** Shown as the confirm card's prompt. */
  message: string;
  /** Label for the single "go ahead" option. Defaults to "Confirm". */
  confirmLabel?: string;
}

export interface ChatAction {
  /** Stable id — React key, and the confirm/params card's rough identity. */
  id: string;
  label: string;
  /** Optional icon element, rendered at whatever size the bar's CSS sets. */
  icon?: ReactNode;
  /** Actions sharing a `group` render as one cluster, in first-seen order. */
  group?: string;
  /** Whether this action is offered at all, given the current ctx. */
  available(ctx: ChatActionContext): boolean;
  /**
   * Optional value-collection step: return a CardSpec and the bar opens it
   * via `askUserLocal` (rendered by whichever LocalCardHost is mounted in
   * the tree) and awaits the response. Omit for a zero-param action (a
   * plain button click straight into `run`). Async because some actions
   * fetch their option set at click time (e.g. P-005's rubric picker reads
   * `rubrics:list` live).
   */
  params?(ctx: ChatActionContext): Promise<CardSpec<ZodTypeAny>>;
  /** Optional confirm-before-run step, after `params` resolves. */
  confirm?: ChatActionConfirm | ((ctx: ChatActionContext) => ChatActionConfirm | null | undefined);
  /**
   * Perform the action. `value` is the params card's submitted payload
   * (`undefined` when the action declares no `params`). The bar only calls
   * `run` after every declared params/confirm step ended in `submit`.
   */
  run(ctx: ChatActionContext, value: unknown): Promise<void> | void;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The SECOND descriptor shape: a mode-action
 * (session-chat-popup-direction-d-2026-08-02 P-005, deck change #3).
 *
 * WHY A SECOND SHAPE RATHER THAN A FLAG ON ChatAction. A `ChatAction` is a
 * VERB: it has no state of its own, so the bar can render it as a button and
 * be done. A mode is not a verb — it is a value that is currently something,
 * and the control that changes it. Modelling that as a ChatAction is exactly
 * what produced the duplication the owner reported: the mode had to be shown
 * somewhere ELSE as a read-only chip (`AUTO` in the status row) while its
 * setter lived here as a button with an unrelated name (`Autonomy`), so one
 * concept wore two costumes in two places and neither said it was the other.
 *
 * A ChatModeAction reports AND sets, so it renders as ONE object — the
 * vocabulary's Mode pill: a filled cap carrying the axis name, its current
 * value beside it, and a caret saying a chooser opens. Being one object is the
 * entire fix; the pill shape is just how that is made visible.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One selectable value of a mode axis. */
export interface ChatModeOption {
  /** Stable id, passed back to `set`. */
  id: string;
  label: string;
  /** One-line explanation, shown under the label in the chooser. */
  hint?: string;
}

/** What a mode axis is set to right now. */
export interface ChatModeState {
  /** Short current value rendered beside the cap — "on", "off", "cold". */
  value: string;
  /**
   * Which `options()` entry `value` corresponds to, when the two differ.
   *
   * `value` is DISPLAY text and is deliberately terser than an option label —
   * the autonomy axis shows "on" for the option whose id is `auto` and "cold"
   * for `cold-auto`. The dropdown needs the id to put a checkmark on the row
   * that is actually in force, and deriving it by matching display text would
   * be a silent mis-highlight the moment either string changes.
   *
   * OPTIONAL on purpose: for an axis whose option ids already ARE its display
   * values (the stackable overlays, ids `on`/`off`), `value` is the id and
   * this adds nothing. Callers fall back to `value`. Making it required would
   * strand every existing fixture that builds a ChatModeState — the exact trap
   * `lint:required-field-strands` exists to catch.
   */
  optionId?: string;
  /**
   * Whether the axis is engaged. Drives the FORM (filled cap vs hollow), which
   * is what makes on/off legible in greyscale rather than by colour alone.
   */
  on: boolean;
  /** Long explanation for the pill's tooltip. */
  title?: string;
}

export interface ChatModeAction {
  /** Stable id — React key and test handle. */
  id: string;
  /** The cap text: the axis's short name, e.g. "AUTO", "IDEATE". */
  cap: string;
  /** Mode-actions sharing a `group` render as one cluster, in first-seen order. */
  group?: string;
  /** Whether this axis is offered at all, given the current ctx. */
  available(ctx: ChatActionContext): boolean;
  /**
   * Read the current value out of `ctx`. PURE and synchronous on purpose: the
   * pill re-renders from whatever the surface already knows (the roster row's
   * `modes`), so it never costs a fetch and never shows a value that
   * disagrees with the rest of the surface.
   */
  current(ctx: ChatActionContext): ChatModeState;
  /** The values this axis can be set to. */
  options(ctx: ChatActionContext): ChatModeOption[];
  /** Apply a chosen option. */
  set(ctx: ChatActionContext, optionId: string): Promise<void> | void;
}
