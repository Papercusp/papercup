/**
 * agent_chats:send_message — fire-and-forget message append with INVERTED
 * timeout logic.
 *
 * The tool POSTs to the harness messages endpoint with an AbortSignal.timeout
 * (EI-1593: raised from 2s to 15s — the route doesn't flush response headers
 * until AFTER prompt assembly, whose memory-context fetch alone is budgeted up
 * to 5s, so a 2s client abort routinely fired before headers ever arrived and
 * killed the freshly-spawned agent) and reads the *initial* response only — it
 * never consumes the SSE body. Its
 * branches are counterintuitive:
 *   • 2xx initial status      → { ok: true } (accepted; no `mode`)
 *   • ≥400 initial status     → { isError: true } with `HTTP <code>` + truncated body
 *   • TimeoutError reject     → { ok: true, mode: 'fire-and-forget' }  ← the HAPPY path:
 *                               a timeout means the SSE stream is still open streaming
 *                               the assistant reply, i.e. the message WAS accepted.
 *   • any other reject        → { isError: true } with the error message
 *
 * We mock global.fetch and pin operatorApiBase via PAPERCUSP_OPERATOR_BASE so the
 * URL is deterministic, then assert the slug/chatId are encodeURIComponent-escaped.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE = 'http://op.test:9999';

let tool: {
  handler: (
    a: { slug: string; chatId: string; content: string },
    c?: unknown,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

const fetchMock = vi.fn();

beforeAll(async () => {
  process.env.PAPERCUSP_OPERATOR_BASE = BASE;
  vi.stubGlobal('fetch', fetchMock);
  tool = (await import('../send_message')).default as never;
});

afterAll(() => {
  delete process.env.PAPERCUSP_OPERATOR_BASE;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function payload(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

/** A TimeoutError exactly as AbortSignal.timeout(...) rejects: `name === 'TimeoutError'`. */
function timeoutError(): Error {
  return Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
}

const ARGS = { slug: 'sheets', chatId: 'chat-1', content: 'hello' };

describe('agent_chats:send_message — happy path (a) 2xx', () => {
  it('returns { ok, chatId, slug } with NO mode field on a 200', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, text: async () => '' });
    const r = await tool.handler(ARGS);
    expect(r.isError).toBeFalsy();
    const p = payload(r);
    expect(p).toEqual({ ok: true, chatId: 'chat-1', slug: 'sheets' });
    expect(p).not.toHaveProperty('mode'); // 2xx is NOT the fire-and-forget branch
  });

  it('POSTs the message body as JSON to the messages endpoint', async () => {
    fetchMock.mockResolvedValueOnce({ status: 201, text: async () => '' });
    await tool.handler(ARGS);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ content: 'hello' });
    // a timeout signal is attached so a hung endpoint can't wedge the tool
    expect(init.signal).toBeDefined();
  });
});

describe('agent_chats:send_message — (b) ≥400 is a real error', () => {
  it('surfaces HTTP <code> + truncated body and sets isError', async () => {
    fetchMock.mockResolvedValueOnce({ status: 404, text: async () => 'chat not found' });
    const r = await tool.handler(ARGS);
    expect(r.isError).toBe(true);
    const p = payload(r) as { error: string; body: string };
    expect(p.error).toContain('HTTP 404');
    expect(p.body).toBe('chat not found');
  });

  it('truncates a long error body to 400 chars', async () => {
    const long = 'x'.repeat(1000);
    fetchMock.mockResolvedValueOnce({ status: 500, text: async () => long });
    const r = await tool.handler(ARGS);
    const p = payload(r) as { body: string };
    expect(p.body).toHaveLength(400);
  });

  it('tolerates a body read that throws (empty body)', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 422,
      text: async () => {
        throw new Error('stream broke');
      },
    });
    const r = await tool.handler(ARGS);
    expect(r.isError).toBe(true);
    expect((payload(r) as { error: string }).error).toContain('HTTP 422');
  });
});

describe('agent_chats:send_message — (c) TimeoutError is the HAPPY path', () => {
  it('a TimeoutError reject → { ok: true, mode: "fire-and-forget" }', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());
    const r = await tool.handler(ARGS);
    expect(r.isError).toBeFalsy();
    expect(payload(r)).toEqual({
      ok: true,
      chatId: 'chat-1',
      slug: 'sheets',
      mode: 'fire-and-forget',
    });
  });
});

describe('agent_chats:send_message — (d) other rejects are real errors', () => {
  it('a plain network Error → { isError: true } carrying the message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await tool.handler(ARGS);
    expect(r.isError).toBe(true);
    expect((payload(r) as { error: string }).error).toContain('ECONNREFUSED');
  });
});

describe('agent_chats:send_message — URL is encodeURIComponent-escaped', () => {
  it('escapes slug and chatId with special chars', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, text: async () => '' });
    await tool.handler({ slug: 'a/b c', chatId: 'id#1?x', content: 'hi' });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/harness/a%2Fb%20c/agent-chats/id%231%3Fx/messages`);
    // raw, un-escaped forms must NOT appear in the path
    expect(url).not.toContain('a/b c');
    expect(url).not.toContain('id#1?x');
  });
});

// ── Fault-injection: prove the timeout branch is non-vacuous ───────────────
// If the impl mis-classified a TimeoutError as an error (the easy inversion
// bug), this assertion would fail — so the (c) happy-path test above has teeth.
describe('agent_chats:send_message — timeout-branch teeth (meta)', () => {
  it('distinguishes a TimeoutError from a generic error by NAME, not message', async () => {
    // Same human-readable message, but name !== 'TimeoutError' → must be an error.
    const looksLikeTimeout = new Error('The operation timed out.');
    fetchMock.mockRejectedValueOnce(looksLikeTimeout);
    const r = await tool.handler(ARGS);
    expect(r.isError).toBe(true); // NOT the happy path — name gates it, not the text
    expect(payload(r)).not.toHaveProperty('mode');
  });
});
