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
  isSidecarInfrastructureFault: (result: { code: number; stderr: string }) =>
    result.code === -1 && result.stderr.startsWith('spawner sidecar '),
}));

import { gitSyncPreDispatchError, runGitBounded } from './run-git-sync';

beforeEach(() => {
  sidecar.enabled.mockClear();
  sidecar.run.mockReset();
  sidecar.fallback.mockClear();
});

describe('git-sync signal-bearing sidecar routing', () => {
  it('reports admission refusal as infrastructure, without replaying a mutation or treating it as a Git merge error', async () => {
    sidecar.run.mockResolvedValue({
      code: -1, stdout: '', stderr: 'spawner sidecar admission failed: resource_governor_admissions_time_chk',
    });
    const result = await runGitBounded(['merge', '--no-edit', 'origin/staging'], '/tmp', 5000);
    expect(result.code).toBe(-1);
    expect(gitSyncPreDispatchError(result)).toContain('infrastructure refusal before Git dispatch');
    expect(gitSyncPreDispatchError(result)).toContain('resource_governor_admissions_time_chk');
    expect(sidecar.run).toHaveBeenCalledOnce();
    expect(sidecar.fallback).not.toHaveBeenCalled();
    expect(gitSyncPreDispatchError({ code: 1, stdout: '', stderr: 'Git failed' })).toBeNull();
  });
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

  it('routes a mutating command with its cancellation signal and normal lock policy', async () => {
    sidecar.run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const signal = new AbortController().signal;
    const result = await runGitBounded(['update-ref', 'refs/test', 'object-id'], '/tmp', 5000, { signal });
    expect(result.code).toBe(0);
    expect(sidecar.run).toHaveBeenCalledOnce();
    const [, , , env, opts] = sidecar.run.mock.calls[0];
    expect(env.GIT_OPTIONAL_LOCKS).toBe(process.env.GIT_OPTIONAL_LOCKS);
    expect(opts.signal).toBe(signal);
  });

  it.each(['unknown-outcome', 'preflight-unavailable'])('handles %s without replaying ambiguous mutations', async (kind) => {
    const repo = mkdtempSync(join(tmpdir(), 'git-sync-sidecar-route-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', 'test.once', 'original']);
      if (kind === 'unknown-outcome') {
        sidecar.run.mockResolvedValue({ code: -1, stdout: '', stderr: 'sidecar execution outcome unavailable after verified process exit; command was not replayed' });
      } else {
        sidecar.run.mockRejectedValue(new Error('sidecar execution containment unavailable before dispatch'));
      }
      const result = await runGitBounded(['config', 'test.once', 'modified'], repo, 5000, {
        signal: new AbortController().signal,
      });
      expect(result.code).toBe(kind === 'unknown-outcome' ? -1 : 0);
      expect(execFileSync('git', ['-C', repo, 'config', 'test.once'], { encoding: 'utf8' }).trim())
        .toBe(kind === 'unknown-outcome' ? 'original' : 'modified');
      expect(sidecar.run).toHaveBeenCalledOnce();
      expect(sidecar.fallback).toHaveBeenCalledTimes(kind === 'unknown-outcome' ? 0 : 1);
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
