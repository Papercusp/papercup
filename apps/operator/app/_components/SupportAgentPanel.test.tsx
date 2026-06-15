// @vitest-environment jsdom
//
// SupportAgentPanel — the AI support chat panel (SSE-streamed from a remote
// /v1/support/chat). On localhost it skips the CORS status probe and renders
// immediately. Real render logic exercised here: the budget readout, the
// disabled-until-typed Ask button, and that an empty submit is a no-op. The
// network send path needs a live SSE endpoint, so it's left to e2e.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// MarkdownPreview pulls in the editor stack; a passthrough is enough — no
// assistant message is rendered in these smoke cases anyway.
vi.mock('./MarkdownEditor', () => ({
  MarkdownPreview: ({ value }: { value: string }) => <div>{value}</div>,
}));
vi.mock('../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { SupportAgentPanel } from './SupportAgentPanel';

beforeEach(() => {
  // Defensive: the localhost branch should never fetch, but stub so an
  // unexpected call can't escape to the network / fail-on-console.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}), text: async () => '' })) as unknown as typeof fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<SupportAgentPanel />', () => {
  it('renders the assistant card with the default budget readout on localhost', () => {
    render(<SupportAgentPanel />);
    expect(screen.getByText(/Try the AI assistant/i)).toBeTruthy();
    // costUsd 0 / budgetCap 0.50 default.
    expect(screen.getByText('$0.0000 / $0.50')).toBeTruthy();
  });

  it('disables the Ask button until the user types', () => {
    render(<SupportAgentPanel />);
    const ask = screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/set up my first harness/i), {
      target: { value: 'how do plugins work?' },
    });
    expect(ask.disabled).toBe(false);
  });

  it('does not start a request when the input is empty (no network call)', () => {
    render(<SupportAgentPanel />);
    const form = screen.getByRole('button', { name: 'Ask' }).closest('form')!;
    fireEvent.submit(form);
    // The localhost mount makes zero fetches; an empty submit adds none.
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
