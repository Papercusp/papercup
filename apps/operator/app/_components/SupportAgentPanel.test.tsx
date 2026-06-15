// @vitest-environment jsdom
//
// SupportAgentPanel — the AI support chat panel (SSE-streamed from a remote
// /v1/support/chat). On localhost it skips the CORS status probe and renders
// immediately. Real render logic exercised here: the budget readout, the
// disabled-until-typed Ask button, and that an empty submit is a no-op. The
// network send path needs a live SSE endpoint, so it's left to e2e.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  // jsdom doesn't implement Element.scrollIntoView; the panel calls it in a
  // post-message effect. Stub it so streaming a message doesn't throw.
  if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  // Defensive: the localhost branch should never fetch, but stub so an
  // unexpected call can't escape to the network / fail-on-console.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}), text: async () => '' })) as unknown as typeof fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Build a Response whose body is a ReadableStream emitting the given SSE
 *  frame strings (each already terminated by the "\n\n" the parser splits on). */
function sseResponse(frames: string[], ok = true): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return { ok, status: ok ? 200 : 500, body, text: async () => 'request failed' } as unknown as Response;
}

async function typeAndAsk(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/set up my first harness/i), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

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

  it('streams token frames into the assistant message and applies the done cost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'event: token\ndata: "Hello, "\n\n',
      'event: token\ndata: "world"\n\n',
      'event: done\ndata: {"costUsd":0.0123,"capExceeded":false}\n\n',
    ])));
    render(<SupportAgentPanel />);
    await typeAndAsk('hi');
    // The user turn renders, and the assistant message accumulates the two tokens.
    await waitFor(() => expect(screen.getByText('Hello, world')).toBeTruthy());
    expect(screen.getByText('hi')).toBeTruthy();
    // The done frame's cost updates the budget readout.
    await waitFor(() => expect(screen.getByText('$0.0123 / $0.50')).toBeTruthy());
    // POST body carried the message + surface.
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({ message: 'hi', surface: 'operator' });
  });

  it('renders the ❌ error text when the POST responds non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([], false)));
    render(<SupportAgentPanel />);
    await typeAndAsk('hi');
    await waitFor(() => expect(screen.getByText(/❌ request failed/)).toBeTruthy());
  });

  it('renders an ❌ message when the stream emits an error event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'event: error\ndata: "rate limited"\n\n',
    ])));
    render(<SupportAgentPanel />);
    await typeAndAsk('hi');
    await waitFor(() => expect(screen.getByText('❌ rate limited')).toBeTruthy());
  });

  it('disables the input + Ask button and shows the cap banner once a done frame sets capExceeded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'event: token\ndata: "ok"\n\n',
      'event: done\ndata: {"capExceeded":true}\n\n',
    ])));
    render(<SupportAgentPanel />);
    await typeAndAsk('hi');
    await waitFor(() => expect(screen.getByText(/budget cap hit/i)).toBeTruthy());
    // Input + Ask are disabled while capExceeded.
    expect((screen.getByPlaceholderText(/set up my first harness/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the "talk to a human" button dispatches the papercusp:open-support event', () => {
    render(<SupportAgentPanel />);
    const onOpen = vi.fn();
    window.addEventListener('papercusp:open-support', onOpen);
    try {
      fireEvent.click(screen.getByRole('button', { name: /talk to a human/i }));
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('papercusp:open-support', onOpen);
    }
  });

  it('renders nothing when the (non-localhost) status probe reports the agent unavailable', async () => {
    // Force the non-localhost branch by faking a non-local host.
    const origHost = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, host: 'app.papercuspai.com' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false }) }) as unknown as Response));
    try {
      const { container } = render(<SupportAgentPanel />);
      // agentAvailable resolves false → the panel renders null.
      await waitFor(() => expect(container.querySelector('h3')).toBeNull());
    } finally {
      if (origHost) Object.defineProperty(window, 'location', origHost);
    }
  });
});
