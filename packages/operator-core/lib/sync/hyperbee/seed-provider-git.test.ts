/**
 * seed-provider-git.test.ts — the git SeedProvider (P-004).
 *
 * Real `git` (no network): a fixture repo (+ a submodule) is bundled, restored
 * into a fresh dir OFFLINE from the bundle, and a subsequent fetch pulls only the
 * delta. Proves the "pre-position via bundle, delta via fetch" property and the
 * submodule round-trip.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitSeedProvider, GIT_SEED_KIND } from './seed-provider-git';

const exec = promisify(execFile);
const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      rmSync(cleanups.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.email', 'seed@test']);
  await g(dir, ['config', 'user.name', 'Seed Test']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
}

describe('git seed provider', () => {
  it('cut → restore clones offline from the bundle; a later fetch carries only the delta', async () => {
    const src = tmpDir('gseed-src-');
    await initRepo(src);
    writeFileSync(join(src, 'file.txt'), 'v1');
    await g(src, ['add', '.']);
    await g(src, ['commit', '-qm', 'v1']);

    const provider = createGitSeedProvider();
    const staging = tmpDir('gseed-stage-');
    const { entry, payload } = await provider.cut({ sourceRepoDir: src, stagingDir: staging, originUrl: 'https://github.com/Papercusp/papercup' });
    expect(entry.kind).toBe(GIT_SEED_KIND);
    expect(existsSync(join(staging, 'super.bundle'))).toBe(true);
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    // RESTORE into a fresh dir — offline clone from the bundle.
    const target = join(tmpDir('gseed-tgt-'), 'checkout');
    await provider.restore(entry, payload, { targetRepoDir: target });
    expect(readFileSync(join(target, 'file.txt'), 'utf8')).toBe('v1'); // pre-positioned
    expect(await g(target, ['remote', 'get-url', 'origin'])).toBe('https://github.com/Papercusp/papercup');
    const baseCount = Number(await g(target, ['rev-list', '--count', 'HEAD']));
    expect(baseCount).toBe(1);

    // Source advances (the "delta"); target fetches only the new commit from source.
    writeFileSync(join(src, 'file.txt'), 'v2');
    await g(src, ['commit', '-aqm', 'v2']);
    await g(target, ['fetch', '-q', src, 'main']);
    await g(target, ['reset', '-q', '--hard', 'FETCH_HEAD']);
    expect(readFileSync(join(target, 'file.txt'), 'utf8')).toBe('v2');
    expect(Number(await g(target, ['rev-list', '--count', 'HEAD']))).toBe(2);
  });

  it('round-trips a submodule (bundled + restored + checked out)', async () => {
    // A sub repo with a file.
    const subSrc = tmpDir('gseed-sub-');
    await initRepo(subSrc);
    writeFileSync(join(subSrc, 'lib.txt'), 'sublib');
    await g(subSrc, ['add', '.']);
    await g(subSrc, ['commit', '-qm', 'sub v1']);

    // A super repo that adds the sub as a submodule at ./vendor/sub.
    const superSrc = tmpDir('gseed-super-');
    await initRepo(superSrc);
    writeFileSync(join(superSrc, 'top.txt'), 'top');
    await g(superSrc, ['add', '.']);
    await g(superSrc, ['commit', '-qm', 'top v1']);
    await g(superSrc, ['-c', 'protocol.file.allow=always', 'submodule', 'add', subSrc, 'vendor/sub']);
    await g(superSrc, ['commit', '-qm', 'add submodule']);

    const provider = createGitSeedProvider();
    const staging = tmpDir('gseed-stage2-');
    const { entry, payload } = await provider.cut({ sourceRepoDir: superSrc, stagingDir: staging, originUrl: 'https://example/super' });
    expect((entry.meta as { submodulePaths: string[] }).submodulePaths).toContain('vendor/sub');
    expect(existsSync(join(staging, 'submodules'))).toBe(true);
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    const target = join(tmpDir('gseed-tgt2-'), 'checkout');
    await provider.restore(entry, payload, { targetRepoDir: target });
    expect(readFileSync(join(target, 'top.txt'), 'utf8')).toBe('top');
    expect(readFileSync(join(target, 'vendor/sub/lib.txt'), 'utf8')).toBe('sublib'); // submodule restored + checked out
  });

  it('verify fails closed on a mismatched hash', async () => {
    const provider = createGitSeedProvider();
    const src = tmpDir('gseed-src3-');
    await initRepo(src);
    writeFileSync(join(src, 'f'), 'x');
    await g(src, ['add', '.']);
    await g(src, ['commit', '-qm', 'c']);
    const staging = tmpDir('gseed-stage3-');
    const { payload } = await provider.cut({ sourceRepoDir: src, stagingDir: staging, originUrl: 'u' });
    const bogus = { kind: GIT_SEED_KIND, hash: 'deadbeef'.repeat(8), sizeBytes: 0, source: { type: 'resource' as const, path: staging } };
    const res = await provider.verify(bogus, payload);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/hash mismatch/);
  });
});
