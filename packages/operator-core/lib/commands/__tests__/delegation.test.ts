/**
 * commands/defs/delegation.ts — the voice agent's deep-work surface:
 * delegates.list/get/search (session picking) + delegate_to_claude /
 * delegate_to_agent (the SSE-streamed delegation command).
 *
 * Covers the module's own logic end-to-end through the REAL registry
 * (runQuery/runCommand) and the real handlers:
 *   - registration surface (ids, kinds, tiers, agents, browser/concurrency,
 *     the backend-neutral delegate_to_agent alias)
 *   - query arg validation + server-side routing into delegated-tasks
 *     (that PG module is the stubbed seam)
 *   - delegate_to_claude's URL construction (session routing: resume vs
 *     newSession), HTTP failure, SSE event application (session/delta/done/
 *     heartbeat/garbage), the sync-window race, and the async 'started' ack
 *
 * Transport seams stubbed per the module's shape: global fetch (the
 * /api/agent-mcp/delegate-chat loopback) and ../delegated-tasks. SSE parsing
 * itself runs through the real @papercusp/sse parseSseStream.
 *
 * (native-session-id-roundtrip.test.ts does NOT cover this module — it pins
 * the bootstrap-su/psu-launcher session-id chain, a different surface.)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listDelegatedSessions: vi.fn(async (_opts: { status?: string; limit?: number }) => [] as unknown[]),
  getDelegatedSession: vi.fn(async (_ref: string) => null as unknown),
  searchDelegatedSessions: vi.fn(async (_q: string, _limit?: number) => [] as unknown[]),
}));

// The PG-backed session store is the seam; everything above it is real.
vi.mock('../../delegated-tasks', () => ({
  listDelegatedSessions: h.listDelegatedSessions,
  getDelegatedSession: h.getDelegatedSession,
  searchDelegatedSessions: h.searchDelegatedSessions,
}));

import '../defs/delegation';
import { get, runCommand, runQuery } from '../registry';
import type { CommandContext, CommandDef } from '../types';

const PORT = '3911';
const BASE = `http://127.0.0.1:${PORT}/api/agent-mcp/delegate-chat`;
let savedPort: string | undefined;
let savedNextPort: string | undefined;

beforeAll(() => {
  savedPort = process.env.PORT;
  savedNextPort = process.env.NEXT_PUBLIC_PORT;
  process.env.PORT = PORT;
  delete process.env.NEXT_PUBLIC_PORT;
});
afterAll(() => {
  if (savedPort === undefined) delete process.env.PORT;
  else process.env.PORT = savedPort;
  if (savedNextPort === undefined) delete process.env.NEXT_PUBLIC_PORT;
  else process.env.NEXT_PUBLIC_PORT = savedNextPort;
});

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  agent: 'operator',
  workspace: 'default',
  requestId: 'r-1',
  ...overrides,
});

/* ─── SSE stream builders ────────────────────────────────────────────── */

const enc = new TextEncoder();
const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

function closedStream(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

/** A stream that emits its frames and then stays open until close() is called. */
function hangingStream(frames: string[]): { body: ReadableStream<Uint8Array>; close: () => void } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      for (const f of frames) c.enqueue(enc.encode(f));
    },
  });
  return { body, close: () => ctl.close() };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ─── Registration surface ───────────────────────────────────────────── */

describe('registration surface', () => {
  it('registers the three session queries on the fast-query tier for oracle + operator', () => {
    for (const id of ['delegates.list', 'delegates.get', 'delegates.search']) {
      const def = get(id);
      expect(def, `${id} registered`).toBeTruthy();
      expect(def!.kind).toBe('query');
      expect(def!.tier).toBe('fast-query');
      expect(def!.agents).toEqual(['oracle', 'operator']);
    }
  });

  it('registers delegate_to_claude as an operator-only, browser-required, queued delegation command', () => {
    const def = get('delegate_to_claude') as CommandDef | undefined;
    expect(def).toBeTruthy();
    expect(def!.kind).toBe('command');
    expect(def!.tier).toBe('delegation');
    expect(def!.agents).toEqual(['operator']);
    expect(def!.browser).toBe('required');
    expect(def!.concurrent).toBe('queue');
  });

  it('delegate_to_agent is the backend-neutral alias: same handler/schema, de-Clauded description', () => {
    const claude = get('delegate_to_claude') as CommandDef;
    const agent = get('delegate_to_agent') as CommandDef;
    expect(agent).toBeTruthy();
    expect(agent.handler).toBe(claude.handler);
    expect(agent.schema).toBe(claude.schema);
    expect(agent.browser).toBe('required');
    expect(agent.concurrent).toBe('queue');
    expect(agent.description).not.toMatch(/Claude/);
    expect(agent.description).toContain('the configured agent');
  });
});

/* ─── delegates.list / get / search (server-side routing) ────────────── */

describe('delegates.* queries', () => {
  it('delegates.list applies the schema defaults (open/20) and wraps rows as { sessions }', async () => {
    const rows = [{ id: 1, title: 'A' }];
    h.listDelegatedSessions.mockResolvedValueOnce(rows);
    const r = await runQuery('delegates.list', {}, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ sessions: rows });
    expect(h.listDelegatedSessions).toHaveBeenCalledWith({ status: 'open', limit: 20 });
  });

  it('delegates.list passes explicit status/limit filters through to the session store', async () => {
    await runQuery('delegates.list', { status: 'archived', limit: 5 }, ctx());
    expect(h.listDelegatedSessions).toHaveBeenCalledWith({ status: 'archived', limit: 5 });
  });

  it('delegates.list rejects out-of-range / unknown filter args before the handler runs', async () => {
    for (const args of [{ limit: 0 }, { limit: 51 }, { status: 'running' }]) {
      const r = await runQuery('delegates.list', args, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-args');
    }
    expect(h.listDelegatedSessions).not.toHaveBeenCalled();
  });

  it('delegates.list is denied to agents outside its allowlist', async () => {
    const r = await runQuery('delegates.list', {}, ctx({ agent: 'pi' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('denied');
    expect(h.listDelegatedSessions).not.toHaveBeenCalled();
  });

  it('delegates.get requires an id and wraps the row as { session }', async () => {
    const missing = await runQuery('delegates.get', {}, ctx());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('invalid-args');

    const row = { id: 7, title: 'Auth refactor' };
    h.getDelegatedSession.mockResolvedValueOnce(row);
    const r = await runQuery('delegates.get', { id: 'abc-123' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ session: row });
    expect(h.getDelegatedSession).toHaveBeenCalledWith('abc-123');
  });

  it('delegates.get surfaces an unknown ref as { session: null } (no throw)', async () => {
    h.getDelegatedSession.mockResolvedValueOnce(null);
    const r = await runQuery('delegates.get', { id: 'nope' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ session: null });
  });

  it('delegates.search routes (query, limit) positionally, defaulting limit to 10', async () => {
    const rows = [{ id: 2, title: 'B' }];
    h.searchDelegatedSessions.mockResolvedValue(rows);
    const r = await runQuery('delegates.search', { query: 'needle', limit: 3 }, ctx({ agent: 'oracle' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ sessions: rows });
    expect(h.searchDelegatedSessions).toHaveBeenCalledWith('needle', 3);

    await runQuery('delegates.search', { query: 'needle' }, ctx());
    expect(h.searchDelegatedSessions).toHaveBeenLastCalledWith('needle', 10);
  });
});

/* ─── delegate_to_claude ─────────────────────────────────────────────── */

type DelegateArgs = {
  task: string;
  context?: string;
  sessionId?: string;
  newSession?: boolean;
};
type DelegateResult =
  | { status: 'complete'; fullText: string; agentSessionId: string | null; costUsd: number }
  | { status: 'started'; agentSessionId: string | null; message: string };

const delegateHandler = () =>
  (get('delegate_to_claude') as CommandDef).handler as (
    args: DelegateArgs,
    c: CommandContext,
  ) => Promise<DelegateResult>;

const requestedUrl = (call = 0): URL => new URL(String(fetchMock.mock.calls[call][0]));

describe('delegate_to_claude — routing + stream handling', () => {
  beforeEach(() => {
    // Fake timers: keeps the 10s sync-window race deterministic and stops the
    // per-iteration race timers from outliving the test as real handles.
    vi.useFakeTimers();
  });

  it('routes a resumed session: request/context/sessionId params on the loopback delegate-chat endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(closedStream([frame('done', { fullText: 'ok' })]), { status: 200 }),
    );
    await delegateHandler()(
      { task: 'sum the costs', context: 'feature: auth', sessionId: 'sess-42', newSession: false },
      ctx(),
    );
    const u = requestedUrl();
    expect(`${u.origin}${u.pathname}`).toBe(BASE);
    expect(u.searchParams.get('request')).toBe('sum the costs');
    expect(u.searchParams.get('context')).toBe('feature: auth');
    expect(u.searchParams.get('sessionId')).toBe('sess-42');
    expect(u.searchParams.get('newSession')).toBeNull();
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { accept: 'text/event-stream' } });
  });

  it('newSession:true forces a fresh conversation — sessionId is DROPPED, newSession=1 sent', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(closedStream([frame('done', { fullText: 'ok' })]), { status: 200 }),
    );
    await delegateHandler()({ task: 't', sessionId: 'sess-42', newSession: true }, ctx());
    const u = requestedUrl();
    expect(u.searchParams.get('sessionId')).toBeNull();
    expect(u.searchParams.get('newSession')).toBe('1');
  });

  it('throws on a non-OK delegate-chat response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(delegateHandler()({ task: 't' }, ctx())).rejects.toThrow(
      'delegate_to_claude: HTTP 503',
    );
  });

  it('sync win: session/delta/done inside the window → status complete with the done payload', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        closedStream([
          frame('session', { agentSessionId: 'as-1' }),
          frame('delta', { text: 'Hello ' }),
          frame('heartbeat', {}), // ignored
          frame('delta', 'this is not json'), // unparseable data is skipped, not fatal
          frame('delta', { text: 'world' }),
          frame('done', { fullText: 'Hello world!', costUsd: 0.42 }),
        ]),
        { status: 200 },
      ),
    );
    const r = await delegateHandler()({ task: 't' }, ctx());
    expect(r).toEqual({
      status: 'complete',
      fullText: 'Hello world!', // the done event's fullText wins over the accumulation
      agentSessionId: 'as-1',
      costUsd: 0.42,
    });
  });

  it('a done event WITHOUT fullText falls back to the accumulated deltas (cost defaults to 0)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        closedStream([
          frame('delta', { text: 'a' }),
          frame('delta', { text: 'b' }),
          frame('done', {}),
        ]),
        { status: 200 },
      ),
    );
    const r = await delegateHandler()({ task: 't' }, ctx());
    expect(r).toEqual({ status: 'complete', fullText: 'ab', agentSessionId: null, costUsd: 0 });
  });

  it('an error event inside the sync window rejects with the Claude error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        closedStream([
          frame('session', { agentSessionId: 'as-2' }),
          frame('error', { message: 'boom' }),
        ]),
        { status: 200 },
      ),
    );
    await expect(delegateHandler()({ task: 't' }, ctx())).rejects.toThrow('Claude error: boom');
  });

  it('a stream that closes WITHOUT done resolves to the async "started" ack (error surfaces via browser events only)', async () => {
    // Node-side contract pin: the sync loop records 'stream closed
    // unexpectedly' but does not throw — completion/error notification is the
    // browser listener's job (this command is browser:'required' in prod).
    fetchMock.mockResolvedValueOnce(
      new Response(
        closedStream([frame('session', { agentSessionId: 'as-3' }), frame('delta', { text: 'x' })]),
        { status: 200 },
      ),
    );
    const r = await delegateHandler()({ task: 't' }, ctx());
    expect(r.status).toBe('started');
    if (r.status === 'started') {
      expect(r.agentSessionId).toBe('as-3');
      expect(r.message).toMatch(/result will arrive/);
    }
  });

  it('a slow delegate blows the 10s sync window → early "started" ack while the stream keeps draining', async () => {
    const { body, close } = hangingStream([frame('session', { agentSessionId: 'as-9' })]);
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const pending = delegateHandler()({ task: 'long task' }, ctx());
    await vi.advanceTimersByTimeAsync(10_001); // past SYNC_DEADLINE_MS
    const r = await pending;
    expect(r.status).toBe('started');
    if (r.status === 'started') expect(r.agentSessionId).toBe('as-9');

    // Let the background drain observe end-of-stream and finish quietly.
    close();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('delegate_to_claude — registry-level gating', () => {
  it('without a browser session the registry returns no-active-session and never fetches', async () => {
    const r = await runCommand('delegate_to_claude', { task: 't' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no-active-session');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-operator agents are denied', async () => {
    const r = await runCommand('delegate_to_claude', { task: 't' }, ctx({ agent: 'oracle', sessionId: 'tab-1' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('denied');
  });

  it('an empty task fails validation before any fetch', async () => {
    const r = await runCommand('delegate_to_claude', { task: '' }, ctx({ sessionId: 'tab-1' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-args');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a browser-backed call runs the real handler end-to-end through runCommand', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      new Response(closedStream([frame('done', { fullText: 'all done', costUsd: 0.01 })]), {
        status: 200,
      }),
    );
    const r = await runCommand<DelegateResult>(
      'delegate_to_claude',
      { task: 't' },
      ctx({ sessionId: 'tab-1' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('complete');
      if (r.value.status === 'complete') expect(r.value.fullText).toBe('all done');
    }
  });
});
