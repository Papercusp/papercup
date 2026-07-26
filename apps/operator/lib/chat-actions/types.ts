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
  params?(ctx: ChatActionContext): Promise<CardSpec>;
  /** Optional confirm-before-run step, after `params` resolves. */
  confirm?: ChatActionConfirm | ((ctx: ChatActionContext) => ChatActionConfirm | null | undefined);
  /**
   * Perform the action. `value` is the params card's submitted payload
   * (`undefined` when the action declares no `params`). The bar only calls
   * `run` after every declared params/confirm step ended in `submit`.
   */
  run(ctx: ChatActionContext, value: unknown): Promise<void> | void;
}
