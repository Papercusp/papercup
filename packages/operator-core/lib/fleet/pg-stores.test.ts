/**
 * pg-stores (unit) — the MugHeartbeat freshness push on a queen spawn.
 *
 * data-sync-push-completion-2026-06-23 D-008 follow-up (P-007): recordSpawnPg is the
 * single spawned_agents INSERT chokepoint. The MugHeartbeat sidebar's hive.controlState
 * lastWakeAt derives from this table's child_role='mug' rows, but the wake-brain Queen
 * spawns WITHOUT calling recordHiveWake — so recordSpawnPg pushes hive.controlState on a
 * queen spawn (and ONLY a queen spawn) so the heartbeat refreshes live instead of waiting
 * on the 180s drift-repair. This unit test mocks the sql handle + sync-sse to lock in
 * "fire on queen, stay quiet on everything else" without a live PG. The rest of pg-stores
 * is exercised by pg-stores.integration.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RecordSpawnInput } from '@papercusp/structured-concurrency';
import { recordSpawnPg, type Db } from './pg-stores';
import * as syncSse from '../sync-sse';

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

const notify = vi.mocked(syncSse.notifySyncInvalidate);

// A fake tagged-template `sql` that resolves empty — recordSpawnPg only awaits the
// INSERT; we exercise the post-insert push side-effect, not the SQL itself.
const fakeSql = (() => Promise.resolve([])) as unknown as Db;

const spawn = (over: Partial<RecordSpawnInput> = {}): RecordSpawnInput => ({
  spawnId: 's1',
  workspaceId: 'ws1',
  runId: 'run-s1',
  childRole: 'worker',
  ...over,
});

describe('recordSpawnPg — hive.controlState push on queen spawn (D-008 P-007)', () => {
  beforeEach(() => notify.mockClear());

  it('pushes notifySyncInvalidate(hive.controlState) when a queen is spawned', async () => {
    await recordSpawnPg(fakeSql, spawn({ childRole: 'mug' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('hive.controlState', {}));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a non-queen spawn (worker / bee / overwatch)', async () => {
    for (const role of ['worker', 'cup', 'kettle', 'scout']) {
      notify.mockClear();
      await recordSpawnPg(fakeSql, spawn({ childRole: role }));
      // give the (absent) fire-and-forget a tick — it must never resolve a push
      await new Promise((r) => setTimeout(r, 10));
      expect(notify).not.toHaveBeenCalled();
    }
  });
});
