// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: {} as Record<string, string | null>, writes: {} as Record<string, unknown>,
  inspector: null as Record<string, any> | null,
  resolve: vi.fn(),
}));
vi.mock('nuqs', () => ({ parseAsString: {}, useQueryState: (key: string) => [state.query[key] ?? null, (value: unknown) => { state.writes[key] = value; }] }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [{ active: [] }] }) }));
vi.mock('../../_components/chat/use-owner-session-chat', () => ({ useOwnerSessionChat: (...args: unknown[]) => { state.resolve(...args); return { streamUrl: '/api/adv/session/thinking?sessionId=live', resolving: false }; } }));
vi.mock('../../harness/AgentInspectorModal', () => ({ default: (props: Record<string, any>) => {
  state.inspector = props;
  return <div role="dialog" aria-label="Session history"><button onClick={() => props.onOpenInGui(props.conversationOwnerId)}>Open conversation</button></div>;
} }));
vi.mock('../../harness/Modal', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import SessionHistoryModal from './SessionHistoryModal';

beforeEach(() => { state.query = {}; state.writes = {}; state.inspector = null; state.resolve.mockClear(); });
afterEach(cleanup);

describe('Session history host', () => {
  it('keeps history separate from the HUD conversation until explicitly requested', () => {
    state.query = { agentHistory: 'su-one' };
    render(<SessionHistoryModal />);
    expect(screen.getByRole('dialog', { name: 'Session history' })).toBeTruthy();
    expect(state.writes).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    expect(state.writes).toEqual({ agentHistory: null, agentHistorySession: null, app: 'hud', hudsession: 'su-one', agentConversation: 'su-one' });
  });
  it.each([
    ['codex:42', 'codexSessionKey', '42'],
    ['claude:older-uuid', 'sessionId', 'older-uuid'],
    ['omp:older-thread:17', 'ompThreadId', 'older-thread'],
  ])('opens the exact selected inactive transcript (%s)', (source, key, value) => {
    state.query = { agentHistory: 'su-one', agentHistorySession: source };
    render(<SessionHistoryModal />);
    const params = new URL(state.inspector!.streamUrl, 'http://test').searchParams;
    expect(params.get(key)).toBe(value);
    expect(params.get('ended')).toBe('1');
    expect(state.resolve.mock.calls[0][0]).toBeNull();
  });
  it('mounts no inspector without a selection', () => {
    render(<SessionHistoryModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
