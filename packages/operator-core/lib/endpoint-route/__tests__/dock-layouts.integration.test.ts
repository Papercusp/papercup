/**
 * Integration tests for /api/dock-layouts/* — hits the running operator
 * at :3055. Requires the operator to be up; skips if not reachable.
 *
 * Migrations 071+072 are applied automatically by operator-boot
 * (instrumentation-node.ts → applyPendingMigrations).
 */

import { describe, expect, it, afterAll } from 'vitest';

// 127.0.0.1, not localhost: Node's fetch resolves `localhost` to ::1 (IPv6)
// first, but the operator binds IPv4 only — a `localhost` BASE makes the probe
// ECONNREFUSE and the suite skip even when the operator IS up (same trap the
// desktop devUrl + main.rs runtime-base avoid).
const BASE = process.env.OPERATOR_BASE ?? 'http://127.0.0.1:3055';
const TEST_LAYOUT = `vitest:dock-${Date.now()}`;
const TEST_SLUG = `vitest-slug-${Date.now()}`;

// Reachability probe at module load so `describe.skipIf` can genuinely SKIP the
// suite when no operator is up (CI / a dev box without `bin/dev`). The previous
// `it('skip if operator not reachable')` + `it.runIf(operatorUp || true)` +
// early-return pattern produced PASSING no-ops (and its console.warn failed the
// CI integration config that treats console output as an error — WI-123).
async function tryFetch(path: string): Promise<Response | null> {
  try {
    return await fetch(`${BASE}${path}`);
  } catch {
    return null;
  }
}

const probe = await tryFetch('/api/dock-layouts/default');
const operatorUp = !!probe && probe.ok;

afterAll(async () => {
  if (!operatorUp) return;
  await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
    method: 'DELETE',
  }).catch(() => {});
});

describe.skipIf(!operatorUp)('/api/dock-layouts integration', () => {
  it('GET seeds default layout on miss', async () => {
    const r = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.layoutName).toBe(TEST_LAYOUT);
    expect(body.schemaVersion).toBe(1);
    expect(body.layoutJson?.root).toBeDefined();
  });

  it('PUT then GET round-trip', async () => {
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

  it('PUT with bad schemaVersion → 400', async () => {
    const r = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: { schemaVersion: 99 } }),
    });
    expect(r.status).toBe(400);
  });

  it('PUT with If-Match: stale → 409', async () => {
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

  it('DELETE → GET reseeds', async () => {
    const del = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    const reseeded = await fetch(`${BASE}/api/dock-layouts/${encodeURIComponent(TEST_LAYOUT)}`);
    const body = await reseeded.json();
    expect(body.layoutJson.schemaVersion).toBe(1);
  });

  it('opaque schemaVersion=0 round-trips', async () => {
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

  it('phase-last-used: PUT then GET', async () => {
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

  it('phase-last-used: GET on unknown slug returns null', async () => {
    const r = await fetch(
      `${BASE}/api/harness-phase-last-used/${encodeURIComponent(`never-${Date.now()}`)}`,
    );
    const body = await r.json();
    expect(body.phase).toBeNull();
  });
});
