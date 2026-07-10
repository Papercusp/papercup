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
// The composed route stack runs INSIDE @papercusp/operator-core, so it calls
// operator-core's telemetry (route-stack.ts → './telemetry'), NOT this app's
// `../telemetry` above. Mock the operator-core module too (it resolves to the
// same file route-stack imports) so the route stack never reaches a live PG:
// telemetry's best-effort write console.warns on a down DB, which
// vitest-fail-on-console turns into a test failure. Keeps the test hermetic
// regardless of whether the dev-box native PG (:5432) is up.
vi.mock('@papercusp/operator-core/lib/endpoint-route/telemetry', () => ({
  recordRouteInvocation: vi.fn(),
}));
// `_hono/app.ts` pulls `server-only` transitively; it's a no-op marker in
// a Node test context — stub it so the real app can be imported here.
vi.mock('server-only', () => ({}));
// The /harness/projects defineTool is NOT pure-FS: loadHarnessRegistry reads
// PG-canonical operator state (mig 025) and throws when no DB is reachable, so
// the handler 500s. That made this whole file silently depend on a live
// Postgres — green on a dev box with native PG on :5432, red on a packaged
// install (and on any contributor without a DB up). Registry CONTENTS are
// irrelevant to a route-WIRING test, so stub the one DB seam and keep every
// other export real. Same resolves-to-the-same-file trick as the mock above.
vi.mock('@papercusp/operator-core/lib/harness-registry', async (importActual) => {
  const actual =
    await importActual<typeof import('@papercusp/operator-core/lib/harness-registry')>();
  return { ...actual, loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) };
});

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
 * The block above guards the MECHANISM (two-phase registration) against a
 * stand-in app that still mounts a colliding `harness` sub-app. This block
 * guards the actual WIRING by importing the real host app (`bin/host-app.ts`).
 *
 * Note the real app no longer mounts ANY `/harness` sub-app — `app.route(
 * '/harness', harness)` was dropped in the A4 batch and `app/_hono/` is gone.
 * So nothing here can out-rank the phase-1 literal by shadowing; what this
 * block still pins is that the literals resolve against the REAL registered
 * route table (a phase-2 catch-all must not swallow them) and that the
 * defineTool — not a dispatcher — answers with its own payload shape.
 */
describe('composed-app route shadowing — REAL host-app wiring', () => {
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

  it('literal /harness/projects resolves to its defineTool, not a catch-all', async () => {
    // With the registry seam stubbed the defineTool 200s with its own
    // `{ projects: [...] }` shape. A phase-2 catch-all answering instead
    // would not produce that shape (and a shadowed literal would 404).
    const res = await app.request('/api/harness/projects');
    expect(res.status, '/harness/projects must hit the defineTool, not a catch-all').toBe(200);
    const body = (await res.json()) as { projects?: unknown };
    expect(Array.isArray(body.projects), 'defineTool response shape').toBe(true);
  });
});
