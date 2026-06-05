/**
 * Tests for /run-cancel — cancels every pending card under a runId.
 * Drives via Hono app.
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
  _resetStateChannelForTests,
  openRun,
  registerCard,
} from '@papercusp/agent-mcp';
import { _resetCardResponseRateLimitForTests } from '../../card-response-rate-limit';
import { registerAllRoutes } from '../register';

const ws = 'workspace-cancel';
const choiceSchema = z.object({ picks: z.array(z.string()).min(1) });
let app: Hono;

function post(body: unknown) {
  return app.request('/api/operator/conversations/c1/run-cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /run-cancel', () => {
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

  it('401 without session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await post({ runId: 'r1', workspaceId: ws });
    expect(res.status).toBe(401);
  });

  it('400 on invalid body', async () => {
    expect((await post({ runId: '', workspaceId: ws })).status).toBe(400);
  });

  it('404 when runId not present in the claimed workspace', async () => {
    const res = await post({ runId: 'unknown-run', workspaceId: ws });
    expect(res.status).toBe(404);
  });

  it('cancels every pending card under the run; deferreds resolve with action:cancel', async () => {
    openRun({ workspaceId: ws, runId: 'r-multi' });
    const a = registerCard({
      workspaceId: ws, runId: 'r-multi',
      spec: { prompt: 'a', dataSchema: choiceSchema },
    });
    const b = registerCard({
      workspaceId: ws, runId: 'r-multi',
      spec: { prompt: 'b', dataSchema: choiceSchema },
    });
    openRun({ workspaceId: ws, runId: 'r-other' });
    const c = registerCard({
      workspaceId: ws, runId: 'r-other',
      spec: { prompt: 'c', dataSchema: choiceSchema },
    });

    const res = await post({ runId: 'r-multi', workspaceId: ws });
    expect(res.status).toBe(200);
    expect(await a.result).toEqual({ action: 'cancel' });
    expect(await b.result).toEqual({ action: 'cancel' });
    let cResolved = false;
    void c.result.then(() => { cResolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(cResolved).toBe(false);
  });

  it('cross-workspace runId returns 404 (defense-in-depth)', async () => {
    openRun({ workspaceId: ws, runId: 'r-x' });
    registerCard({
      workspaceId: ws, runId: 'r-x',
      spec: { prompt: 'x', dataSchema: choiceSchema },
    });
    const res = await post({ runId: 'r-x', workspaceId: 'other-ws' });
    expect(res.status).toBe(404);
  });
});
