/**
 * Locks in the contract that GET /api/snapshots and GET /api/snapshots/[id]
 * agree on the flat top-level shape. The 2026-04-30 snapshot E2E test surfaced
 * a divergence — list flattened manifest fields (name/description/license/
 * filesCount/etc.) while detail kept everything nested under
 * `snapshot.manifest`, forcing API consumers to know two contracts.
 *
 * The fix augments detail with the same flat fields. If someone later strips
 * a field from one endpoint without the other, this test fails.
 *
 * We exercise the handlers directly with mocked snapshot-discovery so the
 * test is self-contained (no fs / no live server).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/snapshot-discovery', () => ({
  listAllSnapshots: vi.fn(),
  findSnapshot: vi.fn(),
}));

import { GET as listGET } from './route';
import { GET as detailGET } from './[id]/route';
import * as discovery from '@/lib/snapshot-discovery';

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

beforeEach(() => {
  vi.mocked(discovery.listAllSnapshots).mockResolvedValue([FIXTURE as any]);
  vi.mocked(discovery.findSnapshot).mockResolvedValue(FIXTURE as any);
});

const FLAT_FIELDS = [
  'id',
  'harnessSlug',
  'bytes',
  'createdAtMs',
  'name',
  'description',
  'template',
  'filesCount',
  'excludedCount',
  'pluginsCount',
  'partial',
  'license',
  'redactions',
  'publishes',
] as const;

describe('snapshot list/detail shape contract', () => {
  it('list endpoint exposes every flat field', async () => {
    const res = await listGET();
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
    const row = body.snapshots[0];
    for (const k of FLAT_FIELDS) {
      expect(row, `list missing flat field "${k}"`).toHaveProperty(k);
    }
  });

  it('detail endpoint exposes every flat field at the SAME path', async () => {
    const res = await detailGET(new Request('http://test/'), {
      params: Promise.resolve({ id: 'snap_test' }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    for (const k of FLAT_FIELDS) {
      expect(body.snapshot, `detail missing flat field "${k}"`).toHaveProperty(k);
    }
  });

  it('list and detail emit identical values for every shared flat field', async () => {
    const listRes = await listGET();
    const listRow = (await listRes.json()).snapshots[0];

    const detRes = await detailGET(new Request('http://test/'), {
      params: Promise.resolve({ id: 'snap_test' }),
    });
    const detail = (await detRes.json()).snapshot;

    for (const k of FLAT_FIELDS) {
      expect(detail[k], `field "${k}" differs between list and detail`)
        .toEqual(listRow[k]);
    }
  });

  it('detail keeps the full manifest nested for callers who need files[]/excluded[]/plugins[]', async () => {
    const detRes = await detailGET(new Request('http://test/'), {
      params: Promise.resolve({ id: 'snap_test' }),
    });
    const detail = (await detRes.json()).snapshot;
    expect(detail.manifest).toBeTruthy();
    expect(detail.manifest.files).toHaveLength(2);
    expect(detail.manifest.excluded).toHaveLength(1);
    expect(detail.manifest.plugins).toHaveLength(1);
    // List does NOT include these arrays — only the counts
    const listRes = await listGET();
    const listRow = (await listRes.json()).snapshots[0];
    expect(listRow).not.toHaveProperty('manifest');
    expect(listRow.filesCount).toBe(2);
    expect(listRow.excludedCount).toBe(1);
    expect(listRow.pluginsCount).toBe(1);
  });

  it('detail returns 404 when the snapshot is unknown', async () => {
    vi.mocked(discovery.findSnapshot).mockResolvedValue(null);
    const res = await detailGET(new Request('http://test/'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
