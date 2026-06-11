/**
 * host-fault-injection (EI-297) — env-gated operator-side fault injection so
 * desktop e2e can exercise server-error / latency legs through the IPC-first
 * /api path. Pins: the env gate, rule matching (prefix + method), times
 * auto-expiry, delay-only fall-through, the loopback-only control plane, and
 * that the control plane can never fault itself out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  _resetFaultRules,
  faultInjectionControl,
  faultInjectionMiddleware,
} from './host-fault-injection';

function makeHost(): Hono {
  const host = new Hono();
  host.route('/', faultInjectionControl());
  host.use('/api/*', faultInjectionMiddleware);
  host.all('/api/*', (c) => c.json({ ok: true, path: new URL(c.req.url).pathname }));
  return host;
}

const LOOPBACK = { host: '127.0.0.1:3070' };

function req(
  host: Hono,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  return host.fetch(
    new Request(`http://127.0.0.1:3070${path}`, {
      ...init,
      headers: { ...LOOPBACK, ...(init.headers ?? {}) },
    }),
  );
}

async function addRule(host: Hono, rule: Record<string, unknown>): Promise<string> {
  const res = await req(host, '/api/admin/fault-injection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rule),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { rule: { id: string } }).rule.id;
}

beforeEach(() => {
  vi.stubEnv('PAPERCUSP_FAULT_INJECTION', '1');
  _resetFaultRules();
});
afterEach(() => vi.unstubAllEnvs());

describe('host fault injection (EI-297)', () => {
  it('is inert when the env gate is off', async () => {
    vi.stubEnv('PAPERCUSP_FAULT_INJECTION', '0');
    const host = makeHost();
    const res = await req(host, '/api/profile', { method: 'POST' });
    expect(res.status).toBe(200); // falls through to the real handler
  });

  it('passes through with no rules, faults on a matching prefix+method', async () => {
    const host = makeHost();
    expect((await req(host, '/api/profile', { method: 'POST' })).status).toBe(200);

    await addRule(host, { pathPrefix: '/api/profile', method: 'POST', status: 500 });
    const faulted = await req(host, '/api/profile', { method: 'POST' });
    expect(faulted.status).toBe(500);
    expect(((await faulted.json()) as { error: string }).error).toBe('fault-injection');
    // method mismatch is untouched
    expect((await req(host, '/api/profile')).status).toBe(200);
    // different path is untouched
    expect((await req(host, '/api/health', { method: 'POST' })).status).toBe(200);
  });

  it('times:N auto-expires the rule after N matches', async () => {
    const host = makeHost();
    await addRule(host, { pathPrefix: '/api/health', status: 503, times: 1 });
    expect((await req(host, '/api/health')).status).toBe(503);
    expect((await req(host, '/api/health')).status).toBe(200);
  });

  it('a delay-only rule falls through after the latency', async () => {
    const host = makeHost();
    await addRule(host, { pathPrefix: '/api/health', delayMs: 120 });
    const t0 = Date.now();
    const res = await req(host, '/api/health');
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it('control plane lists and deletes rules (by id and all)', async () => {
    const host = makeHost();
    const id = await addRule(host, { pathPrefix: '/api/a', status: 500 });
    await addRule(host, { pathPrefix: '/api/b', status: 502 });

    const list = (await (await req(host, '/api/admin/fault-injection')).json()) as {
      enabled: boolean;
      rules: unknown[];
    };
    expect(list.enabled).toBe(true);
    expect(list.rules.length).toBe(2);

    expect((await req(host, `/api/admin/fault-injection?id=${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await req(host, '/api/a')).status).toBe(200); // rule gone
    expect((await req(host, '/api/b')).status).toBe(502); // other rule intact

    await req(host, '/api/admin/fault-injection', { method: 'DELETE' });
    expect((await req(host, '/api/b')).status).toBe(200);
  });

  it('rejects a rule without pathPrefix or without any effect', async () => {
    const host = makeHost();
    const noPath = await req(host, '/api/admin/fault-injection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 500 }),
    });
    expect(noPath.status).toBe(400);
    const noEffect = await req(host, '/api/admin/fault-injection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathPrefix: '/api/x' }),
    });
    expect(noEffect.status).toBe(400);
  });

  it('control plane is loopback-only', async () => {
    const host = makeHost();
    const res = await host.fetch(
      new Request('http://127.0.0.1:3070/api/admin/fault-injection', {
        headers: { host: 'evil.example.com:3070' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('a broad /api fault rule never locks out its own control plane', async () => {
    const host = makeHost();
    await addRule(host, { pathPrefix: '/api', status: 500 });
    expect((await req(host, '/api/anything')).status).toBe(500);
    // the control plane still answers, so the rule can be cleared
    expect((await req(host, '/api/admin/fault-injection', { method: 'DELETE' })).status).toBe(200);
    expect((await req(host, '/api/anything')).status).toBe(200);
  });
});
