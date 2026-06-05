import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Track fetch calls + program responses per test.
interface FetchCall { url: string; method: string; body?: unknown }
const calls: FetchCall[] = [];
let conversationsResponse: { ok: boolean; json: () => unknown } | null = null;
let turnsResponseQueue: { status: number; ok: boolean }[] = [];

beforeEach(async () => {
  calls.length = 0;
  conversationsResponse = { ok: true, json: () => ({ conversation: { id: 'conv-test-1' } }) };
  turnsResponseQueue = [{ status: 200, ok: true }];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    if (url === '/api/operator/conversations') {
      if (!conversationsResponse) throw new Error('network');
      return conversationsResponse as unknown as Response;
    }
    if (/\/api\/operator\/conversations\/.*\/turns/.test(url)) {
      const r = turnsResponseQueue.shift() ?? { status: 200, ok: true };
      return r as unknown as Response;
    }
    return { ok: false } as unknown as Response;
  }));
  // Fresh module state per test (the module caches the conversation id).
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getActiveOperatorConversationId', () => {
  it('fetches and caches the conversation id', async () => {
    const mod = await import('./operator-conversation-client');
    const a = await mod.getActiveOperatorConversationId();
    const b = await mod.getActiveOperatorConversationId();
    expect(a).toBe('conv-test-1');
    expect(b).toBe('conv-test-1');
    // Second call hits cache, no extra fetch.
    expect(calls.filter((c) => c.url === '/api/operator/conversations')).toHaveLength(1);
  });

  it('returns null on a non-ok conversations response', async () => {
    conversationsResponse = { ok: false, json: () => ({}) };
    const mod = await import('./operator-conversation-client');
    expect(await mod.getActiveOperatorConversationId()).toBeNull();
  });

  it('coalesces concurrent calls into a single inflight fetch', async () => {
    const mod = await import('./operator-conversation-client');
    const [a, b, c] = await Promise.all([
      mod.getActiveOperatorConversationId(),
      mod.getActiveOperatorConversationId(),
      mod.getActiveOperatorConversationId(),
    ]);
    expect(a).toBe('conv-test-1');
    expect(b).toBe('conv-test-1');
    expect(c).toBe('conv-test-1');
    expect(calls.filter((c) => c.url === '/api/operator/conversations')).toHaveLength(1);
  });
});

describe('persistOperatorVoiceTurn', () => {
  it('POSTs the turn with role / text / source / elConvId', async () => {
    const mod = await import('./operator-conversation-client');
    await mod.persistOperatorVoiceTurn({
      role: 'user',
      text: 'voice in',
      source: 'voice_stt',
      elConvId: 'el-123',
    });
    const turn = calls.find((c) => c.method === 'POST');
    expect(turn).toBeDefined();
    expect(turn?.url).toBe('/api/operator/conversations/conv-test-1/turns');
    expect(turn?.body).toMatchObject({
      role: 'user',
      text: 'voice in',
      source: 'voice_stt',
      elConvId: 'el-123',
    });
  });

  it('skips empty / whitespace-only text', async () => {
    const mod = await import('./operator-conversation-client');
    await mod.persistOperatorVoiceTurn({ role: 'user', text: '   ', source: 'voice_stt' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refetches + retries once on a 404', async () => {
    turnsResponseQueue = [{ status: 404, ok: false }, { status: 200, ok: true }];
    const mod = await import('./operator-conversation-client');
    await mod.persistOperatorVoiceTurn({ role: 'assistant', text: 'tts out', source: 'voice_tts' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    // Second conversations fetch happened (cache cleared on 404).
    const convFetches = calls.filter((c) => c.url === '/api/operator/conversations');
    expect(convFetches).toHaveLength(2);
  });

  it('clearOperatorConversationCache forces a refetch', async () => {
    const mod = await import('./operator-conversation-client');
    await mod.getActiveOperatorConversationId();
    mod.clearOperatorConversationCache();
    await mod.getActiveOperatorConversationId();
    expect(calls.filter((c) => c.url === '/api/operator/conversations')).toHaveLength(2);
  });
});
