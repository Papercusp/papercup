// @vitest-environment jsdom
/**
 * OperatorChat — thin wrapper over the shared <ChatConversation>. It owns the
 * input draft state, the submit handler (trim → onSend → clear), the
 * passive/active empty-state copy, the quick-draft prompt buttons, the optional
 * "Generate ideas" composer button, and the PendingCardsBar gating. We stub
 * ChatConversation to surface the props OperatorChat computes (emptyState,
 * composerExtra, banner, onSubmit) so we can assert its own logic without the
 * virtualized transcript. Heavy children (cards, logo, Tooltip) are stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// Capture the props OperatorChat hands ChatConversation, and render a tiny
// controllable surface: the empty-state body, the banner, the composer extra,
// and an input wired to onInputChange/onSubmit so we can drive submit().
let lastProps: Record<string, any> = {};
vi.mock('./chat/ChatConversation', () => ({
  ChatConversation: (props: Record<string, any>) => {
    lastProps = props;
    return (
      <div data-testid="chat">
        <div data-testid="empty-body">{props.emptyState?.body}</div>
        <div data-testid="empty-extra">{props.emptyState?.extra}</div>
        <div data-testid="banner">{props.banner}</div>
        <div data-testid="composer-extra">{props.composerExtra}</div>
        <input
          data-testid="input"
          value={props.inputValue}
          onChange={(e) => props.onInputChange?.(e.currentTarget.value)}
        />
        <button data-testid="submit" onClick={() => props.onSubmit?.()}>send</button>
      </div>
    );
  },
}));

vi.mock('./chat/PendingCardsBar', () => ({
  PendingCardsBar: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="pending-cards" data-conv={conversationId} />
  ),
}));
vi.mock('@/lib/chat-cards', () => ({ renderCard: () => null }));
vi.mock('./OperatorLogoMark', () => ({ OperatorLogoMark: () => null }));
vi.mock('../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { OperatorChat } from './OperatorChat';

function baseProps(over: Record<string, any> = {}) {
  return { messages: [], busy: false, passive: false, onSend: vi.fn(), ...over };
}

afterEach(() => {
  lastProps = {};
  cleanup();
});

describe('OperatorChat (operator sidebar chat wrapper)', () => {
  it('renders the active-mode empty-state body', () => {
    render(<OperatorChat {...baseProps({ passive: false })} />);
    expect(screen.getByTestId('empty-body').textContent).toMatch(/inspect, scan, or unblock/i);
  });

  it('renders the passive-mode empty-state body', () => {
    render(<OperatorChat {...baseProps({ passive: true })} />);
    expect(screen.getByTestId('empty-body').textContent).toMatch(/passive mode/i);
  });

  it('quick-draft prompt buttons populate the composer input', () => {
    render(<OperatorChat {...baseProps()} />);
    // The empty-state extra panel renders the three starting-prompt rows.
    const scan = screen.getByText('Scan workspaces');
    fireEvent.click(scan.closest('button')!);
    // setInput was called with the prompt → ChatConversation re-renders with it.
    expect(lastProps.inputValue).toMatch(/Scan my workspaces/i);
  });

  it('submit trims the input, calls onSend, and clears the draft', () => {
    const onSend = vi.fn();
    render(<OperatorChat {...baseProps({ onSend })} />);
    fireEvent.change(screen.getByTestId('input'), { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByTestId('submit'));
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(lastProps.inputValue).toBe(''); // cleared after send
  });

  it('does not call onSend when the input is only whitespace', () => {
    const onSend = vi.fn();
    render(<OperatorChat {...baseProps({ onSend })} />);
    fireEvent.change(screen.getByTestId('input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('submit'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders the Generate ideas button only when onGenerateIdeas is provided', () => {
    const onGenerateIdeas = vi.fn();
    render(<OperatorChat {...baseProps({ onGenerateIdeas })} />);
    const btn = screen.getByLabelText('Generate ideas');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onGenerateIdeas).toHaveBeenCalledTimes(1);
  });

  it('omits the Generate ideas button when onGenerateIdeas is absent', () => {
    render(<OperatorChat {...baseProps()} />);
    expect(screen.queryByLabelText('Generate ideas')).toBeNull();
  });

  it('renders the PendingCardsBar only when both conversationId and workspaceId are set', () => {
    const { rerender } = render(<OperatorChat {...baseProps({ conversationId: 'c1' })} />);
    expect(screen.queryByTestId('pending-cards')).toBeNull(); // workspaceId missing

    rerender(<OperatorChat {...baseProps({ conversationId: 'c1', workspaceId: 'w1' })} />);
    const bar = screen.getByTestId('pending-cards');
    expect(bar.getAttribute('data-conv')).toBe('c1');
  });
});
