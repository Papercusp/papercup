import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sidecar = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  run: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock('../../fleet/git-via-sidecar', () => ({
  gitSidecarEnabled: sidecar.enabled,
  runGitViaSpawnerSidecar: sidecar.run,
  noteSidecarFallback: sidecar.fallback,
}));

import { runGitBounded } from './run-git-sync';

beforeEach(() => {
  sidecar.enabled.mockClear();
  sidecar.run.mockReset();
  sidecar.fallback.mockClear();
});

describe('git-sync signal-bearing sidecar routing', () => {
  it('routes a read-only Git call with cancellation, progress and optional locks disabled', async () => {
    const controller = new AbortController();
    const progress = vi.fn();
    sidecar.run.mockImplementation(async (_args, _cwd, _timeout, _env, opts) => {
      opts.onProgress();
      return { code: 0, stdout: 'revision\n', stderr: '' };
    });
    const result = await runGitBounded(['-c', 'core.quotepath=false', 'rev-parse', 'HEAD'], '/tmp', 5000, {
      signal: controller.signal, onProgress: progress,
    });
    expect(result).toMatchObject({ code: 0, stdout: 'revision\n' });
    expect(sidecar.run).toHaveBeenCalledOnce();
    const [, , , env, opts] = sidecar.run.mock.calls[0];
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(opts.signal).toBe(controller.signal);
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it('keeps a mutating Git command local while sidecar transport loss could strand its child', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'git-sync-sidecar-route-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      const result = await runGitBounded(['update-ref', 'refs/test', 'invalid-object-id'], repo, 5000, {
        signal: new AbortController().signal,
      });
      expect(result.code).not.toBe(0);
      expect(sidecar.run).not.toHaveBeenCalled();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not retry locally after a read-only sidecar call loses transport during abort', async () => {
    const controller = new AbortController();
    sidecar.run.mockImplementation(async () => {
      controller.abort();
      throw new Error('Socket error: connection closed');
    });
    const result = await runGitBounded(['rev-parse', 'HEAD'], '/tmp', 5000, {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ code: -1, stderr: 'git aborted after sidecar transport loss' });
    expect(sidecar.fallback).toHaveBeenCalledOnce();
  });
});
