import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_CONTEXT_PROJECTION_VERSION,
  loopMessageFrames,
  projectConversationContext,
  projectLiveLoopEvent,
} from './conversation-context-projection';

const BASE = {
  sourceKind: 'agent_chat',
  sessionId: 'chat-1',
  harness: 'papercusp',
  role: 'su',
  linkedWorkItemId: 'WI-1',
  tasks: [],
  approvals: [],
};

describe('conversation context projection', () => {
  it('falls back honestly to transcript-only when the loop ledger is absent', () => {
    const projected = projectConversationContext({
      ...BASE,
      transcript: [{ role: 'user', content: 'hello', ts: '2026-08-26T00:00:00Z' }],
      loopSession: null,
    });
    expect(projected.schemaVersion).toBe(CONVERSATION_CONTEXT_PROJECTION_VERSION);
    expect(projected.session.capabilityTier).toBe('transcript-only');
    expect(projected.capabilities).toEqual({
      liveFrames: false,
      taskWrite: false,
      approvalWrite: false,
    });
    expect(projected.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', text: 'hello' }),
      expect.objectContaining({ kind: 'context', section: 'identity' }),
      expect.objectContaining({ kind: 'context', section: 'intent' }),
    ]));
    expect(projected.frames.some((frame) => frame.kind === 'reasoning')).toBe(false);
  });

  it('uses a fresh owned-loop ledger and correlates tool calls with results once', () => {
    const projected = projectConversationContext({
      ...BASE,
      transcript: [
        { role: 'user', content: 'read it', ts: '2026-08-26T00:00:00Z' },
        { role: 'assistant', content: 'done', ts: '2026-08-26T00:00:01Z' },
      ],
      loopSession: {
        workspaceId: 'ws',
        chatId: 'chat-1',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'read it' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'call-1', name: 'files:read', input: { path: 'a' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolCallId: 'call-1', content: { ok: true } }],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        ],
        summary: null,
        compactedCount: 0,
        transcriptTurns: 2,
        model: 'gpt-5.6-sol:xhigh',
        turnCount: 1,
        totals: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          unpricedTurns: 0,
        },
      },
      tasks: [{
        id: 'task-1',
        content: 'Implement projection',
        activeForm: 'Implementing projection',
        status: 'in_progress',
        blockerRef: null,
        blockerState: null,
        explanation: null,
        position: 0,
        createdAt: '2026-08-26T00:00:00Z',
        updatedAt: '2026-08-26T00:00:00Z',
      }],
      approvals: [{
        chatId: 'chat-1',
        callId: 'call-2',
        workspaceId: 'ws',
        toolName: 'capability:edit',
        toolInput: { path: 'b' },
        stepIndex: 1,
        requestedAt: '2026-08-26T00:00:02Z',
      }],
    });
    expect(projected.session.capabilityTier).toBe('owned-loop');
    expect(projected.capabilities).toEqual({ liveFrames: true, taskWrite: true, approvalWrite: true });
    expect(projected.frames.filter((frame) => frame.kind === 'tool')).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        name: 'files:read',
        state: 'succeeded',
        result: { ok: true },
      }),
    ]);
    expect(projected.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'task', taskId: 'task-1', status: 'in_progress' }),
      expect.objectContaining({ kind: 'approval', callId: 'call-2', status: 'pending' }),
    ]));
  });

  it('does not trust a stale loop ledger whose transcript anchor diverged', () => {
    const projected = projectConversationContext({
      ...BASE,
      transcript: [{ role: 'user', content: 'authoritative', ts: '2026-08-26T00:00:00Z' }],
      loopSession: {
        workspaceId: 'ws', chatId: 'chat-1',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'stale' }] }],
        summary: null, compactedCount: 0, transcriptTurns: 9, model: null, turnCount: 1,
        totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, unpricedTurns: 0 },
      },
    });
    expect(projected.frames.some((frame) => frame.kind === 'message' && frame.text === 'stale')).toBe(false);
    expect(projected.frames.some((frame) => frame.kind === 'message' && frame.text === 'authoritative')).toBe(true);
  });

  it('normalizes live reasoning and tool events into the same frame union', () => {
    expect(projectLiveLoopEvent({ type: 'reasoning_delta', stepIndex: 2, text: 'thinking' }))
      .toMatchObject({ kind: 'reasoning', stepIndex: 2, text: 'thinking', transient: true });
    expect(projectLiveLoopEvent({
      type: 'tool_call',
      stepIndex: 2,
      call: { id: 'c', name: 'files:read', input: {} },
      needsApproval: true,
    })).toMatchObject({ kind: 'tool', callId: 'c', state: 'approval-required' });
    expect(loopMessageFrames([])).toEqual([]);
  });
});
