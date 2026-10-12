import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  diskEntries: [] as Array<{ path: string; mtimeMs: number; sizeBytes: number }>,
  catalogCalls: 0,
  ageCalls: 0,
  diskCalls: 0,
}));

function makeSql() {
  const sql: unknown = (strings: TemplateStringsArray) => {
    const query = Array.from(strings).join(' ');
    if (query.includes('pg_total_relation_size')) {
      h.catalogCalls += 1;
      return Promise.resolve([{ total_bytes: 1000n, rows_estimate: 100n }]);
    }
    return Promise.resolve([{ total: 80n, d30: 50n, d90: 30n, d365: 10n }]);
  };
  const s = sql as {
    unsafe: (q: string) => Promise<unknown[]>;
    begin: (fn: (x: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  s.unsafe = (q: string) => {
    if (q.includes('SET LOCAL')) return Promise.resolve([]);
    h.ageCalls += 1;
    return Promise.resolve([{ total: 80n, d30: 50n, d90: 30n, d365: 10n }]);
  };
  s.begin = (fn) => fn(sql);
  return sql;
}

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: makeSql() }),
}));
vi.mock('./disk', () => ({
  listDiskEntries: () => h.diskEntries,
  // computeStorageUsage now walks disk via the event-loop-cooperative async twin
  // (WI-5471); the sync export stays mocked for any direct caller.
  listDiskEntriesAsync: () => {
    h.diskCalls += 1;
    return Promise.resolve(h.diskEntries);
  },
}));

import {
  attributeOwnFiles,
  censusDepth,
  computeStorageUsage,
  deviceMountRoot,
  devToMajorMinor,
  DuTreeAccumulator,
  joinCensusGrowth,
  parseMountInfo,
  sortCensusRows,
  sumStorageUsageTotalBytes,
  TRIM_THRESHOLD_DAYS,
} from './usage';
import { STORAGE_CATEGORIES } from './categories';

beforeEach(() => {
  h.catalogCalls = 0;
  h.ageCalls = 0;
  h.diskCalls = 0;
  const now = Date.now();
  h.diskEntries = [
    { path: '/d/old', mtimeMs: now - 400 * 86400000, sizeBytes: 700 },
    { path: '/d/fresh', mtimeMs: now - 5 * 86400000, sizeBytes: 300 },
  ];
});

describe('computeStorageUsage', () => {
  it('returns one row per category', async () => {
    const rows = await computeStorageUsage();
    expect(rows.length).toBe(STORAGE_CATEGORIES.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('trimmable PG rows carry a cumulative distribution incl. a null=total bucket', async () => {
    const rows = await computeStorageUsage();
    const route = rows.find((r) => r.id === 'route-invocations')!;
    expect(route.trimmable).toBe(true);
    expect(route.totalBytes).toBe(1000);
    // one bucket per threshold + the total bucket
    expect(route.ageBuckets.length).toBe(TRIM_THRESHOLD_DAYS.length + 1);
    expect(route.ageBuckets.at(-1)!.olderThanDays).toBeNull();
    const b90 = route.ageBuckets.find((b) => b.olderThanDays === 90)!;
    expect(b90.rows).toBe(30);
    // perRow = 1000/80 → 30 rows ≈ 375 bytes
    expect(b90.bytes).toBe(Math.round((1000 / 80) * 30));
  });

  it('federated rows are read-only with no distribution', async () => {
    const rows = await computeStorageUsage();
    const plans = rows.find((r) => r.id === 'plans')!;
    expect(plans.trimmable).toBe(false);
    expect(plans.ageBuckets).toEqual([]);
  });

  it('disk rows size + bucket by mtime', async () => {
    const rows = await computeStorageUsage();
    const scratch = rows.find((r) => r.id === 'scratch')!;
    expect(scratch.kind).toBe('disk');
    expect(scratch.totalBytes).toBe(1000); // 700 + 300
    const b365 = scratch.ageBuckets.find((b) => b.olderThanDays === 365)!;
    expect(b365.rows).toBe(1); // only the 400-day entry
    expect(b365.bytes).toBe(700);
  });

  it('measures PG catalog totals before disk and age scans can exhaust the shared deadline', async () => {
    const pgCategoryCount = STORAGE_CATEGORIES.filter((category) => category.kind === 'pg').length;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (h.diskCalls > 0 ? 100 : 0));
    try {
      const rows = await computeStorageUsage({ deadlineMs: 50 });

      const pgRows = rows.filter((row) => row.kind === 'pg');
      expect(h.catalogCalls).toBe(pgCategoryCount);
      expect(pgRows.every((row) => row.totalBytes === 1000)).toBe(true);
      expect(h.ageCalls).toBe(0);
      expect(h.diskCalls).toBe(1);
      expect(rows.find((r) => r.id === 'scratch')?.totalBytes).toBe(1000);
      expect(rows.map((r) => r.id)).toEqual(STORAGE_CATEGORIES.map((r) => r.id));
    } finally {
      clock.mockRestore();
    }
  });

  it('uses one aggregate deadline and preserves partial rows when it is already exhausted', async () => {
    const rows = await computeStorageUsage({ deadlineMs: Date.now() - 1 });

    expect(rows).toHaveLength(STORAGE_CATEGORIES.length);
    expect(rows.every((row) => row.note?.includes('storage usage read deadline exhausted'))).toBe(true);
    expect(rows.every((row) => row.totalBytes === null)).toBe(true);
    expect(h.catalogCalls).toBe(0);
    expect(h.ageCalls).toBe(0);
  });

  it('measures only the requested category and skips unrelated disk scans', async () => {
    const rows = await computeStorageUsage({ categoryId: 'tool-invocations' });

    expect(rows.map((row) => row.id)).toEqual(['tool-invocations']);
    expect(h.catalogCalls).toBe(1);
    expect(h.ageCalls).toBe(1);
    expect(h.diskCalls).toBe(0);
  });

  it('rejects an unknown requested category instead of returning an empty success', async () => {
    await expect(computeStorageUsage({ categoryId: 'unknown-category' })).rejects.toThrow(
      'Unknown storage category: unknown-category',
    );
  });

  it('does not report a numeric aggregate when one category size is unknown', () => {
    expect(sumStorageUsageTotalBytes([{ totalBytes: 100 }, { totalBytes: null }])).toBeNull();
    expect(sumStorageUsageTotalBytes([{ totalBytes: 100 }, { totalBytes: 25 }])).toBe(125);
  });
});

// ── Disk consumer census, pure half (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1) ──
describe('disk consumer census attribution', () => {
  const G = 1024 ** 3;
  const M = 1024 ** 2;
  // du prints children before parents (post-order); this is the shape of
  // `du -x -0 -B1 --max-depth=3 /mnt/data` split on NUL.
  const duRecords = [
    `${12 * G}\t/mnt/data/offload/relcut-0026`,
    `${300 * M}\t/mnt/data/offload/small`,
    `${12 * G + 300 * M + 2 * G}\t/mnt/data/offload`, // 2 GiB of files directly in offload
    `${5 * G}\t/mnt/data/Backup/kopia`,
    `${5 * G}\t/mnt/data/Backup`,
    `${12 * G + 300 * M + 2 * G + 5 * G + 1024 * G}\t/mnt/data`, // + a 1 TiB swapfile at the root
  ];

  it('lists every directory at or above the floor with its depth below the mount', () => {
    const acc = new DuTreeAccumulator('/mnt/data', { floorBytes: G, maxDepth: 3 });
    for (const r of duRecords) acc.addRecord(r);
    const s = acc.result();
    expect(s.rootBytes).toBe(12 * G + 300 * M + 2 * G + 5 * G + 1024 * G);
    const byPath = new Map(s.consumers.map((c) => [c.consumer, c]));
    expect(byPath.get('/mnt/data/offload/relcut-0026')).toMatchObject({ kind: 'dir', depth: 2, bytes: 12 * G });
    expect(byPath.get('/mnt/data/Backup/kopia')).toMatchObject({ depth: 2, bytes: 5 * G });
    expect(byPath.get('/mnt/data')).toMatchObject({ depth: 0 });
    expect(byPath.has('/mnt/data/offload/small')).toBe(false); // under the floor
    expect(s.records).toBe(duRecords.length);
  });

  it("finds a directory's own files (size minus child directories) so a large file at any listed level is attributed", () => {
    const acc = new DuTreeAccumulator('/mnt/data', { floorBytes: G, maxDepth: 3 });
    for (const r of duRecords) acc.addRecord(r);
    const own = new Map(acc.result().ownFiles.map((o) => [o.dir, o]));
    expect(own.get('/mnt/data')?.bytes).toBe(1024 * G); // the swapfile
    expect(own.get('/mnt/data/offload')?.bytes).toBe(2 * G);
    expect(own.has('/mnt/data/Backup')).toBe(false); // all of Backup is its child directory
  });

  it('splits own files into named large files plus one remainder row', () => {
    const rows = attributeOwnFiles(
      { dir: '/mnt/data', depth: 0, bytes: 1026 * G },
      [
        { path: '/mnt/data/swapfile', bytes: 1024 * G },
        { path: '/mnt/data/notes.txt', bytes: 4096 },
      ],
      G,
    );
    expect(rows).toEqual([
      { consumer: '/mnt/data/swapfile', kind: 'file', depth: 1, bytes: 1024 * G },
      // The small file stays inside the remainder: only files at the floor get their own row.
      { consumer: '/mnt/data/*', kind: 'files', depth: 1, bytes: 2 * G },
    ]);
    expect(attributeOwnFiles({ dir: '/', depth: 0, bytes: 3 * G }, [], G)).toEqual([
      { consumer: '/*', kind: 'files', depth: 1, bytes: 3 * G },
    ]);
  });

  it('ignores records outside the mount root and malformed records', () => {
    const acc = new DuTreeAccumulator('/', { floorBytes: G, maxDepth: 2 });
    acc.addRecord('not-a-record');
    acc.addRecord('abc\t/home');
    acc.addRecord(`${2 * G}\t/home`);
    acc.addRecord(`${3 * G}\t/`);
    const s = acc.result();
    expect(s.records).toBe(2);
    expect(s.consumers.map((c) => [c.consumer, c.depth])).toEqual([['/home', 1], ['/', 0]]);
    expect(censusDepth('/mnt/data', '/mnt/database')).toBeNull();
    expect(censusDepth('/', '/home/a/b')).toBe(3);
  });

  it('computes 24h growth by consumer key, null when the consumer was not listed at the baseline', () => {
    const latest = [
      { consumer: '/var/lib/x', kind: 'dir' as const, depth: 3, bytes: 30 * G },
      { consumer: '/home/u/new', kind: 'dir' as const, depth: 3, bytes: 4 * G },
      { consumer: 'docker:volumes', kind: 'docker' as const, depth: 0, bytes: 20 * G },
    ];
    const baseline = [
      { consumer: '/var/lib/x', kind: 'dir' as const, depth: 3, bytes: 10 * G },
      { consumer: 'docker:volumes', kind: 'docker' as const, depth: 0, bytes: 25 * G },
    ];
    const rows = joinCensusGrowth(latest, baseline);
    expect(rows.map((r) => [r.consumer, r.growth24hBytes])).toEqual([
      ['/var/lib/x', 20 * G],
      ['/home/u/new', null],
      ['docker:volumes', -5 * G],
    ]);
    expect(joinCensusGrowth(latest, null).every((r) => r.baselineBytes === null && r.growth24hBytes === null)).toBe(true);
    expect(sortCensusRows(rows, 'growth').map((r) => r.consumer)).toEqual(['/var/lib/x', 'docker:volumes', '/home/u/new']);
    expect(sortCensusRows(rows, 'bytes').map((r) => r.consumer)).toEqual(['/var/lib/x', 'docker:volumes', '/home/u/new']);
  });

  it('resolves a bind-mounted subdirectory to the mount that shows the whole device', () => {
    const mountinfo = [
      '26 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
      '40 26 259:0 /tmpdir /tmp rw,relatime shared:20 - xfs /dev/nvme1n1 rw',
      '41 26 259:0 / /mnt/data rw,relatime shared:21 - xfs /dev/nvme1n1 rw',
      '42 26 0:5 / /dev\\040space rw - devtmpfs udev rw',
    ].join('\n');
    const entries = parseMountInfo(mountinfo);
    expect(deviceMountRoot(entries, '259:0')).toBe('/mnt/data');
    expect(deviceMountRoot(entries, '259:2')).toBe('/');
    expect(deviceMountRoot(entries, '8:1')).toBeNull();
    expect(entries.find((e) => e.majorMinor === '0:5')?.mountPoint).toBe('/dev space');
    expect(devToMajorMinor(66304)).toBe('259:0');
    expect(devToMajorMinor(66306)).toBe('259:2');
  });
});
