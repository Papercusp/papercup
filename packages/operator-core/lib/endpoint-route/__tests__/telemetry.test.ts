/**
 * route-invocation telemetry — sampling gate + fire-and-forget safety.
 *
 * The PG write is fire-and-forget (racy to assert directly); these tests
 * cover the synchronous, deterministic surface: the sampleRate gate and
 * that `recordRouteInvocation` never throws into the route-stack's
 * `finally`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

let unsafeCalls: Array<{ sql: string; params: unknown[] }> = [];
const sqlBegin = vi.fn(async (fn: (tx: { unsafe: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>) => {
  await fn({
    unsafe: async (sql: string, params?: unknown[]) => {
      unsafeCalls.push({ sql, params: params ?? [] });
    },
  });
});
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

function execWith(
  over: Partial<RouteDefinition> & { status?: RouteExecution['status']; url?: string; responseBytes?: number | null } = {},
): RouteExecution {
  const { status, url, responseBytes, ...defOver } = over;
  return {
    def: {
      method: 'GET',
      path: '/x',
      auth: 'public',
      handler: () => new Response(),
      ...defOver,
    } as RouteDefinition,
    hono: {} as never,
    req: new Request(url ?? 'http://x/x'),
    startedAt: Date.now() - 5,
    principal: null,
    input: undefined,
    abort: new AbortController(),
    timeoutTimer: null,
    status: status ?? 'ok',
    responseBytes: responseBytes ?? null,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  unsafeCalls = [];
});

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

/** recordRouteInvocation's tx runs TWO tx.unsafe calls per write (a
 *  set_config, then the INSERT) — isolate the INSERT for assertions. */
function findInsertCall(): { sql: string; params: unknown[] } {
  const found = unsafeCalls.find((c) => c.sql.includes('INSERT INTO harness_shared.route_invocations'));
  if (!found) throw new Error(`no INSERT call captured among ${unsafeCalls.length} tx.unsafe call(s)`);
  return found;
}

describe('recordRouteInvocation — resolved path + response bytes (EI-7069)', () => {
  it('records the RESOLVED request path, distinct from the route TEMPLATE', async () => {
    recordRouteInvocation(
      execWith({ path: '/admin/plans/:verb', url: 'http://x/admin/plans/attention?tier=trimmed' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const { sql: insertSql, params } = findInsertCall();
    expect(insertSql).toContain('resolved_path');
    // template path stays $3 (path), resolved path is the new $10 slot.
    expect(params).toContain('/admin/plans/:verb');
    expect(params).toContain('/admin/plans/attention');
  });

  it('an unparseable request URL degrades resolved_path to null rather than throwing', async () => {
    const exec = execWith();
    // Force an unparseable URL onto the already-built Request-backed exec.
    Object.defineProperty(exec.req, 'url', { value: 'not a url', configurable: true });
    expect(() => recordRouteInvocation(exec)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    const { params } = findInsertCall();
    expect(params).toContain(null);
  });

  it('records response_bytes when the orchestrator set it (Content-Length present)', async () => {
    recordRouteInvocation(execWith({ responseBytes: 1234 }));
    await new Promise((r) => setTimeout(r, 0));
    const { params } = findInsertCall();
    expect(params).toContain(1234);
  });

  it('response_bytes stays null for a streaming response (no Content-Length)', async () => {
    recordRouteInvocation(execWith({ responseBytes: null }));
    await new Promise((r) => setTimeout(r, 0));
    const { params } = findInsertCall();
    // response_bytes is the last bound param; assert it's specifically null,
    // not just "params contains null somewhere" (principal fields are also null here).
    expect(params[params.length - 1]).toBeNull();
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
