/**
 * Regression test for the endpoint-route audit (2026-05-20).
 *
 * The bug: every other endpoint-route test builds a BARE `new Hono()` +
 * `registerAllRoutes` — it never reproduces the real `_hono/app.ts`,
 * which mounts sub-apps (`app.route('/harness', …)`, `app.route('/plugins',
 * …)`). The `plugins` sub-app carries a parametric catch-all
 * (`installPluginApiDispatcher`). When `registerAllRoutes` ran AFTER
 * those mounts, the catch-all shadowed every literal `/plugins/*`
 * defineRoute — 17 of them returned 404 in production while 264 tests
 * stayed green.
 *
 * This test reproduces the real mount ORDER and asserts the literals
 * are reachable. It fails if anyone reverts the two-phase split in
 * `register.ts` / `_hono/app.ts` or the dispatcher's yield in
 * `plugin-api-mount.ts`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Hono as HonoType } from 'hono';

vi.mock('@/lib/endpoint-route/telemetry', () => ({
  recordRouteInvocation: vi.fn(),
}));
// `_hono/app.ts` pulls `server-only` transitively; it's a no-op marker in
// a Node test context — stub it so the real app can be imported here.
vi.mock('server-only', () => ({}));

import { Hono } from 'hono';
import { installPluginApiDispatcher } from '@/lib/plugin-api-mount';
import { registerRouteLiterals, registerRouteCatchalls } from '../register';

/**
 * Reproduce the `_hono/app.ts` mount order exactly:
 *   phase 1 literals → sub-apps (harness, plugins+dispatcher) → phase 2 catch-alls.
 * The harness/plugins sub-apps here are minimal stand-ins — only their
 * SHADOWING shape (a colliding route / the dispatcher catch-all) matters.
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

  const plugins = new Hono();
  installPluginApiDispatcher(plugins); // the parametric catch-all that caused the bug
  app.route('/plugins', plugins);

  // ── phase 2: catch-all defineRoutes ──
  registerRouteCatchalls(app);

  return app;
}

describe('composed-app route shadowing (endpoint-route audit regression)', () => {
  it('literal /plugins/* routes reach their defineRoute, not the dispatcher 404', async () => {
    const app = composedApp();
    // Each of these is a literal defineRoute. Before the fix, the
    // plugin dispatcher (registered via app.route('/plugins', …)) ran
    // first and returned 404. All must now be reached — the exact
    // non-404 status (400/500/200) depends on test-env deps and is
    // irrelevant; reaching the handler at all is the contract.
    for (const p of [
      '/api/plugins/enabled',
      '/api/plugins/manifest',
      '/api/plugins/grants',
    ]) {
      const res = await app.request(p);
      expect(res.status, `${p} must reach its defineRoute, not the dispatcher 404`).not.toBe(404);
    }
  });

  it('a 2-segment literal (/plugins/host/*) is not eaten by the /:pluginName/* dispatcher', async () => {
    const app = composedApp();
    // /plugins/host/query matches the dispatcher's `/:pluginName/*`
    // (pluginName=host). Empty body → the handler's own 400. Before the
    // fix this was a dispatcher 404.
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
    expect(body, 'the ported defineRoute must answer, not the _hono sub-app').not.toContain(
      'fake-hono-harness',
    );
  });
});

/**
 * The block above guards the MECHANISM (register.ts two-phase + the
 * dispatcher yield) against a stand-in app. This block guards the actual
 * WIRING by importing the real `_hono/app.ts`:
 *
 *  - `/plugins/*` reachability — a composed-app smoke test. (Note: the
 *    `plugin-api-mount.ts` `next()` yield alone keeps these reachable
 *    regardless of literal-vs-dispatcher registration order, so this
 *    assertion catches a *both-parts* revert, not a lone reorder.)
 *  - `/harness/projects` returns exactly 200 — this DOES catch a
 *    two-phase reorder. The ported defineRoute is a pure-FS handler that
 *    always 200s; the colliding `_hono` `harness.get('/projects')` opens
 *    per-slug PG pools and fails without a DB. If `registerRouteLiterals`
 *    is moved after `app.route('/harness', …)`, the `_hono` route wins
 *    and the status flips off 200.
 */
describe('composed-app route shadowing — REAL _hono/app.ts wiring', () => {
  let app: HonoType;

  beforeAll(async () => {
    // ~6s — imports the full _hono app graph. Cached after first import.
    const mod = await import('@/app/api/_hono/app');
    app = mod.app as unknown as HonoType;
  }, 120_000);

  it('literal /plugins/* routes are not shadowed by the plugin dispatcher', async () => {
    for (const p of ['/api/plugins/enabled', '/api/plugins/manifest', '/api/plugins/grants']) {
      const res = await app.request(p);
      expect(res.status, `${p} must reach its defineRoute, not the dispatcher 404`).not.toBe(404);
    }
  });

  it('2-segment literal /plugins/host/query is not eaten by /:pluginName/*', async () => {
    const res = await app.request('/api/plugins/host/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(res.status).not.toBe(404);
  });

  it('literal /harness/projects defineRoute wins over the _hono harness sub-app', async () => {
    // The ported defineRoute is pure-FS and always 200s; the _hono
    // harness sub-app's /projects opens PG pools and won't 200 here.
    // 200 ⇒ the phase-1 literal out-ranked the sub-app (correct wiring).
    const res = await app.request('/api/harness/projects');
    expect(res.status, '/harness/projects must hit the defineRoute, not the _hono sub-app').toBe(
      200,
    );
    const body = (await res.json()) as { projects?: unknown };
    expect(Array.isArray(body.projects), 'defineRoute response shape').toBe(true);
  });
});
