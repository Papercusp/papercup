// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ConversationContextProjection } from '@papercusp/operator-core/lib/conversation-context-projection';

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  calls: [] as Array<{ queryName: string; args: unknown; enabled?: boolean }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (input: { queryName: string; args: unknown; enabled?: boolean }) => {
    H.calls.push(input);
    return { data: H.rows, loading: false, fetching: false, error: null, invalidate: vi.fn() };
  },
}));

import {
  ConversationContextProjectionView,
  conversationProjectionMessages,
  mergeConversationProjectionMessages,
  useConversationContextProjection,
} from './ConversationContextProjectionView';

const PROJECTION: ConversationContextProjection = {
  schemaVersion: 'conversation-context-v1',
  session: {
    sourceKind: 'agent_chat',
    sessionId: 'chat-1',
    harness: 'papercusp',
    role: 'worker',
    linkedWorkItemId: 'WI-42177',
    capabilityTier: 'owned-loop',
  },
  capabilities: { liveFrames: true, taskWrite: true, approvalWrite: true },
  frames: [
    { id: 'm1', kind: 'message', role: 'user', text: 'Build it', timestamp: '2026-08-26T00:00:00Z' },
    { id: 'tool-1', kind: 'tool', callId: 'c1', name: 'chat:ask_choice', input: { question: 'Route?' }, stepIndex: 1, needsApproval: false, state: 'succeeded' },
    { id: 'ctx-1', kind: 'context', section: 'identity', title: 'Identity', entries: [{ label: 'Harness', value: 'papercusp' }] },
    { id: 'task-1', kind: 'task', taskId: 't1', content: 'Ship projection', activeForm: 'Shipping projection', status: 'in_progress', blockerRef: null, explanation: 'Shared row', position: 0, updatedAt: '2026-08-26T00:00:01Z' },
    { id: 'approval-1', kind: 'approval', callId: 'c2', toolName: 'capability:edit', input: {}, stepIndex: 2, requestedAt: '2026-08-26T00:00:02Z', status: 'pending' },
  ],
};

function HookProbe() {
  const { projection } = useConversationContextProjection({
    sourceKind: 'agent_chat',
    sessionId: 'chat-1',
    harness: 'papercusp',
  });
  return <span>{projection?.session.sessionId ?? 'missing'}</span>;
}

afterEach(() => {
  cleanup();
  H.rows = [];
  H.calls = [];
});

describe('shared conversation/context GUI consumer', () => {
  it('reads the one named projection query with the canonical target args', () => {
    H.rows = [PROJECTION];
    render(<HookProbe />);
    expect(screen.getByText('chat-1')).toBeTruthy();
    expect(H.calls.at(-1)).toMatchObject({
      queryName: 'conversations.contextProjection',
      args: { sourceKind: 'agent_chat', sessionId: 'chat-1', harness: 'papercusp' },
      enabled: true,
    });
  });

  it('renders every available non-transcript frame without inventing missing sections', () => {
    render(<ConversationContextProjectionView projection={PROJECTION} />);
    const root = screen.getByTestId('conversation-context-projection');
    expect(root.dataset.capabilityTier).toBe('owned-loop');
    expect(screen.getByText('papercusp')).toBeTruthy();
    expect(screen.getByText('Shipping projection')).toBeTruthy();
    expect(screen.getByText('Shared row')).toBeTruthy();
    expect(screen.getByText('capability:edit')).toBeTruthy();
    expect(screen.queryByText('Plan')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /context/i }));
    expect(screen.queryByText('Shipping projection')).toBeNull();
  });

  it('routes tool frames through ChatMessage.tools and keeps only an unmatched live tail', () => {
    const projected = conversationProjectionMessages(PROJECTION);
    expect(projected).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', role: 'user', content: 'Build it' }),
      expect.objectContaining({ id: 'tool-1', tools: [{ name: 'chat:ask_choice', input: { question: 'Route?' } }] }),
    ]));
    const merged = mergeConversationProjectionMessages(PROJECTION, [
      { role: 'user', content: 'Build it' },
      { role: 'assistant', content: 'Live delta' },
    ]);
    expect(merged.filter((message) => message.content === 'Build it')).toHaveLength(1);
    expect(merged.at(-1)?.content).toBe('Live delta');
  });

  it('renders nothing for an unavailable capability tier', () => {
    const { container } = render(<ConversationContextProjectionView projection={null} />);
    expect(container.innerHTML).toBe('');
  });
});
