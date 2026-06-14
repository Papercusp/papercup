/**
 * @vitest-environment jsdom
 *
 * EI-577 regression — a FAILED chat turn must not vanish silently.
 *
 * The bug: when the messages stream ends in an SSE `error` event (rate-limit,
 * backend failure), `send()` ran `setSendState({kind:'idle'})` UNCONDITIONALLY
 * after the stream closed, clobbering the error state the loop had just set. The
 * user saw the "thinking" indicator appear then vanish with no reply and no
 * error. This pins that the inline error banner appears AND stays.
 *
 * Also covers the follow-up gap: a stream that closes with NEITHER a `done` nor
 * an `error` event (operator recycle / OOM / network drop). No failure marker
 * is persisted server-side, so the panel must surface the gap itself instead of
 * resetting to idle — same vanish symptom, different cause.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// useSyncQuery → a single chat row matching the panel's chatId so `chat`
// populates from the cache (loadChat takes the cached-row path, no REST fetch).
let syncRows: Array<Record<string, unknown>> = [];
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: syncRows, loading: false, fetching: false, error: null, invalidate: vi.fn() }),
}));

// The confirm dialog is only used by archive; stub it out of the way.
vi.mock('./useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false), element: null }),
}));

// Tooltip is a Radix tooltip that needs a TooltipProvider ancestor the real
// app supplies; render it as a passthrough here.
vi.mock('./Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import ChatPanel from './ChatPanel';

const SLUG = 'papercup';
const CHAT = 'c-err';

function chatRow(transcript: unknown[] = []) {
  return {
    harnessSlug: SLUG,
    id: CHAT,
    role: 'worker',
    featureId: 'F-FIX-013',
    title: 'Test failing repeatedly',
    transcript,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsdCents: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
  };
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

afterEach(() => {
  cleanup();
  syncRows = [];
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ChatPanel — failed turn (EI-577)', () => {
  it('keeps the inline error banner after the stream emits an SSE error', async () => {
    syncRows = [chatRow()];
    const errMsg = 'anthropic-direct: rate-limited — paused until 2026-06-14T08:50:00.000Z';
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return new Response(
          sseStream([`event: error\ndata: ${JSON.stringify({ message: errMsg })}\n\n`]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify(chatRow()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatPanel slug={SLUG} chatId={CHAT} />);

    // Compose box only renders once the chat row has loaded.
    const textarea = await screen.findByPlaceholderText(/Message worker/i);
    fireEvent.change(textarea, { target: { value: 'what happened?' } });
    fireEvent.submit(textarea.closest('form')!);

    // The error must surface...
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('rate-limited');

    // ...and STILL be there after the post-stream code has had a chance to run
    // (the regression was an unconditional reset to idle right here).
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('alert')?.textContent).toContain('rate-limited');

    // The user turn is shown; no assistant reply was produced.
    expect(screen.getByText('what happened?')).toBeTruthy();

    // The POST went to the messages endpoint (and no post-error refetch fired).
    const messageCalls = fetchMock.mock.calls.filter(
      ([u]) => typeof u === 'string' && u.includes('/messages'),
    );
    expect(messageCalls.length).toBe(1);
  });

  it('surfaces an error when the stream closes with no done/error event (dropped connection)', async () => {
    // Operator recycle / OOM / network blip: the SSE body closes WITHOUT a
    // terminal `done` or `error`. The server never persisted a failure marker,
    // so the panel itself must surface the gap instead of resetting to idle.
    syncRows = [chatRow()];
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        // Heartbeat only, then the connection drops — no done, no error.
        return new Response(sseStream([': hb\n\n']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify(chatRow()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatPanel slug={SLUG} chatId={CHAT} />);
    const textarea = await screen.findByPlaceholderText(/Message worker/i);
    fireEvent.change(textarea, { target: { value: 'what happened?' } });
    fireEvent.submit(textarea.closest('form')!);

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/connection closed|restarted/i);

    // Stays put — not clobbered by a post-stream idle reset.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('alert')?.textContent).toMatch(/connection closed|restarted/i);

    // No post-error refetch fired (the live subscription backfills if needed).
    const refetches = fetchMock.mock.calls.filter(
      ([u]) => typeof u === 'string' && u.includes('/agent-chats/') && !u.includes('/messages'),
    );
    expect(refetches.length).toBe(0);
  });

  it('flags an incomplete reply when the stream drops mid-delta', async () => {
    // Partial text streamed, then the connection drops before `done`.
    syncRows = [chatRow()];
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return new Response(
          sseStream([`event: delta\ndata: ${JSON.stringify({ text: 'Looking at the' })}\n\n`]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify(chatRow()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatPanel slug={SLUG} chatId={CHAT} />);
    const textarea = await screen.findByPlaceholderText(/Message worker/i);
    fireEvent.change(textarea, { target: { value: 'what happened?' } });
    fireEvent.submit(textarea.closest('form')!);

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/incomplete/i);
  });

  it('renders a persisted failure-marker turn distinctly on load', async () => {
    // Server persists the failed turn with error:true so a reload shows it
    // instead of a silent gap.
    syncRows = [
      chatRow([
        { role: 'user', content: 'what happened?', ts: new Date().toISOString() },
        {
          role: 'assistant',
          content: 'anthropic-direct: rate-limited — paused until later',
          ts: new Date().toISOString(),
          error: true,
        },
      ]),
    ];
    render(<ChatPanel slug={SLUG} chatId={CHAT} />);

    const failed = await screen.findByText(/rate-limited — paused until later/i);
    const turn = failed.closest('.chat-turn');
    expect(turn?.className).toContain('chat-turn--error');
  });
});
