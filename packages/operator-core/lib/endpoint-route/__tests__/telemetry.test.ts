/**
 * route-invocation telemetry — sampling gate + fire-and-forget safety.
 *
 * The PG write is fire-and-forget (racy to assert directly); these tests
 * cover the synchronous, deterministic surface: the sampleRate gate and
 * that `recordRouteInvocation` never throws into the route-stack's
 * `finally`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sqlBegin = vi.fn(async () => {});
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: vi.fn(() => ({ sql: { begin: sqlBegin } })),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));

import { recordRouteInvocation } from '../telemetry';
import { getOrgPg } from '@papercusp/db-org';
import type { RouteExecution } from '../route-stack';
import type { RouteDefinition } from '../define-route';

function execWith(over: Partial<RouteDefinition> & { status?: RouteExecution['status'] } = {}): RouteExecution {
  const { status, ...defOver } = over;
  return {
    def: {
      method: 'GET',
      path: '/x',
      auth: 'public',
      handler: () => new Response(),
      ...defOver,
    } as RouteDefinition,
    hono: {} as never,
    req: new Request('http://x/x'),
    startedAt: Date.now() - 5,
    principal: null,
    input: undefined,
    abort: new AbortController(),
    timeoutTimer: null,
    status: status ?? 'ok',
  };
}

afterEach(() => vi.clearAllMocks());

describe('recordRouteInvocation — sampling gate', () => {
  it('sampleRate 0 → never touches PG', () => {
    recordRouteInvocation(execWith({ sampleRate: 0 }));
    expect(getOrgPg).not.toHaveBeenCalled();
  });

  it('sampleRate 1 (default) → attempts the write', async () => {
    recordRouteInvocation(execWith());
    // Fire-and-forget — let the microtask run.
    await new Promise((r) => setTimeout(r, 0));
    expect(getOrgPg).toHaveBeenCalled();
  });

  it('sampleRate 1 explicit → attempts the write', async () => {
    recordRouteInvocation(execWith({ sampleRate: 1 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(getOrgPg).toHaveBeenCalled();
  });

  it('never throws synchronously, whatever the status', () => {
    for (const status of ['ok', 'error', 'timeout', 'unauthorized'] as const) {
      expect(() => recordRouteInvocation(execWith({ status }))).not.toThrow();
    }
  });
});

describe('recordRouteInvocation — degraded environments (gate hold 2026-06-10)', () => {
  it('partial db-org mock (no sql.begin) → silent no-op, no write, no warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getOrgPg).mockReturnValueOnce({} as never);
    recordRouteInvocation(execWith());
    await new Promise((r) => setTimeout(r, 0));
    expect(sqlBegin).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Keep LAST: trips the module-level once-flag for the rest of the process.
  it('repeated write failures warn exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlBegin.mockImplementation(async () => {
      throw new Error('relation "route_invocations" does not exist');
    });
    recordRouteInvocation(execWith());
    recordRouteInvocation(execWith());
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[route-telemetry] write failed');
    sqlBegin.mockImplementation(async () => {});
    warn.mockRestore();
  });
});
