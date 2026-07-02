/**
 * operator-elevenlabs-ws-init.test.ts — voice-realtime-tui-2026-06-05 P-001/P-002.
 *
 * In-process Hono round-trips for the raw-WS EL session-init route + the TUI
 * voice-lease verbs. EL's API, voice prefs, credentials, cooldown marks, and
 * the lease lib are all stubbed — this asserts the ROUTE contract:
 * gating order, lease-before-mint, the signed-url mint shape, the shell-mode
 * payload (language-pin-only overrides, D-009), and heartbeat/release.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── stubs ────────────────────────────────────────────────────────────────
const prefsState: { fullAgentEngine: string; elevenLabsAgentId: string; agentLanguage: string } = {
  fullAgentEngine: 'elevenlabs-conv',
  elevenLabsAgentId: 'agent_test_123',
  agentLanguage: 'en',
};
vi.mock('../../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => ({ ...prefsState })),
}));

let apiKey: string | null = 'xi-test-key';
vi.mock('../../voice-credentials', () => ({
  readElevenLabsKey: vi.fn(async () => apiKey),
}));

const cooldowns = new Map<string, number>();
vi.mock('../../cooldown-marks', () => ({
  readCooldownMark: vi.fn(async (k: string) => cooldowns.get(k) ?? null),
  writeCooldownMark: vi.fn(async (k: string) => { cooldowns.set(k, Date.now()); }),
}));

const claimMock = vi.fn(async (opts: { ownerId: string; ownerKind: string }) => ({
  granted: true,
  lease: { workspaceId: 'ws-test', ownerId: opts.ownerId, ownerKind: opts.ownerKind, expiresAtMs: Date.now() + 12_000 },
}));
const releaseMock = vi.fn(async (_opts: unknown) => {});
vi.mock('../../voice-lease', () => ({
  claimVoiceLease: (...args: unknown[]) => claimMock(...(args as [never])),
  releaseVoiceLease: (...args: unknown[]) => releaseMock(...(args as [never])),
}));

vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'ws-test' };
});

vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

import { Hono } from 'hono';
import { registerAllRoutes } from '../register';

let app: Hono;
const INIT = '/api/agent-mcp/operator-elevenlabs-ws-init';
const HEARTBEAT = '/api/agent-mcp/operator-voice-lease/heartbeat';
const LEASE = '/api/agent-mcp/operator-voice-lease';

function stubElFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  cooldowns.clear();
  claimMock.mockClear();
  releaseMock.mockClear();
  prefsState.fullAgentEngine = 'elevenlabs-conv';
  prefsState.elevenLabsAgentId = 'agent_test_123';
  prefsState.agentLanguage = 'en';
  apiKey = 'xi-test-key';
  app = new Hono().basePath('/api');
  registerAllRoutes(app);
});

describe('GET operator-elevenlabs-ws-init', () => {
  it('400 without owner (the lease identity is required)', async () => {
    const res = await app.request(INIT);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('owner-required');
  });

  it('404 when the full-agent engine is not elevenlabs-conv', async () => {
    prefsState.fullAgentEngine = 'off';
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not-enabled');
  });

  it('404 without an agent id / api key', async () => {
    prefsState.elevenLabsAgentId = '';
    expect((await app.request(`${INIT}?owner=pui-1`)).status).toBe(404);
    prefsState.elevenLabsAgentId = 'agent_test_123';
    apiKey = null;
    expect((await app.request(`${INIT}?owner=pui-1`)).status).toBe(404);
  });

  it('409 + holder when another surface holds the lease — and does NOT mint', async () => {
    const fetchMock = stubElFetch({ signed_url: 'wss://example/signed' });
    claimMock.mockResolvedValueOnce({
      granted: false,
      lease: { workspaceId: 'ws-test', ownerId: 'tab-9', ownerKind: 'desktop', expiresAtMs: Date.now() + 9000 },
    });
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('lease-held');
    expect(body.holder.ownerKind).toBe('desktop');
    expect(fetchMock).not.toHaveBeenCalled(); // lease-before-mint: no EL slot burned
  });

  it('200 happy path: claims kind=tui, mints the signed url, returns the shell-mode payload', async () => {
    const fetchMock = stubElFetch({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=abc' });
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signedUrl).toContain('wss://');
    expect(body.agentId).toBe('agent_test_123');
    // Shell mode (D-009): language pin is the ONLY override.
    expect(body.overrides).toEqual({ agent: { language: 'en' } });
    expect(body.dynamicVariables).toEqual({ workspace_id: 'ws-test', surface: 'tui' });
    // Lease claimed as 'tui' before the mint.
    expect(claimMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'pui-1', ownerKind: 'tui', force: false }),
    );
    // The mint hit the signed-url endpoint with the server-side key.
    const [mintUrl, mintInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(mintUrl).toContain('/v1/convai/conversation/get-signed-url?agent_id=agent_test_123');
    expect((mintInit.headers as Record<string, string>)['xi-api-key']).toBe('xi-test-key');
  });

  it('omits overrides when no language pin is set', async () => {
    prefsState.agentLanguage = '';
    stubElFetch({ signed_url: 'wss://example/signed' });
    const body = await (await app.request(`${INIT}?owner=pui-1`)).json();
    expect(body.overrides).toBeNull();
  });

  it('429 mint-cooldown within 8s of the last mint', async () => {
    stubElFetch({ signed_url: 'wss://example/signed' });
    expect((await app.request(`${INIT}?owner=pui-1`)).status).toBe(200);
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('mint-cooldown');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('503 concurrent-limit passthrough from EL', async () => {
    stubElFetch('workspace_concurrency_limit exceeded', 429);
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('concurrent-limit');
  });

  it('502 on a token-shaped (non-signed-url) response', async () => {
    stubElFetch({ token: 'not-a-signed-url' });
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('mint-shape');
  });

  it('force=1 forwards pre-emption to the lease claim', async () => {
    stubElFetch({ signed_url: 'wss://example/signed' });
    await app.request(`${INIT}?owner=pui-1&force=1`);
    expect(claimMock).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  // WI-1461: a transient network error (timeout/reset — the class a stuck
  // pooled keep-alive socket to a rarely-hit origin produces) on the FIRST
  // mint attempt retries once on a fresh dispatcher instead of failing outright.
  it('retries once on a transient network error, then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        // Simulate what AbortSignal.timeout(8000) throws on a stuck socket.
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      // The retry must be on an isolated dispatcher, not the (implicitly
      // poisoned) default one.
      expect((init as { dispatcher?: unknown } | undefined)?.dispatcher).toBeDefined();
      return new Response(JSON.stringify({ signed_url: 'wss://example/signed-after-retry' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(200);
    expect((await res.json()).signedUrl).toBe('wss://example/signed-after-retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A genuine rejection (bad key, malformed request) is an HTTP response, not
  // a thrown network error — it must NOT be retried (retrying a real 401
  // burns a second EL request for no benefit).
  it('does not retry a non-network mint-rejected response', async () => {
    const fetchMock = stubElFetch('unauthorized', 401);
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(401); // passthrough: <500 EL status is forwarded verbatim
    expect((await res.json()).error).toBe('mint-rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A non-transient thrown error (e.g. a genuine DNS/programming failure, not
  // matching the transient-network-error class) also must not retry.
  it('does not retry a non-transient thrown error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Invalid URL');
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request(`${INIT}?owner=pui-1`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('mint-failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('TUI voice-lease verbs', () => {
  it('heartbeat refreshes the lease; surfaces a lost lease as ok:false + holder', async () => {
    const ok = await app.request(HEARTBEAT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'pui-1' }),
    });
    expect((await ok.json()).ok).toBe(true);

    claimMock.mockResolvedValueOnce({
      granted: false,
      lease: { workspaceId: 'ws-test', ownerId: 'phone-1', ownerKind: 'mobile', expiresAtMs: Date.now() + 9000 },
    });
    const lost = await app.request(HEARTBEAT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'pui-1' }),
    });
    const lostBody = await lost.json();
    expect(lostBody.ok).toBe(false);
    expect(lostBody.holder.ownerKind).toBe('mobile');
  });

  it('heartbeat 400 without owner; release deletes by owner', async () => {
    const bad = await app.request(HEARTBEAT, { method: 'POST', body: '{}' });
    expect(bad.status).toBe(400);

    const res = await app.request(`${LEASE}?owner=pui-1`, { method: 'DELETE' });
    expect((await res.json()).ok).toBe(true);
    expect(releaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-test', ownerId: 'pui-1' }),
    );
  });
});
