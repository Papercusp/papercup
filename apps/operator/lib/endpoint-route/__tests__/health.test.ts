/**
 * GET /health — operator liveness probe (agent-coordination-architecture-v2
 * §10 / Q-5). The OMP coordination extension hits this to choose
 * attached vs detached mode, so the contract is locked here:
 *   - 200, no auth, no DB
 *   - { ok: true, service: 'papercusp-operator', ts: <ISO> }
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import miscHealth from '../routes/misc/health';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(): Hono {
  const app = new Hono();
  registerRoute(app, miscHealth as AnyRoute);
  return app;
}

describe('GET /health', () => {
  it('answers 200 with the liveness payload', async () => {
    const resp = await appWith().request('/health');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      service: string;
      ts: string;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('papercusp-operator');
    // ts is a parseable ISO timestamp.
    expect(Number.isNaN(Date.parse(body.ts))).toBe(false);
  });

  it('requires no auth header', async () => {
    // No Authorization header at all — a probe must still answer.
    const resp = await appWith().request('/health');
    expect(resp.status).toBe(200);
  });
});
