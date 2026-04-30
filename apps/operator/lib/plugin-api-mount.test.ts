/**
 * Unit tests for the apiRoutes dispatcher + lazy registry rebuild.
 *
 * Covers the routing-rewrite that landed 2026-04-30: instead of static
 * `app.mount('/plugins/<name>', ...)` (which Hono.app.route silently
 * shadows), the host registers one catch-all on the plugins sub-app and
 * dispatches by safe-name from an in-memory registry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  installPluginApiDispatcher,
  mountPluginApiRoutes,
  pluginApiRegistryNames,
  pluginApiRoutesStatus,
  _resetPluginApiRoutesForTests,
} from './plugin-api-mount';

beforeEach(() => {
  _resetPluginApiRoutesForTests();
});

function buildHostApp(): { app: Hono; plugins: Hono } {
  const app = new Hono().basePath('/api');
  const plugins = new Hono();
  plugins.get('/runtime/status', (c) => c.json({ ok: 'plugins-handler' }));
  installPluginApiDispatcher(plugins);
  app.route('/plugins', plugins);
  return { app, plugins };
}

describe('installPluginApiDispatcher', () => {
  it('returns 404 from sub-app when no plugins registered', async () => {
    const { app } = buildHostApp();
    // The dispatcher will lazy-rebuild on first dispatch via filesystem
    // discovery (PAPERCUSP_GLOBAL_PLUGINS_DIR is unset → empty registry).
    const r = await app.fetch(new Request('http://x/api/plugins/_papercupai_nope/ping'));
    expect(r.status).toBe(404);
  });

  it('does not shadow the plugins sub-app routes', async () => {
    const { app } = buildHostApp();
    const r = await app.fetch(new Request('http://x/api/plugins/runtime/status'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: 'plugins-handler' });
  });

  it('dispatches to a plugin registered after app.route(...)', async () => {
    // Demonstrates the Hono.route-snapshot footgun is resolved: registry
    // mutations after `app.route()` are visible to subsequent requests.
    const { app, plugins } = buildHostApp();
    expect(plugins).toBeDefined();
    const fakePlugin = {
      async fetch(req: Request) {
        const u = new URL(req.url);
        return Response.json({ ok: true, path: u.pathname });
      },
    };
    // Inject directly into the registry by re-using mountPluginApiRoutes's
    // exposed names (we drive it through a fixture dir below). For this
    // test, exercise the `_unsafe` injection path: we rebuild via the
    // public function but with no fixture, then push into the registry
    // through pluginApiRegistryNames's underlying state by mounting a
    // minimal fixture plugin.
    const tmp = await makeTempPlugin('test-plugin', fakePlugin);
    await mountPluginApiRoutes(null as any, { globalPluginsDir: tmp.dir, harnessSlugs: [] });
    expect(pluginApiRegistryNames()).toContain('test-plugin');

    const r = await app.fetch(new Request('http://x/api/plugins/test-plugin/some/deep/path?q=1'));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/some/deep/path');
  });

  it('handles bare plugin path (no trailing segment)', async () => {
    const fakePlugin = {
      async fetch(req: Request) {
        return Response.json({ ok: true, url: new URL(req.url).pathname });
      },
    };
    const tmp = await makeTempPlugin('bare', fakePlugin);
    await mountPluginApiRoutes(null as any, { globalPluginsDir: tmp.dir, harnessSlugs: [] });
    const { app } = buildHostApp();
    const r = await app.fetch(new Request('http://x/api/plugins/bare'));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it('clears the registry on reset and re-populates on next mount call', async () => {
    const fakePlugin = { async fetch() { return Response.json({ alive: true }); } };
    const tmp = await makeTempPlugin('reborn', fakePlugin);
    await mountPluginApiRoutes(null as any, { globalPluginsDir: tmp.dir, harnessSlugs: [] });
    expect(pluginApiRegistryNames()).toContain('reborn');

    _resetPluginApiRoutesForTests();
    expect(pluginApiRegistryNames()).toEqual([]);

    // Calling mount again with the same fixture rebuilds the registry —
    // this is the path that install-plugin / uninstall / status?reset=1
    // exercise after a reset.
    await mountPluginApiRoutes(null as any, { globalPluginsDir: tmp.dir, harnessSlugs: [] });
    expect(pluginApiRegistryNames()).toContain('reborn');
  });

  it('records mount counts via pluginApiRoutesStatus', async () => {
    const fakePlugin = { async fetch() { return new Response('ok'); } };
    const tmp = await makeTempPlugin('counted', fakePlugin);
    const r = await mountPluginApiRoutes(null as any, { globalPluginsDir: tmp.dir, harnessSlugs: [] });
    expect(r.mounted).toBe(1);
    expect(pluginApiRoutesStatus()).toEqual(r);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * Test helpers
 * ───────────────────────────────────────────────────────────────────── */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeTempPlugin(
  name: string,
  apiRoutes: { fetch: (req: Request) => Promise<Response> | Response },
): Promise<{ dir: string }> {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-mount-test-'));
  const pluginDir = join(root, name);
  mkdirSync(pluginDir, { recursive: true });
  const manifest = {
    kind: 'plugin',
    name,
    version: '0.1.0',
    papercusp: '^0.1.0',
    capabilities: [],
  };
  writeFileSync(join(pluginDir, 'papercusp.json'), JSON.stringify(manifest, null, 2));
  // Stash the apiRoutes object on a globalThis-keyed slot so the entry
  // file can hand it back. Avoids serializing functions through JSON.
  const slot = `__papercusp_test_api_${name}`;
  (globalThis as any)[slot] = apiRoutes;
  const entry = `
const plugin = {
  kind: 'plugin',
  name: ${JSON.stringify(name)},
  version: '0.1.0',
  papercusp: '^0.1.0',
  capabilities: [],
  async init() {},
};
plugin.apiRoutes = globalThis[${JSON.stringify(slot)}];
module.exports = { default: plugin };
module.exports.default = plugin;
`;
  writeFileSync(join(pluginDir, 'index.js'), entry);
  return { dir: root };
}
