import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { workspaceContextMiddleware } from './workspace-context-middleware';
import { activeWorkspaceId } from './workspace-registry';

// A real temp registry so the middleware's known-workspace check (D-007) is
// exercised end-to-end, not mocked.
let root: string;
let prevRoot: string | undefined;

function makeApp() {
  const app = new Hono();
  app.use('*', workspaceContextMiddleware);
  app.get('/probe', (c) => c.json({ ws: activeWorkspaceId() }));
  return app;
}

beforeAll(() => {
  prevRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  root = mkdtempSync(join(tmpdir(), 'pcws-mw-'));
  writeFileSync(
    join(root, 'registry.json'),
    JSON.stringify({
      current: 'ws-default',
      workspaces: [
        { id: 'ws-default', name: 'Default', createdAt: 1 },
        { id: 'ws-known', name: 'Known', createdAt: 2 },
      ],
    }),
  );
  process.env.PAPERCUSP_WORKSPACES_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
  else process.env.PAPERCUSP_WORKSPACES_ROOT = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('workspaceContextMiddleware (per-window-workspace-context P-011)', () => {
  it('no header → falls back to the global active workspace', async () => {
    const res = await makeApp().request('/probe');
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('ws-default');
  });

  it('known header → request resolves to that workspace', async () => {
    const res = await makeApp().request('/probe', {
      headers: { 'x-papercusp-workspace': 'ws-known' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('ws-known');
  });

  it('present-but-unknown header → 400 (D-007), never a silent fallback', async () => {
    const res = await makeApp().request('/probe', {
      headers: { 'x-papercusp-workspace': 'ws-bogus' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown_workspace');
    expect(body.workspace).toBe('ws-bogus');
  });

  it('the literal default workspace is always accepted', async () => {
    const res = await makeApp().request('/probe', {
      headers: { 'x-papercusp-workspace': 'default' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('default');
  });

  // Streams (EventSource/WS) can't set a custom header, so the workspace
  // rides as a ?ws= query param on connect (per-window-workspace-context P-015).
  it('falls back to the ?ws= query param when no header is present (stream connect)', async () => {
    const res = await makeApp().request('/probe?ws=ws-known');
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('ws-known');
  });

  it('rejects an unknown ?ws= query param too (D-007)', async () => {
    const res = await makeApp().request('/probe?ws=ws-bogus');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown_workspace');
  });

  it('the header wins over ?ws= when both are present', async () => {
    const res = await makeApp().request('/probe?ws=ws-default', {
      headers: { 'x-papercusp-workspace': 'ws-known' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('ws-known');
  });
});
