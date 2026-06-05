import { beforeEach, describe, expect, it } from 'vitest';
import { createTombstones, runSaga, type Tombstones } from './saga';
import { createInMemorySagaJournal, createInMemoryTombstoneStore, type InMemorySagaJournal } from './mem-store';

const WS = 'default';
let journal: InMemorySagaJournal;
let tombs: Tombstones;
let tombStore: ReturnType<typeof createInMemoryTombstoneStore>;

beforeEach(() => {
  journal = createInMemorySagaJournal();
  tombStore = createInMemoryTombstoneStore();
  tombs = createTombstones(tombStore);
});

describe('saga — forward + compensation', () => {
  it('runs all steps and records completed', async () => {
    const ran: string[] = [];
    const res = await runSaga(journal, {
      workspaceId: WS, name: 'deploy',
      steps: [
        { name: 's1', run: async () => { ran.push('s1'); return 1; } },
        { name: 's2', run: async () => { ran.push('s2'); return 2; } },
        { name: 's3', run: async () => { ran.push('s3'); return 3; } },
      ],
    });
    expect(res.status).toBe('completed');
    expect(ran).toEqual(['s1', 's2', 's3']);
    expect(res.results).toEqual([1, 2, 3]);
    expect(res.steps.every((s) => s.status === 'done')).toBe(true);
    expect(journal.get(res.sagaId)?.status).toBe('completed');
  });

  it('on a step failure, compensates the completed steps in REVERSE', async () => {
    const events: string[] = [];
    const res = await runSaga(journal, {
      workspaceId: WS, name: 'risky',
      steps: [
        { name: 'a', run: async () => { events.push('run:a'); return 'A'; }, compensate: async (r) => { events.push(`comp:a(${r})`); } },
        { name: 'b', run: async () => { events.push('run:b'); return 'B'; }, compensate: async (r) => { events.push(`comp:b(${r})`); } },
        { name: 'c', run: async () => { events.push('run:c'); throw new Error('boom'); } },
      ],
    });
    expect(res.status).toBe('compensated');
    expect(res.failedStep).toBe('c');
    expect(res.error).toMatch(/boom/);
    expect(events).toEqual(['run:a', 'run:b', 'run:c', 'comp:b(B)', 'comp:a(A)']);
    expect(res.steps.find((s) => s.name === 'a')?.status).toBe('compensated');
    expect(res.steps.find((s) => s.name === 'c')?.status).toBe('failed');
    expect(journal.get(res.sagaId)?.status).toBe('compensated');
  });

  it('records a compensate_failed step without aborting the rest of the rollback', async () => {
    const res = await runSaga(journal, {
      workspaceId: WS, name: 'partial-undo',
      steps: [
        { name: 'a', run: async () => 'A', compensate: async () => {} },
        { name: 'b', run: async () => 'B', compensate: async () => { throw new Error('undo-failed'); } },
        { name: 'c', run: async () => { throw new Error('boom'); } },
      ],
    });
    expect(res.steps.find((s) => s.name === 'b')?.status).toBe('compensate_failed');
    expect(res.steps.find((s) => s.name === 'a')?.status).toBe('compensated'); // a still rolled back
  });
});

describe('saga — tombstone / deferred-GC destructive op', () => {
  it('soft-delete is logically reversible; physical GC waits for the grace window', async () => {
    const t = 10_000_000;
    await tombs.softDelete({ workspaceId: WS, refKind: 'snapshot', refId: 'snap-1', graceSec: 3600, now: t });
    expect(await tombs.isTombstoned({ workspaceId: WS, refKind: 'snapshot', refId: 'snap-1' })).toBe(true);
    expect(await tombs.physicalGc({ workspaceId: WS, now: t + 1000 })).toEqual([]);              // within grace
    expect(await tombs.physicalGc({ workspaceId: WS, now: t + 3_600_001 })).toEqual(['snapshot:snap-1']); // past grace
    expect(await tombs.isTombstoned({ workspaceId: WS, refKind: 'snapshot', refId: 'snap-1' })).toBe(false);
  });

  it('restore (compensation) un-tombstones so a later GC skips it', async () => {
    const t = 11_000_000;
    await tombs.softDelete({ workspaceId: WS, refKind: 'work_item', refId: 'WI-9', graceSec: 60, now: t });
    expect(await tombs.restoreTombstone({ workspaceId: WS, refKind: 'work_item', refId: 'WI-9' })).toBe(true);
    expect(await tombs.isTombstoned({ workspaceId: WS, refKind: 'work_item', refId: 'WI-9' })).toBe(false);
    expect(await tombs.physicalGc({ workspaceId: WS, now: t + 1_000_000 })).toEqual([]);
  });

  it('a saga makes a destructive delete compensable: a later failure restores the soft-delete', async () => {
    const ref = { workspaceId: WS, refKind: 'snapshot', refId: 'snap-2' };
    const res = await runSaga(journal, {
      workspaceId: WS, name: 'prune-snapshot',
      steps: [
        { name: 'tombstone', run: async () => { await tombs.softDelete({ ...ref, graceSec: 3600 }); return ref; }, compensate: async () => { await tombs.restoreTombstone(ref); } },
        { name: 'verify-elsewhere', run: async () => { throw new Error('peer rejected the prune'); } },
      ],
    });
    expect(res.status).toBe('compensated');
    expect(await tombs.isTombstoned(ref)).toBe(false); // rolled back — the object lives
  });
});
