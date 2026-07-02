/**
 * Unit tests for POST /api/agent-mcp/console/record
 * (windows-desktop-feature-parity-2026-07-02 P-014).
 *
 * Covers: the happy path records a plain adv_sessions row from the fields the
 * Tauri `console_launch` fallback can actually supply; a missing `cwd` 400s;
 * and — the load-bearing case — a caller-supplied `pid` is never forwarded to
 * `recordAdvSession`, even when a caller tries to smuggle one in (the
 * WSL-namespace-poisoning trap this route exists to close off).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';

const recordAdvSessionMock = vi.fn(async (_o: unknown) => 42 as number | null);

vi.mock('../../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../../../adv-sessions', () => ({ recordAdvSession: recordAdvSessionMock }));

const CTX: RouteContext = { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };

async function callPost(body: unknown): Promise<Response> {
  const mod = await import('./console-record');
  const post = (mod.default as unknown as { method: string; handler: (r: Request, c: RouteContext) => Promise<Response> });
  const req = new Request('http://localhost:3070/api/agent-mcp/console/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return post.handler(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAdvSessionMock.mockResolvedValue(42);
});

describe('POST /api/agent-mcp/console/record', () => {
  it('records a console-mode adv_sessions row from cwd/terminalBin/label/planSlug', async () => {
    const res = await callPost({
      cwd: '/home/avi/papercup',
      terminalBin: 'wt.exe',
      label: 'my session',
      planSlug: 'some-plan',
      launchArgv: ['wt.exe', 'psu'],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ok', id: 42 });
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'default',
        mode: 'console',
        cwd: '/home/avi/papercup',
        terminalBin: 'wt.exe',
        label: 'my session',
        planSlug: 'some-plan',
        launchArgv: ['wt.exe', 'psu'],
      }),
    );
  });

  it('400s when cwd is missing (nothing to record)', async () => {
    const res = await callPost({ terminalBin: 'wt.exe' });
    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('defaults optional fields to null / [] shape when omitted', async () => {
    await callPost({ cwd: '/home/avi/papercup' });
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/home/avi/papercup',
        terminalBin: null,
        label: null,
        planSlug: null,
        launchArgv: null,
      }),
    );
  });

  it('NEVER forwards a caller-supplied pid — the WSL-namespace-poisoning trap this route exists to close', async () => {
    // A Windows-side wt.exe/wsl.exe pid smuggled in via the request body must
    // never reach adv_sessions.pid: it lives in a different pid namespace than
    // the WSL-hosted operator that later `process.kill(pid, 0)`s it.
    await callPost({ cwd: '/home/avi/papercup', pid: 123456 });
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);
    const call = recordAdvSessionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.pid).toBeUndefined();
  });
});
