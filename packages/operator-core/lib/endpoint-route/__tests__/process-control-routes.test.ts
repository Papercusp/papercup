/**
 * Audit P-025 — the harness process-control routes (`/harness/:slug/pause`,
 * `/unpause`, `/stop`) SIGSTOP/SIGCONT/SIGTERM PIDs found under the project
 * path, yet are `auth: 'public'`. They now carry `requireLoopbackOr403` like
 * their destructive siblings (spawn, backups, flags). This file asserts, per
 * route:
 *   - 403 `loopback_only` from a non-loopback host BEFORE any project
 *     resolution or /proc walking, and
 *   - the gate passes from a loopback host (request proceeds to the project
 *     lookup → 404 for an unknown slug, 200 with an empty PID set for a
 *     project path nothing is running under — no real signals fired).
 *
 * Harness mirrors destructive-public-routes.test.ts: registerRoute →
 * throwaway Hono app → app.request().
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const resolvePhasedProject = vi.fn(async (): Promise<{ path: string } | null> => null);
vi.mock('../../harness-core', () => ({
  resolvePhasedProject: (...a: unknown[]) => resolvePhasedProject(...(a as [])),
  isHarnessDriverCmdline: () => false,
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import processControl from '../routes/harness/process-control';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [pause, unpause, stop] = processControl as unknown as AnyRoute[];

function appWith(def: AnyRoute): Hono {
  const app = new Hono();
  registerRoute(app, def);
  return app;
}
const post = (def: AnyRoute, url: string) =>
  appWith(def).request(url, { method: 'POST' });

afterEach(() => vi.clearAllMocks());

const CASES: Array<{ name: string; def: AnyRoute; path: string; okKey: string }> = [
  { name: 'pause', def: pause, path: '/harness/some-h/pause', okKey: 'paused' },
  { name: 'unpause', def: unpause, path: '/harness/some-h/unpause', okKey: 'resumed' },
  { name: 'stop', def: stop, path: '/harness/some-h/stop', okKey: 'killed' },
];

describe('process-control routes — loopback gate (audit P-025)', () => {
  for (const c of CASES) {
    it(`${c.name} → 403 loopback_only from a non-loopback host, before project resolution`, async () => {
      const res = await post(c.def, `http://192.168.1.50:3070${c.path}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'loopback_only' });
      expect(resolvePhasedProject).not.toHaveBeenCalled();
    });

    it(`${c.name} → passes the gate from loopback (404 unknown project)`, async () => {
      resolvePhasedProject.mockResolvedValueOnce(null);
      const res = await post(c.def, `http://127.0.0.1:3070${c.path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'unknown project' });
      expect(resolvePhasedProject).toHaveBeenCalledOnce();
    });

    it(`${c.name} → 200 from loopback with an empty PID set (no real process matched)`, async () => {
      // A project path nothing on this box runs under: the /proc walk finds
      // no matching cwd, so the route returns ok with zero signalled PIDs —
      // a true 200-through-the-gate without firing any signal.
      resolvePhasedProject.mockResolvedValueOnce({
        path: '/tmp/papercusp-test-no-such-project-dir-p025',
      });
      const res = await post(c.def, `http://localhost${c.path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body[c.okKey]).toEqual([]);
    });
  }
});
