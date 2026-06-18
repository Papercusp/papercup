import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ── Mocks (hoisted above the module body) ─────────────────────────────── */
const h = vi.hoisted(() => ({
  statsQueue: [] as Array<{ b: number; r: number }>,
  deleteQueue: [] as number[],
  countMatched: 0,
  vacuumCalls: [] as string[],
  guardAcquired: true,
  diskEntries: [] as Array<{ path: string; mtimeMs: number; sizeBytes: number }>,
}));

function makeSql() {
  // tagged template = relationStats (returns {b,r}); .unsafe handles count / delete / vacuum.
  const sql: unknown = () => Promise.resolve([h.statsQueue.shift() ?? { b: 0, r: 0 }]);
  const s = sql as { unsafe: (q: string) => Promise<unknown[]>; begin: (fn: (x: unknown) => Promise<unknown>) => Promise<unknown> };
  s.unsafe = (q: string) => {
    if (q.includes('WITH del')) return Promise.resolve([{ n: h.deleteQueue.shift() ?? 0 }]);
    if (q.includes('count(*)')) return Promise.resolve([{ n: h.countMatched }]);
    if (q.includes('VACUUM')) {
      h.vacuumCalls.push(q);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  s.begin = (fn) => fn(sql);
  return sql;
}

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: makeSql() }) }));
vi.mock('../agent-tools/locks/resource-lock-guard', () => ({
  guardResource: async (_spec: unknown, run: (f: unknown) => Promise<unknown>) =>
    h.guardAcquired
      ? { acquired: true, result: await run({}), lock_id: 'x' }
      : { acquired: false, reason: 'busy', holders: [] },
}));
vi.mock('./disk', () => ({
  listDiskEntries: () => h.diskEntries,
  dirSizeBytes: () => 0,
  gatherProtectedSessionIdentity: async () => ({ ok: true, identity: { ownerIds: new Set(), sessionKeys: new Set() } }),
}));
vi.mock('./session-dir-gc', () => ({
  defaultSessionDirRoots: () => [],
  discoverSessionDirCandidates: () => [],
  planSessionDirGc: () => ({ remove: [], keptProtected: [], keptFresh: [] }),
}));

import { pruneStorageCategory } from './prune';

const REQ = (over: Record<string, unknown> = {}) => ({
  categoryId: 'route-invocations',
  olderThanDays: 90 as number | null,
  dryRun: false,
  workspaceId: 'ws-test',
  ...over,
});

beforeEach(() => {
  h.statsQueue = [];
  h.deleteQueue = [];
  h.countMatched = 0;
  h.vacuumCalls = [];
  h.guardAcquired = true;
  h.diskEntries = [];
});

describe('pruneStorageCategory — guards', () => {
  it('refuses federated categories', async () => {
    const r = await pruneStorageCategory(REQ({ categoryId: 'plans', dryRun: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('federated_not_trimmable');
  });
  it('rejects unknown categories', async () => {
    const r = await pruneStorageCategory(REQ({ categoryId: 'nope' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown_category');
  });
  it('rejects invalid day counts', async () => {
    expect((await pruneStorageCategory(REQ({ olderThanDays: -5 }))).reason).toBe('invalid_older_than_days');
    expect((await pruneStorageCategory(REQ({ olderThanDays: 1.5 }))).reason).toBe('invalid_older_than_days');
  });
});

describe('pruneStorageCategory — PG', () => {
  it('dry-run returns matched count + proportional estimate, deletes nothing', async () => {
    h.statsQueue = [{ b: 1000, r: 100 }];
    h.countMatched = 40;
    const r = await pruneStorageCategory(REQ({ dryRun: true }));
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(40);
    expect(r.reclaimedBytes).toBe(400); // perRow 10 * 40
    expect(r.reclaimEstimated).toBe(true);
    expect(h.deleteQueue.length).toBe(0); // nothing consumed
  });

  it('executes a chunked delete and does NOT vacuum a non-bloat table', async () => {
    h.statsQueue = [{ b: 1000, r: 100 }, { b: 1000, r: 100 }];
    h.deleteQueue = [40]; // one batch < CHUNK → stop
    const r = await pruneStorageCategory(REQ());
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(40);
    expect(r.vacuumed).toBe(false);
    expect(h.vacuumCalls.length).toBe(0);
    expect(r.reclaimEstimated).toBe(true);
    expect(r.reclaimedBytes).toBe(400);
  });

  it('vacuums a bloat-queue table and measures actual reclaim', async () => {
    h.statsQueue = [{ b: 1000, r: 100 }, { b: 600, r: 60 }]; // before, after
    h.deleteQueue = [40];
    const r = await pruneStorageCategory(REQ({ categoryId: 'substrate-outbox', olderThanDays: 30 }));
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(40);
    expect(r.vacuumed).toBe(true);
    expect(h.vacuumCalls.some((q) => q.includes('VACUUM (FULL, ANALYZE)'))).toBe(true);
    expect(r.reclaimedBytes).toBe(400); // 1000 - 600
    expect(r.reclaimEstimated).toBe(false);
  });

  it('keeps the rows deleted when the VACUUM lock is busy (best-effort)', async () => {
    h.statsQueue = [{ b: 1000, r: 100 }];
    h.deleteQueue = [40];
    h.guardAcquired = false;
    const r = await pruneStorageCategory(REQ({ categoryId: 'substrate-outbox', olderThanDays: 30 }));
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(40);
    expect(r.vacuumed).toBe(false);
    expect(r.note).toMatch(/VACUUM FULL skipped/);
  });
});

describe('pruneStorageCategory — disk (plain store)', () => {
  it('removes entries older than the cutoff, sums reclaim (dry-run)', async () => {
    const now = Date.now();
    h.diskEntries = [
      { path: '/s/old', mtimeMs: now - 40 * 86400000, sizeBytes: 500 },
      { path: '/s/fresh', mtimeMs: now - 10 * 86400000, sizeBytes: 300 },
    ];
    const r = await pruneStorageCategory(REQ({ categoryId: 'scratch', olderThanDays: 30, dryRun: true }));
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(1);
    expect(r.reclaimedBytes).toBe(500);
  });
});
