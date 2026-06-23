import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// @ts-expect-error — .mjs sibling, no types but stable runtime API
import { SHARED_TOOLS, runSharedTool, runDispatchToAgent } from './agent-tools-shared.mjs';

interface Call { url: string; method: string; body?: unknown }
const calls: Call[] = [];
const responses = new Map<string, { ok?: boolean; status?: number; body?: any }>();
const origFetch = globalThis.fetch;

interface HarnessSummary {
  slug: string;
  path: string;
  hasState: boolean;
  hasSpec: boolean;
}

interface ChatSummary {
  id: string;
}

interface AgentSummary {
  slug: string;
  role: string;
  chat_count: number;
  last_active: string;
}

function setup() {
  calls.length = 0;
  responses.clear();
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body });
    const resp = responses.get(u);
    if (!resp) return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as any;
    return { ok: resp.ok ?? true, status: resp.status ?? 200, text: async () => '', json: async () => resp.body } as any;
  }) as any;
}

beforeEach(setup);

afterEach(() => { globalThis.fetch = origFetch; });

function tools<T extends { name: string }>(arr: T[]): string[] { return arr.map((t) => t.name).sort(); }

describe('SHARED_TOOLS catalog', () => {
  it('exposes 5 tools with stable names', () => {
    expect(tools(SHARED_TOOLS)).toEqual([
      'dispatchToAgent', 'getHarnessStatus', 'listAgents', 'listChats', 'listHarnesses',
    ]);
  });
  it('every tool has an inputSchema', () => {
    for (const t of SHARED_TOOLS as Array<{ inputSchema?: { type: string } }>) {
      expect(t.inputSchema?.type).toBe('object');
    }
  });
});

describe('runSharedTool', () => {
  it('listHarnesses normalizes the projects payload', async () => {
    responses.set('http://test/api/harness/projects', { body: {
      projects: [
        { slug: 'a', path: '/a', hasState: true, hasSpec: false },
        { slug: 'b', path: '/b' },
      ],
    } });
    const r = await runSharedTool('listHarnesses', {}, { base: 'http://test' });
    const parsed = JSON.parse(r.content[0].text) as HarnessSummary[];
    expect(parsed).toEqual([
      { slug: 'a', path: '/a', hasState: true, hasSpec: false },
      { slug: 'b', path: '/b', hasState: false, hasSpec: false },
    ]);
  });

  it('listChats sorts by updated_at desc + caps at 20', async () => {
    const chats = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`, role: 'architect', title: `t${i}`, updated_at: `2026-01-${String(i + 1).padStart(2, '0')}`, transcript: [],
    }));
    responses.set('http://test/api/harness/foo/agent-chats', { body: { chats } });
    const r = await runSharedTool('listChats', { slug: 'foo' }, { base: 'http://test' });
    const parsed = JSON.parse(r.content[0].text) as ChatSummary[];
    expect(parsed).toHaveLength(20);
    expect(parsed[0].id).toBe('c29');
  });

  it('listChats filters by role', async () => {
    responses.set('http://test/api/harness/foo/agent-chats', { body: { chats: [
      { id: 'a', role: 'architect', updated_at: '2026-01-02', transcript: [] },
      { id: 'b', role: 'worker', updated_at: '2026-01-01', transcript: [] },
    ] } });
    const r = await runSharedTool('listChats', { slug: 'foo', role: 'architect' }, { base: 'http://test' });
    const parsed = JSON.parse(r.content[0].text) as ChatSummary[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('a');
  });

  it('listAgents groups chats by (slug, role) and computes last_active', async () => {
    responses.set('http://test/api/harness/projects', { body: { projects: [{ slug: 'h1' }, { slug: 'h2' }] } });
    responses.set('http://test/api/harness/h1/agent-chats', { body: { chats: [
      { role: 'architect', updated_at: '2026-01-02' },
      { role: 'architect', updated_at: '2026-01-03' },
      { role: 'worker', updated_at: '2026-01-01' },
    ] } });
    responses.set('http://test/api/harness/h2/agent-chats', { body: { chats: [
      { role: 'architect', updated_at: '2026-01-05' },
    ] } });
    const r = await runSharedTool('listAgents', {}, { base: 'http://test' });
    const parsed = JSON.parse(r.content[0].text) as AgentSummary[];
    // Most recent first
    expect(parsed[0]).toEqual({ slug: 'h2', role: 'architect', chat_count: 1, last_active: '2026-01-05' });
    expect(parsed.find((a) => a.slug === 'h1' && a.role === 'architect')).toEqual({
      slug: 'h1', role: 'architect', chat_count: 2, last_active: '2026-01-03',
    });
  });

  it('getHarnessStatus rolls up feature_counts', async () => {
    responses.set('http://test/api/harness/foo/status?phase=staging', { body: {
      project: { path: '/p' },
      features: [
        { id: 'f1', status: 'passed', title: 'A' },
        { id: 'f2', status: 'in-progress', title: 'B' },
        { id: 'f3', status: 'passed', title: 'C' },
      ],
    } });
    responses.set('http://test/api/harness/foo/summary', { body: { summary: 'summary text' } });
    const r = await runSharedTool('getHarnessStatus', { slug: 'foo' }, { base: 'http://test' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.feature_counts).toEqual({ passed: 2, 'in-progress': 1 });
    expect(parsed.feature_total).toBe(3);
  });

  it('errors on missing slug', async () => {
    const r = await runSharedTool('getHarnessStatus', {}, { base: 'http://test' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/slug required/);
  });
});

describe('runDispatchToAgent', () => {
  it('creates the chat and posts the first message', async () => {
    responses.set('http://test/api/harness/sheets/agent-chats', {
      body: { id: 'chat-123', title: 'architect', feature_id: null },
    });
    responses.set('http://test/api/harness/sheets/agent-chats/chat-123/messages', { body: { ok: true } });
    const result = await runDispatchToAgent(
      { slug: 'sheets', role: 'architect', message: 'hello' },
      { base: 'http://test' },
    );
    expect(result.error).toBeUndefined();
    expect(result.chat.id).toBe('chat-123');
    // Two POSTs: create chat + send message.
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
  });

  it('returns structured error when create fails', async () => {
    responses.set('http://test/api/harness/sheets/agent-chats', { ok: false, status: 500 });
    const result = await runDispatchToAgent(
      { slug: 'sheets', role: 'architect', message: 'hi' },
      { base: 'http://test' },
    );
    expect(result.error?.isError).toBe(true);
  });
});
