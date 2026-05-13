/**
 * /api/workspaces/switch — verifies the audit6 H4 dispatch wiring.
 *
 * Audit6 found that dispatchWorkspaceSwitch was never called from
 * production code despite being implemented + tested in the bespoke-
 * card-improvements arc. The /api/workspaces/switch route is now
 * the single production caller — verifies the leaving workspaceId
 * is passed (NOT the new one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
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

import { dispatchWorkspaceSwitch } from '@papercusp/agent-mcp';
import { promises as fs } from 'node:fs';

import { POST } from './route';

function makeReq(body: object): Request {
  return new Request('http://localhost/api/workspaces/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/workspaces/switch', () => {
  beforeEach(() => {
    vi.mocked(dispatchWorkspaceSwitch).mockReset();
    vi.mocked(dispatchWorkspaceSwitch).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.writeFile).mockReset();
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        current: 'ws-old',
        workspaces: [
          { id: 'ws-old', name: 'Old', createdAt: 1 },
          { id: 'ws-new', name: 'New', createdAt: 2 },
        ],
      }),
    );
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.mocked(dispatchWorkspaceSwitch).mockReset();
  });

  it('audit6: dispatchWorkspaceSwitch is called with the LEAVING workspaceId, not the new one', async () => {
    const res = await POST(makeReq({ id: 'ws-new' }));
    expect(res.status).toBe(200);
    // Need a microtask for the fire-and-forget dispatch.
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatchWorkspaceSwitch).toHaveBeenCalledWith('ws-old');
    expect(dispatchWorkspaceSwitch).not.toHaveBeenCalledWith('ws-new');
  });

  it('alreadyCurrent: dispatchWorkspaceSwitch is NOT called', async () => {
    const res = await POST(makeReq({ id: 'ws-old' }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatchWorkspaceSwitch).not.toHaveBeenCalled();
  });

  it('invalid id: 400 + no dispatch', async () => {
    const res = await POST(makeReq({ id: '' }));
    expect(res.status).toBe(400);
    expect(dispatchWorkspaceSwitch).not.toHaveBeenCalled();
  });

  it('dispatch failure does NOT fail the switch (fire-and-forget)', async () => {
    vi.mocked(dispatchWorkspaceSwitch).mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(makeReq({ id: 'ws-new' }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
