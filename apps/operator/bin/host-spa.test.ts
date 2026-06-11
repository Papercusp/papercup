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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
let distDir: string;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'host-spa-dist-'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><head></head><body>app</body></html>');
  process.env.PAPERCUSP_SPA_DIST = distDir;
  ({ spaRoutes } = await import('./host-spa'));
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
    const body = await res.text();
    expect(body).toContain('window.__PAPERCUSP_WS__=');
    // Injected inside <head> so it runs before the deferred module entry.
    expect(body.indexOf('window.__PAPERCUSP_WS__=')).toBeLessThan(body.indexOf('</head>'));
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

  it('serves the shell for an unknown client route (200, not 404)', async () => {
    const res = await spaRoutes.request('/some/deep/client/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('window.__PAPERCUSP_WS__=');
  });

  it('returns a real 404 for a missing extensioned asset (never shells a .js)', async () => {
    const res = await spaRoutes.request('/assets/does-not-exist.js');
    expect(res.status).toBe(404);
  });
});
