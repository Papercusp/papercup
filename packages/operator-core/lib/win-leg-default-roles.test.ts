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
 *   1. build-windows-on-vm.sh's own default (a direct invocation must build both).
 *   2. release-local.sh forwarding the resolved roles into the Windows leg
 *      (it must NOT strip them back to gui-only — the WI-5559 `env -u` hack).
 * Either one reverting alone re-ships the dead build, so both are pinned here.
 *
 * These are STATIC assertions over the shell scripts (no VM, no real cut — the
 * behavior cannot be exercised without a Windows VM build). Run:
 *   cd packages/operator-core && npx vitest run lib/win-leg-default-roles.test.ts
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
const winLeg = readFileSync(join(ROOT, 'papercusp-desktop', 'bin', 'build-windows-on-vm.sh'), 'utf8');
const releaseLocal = readFileSync(join(ROOT, 'papercusp-desktop', 'bin', 'release-local.sh'), 'utf8');

describe('WI-5600: the Windows leg builds gui+server by DEFAULT (never a dead gui-only cut)', () => {
  it('build-windows-on-vm.sh defaults PAPERCUSP_BUILD_ROLES to include server (not gui-only)', () => {
    // The `${PAPERCUSP_BUILD_ROLES:-<default>}` fallback is what an UNSET caller
    // (a plain release cut) resolves to. It must include `server`, or a normal
    // Windows cut ships a GUI with no Server to attach to (the WI-5600 dead build).
    const m = winLeg.match(/PAPERCUSP_BUILD_ROLES="\$\{PAPERCUSP_BUILD_ROLES:-([^}]*)\}"/);
    expect(m, 'build-windows-on-vm.sh must default PAPERCUSP_BUILD_ROLES via :- fallback').not.toBeNull();
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
