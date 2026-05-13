/**
 * Chat-card registry — Phase 4 T2.1.
 *
 * Schema-shaped lookup that lets the chat consumers (OperatorChat,
 * OracleDock) render tool calls as React components without each
 * consumer hardcoding `if (t.name === 'chat:ask_choice') return <X/>`.
 *
 * Pattern:
 *   - A card module (e.g. AskChoiceCardEntry.tsx) calls `registerCard`
 *     at import time.
 *   - `apps/operator/lib/chat-cards/index.ts` side-effect-imports every
 *     registered card so consumers see them all by importing once.
 *   - Consumers call `renderCard(toolName, props)` and either get a
 *     ReactNode or null. `null` falls through to the default tool-chip
 *     renderer.
 *
 * The on-answer logic STAYS PER CONSUMER — OperatorChat does live-tail
 * answerChoice; OracleDock mutates local tab state. Each consumer
 * supplies its own `onAnswer` callback through the props.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.1.
 */

import type { ReactNode } from 'react';

/**
 * Render-time props handed to a card renderer. `args` is the tool's
 * input payload (the model's tool-call args); `answered` is the
 * persisted user response (null when unanswered); `onAnswer` is the
 * consumer-supplied commit callback.
 *
 * Generic over `TArgs` so each card can narrow to its specific
 * input shape, but the registry itself stores `unknown` because
 * each card knows its own shape internally.
 */
export interface CardRenderProps<TArgs = unknown> {
  args: TArgs;
  answered?: unknown;
  /**
   * Called when the user commits a response (clicks a button, submits
   * a text field, etc). The payload shape is card-specific; the
   * consumer's `onAnswer` knows how to interpret it for the matching
   * tool.
   */
  onAnswer: (payload: unknown) => void;
}

export type CardRenderer<TArgs = unknown> = (
  props: CardRenderProps<TArgs>,
) => ReactNode | null;

const REGISTRY = new Map<string, CardRenderer<unknown>>();

/**
 * Register a card renderer for a tool name. Re-registering replaces
 * the prior renderer (lets HMR work in dev). Same tool name across
 * multiple `defineTool` calls would be a registry-level collision
 * upstream; we don't double-check here.
 */
export function registerCard<TArgs>(
  toolName: string,
  renderer: CardRenderer<TArgs>,
): void {
  REGISTRY.set(toolName, renderer as CardRenderer<unknown>);
}

/**
 * Render the card for `toolName`, or `null` if nothing is registered
 * (or the renderer itself returned null — e.g. payload validation
 * failed inside the card).
 */
export function renderCard(
  toolName: string,
  props: CardRenderProps<unknown>,
): ReactNode | null {
  const renderer = REGISTRY.get(toolName);
  if (!renderer) return null;
  return renderer(props);
}

/**
 * Test-only — flush the registry. Used by unit tests that want a
 * clean slate per `it()`.
 */
export function _resetCardRegistryForTests(): void {
  REGISTRY.clear();
}
