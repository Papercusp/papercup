import { describe, expect, it, vi } from 'vitest';
import {
  refreshLiveSessionsBeforeRead,
  refreshTargetSessionBeforeRead,
  SESSION_READ_REFRESH_TIMEOUT_MS,
  SESSION_TARGET_REFRESH_TIMEOUT_MS,
} from './_shared';

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

    expect(result).toEqual({
      attempted: 2,
      refreshed: 1,
      failureReasons: { transcript_unavailable: 1 },
    });
  });

  it('degrades a slow live resolve or ingest within the read budget', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ingest = vi.fn(() => new Promise<never>(() => {}));
      const pending = refreshLiveSessionsBeforeRead(vi.fn() as never, ['su-slow'], {
        resolve: async () => ({ filePath: '/tmp/slow.jsonl', sessionId: 'slow' }),
        ingest,
      });

      await vi.advanceTimersByTimeAsync(SESSION_READ_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        attempted: 1,
        refreshed: 0,
        failureReasons: { ingest_timeout: 1 },
      });
      expect(ingest).toHaveBeenCalledWith('/tmp/slow.jsonl', { owner: 'su-slow', sessionId: 'slow' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessions:live refresh'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('refreshes an active target session with its resolved owner and target id', async () => {
    const sql = vi.fn(async () => [{
      id: 42,
      agent: 'codex',
      owner: 'su-owner',
      session_id: 'target-session',
      omp_thread_id: null,
    }]) as never;
    const resolve = vi.fn(async (sourceKind: string, sessionId: string) => ({
      filePath: `/tmp/${sourceKind}/${sessionId}.jsonl`,
      sessionId,
    }));
    const ingest = vi.fn(async () => undefined);

    const result = await refreshTargetSessionBeforeRead(sql, undefined, 'target-session', { resolve, ingest });

    expect(result).toEqual({ attempted: 1, refreshed: 1 });
    expect(resolve).toHaveBeenCalledWith('codex', 'target-session', expect.objectContaining({ id: 42, owner: 'su-owner' }));
    expect(ingest).toHaveBeenCalledWith('/tmp/codex/target-session.jsonl', {
      owner: 'su-owner',
      sessionId: 'target-session',
    });
  });

  it('degrades a slow active-target ingest so the indexed read can continue', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sql = vi.fn(async () => [{
        id: 42,
        agent: 'codex',
        owner: 'su-owner',
        session_id: 'target-session',
        omp_thread_id: null,
      }]) as never;
      const ingest = vi.fn(() => new Promise<never>(() => {}));

      const pending = refreshTargetSessionBeforeRead(sql, 'codex', 'target-session', {
        resolve: async () => ({ filePath: '/tmp/codex/target-session.jsonl', sessionId: 'target-session' }),
        ingest,
      });

      await vi.advanceTimersByTimeAsync(SESSION_TARGET_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        attempted: 1,
        refreshed: 0,
        failureReasons: { ingest_timeout: 1 },
      });
      expect(ingest).toHaveBeenCalledWith('/tmp/codex/target-session.jsonl', {
        owner: 'su-owner',
        sessionId: 'target-session',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessions:read target refresh'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('classifies a live transcript resolver error without exposing its raw message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await refreshLiveSessionsBeforeRead(vi.fn() as never, ['su-error'], {
        resolve: async () => { throw new Error('/private/session/path: permission denied'); },
        ingest: async () => undefined,
      });

      expect(result).toEqual({ attempted: 1, refreshed: 0, failureReasons: { resolve_error: 1 } });
      expect(JSON.stringify(result)).not.toContain('/private/session/path');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessions:live resolve'));
    } finally {
      warn.mockRestore();
    }
  });

  it('reports a failed live-owner lookup even when no session rows were enumerated', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sql = vi.fn(() => new Promise<never>(() => {})) as never;
      const pending = refreshLiveSessionsBeforeRead(sql, null, {
        resolve: async () => null,
        ingest: async () => undefined,
      });

      await vi.advanceTimersByTimeAsync(SESSION_READ_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        attempted: 0,
        refreshed: 0,
        failureReasons: { owner_lookup_timeout: 1 },
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('skips inactive targets so indexed and archive reads keep their existing behavior', async () => {
    const sql = vi.fn(async () => []) as never;
    const resolve = vi.fn();
    const ingest = vi.fn();

    const result = await refreshTargetSessionBeforeRead(sql, 'codex', 'historical-session', { resolve, ingest });

    expect(result).toEqual({ attempted: 0, refreshed: 0 });
    expect(resolve).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});
