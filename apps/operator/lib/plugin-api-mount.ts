/**
 * Phase 6b item 2 — apiRoutes mounting.
 *
 * Discovers loaded plugins on first call and registers each plugin's
 * `apiRoutes` (a Hono app or any object with a `fetch(req)` method)
 * into an in-memory registry keyed by safe-name.
 *
 * `installPluginApiDispatcher(plugins)` adds ONE catch-all route on the
 * supplied Hono router that looks up the requested plugin and forwards
 * the request to its handler. We use runtime dispatch instead of
 * `Hono.mount(...)` because Hono's `app.route(prefix, sub)` snapshots the
 * sub-app's routes at registration time — late mounts (after server boot
 * or after a hot-reload reset) silently no-op.
 *
 * Plugin authors expose `apiRoutes` in their manifest as a Hono app. The
 * SDK types this as `unknown` (to keep the SDK Hono-version-agnostic);
 * we duck-type at registration time and skip plugins that don't expose
 * a Hono-shaped `fetch` handler.
 */
import type { Hono } from 'hono';
import { loadPlugins, type LoadedPlugin } from '@papercusp/plugin-loader';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { papercuspPath } from '@/lib/papercusp-root';
interface ApiRouteHandle {
  fetch: (req: Request, ...rest: any[]) => Promise<Response> | Response;
}

function looksLikeHonoApp(x: unknown): x is ApiRouteHandle {
  return typeof x === 'object' && x !== null && typeof (x as any).fetch === 'function';
}

function discoverHarnessSlugs(): string[] {
  const harnessRoot = papercuspPath('harnesses');
  if (!existsSync(harnessRoot)) return [];
  try {
    return readdirSync(harnessRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Pin the registry on globalThis so HMR module reloads don't lose mounts.
const __mountKey = '__papercuspPluginApiMount';
type Result = { mounted: number; skipped: number; errors: string[] };
type Registry = Map<string, ApiRouteHandle>;
type CacheShape = { promise: Promise<Result> | null; counts: Result | null; registry: Registry };
type Globals = { [__mountKey]?: CacheShape };
const __globals = globalThis as Globals;
if (!__globals[__mountKey]) {
  __globals[__mountKey] = { promise: null, counts: null, registry: new Map() };
}
const __cache = __globals[__mountKey]!;

export interface MountPluginApiRoutesOptions {
  /** Override the global-plugins discovery directory (tests). */
  globalPluginsDir?: string;
  /** Override the harness-slug list (tests). Defaults to scanning ~/.papercusp/harnesses. */
  harnessSlugs?: string[];
  /**
   * Compatibility shim — ignored (the runtime now uses an in-router
   * dispatcher rather than path mounts). Accepted so existing callers
   * don't break.
   */
  mountPrefix?: string;
}

/**
 * Build / refresh the in-memory plugin-apiRoutes registry. Idempotent
 * after first call until `_resetPluginApiRoutesForTests()` is invoked.
 *
 * The `parent` argument is accepted for back-compat with the old mount
 * API but is no longer used — dispatch happens via
 * `installPluginApiDispatcher(plugins)` which registers a single
 * catch-all route on the plugins sub-app.
 */
export function mountPluginApiRoutes(_parent: Hono<any, any, any>, opts: MountPluginApiRoutesOptions = {}): Promise<{ mounted: number; skipped: number; errors: string[] }> {
  if (__cache.promise) return __cache.promise;

  __cache.promise = (async () => {
    const errors: string[] = [];
    let mounted = 0;
    let skipped = 0;
    __cache.registry.clear();

    let discovered: { loaded: LoadedPlugin[]; errors: Array<{ error: string; path: string }> };
    try {
      discovered = await loadPlugins({
        globalPluginsDir: opts.globalPluginsDir,
        harnessSlugs: opts.harnessSlugs ?? discoverHarnessSlugs(),
      });
    } catch (e: any) {
      errors.push(`plugin discovery failed: ${e?.message ?? String(e)}`);
      const result = { mounted: 0, skipped: 0, errors };
      __cache.counts = result;
      return result;
    }

    for (const lp of discovered.loaded) {
      const apiRoutes = lp.plugin.apiRoutes;
      if (apiRoutes === undefined || apiRoutes === null) {
        skipped++;
        continue;
      }
      if (!looksLikeHonoApp(apiRoutes)) {
        errors.push(`plugin "${lp.plugin.name}" apiRoutes is not Hono-shaped (no .fetch); skipping`);
        skipped++;
        continue;
      }
      const safeName = lp.plugin.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      __cache.registry.set(safeName, apiRoutes);
      mounted++;
    }

    for (const err of discovered.errors) {
      errors.push(`plugin discovery error at ${err.path}: ${err.error}`);
    }

    const result = { mounted, skipped, errors };
    __cache.counts = result;
    return result;
  })();

  return __cache.promise;
}

async function ensureRegistryBuilt(): Promise<void> {
  if (__cache.promise) {
    await __cache.promise;
    return;
  }
  // Lazy rebuild: install/uninstall reset paths clear the cache and don't
  // re-call mountPluginApiRoutes themselves. We rehydrate on first dispatch.
  await mountPluginApiRoutes(null as any);
}

/**
 * Register a single catch-all route on the given Hono router that
 * forwards `/<safe-name>/...` requests to the corresponding plugin's
 * apiRoutes handler. Safe to call once at module init — the underlying
 * registry is hot-swappable without re-registering this route.
 */
export function installPluginApiDispatcher(router: Hono<any, any, any>): void {
  router.all('/:pluginName/*', async (c) => {
    await ensureRegistryBuilt();
    const name = c.req.param('pluginName');
    const handle = __cache.registry.get(name);
    if (!handle) return c.notFound();
    // Hand the inner handler a Request stripped of the `/<plugin-name>` prefix
    // and the parent's basePath so its own internal routing matches the way
    // it does in standalone tests.
    const url = new URL(c.req.url);
    const stripped = url.pathname.replace(new RegExp(`^.*/plugins/${name}`), '') || '/';
    const innerUrl = url.origin + stripped + url.search;
    const innerReq = new Request(innerUrl, c.req.raw);
    return handle.fetch(innerReq);
  });
  router.all('/:pluginName', async (c) => {
    await ensureRegistryBuilt();
    const name = c.req.param('pluginName');
    const handle = __cache.registry.get(name);
    if (!handle) return c.notFound();
    const url = new URL(c.req.url);
    const innerUrl = url.origin + '/' + url.search;
    const innerReq = new Request(innerUrl, c.req.raw);
    return handle.fetch(innerReq);
  });
}

/** Inspector for tests / health endpoints — null until first mount completes. */
export function pluginApiRoutesStatus() {
  return __cache.counts;
}

/** Read-only view of the registry — used by diagnostics. */
export function pluginApiRegistryNames(): string[] {
  return Array.from(__cache.registry.keys()).sort();
}

/** Resets the cache. Tests use this to re-mount with different fixtures. */
export function _resetPluginApiRoutesForTests() {
  __cache.promise = null;
  __cache.counts = null;
  __cache.registry.clear();
}
