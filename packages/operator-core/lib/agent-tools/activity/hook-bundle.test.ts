import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_HOOK_BUNDLE_SCHEMA,
  buildActivityHookBundle,
  INBOX_CURSOR_SURFACE,
  guardedLegacyInboxFloor,
  type ActivityHookBundleDeps,
} from './hook-bundle';
import { InMemoryReadCursorStore } from '../coordination/read-cursors';

function deps(generation = 'host-a:42') {
  const inbox = vi.fn(async (): Promise<Record<string, unknown>> => ({
    entries: [],
    summary: { newest_ts: null },
  }));
  const glance = vi.fn(async () => ({ display: { title: 'su-abc', notice: null } }));
  const cursor = new InMemoryReadCursorStore();
  const readInboxCursor = vi.fn((ownerId: string) => cursor.ackAndRead(ownerId, INBOX_CURSOR_SURFACE));
  const stageInboxCursor = vi.fn((ownerId: string, next: Record<string, unknown>) =>
    cursor.stage(ownerId, INBOX_CURSOR_SURFACE, next),
  );
  const readWatermark = vi.fn(async (): Promise<{
    messages_since_ts?: string | null;
    messages_shown_ts?: string | null;
  }> => ({
    messages_since_ts: null,
    messages_shown_ts: null,
  }));
  const value: ActivityHookBundleDeps = {
    generation: vi.fn(async () => generation),
    inbox,
    glance,
    readInboxCursor,
    stageInboxCursor,
    readWatermark,
    now: () => new Date('2026-07-13T20:00:00.000Z'),
  };
  return { value, inbox, glance, readInboxCursor, stageInboxCursor, readWatermark };
}

describe('activity hook bundle', () => {
  it('hydrates inbox + glance once, then skips both for N unchanged heartbeats', async () => {
    const d = deps();
    const first = await buildActivityHookBundle(
      'su-abc',
      { generation: null, since_ts: '2026-07-13T19:00:00.000Z', force_resync: true },
      {} as never,
      d.value,
    );
    expect(first).toMatchObject({
      schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
      generation: 'host-a:42',
      changed: true,
      complete: true,
      provenance: { source: 'activity:report', ownerId: 'su-abc' },
      resync: { strategy: 'replace-full-never-merge-behind' },
    });

    for (let i = 0; i < 20; i += 1) {
      const quiet = await buildActivityHookBundle(
        'su-abc',
        { generation: first.generation, since_ts: '2026-07-13T19:00:00.000Z' },
        {} as never,
        d.value,
      );
      expect(quiet).toMatchObject({ changed: false, complete: true });
      expect(quiet.surfaces).toBeUndefined();
    }
    expect(d.inbox).toHaveBeenCalledTimes(1);
    expect(d.glance).toHaveBeenCalledTimes(1);
  });

  it('rehydrates on a generation change but never trusts a client cursor past the durable receipt', async () => {
    const d = deps('host-a:43');
    d.readWatermark.mockResolvedValueOnce({
      messages_since_ts: '2026-07-13T19:00:00.000Z',
      messages_shown_ts: null,
    });
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:30:00.000Z' },
      {} as never,
      d.value,
    );
    expect(result).toMatchObject({ changed: true, complete: true, generation: 'host-a:43' });
    expect(d.inbox).toHaveBeenCalledWith('2026-07-13T19:00:00.000Z', expect.anything());
  });

  it('ignores a first-call client cursor when no durable receipt exists', async () => {
    const d = deps('host-a:43');
    await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:30:00.000Z' },
      {} as never,
      d.value,
    );
    expect(d.inbox).toHaveBeenCalledWith(null, expect.anything());
  });

  it('uses the server cursor after the first delivery, regardless of a stale client cursor', async () => {
    const d = deps('host-a:42');
    d.inbox.mockResolvedValueOnce({
      entries: [],
      summary: { newest_ts: '2026-07-13T20:00:00.000Z' },
    });
    await buildActivityHookBundle(
      'su-abc',
      { generation: null, force_resync: true },
      {} as never,
      d.value,
    );

    d.value.generation = vi.fn(async () => 'host-a:43');
    await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:00:00.000Z' },
      {} as never,
      d.value,
    );
    expect(d.inbox).toHaveBeenNthCalledWith(2, '2026-07-13T20:00:00.000Z', expect.anything());
  });

  it('uses a null floor when the first-call watermark read fails (fail closed)', async () => {
    const d = deps('host-a:43');
    d.readWatermark.mockRejectedValueOnce(new Error('temporary'));
    await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:30:00.000Z' },
      {} as never,
      d.value,
    );
    expect(d.inbox).toHaveBeenCalledWith(null, expect.anything());
  });

  it('marks a partial hydrate incomplete so the client retries instead of advancing', async () => {
    const d = deps();
    d.glance.mockRejectedValueOnce(new Error('temporary'));
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'old' },
      {} as never,
      d.value,
    );
    expect(result).toMatchObject({ changed: true, complete: false });
    expect(result.surfaces?.inbox).toBeDefined();
    expect(result.surfaces?.glance).toBeUndefined();
  });

  it('marks a cursor-stage failure incomplete so the next heartbeat cannot skip the delivery', async () => {
    const d = deps();
    d.stageInboxCursor.mockRejectedValueOnce(new Error('temporary'));
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'old' },
      {} as never,
      d.value,
    );
    expect(result).toMatchObject({ changed: true, complete: false });
  });
});

describe('guardedLegacyInboxFloor — migration safety', () => {
  it('rejects a client floor newer than the durable receipt', () => {
    expect(guardedLegacyInboxFloor('2026-07-13T19:30:00.000Z', '2026-07-13T19:00:00.000Z')).toBe(
      '2026-07-13T19:00:00.000Z',
    );
  });

  it('allows an older client floor because it can only duplicate delivery', () => {
    expect(guardedLegacyInboxFloor('2026-07-13T18:30:00.000Z', '2026-07-13T19:00:00.000Z')).toBe(
      '2026-07-13T18:30:00.000Z',
    );
  });

  it('fails closed to a full baseline when no durable receipt exists', () => {
    expect(guardedLegacyInboxFloor('2026-07-13T19:30:00.000Z', null)).toBeNull();
  });
});
