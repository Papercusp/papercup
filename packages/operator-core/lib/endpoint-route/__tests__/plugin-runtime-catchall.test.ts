/**
 * Audit P-026 — the plugin-runtime catchall dispatches into per-plugin
 * services (secrets/db/fetch/storage) and joins `:slug`/`:plugin` into
 * filesystem paths. It now carries `requireLoopbackOr403` plus path-segment
 * confinement. This file asserts:
 *   - 403 `loopback_only` from a non-loopback host (before any fs access),
 *   - 400 `badIdent` for traversal-shaped slug/plugin params,
 *   - the gate passes from loopback (bad path → 400, unknown service → 400,
 *     missing plugin → 404 pluginNotFound — i.e. legitimate dispatch shape
 *     is unchanged).
 *
 * `buildPluginRuntime` is mocked; none of these cases may reach it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const buildPluginRuntime = vi.fn();
vi.mock('../../plugin-host', () => ({
  buildPluginRuntime: (...a: unknown[]) => buildPluginRuntime(...(a as [])),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import catchall, { isSafeSegment } from '../routes/plugin-runtime/catchall';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function app(): Hono {
  const a = new Hono();
  registerRoute(a, catchall as unknown as AnyRoute);
  return a;
}
const post = (url: string) =>
  app().request(url, {
    method: 'POST',
    body: JSON.stringify({ args: [] }),
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.clearAllMocks());

describe('plugin-runtime catchall — loopback gate + path confinement (audit P-026)', () => {
  it('403 loopback_only from a non-loopback host', async () => {
    const res = await post('http://192.168.1.50:3070/plugin-runtime/h1/plug1/tasks/list');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'loopback_only' });
    expect(buildPluginRuntime).not.toHaveBeenCalled();
  });

  it('400 badIdent for a double-encoded traversal slug (`%252e%252e` — survives URL normalization)', async () => {
    // A well-formed `..` segment is collapsed by the URL layer before
    // routing (404s above the handler); the smuggled-escape form reaches
    // the param decode and must hit the in-handler guard.
    const res = await post('http://127.0.0.1:3070/plugin-runtime/%252e%252e/plug1/tasks/list');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'badIdent' });
  });

  it('isSafeSegment — unit matrix for the confinement guard', () => {
    for (const bad of ['..', '.', '.hidden', 'a/b', 'a\\b', 'a..b', '%2e%2e', 'has space', '']) {
      expect(isSafeSegment(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
    for (const good of ['example-tool-pack', 'h1', 'pkg.name', 'a_b-c.d']) {
      expect(isSafeSegment(good), `should accept ${JSON.stringify(good)}`).toBe(true);
    }
  });

  it('400 badIdent for a plugin param smuggling a separator (`..%2fup`)', async () => {
    const res = await post('http://127.0.0.1:3070/plugin-runtime/h1/..%2fup/tasks/list');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'badIdent' });
  });

  it('400 badIdent for a dot-leading plugin name', async () => {
    const res = await post('http://127.0.0.1:3070/plugin-runtime/h1/.hidden/tasks/list');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'badIdent' });
  });

  it('passes the gate from loopback → 400 badPath for a missing method segment', async () => {
    const res = await post('http://localhost/plugin-runtime/h1/plug1/tasksonly');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'badPath' });
  });

  it('passes the gate from loopback → 400 unknownService outside the allowlist', async () => {
    const res = await post('http://localhost/plugin-runtime/h1/plug1/shell/exec');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknownService', service: 'shell' });
  });

  it('passes the gate from loopback → 404 pluginNotFound for a valid-but-absent plugin', async () => {
    const res = await post(
      'http://localhost/plugin-runtime/no-such-harness-p026/no-such-plugin-p026/tasks/list',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'pluginNotFound' });
    expect(buildPluginRuntime).not.toHaveBeenCalled();
  });
});
