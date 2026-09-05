/**
 * POST /api/admin/tasks/kill — the write half of the Task Manager pane
 * (task-manager-no-escape-2026-07-27 P-023/P-024/P-025).
 *
 * This route reverses a posture the file it lives in used to state outright ("a
 * dashboard fetch must not be able to kill anything"), on an owner ask, so the things
 * worth pinning are the ones that make the reversal safe rather than merely working:
 *
 *   - a CROSS-ORIGIN browser POST is refused at the edge, before anything is signalled
 *     (this is the backstop that pays for widening past the VT gate its sibling GET
 *     uses — the widening is forced by the cookie-less desktop webview, EI-338);
 *   - the request body can express a `taskId` and NOTHING ELSE — no pid, no name, no
 *     pattern — so the route cannot become the `pkill -f` that has twice killed the
 *     owner's live desktop here;
 *   - a REFUSAL comes back as a 200 with the reason intact. `identity_mismatch` is the
 *     safety rail working; returning it as a 4xx/5xx would present the rail as a fault
 *     and hide the detail the UI is required to show verbatim;
 *   - the flag failing CLOSED, and the inventory GET keeping its own (different) gate.
 *
 * Harness mirrors process-control-routes.test.ts: registerRoute → throwaway Hono app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const killTask = vi.fn(async (taskId: string) => ({
  ok: true as const,
  taskId,
  action: 'kill',
  detail: `scope pc-${taskId}.scope signalled SIGTERM`,
}));
const enabled = vi.fn(async () => true);
const notify = vi.fn(async () => {});

// A trust-gated route resolves a principal before the handler runs; the mocked
// trusted one stands in for the real gate, exactly as admin.test.ts does. The CSRF
// backstop under test runs INSIDE the handler and is unaffected by it.
vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'system', slug: 'system:operator', workspaceId: 'ws',
    authMethod: 'superuser-bearer', trust: 'trusted',
    capabilities: new Set(['*']), label: 'su',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
  },
}));
vi.mock('../../task-manager/control', () => ({ killTask: (...a: unknown[]) => killTask(...(a as [string])) }));
vi.mock('../../task-manager/enabled', () => ({ isTaskManagerEnabled: () => enabled() }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: (...a: unknown[]) => notify(...(a as [])) }));
vi.mock('../../task-manager/inventory', () => ({
  getTaskInventory: async () => ({ enabled: true, rows: [] }),
  disabledInventory: () => ({ enabled: false, rows: [] }),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import taskManagerRoutes from '../routes/admin/task-manager';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [inventory, kill] = taskManagerRoutes as unknown as AnyRoute[];

async function post(url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const app = new Hono();
  registerRoute(app, kill);
  return await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const LOOPBACK = 'http://127.0.0.1:3070/admin/tasks/kill';

beforeEach(() => {
  enabled.mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('the route pair', () => {
  it('still exports the read route, and the two carry DIFFERENT gates on purpose', () => {
    expect(inventory.method).toBe('GET');
    expect(kill.method).toBe('POST');
    expect(kill.path).toBe('/admin/tasks/kill');
    // The read is VT-gated; the write additionally admits `unverified-loopback`,
    // because a bare fetch from the packaged desktop webview carries no cookie or
    // bearer and resolves to exactly that — under VT the control would 403 on the one
    // surface it was asked for (EI-338 / WI-6475). The CSRF backstop below is what
    // pays for the widening.
    expect(kill.auth).toEqual({ trust: ['verified', 'trusted', 'unverified-loopback'] });
    expect(inventory.auth).toEqual({ trust: ['verified', 'trusted'] });
  });
});

describe('the CSRF edge', () => {
  it('403s a cross-origin browser POST BEFORE anything is signalled', async () => {
    const res = await post(LOOPBACK, { taskId: 't1' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    // route-stack's errorResponse envelope: { error: { code, message } }.
    expect(await res.json()).toMatchObject({ error: { code: 'cross_origin_blocked' } });
    expect(killTask).not.toHaveBeenCalled();
  });

  it('refuses cross-origin BEFORE reading the feature flag — no probing what is on', async () => {
    await post(LOOPBACK, { taskId: 't1' }, { origin: 'https://evil.example' });
    expect(enabled).not.toHaveBeenCalled();
  });

  it('admits a request with no Origin at all (curl, the SU bearer, the webview)', async () => {
    const res = await post(LOOPBACK, { taskId: 't1' });
    expect(res.status).toBe(200);
  });
});

describe('what the body can say', () => {
  it('kills by taskId and passes NOTHING ELSE through to the killer', async () => {
    const res = await post(LOOPBACK, { taskId: 'tsk_abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, taskId: 'tsk_abc' });
    expect(killTask).toHaveBeenCalledWith('tsk_abc', expect.anything());
  });

  it('ignores a pid / name / pattern smuggled into the body', async () => {
    // The point is not that these are rejected — it is that they are UNREACHABLE.
    // `killTask` takes a taskId, so there is no code path from any of these to a signal.
    await post(LOOPBACK, { taskId: 't1', pid: 4242, name: 'node', pattern: 'papercup' });
    expect(killTask).toHaveBeenCalledWith('t1', expect.anything());
    const [, opts] = killTask.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts).not.toHaveProperty('pid');
    expect(opts).not.toHaveProperty('name');
  });

  it('400s a missing or blank taskId rather than guessing', async () => {
    for (const body of [{}, { taskId: '' }, { taskId: '   ' }, { taskId: 42 }]) {
      const res = await post(LOOPBACK, body);
      expect(res.status).toBe(400);
    }
    expect(killTask).not.toHaveBeenCalled();
  });

  it('clamps escalateAfterMs instead of letting a caller pin the request open', async () => {
    await post(LOOPBACK, { taskId: 't1', escalateAfterMs: 999_999 });
    const [, opts] = killTask.mock.calls[0] as unknown as [string, { escalateAfterMs: number }];
    expect(opts.escalateAfterMs).toBeLessThanOrEqual(10_000);
  });
});

describe('a refusal is a RESULT, not a transport failure', () => {
  it('returns identity_mismatch as 200 with the detail intact', async () => {
    killTask.mockResolvedValueOnce({
      ok: false,
      taskId: 't1',
      action: 'kill',
      error: 'identity_mismatch',
      detail: 'pid 4242 now holds identity 991:44, row recorded 812:17 — refusing to signal a recycled pid',
    } as unknown as Awaited<ReturnType<typeof killTask>>);
    const res = await post(LOOPBACK, { taskId: 't1' });
    // 200: the rail WORKED. A 5xx here would read as "the pane is broken, try again",
    // and trying again is the one response that is actually dangerous.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string; detail: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('identity_mismatch');
    expect(body.detail).toContain('row recorded 812:17');
  });
});

describe('the feature flag', () => {
  it('refuses while the task manager is switched off', async () => {
    enabled.mockResolvedValue(false);
    const res = await post(LOOPBACK, { taskId: 't1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'disabled' });
    expect(killTask).not.toHaveBeenCalled();
  });
});

describe('the panes are told', () => {
  it('invalidates taskManager.inventory so a killed row does not linger as running', async () => {
    await post(LOOPBACK, { taskId: 't1' });
    expect(notify).toHaveBeenCalled();
  });
});
