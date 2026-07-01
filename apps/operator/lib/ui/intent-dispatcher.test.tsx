// @vitest-environment jsdom
/**
 * intent-dispatcher.test.tsx — coverage for UiIntentDispatcher, the tab-side
 * subscriber that runs ui:dispatch intents off an SSE stream. The component
 * renders nothing; its logic lives in the mount effect + executeIntent. We mock
 * the SSE factory (capture opts + a captured `message` handler + a close spy),
 * the client-id + intent-registry + built-in-intents helpers, and stub fetch to
 * record the result round-trip. Covers: built-in registration + stream open with
 * the client_id, the bad-message guards, the unknown-intent error, a handler
 * success/throw round-trip POST, the no-client-id early return, and unmount close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

let captured: {
  url: string;
  messageHandler?: (data: string) => void;
  onOpen?: () => void;
  onStatusChange?: (status: string) => void;
} | null = null;
const closeSpy = vi.fn();
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: (opts: {
    url: string;
    handlers: Record<string, (data: string) => void>;
    onOpen?: () => void;
    onStatusChange?: (status: string) => void;
  }) => {
    captured = {
      url: opts.url,
      messageHandler: opts.handlers.message,
      onOpen: opts.onOpen,
      onStatusChange: opts.onStatusChange,
    };
    return { close: closeSpy };
  },
}));

const reportReachable = vi.fn();
const reportUnreachable = vi.fn();
vi.mock('@papercusp/sync', () => ({
  reportSyncReachable: () => reportReachable(),
  reportSyncUnreachable: () => reportUnreachable(),
}));

let clientId: string;
vi.mock('@papercusp/operator-core/lib/ui/client-id', () => ({
  getOrCreateClientId: () => clientId,
}));

const registerBuiltInIntents = vi.fn();
vi.mock('@papercusp/operator-core/lib/ui/built-in-intents', () => ({
  registerBuiltInIntents: () => registerBuiltInIntents(),
}));

let handler: ((args: Record<string, unknown>) => unknown) | null;
vi.mock('@papercusp/operator-core/lib/ui/intent-registry', () => ({
  lookupIntent: (name: string) => (handler ? { name, handler } : undefined),
}));

import { UiIntentDispatcher } from './intent-dispatcher';

/** Flush microtasks so the async executeIntent → fetch round-trip settles. */
const flush = () => new Promise((r) => setTimeout(r, 0));

let posts: Array<{ url: string; body: unknown }>;
function installFetch() {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch);
}

beforeEach(() => {
  captured = null;
  closeSpy.mockReset();
  registerBuiltInIntents.mockReset();
  reportReachable.mockReset();
  reportUnreachable.mockReset();
  clientId = 'client-xyz';
  handler = null;
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UiIntentDispatcher', () => {
  it('renders nothing', () => {
    const { container } = render(<UiIntentDispatcher />);
    expect(container.firstChild).toBeNull();
  });

  it('registers built-in intents and opens the stream with the client_id', () => {
    render(<UiIntentDispatcher />);
    expect(registerBuiltInIntents).toHaveBeenCalledTimes(1);
    expect(captured).toBeTruthy();
    expect(captured!.url).toContain('/api/ui/intents/stream?client_id=client-xyz');
  });

  it('does not open a stream when there is no client_id', () => {
    clientId = '';
    render(<UiIntentDispatcher />);
    // Built-ins still register, but no source is created.
    expect(registerBuiltInIntents).toHaveBeenCalledTimes(1);
    expect(captured).toBeNull();
  });

  it('ignores malformed / incomplete messages (no result POST)', async () => {
    // The bad-JSON branch console.warns; spy so it doesn't trip fail-on-console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<UiIntentDispatcher />);
    captured!.messageHandler!('not json{');
    captured!.messageHandler!(JSON.stringify({ intent: 'x' })); // missing id
    captured!.messageHandler!(JSON.stringify({ id: 1 })); // missing intent
    await flush();
    expect(posts.length).toBe(0);
    expect(warn).toHaveBeenCalled(); // the bad-JSON path logged
    warn.mockRestore();
  });

  it('POSTs an unknown_intent error when no handler is registered', async () => {
    handler = null;
    render(<UiIntentDispatcher />);
    captured!.messageHandler!(JSON.stringify({ id: 7, intent: 'mystery', args: {} }));
    await flush();
    expect(posts.length).toBe(1);
    expect(posts[0].url).toBe('/api/ui/intents/7/result');
    expect(posts[0].body).toEqual({ result: null, error: 'unknown_intent: mystery' });
  });

  it('runs a matched handler and POSTs its result', async () => {
    handler = vi.fn(async (args: Record<string, unknown>) => ({ echoed: args.value }));
    render(<UiIntentDispatcher />);
    captured!.messageHandler!(JSON.stringify({ id: 9, intent: 'echo', args: { value: 42 } }));
    await flush();
    expect(handler).toHaveBeenCalledWith({ value: 42 });
    expect(posts[0].url).toBe('/api/ui/intents/9/result');
    expect(posts[0].body).toEqual({ result: { echoed: 42 }, error: null });
  });

  it('POSTs the error message when the handler throws', async () => {
    handler = vi.fn(async () => { throw new Error('boom'); });
    render(<UiIntentDispatcher />);
    captured!.messageHandler!(JSON.stringify({ id: 3, intent: 'explode', args: {} }));
    await flush();
    expect(posts[0].body).toEqual({ result: null, error: 'boom' });
  });

  it('closes the source on unmount', () => {
    const { unmount } = render(<UiIntentDispatcher />);
    unmount();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('feeds the shared sync connectivity store: onOpen reports reachable, a "failing" status reports unreachable', () => {
    render(<UiIntentDispatcher />);
    expect(captured!.onOpen).toBeTypeOf('function');
    expect(captured!.onStatusChange).toBeTypeOf('function');

    captured!.onOpen!();
    expect(reportReachable).toHaveBeenCalledTimes(1);

    captured!.onStatusChange!('failing');
    expect(reportUnreachable).toHaveBeenCalledTimes(1);

    // Other statuses don't report unreachable.
    captured!.onStatusChange!('open');
    captured!.onStatusChange!('connecting');
    expect(reportUnreachable).toHaveBeenCalledTimes(1);
  });
});
