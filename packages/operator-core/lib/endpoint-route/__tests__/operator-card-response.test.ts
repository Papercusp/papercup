/**
 * Tests for /card-response — H3 audit + plan §4.9. Drives via Hono app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../auth', () => ({ getSessionUser: vi.fn() }));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

import { Hono } from 'hono';
import { getSessionUser } from '../../auth';
import {
  _resetCardCorrelatorForTests,
  registerCard,
  _resetStateChannelForTests,
  openRun,
} from '@papercusp/agent-mcp';
import { _resetCardResponseRateLimitForTests } from '../../card-response-rate-limit';
import { registerAllRoutes } from '../register';

const ws = 'workspace-T';
const choiceSchema = z.object({ picks: z.array(z.string()).min(1) });
let app: Hono;

function post(body: unknown) {
  return app.request('/api/operator/conversations/c1/card-response', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/operator/conversations/:id/card-response', () => {
  beforeEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'u1', username: 'alice', display_name: 'Alice', has_password: true,
    });
    app = new Hono().basePath('/api');
    registerAllRoutes(app);
  });
  afterEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
  });

  function pendingCard() {
    openRun({ workspaceId: ws, runId: 'r1' });
    return registerCard({
      workspaceId: ws, runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema },
    });
  }

  it('401 when session cookie is missing (H3)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await post({ correlationId: 'x', workspaceId: ws, action: 'submit', payload: { picks: ['a'] } });
    expect(res.status).toBe(401);
  });

  it('400 when body shape invalid', async () => {
    const res = await post({ correlationId: '', action: 'submit' });
    expect(res.status).toBe(400);
  });

  it('submit happy-path: resolves deferred, returns 200', async () => {
    const reg = pendingCard();
    const res = await post({
      correlationId: reg.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] },
    });
    expect(res.status).toBe(200);
    expect(await reg.result).toEqual({ action: 'submit', payload: { picks: ['a'] } });
  });

  it('submit validation failure returns 400 with Zod details', async () => {
    const reg = pendingCard();
    const res = await post({
      correlationId: reg.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: [] },
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string; details?: unknown };
    expect(j.error).toMatch(/dataSchema/);
    expect(j.details).toBeDefined();
  });

  it('decline path resolves with action:decline', async () => {
    const reg = pendingCard();
    const res = await post({
      correlationId: reg.correlationId, workspaceId: ws,
      action: 'decline', reason: 'nope',
    });
    expect(res.status).toBe(200);
    expect(await reg.result).toEqual({ action: 'decline', reason: 'nope' });
  });

  it('cross-workspace correlationId returns 404 (defense-in-depth)', async () => {
    const reg = pendingCard();
    const res = await post({
      correlationId: reg.correlationId, workspaceId: 'other-ws',
      action: 'submit', payload: { picks: ['a'] },
    });
    expect(res.status).toBe(404);
  });

  it('429 after 30 RPS for the same session user (H3)', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await post({
        correlationId: 'doesntmatter', workspaceId: 'rate-ws', action: 'cancel',
      });
      responses.push(res.status);
    }
    expect(responses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(responses[0]).not.toBe(429);
    expect(responses[31]).toBe(429);
  });

  it('audit: rate limit is per session user, NOT per caller-supplied workspaceId', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await post({
        correlationId: 'x', workspaceId: `attacker-ws-${i}`, action: 'cancel',
      });
      responses.push(res.status);
    }
    expect(responses[31]).toBe(429);
  });

  it('audit: a different session user has its own bucket', async () => {
    for (let i = 0; i < 30; i++) {
      await post({ correlationId: 'x', workspaceId: 'w', action: 'cancel' });
    }
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'u2', username: 'bob', display_name: 'Bob', has_password: true,
    });
    const res = await post({ correlationId: 'x', workspaceId: 'w', action: 'cancel' });
    expect(res.status).not.toBe(429);
  });
});
