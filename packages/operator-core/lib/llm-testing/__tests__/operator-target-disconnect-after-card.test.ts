/**
 * WI-5613 regression — a mid-turn transport disconnect AFTER the expected
 * blocking card was already observed must not sink the whole run to
 * `errored`.
 *
 * Root cause: op-S10-ask-choice (and any scenario exercising a blocking
 * human-in-the-loop tool like chat:ask_choice) legitimately keeps the
 * PRIMARY operator-converse SSE stream open for up to 10 minutes while
 * ctx.askUser blocks for a click nobody in this unattended harness will
 * ever send. Meanwhile, other fleet agents restarting the shared :3170
 * staging operator every few minutes (the documented WI-4221-class
 * restart-storm) kill that long-lived connection mid-turn — well AFTER the
 * SUT already made the correct tool call and the WI-5023 state-snapshot
 * watcher already observed the resulting card. The read loop then throws
 * (fetch/SSE reset), which used to set `finishReason: 'error'` unconditionally
 * and made runner.ts mark the *entire run* `errored`/inconclusive — even
 * though the tested behavior had already, verifiably, happened
 * (harness_shared.tool_invocations confirmed 6/6 well-formed calls; only the
 * harness's own verdict was a false negative).
 *
 * Fix: OperatorTarget now downgrades `finishReason` back to 'done' (and
 * flags `recoveredFromDisconnectAfterCard`) when the primary stream errors
 * AFTER a card was already captured — via the separate state-snapshot
 * watcher, or already present in `result.cards` from the primary stream
 * itself. A disconnect BEFORE any card ever arrives is untouched and still
 * errors the turn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OperatorTarget } from '../targets/operator';

function sseChunk(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function controllableSseStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    stream,
    push: (event: string, data: unknown) => ctrl.enqueue(sseChunk(event, data)),
    end: () => ctrl.close(),
    /** Simulate the underlying connection being severed mid-stream (e.g. an
     *  infra restart killing the socket) — makes the reader's next `read()`
     *  reject, exactly like a real ECONNRESET/'terminated' fetch error. */
    error: (err: Error) => ctrl.error(err),
  };
}

const ASK_CHOICE_CARD = {
  correlationId: 'cid-disconnect-1',
  prompt: 'Which repo should I clean up first?',
  dataSchemaJson: {},
  presentation: {
    kind: 'radio',
    options: [
      { id: 'repo-a', label: 'Repo A' },
      { id: 'repo-b', label: 'Repo B' },
    ],
  },
  fallbackText: 'Which repo should I clean up first?\n\nOptions:\n  1. Repo A\n  2. Repo B',
  createdAt: 0,
};

describe('OperatorTarget — WI-5613 recover from mid-turn disconnect after card observed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downgrades finishReason to done (and flags recoveredFromDisconnectAfterCard) when the primary stream errors AFTER the card was already observed', async () => {
    const conv = controllableSseStream();
    const snap = controllableSseStream();

    conv.push('run-meta', { runId: 'run-disconnect-1' });

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/agent-mcp/operator-converse')) {
        return new Response(conv.stream, { status: 200 });
      }
      if (u.includes('/operator/state-snapshot')) {
        queueMicrotask(() => {
          // The card arrives — proving the SUT already called the blocking
          // tool correctly — THEN, before the primary stream ever reaches
          // 'done', simulate the restart-storm severing it.
          snap.push('snapshot', {
            runId: 'run-disconnect-1',
            workspaceId: 'default',
            snapshot: { openCards: [ASK_CHOICE_CARD] },
          });
          queueMicrotask(() => {
            conv.error(new Error('terminated'));
          });
        });
        return new Response(snap.stream, { status: 200 });
      }
      if (u.includes('/card-response')) {
        // Best-effort auto-resolve — its outcome doesn't matter for this
        // test; the primary stream is already going to die regardless.
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch in WI-5613 regression: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const target = new OperatorTarget({ baseUrl: 'http://127.0.0.1:9999' });
    const session = await target.open({
      runId: 'scenario-run-disconnect-1',
      workspaceMode: 'real',
      transport: 'http-sse',
    });

    const result = await session.send({
      messages: [{ role: 'user', content: 'Which repo should I clean up first? Give me options.' }],
      trigger: 'user_message',
      meta: { modality: 'text' },
    });

    // The card was observed despite the primary stream dying.
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].kind).toBe('chat:ask_choice');

    // The whole point of the fix: NOT 'error' — a disconnect after the
    // expected signal already arrived must not sink the run.
    expect(result.finishReason).toBe('done');
    expect(result.recoveredFromDisconnectAfterCard).toBe(true);
    // The original disconnect reason is preserved for diagnostics.
    expect(result.error).toContain('terminated');

    await session.close();
  });

  it('still errors the turn when the stream disconnects BEFORE any card ever arrives (unchanged behavior)', async () => {
    const conv = controllableSseStream();
    conv.push('run-meta', { runId: 'run-disconnect-2' });

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/agent-mcp/operator-converse')) {
        return new Response(conv.stream, { status: 200 });
      }
      if (u.includes('/operator/state-snapshot')) {
        // No card ever delivered on this channel — the watcher settles on
        // `null` once stopped, exactly like the pre-fix "unobserved" path.
        return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const target = new OperatorTarget({ baseUrl: 'http://127.0.0.1:9999' });
    const session = await target.open({
      runId: 'scenario-run-disconnect-2',
      workspaceMode: 'real',
      transport: 'http-sse',
    });

    // Sever the primary stream immediately — no card was ever observed.
    queueMicrotask(() => conv.error(new Error('terminated')));

    const result = await session.send({
      messages: [{ role: 'user', content: 'hi' }],
      trigger: 'user_message',
      meta: { modality: 'text' },
    });

    expect(result.cards).toHaveLength(0);
    expect(result.finishReason).toBe('error');
    expect(result.recoveredFromDisconnectAfterCard).toBeUndefined();

    await session.close();
  });
});
