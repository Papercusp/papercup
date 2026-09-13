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

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: makeSql() }) }));
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
vi.mock('../session-dir-gc', () => ({
  defaultSessionDirRoots: () => [],
  discoverSessionDirCandidates: () => [],
  planSessionDirGc: () => ({ remove: [], keptProtected: [], keptFresh: [] }),
}));

import { pruneStorageCategory } from './prune';
import { getStorageCategory, isTrimmable } from './categories';

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

  it('describes non-vacuum reclaim as logical reuse, not measured OS shrink', async () => {
    h.statsQueue = [{ b: 1000, r: 100 }, { b: 1000, r: 100 }];
    h.deleteQueue = [40];
    const r = await pruneStorageCategory(REQ());
    expect(r.reclaimEstimated).toBe(true);
    expect(r.reclaimedBytes).toBe(400);
    expect(r.note).toContain('space freed for reuse');
    expect(r.note).toMatch(/relation\/OS bytes are not guaranteed to shrink/);
    expect(r.note).toMatch(/table rewrite or truncation/);
    expect(r.note).not.toContain('returns it to the OS');
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

// EI-11379: storage:prune used to run the chunked delete unbounded, so a
// multi-million-row trim committed part of the delete and then blew past the
// ~55s MCP transport envelope with no usable result. It now stops at a
// wall-time budget and returns { removed, totalRemaining, complete, continuation }
// so the caller can replay the SAME args (idempotently) until complete.
// `FULL_CHUNK` == the internal CHUNK batch size in prune.ts — a delete returning
// exactly this many rows does NOT drain the eligible set, so the loop continues
// to the budget check (which `timeBudgetMs: 0` trips after the first chunk).
const FULL_CHUNK = 10_000;

describe('pruneStorageCategory — wall-time budget + continuation (EI-11379)', () => {
  it('uses a transport-safe default wall-time budget', async () => {
    h.statsQueue = [{ b: 100_000, r: 10_000 }];
    h.deleteQueue = [FULL_CHUNK, FULL_CHUNK];
    h.countMatched = 12_345;
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(27_000);
    try {
      const r = await pruneStorageCategory(REQ());
      expect(r.partial).toBe(true);
      expect(r.complete).toBe(false);
      expect(r.removed).toBe(FULL_CHUNK);
      expect(r.totalRemaining).toBe(12_345);
      expect(r.continuation).toEqual({ categoryId: 'route-invocations', olderThanDays: 90 });
      expect(h.deleteQueue.length).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it('returns a continuation (not the whole delete) when the wall-time budget is hit mid-drain', async () => {
    h.statsQueue = [{ b: 100_000, r: 10_000 }]; // perRow 10
    // Two full chunks are queued, but timeBudgetMs:0 stops after the FIRST —
    // proof the call returns promptly instead of draining past the envelope.
    h.deleteQueue = [FULL_CHUNK, FULL_CHUNK];
    h.countMatched = 12_345; // rows still matching after the partial delete
    const r = await pruneStorageCategory(REQ({ timeBudgetMs: 0 }));
    expect(r.ok).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.removed).toBe(FULL_CHUNK); // exactly ONE chunk — did not drain the queue
    expect(r.totalRemaining).toBe(12_345);
    expect(r.continuation).toEqual({ categoryId: 'route-invocations', olderThanDays: 90 });
    expect(r.note).toMatch(/re-run with the same/);
    expect(h.deleteQueue.length).toBe(1); // the second queued chunk was NOT consumed
  });

  it('marks a fully-drained trim complete with no continuation', async () => {
    h.statsQueue = [{ b: 1000, r: 100 }];
    h.deleteQueue = [40]; // < CHUNK → drained in one batch
    const r = await pruneStorageCategory(REQ());
    expect(r.removed).toBe(40);
    expect(r.complete).toBe(true);
    expect(r.partial).toBeFalsy();
    expect(r.totalRemaining).toBe(0);
    expect(r.continuation).toBeUndefined();
  });

  it('repeated continuation calls reach complete with no duplicate accounting', async () => {
    // Call 1 — budget trips after one chunk; 15k still eligible.
    h.statsQueue = [{ b: 250_000, r: 25_000 }];
    h.deleteQueue = [FULL_CHUNK, FULL_CHUNK];
    h.countMatched = 15_000;
    const r1 = await pruneStorageCategory(REQ({ timeBudgetMs: 0 }));
    expect(r1.removed).toBe(FULL_CHUNK);
    expect(r1.partial).toBe(true);
    expect(r1.complete).toBe(false);
    expect(r1.totalRemaining).toBe(15_000);
    expect(r1.continuation).toBeTruthy();

    // Call 2 — replay the EXACT continuation args; drains the remainder.
    h.statsQueue = [{ b: 150_000, r: 15_000 }];
    h.deleteQueue = [FULL_CHUNK, 5_000]; // 10k then 5k (< CHUNK) → complete
    h.countMatched = 0;
    const r2 = await pruneStorageCategory(
      REQ({ categoryId: r1.continuation!.categoryId, olderThanDays: r1.continuation!.olderThanDays }),
    );
    expect(r2.removed).toBe(15_000);
    expect(r2.complete).toBe(true);
    expect(r2.partial).toBeFalsy();
    expect(r2.totalRemaining).toBe(0);
    expect(r2.continuation).toBeUndefined();

    // No double-counting: the two calls together removed the eligible set exactly once.
    expect(r1.removed + r2.removed).toBe(25_000);
  });

  it('defers VACUUM FULL while a bloat-queue trim is still partial', async () => {
    h.statsQueue = [{ b: 100_000, r: 10_000 }];
    h.deleteQueue = [FULL_CHUNK, FULL_CHUNK];
    h.countMatched = 5_000; // still remaining → partial
    const r = await pruneStorageCategory(
      REQ({ categoryId: 'substrate-outbox', olderThanDays: 30, timeBudgetMs: 0 }),
    );
    expect(r.partial).toBe(true);
    expect(r.vacuumed).toBe(false);
    expect(h.vacuumCalls.length).toBe(0); // VACUUM deferred to the final draining call
    expect(r.continuation).toBeTruthy();
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

  // The in-flight guard used to live ONLY on the `olderThanDays: null` branch, which
  // inverted the safety: asking for an explicit 0 was less protected than asking to
  // delete everything, and could unlink an entry written seconds ago.
  it('applies the in-flight guard to an EXPLICIT age request, not just to "all"', async () => {
    const now = Date.now();
    h.diskEntries = [{ path: '/s/just-written', mtimeMs: now - 30_000, sizeBytes: 100 }];
    const r = await pruneStorageCategory(REQ({ categoryId: 'scratch', olderThanDays: 0, dryRun: true }));
    expect(r.removed).toBe(0);
    expect(r.note).toMatch(/in-flight/);
  });

  it('still removes an entry past the in-flight guard on an explicit 0', async () => {
    const now = Date.now();
    h.diskEntries = [{ path: '/s/stale', mtimeMs: now - 10 * 60_000, sizeBytes: 100 }];
    const r = await pruneStorageCategory(REQ({ categoryId: 'scratch', olderThanDays: 0, dryRun: true }));
    expect(r.removed).toBe(1);
  });
});

describe('pruneStorageCategory — wake-spills retention floor', () => {
  it('is registered as a trimmable local disk category', () => {
    const cat = getStorageCategory('wake-spills');
    expect(cat).toBeDefined();
    expect(cat!.kind).toBe('disk');
    expect(isTrimmable(cat!)).toBe(true);
  });

  // The floor is declared on the shared DiskStorageCategory and the module contract
  // says disk trims honour it, but only the session-dirs path ever read it — so a
  // floor on a plain store was decorative. A spill is the only copy of a wake's full
  // text, so an unfloored trim can delete it before its recipient takes a turn.
  it('refuses to trim inside the declared floor even when asked for 0 days', async () => {
    const now = Date.now();
    h.diskEntries = [{ path: '/w/su-recent', mtimeMs: now - 2 * 86400000, sizeBytes: 4096 }];
    const r = await pruneStorageCategory(
      REQ({ categoryId: 'wake-spills', olderThanDays: 0, dryRun: true }),
    );
    expect(r.removed).toBe(0);
    expect(r.reclaimedBytes).toBe(0);
    expect(r.note).toMatch(/floored to 3d/);
  });

  it('collects an owner directory that has aged past the floor', async () => {
    const now = Date.now();
    h.diskEntries = [
      { path: '/w/su-dead', mtimeMs: now - 47 * 86400000, sizeBytes: 748_000 },
      { path: '/w/su-live', mtimeMs: now - 60_000, sizeBytes: 2048 },
    ];
    const r = await pruneStorageCategory(
      REQ({ categoryId: 'wake-spills', olderThanDays: 7, dryRun: true }),
    );
    expect(r.removed).toBe(1);
    expect(r.reclaimedBytes).toBe(748_000);
    // 7d was already stricter than the 3d floor, so nothing was overridden.
    expect(r.note).toBeUndefined();
  });

  it('never deletes everything on an "all" request — the floor still applies', async () => {
    const now = Date.now();
    h.diskEntries = [{ path: '/w/su-yesterday', mtimeMs: now - 86400000, sizeBytes: 512 }];
    const r = await pruneStorageCategory(
      REQ({ categoryId: 'wake-spills', olderThanDays: null, dryRun: true }),
    );
    expect(r.removed).toBe(0);
  });
});
