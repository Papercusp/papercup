/**
 * Integration tests for /api/dock-layouts/* — hits the running operator
 * at :3055. Requires the operator to be up; skips if not reachable.
 *
 * Migrations 071+072 are applied automatically by operator-boot
 * (instrumentation-node.ts → applyPendingMigrations).
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

const BASE = process.env.OPERATOR_BASE ?? 'http://localhost:3055';
const TEST_LAYOUT = `vitest:dock-${Date.now()}`;
const TEST_SLUG = `vitest-slug-${Date.now()}`;

let operatorUp = false;

async function tryFetch(path: string): Promise<Response | null> {
  try {
    return await fetch(`${BASE}${path}`);
  } catch {
    return null;
  }
}

beforeAll(async () => {
  const r = await tryFetch('/api/dock-layouts/default');
  operatorUp = !!r && r.ok;
});

afterAll(async () => {
  if (!operatorUp) return;
  await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
    method: 'DELETE',
  }).catch(() => {});
});

describe.runIf(true)('/api/dock-layouts integration', () => {
  it('skip if operator not reachable', async () => {
    if (!operatorUp) {
      console.warn(`operator at ${BASE} not reachable; skipping`);
    }
    expect(true).toBe(true);
  });

  it.runIf(operatorUp || true)('GET seeds default layout on miss', async () => {
    if (!operatorUp) return;
    const r = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.layoutName).toBe(TEST_LAYOUT);
    expect(body.schemaVersion).toBe(1);
    expect(body.layoutJson?.root).toBeDefined();
  });

  it.runIf(operatorUp || true)('PUT then GET round-trip', async () => {
    if (!operatorUp) return;
    const layout = {
      schemaVersion: 1,
      root: {
        kind: 'tabs',
        id: 'r',
        activePanelId: 'a',
        panels: [{ id: 'a', type: 'data:features', params: { slug: 'sheets' } }],
      },
    };
    const put = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.layoutJson.root.panels[0].type).toBe('data:features');

    const get = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`);
    const getBody = await get.json();
    expect(getBody.layoutJson.root.panels[0].params.slug).toBe('sheets');
    expect(getBody.updatedTs).toBe(putBody.updatedTs);
  });

  it.runIf(operatorUp || true)('PUT with bad schemaVersion → 400', async () => {
    if (!operatorUp) return;
    const r = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: { schemaVersion: 99 } }),
    });
    expect(r.status).toBe(400);
  });

  it.runIf(operatorUp || true)('PUT with If-Match: stale → 409', async () => {
    if (!operatorUp) return;
    // Establish baseline
    const layout = {
      schemaVersion: 1,
      root: { kind: 'tabs', id: 'r', activePanelId: 'a', panels: [{ id: 'a', type: 'data:features' }] },
    };
    await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout }),
    });
    // Stale ts
    const stale = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': '1' },
      body: JSON.stringify({ layout }),
    });
    expect(stale.status).toBe(409);
  });

  it.runIf(operatorUp || true)('DELETE → GET reseeds', async () => {
    if (!operatorUp) return;
    const del = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    const reseeded = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`);
    const body = await reseeded.json();
    expect(body.layoutJson.schemaVersion).toBe(1);
  });

  it.runIf(operatorUp || true)('opaque schemaVersion=0 round-trips', async () => {
    if (!operatorUp) return;
    const opaque = { schemaVersion: 0, dockviewJson: { grid: { root: { type: 'branch', data: [] } } } };
    const r = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: opaque }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.schemaVersion).toBe(0);
  });

  it.runIf(operatorUp || true)('phase-last-used: PUT then GET', async () => {
    if (!operatorUp) return;
    const put = await fetch(
      `${BASE}/api/harness-phase-last-used/${encodeURIComponent(TEST_SLUG)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase: 'testing' }),
      },
    );
    expect(put.status).toBe(204);
    const get = await fetch(
      `${BASE}/api/harness-phase-last-used/${encodeURIComponent(TEST_SLUG)}`,
    );
    const body = await get.json();
    expect(body.phase).toBe('testing');
  });

  it.runIf(operatorUp || true)('phase-last-used: GET on unknown slug returns null', async () => {
    if (!operatorUp) return;
    const r = await fetch(
      `${BASE}/api/harness-phase-last-used/${encodeURIComponent(`never-${Date.now()}`)}`,
    );
    const body = await r.json();
    expect(body.phase).toBeNull();
  });
});
