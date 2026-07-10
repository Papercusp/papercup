/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-su/heartbeat
 * (WI-3898 P1 — coord:presence liveness parity).
 *
 * The route forwards an optional caller-reported { pid, host } to
 * touchHeartbeat so a same-machine reader can later verify liveness via a
 * local kill(pid, 0) probe (presence.ts's probeProcessLiveness). This pins
 * the request-body parsing + forwarding contract: valid pid/host are passed
 * through, invalid/missing ones are dropped rather than failing the beat.
 *
 * Mirrors bootstrap-su-launch-argv.test.ts's minimal mock set so importing
 * the route module doesn't reach for @papercusp/db-org.
 */
import { describe, expect, it, vi } from 'vitest';

// bootstrap-su.ts is a large module with many real (unmocked) sibling imports —
// only the couple this route actually touches (auth, adv-sessions, presence)
// are mocked below, so the FIRST dynamic `import('./bootstrap-su')` pays a
// real transform/import cost north of the 5s default (bootstrap-su.test.ts
// avoids this by mocking ~20 sibling modules; not worth duplicating that
// weight here for a 5-test route file).
vi.setConfig({ testTimeout: 15_000 });

vi.mock('../../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../../adv-sessions', () => ({
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  reactivateAdvSession: vi.fn(async () => false),
}));

const touchHeartbeatMock = vi.fn(async () => {});
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: touchHeartbeatMock,
}));

async function postHeartbeat(body: unknown): Promise<Response> {
  const mod = await import('./bootstrap-su');
  const routes = mod.default as { method: string; path: string; handler: (req: Request) => Promise<Response> }[];
  const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/heartbeat'))!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.handler(req);
}

describe('POST bootstrap-su/heartbeat — pid/host forwarding (WI-3898 P1)', () => {
  it('forwards a valid pid + host to touchHeartbeat as { pid, host }', async () => {
    touchHeartbeatMock.mockClear();
    const res = await postHeartbeat({ ownerId: 'su-abc', pid: 4242, host: 'box-a' });
    expect(res.status).toBe(200);
    expect(touchHeartbeatMock).toHaveBeenCalledWith('su-abc', { pid: 4242, host: 'box-a' });
  });

  it('passes undefined liveness (not an empty object) when neither pid nor host is given', async () => {
    touchHeartbeatMock.mockClear();
    await postHeartbeat({ ownerId: 'su-abc' });
    expect(touchHeartbeatMock).toHaveBeenCalledWith('su-abc', undefined);
  });

  it('drops a non-positive / non-integer pid rather than forwarding garbage', async () => {
    touchHeartbeatMock.mockClear();
    await postHeartbeat({ ownerId: 'su-abc', pid: -1, host: 'box-a' });
    expect(touchHeartbeatMock).toHaveBeenCalledWith('su-abc', { pid: undefined, host: 'box-a' });
    touchHeartbeatMock.mockClear();
    await postHeartbeat({ ownerId: 'su-abc', pid: 1.5, host: 'box-a' });
    expect(touchHeartbeatMock).toHaveBeenCalledWith('su-abc', { pid: undefined, host: 'box-a' });
    touchHeartbeatMock.mockClear();
    await postHeartbeat({ ownerId: 'su-abc', pid: 'not-a-number', host: 'box-a' });
    expect(touchHeartbeatMock).toHaveBeenCalledWith('su-abc', { pid: undefined, host: 'box-a' });
  });

  it('drops a blank or oversized host rather than forwarding it', async () => {
    touchHeartbeatMock.mockClear();
    await postHeartbeat({ ownerId: 'su-abc', pid: 42, host: '   ' });
    expect(touchHeartbeatMock).toHaveBeenCalledWith('su-abc', { pid: 42, host: undefined });
    touchHeartbeatMock.mockClear();
    await postHeartbeat({ ownerId: 'su-abc', pid: 42, host: 'x'.repeat(300) });
    expect(touchHeartbeatMock).toHaveBeenCalledWith('su-abc', { pid: 42, host: undefined });
  });

  it('still 400s on a missing ownerId regardless of pid/host', async () => {
    touchHeartbeatMock.mockClear();
    const res = await postHeartbeat({ pid: 42, host: 'box-a' });
    expect(res.status).toBe(400);
    expect(touchHeartbeatMock).not.toHaveBeenCalled();
  });
});
