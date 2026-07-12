/**
 * journal-surfacing.test.ts — user-facing surfacing for the memory write-ahead
 * journal (memory-write-journal-auto-recovery P-006), task #36 hardening.
 * journal-surfacing.ts had NO test — the recovery BADGE + BANNER a public user
 * sees after a memory outage were unguarded.
 *
 * Invariants pinned here:
 *  1. BADGE never NaN: ::text counts parse to Numbers; a missing row degrades to 0.
 *  2. BANNER guard (never render a partial/empty window): lastRecovery is null unless
 *     a row was genuinely recovered (n>0) AND from/to/lastAt are ALL present — a
 *     partial aggregate must not surface "recovered N facts from null – null".
 *  3. The recovery query reports only facts that ARRIVED LATE: committed, attempts>=1
 *     (excludes live-path writes), non-deduped (excludes dedup closures), last 24h.
 *  4. The post-drain push is BEST-EFFORT: a throw in notifySyncInvalidate is swallowed
 *     — surfacing must NEVER fail the drain.
 *
 * Run: cd packages/operator-core && npx vitest run lib/memory/journal-surfacing.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  notifySync: vi.fn(),
  state: { counts: [] as Row[], rec: [] as Row[], calls: [] as string[] },
}));

// getOrgPg().sql is a tagged-template fn; route the two queries by their literal SQL.
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray) => {
      const q = Array.from(strings).join('');
      mocks.state.calls.push(q);
      return Promise.resolve(q.includes("status = 'committed'") ? mocks.state.rec : mocks.state.counts);
    },
  }),
}));
// The dynamic import('../sync-sse') inside notifyJournalRecovery resolves to this.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: mocks.notifySync }));

import { journalStatusSnapshot, notifyJournalRecovery } from './journal-surfacing';
import type { DrainResult } from './write-journal';

const drain = (over: Partial<DrainResult> = {}): DrainResult => ({
  scanned: 0, recovered: 0, deduped: 0, retriesExhausted: 0, stillPending: 0, recoveredWindow: null, ...over,
});

beforeEach(() => {
  mocks.state.counts = [];
  mocks.state.rec = [];
  mocks.state.calls = [];
  mocks.notifySync.mockReset();
});

describe('journalStatusSnapshot — badge counts (never NaN)', () => {
  it('parses ::text pending/failed counts into Numbers', async () => {
    mocks.state.counts = [{ pending: '7', failed: '2' }];
    mocks.state.rec = [{ n: '0', f: null, t: null, at: null }];
    const s = await journalStatusSnapshot();
    expect(s.pending).toBe(7);
    expect(s.failedPermanent).toBe(2);
  });

  it('an empty counts result degrades to 0/0, never NaN', async () => {
    mocks.state.counts = [];
    mocks.state.rec = [];
    const s = await journalStatusSnapshot();
    expect(s.pending).toBe(0);
    expect(s.failedPermanent).toBe(0);
    expect(Number.isNaN(s.pending)).toBe(false);
    expect(Number.isNaN(s.failedPermanent)).toBe(false);
  });
});

describe('journalStatusSnapshot — lastRecovery banner guard (never a partial/empty window)', () => {
  it('null when nothing was recovered in 24h (n=0)', async () => {
    mocks.state.counts = [{ pending: '0', failed: '0' }];
    mocks.state.rec = [{ n: '0', f: null, t: null, at: null }];
    expect((await journalStatusSnapshot()).lastRecovery).toBeNull();
  });

  it('POPULATED only when n>0 AND from/to/lastAt are all present', async () => {
    mocks.state.counts = [{ pending: '3', failed: '0' }];
    mocks.state.rec = [{ n: '4', f: '2026-07-12T01:00:00Z', t: '2026-07-12T01:05:00Z', at: '2026-07-12T01:06:00Z' }];
    expect((await journalStatusSnapshot()).lastRecovery).toEqual({
      count: 4, from: '2026-07-12T01:00:00Z', to: '2026-07-12T01:05:00Z', lastAt: '2026-07-12T01:06:00Z',
    });
  });

  it('null when n>0 but the window is partial (from is null) — no "from null – …" banner', async () => {
    mocks.state.counts = [{ pending: '0', failed: '0' }];
    mocks.state.rec = [{ n: '4', f: null, t: '2026-07-12T01:05:00Z', at: '2026-07-12T01:06:00Z' }];
    expect((await journalStatusSnapshot()).lastRecovery).toBeNull();
  });

  it('null when the aggregate row is entirely absent', async () => {
    mocks.state.counts = [{ pending: '0', failed: '0' }];
    mocks.state.rec = [];
    expect((await journalStatusSnapshot()).lastRecovery).toBeNull();
  });
});

describe('journalStatusSnapshot — the recovery query reports only genuinely-late facts', () => {
  it('scopes to committed, attempts>=1, non-deduped, within 24h', async () => {
    mocks.state.counts = [{ pending: '0', failed: '0' }];
    mocks.state.rec = [{ n: '0', f: null, t: null, at: null }];
    await journalStatusSnapshot();
    const recQ = mocks.state.calls.find((q) => q.includes("status = 'committed'"))!;
    expect(recQ).toBeDefined();
    expect(recQ).toContain('attempts >= 1');       // live-path writes (attempts 0) excluded
    expect(recQ).toContain("NOT LIKE 'deduped%'");  // dedup closures excluded
    expect(recQ).toContain("interval '24 hours'");  // bounded window
  });
});

describe('notifyJournalRecovery — best-effort push (must NEVER fail the drain)', () => {
  it('invalidates BOTH the memory list and the journal-status sync', async () => {
    await notifyJournalRecovery(drain({ scanned: 5, recovered: 2, stillPending: 3, recoveredWindow: { from: '01:00', to: '01:05' } }));
    expect(mocks.notifySync).toHaveBeenCalledWith('userMemory.list');
    expect(mocks.notifySync).toHaveBeenCalledWith('userMemory.journalStatus');
  });

  it('a throw inside notifySyncInvalidate is swallowed — resolves, never rejects', async () => {
    mocks.notifySync.mockImplementation(() => {
      throw new Error('sse channel down');
    });
    await expect(
      notifyJournalRecovery(drain({ recovered: 1, recoveredWindow: { from: '01:00', to: '01:05' } })),
    ).resolves.toBeUndefined();
  });

  it('resolves cleanly on a zero-recovery / null-window drain, still refreshing the status surface', async () => {
    await expect(notifyJournalRecovery(drain())).resolves.toBeUndefined();
    expect(mocks.notifySync).toHaveBeenCalledWith('userMemory.journalStatus');
  });
});
