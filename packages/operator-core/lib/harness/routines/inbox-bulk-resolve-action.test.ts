import { describe, expect, it, vi } from 'vitest';
import { makeInboxBulkResolveAction, buildInboxBulkResolveSeedItems } from './inbox-bulk-resolve-action';

const ctx = { installSlug: 'papercusp', workspaceId: 'ws-1', triggerConfig: {}, payloadTemplate: null };

describe('inbox bulk resolver durable action', () => {
  it('skips when the feature flag is off', async () => {
    const readAttention = vi.fn();
    const action = makeInboxBulkResolveAction({ enabled: async () => false, readAttention });
    await action(ctx);
    expect(readAttention).not.toHaveBeenCalled();
  });

  it('skips an empty action-bearing attention feed', async () => {
    const launch = vi.fn();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      readAttention: async () => ({ groups: [{ items: [{ id: 'x', actions: [] }] }] }),
      activeRun: async () => null,
      launch,
    });
    await action(ctx);
    expect(launch).not.toHaveBeenCalled();
  });

  it('skips while an active run owns the workspace', async () => {
    const readAttention = vi.fn();
    const launch = vi.fn();
    const action = makeInboxBulkResolveAction({
      enabled: async () => true,
      activeRun: async () => ({ runId: 'bulk-existing', phase: 'running' }),
      readAttention,
      launch,
    });
    await action(ctx);
    expect(readAttention).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
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
