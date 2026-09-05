/**
 * codex-oauth-proxy.test.ts — the pure auth/header/refresh half of the codex ChatGPT
 * OAuth streaming proxy (WI-2198). Streaming/plumbing lives in gateway.ts and is not
 * exercised here; this pins the reverse-engineered transport contract:
 *   auth.json parse · JWT-exp proactive refresh · /v1 → chatgpt-backend URL rewrite ·
 *   OAuth header injection · refresh_token grant (form body, persist, per-home coalesce).
 *
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/codex-oauth-proxy.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetCodexRefreshState,
  accessTokenExpired,
  aggregateCodexNonStreamResponse,
  buildCodexUpstreamHeaders,
  codexBackendUrl,
  CodexNonStreamAggregateError,
  makeCodexNonStreamUpstreamBody,
  normalizeCodexChatGptResponsesBody,
  parseCodexRateLimitHeaders,
  parseCodexRateReset,
  preflightCodexModel,
  jwtExpMs,
  readCodexAuth,
  refreshCodexToken,
  resolveCodexAccessToken,
  type CodexAuth,
  CODEX_OAUTH_TOKEN_URL,
} from './codex-oauth-proxy';

/** Build a signature-less JWT whose payload carries `exp` (seconds). */
function jwt(expSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSec })}.sig`;
}

let home: string;
beforeEach(async () => {
  __resetCodexRefreshState();
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexhome-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function writeAuth(tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens, ...extra }));
}

describe('readCodexAuth', () => {
  it('parses a valid chatgpt auth.json', async () => {
    await writeAuth({ access_token: 'at', refresh_token: 'rt', account_id: 'acc', id_token: 'id' });
    const a = await readCodexAuth(home);
    expect(a).toMatchObject({
      authMode: 'chatgpt',
      accessToken: 'at',
      refreshToken: 'rt',
      accountId: 'acc',
      idToken: 'id',
    });
  });
  it('returns null for a missing file, malformed JSON, or no access_token', async () => {
    expect(await readCodexAuth(path.join(home, 'nope'))).toBeNull();
    await fs.writeFile(path.join(home, 'auth.json'), '{not json');
    expect(await readCodexAuth(home)).toBeNull();
    await writeAuth({ refresh_token: 'rt' }); // no access_token
    expect(await readCodexAuth(home)).toBeNull();
  });
});

describe('jwtExpMs / accessTokenExpired', () => {
  it('decodes a JWT exp; treats a non-JWT as never-proactively-expiring', () => {
    expect(jwtExpMs(jwt(1_000))).toBe(1_000_000);
    expect(jwtExpMs('opaque-token')).toBeNull();
  });
  it('flags expiry within the skew window; fresh tokens are not expired', () => {
    const now = 1_000_000_000_000;
    expect(accessTokenExpired(jwt(now / 1000 + 3600), now)).toBe(false); // 1h out
    expect(accessTokenExpired(jwt(now / 1000 + 10), now)).toBe(true); // inside 60s skew
    expect(accessTokenExpired(jwt(now / 1000 - 5), now)).toBe(true); // already expired
    expect(accessTokenExpired('opaque', now)).toBe(false); // opaque → 401-backstop, not proactive
  });
});

describe('codexBackendUrl', () => {
  it('rewrites /v1/responses onto the chatgpt backend base, preserving the query', () => {
    expect(codexBackendUrl('/v1/responses')).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(codexBackendUrl('/v1/responses?stream=true')).toBe(
      'https://chatgpt.com/backend-api/codex/responses?stream=true',
    );
  });
});

describe('normalizeCodexChatGptResponsesBody', () => {
  it('splits a Papercusp effort suffix into the bare upstream model and reasoning effort', () => {
    const result = normalizeCodexChatGptResponsesBody(
      Buffer.from(
        JSON.stringify({
          model: 'gpt-5.6-sol:xhigh',
          input: [{ role: 'user', content: [] }],
          reasoning: { summary: 'auto' },
          store: false,
        }),
      ),
    );
    expect(result.inputNormalized).toBe(false);
    expect(JSON.parse(result.body.toString('utf8'))).toEqual({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: [] }],
      reasoning: { summary: 'auto', effort: 'xhigh' },
      store: false,
    });
  });

  it('removes public max_output_tokens, which the ChatGPT Codex backend rejects', () => {
    const result = normalizeCodexChatGptResponsesBody(
      Buffer.from(
        JSON.stringify({
          model: 'gpt-5.6-sol',
          input: [{ role: 'user', content: [] }],
          max_output_tokens: 8_000,
          store: false,
        }),
      ),
    );
    expect(result.inputNormalized).toBe(false);
    expect(JSON.parse(result.body.toString('utf8'))).toEqual({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: [] }],
      store: false,
    });
  });

  it('expands public input:string into the canonical one-user-message list', () => {
    const result = normalizeCodexChatGptResponsesBody(
      Buffer.from(
        JSON.stringify({
          model: 'gpt-5.6-terra',
          input: 'hello',
          stream: true,
        }),
      ),
    );
    expect(result.inputNormalized).toBe(true);
    expect(JSON.parse(result.body.toString('utf8'))).toEqual({
      model: 'gpt-5.6-terra',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
      store: false,
    });
  });

  it('forces the ChatGPT backend store:false contract even when input is already canonical', () => {
    for (const store of [undefined, true]) {
      const body = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [] }], store }));
      const result = normalizeCodexChatGptResponsesBody(body);
      expect(result.inputNormalized).toBe(false);
      expect(JSON.parse(result.body.toString('utf8'))).toEqual({
        input: [{ role: 'user', content: [] }],
        model: 'gpt-5.6-sol',
        reasoning: { effort: 'medium' },
        store: false,
      });
    }
  });

  it('adds the managed default to a model-less compatible list and leaves malformed JSON byte-identical', () => {
    const list = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [] }], store: false }));
    const normalized = normalizeCodexChatGptResponsesBody(list);
    expect(normalized.inputNormalized).toBe(false);
    expect(JSON.parse(normalized.body.toString('utf8'))).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'medium' },
      input: [{ role: 'user', content: [] }],
      store: false,
    });
    const malformed = Buffer.from('{oops');
    expect(normalizeCodexChatGptResponsesBody(malformed)).toEqual({ body: malformed, inputNormalized: false });
  });

  it('throws on a Spark model instead of swallowing the policy refusal', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-5.3-codex-spark', input: [] }));
    expect(() => normalizeCodexChatGptResponsesBody(body)).toThrow(/denied/i);
  });

  it('preserves an independently requested reasoning effort when only the model is omitted', () => {
    const body = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [] }], reasoning: { effort: 'high' }, store: false }));
    const normalized = normalizeCodexChatGptResponsesBody(body);
    expect(JSON.parse(normalized.body.toString('utf8'))).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'high' },
      store: false,
    });
  });
});

describe('makeCodexNonStreamUpstreamBody / aggregateCodexNonStreamResponse', () => {
  async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
    for (const value of values) yield Buffer.from(value, 'utf8');
  }

  it('turns a public non-stream body into the ChatGPT streaming wire shape', () => {
    const body = makeCodexNonStreamUpstreamBody(
      Buffer.from(JSON.stringify({ model: 'gpt-5.6', input: 'hello', stream: false })),
    );
    expect(body && JSON.parse(body.toString('utf8'))).toEqual({
      model: 'gpt-5.6',
      input: 'hello',
      stream: true,
      store: false,
    });
  });

  it('extracts response.completed from chunked SSE and returns ordinary Responses JSON', async () => {
    const completed = { id: 'resp_1', model: 'gpt-5.6', output: [{ type: 'message' }] };
    const wire = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\ndata: [DONE]\n\n`;
    const split = Math.floor(wire.length / 2);
    const result = await aggregateCodexNonStreamResponse(chunks(wire.slice(0, split), wire.slice(split)), {
      contentType: 'text/event-stream; charset=utf-8',
      maxBytes: 16 * 1024,
      timeoutMs: 1_000,
    });
    expect(JSON.parse(result.toString('utf8'))).toEqual(completed);
  });

  it('sniffs headerless ChatGPT SSE and preserves frames split across opening chunks (WI-284159)', async () => {
    const reasoning = { id: 'rs_headerless', type: 'reasoning', content: [] };
    const message = {
      id: 'msg_headerless',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '{"ok":true}' }],
    };
    const completed = { id: 'resp_headerless', model: 'gpt-5.5', status: 'completed', output: [] };
    const wire =
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { status: 'in_progress' } })}\n\n` +
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: reasoning })}\n\n` +
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 1, item: message })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n` +
      'data: [DONE]\n\n';
    const result = await aggregateCodexNonStreamResponse(
      chunks('ev', 'ent: response.created\n', wire.slice('event: response.created\n'.length)),
      {
        contentType: null,
        maxBytes: 16 * 1024,
        timeoutMs: 1_000,
      },
    );
    expect(JSON.parse(result.toString('utf8'))).toEqual({
      ...completed,
      output: [reasoning, message],
      output_text: '{"ok":true}',
    });
  });

  it('accepts a bounded JSON response when the backend ignores stream:true', async () => {
    const body = JSON.stringify({ id: 'resp_json', output: [] });
    const result = await aggregateCodexNonStreamResponse(chunks(body), {
      contentType: 'application/json',
      maxBytes: 1_024,
      timeoutMs: 1_000,
    });
    expect(result.toString('utf8')).toBe(body);
  });

  it('keeps a headerless JSON fallback as JSON rather than misclassifying it as SSE', async () => {
    const body = JSON.stringify({ id: 'resp_headerless_json', output: [] });
    const result = await aggregateCodexNonStreamResponse(chunks(body.slice(0, 2), body.slice(2)), {
      contentType: null,
      maxBytes: 1_024,
      timeoutMs: 1_000,
    });
    expect(result.toString('utf8')).toBe(body);
  });

  it('rejects an oversized response before retaining it', async () => {
    await expect(
      aggregateCodexNonStreamResponse(chunks('data: {"type":"response.created"}\n\n', 'x'.repeat(64)), {
        contentType: 'text/event-stream',
        maxBytes: 32,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: 'size',
      name: 'CodexNonStreamAggregateError',
    } satisfies Partial<CodexNonStreamAggregateError>);
  });

  it('times out a stalled source and invokes the transport abort hook', async () => {
    let returned = false;
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: async () => {
            returned = true;
            return { done: true, value: undefined as never };
          },
        };
      },
    };
    const onTimeout = vi.fn();
    await expect(
      aggregateCodexNonStreamResponse(stalled, {
        contentType: 'text/event-stream',
        maxBytes: 1_024,
        timeoutMs: 10,
        onTimeout,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(returned).toBe(true);
  });

  it('reports a DEADLINE as timeout even when onTimeout aborts the shared signal (P-004, codex-auto-route-all-walled-fail-fast-2026-09-05)', async () => {
    // The gateway's onTimeout aborts the request signal — the same signal this aggregation races
    // against. With the hook run BEFORE the race settled, the deadline read as a client 'aborted'
    // and the gateway destroyed the socket silently instead of answering its own 504.
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: async () => ({ done: true, value: undefined as never }),
        };
      },
    };
    const controller = new AbortController();
    await expect(
      aggregateCodexNonStreamResponse(stalled, {
        contentType: 'text/event-stream',
        maxBytes: 1_024,
        timeoutMs: 10,
        signal: controller.signal,
        onTimeout: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(controller.signal.aborted).toBe(true);
  });

  it('cancels aggregation promptly when the downstream signal aborts', async () => {
    let returned = false;
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: async () => {
            returned = true;
            return { done: true, value: undefined as never };
          },
        };
      },
    };
    const controller = new AbortController();
    const pending = aggregateCodexNonStreamResponse(stalled, {
      contentType: 'text/event-stream',
      maxBytes: 1_024,
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(returned).toBe(true);
  });
});

describe('buildCodexUpstreamHeaders', () => {
  it('injects the OAuth bearer + account id + codex signatures + identity encoding', () => {
    const h = buildCodexUpstreamHeaders({
      base: { 'content-type': 'application/json' },
      accessToken: 'AT',
      accountId: 'ACC',
    });
    expect(h.authorization).toBe('Bearer AT');
    expect(h['chatgpt-account-id']).toBe('ACC');
    expect(h.originator).toBe('codex_cli_rs');
    expect(h['openai-beta']).toBe('responses=experimental');
    expect(h['accept-encoding']).toBe('identity');
    expect(h['content-type']).toBe('application/json');
  });
  it('does NOT override an originator / OpenAI-Beta the codex CLI already sent', () => {
    const h = buildCodexUpstreamHeaders({
      base: { originator: 'codex_cli_rs_custom', 'OpenAI-Beta': 'responses=v9' },
      accessToken: 'AT',
      accountId: null,
    });
    expect(h.originator).toBe('codex_cli_rs_custom');
    expect(h['OpenAI-Beta']).toBe('responses=v9');
    expect(h['chatgpt-account-id']).toBeUndefined(); // no account id → header omitted
  });
});

describe('preflightCodexModel (EI-20362893066852316)', () => {
  const resolveAuth = async () => ({ accessToken: 'AT', accountId: 'ACC' });

  it.each(['model is not supported', 'unsupported model', 'unknown model'])(
    'refuses a definitive 4xx matching the backend model-refusal shape (%s)',
    async (phrase) => {
      const body = JSON.stringify({ detail: `The 'gpt-5.6' ${phrase} when using Codex with a ChatGPT account.` });
      const fetchImpl = vi.fn(
        async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(body, { status: 400 }),
      );
      const result = await preflightCodexModel('/tmp/codex', 'gpt-5.6', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveAuth,
      });

      expect(result).toEqual({ verdict: 'refused', status: 400, detail: body });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
        model: 'gpt-5.6',
        stream: true,
        store: false,
      });
    },
  );

  it.each([
    [400, 'invalid request'],
    [401, "The 'gpt-5.6' model is not supported"],
    [403, "The 'gpt-5.6' model is not supported"],
    [429, "The 'gpt-5.6' model is not supported"],
    [500, "The 'gpt-5.6' model is not supported"],
  ] as const)('fails open for non-definitive response %s', async (status, body) => {
    const fetchImpl = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
    const result = await preflightCodexModel('/tmp/codex', 'gpt-5.6', { fetchImpl, resolveAuth });
    expect(result).toMatchObject({ verdict: 'unknown', status });
  });

  it('fails open on transport errors and accepts a successful stream', async () => {
    const transport = vi.fn(async () => {
      throw new Error('socket closed');
    }) as unknown as typeof fetch;
    await expect(
      preflightCodexModel('/tmp/codex', 'gpt-5.6', { fetchImpl: transport, resolveAuth }),
    ).resolves.toMatchObject({ verdict: 'unknown', detail: 'preflight transport: socket closed' });

    const ok = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await expect(preflightCodexModel('/tmp/codex', 'gpt-5.6', { fetchImpl: ok, resolveAuth })).resolves.toEqual({
      verdict: 'ok',
      status: 200,
    });
  });
});

describe('refreshCodexToken', () => {
  const current: CodexAuth = {
    authMode: 'chatgpt',
    accessToken: 'old',
    refreshToken: 'rt-old',
    accountId: 'acc',
    idToken: 'id-old',
    lastRefresh: null,
  };

  it('POSTs the refresh_token grant as form-urlencoded, persists the new tokens, returns fresh auth', async () => {
    await writeAuth({ access_token: 'old', refresh_token: 'rt-old', account_id: 'acc', id_token: 'id-old' });
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(CODEX_OAUTH_TOKEN_URL);
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(init.body as string);
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('rt-old');
      expect(params.get('client_id')).toBe('test-client');
      return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt-new', id_token: 'id-new' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const next = await refreshCodexToken(home, current, { fetchImpl, clientId: 'test-client' });
    expect(next.accessToken).toBe('new');
    expect(next.refreshToken).toBe('rt-new');
    // persisted back to disk
    const onDisk = await readCodexAuth(home);
    expect(onDisk?.accessToken).toBe('new');
    expect(onDisk?.refreshToken).toBe('rt-new');
    expect(onDisk?.accountId).toBe('acc'); // preserved
  });

  it('coalesces concurrent refreshes for the same home into ONE token call', async () => {
    await writeAuth({ access_token: 'old', refresh_token: 'rt-old', account_id: 'acc' });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ access_token: 'new' }), { status: 200 });
    }) as unknown as typeof fetch;
    const [a, b, c] = await Promise.all([
      refreshCodexToken(home, current, { fetchImpl, clientId: 'x' }),
      refreshCodexToken(home, current, { fetchImpl, clientId: 'x' }),
      refreshCodexToken(home, current, { fetchImpl, clientId: 'x' }),
    ]);
    expect(calls).toBe(1);
    expect([a.accessToken, b.accessToken, c.accessToken]).toEqual(['new', 'new', 'new']);
  });

  it('picks up a token a peer already refreshed on disk WITHOUT a network call', async () => {
    // on-disk token is fresh + different from `current` → no refresh needed
    await writeAuth({ access_token: jwt(Date.now() / 1000 + 3600), refresh_token: 'rt-disk', account_id: 'acc' });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const next = await refreshCodexToken(home, current, { fetchImpl, clientId: 'x' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(next.refreshToken).toBe('rt-disk');
  });

  it('throws a clear error when the grant fails', async () => {
    await writeAuth({ access_token: 'old', refresh_token: 'rt-old' });
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
    await expect(refreshCodexToken(home, current, { fetchImpl, clientId: 'x' })).rejects.toThrow(
      /token refresh failed 400/,
    );
  });
});

describe('resolveCodexAccessToken', () => {
  it('returns the current token when fresh (no refresh)', async () => {
    const fresh = jwt(Date.now() / 1000 + 3600);
    await writeAuth({ access_token: fresh, refresh_token: 'rt', account_id: 'acc' });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const a = await resolveCodexAccessToken(home, { fetchImpl });
    expect(a.accessToken).toBe(fresh);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refreshes when the access token is expired', async () => {
    await writeAuth({ access_token: jwt(Date.now() / 1000 - 10), refresh_token: 'rt', account_id: 'acc' });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'refreshed' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const a = await resolveCodexAccessToken(home, { fetchImpl, clientId: 'x' });
    expect(a.accessToken).toBe('refreshed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('throws when there is no usable auth.json', async () => {
    await expect(resolveCodexAccessToken(path.join(home, 'absent'))).rejects.toThrow(/no usable auth.json/);
  });
});

describe('parseCodexRateReset — the codex-dialect 429 reset parser (WI-2038027)', () => {
  const NOW = 1_756_700_000_000;

  it('parks to the weekly wall: an exhausted 10080-min window with reset-after-seconds', () => {
    const r = parseCodexRateReset(
      {
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-after-seconds': '86400',
      },
      NOW,
    );
    expect(r.resetAt).toBe(NOW + 86_400_000);
    expect(r.transient).toBe(false);
  });

  it('parks to an exhausted 5h window given as an epoch reset-at', () => {
    const resetSec = Math.floor(NOW / 1000) + 1800;
    const r = parseCodexRateReset(
      {
        'x-codex-primary-used-percent': '99',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(resetSec),
      },
      NOW,
    );
    expect(r.resetAt).toBe(resetSec * 1000);
    expect(r.transient).toBe(false);
  });

  it('both meters walled → the LATER reset wins (the account cannot serve until both clear)', () => {
    const r = parseCodexRateReset(
      {
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '1800',
        'x-codex-secondary-used-percent': '100',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-after-seconds': '86400',
      },
      NOW,
    );
    expect(r.resetAt).toBe(NOW + 86_400_000);
    expect(r.transient).toBe(false);
  });

  it('healthy windows are pacing, not walls: no reset, transient', () => {
    const r = parseCodexRateReset(
      {
        'x-codex-primary-used-percent': '40',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '1800',
      },
      NOW,
    );
    expect(r.resetAt).toBeNull();
    expect(r.retryAfterMs).toBeNull();
    expect(r.transient).toBe(true);
  });

  it('a bare numeric retry-after fills in when no window is exhausted', () => {
    const r = parseCodexRateReset({ 'retry-after': '7' }, NOW);
    expect(r.retryAfterMs).toBe(7000);
    expect(r.resetAt).toBe(NOW + 7000);
    expect(r.transient).toBe(true);
  });

  it('api.openai.com request exhaustion parses a sub-second x-ratelimit duration as a wall', () => {
    const r = parseCodexRateReset(
      {
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '250ms',
        'x-ratelimit-remaining-tokens': '42',
        'x-ratelimit-reset-tokens': '6m0s',
      },
      NOW,
    );
    expect(r.resetAt).toBe(NOW + 250);
    expect(r.transient).toBe(false);
  });

  it('api.openai.com waits for BOTH exhausted meters — the later compound duration wins', () => {
    const r = parseCodexRateReset(
      {
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '1s',
        'x-ratelimit-remaining-tokens': '0',
        'x-ratelimit-reset-tokens': '6m0s',
      },
      NOW,
    );
    expect(r.resetAt).toBe(NOW + 360_000);
    expect(r.transient).toBe(false);
  });

  it('api.openai.com reset evidence without a zero meter stays transient and waitable', () => {
    const r = parseCodexRateReset(
      {
        'x-ratelimit-remaining-requests': '7',
        'x-ratelimit-reset-requests': '1s',
      },
      NOW,
    );
    expect(r.resetAt).toBe(NOW + 1_000);
    expect(r.transient).toBe(true);
  });

  it('retry-after accepts the same duration dialect without misreading milliseconds as minutes', () => {
    const r = parseCodexRateReset({ 'retry-after': '250ms' }, NOW);
    expect(r.retryAfterMs).toBe(250);
    expect(r.resetAt).toBe(NOW + 250);
    expect(r.transient).toBe(true);
  });

  it('retry-after floors a window-derived reset upward, never shortens it', () => {
    const r = parseCodexRateReset(
      {
        'retry-after': '3600',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '60',
      },
      NOW,
    );
    expect(r.resetAt).toBe(NOW + 3_600_000);
    expect(r.transient).toBe(false);
  });

  it('a reset at/before now is DROPPED — onExhausted treats a past resetAt as "park five hours"', () => {
    const r = parseCodexRateReset(
      {
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(Math.floor(NOW / 1000) - 60),
      },
      NOW,
    );
    expect(r.resetAt).toBeNull();
    expect(r.transient).toBe(false);
  });

  it('the reserve family (x-base-model-inference-*) parses when it is the active bucket', () => {
    const r = parseCodexRateReset(
      {
        'x-codex-active-limit': 'base_model_inference',
        'x-base-model-inference-primary-used-percent': '100',
        'x-base-model-inference-primary-window-minutes': '10080',
        'x-base-model-inference-primary-reset-after-seconds': '43200',
      },
      NOW,
    );
    expect(r.resetAt).toBe(NOW + 43_200_000);
    expect(r.transient).toBe(false);
  });

  it('parseCodexRateLimitHeaders stamps the METER: premium for x-codex-*, base_model_inference for the reserve family, nothing for {} (EI-22103680502746318)', () => {
    expect(
      parseCodexRateLimitHeaders({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '10080' }, NOW),
    ).toEqual({ utilization7d: 1, bucket: 'premium' });
    expect(
      parseCodexRateLimitHeaders(
        {
          'x-codex-active-limit': 'base_model_inference',
          'x-base-model-inference-primary-used-percent': '4',
          'x-base-model-inference-primary-window-minutes': '10080',
        },
        NOW,
      ),
    ).toEqual({ utilization7d: 0.04, bucket: 'base_model_inference' });
    // Reserve-only headers with NO active-limit marker are still the reserve meter — never premium.
    expect(
      parseCodexRateLimitHeaders(
        { 'x-base-model-inference-primary-used-percent': '4', 'x-base-model-inference-primary-window-minutes': '10080' },
        NOW,
      ).bucket,
    ).toBe('base_model_inference');
    // Both families present + premium marked active ⇒ the premium family wins and is stamped premium.
    expect(
      parseCodexRateLimitHeaders(
        {
          'x-codex-active-limit': 'premium',
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-window-minutes': '10080',
          'x-base-model-inference-primary-used-percent': '4',
          'x-base-model-inference-primary-window-minutes': '10080',
        },
        NOW,
      ),
    ).toEqual({ utilization7d: 1, bucket: 'premium' });
    expect(parseCodexRateLimitHeaders({}, NOW)).toEqual({});
  });

  it('no rate headers at all → null reset, transient (caller falls back to its short backoff)', () => {
    const r = parseCodexRateReset({}, NOW);
    expect(r.resetAt).toBeNull();
    expect(r.retryAfterMs).toBeNull();
    expect(r.transient).toBe(true);
  });
});
