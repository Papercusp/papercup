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
 *   - SEED_INITDB_FLAGS locale portability: the WI-2649 recurrence guard — the
 *     shipped seed's postgresql.conf must name a PORTABLE locale (C.UTF-8), never
 *     the build host's (en_US.UTF-8), or first boot FATALs on the lean Windows
 *     WSL rootfs. Pure assertion on the single-source-of-truth flag, no real PG.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSeedPath,
  extractSeed,
  SEED_INITDB_FLAGS,
  PORTABLE_INITDB_LOCALES,
  RUNTIME_LC_PARAMS,
  initdbLocale,
  initdbLocaleIsPortable,
  localeIsPortable,
  confLcNonPortable,
  normalizeConfLc,
} from '@papercusp/embedded-postgres-server';

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

describe('initdb locale portability (WI-2649 recurrence guard)', () => {
  // A flag guard is NECESSARY BUT NOT SUFFICIENT — the WI-2749 correction. The
  // bundled `embedded-postgres` package hard-injects `--lc-messages=<getBestLocale()>`
  // into initdb BEFORE our SEED_INITDB_FLAGS, and getBestLocale prefers the build
  // host's en_US.UTF-8. A per-category `--lc-messages` overrides `--locale` for
  // that ONE category, so `--locale=C.UTF-8` alone left lc_messages='en_US.utf8'
  // in the seed while every other lc_* was C.UTF-8 — and that one FATALed the
  // postmaster on the lean rootfs (WI-2749). The fix is two-layer: pin
  // `--lc-messages=C.UTF-8` explicitly (below) AND normalize the on-disk conf on
  // every boot (the WI-2749 block). These flag tests still guard the --locale pin.

  it('SEED_INITDB_FLAGS pins an explicit, portable locale (== C.UTF-8)', () => {
    expect(initdbLocale(SEED_INITDB_FLAGS)).toBe('C.UTF-8');
    expect(initdbLocaleIsPortable(SEED_INITDB_FLAGS)).toBe(true);
  });

  it('SEED_INITDB_FLAGS ALSO pins --lc-messages=C.UTF-8 (overrides the package injection — WI-2749)', () => {
    // The package prepends --lc-messages=<build-host locale>; ours must appear
    // (later, so initdb last-duplicate-wins picks it) or lc_messages slips through.
    const i = SEED_INITDB_FLAGS.indexOf('--lc-messages=C.UTF-8');
    expect(i).toBeGreaterThanOrEqual(0);
  });

  it("the shipped seed's postgresql.conf lc_* never names the build host's locale", () => {
    // The exact value that FATALed on the Windows rootfs in WI-2649.
    const shippedLocale = initdbLocale(SEED_INITDB_FLAGS);
    expect(shippedLocale).not.toBe('en_US.UTF-8');
    expect(shippedLocale).not.toMatch(/^[a-z]{2}_[A-Z]{2}/); // no ll_CC host locale
    // Whatever it is, it must be one this package promises is present everywhere.
    expect(PORTABLE_INITDB_LOCALES.map((l) => l.toLowerCase())).toContain(
      String(shippedLocale).toLowerCase(),
    );
  });

  it('rejects the regression shapes: host-specific locale, or no --locale at all', () => {
    // A full-locale build host baked into the flags (the WI-2649 bug shape).
    expect(initdbLocaleIsPortable(['--locale=en_US.UTF-8', '--encoding=UTF8'])).toBe(false);
    expect(initdbLocaleIsPortable(['--locale=en_GB.UTF-8'])).toBe(false);
    // No `--locale` → initdb inherits the host's LANG → not portable.
    expect(initdbLocaleIsPortable(['--encoding=UTF8'])).toBe(false);
    expect(initdbLocaleIsPortable([])).toBe(false);
    expect(initdbLocaleIsPortable(undefined)).toBe(false);
  });

  it('accepts every portable locale, case/hyphenation-insensitively', () => {
    for (const loc of PORTABLE_INITDB_LOCALES) {
      expect(initdbLocaleIsPortable([`--locale=${loc}`])).toBe(true);
    }
  });

  it('initdbLocale parses both --locale=X and split --locale X spellings', () => {
    expect(initdbLocale(['--locale=C.UTF-8'])).toBe('C.UTF-8');
    expect(initdbLocale(['--locale', 'C.UTF-8', '--encoding=UTF8'])).toBe('C.UTF-8');
    expect(initdbLocale(['--encoding=UTF8'])).toBeNull();
    expect(initdbLocale([])).toBeNull();
    expect(initdbLocale(['--locale'])).toBeNull(); // dangling flag, no value
  });
});

describe('postgresql.conf lc_* portability (WI-2749 conf-level guard)', () => {
  // The ACTUAL artifact-level guard. WI-2649's flag pin proved insufficient: the
  // embedded-postgres package injected --lc-messages=en_US.utf8, so the shipped
  // seed carried lc_messages='en_US.utf8' (others C.UTF-8) and FATALed first boot
  // on the C/C.utf8/POSIX-only WSL rootfs. confLcNonPortable/normalizeConfLc
  // operate on the real postgresql.conf text, closing the class regardless of
  // what the underlying package injects.

  // The exact conf the broken seed shipped (verbatim shape from the VM, 2026-07-04).
  const BROKEN_CONF = [
    "lc_messages = 'en_US.utf8'\t\t# locale for system error message",
    "                                        # string; actually, defaults to LC_MESSAGES",
    "lc_monetary = 'C.UTF-8'\t\t\t# locale for monetary formatting",
    "lc_numeric = 'C.UTF-8'\t\t\t# locale for number formatting",
    "lc_time = 'C.UTF-8'\t\t\t# locale for time formatting",
  ].join('\n');

  it('localeIsPortable accepts C-family, rejects host locales', () => {
    expect(localeIsPortable('C.UTF-8')).toBe(true);
    expect(localeIsPortable('C.utf8')).toBe(true);
    expect(localeIsPortable('C')).toBe(true);
    expect(localeIsPortable('POSIX')).toBe(true);
    expect(localeIsPortable('en_US.utf8')).toBe(false);
    expect(localeIsPortable('en_US.UTF-8')).toBe(false);
    expect(localeIsPortable(undefined as unknown as string)).toBe(false);
  });

  it('RUNTIME_LC_PARAMS covers exactly the four startup-validated GUCs', () => {
    expect(RUNTIME_LC_PARAMS).toEqual(['lc_messages', 'lc_monetary', 'lc_numeric', 'lc_time']);
    // lc_collate / lc_ctype are initdb-fixed in pg_database, NOT re-validated at
    // start — deliberately excluded so we never try to rewrite an immutable GUC.
    expect(RUNTIME_LC_PARAMS).not.toContain('lc_collate');
    expect(RUNTIME_LC_PARAMS).not.toContain('lc_ctype');
  });

  it('confLcNonPortable flags exactly the broken lc_messages the seed shipped', () => {
    expect(confLcNonPortable(BROKEN_CONF)).toEqual(["lc_messages='en_US.utf8'"]);
  });

  it('confLcNonPortable returns [] for an all-portable conf', () => {
    const ok = BROKEN_CONF.replace("'en_US.utf8'", "'C.UTF-8'");
    expect(confLcNonPortable(ok)).toEqual([]);
  });

  it('normalizeConfLc rewrites the bad lc_messages, preserves the comment + other lines', () => {
    const { text, changed } = normalizeConfLc(BROKEN_CONF);
    expect(changed).toBe(true);
    expect(text).toContain("lc_messages = 'C.UTF-8'\t\t# locale for system error message");
    // Untouched portable lines stay byte-identical.
    expect(text).toContain("lc_monetary = 'C.UTF-8'\t\t\t# locale for monetary formatting");
    // And the result is now clean.
    expect(confLcNonPortable(text)).toEqual([]);
  });

  it('normalizeConfLc is idempotent + a no-op on an already-portable conf', () => {
    const clean = BROKEN_CONF.replace("'en_US.utf8'", "'C.UTF-8'");
    const first = normalizeConfLc(clean);
    expect(first.changed).toBe(false);
    expect(first.text).toBe(clean);
    // Normalizing the fixed output again changes nothing.
    const fixed = normalizeConfLc(BROKEN_CONF).text;
    expect(normalizeConfLc(fixed).changed).toBe(false);
  });

  it('normalizeConfLc leaves COMMENTED-out lc_* lines alone (only active GUCs)', () => {
    const commented = "#lc_messages = 'en_US.utf8'\t# default";
    const { text, changed } = normalizeConfLc(commented);
    expect(changed).toBe(false);
    expect(text).toBe(commented);
  });
});
