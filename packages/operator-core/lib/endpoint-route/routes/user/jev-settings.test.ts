/**
 * jev-settings.test.ts (route) — GET/POST /api/user/jev-settings, P-013 of
 * jev-decision-model-integration-2026-09-29.
 *
 * The route must: return the masked view (never the raw key), validate mode and
 * key before writing anything, save the key BEFORE flipping the mode (so a failed
 * credential write cannot leave Jev "on" with a stale key), and be loopback-only
 * for writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));

const calls = vi.hoisted(() => ({ order: [] as string[], failKeyWrite: false }));

vi.mock('../../../memory/jev-settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../memory/jev-settings')>();
  return {
    ...real,
    setJevApiKey: vi.fn(async (key: string | null) => {
      calls.order.push(`key:${key === null ? 'clear' : 'save'}`);
      if (calls.failKeyWrite) throw new Error('credential store down');
    }),
    setJevMode: vi.fn(async (mode: string) => {
      calls.order.push(`mode:${mode}`);
      return mode;
    }),
    getJevSettingsView: vi.fn(async () => ({
      mode: 'shadow',
      keyPresent: true,
      maskedKey: 'fak...aaaa',
      effective: 'shadow',
      model: 'jev-1.13.0',
    })),
  };
});

import routes from './jev-settings';

// Deliberately low-entropy: an obvious fixture, never mistakable for a real key.
const FIXTURE = 'fake-jev-key-aaaaaaaa';

type Route = { method: string; path: string; auth: string; handler: (req: Request) => Promise<Response> };
const [getRoute, postRoute] = routes as unknown as [Route, Route];

function post(body: unknown): Promise<Response> {
  return postRoute.handler(
    new Request('http://127.0.0.1/api/user/jev-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  calls.order = [];
  calls.failKeyWrite = false;
});

describe('route shape', () => {
  it('GET is readable, POST is loopback-only', () => {
    expect(getRoute).toMatchObject({ method: 'GET', path: '/user/jev-settings' });
    expect(postRoute).toMatchObject({ method: 'POST', path: '/user/jev-settings', auth: 'loopback' });
  });

  it('GET returns the masked view', async () => {
    const res = await getRoute.handler(new Request('http://127.0.0.1/api/user/jev-settings'));
    expect(await res.json()).toEqual({ mode: 'shadow', keyPresent: true, maskedKey: 'fak...aaaa', effective: 'shadow', model: 'jev-1.13.0' });
  });
});

describe('POST validation writes nothing on a bad request', () => {
  it.each([
    ['invalid JSON', '{not json'],
    ['an array body', []],
    ['an empty change', {}],
    ['an unknown mode', { mode: 'always' }],
    ['a non-string key', { apiKey: 12345678 }],
    ['a too-short key', { apiKey: 'short' }],
    ['a key with whitespace', { apiKey: 'fake jev key aaaa' }],
  ])('%s ⇒ 400', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(calls.order).toEqual([]);
  });
});

describe('POST writes', () => {
  it('saves the key BEFORE turning Jev on', async () => {
    const res = await post({ apiKey: FIXTURE, mode: 'on' });
    expect(res.status).toBe(200);
    expect(calls.order).toEqual(['key:save', 'mode:on']);
    expect(await res.json()).toMatchObject({ ok: true, maskedKey: 'fak...aaaa' });
  });

  it('a failed key write leaves the mode untouched', async () => {
    calls.failKeyWrite = true;
    await expect(post({ apiKey: FIXTURE, mode: 'on' })).rejects.toThrow(/credential store down/);
    expect(calls.order).toEqual(['key:save']);
  });

  it('null clears the key', async () => {
    await post({ apiKey: null });
    expect(calls.order).toEqual(['key:clear']);
  });

  it('a mode-only change does not touch the key', async () => {
    await post({ mode: 'off' });
    expect(calls.order).toEqual(['mode:off']);
  });
});
