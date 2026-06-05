/**
 * Regression test for the endpoint-route audit (2026-05-20).
 *
 * The original bug: every other endpoint-route test built a BARE
 * `new Hono()` + `registerAllRoutes` — never reproducing the real
 * `_hono/app.ts`, which mounts sub-apps (`app.route('/harness', …)`,
 * historically `app.route('/plugins', …)`). The `plugins` sub-app
 * carried a parametric catch-all (`installPluginApiDispatcher`).
 * When `registerAllRoutes` ran AFTER those mounts, the catch-all
 * shadowed every literal `/plugins/*` defineTool — 17 of them
 * returned 404 in production while 264 tests stayed green.
 *
 * The endpoint-hono-elimination 2026-05-21 A3 migration **deleted**
 * the `plugins` Hono sub-app entirely — `/plugins/*` is now served
 * exclusively by `defineTool` modules (literals via phase 1, the
 * apiRoutes-then-projected-tool catch-all via phase 2). This test
 * still guards the two-phase split itself: the `harness` sub-app
 * remains, and any future sub-app added the same way must not
 * shadow phase-1 literals.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Hono as HonoType } from 'hono';

vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(),
}));
// `_hono/app.ts` pulls `server-only` transitively; it's a no-op marker in
// a Node test context — stub it so the real app can be imported here.
vi.mock('server-only', () => ({}));

import { Hono } from 'hono';
import { registerRouteLiterals, registerRouteCatchalls } from '@papercusp/operator-core/lib/endpoint-route/register';

/**
 * Reproduce the `_hono/app.ts` mount order exactly:
 *   phase 1 literals → sub-apps (harness) → phase 2 catch-alls.
 * The `harness` sub-app here is a minimal stand-in — only its
 * SHADOWING shape (a colliding route) matters.
 */
function composedApp(): Hono {
  const app = new Hono().basePath('/api');

  // ── phase 1: literal defineRoutes ──
  registerRouteLiterals(app);

  // ── sub-apps (mirror _hono/app.ts) ──
  const harness = new Hono();
  // The real _hono harness sub-app has these two — they collided with
  // the ported defineRoutes. The marker proves which handler answered.
  harness.get('/projects', (c) => c.json({ from: 'fake-hono-harness' }));
  harness.post('/:slug/save-as-template', (c) => c.json({ from: 'fake-hono-harness' }));
  app.route('/harness', harness);

  // ── phase 2: catch-all defineRoutes ──
  registerRouteCatchalls(app);

  return app;
}

describe('composed-app route shadowing (endpoint-route audit regression)', () => {
  it('literal /plugins/* routes reach their defineTool, not the dispatcher 404', async () => {
    const app = composedApp();
    // Each of these is a literal defineTool. Before the original
    // (now-removed) dispatcher fix, the plugin Hono sub-app shadowed
    // these and returned 404. They must still all be reached even
    // though the sub-app is gone — the phase-2 `/plugins/*` catch-all
    // (apiRoutes-then-projected-tool) must not shadow phase-1 literals
    // either. The exact non-404 status depends on test-env deps and is
    // irrelevant; reaching the handler is the contract.
    for (const p of [
      '/api/plugins/enabled',
      '/api/plugins/manifest',
      '/api/plugins/grants',
    ]) {
      const res = await app.request(p);
      expect(res.status, `${p} must reach its defineTool, not the catch-all 404`).not.toBe(404);
    }
  });

  it('a 2-segment literal (/plugins/host/*) is not eaten by the /plugins/* catch-all', async () => {
    const app = composedApp();
    // /plugins/host/query is a phase-1 literal. The phase-2 /plugins/*
    // catch-all (the apiRoutes-then-projected-tool dispatcher) must not
    // shadow it. Empty body → the handler's own 400.
    const res = await app.request('/api/plugins/host/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(res.status).not.toBe(404);
  });

  it('literal /harness/projects wins over the _hono harness sub-app', async () => {
    const app = composedApp();
    const res = await app.request('/api/harness/projects');
    expect(res.status).not.toBe(404);
    const body = await res.text();
    expect(body, 'the ported defineTool must answer, not the _hono sub-app').not.toContain(
      'fake-hono-harness',
    );
  });
});

/**
 * The block above guards the MECHANISM (two-phase registration) against
 * a stand-in app. This block guards the actual WIRING by importing the
 * real `_hono/app.ts`:
 *
 *  - `/plugins/*` reachability — a composed-app smoke test against the
 *    real wiring (phase-1 literals + phase-2 catch-all + the `harness`
 *    sub-app).
 *  - `/harness/projects` returns exactly 200 — catches a two-phase
 *    reorder. The ported defineTool is a pure-FS handler that always
 *    200s; the colliding `_hono` `harness.get('/projects')` opens per-
 *    slug PG pools and fails without a DB. If `registerRouteLiterals`
 *    is moved after `app.route('/harness', …)`, the `_hono` route wins
 *    and the status flips off 200.
 */
describe('composed-app route shadowing — REAL _hono/app.ts wiring', () => {
  let app: HonoType;

  beforeAll(async () => {
    // ~6s — imports the full host app graph. Cached after first import.
    const mod = await import('@/bin/host-app');
    app = mod.app as unknown as HonoType;
  }, 120_000);

  it('literal /plugins/* routes are not shadowed by the /plugins/* catch-all', async () => {
    for (const p of ['/api/plugins/enabled', '/api/plugins/manifest', '/api/plugins/grants']) {
      const res = await app.request(p);
      expect(res.status, `${p} must reach its defineTool, not the catch-all 404`).not.toBe(404);
    }
  });

  it('2-segment literal /plugins/host/query is not eaten by /plugins/*', async () => {
    const res = await app.request('/api/plugins/host/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(res.status).not.toBe(404);
  });

  it('literal /harness/projects defineTool wins over the _hono harness sub-app', async () => {
    // The ported defineTool is pure-FS and always 200s; the _hono
    // harness sub-app's /projects opens PG pools and won't 200 here.
    // 200 ⇒ the phase-1 literal out-ranked the sub-app (correct wiring).
    const res = await app.request('/api/harness/projects');
    expect(res.status, '/harness/projects must hit the defineTool, not the _hono sub-app').toBe(
      200,
    );
    const body = (await res.json()) as { projects?: unknown };
    expect(Array.isArray(body.projects), 'defineTool response shape').toBe(true);
  });
});
