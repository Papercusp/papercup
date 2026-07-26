'use client';

/**
 * useAgentDetail — the lazy Tier-3 `agentDetail.byOwner` dossier fetch
 * (locks held/waiting, coord last-message/unread/handoffs/escalations, native
 * session handle, codex runtime diagnostics), factored out of AgentDossier.tsx
 * (hud-first-nav-and-dossier-2026-07-26 P-004) so a SECOND reader — the chat
 * footer's compact "N locks / M unread" summary chip — can share the exact
 * same `useSyncQuery` cache entry ({queryName, args}-keyed, per
 * SessionChatModal.tsx's own established pattern for `advRoster.list`)
 * instead of re-fetching or duplicating the DTO shape. No new endpoint.
 */

import { useSyncQuery } from '@papercusp/sync';
import type { NativeSessionHandle } from './SessionsRosterView';

// ── Server DTO mirror (apps/operator/lib/adv-agent-detail.ts). Inlined, not
//    imported, so this client module never pulls the PG-backed server module.
export interface LockHeld {
  path: string;
  intent: string;
  acquiredAt: string;
  expiresAt: string;
}
export interface LockBlocker {
  path: string;
  holder: string;
  holderLabel: string | null;
  intent: string;
  expiresAt: string;
}
export interface LockWaiting {
  ticketId: string;
  paths: string[];
  intent: string;
  aheadCount: number;
  queuedAt: string;
  waitUntil: string;
  blockedBy: LockBlocker[];
}
export interface AgentLocks {
  held: LockHeld[];
  waiting: LockWaiting[];
  error: string | null;
}
export interface CoordMessageSummary {
  msgId: string;
  from: string;
  to: string[];
  kind: string;
  summary: string;
  ts: string;
  direction: 'inbound' | 'outbound';
}
export interface CoordHandoffSummary {
  msgId: string;
  from: string;
  to: string[];
  summary: string;
  ts: string;
  planSlug: string | null;
  nextAction: string | null;
  direction: 'inbound' | 'outbound';
  accepted: boolean;
}
export interface CoordEscalationSummary {
  msgId: string;
  severity: 'blocker' | 'question' | 'advisory';
  summary: string;
  ts: string;
  planSlug: string | null;
}
export interface AgentCoordState {
  lastMessage: CoordMessageSummary | null;
  unreadCount: number;
  openHandoffs: CoordHandoffSummary[];
  openEscalations: CoordEscalationSummary[];
  error: string | null;
}
export interface CodexHomeDiagnostics {
  codexHome: string;
  exists: boolean;
  agentsPath: string;
  agentsExists: boolean;
  configPath: string;
  configExists: boolean;
  hooksPath: string;
  hooksExists: boolean;
  promptsPath: string;
  promptsExists: boolean;
  authPath: string;
  authExists: boolean;
  diagnosticsPath: string;
  diagnosticsExists: boolean;
  diagnostics: {
    lockEnforcement?: string;
    codexPreToolUseStatus?: string;
    requiresExplicitPapercuspLocks?: boolean;
    inheritedPromptsCopied?: boolean;
  } | null;
  latestRolloutId: string | null;
  latestRolloutPath: string | null;
  resumeStrategy: 'codex-resume-last-in-code-home';
  resumeCommand: string;
  error: string | null;
}
// hud-first-nav-and-dossier-2026-07-26 P-005: the six health signals — see the
// server-side docstring on AgentSignals (adv-agent-detail.ts) for what each is
// sourced from.
export interface AgentDossierLoopStatus {
  active: boolean;
  intervalSec: number | null;
  nextFireAt: string | null;
  parked: boolean;
  stalled: boolean;
}
export interface AgentDossierClaim {
  id: string;
  title: string | null;
  harness: string | null;
}
export interface AgentDossierCheckpoint {
  text: string;
  updatedAtMs: number | null;
}
export interface AgentSignals {
  loop: AgentDossierLoopStatus | null;
  currentClaim: AgentDossierClaim | null;
  contextTokens: number | null;
  compactionLimit: number | null;
  lastCheckpoint: AgentDossierCheckpoint | null;
  unansweredDirectedCount: number;
  lastToolCallAt: string | null;
}

export interface AgentDetail {
  ownerId: string;
  locks: AgentLocks;
  coord: AgentCoordState;
  nativeSession: NativeSessionHandle | null;
  codex: CodexHomeDiagnostics | null;
  signals: AgentSignals;
}

/** Lazy-load the Tier-3 dossier for one owner id through sync. Any number of
 *  call sites can invoke this for the SAME ownerId — `useSyncQuery` shares
 *  its cache by `{queryName, args}`, so it is a second READER, not a second
 *  fetch. */
export function useAgentDetail(ownerId: string | null): {
  detail: AgentDetail | null;
  error: string | null;
  loading: boolean;
} {
  const query = useSyncQuery<AgentDetail>({
    queryName: 'agentDetail.byOwner',
    args: ownerId ? { ownerId } : undefined,
    enabled: !!ownerId,
  });
  return {
    detail: query.data?.[0] ?? null,
    error: query.error ? String(query.error) : null,
    loading: query.loading,
  };
}
