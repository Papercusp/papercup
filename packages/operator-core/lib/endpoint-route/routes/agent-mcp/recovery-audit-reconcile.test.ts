import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const sql = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => []);
Object.assign(sql, {
  begin: vi.fn(async (run: (tx: typeof sql) => unknown) => run(sql)),
});
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../superuser-token', () => ({
  isLoopbackRequest: (headers: Headers) => (headers.get('host') ?? '').startsWith('127.0.0.1'),
  isValidSuperuserBearer: (token: string | null) => token === 'owner-token',
}));
vi.mock('../../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../../define-route';
import route, { recoveryAuditRowId } from './recovery-audit-reconcile';

function app() {
  const h = new Hono();
  registerRoute(h, route);
  return h;
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    eventId: '11111111-1111-4111-8111-111111111111',
    event: 'execution-finished',
    at: '2026-09-13T20:00:00.000Z',
    atMs: Date.parse('2026-09-13T20:00:00.000Z'),
    grantId: '22222222-2222-4222-8222-222222222222',
    capability: 'diagnostic-command',
    identity: { uid: 1000, username: 'avi', hostname: 'workstation' },
    client: { name: 'psu', version: '1.2.3' },
    reason: 'operator endpoint unavailable',
    command: { argv: ['/usr/bin/printf', '%s', 'offline-ok'], cwd: '/tmp' },
    outcome: { exitCode: 0, signal: null, timedOut: false },
    ...overrides,
  };
}

const request = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: {
    host: '127.0.0.1:3070',
    authorization: 'Bearer owner-token',
    'content-type': 'application/json',
    ...headers,
  },
  body: JSON.stringify(body),
});

beforeEach(() => sql.mockClear());

describe('recovery audit reconciliation route', () => {
  it('requires both loopback and the existing owner bearer', async () => {
    expect((await app().request('/agent-mcp/recovery-audit/reconcile', request({ events: [event()] }, {
      authorization: 'Bearer wrong',
    }))).status).toBe(403);
    expect((await app().request('http://remote.example/agent-mcp/recovery-audit/reconcile', request({ events: [event()] }, {
      host: 'remote.example',
    }))).status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects malformed, unbounded and timestamp-substituted evidence', async () => {
    for (const body of [
      { events: [] },
      { events: [event({ event: 'made-up' })] },
      { events: [event({ atMs: Date.parse('2026-09-13T21:00:00.000Z') })] },
      { events: Array.from({ length: 101 }, () => event()) },
    ]) {
      const res = await app().request('/agent-mcp/recovery-audit/reconcile', request(body));
      expect(res.status).toBe(400);
    }
    expect(sql).not.toHaveBeenCalled();
  });

  it('writes deterministic idempotency ids into the canonical audit_log', async () => {
    const first = event();
    const second = event({
      eventId: '33333333-3333-4333-8333-333333333333',
      event: 'execution-refused',
      command: { argv: [], cwd: '' },
      outcome: { refusalReason: 'expired' },
    });
    const res = await app().request('/agent-mcp/recovery-audit/reconcile', request({ events: [first, second] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      reconciledEventIds: [first.eventId, second.eventId],
    });
    expect(sql).toHaveBeenCalledTimes(2);
    const text = sql.mock.calls.map(([strings]) => strings.join('?')).join('\n');
    expect(text).toContain('INSERT INTO harness_shared.audit_log');
    expect(text).toContain('ON CONFLICT (id) DO NOTHING');
    expect(recoveryAuditRowId(first.eventId)).toBe(`psu-recovery:${first.eventId}`);
  });
});
