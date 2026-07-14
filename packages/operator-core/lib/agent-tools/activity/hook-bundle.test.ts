import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_HOOK_BUNDLE_SCHEMA,
  buildActivityHookBundle,
  type ActivityHookBundleDeps,
} from './hook-bundle';

function deps(generation = 'host-a:42') {
  const inbox = vi.fn(async () => ({ entries: [], summary: { newest_ts: null } }));
  const glance = vi.fn(async () => ({ display: { title: 'su-abc', notice: null } }));
  const value: ActivityHookBundleDeps = {
    generation: vi.fn(async () => generation),
    inbox,
    glance,
    now: () => new Date('2026-07-13T20:00:00.000Z'),
  };
  return { value, inbox, glance };
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

  it('rehydrates on a generation change and forwards the caller inbox cursor', async () => {
    const d = deps('host-a:43');
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:30:00.000Z' },
      {} as never,
      d.value,
    );
    expect(result).toMatchObject({ changed: true, complete: true, generation: 'host-a:43' });
    expect(d.inbox).toHaveBeenCalledWith('2026-07-13T19:30:00.000Z', expect.anything());
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
});
