/**
 * shipped-seed-artifact — the recurrence guard for EI-19455669487837783.
 *
 * WHY THIS EXISTS, given restore-hive-seed.test.ts already has 17 tests.
 *
 * Those tests cover the LOGIC exhaustively (resolve precedence, the WI-2902
 * autodetect fallthrough, the encrypted-git defer/split, failure isolation) —
 * but every one of them builds a SYNTHETIC seed. Nothing asserted that the seed
 * we actually SHIP is well-formed enough for that (correct) logic to succeed on
 * it. That gap is not hypothetical:
 *
 *   - WI-2902: every packaged install logged `restored=[]` — the logic was fine,
 *     the shipped artifact could not be opened.
 *   - WI-3306 (Windows) and WI-3307 (Mac) both closed on HAND verification of
 *     this artifact. On 2026-08-03 that hand check was performed a third time
 *     and produced a WRONG conclusion ("bundle ships unseeded"), retracted the
 *     same hour. A hand check that has to be re-derived per platform, per
 *     release, is a detector that fails silently.
 *
 * So this file asserts the shipped artifact's INTEGRITY, cheaply, in seconds —
 * it deliberately does NOT perform a restore. The restore itself is an in-process
 * hypercore replication of ~108k blocks and takes ~4m52s wall for the real 2.0G
 * seed (measured 2026-08-03), which is why it can never be a routine test; the
 * replication path is already covered with small fixtures by
 * seed-provider-corestore.test.ts.
 *
 * SKIPS when no seed is present (dev boxes and CI checkouts do not carry the
 * 2.0G payload). A skip must never read as a pass — the skip reason says so.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeManifest } from '@papercusp/seed-bundle';
import { resolveSeedDir, SEED_MANIFEST_FILE } from './restore-hive-seed';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/operator-core/lib/sync/hyperbee → repo root */
const REPO_ROOT = join(HERE, '../../../../..');
/** Overridable so falsifiability can be proven against a DOCTORED COPY outside the
 *  tree — never by mutating the real artifact (the shared tree is swept into commits
 *  every few minutes, so an in-tree mutation can be committed mid-probe). */
const SEED_DIR = process.env.PAPERCUSP_TEST_SEED_DIR ?? join(REPO_ROOT, 'papercusp-desktop/src-tauri/seed');

const seedPresent = existsSync(join(SEED_DIR, SEED_MANIFEST_FILE));

/** Total bytes + file count of a payload dir (mirrors how the manifest's
 *  sizeBytes is cut: regular files only, recursive). */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

describe.skipIf(!seedPresent)('shipped seed artifact (integrity of the real bundled seed)', () => {
  const manifest = seedPresent
    ? decodeManifest(readFileSync(join(SEED_DIR, SEED_MANIFEST_FILE), 'utf8'))
    : null;

  it('resolves via the shipped precedence — PAPERCUSP_SEED_DIR ⇒ source:env, not a cold path', () => {
    const r = resolveSeedDir({ env: { PAPERCUSP_SEED_DIR: SEED_DIR } });
    expect(r.disabled).toBe(false);
    expect(r.seedDir).toBe(SEED_DIR);
    // 'env-missing' here would mean the shipped dir holds no manifest — i.e. the
    // artifact ships in a shape boot silently cold-paths on.
    expect(r.source).toBe('env');
  });

  it('the manifest parses with the REAL decoder (not JSON.parse) and names a hive', () => {
    // decodeManifest throws SeedManifestError on a schema regression — a manifest
    // that is valid JSON but invalid to the decoder cold-paths at boot with only
    // an info-level log, so it must fail loudly HERE instead.
    expect(manifest!.seedFormatVersion).toBeGreaterThanOrEqual(1);
    expect(manifest!.potId.length).toBeGreaterThan(0);
    expect(manifest!.stores.length).toBeGreaterThan(0);
  });

  it('declares a corestore store with at least one coreKey — the WI-2902 `restored=[]` guard', () => {
    const core = manifest!.stores.find((s) => s.kind === 'corestore');
    expect(core, 'no corestore store in the shipped manifest').toBeDefined();
    const coreKeys = (core!.meta as { coreKeys?: readonly string[] } | undefined)?.coreKeys ?? [];
    // Zero coreKeys restores NOTHING while still reporting success — the exact
    // shape of the packaged-install failure in WI-2902.
    expect(coreKeys.length).toBeGreaterThan(0);
  });

  it('keeps the git store ENCRYPTED, so boot defers it pre-admission (the documented split)', () => {
    const git = manifest!.stores.find((s) => s.kind === 'git');
    expect(git, 'no git store in the shipped manifest').toBeDefined();
    // If a packaging change ever ships git unencrypted, boot would restore it
    // PRE-admission instead of deferring — a silent change to boot semantics.
    expect(git!.encryption).toBeDefined();
  });

  it('every declared payload exists on disk at its declared size (catches a truncated/partial ship)', () => {
    for (const store of manifest!.stores) {
      const payloadDir = join(SEED_DIR, store.source.path);
      expect(existsSync(payloadDir), `${store.kind}: payload dir missing at ${payloadDir}`).toBe(true);
      const actual = measure(payloadDir);
      expect(actual.files, `${store.kind}: payload dir is empty`).toBeGreaterThan(0);
      // This is precisely the check WI-3306/WI-3307 performed BY HAND. A partial
      // ship (interrupted copy, a bundler that dropped files) leaves a manifest
      // promising bytes the payload no longer has, and boot only discovers it
      // mid-restore.
      expect(actual.bytes, `${store.kind}: payload size drifted from the manifest`).toBe(store.sizeBytes);
    }
  });

  it('ships the bundled epoch keys — the offline path for the DEFERRED git restore', () => {
    // bootstrap-papercusp-hive.ts:453-458 calls this "the crux of the offline pot":
    // post-admission the deferred git store resolves its key from this file when
    // there is no network. Absent ⇒ the offline pot degrades to a cold join.
    const keysPath = join(SEED_DIR, 'epoch-keys.json');
    expect(existsSync(keysPath), 'epoch-keys.json missing — offline git restore cannot resolve a key').toBe(true);
    const parsed = JSON.parse(readFileSync(keysPath, 'utf8')) as unknown;
    expect(parsed, 'epoch-keys.json is not a non-empty object').toBeTruthy();
    expect(Object.keys(parsed as Record<string, unknown>).length).toBeGreaterThan(0);
  });
});

describe.skipIf(seedPresent)('shipped seed artifact', () => {
  it('SKIPPED — no bundled seed in this checkout (a skip is NOT a pass)', () => {
    // Present so the absence is visible in the report rather than silent.
    expect(seedPresent).toBe(false);
  });
});
