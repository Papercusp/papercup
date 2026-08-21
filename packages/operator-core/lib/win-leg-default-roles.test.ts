/**
 * win-leg-default-roles.test.ts — regression guard for WI-5600.
 *
 * On Windows the GUI is a THIN CLIENT that attaches to com.papercusp.server
 * (exactly like mac); it cannot launch without the separately-installed Server.
 * WI-5559 had narrowed the Windows build to gui-only by default on the premise
 * that the Windows Server is unpublished throwaway output. WI-5600 (owner
 * -reported, angry, 2026-07-20) proved that premise wrong: the gui-only default
 * shipped a DEAD 0.0.12 Windows build that could not start, and the Windows
 * Server IS a required, published product (0.0.12's Server is live on the
 * releases site). This is the same class of regression D-004 fixed for mac/linux
 * (EI-18099496479921046). The reversal lives in TWO places that must AGREE:
 *   1. the Windows producer's own default (a direct invocation must build both).
 *   2. release-local.sh forwarding the resolved roles into the Windows leg
 *      (it must NOT strip them back to gui-only — the WI-5559 `env -u` hack).
 * Either one reverting alone re-ships the dead build, so both are pinned here.
 *
 * WI-5651 (2026-07-20) retired the QEMU-VM producer `build-windows-on-vm.sh`
 * (SSH + a real Windows VM) in favor of `build-windows-cross.sh` (cross-compile
 * + wine, no VM) — it is now the ONLY Windows producer release-local.sh calls
 * (see its `WIN_PRODUCER=` assignment). This test was retargeted from the
 * retired script to the live one (WI-5669); it carries the same default-roles
 * env contract (`PAPERCUSP_BUILD_ROLES` documented in the cross script's own
 * header as mirroring the old VM script's contract).
 *
 * These are STATIC assertions over the shell scripts (no VM, no real cut — the
 * behavior cannot be exercised without a real Windows cross-build). Run:
 *   cd packages/operator-core && npx vitest run lib/win-leg-default-roles.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'build-windows-cross.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/build-windows-cross.sh above this test)',
  );
}

const ROOT = repoRoot();
const winLeg = readFileSync(join(ROOT, 'papercusp-desktop', 'bin', 'build-windows-cross.sh'), 'utf8');
const releaseLocal = readFileSync(join(ROOT, 'papercusp-desktop', 'bin', 'release-local.sh'), 'utf8');
const innoSpanHelper = readFileSync(
  join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'inno-spanned-server.sh'),
  'utf8',
);

describe('WI-5600: the Windows leg builds gui+server by DEFAULT (never a dead gui-only cut)', () => {
  it('build-windows-cross.sh defaults PAPERCUSP_BUILD_ROLES to include server (not gui-only)', () => {
    // The `${PAPERCUSP_BUILD_ROLES:-<default>}` fallback is what an UNSET caller
    // (a plain release cut) resolves to. It must include `server`, or a normal
    // Windows cut ships a GUI with no Server to attach to (the WI-5600 dead build).
    const m = winLeg.match(/ROLES="\$\{PAPERCUSP_BUILD_ROLES:-([^}]*)\}"/);
    expect(m, 'build-windows-cross.sh must default PAPERCUSP_BUILD_ROLES via :- fallback').not.toBeNull();
    const dflt = (m![1] || '').trim();
    expect(dflt.split(/\s+/)).toContain('server');
    expect(dflt.split(/\s+/)).toContain('gui');
    // Guard the exact regression: the default is NOT bare `gui`.
    expect(dflt).not.toBe('gui');
  });

  it('release-local.sh forwards the resolved roles into the Windows leg (no WI-5559 gui-only strip)', () => {
    // The Windows subshell must forward PAPERCUSP_BUILD_ROLES into the child's env,
    // mirroring the mac leg. The reverted bug stripped it with `env -u
    // PAPERCUSP_BUILD_ROLES` so the child fell back to its (then gui-only) default.
    expect(releaseLocal).toMatch(/win_env\+=\("PAPERCUSP_BUILD_ROLES=\$PAPERCUSP_BUILD_ROLES"\)/);
    // The WI-5559 unconditional strip of the roles for the Windows leg must be gone.
    expect(releaseLocal).not.toMatch(/env -u PAPERCUSP_BUILD_ROLES\b/);
    // And the caller-set gating variable that drove that strip is fully removed.
    expect(releaseLocal).not.toContain('_PAPERCUSP_BUILD_ROLES_CALLER_SET');
  });

  it('an explicit gui-only fast-iteration override is still honored (not clobbered to both)', () => {
    // release-local.sh itself still resolves an unset caller to gui+server (the
    // release default), but a caller passing PAPERCUSP_BUILD_ROLES=gui must reach
    // the leg verbatim — the forward uses the resolved variable, not a hardcoded set.
    expect(releaseLocal).toMatch(/PAPERCUSP_BUILD_ROLES="\$\{PAPERCUSP_BUILD_ROLES:-gui server\}"/);
    // The forward is the resolved var (honors an explicit override), not a literal.
    expect(releaseLocal).not.toMatch(/win_env\+=\("PAPERCUSP_BUILD_ROLES=gui server"\)/);
  });
});

describe('WI-5600: the spanned Windows Server is normalized to a single publishable zip', () => {
  // The Windows Server DiskSpans (it bundles the dogfood source tree >4GB) into a
  // setup.exe stub + *-setup-N.bin disks. record-release-cli SKIPS a bare spanned
  // stub (isSpannedInstaller — an uninstallable download), so release-local.sh
  // must zip the span into ONE download the release page can offer. Without this,
  // every default Windows cut re-hides the Server from the page (the WI-5600
  // symptom) even though the by-default build now produces it.
  it('release-local.sh delegates spanned Server normalization to the shared helper', () => {
    // The helper follows the orchestration revision, not the frozen target tree:
    // exact-source salvage deliberately keeps those roots separate.
    expect(releaseLocal).toContain('source "$ORCHESTRATOR_HERE/lib/inno-spanned-server.sh"');
    expect(releaseLocal).toContain('papercusp_normalize_spanned_server "$_win_inno_dir" "$VERSION"');
    // The shared implementation stores (no compression: -0) the stub + slices.
    expect(innoSpanHelper).toMatch(
      /zip -0 -j\s+"\$PAPERCUSP_SPANNED_SERVER_ZIP"[\s\S]{0,160}"\$PAPERCUSP_SPANNED_SERVER_STUB"[\s\S]{0,160}"\$\{PAPERCUSP_SPANNED_SERVER_SLICES\[@\]\}"/,
    );
    // Detection remains structural: a Server stub WITH sibling -setup-N.bin disks.
    expect(innoSpanHelper).toMatch(/PAPERCUSP_SPANNED_SERVER_SLICES=\(\s*"\$base"-\*\.bin\s*\)/);
    expect(innoSpanHelper).toMatch(/\(\( \$\{#PAPERCUSP_SPANNED_SERVER_SLICES\[@\]\} > 0 \)\)/);
  });

  it('swaps the raw stub+slices OUT of ARTIFACTS and the normalization OUTPUTS in', () => {
    // The published set is the normalized download, not the ~5 GB of raw disks
    // the page can't use. It is the OUTPUTS ARRAY, never the bare zip: the
    // normalization also emits the zip's updater signature, and re-appending
    // $PAPERCUSP_SPANNED_SERVER_ZIP directly is exactly how 0.0.16 and 0.0.17
    // shipped the Windows Server UNSIGNED (EI-20595279927716716). This guard
    // used to pin that bare-zip form, so the regression is asserted ABSENT here
    // rather than merely un-asserted — re-pinning it would re-ship unsigned.
    expect(releaseLocal).toMatch(
      /ARTIFACTS=\(\s*"\$\{_win_kept\[@\]\}"\s*"\$\{PAPERCUSP_SPANNED_SERVER_OUTPUTS\[@\]\}"\s*\)/,
    );
    expect(releaseLocal).not.toMatch(
      /ARTIFACTS=\(\s*"\$\{_win_kept\[@\]\}"\s*"\$PAPERCUSP_SPANNED_SERVER_ZIP"\s*\)/,
    );
    // The "swaps OUT" half: _win_kept is ARTIFACTS with every raw span member
    // filtered out by the shared predicate (stub, slices, and the outputs
    // themselves — so re-appending OUTPUTS cannot duplicate an entry).
    expect(releaseLocal).toMatch(/papercusp_spanned_server_artifact "\$_a" && continue/);
  });

  it('OUTPUTS carries the zip AND its updater signature (never the zip alone)', () => {
    // EI-20595279927716716: 0.0.16/0.0.17 published the spanned Server zip with
    // no .sig because the caller re-appended only the zip. The signature became
    // reachable when the helper started exporting an OUTPUTS array — which had
    // NO test coverage until this case, which is why the stale assertion above
    // could sit red against a correct fix. OUTPUTS starts as the zip and grows
    // the signature whenever signing produced one.
    expect(innoSpanHelper).toMatch(
      /PAPERCUSP_SPANNED_SERVER_OUTPUTS=\(\s*"\$PAPERCUSP_SPANNED_SERVER_ZIP"\s*\)/,
    );
    expect(innoSpanHelper).toMatch(
      /\[\[ -n "\$PAPERCUSP_SPANNED_SERVER_ZIP_SIG" \]\][\s\S]{0,80}PAPERCUSP_SPANNED_SERVER_OUTPUTS\+=\(\s*"\$PAPERCUSP_SPANNED_SERVER_ZIP_SIG"\s*\)/,
    );
  });

  it('is fall-back-safe: a zip failure leaves the raw artifacts (no cut regression)', () => {
    // Guarded on `command -v zip` and the zip exit + a non-empty result; the else
    // branch warns and leaves ARTIFACTS untouched, so a missing/failed zip degrades
    // to today's behavior (record-release skips the stub) rather than failing the cut.
    expect(innoSpanHelper).toMatch(/command -v zip/);
    expect(releaseLocal).toMatch(/could not zip the spanned Server set/);
  });
});
