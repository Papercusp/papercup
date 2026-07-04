/**
 * restore-hive-seed.test.ts — the restore-before-join orchestration (P-007).
 *
 * Fixture-only (real git, real corestore, no network/PG). Proves:
 *  - no seed / corrupt manifest ⇒ cold path (ran:false), never a boot failure;
 *  - an UNENCRYPTED seed restores both stores pre-key;
 *  - the ADMISSION-TIMING SPLIT: an ENCRYPTED git seed with NO key DEFERS git but
 *    still restores the (plaintext-container) corestore pre-join; supplying the key
 *    restores git too;
 *  - failure isolation: one store's bad payload cold-paths only that store.
 */

import { afterEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSeedKey } from '@papercusp/seed-bundle';
import { openOwnLog, type PeerLogOp } from './peer-log';
import { cutHiveSeed } from './seed-cutter';
import { restoreHiveSeed, SEED_MANIFEST_FILE } from './restore-hive-seed';

const exec = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* ignore */
    }
  }
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function makeStore(dir: string): Corestore {
  const store = new Corestore(dir);
  cleanups.push(() => store.close());
  return store;
}

function op(i: number): PeerLogOp {
  return { type: 'put', table: 'harness_plans', hbKey: `P-${i}`, value: { id: `P-${i}` }, ts: 100 + i, schema_version: 1, author_pubkey: 'ownerdev' };
}

async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.email', 'seed@test']);
  await g(dir, ['config', 'user.name', 'Seed Test']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'code.txt'), 'the repo');
  await g(dir, ['add', '.']);
  await g(dir, ['commit', '-qm', 'init']);
}

/** Cut a fixture seed (git + corestore) into a fresh dir; return { seedDir, keyHex }. */
async function cutFixtureSeed(opts: { encryptGit?: Uint8Array } = {}): Promise<{ seedDir: string; keyHex: string }> {
  const repo = tmpDir('rhs-repo-');
  await initRepo(repo);
  const store = makeStore(tmpDir('rhs-store-'));
  await store.ready();
  const log = await openOwnLog(store);
  for (let i = 0; i < 3; i++) await log.append(op(i));
  const keyHex = log.keyHex;

  const seedDir = tmpDir('rhs-seed-');
  await rm(seedDir, { recursive: true, force: true });
  await cutHiveSeed({
    hiveId: 'papercusp', cutAtEpoch: 0, cutHlc: '0', cutTs: 1, outDir: seedDir,
    git: {
      sourceRepoDir: repo,
      originUrl: 'https://github.com/Papercusp/papercup',
      rev: '--all',
      ...(opts.encryptGit ? { encryption: { key: opts.encryptGit, keyRef: { via: 'seed-key-op' as const, hiveId: 'papercusp' } } } : {}),
    },
    corestore: { sourceStore: store, coreKeys: [keyHex] },
  });
  return { seedDir, keyHex };
}

async function corestoreSeededLength(targetStoreDir: string, keyHex: string): Promise<number> {
  const store = makeStore(targetStoreDir);
  await store.ready();
  type TestCore = { length: number; ready(): Promise<void> };
  const core = store.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
  await core.ready();
  return core.length;
}

describe('restoreHiveSeed — restore-before-join orchestration', () => {
  it('no seed present ⇒ cold path (ran:false), never throws', async () => {
    const res = await restoreHiveSeed({
      seedDir: join(tmpDir('rhs-empty-'), 'nope'),
      targetRepoDir: join(tmpDir('rhs-r-'), 'repo'),
      targetStoreDir: join(tmpDir('rhs-s-'), 'hyperbee'),
    });
    expect(res).toEqual({ ran: false, outcomes: [], deferred: [] });
  });

  it('a corrupt manifest ⇒ cold path, never a boot failure', async () => {
    const seedDir = tmpDir('rhs-corrupt-');
    writeFileSync(join(seedDir, SEED_MANIFEST_FILE), '{ not valid json');
    const res = await restoreHiveSeed({
      seedDir,
      targetRepoDir: join(tmpDir('rhs-r2-'), 'repo'),
      targetStoreDir: join(tmpDir('rhs-s2-'), 'hyperbee'),
    });
    expect(res.ran).toBe(false);
  });

  it('an UNENCRYPTED seed restores BOTH stores pre-key', async () => {
    const { seedDir, keyHex } = await cutFixtureSeed();
    const targetRepoDir = join(tmpDir('rhs-r3-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-s3-'), 'hyperbee');

    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual([]);
    expect(res.outcomes.every((o) => o.ok)).toBe(true);
    expect(res.outcomes.map((o) => o.kind).sort()).toEqual(['corestore', 'git']);
    // Git checkout + corestore blocks both pre-positioned.
    expect(readFileSync(join(targetRepoDir, 'code.txt'), 'utf8')).toBe('the repo');
    expect(await corestoreSeededLength(targetStoreDir, keyHex)).toBe(3);
  });

  it('SPLIT: an ENCRYPTED git seed with NO key DEFERS git, still restores corestore pre-join', async () => {
    const key = generateSeedKey();
    const { seedDir, keyHex } = await cutFixtureSeed({ encryptGit: key });
    const targetRepoDir = join(tmpDir('rhs-r4-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-s4-'), 'hyperbee');

    // No decryptionKey → git deferred (awaiting post-admission key), corestore restores.
    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual(['git']);
    expect(res.outcomes.map((o) => o.kind)).toEqual(['corestore']);
    expect(res.outcomes[0].ok).toBe(true);
    expect(await corestoreSeededLength(targetStoreDir, keyHex)).toBe(3);
    expect(existsSync(join(targetRepoDir, 'code.txt'))).toBe(false); // git NOT restored (deferred)
  });

  it('SPLIT: supplying the key restores the git seed too', async () => {
    const key = generateSeedKey();
    const { seedDir } = await cutFixtureSeed({ encryptGit: key });
    const targetRepoDir = join(tmpDir('rhs-r5-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-s5-'), 'hyperbee');

    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir, decryptionKey: key });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual([]);
    expect(res.outcomes.every((o) => o.ok)).toBe(true);
    expect(readFileSync(join(targetRepoDir, 'code.txt'), 'utf8')).toBe('the repo');
  });

  it('failure isolation: a wrong git key cold-paths git but corestore still restores', async () => {
    const key = generateSeedKey();
    const { seedDir, keyHex } = await cutFixtureSeed({ encryptGit: key });
    const targetRepoDir = join(tmpDir('rhs-r6-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-s6-'), 'hyperbee');

    // Present-but-WRONG key: git is NOT deferred (a key exists) — it ATTEMPTS and
    // fails at decrypt; corestore is unaffected.
    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir, decryptionKey: generateSeedKey() });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual([]);
    const byKind = Object.fromEntries(res.outcomes.map((o) => [o.kind, o]));
    expect(byKind.corestore.ok).toBe(true);
    expect(byKind.git.ok).toBe(false); // decrypt failed → cold-pathed, not thrown
    expect(await corestoreSeededLength(targetStoreDir, keyHex)).toBe(3);
  });
});
