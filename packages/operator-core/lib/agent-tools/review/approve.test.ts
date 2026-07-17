/**
 * review:approve — pins the loopback-wrap contract (EI-457): builds the right
 * URL (+ optional phase query), forwards { response, accept } as the POST
 * body, returns the resolved review JSON on success, and surfaces a non-2xx
 * as isError with the response body echoed (truncated).
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
  // Deterministic operatorBase() regardless of the ambient PORT/INTERNAL_API_BASE
  // this process happens to inherit (e.g. a dev :3070 shell) — pin both.
  vi.stubEnv('PORT', '3055');
  vi.stubEnv('INTERNAL_API_BASE', undefined as unknown as string);
  h.lastUrl = '';
  h.lastInit = undefined;
  h.status = 200;
  h.bodyText = '{}';
});

describe('review:approve', () => {
  it('POSTs the resolve route with the response/accept body, no phase query by default', async () => {
    h.bodyText = JSON.stringify({ ok: true, review: { id: 'rev-1', resolved: true } });
    const { isError, body } = await callTool({ slug: 'papercup', id: 'rev-1', accept: true });
    expect(isError).toBeFalsy();
    expect(h.lastUrl).toBe('http://127.0.0.1:3055/api/harness/papercup/reviews/rev-1/resolve');
    expect(h.lastInit?.method).toBe('POST');
    expect(JSON.parse(String(h.lastInit?.body))).toEqual({ response: undefined, accept: true });
    expect(body).toEqual({ ok: true, review: { id: 'rev-1', resolved: true } });
  });

  it('appends ?phase= when a phase is given', async () => {
    await callTool({ slug: 'papercup', id: 'rev-1', phase: 'testing' });
    expect(h.lastUrl).toBe('http://127.0.0.1:3055/api/harness/papercup/reviews/rev-1/resolve?phase=testing');
  });

  it('a non-2xx response surfaces as isError with the body echoed', async () => {
    h.status = 404;
    h.bodyText = JSON.stringify({ error: 'not found' });
    const { isError, body } = await callTool({ slug: 'papercup', id: 'missing' });
    expect(isError).toBe(true);
    expect(body.error).toBe('resolve_failed:404');
    expect(String(body.detail)).toContain('not found');
  });
});
