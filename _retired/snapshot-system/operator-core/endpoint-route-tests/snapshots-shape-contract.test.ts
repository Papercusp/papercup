/**
 * GET /api/snapshots and GET /api/snapshots/:id must agree on a flat
 * top-level shape. Pinned because the 2026-04-30 E2E found a divergence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../snapshot-discovery', () => ({
  listAllSnapshots: vi.fn(),
  findSnapshot: vi.fn(),
}));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));
vi.mock('../../require-flag', () => ({
  gateApiRoute: vi.fn(async () => null),
}));

import { Hono } from 'hono';
import * as discovery from '../../snapshot-discovery';
import { registerAllRoutes } from '../register';

const FIXTURE = {
  id: 'snap_test',
  harnessSlug: 'sheets',
  bytes: 12345,
  createdAtMs: 1777000000000,
  tarballPath: '/tmp/snap_test.tar.gz',
  publishes: [],
  manifest: {
    schemaVersion: 1,
    kind: 'snapshot' as const,
    id: 'snap_test',
    name: 'fixture-snapshot',
    description: 'a fixture for the contract test',
    harnessSlug: 'sheets',
    substrateVersion: '0.0.1',
    minSubstrateVersion: '0.0.1',
    template: { name: 'sheets', version: '0.0.0' },
    createdAt: 1777000000000,
    files: [
      { path: 'a', sha256: 'x'.repeat(64), bytes: 1 },
      { path: 'b', sha256: 'y'.repeat(64), bytes: 2 },
    ],
    excluded: [{ path: '.env', reason: 'denylist:secret' }],
    plugins: [{ name: 'p', version: '0.1.0', capabilities: [], configJson: '{}' }],
    partial: false,
    license: 'MIT',
    redactions: { blockedSecretsTier: 'none' as const, verifiedHits: 0, highRecallHits: 0 },
  },
};

const FLAT_FIELDS = [
  'id', 'harnessSlug', 'bytes', 'createdAtMs', 'name', 'description', 'template',
  'filesCount', 'excludedCount', 'pluginsCount', 'partial', 'license', 'redactions', 'publishes',
] as const;

let app: Hono;

beforeEach(() => {
  vi.mocked(discovery.listAllSnapshots).mockResolvedValue([FIXTURE as any]);
  vi.mocked(discovery.findSnapshot).mockResolvedValue(FIXTURE as any);
  app = new Hono().basePath('/api');
  registerAllRoutes(app);
});

describe('snapshot list/detail shape contract', () => {
  it('list endpoint exposes every flat field', async () => {
    const res = await app.request('/api/snapshots');
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
    for (const k of FLAT_FIELDS) {
      expect(body.snapshots[0], `list missing flat field "${k}"`).toHaveProperty(k);
    }
  });

  it('detail endpoint exposes every flat field at the SAME path', async () => {
    const res = await app.request('/api/snapshots/snap_test');
    const body = await res.json();
    expect(body.ok).toBe(true);
    for (const k of FLAT_FIELDS) {
      expect(body.snapshot, `detail missing flat field "${k}"`).toHaveProperty(k);
    }
  });

  it('list and detail emit identical values for every shared flat field', async () => {
    const listRow = (await (await app.request('/api/snapshots')).json()).snapshots[0];
    const detail = (await (await app.request('/api/snapshots/snap_test')).json()).snapshot;
    for (const k of FLAT_FIELDS) {
      expect(detail[k], `field "${k}" differs between list and detail`).toEqual(listRow[k]);
    }
  });

  it('detail keeps the full manifest nested; list only counts', async () => {
    const detail = (await (await app.request('/api/snapshots/snap_test')).json()).snapshot;
    expect(detail.manifest.files).toHaveLength(2);
    expect(detail.manifest.excluded).toHaveLength(1);
    expect(detail.manifest.plugins).toHaveLength(1);
    const listRow = (await (await app.request('/api/snapshots')).json()).snapshots[0];
    expect(listRow).not.toHaveProperty('manifest');
    expect(listRow.filesCount).toBe(2);
    expect(listRow.excludedCount).toBe(1);
    expect(listRow.pluginsCount).toBe(1);
  });

  it('detail returns 404 when the snapshot is unknown', async () => {
    vi.mocked(discovery.findSnapshot).mockResolvedValue(null);
    const res = await app.request('/api/snapshots/missing');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
