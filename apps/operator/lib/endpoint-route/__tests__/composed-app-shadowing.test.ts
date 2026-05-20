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
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/endpoint-route/telemetry', () => ({
  recordRouteInvocation: vi.fn(),
}));

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
