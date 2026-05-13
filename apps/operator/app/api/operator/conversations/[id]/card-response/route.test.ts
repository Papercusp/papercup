/**
 * Tests for the /card-response route — H3 audit + plan §4.9.
 *
 * Uses route-handler unit-test style (call POST directly with a fake
 * NextRequest). Auth is mocked via vi.doMock for /lib/auth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/auth', () => ({
  getSessionUser: vi.fn(),
}));

import { getSessionUser } from '@/lib/auth';
import {
  _resetCardCorrelatorForTests,
  registerCard,
} from '@papercusp/agent-mcp';
import { _resetStateChannelForTests, openRun } from '@papercusp/agent-mcp';

import { POST, _resetCardResponseRateLimitForTests } from './route';

const ws = 'workspace-T';
const choiceSchema = z.object({ picks: z.array(z.string()).min(1) });

function makeReq(body: unknown): import('next/server').NextRequest {
  return new Request('http://localhost/api/operator/conversations/c1/card-response', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/operator/conversations/:id/card-response', () => {
  beforeEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'u1',
      username: 'alice',
      display_name: 'Alice',
      has_password: true,
    });
  });
  afterEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
  });

  function pendingCard() {
    openRun({ workspaceId: ws, runId: 'r1' });
    const reg = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema },
    });
    return reg;
  }

  it('401 when session cookie is missing (H3)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await POST(
      makeReq({ correlationId: 'x', workspaceId: ws, action: 'submit', payload: { picks: ['a'] } }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('400 when body shape invalid', async () => {
    const res = await POST(
      makeReq({ correlationId: '', action: 'submit' }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(res.status).toBe(400);
  });

  it('submit happy-path: resolves deferred, returns 200', async () => {
    const reg = pendingCard();
    const res = await POST(
      makeReq({
        correlationId: reg.correlationId,
        workspaceId: ws,
        action: 'submit',
        payload: { picks: ['a'] },
      }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(res.status).toBe(200);
    expect(await reg.result).toEqual({ action: 'submit', payload: { picks: ['a'] } });
  });

  it('submit validation failure returns 400 with Zod details', async () => {
    const reg = pendingCard();
    const res = await POST(
      makeReq({
        correlationId: reg.correlationId,
        workspaceId: ws,
        action: 'submit',
        payload: { picks: [] },
      }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string; details?: unknown };
    expect(j.error).toMatch(/dataSchema/);
    expect(j.details).toBeDefined();
  });

  it('decline path resolves with action:decline', async () => {
    const reg = pendingCard();
    const res = await POST(
      makeReq({
        correlationId: reg.correlationId,
        workspaceId: ws,
        action: 'decline',
        reason: 'nope',
      }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(res.status).toBe(200);
    expect(await reg.result).toEqual({ action: 'decline', reason: 'nope' });
  });

  it('cross-workspace correlationId returns 404 (defense-in-depth)', async () => {
    const reg = pendingCard();
    const res = await POST(
      makeReq({
        correlationId: reg.correlationId,
        workspaceId: 'other-ws',
        action: 'submit',
        payload: { picks: ['a'] },
      }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(res.status).toBe(404);
  });

  it('429 after 30 RPS in the same workspace window (H3)', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await POST(
        makeReq({
          correlationId: 'doesntmatter',
          workspaceId: 'rate-ws',
          action: 'cancel',
        }),
        { params: Promise.resolve({ id: 'c1' }) },
      );
      responses.push(res.status);
    }
    expect(responses.filter((s) => s === 429).length).toBeGreaterThan(0);
    // First 30 should not be 429; 31+ should be.
    expect(responses[0]).not.toBe(429);
    expect(responses[31]).toBe(429);
  });
});
