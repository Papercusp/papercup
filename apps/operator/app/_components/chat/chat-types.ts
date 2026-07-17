/**
 * Chat message/tool-call types — the shape the operator conversation store and the
 * chat cards agree on.
 *
 * These lived in ChatConversation.tsx until that component was retired
 * (design-simplification-2026-07-09 P-010, backfilling P-003): ChatConversation was
 * the shared transcript view of OracleDock + OperatorChat, both of which moved to
 * `_retired/legacy-web-chats/`. The types outlived the view — OperatorConversationProvider
 * still stores turns in this shape — so they get a home of their own rather than
 * keeping a dead component alive as a type module.
 */

export interface ChatToolCall {
  /** Display name of the tool the model called. */
  name: string;
  /** Tool input — rendered as a short chip by the surface, if it renders one. */
  input?: unknown;
  /**
   * For interactive tools (e.g. chat:ask_choice), the user's response.
   * When set, the surface should render the answered state.
   * Persisted into operator_turns.tools jsonb (migration 015).
   *
   * Always an array of picks (length 1 for single-select cards,
   * length ≥1 for multi-select). Pre-alpha unified shape — no
   * legacy {option_id, label} variant.
   */
  answered?: {
    picks: Array<{ option_id: string; label: string }>;
    /** True when the user used the card's Skip affordance. */
    declined?: boolean;
    at: number;
  };
}

import type { ReportBlock } from '@papercusp/chat-protocol';

export interface ChatMessage {
  /** Who spoke. Surfaces tint by role. */
  role: 'user' | 'assistant' | 'system';
  /**
   * WHICH agent spoke, when the surface knows (WI-4731 — the owner sees the
   * Papercup mark on every assistant message even when the message is the
   * Mug's or the Kettle's). Drives the per-message avatar: ChatConversation
   * maps the known cast ids to their canonical marks (mug → Coffee,
   * kettle → Thermometer — the LeftSidebar tab iconography) and falls back
   * to the pane's own icon when absent/unknown. Optional so existing
   * papercup-only feeds are untouched.
   */
  agent?: 'papercup' | 'mug' | 'kettle' | (string & {});
  /** Visible message text. May be empty while the assistant turn is still streaming. */
  content: string;
  /** Optional tool calls to render above the content (chat:ask_choice uses this). */
  tools?: ChatToolCall[];
  /**
   * Structured status CARD for this message (deterministic-status-cards-2026-07-17
   * P-003). Set ONLY for the curator-operator's `source:'system'` status turns —
   * the provider maps `operator_turns.report` onto this field exclusively for
   * system turns, so `report` present ⟺ a curator status card. Rendered in the
   * chat via ReportBlockCard in place of the flattened `content` (gated on
   * FLAGS.CURATOR_STATUS_CARDS). The operator's OWN `<report>` turns (text_typed/
   * voice_tts) still route to the tiered Inbox and do NOT set this field — chat
   * conversation stays conversation (report-cards-inbox-reconciliation D-002); the
   * curator's fleet-status digest is the one deterministic exception, by design.
   */
  report?: ReportBlock;
  /**
   * Stable id for optimistic-write dedup. Set client-side to a uuid
   * when an optimistic local turn is dispatched; once the POST returns,
   * the row's PG id replaces it. A live-tail reconciler skips any
   * incoming row whose id matches an already-loaded message — defeats
   * the race where a push arrives before the POST response (would
   * otherwise double-render the user's own message).
   */
  id?: string;
  /**
   * Operator-side: the per-conversation sequence number from
   * operator_turns.seq. Needed by chat:ask_choice when the user picks
   * an option — the turn-answer endpoint addresses turns by seq. Not
   * set for optimistic local messages before they're persisted.
   */
  seq?: number;
}
