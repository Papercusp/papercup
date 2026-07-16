/**
 * mac-leg-disk-reclaim.test.ts — regression guard for EI-12853.
 *
 * The mac release leg (papercusp-desktop/bin/release-local.sh) carried a FALSE
 * load-bearing premise for a week: a comment asserted the mac VM was "~9.6GB total
 * ... fundamentally too small" for a universal build. The VM is actually a 120GB
 * disk that was merely 96% full. Because the VM was believed unfixable,
 * PAPERCUSP_REUSE_MAC (which SHIPS STALE bytes from a prior cut) was designated the
 * "first-class salvage fallback" — so mac shipped salvaged bytes since 2026-07-08.
 *
 * The WI-4389 auto-reclaim compounded it: it only removed "debug" profile dirs under
 * a build tree that a --release build never populates (and the rsync excludes the
 * cargo target dir), so it freed ~0 bytes every time while printing success-shaped
 * output — disguising the real, regenerable space (Xcode/SPM/cargo caches) that a
 * fresh build never re-reads.
 *
 * This guard pins the corrected shape so a future edit cannot reinstate the false
 * premise or the no-op reclaim. STATIC assertions over the shell script (the fix
 * cannot be exercised without a mac VM + a real cut). Run:
 *   cd packages/operator-core && npx vitest run lib/mac-leg-disk-reclaim.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'release-local.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/release-local.sh above this test)',
  );
}

const ROOT = repoRoot();
const releaseLocal = readFileSync(
  join(ROOT, 'papercusp-desktop', 'bin', 'release-local.sh'),
  'utf8',
);

describe('EI-12853: mac leg has no false "VM too small" premise', () => {
  it('drops the false "~9.6GB total ... fundamentally too small" claim', () => {
    // The premise inverted a transient 96%-full disk into a permanent hardware limit.
    expect(releaseLocal).not.toContain('is fundamentally too small');
    // The old preflight comment's "(~9.6GB) is marginal" is gone too.
    expect(releaseLocal).not.toMatch(/\(~9\.6GB\)\s+is marginal/);
  });

  it('states the truth: the VM is a 120GB disk that needs cache reclamation', () => {
    expect(releaseLocal).toMatch(/120GB/);
  });
});

describe('EI-12853: PAPERCUSP_REUSE_MAC is demoted to an emergency last resort', () => {
  it('no longer names the salvage path as the first-class fallback', () => {
    // Leading with salvage taught every cut to reach for stale bytes first.
    expect(releaseLocal).not.toContain('as the FIRST-CLASS fallback');
    expect(releaseLocal).not.toContain('the first-class salvage fallback');
  });

  it('the salvage comment and the error both frame REUSE_MAC as a last resort', () => {
    expect(releaseLocal).toMatch(/EMERGENCY SALVAGE PATH \(last resort/);
    expect(releaseLocal).toMatch(/LAST RESORT ONLY: cut with PAPERCUSP_REUSE_MAC=1/);
  });
});

describe('EI-12853: the WI-4389 auto-reclaim targets real regenerable caches (not a no-op)', () => {
  it('reclaims the dirs that actually accumulate on this VM', () => {
    // The old reclaim hit only $MAC_VM_BUILD_DIR/.../target/**/debug — a path a
    // --release build never creates. The real consumers are these regenerable caches.
    expect(releaseLocal).toMatch(/Library\/Developer\/CoreSimulator/);
    expect(releaseLocal).toMatch(/Library\/Developer\/Xcode\/DerivedData/);
    expect(releaseLocal).toMatch(/spm-cache/);
    expect(releaseLocal).toMatch(/papercup-rust-mobile\/ios\/build/);
    expect(releaseLocal).toMatch(/papercup-rust-mobile\/target/);
  });

  it('measures and reports the bytes actually freed (no more silent 0-byte "self-heal")', () => {
    // Re-measure via df before/after and print what was reclaimed — the missing
    // signal that let a 0-byte reclaim masquerade as a fix.
    expect(releaseLocal).toContain('_mac_free_kb_before');
    expect(releaseLocal).toContain('_mac_reclaimed_gb');
    expect(releaseLocal).toMatch(/reclaimed ~\$\{_mac_reclaimed_gb\}GB/);
    // The error message surfaces the reclaim result so a 0-byte reclaim is visible.
    expect(releaseLocal).toMatch(/auto-reclaim freed ~\$\{_mac_reclaimed_gb\}GB/);
  });

  it('NEVER reclaims the live dogfood workspace', () => {
    // ~/.papercusp-workspaces holds a live peer instance's data (embedded PG, live
    // workspace). The reclaim allow-list must never rm it — only name it as off-limits.
    expect(releaseLocal).not.toMatch(/rm[^\n]*\.papercusp-workspaces/);
    // It IS named in the "never touch" guidance so an operator reclaiming by hand knows.
    expect(releaseLocal).toMatch(/\.papercusp-workspaces/);
  });
});
