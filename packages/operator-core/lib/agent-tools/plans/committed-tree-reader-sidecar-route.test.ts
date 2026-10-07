import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sidecar = vi.hoisted(() => ({
  enabled: true,
  enabledVar: vi.fn(),
  run: vi.fn(),
  fallback: vi.fn(),
}));

vi.mock('../../fleet/git-via-sidecar', () => ({
  gitSidecarEnabled: (explicitVar?: string) => {
    sidecar.enabledVar(explicitVar);
    return sidecar.enabled;
  },
  isSidecarInfrastructureFault: (result: { code: number; stderr: string }) =>
    result.code === -1 && result.stderr.startsWith('spawner sidecar '),
  noteSidecarFallback: (subsystem: string, error: unknown) => sidecar.fallback(subsystem, error),
  runGitStdinViaSpawnerSidecar: (...args: unknown[]) => sidecar.run(...args),
}));

import { defaultBlobBatchReader } from './committed-tree-reader';

const BLOB_PATH = 'src/binary.dat';
const CONTENT = Buffer.from([0x00, 0x61, 0xff, 0x0a, 0x80, 0x5a]);

let repoDir = '';

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C', repoDir,
      '-c', 'user.email=t@example.test',
      '-c', 'user.name=t',
      '-c', 'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function catFileBatch(blobId: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${blobId} blob ${content.length}\n`),
    content,
    Buffer.from('\n'),
  ]);
}

beforeEach(() => {
  sidecar.enabled = true;
  sidecar.enabledVar.mockReset();
  sidecar.run.mockReset();
  sidecar.fallback.mockReset();

  repoDir = mkdtempSync(join(tmpdir(), 'committed-tree-sidecar-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, BLOB_PATH), CONTENT);
  git('add', '.');
  git('commit', '-q', '-m', 'binary fixture');
});

afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  repoDir = '';
});

describe('committed-tree blob reader sidecar routing', () => {
  it('reads uncached binary blobs through the spawner sidecar when enabled', async () => {
    const blobId = git('rev-parse', `HEAD:${BLOB_PATH}`);
    sidecar.run.mockResolvedValue({ code: 0, stdout: catFileBatch(blobId, CONTENT), stderr: '' });

    const blobs = await defaultBlobBatchReader(repoDir, [blobId]);

    expect(blobs.get(blobId)).toEqual(CONTENT);
    expect(sidecar.enabledVar).toHaveBeenCalledWith('PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR');
    expect(sidecar.run).toHaveBeenCalledWith(
      ['cat-file', '--batch'],
      repoDir,
      `${blobId}\n`,
      15_000,
      process.env,
    );
    expect(sidecar.fallback).not.toHaveBeenCalled();
  });

  it('keeps the local reader as a counted correctness fallback for sidecar failures', async () => {
    const blobId = git('rev-parse', `HEAD:${BLOB_PATH}`);
    const sidecarError = new Error('spawner socket unavailable');
    sidecar.run
      .mockRejectedValueOnce(sidecarError)
      .mockResolvedValueOnce({ code: -1, stdout: Buffer.alloc(0), stderr: 'spawner sidecar handoff failed' });

    const first = await defaultBlobBatchReader(repoDir, [blobId]);
    expect(first.get(blobId)).toEqual(CONTENT);
    expect(sidecar.fallback).toHaveBeenNthCalledWith(1, 'committed-tree-reader', sidecarError);

    const second = await defaultBlobBatchReader(repoDir, [blobId]);
    expect(second.get(blobId)).toEqual(CONTENT);
    expect(sidecar.fallback).toHaveBeenNthCalledWith(
      2,
      'committed-tree-reader',
      expect.objectContaining({ message: 'spawner sidecar handoff failed' }),
    );
  });
});
