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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationContextProjection } from '@papercusp/operator-core/lib/conversation-context-projection';

// useSyncQuery → a single chat row matching the panel's chatId so `chat`
// populates from the cache (loadChat takes the cached-row path, no REST fetch).
let syncRows: Array<Record<string, unknown>> = [];
let projectionRows: ConversationContextProjection[] = [];
const syncCalls: Array<{ queryName?: string; args?: unknown }> = [];
// Whether the subscription is still resolving. Default false = settled, which is
// what every pre-existing test wants; the WI-5125 cases below flip it to assert
// the loading-vs-resolved-but-empty distinction.
let syncLoading = false;
const invalidateSpy = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (input: { queryName?: string; args?: unknown }) => {
    syncCalls.push(input);
    return {
    data: input.queryName === 'conversations.contextProjection' ? projectionRows : syncRows,
    loading: syncLoading,
    fetching: false,
    error: null,
    invalidate: invalidateSpy,
    };
  },
}));

let lastOperatorChatProps: Record<string, unknown> | null = null;
vi.mock('@/app/_components/OperatorChat', () => ({
  OperatorChat: (props: Record<string, unknown>) => {
    lastOperatorChatProps = props;
    return <div data-testid="operator-chat-probe" />;
  },
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

// P-006 perf-marks wiring: spy begin/end, keep the real PERF_INTERACTIONS names.
const perfMarks = vi.hoisted(() => ({ begin: vi.fn(), end: vi.fn() }));
vi.mock('@/app/_components/perf/perf-marks', async (orig) => ({
  ...(await orig<typeof import('@/app/_components/perf/perf-marks')>()),
  beginInteraction: perfMarks.begin,
  endInteraction: perfMarks.end,
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

function taskProjection(
  status: 'pending' | 'completed' = 'pending',
): ConversationContextProjection {
  return {
    schemaVersion: 'conversation-context-v1',
    session: {
      sourceKind: 'agent_chat',
      sessionId: CHAT,
      harness: SLUG,
      role: 'worker',
      linkedWorkItemId: 'WI-42177',
      capabilityTier: 'owned-loop',
    },
    capabilities: { liveFrames: true, taskWrite: true, approvalWrite: true },
    frames: [{
      id: 'task:task-1',
      kind: 'task',
      taskId: 'task-1',
      content: 'Ship projection',
      activeForm: 'Shipping projection',
      status,
      blockerRef: null,
      blockerState: null,
      explanation: null,
      position: 0,
      updatedAt: '2026-08-26T00:00:01Z',
    }],
  };
}

afterEach(() => {
  cleanup();
  syncRows = [];
  projectionRows = [];
  syncCalls.length = 0;
  lastOperatorChatProps = null;
  syncLoading = false;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * WI-5125 — the owner-reported "loading chat… forever" bug.
 *
 * The chat row existed but carried a different workspace_id, so the panel's
 * workspace-scoped read matched ZERO rows. `useSyncQuery` reports that as
 * `{ data: [], error: null }` — no row AND no error — which matched neither of
 * loadChat's branches, so `chat` stayed null and the panel rendered its spinner
 * forever with no way out.
 *
 * The distinction these tests pin: STILL-LOADING must keep spinning, but
 * RESOLVED-AND-EMPTY is a real, reportable outcome. Empty is never eternal.
 */
describe('ChatPanel — conversation-thread-load perf interaction (P-006)', () => {
  it('begins on open (chatId set) and ends when the thread renders', async () => {
    syncRows = [chatRow()]; // resolves to a matching chat.id === chatId
    render(<ChatPanel slug={SLUG} chatId={CHAT} />);
    // begins the moment the conversation is opened…
    expect(perfMarks.begin).toHaveBeenCalledWith('conversation-thread-load');
    // …and ends once that chat's transcript first renders.
    await waitFor(() => expect(perfMarks.end).toHaveBeenCalledWith('conversation-thread-load'));
  });
});

describe('ChatPanel — shared conversation/context projection (P-009)', () => {
  it('queries the canonical frame source and hands its tool frames to OperatorChat', async () => {
    syncRows = [chatRow([{ role: 'user', content: 'Ship it', ts: '2026-08-26T00:00:00Z' }])];
    projectionRows = [{
      schemaVersion: 'conversation-context-v1',
      session: {
        sourceKind: 'agent_chat',
        sessionId: CHAT,
        harness: SLUG,
        role: 'worker',
        linkedWorkItemId: 'WI-42177',
        capabilityTier: 'owned-loop',
      },
      capabilities: { liveFrames: true, taskWrite: true, approvalWrite: true },
      frames: [
        { id: 'm1', kind: 'message', role: 'user', text: 'Ship it', timestamp: '2026-08-26T00:00:00Z' },
        { id: 'tool-1', kind: 'tool', callId: 'c1', name: 'work_items:complete', input: { id: 'WI-42177' }, stepIndex: 1, needsApproval: false, state: 'succeeded' },
        { id: 'ctx-1', kind: 'context', section: 'identity', title: 'Identity', entries: [{ label: 'Harness', value: SLUG }] },
      ],
    }];

    render(<ChatPanel slug={SLUG} chatId={CHAT} />);

    expect(await screen.findByTestId('conversation-context-projection')).toBeTruthy();
    expect(screen.getByText(SLUG)).toBeTruthy();
    expect(syncCalls).toContainEqual(expect.objectContaining({
      queryName: 'conversations.contextProjection',
      args: { sourceKind: 'agent_chat', sessionId: CHAT, harness: SLUG },
    }));
    expect(lastOperatorChatProps?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'tool-1',
        tools: [{ name: 'work_items:complete', input: { id: 'WI-42177' } }],
      }),
    ]));
  });

  it('posts task controls and paints the response projection before sync advances', async () => {
    syncRows = [chatRow()];
    projectionRows = [taskProjection('pending')];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/tasks')) {
        return new Response(JSON.stringify({
          ok: true,
          action: 'check',
          op: 'done',
          changedTaskId: 'task-1',
          tasks: [],
          projection: taskProjection('completed'),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatPanel slug={SLUG} chatId={CHAT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check task: Ship projection' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/harness/${SLUG}/agent-chats/${CHAT}/tasks`,
      expect.objectContaining({ method: 'POST' }),
    ));
    const taskCall = fetchMock.mock.calls.find(([url]) => url.includes('/tasks'));
    expect(JSON.parse(String(taskCall?.[1]?.body))).toMatchObject({
      action: 'check',
      taskId: 'task-1',
    });
    expect(await screen.findByText('Completed')).toBeTruthy();
    expect(projectionRows[0]?.frames.find((frame) => frame.kind === 'task')).toMatchObject({
      status: 'pending',
    });
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('surfaces canonical task mutation errors without replacing the projection', async () => {
    syncRows = [chatRow()];
    projectionRows = [taskProjection('pending')];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'task_write_unavailable', message: 'Task writes are unavailable.' },
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));

    render(<ChatPanel slug={SLUG} chatId={CHAT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check task: Ship projection' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Task writes are unavailable.');
    expect(screen.getByText('Pending')).toBeTruthy();
  });
});

describe('ChatPanel — hosting-surface context', () => {
  it('forwards non-empty context with the message instead of dropping the host identity', async () => {
    syncRows = [chatRow()];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      sseStream([`event: done\ndata: ${JSON.stringify({})}\n\n`]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ChatPanel
        slug={SLUG}
        chatId={CHAT}
        context='{"surface":"workflows-detail","planSlug":"meeting-prep"}'
      />,
    );
    const textarea = await screen.findByPlaceholderText(/Message worker/i);
    fireEvent.change(textarea, { target: { value: 'change the filter' } });
    fireEvent.submit(textarea.closest('form')!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const messageCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/messages'),
    );
    const request = messageCall?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      content: 'change the filter',
      context: '{"surface":"workflows-detail","planSlug":"meeting-prep"}',
    });
  });

  it('sends a hosting surface initial message once through the canonical stream', async () => {
    syncRows = [chatRow()];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      sseStream([`event: done\ndata: ${JSON.stringify({})}\n\n`]),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ChatPanel
        slug={SLUG}
        chatId={CHAT}
        initialMessage="Build a disarmed Gmail triage workflow"
        context='{"surface":"workflows-composer","harness":"papercup"}'
      />,
    );

    await waitFor(() => expect(fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/messages'),
    )).toHaveLength(1));
    const request = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/messages'),
    )?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      content: 'Build a disarmed Gmail triage workflow',
      context: '{"surface":"workflows-composer","harness":"papercup"}',
    });
  });
});

describe('ChatPanel — resolved-but-empty is an error, not an eternal spinner (WI-5125)', () => {
  it('surfaces a not-found fault when the subscription settles with zero rows', async () => {
    syncRows = [];
    syncLoading = false;
    render(<ChatPanel slug={SLUG} chatId={CHAT} />);
    expect(await screen.findByText(/chat not found/i)).toBeTruthy();
    // The spinner must be GONE — its persistence IS the reported bug.
    expect(screen.queryByText(/loading chat/i)).toBeNull();
  });

  it('still shows the spinner while the subscription is genuinely loading', async () => {
    syncRows = [];
    syncLoading = true;
    render(<ChatPanel slug={SLUG} chatId={CHAT} />);
    // Empty + loading is NOT a fault — don't cry not-found mid-flight.
    expect(await screen.findByText(/loading chat/i)).toBeTruthy();
    expect(screen.queryByText(/chat not found/i)).toBeNull();
  });

  it('retry REFETCHES rather than re-reading the same cached emptiness', async () => {
    syncRows = [];
    syncLoading = false;
    render(<ChatPanel slug={SLUG} chatId={CHAT} />);
    await screen.findByText(/chat not found/i);
    fireEvent.click(screen.getByText('retry'));
    // Without this the button re-derives the identical failure from cache and
    // the panel is just as stuck — only with a louder message.
    expect(invalidateSpy).toHaveBeenCalled();
  });
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
