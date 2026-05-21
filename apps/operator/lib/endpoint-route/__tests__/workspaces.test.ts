/**
 * Verification for the ported `workspaces` family. Focused on the
 * audit6 invariant carried over from app/api/workspaces/switch/route.test.ts:
 * dispatchWorkspaceSwitch must fire with the LEAVING workspaceId, not
 * the new one — otherwise replay buffers / card-correlator PENDING /
 * state-channel snapshots leak across the switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Spread the real module — route files import `defineTool` from here
// (the unified endpoint primitive), so a full-replacement mock would
// leave `defineTool` undefined. Override only `dispatchWorkspaceSwitch`.
vi.mock('@papercusp/agent-mcp', async (orig) => ({
  ...(await orig<typeof import('@papercusp/agent-mcp')>()),
  dispatchWorkspaceSwitch: vi.fn(async () => {}),
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(async () => {}),
    },
  };
});
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { dispatchWorkspaceSwitch } from '@papercusp/agent-mcp';
import { promises as fs } from 'node:fs';

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import workspaceSwitch from '../routes/workspaces/switch';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const post = (body: object) => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

describe('POST /workspaces/switch — audit6 invariant', () => {
  beforeEach(() => {
    vi.mocked(dispatchWorkspaceSwitch).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockReset().mockResolvedValue(
      JSON.stringify({
        current: 'ws-old',
        workspaces: [
          { id: 'ws-old', name: 'Old', createdAt: 1 },
          { id: 'ws-new', name: 'New', createdAt: 2 },
        ],
      }),
    );
    vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.mocked(dispatchWorkspaceSwitch).mockReset());

  it('dispatchWorkspaceSwitch fires with LEAVING workspaceId, not new one', async () => {
    const res = await appWith(workspaceSwitch as AnyRoute).request('/workspaces/switch', post({ id: 'ws-new' }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatchWorkspaceSwitch).toHaveBeenCalledWith('ws-old');
    expect(dispatchWorkspaceSwitch).not.toHaveBeenCalledWith('ws-new');
  });

  it('alreadyCurrent: dispatchWorkspaceSwitch is NOT called', async () => {
    const res = await appWith(workspaceSwitch as AnyRoute).request('/workspaces/switch', post({ id: 'ws-old' }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatchWorkspaceSwitch).not.toHaveBeenCalled();
  });

  it('invalid id: 400 + no dispatch', async () => {
    const res = await appWith(workspaceSwitch as AnyRoute).request('/workspaces/switch', post({ id: '' }));
    expect(res.status).toBe(400);
    expect(dispatchWorkspaceSwitch).not.toHaveBeenCalled();
  });

  it('dispatch failure does NOT fail the switch (fire-and-forget)', async () => {
    vi.mocked(dispatchWorkspaceSwitch).mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await appWith(workspaceSwitch as AnyRoute).request('/workspaces/switch', post({ id: 'ws-new' }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
