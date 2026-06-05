/**
 * tui-routes.test.ts — BRIEF-test-coverage-fu-tui-routes (follow-up to
 * BRIEF-test-coverage-2026-06-04).
 *
 * The tui-workbench store layer (`tui-workbench-store.ts`) is well covered by
 * integration tests against real PG, but the HTTP-route layer
 * (`endpoint-route/routes/tui/*`) had a clean hole: none of the handlers'
 * input-validation, 404, or response-envelope logic was tested. This file
 * fills it by driving each route handler directly with a crafted `Request` +
 * a hand-built `RouteContext` (the DB-free pattern from
 * `device-routes.test.ts`), with the store + org-PG collaborators mocked.
 *
 * Coverage:
 *   • layoutPut/crewPut/viewStatePut — owner/name required → 400, kdl_required
 *     (missing / empty / non-string) → 400, malformed-JSON body tolerated
 *     (graceful 400, not 500), `state` `{}` fallback, `members` `[]` coercion.
 *   • layoutGet/crewGet — 404 on absent.
 *   • layoutDelete/crewDelete — the `{ ok, deleted: boolean }` envelope; delete
 *     is idempotent (absent → `deleted:false`, NOT an HTTP 404 — verified
 *     against source, which is why this differs from the GET 404s).
 *   • intent-result / intents-stream — these gate via `isLoopbackRequest`
 *     (from `superuser-token`), a DIFFERENT helper than the
 *     `requireLoopbackOr403`/`isLoopbackHost` that `loopback-guard.test.ts`
 *     covers, so their loopback gating is not transitively covered elsewhere.
 *     Asserted directly: a non-loopback request is rejected (403), and a
 *     loopback request passes the gate (reaching the input-validation +
 *     DB-dispatch logic).
 *
 * The `/tui/*` auth-posture (every route is `auth:'public'`, mirroring the
 * sibling `/api/coord/*` routes) is guarded in `auth-posture.test.ts` via a
 * `/tui/` prefix RULE — see the comment there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext, RouteDefinition } from '../define-route';

// ── Mocks ─────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted above imports, so the fn holders must be too.
const mocks = vi.hoisted(() => ({
  getViewState: vi.fn(),
  putViewState: vi.fn(),
  listLayouts: vi.fn(),
  getLayout: vi.fn(),
  putLayout: vi.fn(),
  deleteLayout: vi.fn(),
  listCrews: vi.fn(),
  getCrew: vi.fn(),
  putCrew: vi.fn(),
  deleteCrew: vi.fn(),
  /** tagged-template SQL stub for intent-result's UPDATE. */
  sql: vi.fn(),
}));

vi.mock('../../tui-workbench-store', () => ({
  getViewState: mocks.getViewState,
  putViewState: mocks.putViewState,
  listLayouts: mocks.listLayouts,
  getLayout: mocks.getLayout,
  putLayout: mocks.putLayout,
  deleteLayout: mocks.deleteLayout,
  listCrews: mocks.listCrews,
  getCrew: mocks.getCrew,
  putCrew: mocks.putCrew,
  deleteCrew: mocks.deleteCrew,
}));

// intent-result / intents-stream pull `getOrgPg` from db-org; stub only that so
// the DB-dispatch path is controllable without real PG. A partial mock
// (spreading the original) is required — agent-mcp's bootstrap, imported
// transitively via the tui route's `defineTool`, reads db-org's `generated`.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.sql }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>,
}));

import tuiRoutes from '../routes/tui/index';

// ── Harness ───────────────────────────────────────────────────────────────
type AnyRoute = RouteDefinition<never>;

function routeByPath(method: string, path: string): AnyRoute {
  const def = (tuiRoutes as AnyRoute[]).find((r) => r.method === method && r.path === path);
  if (!def) throw new Error(`no ${method} ${path} in routes/tui`);
  return def;
}

function ctx(params: Record<string, string> = {}): RouteContext<never> {
  return {
    principal: null,
    input: undefined as never,
    params,
    log: () => {},
    signal: new AbortController().signal,
  };
}

/** Build a request. `json` → JSON.stringify'd body; `raw` → verbatim body. */
function req(
  method: string,
  url: string,
  opts: { host?: string; json?: unknown; raw?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.host) headers.host = opts.host;
  let body: string | undefined;
  if (opts.raw !== undefined) {
    headers['content-type'] = 'application/json';
    body = opts.raw;
  } else if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  return new Request(url, { method, headers, body });
}

const BASE = 'http://t.test/api';
const jsonOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getViewState.mockResolvedValue({});
  mocks.putViewState.mockResolvedValue(undefined);
  mocks.listLayouts.mockResolvedValue([]);
  mocks.getLayout.mockResolvedValue(null);
  mocks.putLayout.mockResolvedValue(undefined);
  mocks.deleteLayout.mockResolvedValue(false);
  mocks.listCrews.mockResolvedValue([]);
  mocks.getCrew.mockResolvedValue(null);
  mocks.putCrew.mockResolvedValue(undefined);
  mocks.deleteCrew.mockResolvedValue(false);
  mocks.sql.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

// ── view_state ─────────────────────────────────────────────────────────────
describe('PUT /tui/view-state (viewStatePut)', () => {
  const def = () => routeByPath('PUT', '/tui/view-state');
  it('400 owner_required when owner is missing', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/view-state`, { json: { state: { a: 1 } } }), ctx());
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(/^owner_required/);
    expect(mocks.putViewState).not.toHaveBeenCalled();
  });
  it('blank owner (whitespace-only) is rejected', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/view-state`, { json: { owner: '   ' } }), ctx());
    expect(res.status).toBe(400);
    expect(mocks.putViewState).not.toHaveBeenCalled();
  });
  it('absent state falls back to {}', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/view-state`, { json: { owner: 'u1' } }), ctx());
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect(mocks.putViewState).toHaveBeenCalledWith('u1', {});
  });
  it('passes a provided state through', async () => {
    await def().handler(req('PUT', `${BASE}/tui/view-state`, { json: { owner: 'u1', state: { tab: 'x' } } }), ctx());
    expect(mocks.putViewState).toHaveBeenCalledWith('u1', { tab: 'x' });
  });
  it('tolerates a malformed-JSON body (graceful 400, not 500)', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/view-state`, { raw: 'not-json{' }), ctx());
    expect(res.status).toBe(400); // body → null → owner_required, NOT a thrown 500
    expect((await jsonOf(res)).error).toMatch(/^owner_required/);
    expect(mocks.putViewState).not.toHaveBeenCalled();
  });
});

describe('GET /tui/view-state (viewStateGet)', () => {
  const def = () => routeByPath('GET', '/tui/view-state');
  it('400 owner_required without ?owner', async () => {
    const res = await def().handler(req('GET', `${BASE}/tui/view-state`), ctx());
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(/^owner_required/);
  });
  it('returns { state } for a valid owner', async () => {
    mocks.getViewState.mockResolvedValue({ sidebar: 'open' });
    const res = await def().handler(req('GET', `${BASE}/tui/view-state?owner=u1`), ctx());
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ state: { sidebar: 'open' } });
    expect(mocks.getViewState).toHaveBeenCalledWith('u1');
  });
});

// ── layouts ─────────────────────────────────────────────────────────────────
describe('PUT /tui/layouts (layoutPut)', () => {
  const def = () => routeByPath('PUT', '/tui/layouts');
  it('400 owner_required when owner is missing', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/layouts`, { json: { name: 'l1', kdl: 'x' } }), ctx());
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(/^owner_required/);
    expect(mocks.putLayout).not.toHaveBeenCalled();
  });
  it('400 name_required when name is missing', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/layouts`, { json: { owner: 'u1', kdl: 'x' } }), ctx());
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'name_required' });
    expect(mocks.putLayout).not.toHaveBeenCalled();
  });
  it('400 kdl_required when kdl is missing', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/layouts`, { json: { owner: 'u1', name: 'l1' } }), ctx());
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'kdl_required' });
    expect(mocks.putLayout).not.toHaveBeenCalled();
  });
  it('400 kdl_required when kdl is an empty string', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/layouts`, { json: { owner: 'u1', name: 'l1', kdl: '' } }), ctx());
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'kdl_required' });
    expect(mocks.putLayout).not.toHaveBeenCalled();
  });
  it('400 kdl_required when kdl is not a string', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/layouts`, { json: { owner: 'u1', name: 'l1', kdl: 123 } }), ctx());
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'kdl_required' });
    expect(mocks.putLayout).not.toHaveBeenCalled();
  });
  it('upserts with description defaulted to null on valid input', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/layouts`, { json: { owner: 'u1', name: 'l1', kdl: 'layout {}' } }), ctx());
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect(mocks.putLayout).toHaveBeenCalledWith('u1', 'l1', 'layout {}', null);
  });
  it('passes a provided description through', async () => {
    await def().handler(req('PUT', `${BASE}/tui/layouts`, { json: { owner: 'u1', name: 'l1', kdl: 'k', description: 'desc' } }), ctx());
    expect(mocks.putLayout).toHaveBeenCalledWith('u1', 'l1', 'k', 'desc');
  });
  it('tolerates a malformed-JSON body (graceful 400, not 500)', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/layouts`, { raw: '{bad' }), ctx());
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(/^owner_required/);
    expect(mocks.putLayout).not.toHaveBeenCalled();
  });
});

describe('GET /tui/layouts (layoutsList)', () => {
  const def = () => routeByPath('GET', '/tui/layouts');
  it('400 owner_required without ?owner', async () => {
    const res = await def().handler(req('GET', `${BASE}/tui/layouts`), ctx());
    expect(res.status).toBe(400);
  });
  it('returns { layouts } for a valid owner', async () => {
    mocks.listLayouts.mockResolvedValue([{ name: 'l1', description: null, updated_at: 't' }]);
    const res = await def().handler(req('GET', `${BASE}/tui/layouts?owner=u1`), ctx());
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ layouts: [{ name: 'l1', description: null, updated_at: 't' }] });
    expect(mocks.listLayouts).toHaveBeenCalledWith('u1');
  });
});

describe('GET /tui/layouts/:name (layoutGet)', () => {
  const def = () => routeByPath('GET', '/tui/layouts/:name');
  it('400 owner_required without ?owner', async () => {
    const res = await def().handler(req('GET', `${BASE}/tui/layouts/l1`), ctx({ name: 'l1' }));
    expect(res.status).toBe(400);
  });
  it('404 when the layout is absent', async () => {
    mocks.getLayout.mockResolvedValue(null);
    const res = await def().handler(req('GET', `${BASE}/tui/layouts/nope?owner=u1`), ctx({ name: 'nope' }));
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ error: 'layout not found' });
    expect(mocks.getLayout).toHaveBeenCalledWith('u1', 'nope');
  });
  it('200 returns the row when present', async () => {
    const row = { name: 'l1', kdl: 'k', description: null, created_at: 'c', updated_at: 'u' };
    mocks.getLayout.mockResolvedValue(row);
    const res = await def().handler(req('GET', `${BASE}/tui/layouts/l1?owner=u1`), ctx({ name: 'l1' }));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual(row);
  });
});

describe('DELETE /tui/layouts/:name (layoutDelete)', () => {
  const def = () => routeByPath('DELETE', '/tui/layouts/:name');
  it('400 owner_required without ?owner', async () => {
    const res = await def().handler(req('DELETE', `${BASE}/tui/layouts/l1`), ctx({ name: 'l1' }));
    expect(res.status).toBe(400);
    expect(mocks.deleteLayout).not.toHaveBeenCalled();
  });
  it('{ ok:true, deleted:true } when a row was removed', async () => {
    mocks.deleteLayout.mockResolvedValue(true);
    const res = await def().handler(req('DELETE', `${BASE}/tui/layouts/l1?owner=u1`), ctx({ name: 'l1' }));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, deleted: true });
    expect(mocks.deleteLayout).toHaveBeenCalledWith('u1', 'l1');
  });
  it('idempotent: absent → { ok:true, deleted:false } (NOT a 404)', async () => {
    mocks.deleteLayout.mockResolvedValue(false);
    const res = await def().handler(req('DELETE', `${BASE}/tui/layouts/gone?owner=u1`), ctx({ name: 'gone' }));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, deleted: false });
  });
});

// ── crews ────────────────────────────────────────────────────────────────────
describe('PUT /tui/crews (crewPut)', () => {
  const def = () => routeByPath('PUT', '/tui/crews');
  it('400 owner_required when owner is missing', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/crews`, { json: { name: 'c1' } }), ctx());
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(/^owner_required/);
    expect(mocks.putCrew).not.toHaveBeenCalled();
  });
  it('400 name_required when name is missing', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/crews`, { json: { owner: 'u1' } }), ctx());
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'name_required' });
    expect(mocks.putCrew).not.toHaveBeenCalled();
  });
  it('coerces a non-array members to []', async () => {
    const res = await def().handler(
      req('PUT', `${BASE}/tui/crews`, { json: { owner: 'u1', name: 'c1', members: 'not-an-array' } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect(mocks.putCrew).toHaveBeenCalledWith('u1', 'c1', [], null, null);
  });
  it('passes members + layout_name + description through', async () => {
    const members = [{ slot: 0, agent: 'claude' }];
    await def().handler(
      req('PUT', `${BASE}/tui/crews`, { json: { owner: 'u1', name: 'c1', members, layout_name: 'l1', description: 'd' } }),
      ctx(),
    );
    expect(mocks.putCrew).toHaveBeenCalledWith('u1', 'c1', members, 'l1', 'd');
  });
  it('tolerates a malformed-JSON body (graceful 400, not 500)', async () => {
    const res = await def().handler(req('PUT', `${BASE}/tui/crews`, { raw: 'oops' }), ctx());
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatch(/^owner_required/);
    expect(mocks.putCrew).not.toHaveBeenCalled();
  });
});

describe('GET /tui/crews (crewsList)', () => {
  const def = () => routeByPath('GET', '/tui/crews');
  it('400 owner_required without ?owner', async () => {
    const res = await def().handler(req('GET', `${BASE}/tui/crews`), ctx());
    expect(res.status).toBe(400);
  });
  it('returns { crews } for a valid owner', async () => {
    mocks.listCrews.mockResolvedValue([{ name: 'c1', description: null, layout_name: null, member_count: 2, updated_at: 't' }]);
    const res = await def().handler(req('GET', `${BASE}/tui/crews?owner=u1`), ctx());
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).crews).toHaveLength(1);
    expect(mocks.listCrews).toHaveBeenCalledWith('u1');
  });
});

describe('GET /tui/crews/:name (crewGet)', () => {
  const def = () => routeByPath('GET', '/tui/crews/:name');
  it('400 owner_required without ?owner', async () => {
    const res = await def().handler(req('GET', `${BASE}/tui/crews/c1`), ctx({ name: 'c1' }));
    expect(res.status).toBe(400);
  });
  it('404 when the crew is absent', async () => {
    mocks.getCrew.mockResolvedValue(null);
    const res = await def().handler(req('GET', `${BASE}/tui/crews/nope?owner=u1`), ctx({ name: 'nope' }));
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ error: 'crew not found' });
    expect(mocks.getCrew).toHaveBeenCalledWith('u1', 'nope');
  });
  it('200 returns the row when present', async () => {
    const row = { name: 'c1', description: null, layout_name: null, members: [], created_at: 'c', updated_at: 'u' };
    mocks.getCrew.mockResolvedValue(row);
    const res = await def().handler(req('GET', `${BASE}/tui/crews/c1?owner=u1`), ctx({ name: 'c1' }));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual(row);
  });
});

describe('DELETE /tui/crews/:name (crewDelete)', () => {
  const def = () => routeByPath('DELETE', '/tui/crews/:name');
  it('400 owner_required without ?owner', async () => {
    const res = await def().handler(req('DELETE', `${BASE}/tui/crews/c1`), ctx({ name: 'c1' }));
    expect(res.status).toBe(400);
    expect(mocks.deleteCrew).not.toHaveBeenCalled();
  });
  it('{ ok:true, deleted:true } when a row was removed', async () => {
    mocks.deleteCrew.mockResolvedValue(true);
    const res = await def().handler(req('DELETE', `${BASE}/tui/crews/c1?owner=u1`), ctx({ name: 'c1' }));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, deleted: true });
    expect(mocks.deleteCrew).toHaveBeenCalledWith('u1', 'c1');
  });
  it('idempotent: absent → { ok:true, deleted:false } (NOT a 404)', async () => {
    mocks.deleteCrew.mockResolvedValue(false);
    const res = await def().handler(req('DELETE', `${BASE}/tui/crews/gone?owner=u1`), ctx({ name: 'gone' }));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, deleted: false });
  });
});

// ── intent-result (loopback-gated via isLoopbackRequest) ─────────────────────
describe('POST /tui/intents/:id/result (intentResult) — loopback gate + validation', () => {
  const def = () => routeByPath('POST', '/tui/intents/:id/result');

  it('403 loopback_required from a non-loopback host (before any DB call)', async () => {
    const res = await def().handler(
      req('POST', `${BASE}/tui/intents/1/result`, { host: 'evil.com:3070', json: { result: { ok: 1 } } }),
      ctx({ id: '1' }),
    );
    expect(res.status).toBe(403);
    expect(await jsonOf(res)).toEqual({ error: 'loopback_required' });
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('403 when no host header is present (not provably loopback)', async () => {
    const res = await def().handler(req('POST', `${BASE}/tui/intents/1/result`, { json: {} }), ctx({ id: '1' }));
    expect(res.status).toBe(403);
    expect(await jsonOf(res)).toEqual({ error: 'loopback_required' });
  });

  it('passes the gate from a loopback host → 400 invalid_id for a non-numeric id', async () => {
    const res = await def().handler(
      req('POST', `${BASE}/tui/intents/abc/result`, { host: 'localhost', json: {} }),
      ctx({ id: 'abc' }),
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'invalid_id' });
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('400 invalid_id for a non-positive id', async () => {
    const res = await def().handler(
      req('POST', `${BASE}/tui/intents/0/result`, { host: 'localhost', json: {} }),
      ctx({ id: '0' }),
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'invalid_id' });
  });

  it('400 invalid_json for a malformed body (after the gate + id checks)', async () => {
    const res = await def().handler(
      req('POST', `${BASE}/tui/intents/1/result`, { host: 'localhost', raw: 'not-json' }),
      ctx({ id: '1' }),
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'invalid_json' });
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('400 invalid_body when the body fails the schema', async () => {
    const res = await def().handler(
      req('POST', `${BASE}/tui/intents/1/result`, { host: 'localhost', json: { error: 123 } }),
      ctx({ id: '1' }),
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'invalid_body' });
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it('404 not_pending_or_missing when the UPDATE matches no pending row', async () => {
    mocks.sql.mockResolvedValueOnce([]);
    const res = await def().handler(
      req('POST', `${BASE}/tui/intents/9/result`, { host: 'localhost', json: { result: { x: 1 } } }),
      ctx({ id: '9' }),
    );
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ error: 'not_pending_or_missing' });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it('200 { ok:true, status:"done" } for a successful result', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: 1 }]);
    const res = await def().handler(
      req('POST', `${BASE}/tui/intents/1/result`, { host: '127.0.0.1:3070', json: { result: { x: 1 } } }),
      ctx({ id: '1' }),
    );
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, status: 'done' });
  });

  it('200 { ok:true, status:"error" } when an error is reported', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: 1 }]);
    const res = await def().handler(
      req('POST', `${BASE}/tui/intents/1/result`, { host: 'localhost', json: { error: 'boom' } }),
      ctx({ id: '1' }),
    );
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true, status: 'error' });
  });
});

// ── intents-stream (loopback-gated via isLoopbackRequest) ────────────────────
describe('GET /tui/intents/stream (intentsStream) — loopback gate + validation', () => {
  const def = () => routeByPath('GET', '/tui/intents/stream');

  it('403 loopback_required from a non-loopback host', async () => {
    const res = await def().handler(
      req('GET', `${BASE}/tui/intents/stream?client_id=c1`, { host: 'evil.com' }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(await jsonOf(res)).toEqual({ error: 'loopback_required' });
  });

  it('403 when no host header is present', async () => {
    const res = await def().handler(req('GET', `${BASE}/tui/intents/stream?client_id=c1`), ctx());
    expect(res.status).toBe(403);
    expect(await jsonOf(res)).toEqual({ error: 'loopback_required' });
  });

  it('passes the gate from a loopback host → 400 client_id_required when client_id is absent', async () => {
    const res = await def().handler(req('GET', `${BASE}/tui/intents/stream`, { host: 'localhost' }), ctx());
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: 'client_id_required' });
  });
});
