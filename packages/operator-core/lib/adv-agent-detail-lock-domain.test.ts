/**
 * WI-5979 — the dossier's lock read must span EVERY lock domain.
 *
 * `lockCoordinationDomain()` resolves to the realpath of the repo root of
 * whichever process loaded it. That is correct for lock ENFORCEMENT (two
 * checkouts hold two different physical files and must not serialize against
 * each other) but wrong for the dossier's per-agent diagnostic read, because the
 * operators on this box disagree about which checkout they run from:
 *
 *   :3070  → /…/papercup-release   (the release checkout; every live lock row
 *                                   was recorded here, since agents acquire
 *                                   through :3070)
 *   :3270  → /…/papercusp          (the staging tree the Tauri desktop shell
 *                                   spawns its own operator from — what the
 *                                   owner's window actually drives)
 *
 * So the desktop dossier keyed its read to the staging domain, matched zero of
 * the release-domain rows, and rendered "No locks held or waiting." for every
 * agent. It failed SILENTLY: an empty result is not an error, so the empty
 * section was indistinguishable from a genuinely lock-free agent.
 *
 * The fix is `readQueue(sql, { coordinationDomain: null })` — `owner` is already
 * globally unique, so the domain filter bought no correctness here, only the
 * bug. This test fails if anyone reintroduces a domain-scoped read; the
 * within-domain blocker attribution that makes a cross-domain read safe is
 * covered by adv-agent-detail.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueueParams, QueueResult } from './agent-tools/locks/su-lock-store';

const readQueueSpy = vi.fn<(sql: unknown, params: QueueParams) => Promise<QueueResult>>();

vi.mock('./agent-tools/locks/su-lock-store', () => ({
  ensureBootstrap: vi.fn(async () => {}),
  getTxPool: vi.fn(() => ({}) as unknown),
  readQueue: (sql: unknown, params: QueueParams) => readQueueSpy(sql, params),
}));

describe('getAgentLocks lock-domain scope (WI-5979)', () => {
  beforeEach(() => {
    readQueueSpy.mockReset();
    readQueueSpy.mockResolvedValue({ active_locks: [], waiting: [] });
  });

  it('reads across EVERY lock domain, never scoped to the serving process’s own', async () => {
    const { getAgentLocks } = await import('./adv-agent-detail');
    await getAgentLocks('su-1');

    expect(readQueueSpy).toHaveBeenCalledTimes(1);
    const params = readQueueSpy.mock.calls[0]![1];
    // null is the whole point: a concrete domain here is the regression.
    expect(params.coordinationDomain).toBeNull();
    // And it must stay unfiltered by owner — blocker attribution needs OTHER
    // owners' active locks, and ahead_count is counted across the queue.
    expect(params.owner).toBeUndefined();
  });

  // NOTE: `readQueue` is mocked here, so this does NOT exercise the SQL domain
  // filter — it only pins that a foreign-domain row survives the JS shaping path
  // untouched. The test above is the actual guard for the read scope.
  it('passes a foreign-domain row through the shaping path untouched', async () => {
    const { getAgentLocks } = await import('./adv-agent-detail');
    readQueueSpy.mockResolvedValue({
      active_locks: [
        {
          lock_id: 'lock-foreign-domain',
          path: 'packages/operator-core/lib/sync-resolver/index.ts',
          owner: 'su-1',
          owner_label: 'su · su-1',
          intent: 'editing the resolver',
          acquired_ts: new Date('2026-07-26T06:00:00Z'),
          expires_ts: new Date('2026-07-26T06:20:00Z'),
          // Recorded by :3070; the reader's own domain would be the staging tree.
          coordination_domain: '/home/dev/papercupai-workspace/papercup-release',
        },
      ],
      waiting: [],
    });

    const out = await getAgentLocks('su-1');
    expect(out.error).toBeNull();
    expect(out.held).toHaveLength(1);
    expect(out.held[0]!.path).toBe('packages/operator-core/lib/sync-resolver/index.ts');
  });
});
