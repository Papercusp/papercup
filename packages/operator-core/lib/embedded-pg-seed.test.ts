/**
 * embedded-pg-seed.test.ts
 *
 * Unit coverage for the desktop first-boot fast path (WI-2601): a pre-migrated
 * PGDATA seed extracted on a fresh data dir INSTEAD of running initdb + the full
 * migration replay. Tests the two new, extraction-bug-prone helpers exported from
 * @papercusp/embedded-postgres-server without booting a real postmaster (the full
 * real-PG round-trip is proven separately + on the Mac release verify):
 *   - resolveSeedPath(): opts vs env precedence + the PAPERCUSP_PG_DISABLE_SEED kill.
 *   - extractSeed(): a directory seed AND a .tar.gz seed both land a bootable-shaped
 *     data dir (PG_VERSION + nested files) at 0700.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSeedPath, extractSeed } from '@papercusp/embedded-postgres-server';

const cleanups: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

/** A minimal PGDATA-shaped fixture dir (PG_VERSION marker + a nested file). */
function makeFakePgdata(): string {
  const d = tmp('seed-src-');
  writeFileSync(join(d, 'PG_VERSION'), '16\n');
  mkdirSync(join(d, 'base'), { recursive: true });
  writeFileSync(join(d, 'base', 'marker'), 'hello-seed');
  return d;
}

describe('resolveSeedPath (opts/env precedence + disable kill)', () => {
  it('prefers opts.seedPath over the env var', () => {
    expect(resolveSeedPath({ seedPath: '/a/opts.tar.gz' }, { PAPERCUSP_PG_SEED_PATH: '/b/env.tar.gz' }))
      .toBe('/a/opts.tar.gz');
  });
  it('falls back to PAPERCUSP_PG_SEED_PATH when no opt', () => {
    expect(resolveSeedPath({}, { PAPERCUSP_PG_SEED_PATH: '/b/env.tar.gz' })).toBe('/b/env.tar.gz');
  });
  it('returns null when neither is set', () => {
    expect(resolveSeedPath({}, {})).toBeNull();
  });
  it('PAPERCUSP_PG_DISABLE_SEED forces null even if a seed is configured', () => {
    expect(resolveSeedPath({ seedPath: '/a/opts.tar.gz' }, { PAPERCUSP_PG_DISABLE_SEED: '1' })).toBeNull();
    expect(resolveSeedPath({}, { PAPERCUSP_PG_SEED_PATH: '/b/env.tar.gz', PAPERCUSP_PG_DISABLE_SEED: '1' })).toBeNull();
  });
});

describe('extractSeed (directory + tar.gz seed → bootable-shaped data dir)', () => {
  it('recursively copies a DIRECTORY seed and chmods the data dir 0700', async () => {
    const src = makeFakePgdata();
    const dataDir = tmp('seed-dst-');
    await extractSeed(src, dataDir);
    expect(existsSync(join(dataDir, 'PG_VERSION'))).toBe(true);
    expect(readFileSync(join(dataDir, 'base', 'marker'), 'utf8')).toBe('hello-seed');
    if (process.platform !== 'win32') {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    }
  });

  it('extracts a .tar.gz seed (root = PGDATA contents) into the data dir', async () => {
    const src = makeFakePgdata();
    const archive = join(tmp('seed-arc-'), 'db-seed.tar.gz');
    // Archive CONTENTS at root, mirroring build-seed.mjs (`tar -c -z -C <pgdata> .`).
    execFileSync('tar', ['-c', '-z', '-f', archive, '-C', src, '.']);

    const dataDir = tmp('seed-dst-');
    await extractSeed(archive, dataDir);
    expect(existsSync(join(dataDir, 'PG_VERSION'))).toBe(true);
    expect(readFileSync(join(dataDir, 'base', 'marker'), 'utf8')).toBe('hello-seed');
    if (process.platform !== 'win32') {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    }
  });

  it('throws on a missing seed source (caller then falls back to initdb)', async () => {
    await expect(extractSeed(join(tmpdir(), 'does-not-exist-xyz'), tmp('seed-dst-'))).rejects.toThrow();
  });
});
