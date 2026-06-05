/**
 * Verification for the ported `provision` family — consent / host-check /
 * state / run / stream — mounted on a throwaway Hono app. Proves the
 * `defineTool` ports preserve status codes, JSON bodies, validation
 * branches, and (for `stream`) the SSE response shape.
 *
 * Provision libs are mocked — this tests the route ports, not the
 * provision runner / trust store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Provision routes are now `{trust:['verified','trusted']}` (D3 pass);
// stub the principal resolver so these handler-logic tests don't 403.
vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'user', slug: 'user:test', workspaceId: 'ws',
    authMethod: 'cookie-session', trust: 'verified',
    capabilities: new Set<string>(['*']), label: 'test',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
  },
}));

vi.mock('../../provision/trust-store', () => ({
  checkTrust: vi.fn(async () => ({ trusted: true })),
  recordTrust: vi.fn(async () => {}),
  revokeTrust: vi.fn(async () => {}),
}));
vi.mock('../../provision/single-user', () => ({
  decideGate: vi.fn(async () => ({ decision: 'allow', signals: {} })),
  detectSharedHost: vi.fn(async () => ({})),
  writeAcknowledgement: vi.fn(async () => {}),
}));
vi.mock('../../provision/sandbox', () => ({
  smokeTestSandbox: vi.fn(async () => ({ ok: true, driver: 'bwrap' })),
}));
vi.mock('../../provision/runner', () => ({ runPhase: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../provision/state-store', () => ({ readState: vi.fn(async () => ({ hashes: {} })) }));
vi.mock('../../provision/audit-log', () => ({ readAudit: vi.fn(async () => []) }));
vi.mock('../../provision-audit-bus', () => ({
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
}));
vi.mock('../../papercusp-root', () => ({
  // Point at a dir that does not exist so `run`'s readJson resolves null.
  papercuspPath: vi.fn((s: string) => `/tmp/__no_such_provision_dir__/${s}`),
}));
vi.mock('@papercusp/sse', () => ({
  sseResponse: vi.fn(() => new Response('event: x\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import provisionConsent from '../routes/provision/consent';
import provisionHostCheck from '../routes/provision/host-check';
import provisionState from '../routes/provision/state';
import provisionRun from '../routes/provision/run';
import provisionStream from '../routes/provision/stream';
import { recordTrust, revokeTrust } from '../../provision/trust-store';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}

const json = (b: unknown) => ({
  method: 'POST',
  body: JSON.stringify(b),
  headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.clearAllMocks());

describe('provision/consent', () => {
  const app = appWith(provisionConsent as AnyRoute[]);

  it('POST rejects invalid JSON with 400', async () => {
    const res = await app.request('/provision/consent', {
      method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST rejects a missing publisher with 400', async () => {
    const res = await app.request('/provision/consent', json({ plugin: 'p' }));
    expect(res.status).toBe(400);
  });

  it('POST records trust on a complete body', async () => {
    const res = await app.request('/provision/consent', json({
      publisher: 'pub', plugin: 'p', scriptHash: 'sha', publisherKeyFingerprint: 'fp',
    }));
    expect(res.status).toBe(200);
    expect(recordTrust).toHaveBeenCalledOnce();
  });

  it('POST revokes trust when revoke:true', async () => {
    const res = await app.request('/provision/consent', json({ publisher: 'pub', plugin: 'p', revoke: true }));
    expect(res.status).toBe(200);
    expect(revokeTrust).toHaveBeenCalledWith('pub', 'p');
  });

  it('GET rejects missing params with 400', async () => {
    const res = await app.request('/provision/consent?publisher=pub');
    expect(res.status).toBe(400);
  });

  it('GET returns a trust result', async () => {
    const res = await app.request('/provision/consent?publisher=pub&plugin=p&scriptHash=s&fingerprint=fp');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { trusted: true } });
  });
});

describe('provision/host-check', () => {
  const app = appWith(provisionHostCheck as AnyRoute[]);

  it('GET returns the gate decision', async () => {
    const res = await app.request('/provision/host-check');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, decision: 'allow' });
  });

  it('GET runs the sandbox smoke test on ?smokeTest=1', async () => {
    const res = await app.request('/provision/host-check?smokeTest=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ smokeTest: { ok: true } });
  });

  it('POST rejects without acknowledge', async () => {
    const res = await app.request('/provision/host-check', json({}));
    expect(res.status).toBe(400);
  });

  it('POST records the acknowledgement', async () => {
    const res = await app.request('/provision/host-check', json({ acknowledge: true }));
    expect(res.status).toBe(200);
  });
});

describe('provision/state', () => {
  const app = appWith(provisionState as AnyRoute);

  it('rejects missing params with 400', async () => {
    const res = await app.request('/provision/state?harness=h');
    expect(res.status).toBe(400);
  });

  it('returns state + audit', async () => {
    const res = await app.request('/provision/state?harness=h&plugin=p');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, state: { hashes: {} }, audit: [] });
  });
});

describe('provision/run', () => {
  const app = appWith(provisionRun as AnyRoute);

  it('rejects invalid JSON with 400', async () => {
    const res = await app.request('/provision/run', {
      method: 'POST', body: '{', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing fields with 400', async () => {
    const res = await app.request('/provision/run', json({ harness: 'h' }));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid phase with 400', async () => {
    const res = await app.request('/provision/run', json({ harness: 'h', plugin: 'p', phase: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the plugin manifest is absent', async () => {
    const res = await app.request('/provision/run', json({ harness: 'h', plugin: 'p', phase: 'setup' }));
    expect(res.status).toBe(404);
  });
});

describe('provision/stream', () => {
  const app = appWith(provisionStream as AnyRoute);

  it('rejects missing params with 400', async () => {
    const res = await app.request('/provision/stream?harness=h');
    expect(res.status).toBe(400);
  });

  it('returns an SSE response when params are present', async () => {
    const res = await app.request('/provision/stream?harness=h&plugin=p');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});
