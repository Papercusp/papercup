/**
 * win-leg-pack-verify.test.ts — regression guard for EI-8914.
 *
 * The Windows release leg (papercusp-desktop/bin/build-windows-on-vm.sh) runs a
 * fast local Windows-cfg pre-check, then packs the desktop tree into a tarball
 * MINUTES later (a seed cut + a ~2.2G zstd source stage sit in between) and ships
 * it to the VM. The shared checkout is edited CONCURRENTLY by the whole fleet, so
 * three distinct TOCTOU defects were observed live on 2026-07-09:
 *
 *   1. VERIFIED != PACKED — a peer edit landing AFTER the pre-check ships code no
 *      Windows gate ever saw (a `sweep_orphaned_sidecars()` call went in with only
 *      a `#[cfg(unix)]` definition, leaving the windows target E0425-red for ~90s).
 *   2. TORN PACK — `tar` reads the tree over many seconds; a peer writing main.rs
 *      mid-tar is captured half-written, and tar's tolerated rc==1 "file changed as
 *      we read it" warning HIDES it.
 *   3. LABELED != PACKED — `PAPERCUSP_BUILD_SHA` was a caller-supplied constant
 *      tied to nothing; the 0.0.5 cut self-reported `1a161ab-wi3407` while its
 *      packed main.rs was byte-identical to a commit 767 files / ~10k lines apart.
 *
 * The durable fix (all landed in build-windows-on-vm.sh):
 *   - `rust_src_fingerprint()` — sha256 over the sorted *.rs files under
 *     src-tauri/src + Cargo.toml + Cargo.lock + tauri*.conf.json.
 *   - Capture PRECHECK_FP right after the early pre-check; re-gate before packing
 *     if the fingerprint moved.
 *   - Pack-verify loop (<=3 attempts): fingerprint -> tar -> re-fingerprint; break
 *     only when the fingerprint is unchanged across the pack, else repack; FAIL
 *     closed if the tree kept changing after 3 attempts.
 *   - DERIVE the provenance label from the packed tree (git HEAD + `-dirty`);
 *     demote any caller-supplied PAPERCUSP_BUILD_SHA to a human suffix.
 *
 * These are STATIC assertions over the shell script (no VM, no real cut — the fix
 * cannot be exercised without a Windows VM build), mirroring the sibling
 * win-leg-build-timeout.test.ts. They pin the invariants so a future edit cannot
 * silently drop the pack-verify loop / re-gate / derived provenance and re-open
 * the TOCTOU class. Run:
 *   cd packages/operator-core && npx vitest run lib/win-leg-pack-verify.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'build-windows-on-vm.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/build-windows-on-vm.sh above this test)',
  );
}

const ROOT = repoRoot();
const winLeg = readFileSync(
  join(ROOT, 'papercusp-desktop', 'bin', 'build-windows-on-vm.sh'),
  'utf8',
);

describe('EI-8914: the packed tree is fingerprinted (VERIFIED == PACKED foundation)', () => {
  it('defines a rust_src_fingerprint() over the sources that decide the Rust binary', () => {
    // The whole fix hangs off a content hash of what compiles + what the binary is.
    // Without it there is nothing to tie "the tree we gated" to "the tree we packed".
    expect(winLeg).toMatch(/rust_src_fingerprint\s*\(\)\s*\{/);
  });

  it('the fingerprint covers src-tauri/src/**/*.rs + Cargo.toml + Cargo.lock + tauri*.conf.json', () => {
    // A fingerprint that misses one of these lets a peer edit slip through unseen.
    // Assert the fingerprint body hashes each input class.
    const idx = winLeg.indexOf('rust_src_fingerprint');
    const fpBody = winLeg.slice(idx, idx + 400);
    expect(fpBody).toMatch(/src-tauri\/src/);
    expect(fpBody).toMatch(/-name\s+'\*\.rs'/);
    expect(fpBody).toMatch(/Cargo\.toml/);
    expect(fpBody).toMatch(/Cargo\.lock/);
    expect(fpBody).toMatch(/tauri\*\.conf\.json/);
    expect(fpBody).toMatch(/sha256sum/);
  });

  it('captures the fingerprint of the tree the pre-check gated (PRECHECK_FP)', () => {
    // The gate's verdict only describes the bytes at gate time; PRECHECK_FP remembers
    // exactly WHICH tree passed so we can detect drift before spending a VM build.
    expect(winLeg).toMatch(/PRECHECK_FP="\$\(rust_src_fingerprint\)"/);
  });
});

describe('EI-8914: re-gate the tree we are about to pack (VERIFIED != PACKED)', () => {
  it('re-fingerprints before packing and re-runs the Windows-cfg gate on drift', () => {
    // A peer edit landing between the early pre-check and the tar must NOT ship
    // un-gated: on fingerprint drift, re-run check-windows-cfg.sh before the VM spend.
    expect(winLeg).toMatch(/fp_pre="\$\(rust_src_fingerprint\)"/);
    expect(winLeg).toMatch(/fp_pre[\s\S]{0,240}PRECHECK_FP/);
    expect(winLeg).toMatch(/fp_pre[\s\S]{0,320}check-windows-cfg\.sh/);
  });

  it('fails closed when the re-gate finds the about-to-be-packed tree red', () => {
    // Must abort (nothing shipped), not warn-and-continue, when the drifted tree
    // no longer passes the Windows gate.
    expect(winLeg).toMatch(/fail[\s\S]{0,240}gate FAILED on the tree about to be packed/i);
  });
});

describe('EI-8914: detect a torn pack (concurrent edit DURING tar)', () => {
  it('re-fingerprints AFTER the tar and only accepts a pack whose tree did not move', () => {
    // tar reads the tree over seconds; fp_pre == fp_post proves nothing changed
    // under the pack. Anything else is a possibly-torn tarball.
    expect(winLeg).toMatch(/fp_post="\$\(rust_src_fingerprint\)"/);
    expect(winLeg).toMatch(/\[\[\s*"\$fp_pre"\s*==\s*"\$fp_post"\s*\]\]/);
  });

  it('bounds the repack to a few attempts and FAILS if the tree never quiesces', () => {
    // A live-editing peer must not spin the pack forever — bound it and fail loudly
    // so nothing torn is shipped.
    expect(winLeg).toMatch(/for\s+pack_attempt\s+in\s+1\s+2\s+3/);
    expect(winLeg).toMatch(/fail[\s\S]{0,240}kept changing under the pack after 3 attempts/i);
  });

  it('records the identity of the tree it actually packed (TARBALL.fp)', () => {
    // The label step reads this back; without it the provenance label cannot be
    // tied to the packed bytes.
    expect(winLeg).toMatch(/>\s*"\$TARBALL\.fp"/);
  });
});

describe('EI-8914: the provenance label is DERIVED from the packed tree (LABELED != PACKED)', () => {
  it('computes the commit portion from the tree (git HEAD), never trusting a caller-supplied SHA', () => {
    // PAPERCUSP_BUILD_SHA used to be a caller constant tied to nothing. The commit
    // portion must be COMPUTED from the tree we packed.
    expect(winLeg).toMatch(/rev-parse --short HEAD/);
    expect(winLeg).toMatch(/PACKED_FP="\$\(cat "\$TARBALL\.fp"/);
  });

  it('marks the working tree dirty (the pack snapshots a tree ~always dirty vs HEAD)', () => {
    // On this fleet git-sync commits on a schedule, so the packed working tree is
    // almost never == HEAD. An honest label says `-dirty` rather than implying a
    // clean commit.
    expect(winLeg).toMatch(/diff --quiet HEAD/);
    expect(winLeg).toMatch(/-dirty/);
  });

  it('demotes any caller-supplied PAPERCUSP_BUILD_SHA to a suffix instead of baking it as-is', () => {
    // A caller SHA may only add human context; it can no longer masquerade as the
    // real provenance of the packed bytes.
    expect(winLeg).toMatch(/PAPERCUSP_BUILD_SHA is DEPRECATED/);
    expect(winLeg).toMatch(/PAPERCUSP_BUILD_TAG/);
  });
});
