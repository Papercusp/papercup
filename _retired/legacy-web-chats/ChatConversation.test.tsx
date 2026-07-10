// @vitest-environment jsdom
/**
 * ChatConversation.test.tsx — the shared Oracle/Operator chat surface. Covers
 * the exported lastUserMessageText recall helper and the component: empty state,
 * message rendering (role labels + content), the busy "thinking" row + disabled
 * input, the error row, submit + send-button enable/disable, the ↑-recall, tool
 * chip vs card rendering, the banner, hideInput, and the load-earlier states.
 *
 * Seam: @tanstack/react-virtual is mocked to render every message (jsdom has no
 * layout, so the real virtualizer would render nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// jsdom lacks both — the scroll-to-bottom effect and the load-earlier
// IntersectionObserver effect call them on render.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
});
afterEach(() => vi.unstubAllGlobals());

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ index: i, key: `vk-${i}`, start: i * 64, size: 64 })),
    getTotalSize: () => opts.count * 64,
    measureElement: () => {},
  }),
}));

import { ChatConversation, lastUserMessageText, type ChatMessage } from './ChatConversation';

const Icon = (p: Record<string, unknown>) => <svg data-testid="empty-icon" {...p} />;

describe('lastUserMessageText', () => {
  it('returns the most recent non-empty user message', () => {
    expect(lastUserMessageText([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'last' }])).toBe('last');
    expect(lastUserMessageText([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])).toBe('hi');
  });
  it('skips assistant/system and whitespace-only user messages', () => {
    expect(lastUserMessageText([{ role: 'assistant', content: 'yo' }])).toBeNull();
    expect(lastUserMessageText([{ role: 'user', content: '   ' }])).toBeNull();
    expect(lastUserMessageText([])).toBeNull();
  });
});

function renderChat(over: Record<string, unknown> = {}) {
  const onInputChange = vi.fn();
  const onSubmit = vi.fn();
  const props = {
    messages: [] as ChatMessage[], busy: false, error: null as string | null,
    emptyState: { title: 'Oracle', body: 'Ask me anything', icon: Icon },
    inputValue: '', onInputChange, onSubmit,
    ...over,
  };
  render(<ChatConversation {...(props as never)} />);
  return { onInputChange, onSubmit };
}

afterEach(cleanup);

describe('ChatConversation', () => {
  it('renders the empty state when there are no messages', () => {
    renderChat();
    expect(screen.getByText('Oracle')).toBeTruthy();
    expect(screen.getByText('Ask me anything')).toBeTruthy();
  });

  it('renders message content and the You role label', () => {
    renderChat({ messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi there' }] });
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Hi there')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
  });

  it('shows the thinking row and disables input while busy', () => {
    renderChat({ busy: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(screen.getByText(/Oracle is thinking/)).toBeTruthy();
    expect((screen.getByLabelText('Send a message…') as HTMLInputElement).disabled).toBe(true);
  });

  it('renders the error row', () => {
    renderChat({ error: 'boom' });
    expect(screen.getByText(/⚠ boom/)).toBeTruthy();
  });

  it('submits on send and gates the button on input/busy', () => {
    const { onSubmit } = renderChat({ inputValue: 'hey' });
    const send = screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    cleanup();
    renderChat({ inputValue: '' });
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('forwards typing to onInputChange', () => {
    const { onInputChange } = renderChat();
    fireEvent.change(screen.getByLabelText('Send a message…'), { target: { value: 'draft' } });
    expect(onInputChange).toHaveBeenCalledWith('draft');
  });

  it('recalls the last user message on ↑ in an empty composer', () => {
    const { onInputChange } = renderChat({ inputValue: '', messages: [{ role: 'user', content: 'previous' }, { role: 'assistant', content: 'reply' }] });
    fireEvent.keyDown(screen.getByLabelText('Send a message…'), { key: 'ArrowUp' });
    expect(onInputChange).toHaveBeenCalledWith('previous');
  });

  it('hides the composer when hideInput is set', () => {
    renderChat({ hideInput: true });
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull();
  });

  it('renders a tool card below content (and suppresses the chip for it)', () => {
    renderChat({
      messages: [{ role: 'assistant', content: 'C', tools: [{ name: 'ask' }] }],
      renderToolCard: () => <div data-testid="tool-card" />,
      renderToolChip: () => <div data-testid="tool-chip" />,
    });
    expect(screen.getByTestId('tool-card')).toBeTruthy();
    expect(screen.queryByTestId('tool-chip')).toBeNull();
  });

  it('falls back to the tool chip when no card is produced', () => {
    renderChat({
      messages: [{ role: 'assistant', content: 'C', tools: [{ name: 'ask' }] }],
      renderToolChip: (_t: unknown, i: number) => <div key={i} data-testid="tool-chip" />,
    });
    expect(screen.getByTestId('tool-chip')).toBeTruthy();
  });

  it('renders a banner above the transcript', () => {
    renderChat({ banner: <div data-testid="banner" /> });
    expect(screen.getByTestId('banner')).toBeTruthy();
  });

  it('shows load-earlier states (beginning vs loading)', () => {
    renderChat({ messages: [{ role: 'user', content: 'hi' }], onLoadEarlier: () => {}, hasMoreEarlier: false });
    expect(screen.getByText('Beginning of conversation')).toBeTruthy();
    cleanup();
    renderChat({ messages: [{ role: 'user', content: 'hi' }], onLoadEarlier: () => {}, hasMoreEarlier: true, loadingEarlier: true });
    expect(screen.getByText('Loading earlier…')).toBeTruthy();
  });
});
