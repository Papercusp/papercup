/**
 * SPA host shell tests — focuses on the pre-hydration globals injected into
 * `index.html` at serve time (`window.__PAPERCUSP_WS__`, `window.__PAPERCUSP_FLAGS__`).
 *
 * `host-spa.ts` resolves `SPA_DIST_ROOT` at import time from `PAPERCUSP_SPA_DIST`,
 * so the env var is set + the module dynamically imported inside `beforeAll`,
 * pointing at a tmp fixture `dist/` with a minimal `index.html`.
 *
 * Flags are forced via the `@papercusp/flags/test` override seam rather than a
 * live PostHog backend: with no backend configured (the test env has no
 * `~/.papercusp/posthog.json`), `getAllFlags()` consults `resolveTestOverrides()`
 * first, so a forced flag round-trips through the real serve path.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

// Stub the profile read so the pre-paint prefs injection has a deterministic
// value without a live PG connection.
vi.mock('@papercusp/operator-core/lib/session', () => ({
  readProfile: vi.fn(async () => ({ theme_id: 'black', visual_effects_mode: 'minimal' })),
}));

let spaRoutes: import('hono').Hono;
let createSpaRoutes: typeof import('./host-spa').createSpaRoutes;
let immutableCacheControl: typeof import('./host-spa').IMMUTABLE_CACHE_CONTROL;
let distDir: string;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'host-spa-dist-'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><head></head><body>app</body></html>');
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'assets', 'entry-AbCd1234.js'), 'export const entry = 1;');
  writeFileSync(join(distDir, 'assets', 'runtime.js'), 'export const runtime = 1;');
  process.env.PAPERCUSP_SPA_DIST = distDir;
  ({ spaRoutes, createSpaRoutes, IMMUTABLE_CACHE_CONTROL: immutableCacheControl } = await import('./host-spa'));
});

afterEach(() => {
  setFlagOverridesForTest(null);
});

afterAll(() => {
  delete process.env.PAPERCUSP_SPA_DIST;
  rmSync(distDir, { recursive: true, force: true });
});

describe('SPA shell pre-hydration globals', () => {
  it('injects the active workspace id global before the module bundle', async () => {
    const res = await spaRoutes.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store, max-age=0');
    const body = await res.text();
    expect(body).toContain('window.__PAPERCUSP_WS__=');
    // Injected inside <head> so it runs before the deferred module entry.
    expect(body.indexOf('window.__PAPERCUSP_WS__=')).toBeLessThan(body.indexOf('</head>'));
  });

  it('injects the isolated-Tauri marker when the verifier launch env is set', async () => {
    process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED = '1';
    try {
      const res = await spaRoutes.request('/');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('window.__PAPERCUSP_TAURI_ISOLATED__=true;');
      expect(body.indexOf('window.__PAPERCUSP_TAURI_ISOLATED__=')).toBeLessThan(body.indexOf('</head>'));
    } finally {
      delete process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
    }
  });

  it('seeds resolved feature flags so gated UI does not flash defaults', async () => {
    setFlagOverridesForTest({ 'papercusp-testing': true });
    const res = await spaRoutes.request('/');
    const body = await res.text();
    // The payload is nested JSON, so slice from the assignment to the end of
    // the injected <script> and JSON.parse it rather than a brace-counting regex.
    const marker = 'window.__PAPERCUSP_FLAGS__=';
    const start = body.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const json = body.slice(start + marker.length, body.indexOf('</script>', start)).replace(/;$/, '');
    const payload = JSON.parse(json);
    expect(payload.flags['papercusp-testing']).toBe(true);
    expect(payload.source).toBe('override');
  });

  it('injects pre-paint presentation prefs (theme + visual-effects) before the bundle', async () => {
    const res = await spaRoutes.request('/');
    const body = await res.text();
    expect(body).toContain('window.__PAPERCUSP_PREFS__={"theme_id":"black","visual_effects_mode":"minimal"}');
    // Inside <head>, before the deferred module entry, so the boot scripts read it.
    expect(body.indexOf('window.__PAPERCUSP_PREFS__=')).toBeLessThan(body.indexOf('</head>'));
  });

  it('pins hosted hydration to the control-plane workspace and never exposes local state', async () => {
    process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED = '1';
    setFlagOverridesForTest({ 'papercusp-testing': true });
    try {
      const hostedRoutes = createSpaRoutes({
        kind: 'hosted',
        controlPlaneWorkspaceId: 'hosted-control-plane',
      });
      const res = await hostedRoutes.request('/?ws=other-tenant-workspace');
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain('window.__PAPERCUSP_WS__="hosted-control-plane";');
      const markerStart = body.indexOf("window.__PAPERCUSP_HOSTED_BROWSER__=");
      expect(markerStart).toBeGreaterThan(-1);
      const markerJson = body
        .slice(
          markerStart + "window.__PAPERCUSP_HOSTED_BROWSER__=".length,
          body.indexOf(";", markerStart),
        )
        .trim();
      expect(JSON.parse(markerJson)).toEqual({
        version: 1,
        controlPlaneWorkspaceId: "hosted-control-plane",
        restEndpoint: "/api/hosted/browser",
        sseEndpoint: "/api/hosted/browser/sse",
        workspaceHostEndpoints: {
          connection: "/api/hosted/browser/workspace-hosts/connection",
          provision: "/api/hosted/browser/workspace-hosts/provision",
          action: "/api/hosted/browser/workspace-hosts/action",
        },
      });
      expect(body).toContain(
        "window.__PAPERCUSP_HOSTED_BROWSER_API__=window.__PAPERCUSP_HOSTED_BROWSER__;",
      );
      expect(body).not.toContain('other-tenant-workspace');
      expect(body).not.toContain('window.__PAPERCUSP_PREFS__=');
      expect(body).not.toContain('window.__PAPERCUSP_FLAGS__=');
      expect(body).not.toContain('window.__PAPERCUSP_TAURI_ISOLATED__=');
    } finally {
      delete process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
    }
  });

  it('serves the shell for an unknown client route (200, not 404)', async () => {
    const res = await spaRoutes.request('/some/deep/client/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('window.__PAPERCUSP_WS__=');
  });

  it("script-escapes a hosted workspace marker before injecting it into HTML", async () => {
    const hostedRoutes = createSpaRoutes({
      kind: "hosted",
      controlPlaneWorkspaceId: "</script><script>window.compromised=1</script>",
    });
    const body = await (await hostedRoutes.request("/")).text();

    expect(body).not.toContain(
      "</script><script>window.compromised=1</script>",
    );
    expect(body).toContain("\\u003c/script\\u003e");
  });

  it('returns a real 404 for a missing extensioned asset (never shells a .js)', async () => {
    const res = await spaRoutes.request('/assets/does-not-exist.js');
    expect(res.status).toBe(404);
  });

  it('streams content-hashed assets with immutable caching while leaving mutable assets uncached', async () => {
    const hashed = await spaRoutes.request('/assets/entry-AbCd1234.js');
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get('cache-control')).toBe(immutableCacheControl);
    expect(hashed.headers.get('content-length')).toBe(String('export const entry = 1;'.length));
    expect(hashed.body).not.toBeNull();
    expect(await hashed.text()).toBe('export const entry = 1;');

    const mutable = await spaRoutes.request('/assets/runtime.js');
    expect(mutable.status).toBe(200);
    expect(mutable.headers.get('cache-control')).toBeNull();
    expect(await mutable.text()).toBe('export const runtime = 1;');
  });
});
