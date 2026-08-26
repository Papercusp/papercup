// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  schemaVersion: "conversation-context-v1",
  session: {
    sourceKind: "agent_chat",
    sessionId: "chat-1",
    harness: "papercusp",
    role: "worker",
    linkedWorkItemId: "WI-42177",
    capabilityTier: "owned-loop",
  },
  capabilities: { liveFrames: true, taskWrite: true, approvalWrite: true },
  frames: [
    {
      id: "m1",
      kind: "message",
      role: "user",
      text: "Build it",
      timestamp: "2026-08-26T00:00:00Z",
    },
    {
      id: "tool-1",
      kind: "tool",
      callId: "c1",
      name: "chat:ask_choice",
      input: { question: "Route?" },
      stepIndex: 1,
      needsApproval: false,
      state: "succeeded",
    },
    {
      id: "ctx-1",
      kind: "context",
      section: "identity",
      title: "Identity",
      entries: [{ label: "Harness", value: "papercusp" }],
    },
    {
      id: "task-1",
      kind: "task",
      taskId: "t1",
      content: "Ship projection",
      activeForm: "Shipping projection",
      status: "in_progress",
      blockerRef: null,
      blockerState: null,
      explanation: "Shared row",
      position: 0,
      updatedAt: "2026-08-26T00:00:01Z",
    },
    {
      id: "approval-1",
      kind: "approval",
      callId: "c2",
      toolName: "capability:edit",
      input: {},
      stepIndex: 2,
      requestedAt: "2026-08-26T00:00:02Z",
      status: "pending",
    },
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

function AcceptProjectionProbe() {
  const { projection, acceptProjection } = useConversationContextProjection({
    sourceKind: 'agent_chat',
    sessionId: 'chat-1',
    harness: 'papercusp',
  });
  const task = projection?.frames.find((frame) => frame.kind === 'task');
  return (
    <>
      <span>{task?.status ?? 'missing'}</span>
      <button
        type="button"
        onClick={() => acceptProjection({
          ...PROJECTION,
          frames: PROJECTION.frames.map((frame) => (
            frame.kind === 'task' ? { ...frame, status: 'completed' as const } : frame
          )),
        })}
      >
        Accept mutation projection
      </button>
    </>
  );
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

  it('paints an accepted mutation projection before the subscription advances', () => {
    H.rows = [PROJECTION];
    render(<AcceptProjectionProbe />);
    expect(screen.getByText('in_progress')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept mutation projection' }));
    expect(screen.getByText('completed')).toBeTruthy();
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

  it('emits add, edit, check, and drop actions only through the supplied callback', async () => {
    const onTaskAction = vi.fn(async () => {});
    render(
      <ConversationContextProjectionView
        projection={PROJECTION}
        onTaskAction={onTaskAction}
      />,
    );

    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'Add regression coverage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add',
      content: 'Add regression coverage',
    })));

    fireEvent.click(screen.getByRole('button', { name: 'Edit task: Ship projection' }));
    fireEvent.change(screen.getByLabelText('Task content: Ship projection'), {
      target: { value: 'Ship shared projection' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'edit',
      taskId: 't1',
      content: 'Ship shared projection',
    })));

    fireEvent.click(screen.getByRole('button', { name: 'Check task: Ship projection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drop task: Ship projection' }));
    await waitFor(() => {
      expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'check', taskId: 't1' }));
      expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'drop', taskId: 't1' }));
    });
  });

  it('offers manual blocker clearing but hides every control for a read-only tier', async () => {
    const onTaskAction = vi.fn(async () => {});
    const blockedProjection: ConversationContextProjection = {
      ...PROJECTION,
      frames: PROJECTION.frames.map((frame) => frame.kind === 'task' ? {
        ...frame,
        status: 'blocked' as const,
        blockerRef: 'Waiting for operator input',
        blockerState: {
          ref: 'Waiting for operator input',
          kind: 'text',
          target: 'Waiting for operator input',
          typed: false,
          status: 'manual',
          autoUnblocks: false,
        },
      } : frame),
    };
    const { rerender } = render(
      <ConversationContextProjectionView
        projection={blockedProjection}
        onTaskAction={onTaskAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear blocker for task: Ship projection' }));
    await waitFor(() => expect(onTaskAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'clear_blocker',
      taskId: 't1',
    })));

    rerender(
      <ConversationContextProjectionView
        projection={{
          ...blockedProjection,
          capabilities: { ...blockedProjection.capabilities, taskWrite: false },
        }}
        onTaskAction={onTaskAction}
      />,
    );
    expect(screen.queryByLabelText('New task')).toBeNull();
    expect(screen.queryByRole('button', { name: /task:/i })).toBeNull();
  });

  it('renders the shared busy and error props for task mutations', () => {
    render(
      <ConversationContextProjectionView
        projection={PROJECTION}
        onTaskAction={vi.fn()}
        taskActionBusy
        taskActionError="Task write failed"
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Task write failed');
    expect(screen.getByLabelText('New task')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Edit task: Ship projection' })).toHaveProperty('disabled', true);
  });
});
