/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OperatorChatSidebar } from '../OperatorChatSidebar';
import { OPERATOR_CHAT_COLLAPSED_WIDTH } from '../operator-chat-layout';

vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    parseAsBoolean: {
      withDefault(defaultValue: boolean) {
        return { defaultValue };
      },
    },
    useQueryState(_key: string, parser?: { defaultValue?: boolean }) {
      return React.useState(parser?.defaultValue ?? true);
    },
  };
});

vi.mock('../OperatorConversationProvider', () => ({
  useOperatorConversation: () => ({
    messages: [],
    busy: false,
    mode: 'active',
    bannerText: null,
    error: null,
    hasMoreEarlier: false,
    loadingEarlier: false,
    conversationId: 'conv-1',
    sendUserMessage: vi.fn(),
    generateIdeas: vi.fn(),
    loadEarlier: vi.fn(),
    answerChoice: vi.fn(),
  }),
}));

vi.mock('../OperatorChat', () => ({
  OperatorChat: () => <div data-testid="operator-chat">Operator chat</div>,
}));

vi.mock('../chat/LocalCardHost', () => ({
  LocalCardHost: () => <div data-testid="local-card-host" />,
}));

vi.mock('@/lib/hotkeys', () => ({
  useShortcutAction: () => undefined,
}));

vi.mock('@/lib/use-workspace-id', () => ({
  useWorkspaceId: () => 'ws-test',
}));

vi.mock('../OperatorLogoMark', () => ({
  OperatorLogoMark: ({ className }: { className?: string }) => <span className={className}>Logo</span>,
}));

vi.mock('../OperatorWordmarkLockup', () => ({
  OperatorWordmarkLockup: ({ className, titleClassName }: { className?: string; titleClassName?: string }) => (
    <div className={className}>
      <strong className={titleClassName}>Papercup</strong>
    </div>
  ),
}));

vi.mock('../OperatorActiveToggle', () => ({
  OperatorActiveToggle: () => <button type="button">Active</button>,
}));

vi.mock('../voice/VoiceButton', () => ({
  VoiceButton: () => <button type="button">Voice</button>,
}));
const localStorageState = new Map<string, string>();

beforeEach(() => {
  localStorageState.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => localStorageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageState.set(key, String(value));
      },
      removeItem: (key: string) => {
        localStorageState.delete(key);
      },
      clear: () => {
        localStorageState.clear();
      },
    },
  });
});

afterEach(() => {
  cleanup();
  localStorageState.clear();
  document.body.className = '';
  document.body.style.cssText = '';
  document.documentElement.style.removeProperty('--op-chat-w');
});

describe('OperatorChatSidebar collapse behavior', () => {
  it('collapses to a slim rail and can be expanded again', async () => {
    window.localStorage.setItem(wsLocalKey('papercusp.operatorChat.width'), '420');

    render(<OperatorChatSidebar />);

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe('420px');
    });
    expect(document.body.classList.contains('has-op-chat')).toBe(true);
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(false);
    expect(screen.getByRole('button', { name: 'Collapse Papercup chat' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Papercup chat' }));

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe(`${OPERATOR_CHAT_COLLAPSED_WIDTH}px`);
    });
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand Papercup chat' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Papercup chat' }));

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe('420px');
    });
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(false);
  });
});
