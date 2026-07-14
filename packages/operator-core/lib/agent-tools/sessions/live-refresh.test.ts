import { describe, expect, it, vi } from 'vitest';
import { refreshLiveSessionsBeforeRead } from './_shared';

describe('refreshLiveSessionsBeforeRead', () => {
  it('refreshes explicitly requested owners concurrently and preserves owner identity', async () => {
    const ingest = vi.fn(async () => undefined);
    const resolve = vi.fn(async (owner: string) => ({
      filePath: `/tmp/${owner}.jsonl`,
      sessionId: `session-${owner}`,
    }));
    const sql = vi.fn() as never;

    const result = await refreshLiveSessionsBeforeRead(sql, ['su-a', 'su-b', 'su-a'], { resolve, ingest });

    expect(result).toEqual({ attempted: 2, refreshed: 2 });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(ingest).toHaveBeenCalledWith('/tmp/su-a.jsonl', { owner: 'su-a', sessionId: 'session-su-a' });
    expect(ingest).toHaveBeenCalledWith('/tmp/su-b.jsonl', { owner: 'su-b', sessionId: 'session-su-b' });
  });

  it('fails soft per live session instead of failing the read surface', async () => {
    const result = await refreshLiveSessionsBeforeRead(vi.fn() as never, ['su-missing', 'su-live'], {
      resolve: async (owner) => owner === 'su-live'
        ? { filePath: '/tmp/live.jsonl', sessionId: 'live' }
        : null,
      ingest: async () => undefined,
    });

    expect(result).toEqual({ attempted: 2, refreshed: 1 });
  });
});
