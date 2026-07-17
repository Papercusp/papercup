/**
 * merge:approve — pins the loopback-wrap contract (EI-457): builds the right
 * confirm URL (+ optional phase query), POSTs an empty JSON body, returns the
 * confirmed promotion JSON on success, and surfaces a non-2xx as isError with
 * the response body echoed (truncated).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  lastUrl: '',
  lastInit: undefined as RequestInit | undefined,
  status: 200,
  bodyText: '{}',
}));

vi.mock('../../loopback-fetch', () => ({
  loopbackFetch: async (url: string, init?: RequestInit) => {
    h.lastUrl = String(url);
    h.lastInit = init;
    return {
      ok: h.status >= 200 && h.status < 300,
      status: h.status,
      text: async () => h.bodyText,
    } as unknown as Response;
  },
  readJsonBody: async () => JSON.parse(h.bodyText),
}));

const tool = (await import('./approve')).default;

async function callTool(args: Record<string, unknown>): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const res = await (
    tool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    }
  ).handler(args, {});
  return { isError: res.isError, body: JSON.parse(res.content[0].text) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PORT', '3055');
  vi.stubEnv('INTERNAL_API_BASE', undefined as unknown as string);
  h.lastUrl = '';
  h.lastInit = undefined;
  h.status = 200;
  h.bodyText = '{}';
});

describe('merge:approve', () => {
  it('POSTs the promote confirm route, no phase query by default', async () => {
    h.bodyText = JSON.stringify({ ok: true, sha: 'abc123', promotion: { id: 'promotion-1' } });
    const { isError, body } = await callTool({ slug: 'papercup', id: 'promotion-1' });
    expect(isError).toBeFalsy();
    expect(h.lastUrl).toBe('http://127.0.0.1:3055/api/harness/papercup/promote/promotion-1/confirm');
    expect(h.lastInit?.method).toBe('POST');
    expect(body).toEqual({ ok: true, sha: 'abc123', promotion: { id: 'promotion-1' } });
  });

  it('appends ?phase= when a phase is given', async () => {
    await callTool({ slug: 'papercup', id: 'promotion-1', phase: 'testing' });
    expect(h.lastUrl).toBe('http://127.0.0.1:3055/api/harness/papercup/promote/promotion-1/confirm?phase=testing');
  });

  it('a non-2xx response (e.g. smoke-build failure) surfaces as isError with the body echoed', async () => {
    h.status = 422;
    h.bodyText = JSON.stringify({ error: 'smoke-build failed', reverted: true });
    const { isError, body } = await callTool({ slug: 'papercup', id: 'promotion-1' });
    expect(isError).toBe(true);
    expect(body.error).toBe('confirm_failed:422');
    expect(String(body.detail)).toContain('smoke-build failed');
  });
});
