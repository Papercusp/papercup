/**
 * Behavioral tests for the device voice route family (routes/device/voice.ts):
 * the voice-lease wrappers and — the meat — `voice-session-init`, which mints
 * an ElevenLabs Conv AI token under a cooldown gate, in-flight dedup, and
 * EL-error mapping. These directly govern voice cost + the "concurrency limit
 * reached" UX, and were previously untested (device-routes.test.ts only checks
 * that these routes declare auth/cors).
 *
 * Pattern mirrors device-routes.test.ts: drive the DB-free handlers directly
 * with a hand-built RouteContext; mock voice-lease + the dynamically-imported
 * prefs/creds/cooldown/surface modules + global fetch.
 *
 * P-002 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import type { RouteContext, RouteDefinition } from '../define-route';

vi.mock('../../voice-lease', () => ({
  claimVoiceLease: vi.fn(async () => ({ granted: true })),
  releaseVoiceLease: vi.fn(async () => {}),
  readVoiceLease: vi.fn(async () => null),
}));
vi.mock('../../voice-prefs', () => ({ loadVoicePrefs: vi.fn() }));
vi.mock('../../voice-credentials', () => ({ readElevenLabsKey: vi.fn() }));
vi.mock('../../cooldown-marks', () => ({
  readCooldownMark: vi.fn(),
  writeCooldownMark: vi.fn(async () => {}),
}));
vi.mock('../../device-surface', () => ({
  detectSurface: vi.fn(() => 'web'),
  surfaceToElSource: vi.fn(() => 'web'),
}));
vi.mock('../../device-voice-init-prefs', () => ({
  resolveVoiceInit: vi.fn(() => ({ idleTimeoutMin: 10, sessionMaxMin: 30, voiceMode: 'always-on' })),
}));

import { claimVoiceLease, releaseVoiceLease, readVoiceLease } from '../../voice-lease';
import { loadVoicePrefs } from '../../voice-prefs';
import { readElevenLabsKey } from '../../voice-credentials';
import { readCooldownMark, writeCooldownMark } from '../../cooldown-marks';
import voiceRoutes from '../routes/device/voice';

const MOBILE_PRINCIPAL: Principal = {
  kind: 'device',
  slug: 'device-e4',
  workspaceId: 'ws-e4',
  authMethod: 'jwt',
  trust: 'verified',
  capabilities: new Set(['device:*', 'voice:*']),
  label: 'avi@storewolf.com',
};

function ctx(overrides: Partial<RouteContext<unknown>> = {}): RouteContext<unknown> {
  return {
    principal: MOBILE_PRINCIPAL,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

function routeByPath(method: string, path: string): RouteDefinition<never> {
  const def = (voiceRoutes as RouteDefinition<never>[]).find(
    (r) => r.method === method && r.path === path,
  );
  if (!def) throw new Error(`no ${method} ${path} in routes/device/voice`);
  return def;
}

function req(path: string, method = 'GET'): Request {
  return new Request(`http://localhost/api${path}`, { method });
}

/** A fetch Response carrying an EL convai token body (or a raw error string). */
function elResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const VALID_PREFS = {
  fullAgentEngine: 'elevenlabs-conv',
  elevenLabsAgentId: 'agent-xyz',
  audienceMode: 'engineer',
};

beforeEach(() => {
  vi.mocked(loadVoicePrefs).mockResolvedValue({ ...VALID_PREFS } as never);
  vi.mocked(readElevenLabsKey).mockResolvedValue('el-key');
  vi.mocked(readCooldownMark).mockResolvedValue(0); // no prior mint → cooldown passes
  vi.mocked(writeCooldownMark).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('voice-lease endpoints', () => {
  it('GET /device/voice-lease reads the lease for the principal workspace', async () => {
    vi.mocked(readVoiceLease).mockResolvedValueOnce({
      ownerId: 'p1',
      ownerKind: 'mobile',
      expiresAtMs: Date.now() + 9000,
    } as never);
    const res = await routeByPath('GET', '/device/voice-lease').handler(
      req('/device/voice-lease'),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(readVoiceLease).toHaveBeenCalledWith('ws-e4');
    const body = (await res.json()) as { lease: { ownerKind: string } };
    expect(body.lease.ownerKind).toBe('mobile');
  });

  it('POST /device/voice-lease/claim claims as mobile with the device slug as owner', async () => {
    const res = await routeByPath('POST', '/device/voice-lease/claim').handler(
      req('/device/voice-lease/claim', 'POST'),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(claimVoiceLease).toHaveBeenCalledWith({
      workspaceId: 'ws-e4',
      ownerKind: 'mobile',
      ownerId: 'device-e4',
    });
    expect(await res.json()).toEqual({ ok: true });
  });

  it('POST /device/voice-lease/heartbeat re-claims (refreshes) the same lease', async () => {
    await routeByPath('POST', '/device/voice-lease/heartbeat').handler(
      req('/device/voice-lease/heartbeat', 'POST'),
      ctx(),
    );
    expect(claimVoiceLease).toHaveBeenCalledWith({
      workspaceId: 'ws-e4',
      ownerKind: 'mobile',
      ownerId: 'device-e4',
    });
  });

  it('DELETE /device/voice-lease releases the principal’s lease', async () => {
    const res = await routeByPath('DELETE', '/device/voice-lease').handler(
      req('/device/voice-lease', 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(releaseVoiceLease).toHaveBeenCalledWith({ workspaceId: 'ws-e4', ownerId: 'device-e4' });
  });
});

describe('voice-session-init — configuration gates', () => {
  const initDef = () => routeByPath('GET', '/device/voice-session-init');

  it('404 voice_not_enabled when the full-agent engine is not EL Conv AI', async () => {
    vi.mocked(loadVoicePrefs).mockResolvedValue({ ...VALID_PREFS, fullAgentEngine: 'off' } as never);
    const res = await initDef().handler(req('/device/voice-session-init'), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('voice_not_enabled');
  });

  it('accepts the elevenlabs-conversational engine alias', async () => {
    vi.mocked(loadVoicePrefs).mockResolvedValue({
      ...VALID_PREFS,
      fullAgentEngine: 'elevenlabs-conversational',
    } as never);
    vi.stubGlobal('fetch', vi.fn(async () => elResponse({ token: 'tok' })));
    const res = await initDef().handler(req('/device/voice-session-init'), ctx());
    expect(res.status).toBe(200);
  });

  it('404 no_agent_id when elevenLabsAgentId is unset', async () => {
    vi.mocked(loadVoicePrefs).mockResolvedValue({ ...VALID_PREFS, elevenLabsAgentId: '' } as never);
    const res = await initDef().handler(req('/device/voice-session-init'), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no_agent_id');
  });

  it('404 no_api_key when no ElevenLabs key is stored', async () => {
    vi.mocked(readElevenLabsKey).mockResolvedValue(null as never);
    const res = await initDef().handler(req('/device/voice-session-init'), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no_api_key');
  });
});

describe('voice-session-init — cooldown gate', () => {
  it('429 mint_cooldown when a mint fired within the last 8s', async () => {
    vi.mocked(readCooldownMark).mockResolvedValue(Date.now() - 2000); // 2s ago
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await routeByPath('GET', '/device/voice-session-init').handler(
      req('/device/voice-session-init'),
      ctx(),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfterMs: number };
    expect(body.error).toBe('mint_cooldown');
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled(); // never reaches EL
  });
});

describe('voice-session-init — mint success + error mapping', () => {
  const init = () =>
    routeByPath('GET', '/device/voice-session-init').handler(
      req('/device/voice-session-init'),
      ctx(),
    );

  it('mints a token, records the cooldown, and returns the session payload', async () => {
    const fetchMock = vi.fn(async () => elResponse({ token: 'el-token-123' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await init();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationToken: string;
      agentId: string;
      voiceMode: string;
      dynamicVariables: { device_id: string; workspace_id: string };
    };
    expect(body.conversationToken).toBe('el-token-123');
    expect(body.agentId).toBe('agent-xyz');
    expect(body.voiceMode).toBe('always-on');
    expect(body.dynamicVariables.device_id).toBe('device-e4');
    expect(body.dynamicVariables.workspace_id).toBe('ws-e4');
    // hits the EL convai token endpoint with the agent id
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'api.elevenlabs.io/v1/convai/conversation/token',
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain('agent_id=agent-xyz');
    expect(writeCooldownMark).toHaveBeenCalledWith('el-mint:agent-xyz');
  });

  it('accepts the conversation_token field name as well', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => elResponse({ conversation_token: 'ct-9' })));
    const body = (await (await init()).json()) as { conversationToken: string };
    expect(body.conversationToken).toBe('ct-9');
  });

  it('503 concurrent_limit when EL reports a workspace concurrency limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => elResponse('workspace_concurrency_limit reached', 429)));
    const res = await init();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('concurrent_limit');
    expect(writeCooldownMark).not.toHaveBeenCalled(); // failed mint must not arm cooldown
  });

  it('502 on a non-429 EL rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => elResponse('boom', 500)));
    const res = await init();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('mint_rejected');
  });

  it('502 mint_failed when the fetch throws (network/timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    const res = await init();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('mint_failed');
  });

  it('502 mint_shape when EL returns 200 with no token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => elResponse({ nope: true })));
    const res = await init();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('mint_shape');
  });
});

describe('voice-session-init — in-flight dedup', () => {
  it('coalesces concurrent mints for the same agent into a single EL call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return elResponse({ token: 'shared-tok' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const def = routeByPath('GET', '/device/voice-session-init');
    const p1 = def.handler(req('/device/voice-session-init'), ctx());
    // Let p1 resolve its dynamic module imports and park at the gated fetch
    // before p2 starts — so p2's imports hit the (now-warm) mocked-module
    // cache and it joins the same in-flight mint. Models two pair-retries
    // arriving a few ms apart.
    await new Promise((r) => setTimeout(r, 10));
    const p2 = def.handler(req('/device/voice-session-init'), ctx());
    await new Promise((r) => setTimeout(r, 10));
    release();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r1.json()) as { conversationToken: string }).conversationToken).toBe('shared-tok');
  });
});
