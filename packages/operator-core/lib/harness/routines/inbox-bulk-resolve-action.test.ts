import { describe, expect, it, vi } from 'vitest';

// WI-10004720: the PRODUCTION gate must key on the exclusive set (pending/running),
// never on getActiveRun (which also counts `review`). Only the two reads are
// replaced; everything else keeps its real export so the module graph is intact.
const store = vi.hoisted(() => ({
  getRunningRun: vi.fn(async (): Promise<{ runId: string; phase: string } | null> => null),
  getActiveRun: vi.fn(async () => ({ runId: 'bulk-review-since-aug', phase: 'review' })),
}));
vi.mock('../../attention/bulk-run-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention/bulk-run-store')>()),
  getRunningRun: store.getRunningRun,
  getActiveRun: store.getActiveRun,
}));

import { makeInboxBulkResolveAction, buildInboxBulkResolveSeedItems } from './inbox-bulk-resolve-action';

const ctx = { installSlug: 'papercusp', workspaceId: 'ws-1', triggerConfig: {}, payloadTemplate: null };

describe('inbox bulk resolver durable action', () => {
  it('skips when the feature flag is off', async () => {
    const readAttention = vi.fn();
    const action = makeInboxBulkResolveAction({ enabled: async () => false, readAttention });
    await action(ctx);
    expect(readAttention).not.toHaveBeenCalled();
  });

  it('skips an empty action-bearing attention feed, and says so', async () => {
    const launch = vi.fn();
    const log = vi.fn();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: async () => ({ groups: [{ items: [{ id: 'x', actions: [] }] }] }),
      runningRun: async () => null,
      launch,
      log,
    });
    await action(ctx);
    expect(launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('skip: no action-bearing attention items');
  });

  it('skips while an executing run owns the workspace, and names it', async () => {
    const readAttention = vi.fn();
    const launch = vi.fn();
    const log = vi.fn();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      runningRun: async () => ({ runId: 'bulk-existing', phase: 'running' }),
      readAttention,
      launch,
      log,
    });
    await action(ctx);
    expect(readAttention).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('skip: run=bulk-existing is running (single-flight)');
  });

  it('is NOT blocked by a run waiting in review (production gate is getRunningRun)', async () => {
    store.getRunningRun.mockClear();
    store.getActiveRun.mockClear();
    const readAttention = vi.fn(async () => ({ groups: [] }));
    const log = vi.fn();
    // Default runningRun: the real production wiring, only the store read is mocked.
    const action = makeInboxBulkResolveAction({ enabled: async () => true, readAttention, log });
    await action(ctx);
    expect(store.getRunningRun).toHaveBeenCalledWith('ws-1', 'inbox-resolve');
    expect(store.getActiveRun).not.toHaveBeenCalled();
    // The gate passed: the feed was read even though a review run exists.
    expect(readAttention).toHaveBeenCalledTimes(1);
  });

  it('bounds and de-duplicates the canonical feed to 200 seed rows', () => {
    const items = Array.from({ length: 205 }, (_, i) => ({ id: `item-${i}`, actions: [{ id: 'ack' }] }));
    items.push({ id: 'item-0', actions: [{ id: 'ack' }] });
    const seeds = buildInboxBulkResolveSeedItems({ groups: [{ items }] });
    expect(seeds).toHaveLength(200);
    expect(seeds[0]).toMatchObject({ itemId: 'item-0' });
    expect(new Set(seeds.map((s) => s.itemId)).size).toBe(200);
  });
});
