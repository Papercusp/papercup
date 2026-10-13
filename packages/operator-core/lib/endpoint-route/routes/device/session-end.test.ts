import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ allowed: true, target: true, ended: false, raw: {} as Record<string, unknown>,
  end: vi.fn(), audit: vi.fn(), state: 'ended' as string | null }));
vi.mock('@papercusp/agent-mcp', async original => ({ ...(await original<typeof import('@papercusp/agent-mcp')>()), defineTool: (d: unknown) => d }));
vi.mock('../../../owner-sessions/actions', () => ({ endOwnerSession: (...args: unknown[]) => f.end(...args), adminToolResultJson: (result: { parsed: unknown }) => result.parsed }));
vi.mock('../../../owner-sessions/device-authority', () => ({ requireDeviceAgentSessions: async () => f.allowed ? null : Response.json({ error: 'agent_sessions_not_granted' }, { status: 403 }) }));
vi.mock('./sessions', () => ({ resolveDeviceSessionOwner: async () => f.target
  ? { ok: true, row: { state: f.ended ? 'ended' : 'parked' } }
  : { ok: false, response: Response.json({ error: 'session_not_in_workspace' }, { status: 404 }) } }));
vi.mock('../../../owner-sessions/roster', () => ({ readSessionRosterSnapshot: async () => ({ active: [f.raw], starting: [], pending: [] }) }));
vi.mock('../../../agent-tools/coordination/liveness-oracle', () => ({ resolveSessionStates: async () => new Map([['su-target', { sessionState: f.state }]]) }));
vi.mock('../../../owner-sessions/device-actions', async original => ({
  ...(await original<typeof import('../../../owner-sessions/device-actions')>()),
  auditDeviceAction: (...args: unknown[]) => f.audit(...args),
  runDeviceAction: async (_context: unknown, _key: string, _request: unknown, run: () => unknown) => run(),
}));
import routes from './session-end';
import { isPhoneDevicePath } from '../../../device-ingress-paths';
const call = async (body: unknown = {}) => {
  const response = await routes[0].handler(new Request('http://localhost/api/device/sessions/su-target/end',
    { method: 'POST', body: JSON.stringify(body) }), { principal: { kind: 'device', slug: 'phone-a', workspaceId: 'workspace-a' }, params: { owner: 'su-target' } } as never) as Response;
  return { status: response.status, body: await response.json() };
};
beforeEach(() => {
  f.allowed = true; f.target = true; f.ended = false; f.state = 'ended';
  f.raw = { ownerId: 'su-target', role: 'su', nativeSession: { backend: 'codex' } };
  f.end.mockReset().mockResolvedValue({ status: 200, parsed: { ok: true, results: [{ ok: true }] } });
  f.audit.mockReset().mockImplementation(async (_context, reply) => reply);
});
describe('paired-device end session', () => {
  it('uses desktop Stop agent and reports the post-action shared oracle', async () => {
    expect(await call()).toEqual({ status: 200, body: { ok: true, state: 'ended' } });
    expect(f.end).toHaveBeenCalledWith({ workspaceId: 'workspace-a', ownerId: 'su-target', reason: 'Owner ended session from paired device phone-a' });
  });
  it('keeps an unavailable oracle verdict unknown', async () => {
    f.state = null;
    expect((await call()).body.state).toBeNull();
  });
  it('makes an already-ended repeat harmless', async () => {
    f.ended = true;
    expect(await call()).toEqual({ status: 200, body: { ok: true, state: 'ended', alreadyEnded: true } });
    expect(f.end).not.toHaveBeenCalled();
  });
  it.each(['routine-host', 'git-sync', 'green-checkpoint', 'human', 'system'])('refuses protected role %s before a kill', async role => {
    f.raw = { ...f.raw, role };
    expect((await call()).status).toBe(403);
    expect(f.end).not.toHaveBeenCalled();
  });
  it('refuses a target absent from this workspace', async () => {
    f.target = false;
    expect((await call()).status).toBe(404);
    expect(f.end).not.toHaveBeenCalled();
  });
  it('audits a missing grant without calling the kill handler', async () => {
    f.allowed = false;
    expect((await call()).status).toBe(403);
    expect(f.audit).toHaveBeenCalledTimes(1);
    expect(f.end).not.toHaveBeenCalled();
  });
  it('reports a refused kill instead of claiming the session ended', async () => {
    f.end.mockResolvedValue({ status: 200, parsed: { ok: false, results: [{ ok: false }] } });
    expect((await call()).status).toBe(502);
  });
  it('does not treat an unparseable kill receipt as confirmed success', async () => {
    f.end.mockResolvedValue({ status: 200, parsed: undefined });
    expect((await call()).status).toBe(502);
  });
  it('exposes only the exact end path through phone ingress', () => {
    expect(isPhoneDevicePath('/api/device/sessions/su-target/end')).toBe(true);
    expect(isPhoneDevicePath('/api/device/sessions/../end')).toBe(false);
  });
});
