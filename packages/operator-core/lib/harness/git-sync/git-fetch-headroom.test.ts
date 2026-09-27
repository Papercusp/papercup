import { afterEach, describe, expect, it, vi } from 'vitest';
import { withGitFetchHeadroom } from './git-fetch-headroom';
import { DEFAULT_DISK_POLICY, type DiskSnapshot } from '../../storage/disk-space-alarm';

const GIB = 1024 ** 3;
const path = '/repository-metadata/objects';
const snapshot = (freeBytes: number): DiskSnapshot => ({
  path, freeBytes, totalBytes: 20 * GIB, freePct: freeBytes / (20 * GIB),
  totalInodes: 0, freeInodes: 0, freeInodesPct: 0,
});
const ok = { code: 0, stdout: '', stderr: '' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Git fetch disk headroom', () => {
  it('refuses a bulk fetch below the reserve on the object-store filesystem', async () => {
    const run = vi.fn(async () => ({ ...ok, stdout: `${path}\n` }));
    const sample = vi.fn(async () => [snapshot(GIB)]);
    const result = await withGitFetchHeadroom(['-C', '/worktree', 'fetch', 'origin'], run, undefined, sample);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('critical reserve');
    expect(sample).toHaveBeenCalledWith([path]);
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0]).toEqual([
      ['-C', '/worktree', 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], undefined,
    ]);
  });

  it('does not mistake an unreadable filesystem for available capacity', async () => {
    const run = vi.fn(async () => ({ ...ok, stdout: `${path}\n` }));
    const result = await withGitFetchHeadroom(['fetch'], run, undefined, async () => []);
    expect(result).toMatchObject({ code: -1, stderr: expect.stringContaining('unmeasured') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('requires a resolved absolute object store before admitting the transfer', async () => {
    const run = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'not a git repository' }));
    const sample = vi.fn(async () => [snapshot(10 * GIB)]);
    expect((await withGitFetchHeadroom(['fetch'], run, undefined, sample)).code).toBe(-1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sample).not.toHaveBeenCalled();
  });

  it('cancels a transfer when capacity falls and waits for its exit receipt', async () => {
    vi.useFakeTimers();
    const sample = vi.fn().mockResolvedValueOnce([snapshot(10 * GIB)])
      .mockResolvedValue([snapshot(DEFAULT_DISK_POLICY.criticalFreeBytesMin)]);
    let transferSignal: AbortSignal | undefined;
    let exit!: (value: typeof ok) => void;
    const run = vi.fn(async (args: string[], signal?: AbortSignal) => {
      if (args[0] === 'rev-parse') return { ...ok, stdout: path };
      transferSignal = signal;
      return new Promise<typeof ok>((resolve) => { exit = resolve; });
    });
    let settled = false;
    const result = withGitFetchHeadroom(['fetch'], run, undefined, sample)
      .then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(transferSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(transferSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    exit(ok);
    expect(await result).toMatchObject({ code: -1, stderr: expect.stringContaining('critical reserve') });
    const samples = sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sample).toHaveBeenCalledTimes(samples);
  });

  it('preserves caller cancellation while the disk remains healthy', async () => {
    const controller = new AbortController();
    const run = vi.fn(async (args: string[], signal?: AbortSignal) => {
      if (args[0] === 'rev-parse') return { ...ok, stdout: path };
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { ...ok, code: -1, stderr: 'cancelled' };
    });
    expect(await withGitFetchHeadroom(['fetch'], run, controller.signal,
      async () => [snapshot(10 * GIB)])).toMatchObject({ code: -1, stderr: 'cancelled' });
  });

  it('leaves successful fetch output intact and removes its monitor', async () => {
    vi.useFakeTimers();
    const sample = vi.fn(async () => [snapshot(10 * GIB)]);
    const run = vi.fn(async (args: string[]) => args[0] === 'rev-parse'
      ? { ...ok, stdout: path } : { ...ok, stdout: 'fetched', stderr: 'progress' });
    expect(await withGitFetchHeadroom(['fetch'], run, undefined, sample))
      .toEqual({ ...ok, stdout: 'fetched', stderr: 'progress' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('does not prevent read-only diagnostics or other commands on a full disk', async () => {
    const run = vi.fn(async () => ok);
    const sample = vi.fn(async () => [snapshot(0)]);
    expect(await withGitFetchHeadroom(['rev-parse', 'HEAD'], run, undefined, sample)).toEqual(ok);
    expect(sample).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(['rev-parse', 'HEAD'], undefined);
  });
});
