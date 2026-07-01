/**
 * P-060 (per-window-workspace-context-2026-05-31) — two-window isolation.
 *
 * The headline correctness claim: many concurrent requests on DIFFERENT
 * workspaces (= many desktop windows hitting the one shared sidecar) resolve
 * each to its OWN workspace with no cross-talk, even when their handlers
 * interleave across `await` boundaries. This drives the real middleware +
 * `activeWorkspaceId()` + the workspace ALS through Hono, against a temp
 * registry so each workspace is "known".
 *
 * The data-scoping half follows by construction: `routeWithWorkspace(fn)` is
 * `withWorkspace(activeWorkspaceId(), fn)` (route-workspace.ts) → a per-tx
 * `SET LOCAL app.workspace_id`, so each request's PG GUC is exactly the value
 * proven here. RLS isolation of two SET-LOCAL txns is guaranteed by Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { workspaceContextMiddleware } from './workspace-context-middleware';
import { activeWorkspaceId } from './workspace-registry';

const WORKSPACES = ['ws-a', 'ws-b', 'ws-c', 'ws-d', 'ws-e'];
let root: string;
let prevRoot: string | undefined;

function makeApp() {
  const app = new Hono();
  app.use('*', workspaceContextMiddleware);
  // Resolve the workspace, yield the event loop (forcing interleave with other
  // in-flight requests), then resolve again — both must equal this request's
  // workspace if the ALS truly isolates concurrent contexts.
  app.get('/probe', async (c) => {
    const before = activeWorkspaceId();
    const d = Number(c.req.query('d') ?? 0);
    await new Promise((r) => setTimeout(r, d));
    const after = activeWorkspaceId();
    return c.json({ before, after });
  });
  return app;
}

beforeAll(() => {
  prevRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  root = mkdtempSync(join(tmpdir(), 'pcws-2win-'));
  writeFileSync(
    join(root, 'registry.json'),
    JSON.stringify({
      current: 'ws-a',
      workspaces: WORKSPACES.map((id, i) => ({ id, name: id, createdAt: i + 1 })),
    }),
  );
  process.env.PAPERCUSP_WORKSPACES_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
  else process.env.PAPERCUSP_WORKSPACES_ROOT = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('P-060: concurrent per-window isolation (no cross-talk)', () => {
  it('50 interleaved concurrent requests each resolve their own workspace', async () => {
    const app = makeApp();
    const N = 50;
    const inflight = Array.from({ length: N }, (_, i) => {
      const ws = WORKSPACES[i % WORKSPACES.length];
      // Earlier requests wait LONGER so they finish after later ones — this
      // guarantees the handlers interleave across the await, which is exactly
      // where a leaky context would surface.
      const d = (N - i) % 11;
      return Promise.resolve(
        app.request(`/probe?d=${d}`, { headers: { 'x-papercusp-workspace': ws } }),
      ).then(async (r) => ({ ws, status: r.status, body: (await r.json()) as { before: string; after: string } }));
    });
    const results = await Promise.all(inflight);

    for (const { ws, status, body } of results) {
      expect(status).toBe(200);
      expect(body.before).toBe(ws); // resolved correctly at entry
      expect(body.after).toBe(ws); // ...and still correct after the interleaved await
    }
    // Sanity: all five workspaces were actually exercised.
    expect(new Set(results.map((r) => r.ws)).size).toBe(WORKSPACES.length);
  });

  it('a header-less request among them resolves the global, not a neighbor', async () => {
    const app = makeApp();
    const [withHdr, noHdr] = await Promise.all([
      Promise.resolve(
        app.request('/probe?d=8', { headers: { 'x-papercusp-workspace': 'ws-d' } }),
      ).then((r) => r.json()),
      Promise.resolve(app.request('/probe?d=2')).then((r) => r.json()),
    ]);
    expect(withHdr.after).toBe('ws-d');
    expect(noHdr.after).toBe('ws-a'); // registry.current, never ws-d
  });
});
