/**
 * One server-side conversation/context projection for every agent-chat UI.
 *
 * P-029 / own-tui-full-divorce-2026-08-24 and cockpit D-004 require pui and
 * the operator GUI to render the same typed frames.  Keep normalization here:
 * consumers select/group frames, but never rebuild messages, tool cards,
 * tasks or approvals from their source tables independently.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { TranscriptTurn } from './agent-chats-data';
import { listPendingLoopApprovals, type LoopApprovalRequestRow } from './agent-loop/approval-store';
import { loadLoopSession, type LoopSessionRow } from './agent-loop/session-store';
import type { LoopEvent } from './agent-loop/loop';
import type { ModelMessage } from './agent-loop/model-port';
import { applySessionTaskOp, type SessionTask } from './session-tasks';

export const CONVERSATION_CONTEXT_PROJECTION_VERSION = 'conversation-context-v1' as const;

export type ConversationContextCapabilityTier =
  | 'owned-loop'
  | 'producer-readonly'
  | 'transcript-only';

export interface ConversationContextCapabilities {
  /** The native stream can append already-normalized frames while a turn runs. */
  liveFrames: boolean;
  /** The session accepts canonical tasks:ops mutations. */
  taskWrite: boolean;
  /** The session accepts HITL approval decisions. */
  approvalWrite: boolean;
}

export type ConversationContextFrameKind =
  | 'message'
  | 'reasoning'
  | 'tool'
  | 'task'
  | 'context'
  | 'approval';

interface FrameBase {
  id: string;
  kind: ConversationContextFrameKind;
}

export interface ConversationMessageFrame extends FrameBase {
  kind: 'message';
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
  streaming?: boolean;
  error?: boolean;
  provenance?: {
    engine?: string;
    model?: string;
    accountRoute?: string;
  };
}

export interface ConversationReasoningFrame extends FrameBase {
  kind: 'reasoning';
  text: string;
  stepIndex: number | null;
  /** Reasoning is currently a live frame; snapshots omit it when unavailable. */
  transient: boolean;
}

export type ConversationToolState =
  | 'requested'
  | 'approval-required'
  | 'succeeded'
  | 'failed'
  | 'denied';

export interface ConversationToolFrame extends FrameBase {
  kind: 'tool';
  callId: string;
  name: string;
  input?: unknown;
  result?: unknown;
  error?: string;
  stepIndex: number | null;
  needsApproval: boolean;
  state: ConversationToolState;
}

export interface ConversationTaskFrame extends FrameBase {
  kind: 'task';
  taskId: string;
  content: string;
  activeForm: string;
  status: SessionTask['status'];
  blockerRef: string | null;
  explanation: string | null;
  position: number;
  updatedAt: string;
}

export type ConversationContextSection =
  | 'identity'
  | 'mode'
  | 'model-account'
  | 'intent'
  | 'plan'
  | 'held';

export interface ConversationContextSectionFrame extends FrameBase {
  kind: 'context';
  section: ConversationContextSection;
  title: string;
  entries: Array<{ label: string; value: string; state?: string }>;
}

export interface ConversationApprovalFrame extends FrameBase {
  kind: 'approval';
  callId: string;
  toolName: string | null;
  input?: unknown;
  stepIndex: number;
  requestedAt: string | null;
  status: 'pending' | 'approved' | 'denied';
  reason?: string;
}

export type ConversationContextFrame =
  | ConversationMessageFrame
  | ConversationReasoningFrame
  | ConversationToolFrame
  | ConversationTaskFrame
  | ConversationContextSectionFrame
  | ConversationApprovalFrame;

export interface ConversationContextProjection {
  schemaVersion: typeof CONVERSATION_CONTEXT_PROJECTION_VERSION;
  session: {
    sourceKind: string;
    sessionId: string;
    harness: string | null;
    role: string | null;
    linkedWorkItemId: string | null;
    capabilityTier: ConversationContextCapabilityTier;
  };
  capabilities: ConversationContextCapabilities;
  frames: ConversationContextFrame[];
}

export interface ProjectConversationContextInput {
  sourceKind: string;
  sessionId: string;
  harness: string | null;
  role: string | null;
  linkedWorkItemId: string | null;
  transcript: TranscriptTurn[];
  loopSession: LoopSessionRow | null;
  tasks?: SessionTask[];
  approvals?: LoopApprovalRequestRow[];
  context?: ConversationContextSectionFrame[];
}

function transcriptFrames(turns: TranscriptTurn[]): ConversationMessageFrame[] {
  return turns.map((turn, index) => ({
    id: `message:transcript:${index}`,
    kind: 'message',
    role: turn.role,
    text: turn.content,
    timestamp: turn.ts || null,
    ...(turn.error ? { error: true } : {}),
    ...(turn.engine || turn.model || turn.account_route
      ? {
          provenance: {
            ...(turn.engine ? { engine: turn.engine } : {}),
            ...(turn.model ? { model: turn.model } : {}),
            ...(turn.account_route ? { accountRoute: turn.account_route } : {}),
          },
        }
      : {}),
  }));
}

/** Project the owned loop's provider-neutral message ledger without teaching
 * either renderer how tool_call/tool_result correlation works. */
export function loopMessageFrames(messages: ModelMessage[]): ConversationContextFrame[] {
  const frames: ConversationContextFrame[] = [];
  const toolIndexes = new Map<string, number>();
  messages.forEach((message, messageIndex) => {
    message.content.forEach((part, partIndex) => {
      if (part.type === 'text') {
        if (!part.text) return;
        frames.push({
          id: `message:loop:${messageIndex}:${partIndex}`,
          kind: 'message',
          role: message.role,
          text: part.text,
          timestamp: null,
        });
        return;
      }
      if (part.type === 'tool_call') {
        toolIndexes.set(part.id, frames.length);
        frames.push({
          id: `tool:${part.id}`,
          kind: 'tool',
          callId: part.id,
          name: part.name,
          input: part.input,
          stepIndex: null,
          needsApproval: false,
          state: 'requested',
        });
        return;
      }
      const existingIndex = toolIndexes.get(part.toolCallId);
      const existing = existingIndex === undefined ? null : frames[existingIndex];
      const next: ConversationToolFrame = {
        id: `tool:${part.toolCallId}`,
        kind: 'tool',
        callId: part.toolCallId,
        name: existing?.kind === 'tool' ? existing.name : 'unknown',
        ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
        result: part.content,
        stepIndex: existing?.kind === 'tool' ? existing.stepIndex : null,
        needsApproval: existing?.kind === 'tool' ? existing.needsApproval : false,
        state: part.isError ? 'failed' : 'succeeded',
      };
      if (existingIndex === undefined) {
        toolIndexes.set(part.toolCallId, frames.length);
        frames.push(next);
      } else {
        frames[existingIndex] = next;
      }
    });
  });
  return frames;
}

function defaultContextFrames(input: ProjectConversationContextInput): ConversationContextSectionFrame[] {
  const identityEntries = [
    { label: 'Session', value: input.sessionId },
    ...(input.harness ? [{ label: 'Harness', value: input.harness }] : []),
    ...(input.role ? [{ label: 'Role', value: input.role }] : []),
  ];
  const frames: ConversationContextSectionFrame[] = [
    { id: 'context:identity', kind: 'context', section: 'identity', title: 'Identity', entries: identityEntries },
  ];
  const lastAssistant = [...input.transcript].reverse().find((turn) => turn.role === 'assistant');
  const model = input.loopSession?.model ?? lastAssistant?.model ?? null;
  const account = lastAssistant?.account_route ?? null;
  if (model || account) {
    frames.push({
      id: 'context:model-account',
      kind: 'context',
      section: 'model-account',
      title: 'Model + account',
      entries: [
        ...(model ? [{ label: 'Model', value: model }] : []),
        ...(account ? [{ label: 'Account', value: account }] : []),
      ],
    });
  }
  if (input.linkedWorkItemId) {
    frames.push({
      id: 'context:intent',
      kind: 'context',
      section: 'intent',
      title: 'Intent',
      entries: [{ label: 'Linked work item', value: input.linkedWorkItemId }],
    });
  }
  return frames;
}

export function projectConversationContext(
  input: ProjectConversationContextInput,
): ConversationContextProjection {
  const freshLoopLedger =
    input.loopSession !== null && input.loopSession.transcriptTurns === input.transcript.length;
  const capabilityTier: ConversationContextCapabilityTier = freshLoopLedger
    ? 'owned-loop'
    : input.sourceKind === 'agent_chat'
      ? 'transcript-only'
      : 'producer-readonly';
  const contentFrames = freshLoopLedger
    ? loopMessageFrames(input.loopSession!.messages)
    : transcriptFrames(input.transcript);
  const taskFrames: ConversationTaskFrame[] = (input.tasks ?? []).map((task) => ({
    id: `task:${task.id}`,
    kind: 'task',
    taskId: task.id,
    content: task.content,
    activeForm: task.activeForm,
    status: task.status,
    blockerRef: task.blockerRef,
    explanation: task.explanation,
    position: task.position,
    updatedAt: task.updatedAt,
  }));
  const approvalFrames: ConversationApprovalFrame[] = (input.approvals ?? []).map((approval) => ({
    id: `approval:${approval.callId}`,
    kind: 'approval',
    callId: approval.callId,
    toolName: approval.toolName,
    input: approval.toolInput,
    stepIndex: approval.stepIndex,
    requestedAt: approval.requestedAt,
    status: 'pending',
  }));
  return {
    schemaVersion: CONVERSATION_CONTEXT_PROJECTION_VERSION,
    session: {
      sourceKind: input.sourceKind,
      sessionId: input.sessionId,
      harness: input.harness,
      role: input.role,
      linkedWorkItemId: input.linkedWorkItemId,
      capabilityTier,
    },
    capabilities: {
      liveFrames: freshLoopLedger,
      taskWrite: freshLoopLedger,
      approvalWrite: freshLoopLedger,
    },
    frames: [
      ...contentFrames,
      ...(input.context ?? defaultContextFrames(input)),
      ...taskFrames,
      ...approvalFrames,
    ],
  };
}

/** Normalize a live native-loop event at the server seam. Snapshot readers do
 * not invent reasoning; the stream appends this frame only when it exists. */
export function projectLiveLoopEvent(event: LoopEvent): ConversationContextFrame | null {
  switch (event.type) {
    case 'text_delta':
      return {
        id: `message:live:${event.stepIndex}`,
        kind: 'message',
        role: 'assistant',
        text: event.text,
        timestamp: null,
        streaming: true,
      };
    case 'reasoning_delta':
      return {
        id: `reasoning:live:${event.stepIndex}`,
        kind: 'reasoning',
        text: event.text,
        stepIndex: event.stepIndex,
        transient: true,
      };
    case 'tool_call':
      return {
        id: `tool:${event.call.id}`,
        kind: 'tool',
        callId: event.call.id,
        name: event.call.name,
        input: event.call.input,
        stepIndex: event.stepIndex,
        needsApproval: event.needsApproval,
        state: event.needsApproval ? 'approval-required' : 'requested',
      };
    case 'tool_result':
      return {
        id: `tool:${event.callId}`,
        kind: 'tool',
        callId: event.callId,
        name: event.name,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error ? { error: event.error } : {}),
        stepIndex: event.stepIndex,
        needsApproval: false,
        state: event.denied ? 'denied' : event.error ? 'failed' : 'succeeded',
      };
    case 'approval_resolved':
      return {
        id: `approval:${event.callId}`,
        kind: 'approval',
        callId: event.callId,
        toolName: null,
        stepIndex: event.stepIndex,
        requestedAt: null,
        status: event.approved ? 'approved' : 'denied',
        ...(event.reason ? { reason: event.reason } : {}),
      };
    default:
      return null;
  }
}

interface AgentChatProjectionRow {
  id: string;
  harness_slug: string;
  role: string;
  feature_id: string | null;
  transcript: TranscriptTurn[] | string | null;
}

/** Canonical query implementation used by both the GUI sync hook and pui's
 * generic named-query client. P-030 extends the source adapters; it must keep
 * this return contract unchanged. */
export async function readConversationContextProjection(args: {
  workspaceId: string;
  sourceKind: string;
  sessionId: string;
  harness?: string;
}): Promise<ConversationContextProjection | null> {
  if (args.sourceKind !== 'agent_chat') return null;
  const { sql } = getOrgPg();
  const rows = await sql<AgentChatProjectionRow[]>`
    SELECT id, harness_slug, role, feature_id, transcript
      FROM harness_shared.agent_chats_consolidated
     WHERE workspace_id = ${args.workspaceId}
       AND id = ${args.sessionId}
       AND (${args.harness ?? null}::text IS NULL OR harness_slug = ${args.harness ?? null})
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const transcript = Array.isArray(row.transcript)
    ? row.transcript
    : typeof row.transcript === 'string'
      ? (JSON.parse(row.transcript) as TranscriptTurn[])
      : [];
  const [loopSession, approvals, taskResult] = await Promise.all([
    loadLoopSession({ chatId: row.id, workspaceId: args.workspaceId }, { sql }),
    listPendingLoopApprovals({ chatId: row.id, workspaceId: args.workspaceId }, { sql }),
    applySessionTaskOp(sql, {
      workspaceId: args.workspaceId,
      sessionId: row.id,
      op: 'view',
      idFactory: () => 'unused-on-view',
    }),
  ]);
  return projectConversationContext({
    sourceKind: args.sourceKind,
    sessionId: row.id,
    harness: row.harness_slug,
    role: row.role,
    linkedWorkItemId: row.feature_id,
    transcript,
    loopSession,
    tasks: taskResult.tasks,
    approvals,
  });
}
