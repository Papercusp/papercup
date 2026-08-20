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
  buildCodexUpstreamHeaders,
  codexBackendUrl,
  normalizeCodexChatGptResponsesBody,
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
    expect(a).toMatchObject({ authMode: 'chatgpt', accessToken: 'at', refreshToken: 'rt', accountId: 'acc', idToken: 'id' });
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
    expect(codexBackendUrl('/v1/responses?stream=true')).toBe('https://chatgpt.com/backend-api/codex/responses?stream=true');
  });
});

describe('normalizeCodexChatGptResponsesBody', () => {
  it('expands public input:string into the canonical one-user-message list', () => {
    const result = normalizeCodexChatGptResponsesBody(Buffer.from(JSON.stringify({
      model: 'gpt-5.6-terra',
      input: 'hello',
      stream: true,
    })));
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
        store: false,
      });
    }
  });

  it('keeps compatible list input and malformed JSON byte-identical', () => {
    const list = Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [] }], store: false }));
    expect(normalizeCodexChatGptResponsesBody(list)).toEqual({ body: list, inputNormalized: false });
    const malformed = Buffer.from('{oops');
    expect(normalizeCodexChatGptResponsesBody(malformed)).toEqual({ body: malformed, inputNormalized: false });
  });
});

describe('buildCodexUpstreamHeaders', () => {
  it('injects the OAuth bearer + account id + codex signatures + identity encoding', () => {
    const h = buildCodexUpstreamHeaders({ base: { 'content-type': 'application/json' }, accessToken: 'AT', accountId: 'ACC' });
    expect(h.authorization).toBe('Bearer AT');
    expect(h['chatgpt-account-id']).toBe('ACC');
    expect(h.originator).toBe('codex_cli_rs');
    expect(h['openai-beta']).toBe('responses=experimental');
    expect(h['accept-encoding']).toBe('identity');
    expect(h['content-type']).toBe('application/json');
  });
  it('does NOT override an originator / OpenAI-Beta the codex CLI already sent', () => {
    const h = buildCodexUpstreamHeaders({ base: { originator: 'codex_cli_rs_custom', 'OpenAI-Beta': 'responses=v9' }, accessToken: 'AT', accountId: null });
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
        async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
          new Response(body, { status: 400 }),
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
    const transport = vi.fn(async () => { throw new Error('socket closed'); }) as unknown as typeof fetch;
    await expect(preflightCodexModel('/tmp/codex', 'gpt-5.6', { fetchImpl: transport, resolveAuth }))
      .resolves.toMatchObject({ verdict: 'unknown', detail: 'preflight transport: socket closed' });

    const ok = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await expect(preflightCodexModel('/tmp/codex', 'gpt-5.6', { fetchImpl: ok, resolveAuth }))
      .resolves.toEqual({ verdict: 'ok', status: 200 });
  });
});

describe('refreshCodexToken', () => {
  const current: CodexAuth = { authMode: 'chatgpt', accessToken: 'old', refreshToken: 'rt-old', accountId: 'acc', idToken: 'id-old', lastRefresh: null };

  it('POSTs the refresh_token grant as form-urlencoded, persists the new tokens, returns fresh auth', async () => {
    await writeAuth({ access_token: 'old', refresh_token: 'rt-old', account_id: 'acc', id_token: 'id-old' });
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(CODEX_OAUTH_TOKEN_URL);
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(init.body as string);
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('rt-old');
      expect(params.get('client_id')).toBe('test-client');
      return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt-new', id_token: 'id-new' }), { status: 200 });
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
    const fetchImpl = vi.fn(async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return new Response(JSON.stringify({ access_token: 'new' }), { status: 200 }); }) as unknown as typeof fetch;
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
    await expect(refreshCodexToken(home, current, { fetchImpl, clientId: 'x' })).rejects.toThrow(/token refresh failed 400/);
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
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'refreshed' }), { status: 200 })) as unknown as typeof fetch;
    const a = await resolveCodexAccessToken(home, { fetchImpl, clientId: 'x' });
    expect(a.accessToken).toBe('refreshed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('throws when there is no usable auth.json', async () => {
    await expect(resolveCodexAccessToken(path.join(home, 'absent'))).rejects.toThrow(/no usable auth.json/);
  });
});
