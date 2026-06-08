/**
 * Tests for the saved-prompts browser fetch helpers (scope query, CORS-simple
 * POST body, error propagation). Run with:
 *   cd packages/operator-core && npx vitest run lib/saved-prompts-client.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cross-origin-url', () => ({ crossOriginUrl: (u: string) => u }));

import { fetchSavedPrompts, saveSavedPrompt, deleteSavedPrompt } from './saved-prompts-client';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const bad = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body });

afterEach(() => fetchMock.mockReset());

describe('fetchSavedPrompts', () => {
  it('GETs the workspace-global URL and returns the prompts array', async () => {
    fetchMock.mockResolvedValue(ok({ prompts: [{ id: 'p1', name: 'a' }] }));
    const out = await fetchSavedPrompts();
    expect(fetchMock).toHaveBeenCalledWith('/api/agent-mcp/saved-prompts');
    expect(out).toEqual([{ id: 'p1', name: 'a' }]);
  });

  it('scopes by harness when given', async () => {
    fetchMock.mockResolvedValue(ok({ prompts: [] }));
    await fetchSavedPrompts('my harness');
    expect(fetchMock).toHaveBeenCalledWith('/api/agent-mcp/saved-prompts?harness=my%20harness');
  });

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValue(bad(500));
    await expect(fetchSavedPrompts()).rejects.toThrow(/Failed to load saved prompts \(500\)/);
  });
});

describe('saveSavedPrompt', () => {
  it('POSTs a text/plain (preflight-free) JSON body and returns the prompt', async () => {
    fetchMock.mockResolvedValue(ok({ prompt: { id: 'p1', name: 'a' } }));
    const out = await saveSavedPrompt({ name: 'a', body: 'hi' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'text/plain' });
    expect(JSON.parse(init.body)).toEqual({ name: 'a', body: 'hi' });
    expect(out).toEqual({ id: 'p1', name: 'a' });
  });

  it('prefers the server detail/error message on failure', async () => {
    fetchMock.mockResolvedValue(bad(400, { detail: 'name taken' }));
    await expect(saveSavedPrompt({ name: 'a', body: 'b' })).rejects.toThrow('name taken');
  });
});

describe('deleteSavedPrompt', () => {
  it('POSTs to /remove with the name + harness', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await deleteSavedPrompt('a', 'h1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/agent-mcp/saved-prompts/remove');
    expect(JSON.parse(init.body)).toEqual({ name: 'a', harness: 'h1' });
  });

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValue(bad(404));
    await expect(deleteSavedPrompt('a')).rejects.toThrow(/Delete failed \(404\)/);
  });
});
