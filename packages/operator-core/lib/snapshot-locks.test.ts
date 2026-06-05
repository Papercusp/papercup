import { describe, it, expect } from 'vitest';
import { withSnapshotLock } from './snapshot-locks';

describe('withSnapshotLock', () => {
  it('serializes operations on the same id', async () => {
    const events: string[] = [];
    const slow = withSnapshotLock('A', async () => {
      events.push('slow:start');
      await new Promise((r) => setTimeout(r, 50));
      events.push('slow:end');
      return 's';
    });
    const fast = withSnapshotLock('A', async () => {
      events.push('fast:start');
      events.push('fast:end');
      return 'f';
    });
    expect(await Promise.all([slow, fast])).toEqual(['s', 'f']);
    expect(events).toEqual(['slow:start', 'slow:end', 'fast:start', 'fast:end']);
  });

  it('runs ops on different ids in parallel', async () => {
    const events: string[] = [];
    const a = withSnapshotLock('A', async () => {
      events.push('A:start');
      await new Promise((r) => setTimeout(r, 30));
      events.push('A:end');
    });
    const b = withSnapshotLock('B', async () => {
      events.push('B:start');
      await new Promise((r) => setTimeout(r, 30));
      events.push('B:end');
    });
    await Promise.all([a, b]);
    // Both should have started before either ended
    expect(events.indexOf('A:start')).toBeLessThan(events.indexOf('B:end'));
    expect(events.indexOf('B:start')).toBeLessThan(events.indexOf('A:end'));
  });

  it('releases the lock when the holder throws', async () => {
    await expect(withSnapshotLock('X', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Subsequent op on the same id must not be blocked
    const ok = await withSnapshotLock('X', async () => 'recovered');
    expect(ok).toBe('recovered');
  });

  it('lets a waiter run even when the prior op throws', async () => {
    const slow = withSnapshotLock('Y', async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('first failed');
    }).catch(() => 'first-rejected');
    const next = withSnapshotLock('Y', async () => 'second');
    expect(await Promise.all([slow, next])).toEqual(['first-rejected', 'second']);
  });
});
