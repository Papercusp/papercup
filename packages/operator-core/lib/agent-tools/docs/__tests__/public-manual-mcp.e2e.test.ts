/**
 * Public Papercup acceptance over the serving operator's real HTTP MCP mount.
 * Run with OPERATOR_BASE_URL pointing at a verified current-build operator.
 * No live host is assumed in ordinary CI. Existing public-handlers/public-manual
 * unit suites cover routing, private canaries, outage and revision in isolation.
 * Each test provisions a unique, expiring, read-only PI principal with the same
 * mount builder as the public brain, then revokes it. No owner token is used.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { endPiSession, startPiSession } from '@papercusp/agent-mcp/provisioning';
import { buildConverseMcpMount, PUBLIC_MANUAL_TOOLS } from '../../operator/converse-toolset';

const baseUrl = process.env.OPERATOR_BASE_URL;
const workspaceId = `public-manual-e2e-${randomUUID()}`;
let sessionId: string | undefined;
let client: Client | undefined;

function payload(result: Awaited<ReturnType<Client['callTool']>>, expectedError = false) {
  expect(result.isError === true, JSON.stringify(result)).toBe(expectedError);
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.find((block: { type?: string; text?: string }) => block.type === 'text');
  expect(text?.type).toBe('text');
  return JSON.parse((text as { text: string }).text);
}

async function call(name: string, args: Record<string, unknown>, expectedError = false) {
  return payload(await client!.callTool({ name, arguments: args }, undefined, { timeout: 15_000 }), expectedError);
}

describe.runIf(Boolean(baseUrl))('canonical manual on the public Papercup HTTP MCP mount', () => {
  beforeAll(async () => {
    const health = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(10_000) });
    expect(health.ok).toBe(true);
    expect((await health.json()).sha).toMatch(/^[a-f0-9]{7,40}$/);
  });

  beforeEach(async () => {
    sessionId = `public-manual-${randomUUID()}`;
    const principal = await startPiSession({
      workspaceId, sessionId, capabilities: ['docs:read'],
      allowedTools: ['docs:search', 'docs:get'],
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const mount = buildConverseMcpMount({
      hostTrust: 'public', baseUrl: baseUrl!, workspaceId,
      tools: PUBLIC_MANUAL_TOOLS, uiClientId: null,
      superuserToken: '', principalToken: principal.bearer,
    });
    expect(mount).not.toBeNull();
    expect(new URL(mount!.url).searchParams.has('superuser')).toBe(false);
    const url = new URL(mount!.url);
    url.searchParams.set('format', 'json');
    client = new Client({ name: 'public-manual-acceptance', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${mount!.bearer}` } },
    }), { timeout: 15_000 });
  }, 30_000);

  afterEach(async () => {
    try { await client?.close(); }
    finally {
      client = undefined;
      if (sessionId) await endPiSession(workspaceId, sessionId);
      sessionId = undefined;
    }
  });

  it('a fresh public session lists and calls both manual tools', async () => {
    const listed = await client!.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['docs:search', 'docs:get']));
    const result = await call('docs:search', { query: 'closing the browser', limit: 3 });
    expect(result).toMatchObject({ surface: 'public', revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'faq', url: '/docs/faq#does-closing-the-browser-stop-my-agents', heading: 'does-closing-the-browser-stop-my-agents' })]));
    const page = await call('docs:get', { slugs: ['faq'], heading: 'Does closing the browser stop my agents?' });
    expect(page.surface).toBe('public');
    expect(page.revision).toBe(result.revision);
    expect(page.results[0]).toMatchObject({ found: true, slug: 'faq' });
    expect(page.results[0].content).toMatch(/host|workspace/i);
  });

  it('retrieves natural paraphrases and an ordinary misspelling without embeddings', async () => {
    for (const query of ['Can work continue after I close the tab?', 'Do I need to keep the browser open?', 'browesr']) {
      const result = await call('docs:search', { query, limit: 3 });
      expect(result).toMatchObject({ surface: 'public', legs: { lexical: { status: 'ran' }, semantic: { status: 'not-run' } } });
      expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'faq', heading: 'does-closing-the-browser-stop-my-agents' })]));
    }
  });

  it('retrieves every published FAQ question and its two paraphrases on the serving public mount', async () => {
    const page = await call('docs:get', { slugs: ['faq'] });
    expect(page.results[0].found).toBe(true);
    const questions = [...String(page.results[0].content).matchAll(/^## (.+)\n\nAlso asked as: (.+)$/gm)];
    expect(questions).toHaveLength(20);
    for (const [, title, alternateQuestions] of questions) {
      const paraphrases = alternateQuestions.match(/[^?]+\?/g) ?? [];
      expect(paraphrases, title).toHaveLength(2);
      for (const query of [title, ...paraphrases]) {
        const result = await call('docs:search', { query: query.trim(), limit: 3 });
        expect(result.hits, query).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'faq', title })]));
      }
    }
  }, 90_000);

  it('pairs public retrieval with engineering, project and wildcard scope refusals', async () => {
    expect((await call('docs:get', { slugs: ['faq'], heading: 'Does closing the browser stop my agents?' })).results[0].found).toBe(true);
    for (const harness of ['engineering', 'private-project', 'all']) {
      expect(await call('docs:search', { query: 'browser', harness }, true)).toMatchObject({ error: 'public_scope_conflict' });
      expect(await call('docs:get', { slugs: ['faq'], harness }, true)).toMatchObject({ error: 'public_scope_conflict' });
    }
  });

  it('rejects private paths, encoded traversal and canonical source reads', async () => {
    for (const slug of ['spec/auth-and-identity', 'agent-insights/su-persona-render-and-edit-path', '../faq', '%2e%2e/faq', '/internal/docs/spec/auth-and-identity']) {
      const result = await call('docs:get', { slugs: [slug] });
      expect(result.surface).toBe('public');
      expect(result.results[0]).toMatchObject({ slug, found: false });
    }
    expect(await call('docs:get', { slugs: ['faq'], source: true }, true)).toMatchObject({ error: 'public_source_read_forbidden' });
  });

  it('the read-only public principal cannot author documentation', async () => {
    const result = await client!.callTool({ name: 'docs:author', arguments: {} }, undefined, { timeout: 15_000 });
    expect(result.isError).toBe(true);
  });
});
