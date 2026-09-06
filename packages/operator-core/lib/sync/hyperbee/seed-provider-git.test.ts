/**
 * seed-provider-git.test.ts — the git SeedProvider (P-004).
 *
 * Real `git` (no network): a fixture repo (+ a submodule) is bundled, restored
 * into a fresh dir OFFLINE from the bundle, and a subsequent fetch pulls only the
 * delta. Proves the "pre-position via bundle, delta via fetch" property and the
 * submodule round-trip.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitSeedProvider, GIT_SEED_KIND } from './seed-provider-git';
import { generateSeedKey } from '@papercusp/seed-bundle';
import { runGitSync } from '../../harness/git-sync/run-git-sync';

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
    const { entry, payload } = await provider.cut({
      sourceRepoDir: src,
      stagingDir: staging,
      originUrl: 'https://github.com/Papercusp/papercup',
    });
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
    const { entry, payload } = await provider.cut({
      sourceRepoDir: superSrc,
      stagingDir: staging,
      originUrl: 'https://example/super',
    });
    expect((entry.meta as { submodulePaths: string[] }).submodulePaths).toContain('vendor/sub');
    expect(existsSync(join(staging, 'submodules'))).toBe(true);
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    const target = join(tmpDir('gseed-tgt2-'), 'checkout');
    await provider.restore(entry, payload, { targetRepoDir: target });
    expect(readFileSync(join(target, 'top.txt'), 'utf8')).toBe('top');
    expect(readFileSync(join(target, 'vendor/sub/lib.txt'), 'utf8')).toBe('sublib'); // submodule restored + checked out
  });

  it('depth=1 cuts an offline-cloneable one-commit snapshot and keeps submodule gitlinks coherent', async () => {
    const subSrc = tmpDir('gseed-depth-sub-');
    await initRepo(subSrc);
    writeFileSync(join(subSrc, 'lib.txt'), 'sub v1');
    await g(subSrc, ['add', '.']);
    await g(subSrc, ['commit', '-qm', 'sub v1']);
    writeFileSync(join(subSrc, 'lib.txt'), 'sub v2');
    await g(subSrc, ['commit', '-aqm', 'sub v2']);

    const superSrc = tmpDir('gseed-depth-super-');
    await initRepo(superSrc);
    writeFileSync(join(superSrc, 'top.txt'), 'top v1');
    await g(superSrc, ['add', '.']);
    await g(superSrc, ['commit', '-qm', 'top v1']);
    await g(superSrc, ['-c', 'protocol.file.allow=always', 'submodule', 'add', subSrc, 'vendor/sub']);
    writeFileSync(join(superSrc, 'top.txt'), 'top v2');
    await g(superSrc, ['add', '.']);
    await g(superSrc, ['commit', '-qm', 'top v2 + sub']);

    const provider = createGitSeedProvider();
    const staging = tmpDir('gseed-depth-stage-');
    const { entry, payload } = await provider.cut({
      sourceRepoDir: superSrc,
      stagingDir: staging,
      originUrl: 'https://example/super',
      rev: 'HEAD',
      depth: 1,
    });
    expect((entry.meta as { depth?: number }).depth).toBe(1);
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    const target = join(tmpDir('gseed-depth-tgt-'), 'checkout');
    await provider.restore(entry, payload, { targetRepoDir: target });
    expect(readFileSync(join(target, 'top.txt'), 'utf8')).toBe('top v2');
    expect(readFileSync(join(target, 'vendor/sub/lib.txt'), 'utf8')).toBe('sub v2');
    expect(Number(await g(target, ['rev-list', '--count', 'HEAD']))).toBe(1);
    expect(Number(await g(join(target, 'vendor/sub'), ['rev-list', '--count', 'HEAD']))).toBe(1);
    expect(await g(target, ['status', '--short'])).toBe('');

    writeFileSync(join(superSrc, 'top.txt'), 'top v3');
    await g(superSrc, ['commit', '-aqm', 'top v3']);
    // Production no longer relies on an out-of-band hard reset. The first
    // git-sync recognizes the provider's synthetic root + retained snapshot ref,
    // converts every seeded submodule first, then adopts the real super history.
    await g(target, ['remote', 'set-url', 'origin', superSrc]);
    const syncLogs: string[] = [];
    const synced = await runGitSync('seed-depth-restore', {
      repoPath: target,
      config: { branch: 'main', push: false },
      // The production bootstrap registers the restored embedded clone as a
      // submodule before git-sync. Pin the same discovery result at this pure
      // provider seam so both synthetic histories are converted in order.
      submodulePaths: ['vendor/sub'],
      log: (m) => syncLogs.push(m),
    });
    // Carry the git-sync log trail on the assertion: a 'nothing'/'error' here is only
    // diagnosable from what runGitSync logged (which seed conversion step it took).
    expect(synced.status, `git-sync log trail:\n${syncLogs.join('\n')}\n${JSON.stringify(synced)}`).toBe('synced');
    expect(readFileSync(join(target, 'top.txt'), 'utf8')).toBe('top v3');
    expect(await g(target, ['status', '--short'])).toBe('');
    expect(Number(await g(target, ['rev-list', '--count', 'HEAD']))).toBeGreaterThan(1);
    expect(syncLogs.filter((m) => m.includes('converted installer seed snapshot'))).toHaveLength(2);
  });

  it.each([undefined, 1])('cuts an explicit parent SHA with its pinned child and historical metadata (depth=%s)', async (depth) => {
    const subSrc = tmpDir('gseed-pinned-sub-');
    await initRepo(subSrc);
    writeFileSync(join(subSrc, 'lib.txt'), 'pinned child');
    await g(subSrc, ['add', '.']);
    await g(subSrc, ['commit', '-qm', 'child v1']);
    const childSha = await g(subSrc, ['rev-parse', 'HEAD']);

    const src = tmpDir('gseed-pinned-super-');
    await initRepo(src);
    writeFileSync(join(src, 'top.txt'), 'pinned parent');
    await g(src, ['add', '.']);
    await g(src, ['commit', '-qm', 'parent v1']);
    await g(src, ['-c', 'protocol.file.allow=always', 'submodule', 'add', subSrc, 'vendor/sub']);
    await g(src, ['commit', '-qm', 'pin child']);
    const parentSha = await g(src, ['rev-parse', 'HEAD']);
    expect(parentSha).not.toBe(childSha);

    // Both worktrees and the current .gitmodules advance beyond the selected
    // parent. A cut must read the selected tree, never the checked-out child HEAD.
    const child = join(src, 'vendor/sub');
    await g(child, ['config', 'user.email', 'seed@test']);
    await g(child, ['config', 'user.name', 'Seed Test']);
    await g(child, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(child, 'lib.txt'), 'newer child');
    await g(child, ['commit', '-aqm', 'child v2']);
    writeFileSync(join(src, 'top.txt'), 'newer parent');
    await g(src, ['config', '-f', '.gitmodules', 'submodule.vendor/sub.url', 'https://example/newer-child']);
    await g(src, ['add', '.']);
    await g(src, ['commit', '-qm', 'parent v2']);
    const sourceHead = await g(src, ['rev-parse', 'HEAD']);

    const provider = createGitSeedProvider();
    const { entry, payload } = await provider.cut({
      sourceRepoDir: src, stagingDir: tmpDir('gseed-pinned-stage-'),
      originUrl: 'https://example/parent', rev: parentSha, depth,
    });
    const target = join(tmpDir('gseed-pinned-target-'), 'checkout');
    await provider.restore(entry, payload, { targetRepoDir: target });
    expect(readFileSync(join(target, 'top.txt'), 'utf8')).toBe('pinned parent');
    expect(readFileSync(join(target, 'vendor/sub/lib.txt'), 'utf8')).toBe('pinned child');
    expect(await g(join(target, 'vendor/sub'), ['remote', 'get-url', 'origin'])).toBe(subSrc);
    expect(await g(target, ['status', '--short'])).toBe('');
    if (!depth) {
      expect(await g(target, ['rev-parse', 'HEAD'])).toBe(parentSha);
      expect(await g(join(target, 'vendor/sub'), ['rev-parse', 'HEAD'])).toBe(childSha);
    }
    expect(await g(src, ['rev-parse', 'HEAD'])).toBe(sourceHead);
    expect(await g(src, ['status', '--short'])).toBe('');
  });

  it('encrypts the seed at rest; restores with the key; fails without/with a wrong key', async () => {
    const src = tmpDir('gseed-enc-src-');
    await initRepo(src);
    writeFileSync(join(src, 'secret.txt'), 'private repo contents');
    await g(src, ['add', '.']);
    await g(src, ['commit', '-qm', 'secret']);

    const provider = createGitSeedProvider();
    const staging = tmpDir('gseed-enc-stage-');
    const key = generateSeedKey();
    const { entry, payload } = await provider.cut({
      sourceRepoDir: src,
      stagingDir: staging,
      originUrl: 'https://github.com/Papercusp/papercup',
      encryption: { key, keyRef: { via: 'seed-key-op', potId: 'papercusp' } },
    });
    // Envelope recorded; bundle on disk is ciphertext (no git-bundle header).
    expect(entry.encryption?.scheme).toBe('chacha20-poly1305');
    expect(entry.encryption?.keyRef).toEqual({ via: 'seed-key-op', potId: 'papercusp' });
    const raw = readFileSync(join(staging, 'super.bundle')).subarray(0, 32).toString('latin1');
    expect(raw).not.toMatch(/git bundle/);
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    // Restore WITH the key → the checkout materializes.
    const okTarget = join(tmpDir('gseed-enc-ok-'), 'checkout');
    await provider.restore(entry, payload, { targetRepoDir: okTarget, decryptionKey: key });
    expect(readFileSync(join(okTarget, 'secret.txt'), 'utf8')).toBe('private repo contents');

    // Restore with NO key → refused.
    const noKeyTarget = join(tmpDir('gseed-enc-nokey-'), 'checkout');
    await expect(provider.restore(entry, payload, { targetRepoDir: noKeyTarget })).rejects.toThrow(
      /no decryption key/i,
    );

    // Restore with a WRONG key → decrypt fails.
    const badTarget = join(tmpDir('gseed-enc-bad-'), 'checkout');
    await expect(
      provider.restore(entry, payload, { targetRepoDir: badTarget, decryptionKey: generateSeedKey() }),
    ).rejects.toThrow();
  });

  it('restores an encrypted seed from a READ-ONLY seed dir (packaged /usr/lib layout) and leaves no plaintext behind', async () => {
    // WI-5179: a packaged install's seed dir is a root-owned read-only resource
    // (/usr/lib/<Product>/seed). Decrypted bundles must materialize OUTSIDE it —
    // writing <seed>/.decrypted EACCES'd on every offline install, so the code
    // half never restored (and would have parked a private repo's plaintext next
    // to the installer payload).
    const src = tmpDir('gseed-ro-src-');
    await initRepo(src);
    writeFileSync(join(src, 'secret.txt'), 'private repo contents');
    await g(src, ['add', '.']);
    await g(src, ['commit', '-qm', 'secret']);

    const provider = createGitSeedProvider();
    const staging = tmpDir('gseed-ro-stage-');
    const key = generateSeedKey();
    const { entry, payload } = await provider.cut({
      sourceRepoDir: src,
      stagingDir: staging,
      originUrl: 'https://github.com/Papercusp/papercup',
      encryption: { key, keyRef: { via: 'epoch', potId: 'papercusp', epoch: 1 } },
    });

    await exec('chmod', ['-R', 'a-w', staging]);
    try {
      const target = join(tmpDir('gseed-ro-tgt-'), 'checkout');
      await provider.restore(entry, payload, { targetRepoDir: target, decryptionKey: key });
      expect(readFileSync(join(target, 'secret.txt'), 'utf8')).toBe('private repo contents');
      // Nothing landed inside the seed dir: no plaintext at rest, hash intact.
      expect(existsSync(join(staging, '.decrypted'))).toBe(false);
      expect(await provider.verify(entry, payload)).toEqual({ ok: true });
    } finally {
      await exec('chmod', ['-R', 'u+w', staging]);
    }
  });

  it('skips a submodule declared in .gitmodules but NOT checked out (no spawn ENOENT)', async () => {
    // Repro of the real cut failure: .gitmodules can declare a submodule whose
    // working tree was never initialized (e.g. the RETIRED libs/zero-harness).
    // A naive cut spawns `git bundle` in a cwd that doesn't exist → `spawn git
    // ENOENT`, aborting the ENTIRE cut. The provider must skip it and still cut.
    const src = tmpDir('gseed-uninit-');
    await initRepo(src);
    writeFileSync(join(src, 'top.txt'), 'top');
    // Declare a submodule with NO checked-out working tree (no <path>/.git).
    writeFileSync(
      join(src, '.gitmodules'),
      '[submodule "libs/retired"]\n\tpath = libs/retired\n\turl = https://example/retired\n',
    );
    await g(src, ['add', '.']);
    await g(src, ['commit', '-qm', 'top + a declared-but-uninitialized submodule']);

    const provider = createGitSeedProvider();
    const staging = tmpDir('gseed-uninit-stage-');
    // Must NOT throw; the uninitialized submodule is simply not seeded. The
    // provider DOES emit a console.warn for the skip (intentional, operator-
    // visible signal) — expect it explicitly so it doesn't trip the global
    // fail-on-console guard.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { entry, payload } = await provider.cut({ sourceRepoDir: src, stagingDir: staging, originUrl: 'u' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipping submodule 'libs/retired'"));
    warnSpy.mockRestore();
    expect(existsSync(join(staging, 'super.bundle'))).toBe(true);
    expect((entry.meta as { submodulePaths: string[] }).submodulePaths).toEqual([]);
    expect(await provider.verify(entry, payload)).toEqual({ ok: true });

    // And it still restores (super clones; no submodule to wire — a fresh member
    // cold-clones the retired path if it ever needs it).
    const target = join(tmpDir('gseed-uninit-tgt-'), 'checkout');
    await provider.restore(entry, payload, { targetRepoDir: target });
    expect(readFileSync(join(target, 'top.txt'), 'utf8')).toBe('top');
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
    const bogus = {
      kind: GIT_SEED_KIND,
      hash: 'deadbeef'.repeat(8),
      sizeBytes: 0,
      source: { type: 'resource' as const, path: staging },
    };
    const res = await provider.verify(bogus, payload);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/hash mismatch/);
  });
});
