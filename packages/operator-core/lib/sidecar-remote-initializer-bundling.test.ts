/**
 * EI-21474474153847007 / D-110 regression guard — the workspace-host remote initializer must be
 * EMITTED into the sidecar bundle, not merely declared.
 *
 * THE BUG CLASS. `WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT` declares the controller spawns
 * `bin/papercusp-remote-initializer` on a provisioned workspace host, and
 * `workspace-host-bootstrap.ts` pins the same path. Three separate things then made the absence of
 * that program invisible:
 *
 *   1. `tauri.vm-release.conf.json` packages `sidecar/bin/**` as a GLOB, so it ships whatever
 *      happens to be in that directory and says nothing about what ought to be.
 *   2. `WorkspaceHostBuildManifest` "requires" the entrypoint by searching a CALLER-SUPPLIED
 *      `materials[]` array for a record at that path — a declaration check. A hand-written record
 *      satisfies it, which is why the manifest suite was green the whole time.
 *   3. Nothing in the repo spawns the program on the build host, so no build-host probe could
 *      notice it missing. The failure surfaces only on a real VM, one step into initialization,
 *      as an opaque non-zero exit over SSH.
 *
 * Together those meant a fully green suite was compatible with a VM-release bundle that omitted
 * the executable entirely — which is precisely what D-110 found and what blocks WI-41712.
 *
 * THE GUARD. Assert the PRODUCER chain end to end, from source constant to packaged artifact:
 * the entrypoint constant, the bootstrap pin, the esbuild emission, the executable bit, the
 * fail-closed checks, the vm-release glob that carries it, and the finished-package verifier that
 * re-proves it on the built bundle. Deleting any link fails HERE, red, at unit-test speed.
 *
 * WHAT THIS GUARD DOES NOT DO — stated so nobody reads it as more than it is. It is a STATIC
 * source assertion: it proves the build script CONTAINS the emission, never that a build RAN it.
 * The runtime half is `verify-sidecar-bundle.sh` section [7], which execs the packaged artifact
 * and drives a real protocol cycle against it. Both halves are required; this one is the half
 * that runs in CI without a built bundle.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIB_DIR = import.meta.dirname ?? __dirname;
// operator-core/lib → operator-core → packages → repo root
//
// FALSIFIABILITY SEAM. `PAPERCUSP_REMOTE_INIT_GUARD_ROOT` repoints every subject below at a copy
// of the tree. It exists so this guard can be PROVEN to fail — mutate the copy, run the suite
// against it, watch it go red — without mutating the shared checkout, which git-sync commits on a
// schedule and would therefore publish the mutant (see CLAUDE.md, "Proving a guard is
// falsifiable"). Unset in every normal run, so the default is the real tree.
const REPO_ROOT =
  process.env.PAPERCUSP_REMOTE_INIT_GUARD_ROOT ?? join(LIB_DIR, '..', '..', '..');

const BUILD_SCRIPT = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');
const VERIFY_SCRIPT = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'verify-sidecar-bundle.sh');
const VM_RELEASE_CONF = join(
  REPO_ROOT,
  'papercusp-desktop',
  'src-tauri',
  'tauri.vm-release.conf.json',
);
const DRIVER_SRC = join(REPO_ROOT, 'libs', 'generic', 'deployment-driver');
const MANIFEST_SRC = join(DRIVER_SRC, 'src', 'workspace-host-build-manifest.ts');
const BOOTSTRAP_SRC = join(DRIVER_SRC, 'src', 'workspace-host-bootstrap.ts');
const ENTRYPOINT_TS = join(DRIVER_SRC, 'bin', 'papercusp-remote-initializer.ts');

/** The one string all five surfaces must agree on. */
const ENTRYPOINT_BASENAME = 'papercusp-remote-initializer';
const ENTRYPOINT_PATH = `bin/${ENTRYPOINT_BASENAME}`;

/**
 * WI-3831: a release SOURCE BUNDLE excludes the whole `papercusp-desktop/` directory (it is the
 * Tauri shell, not shipped inside its own bundle target), so on that install these scripts are
 * genuinely absent and there is nothing to assert. Skipping is correct there — but it must be
 * skipping because the DIRECTORY is gone, not because a path was mistyped, so the deployment-driver
 * assertions below run unconditionally and would fail loudly on a typo'd repo root.
 */
const desktopPresent = existsSync(BUILD_SCRIPT);
const read = (path: string): string => readFileSync(path, 'utf8');

describe('workspace-host remote initializer — source contract', () => {
  it('the entrypoint source file exists and wires the production deps', () => {
    expect(existsSync(ENTRYPOINT_TS)).toBe(true);
    const source = read(ENTRYPOINT_TS);
    // The bin must use the PRODUCTION wiring. A bin that constructed a test double would satisfy
    // every other assertion in this file while shipping a program that cannot initialize a host.
    expect(source).toContain('createProductionWorkspaceHostRemoteInitializerDeps');
    expect(source).toContain('runWorkspaceHostRemoteInitializerCli');
  });

  it('the manifest constant and the bootstrap pin name the same path', () => {
    expect(read(MANIFEST_SRC)).toContain(`"${ENTRYPOINT_PATH}"`);
    expect(read(BOOTSTRAP_SRC)).toContain(`'${ENTRYPOINT_PATH}'`);
  });
});

describe.skipIf(!desktopPresent)(
  'workspace-host remote initializer — packaging producer (build-desktop-sidecar.sh)',
  () => {
    it('esbuild-emits the entrypoint into sidecar/bin', () => {
      const script = read(BUILD_SCRIPT);
      // The emission itself: the .ts entrypoint is bundled to the exact packaged basename.
      expect(script).toContain(`bin/${ENTRYPOINT_BASENAME}.ts`);
      expect(script).toMatch(
        new RegExp(`REMOTE_INIT_BIN=.*SIDECAR_DIR/bin/${ENTRYPOINT_BASENAME}`),
      );
      expect(script).toMatch(/--outfile="\$REMOTE_INIT_BIN"/);
    });

    it('marks the artifact executable and gives it a shebang', () => {
      const script = read(BUILD_SCRIPT);
      // Both are load-bearing: the controller spawns the file BY PATH, so without the executable
      // bit exec() fails EACCES and without a `#!` line it fails ENOEXEC. Neither failure names
      // itself usefully over SSH, which is why the producer asserts them rather than assuming.
      expect(script).toContain('chmod 755 "$REMOTE_INIT_BIN"');
      expect(script).toMatch(/--banner:js='#!\/usr\/bin\/env node'/);
    });

    it('fails closed when the artifact is missing, empty, or not executable', () => {
      const script = read(BUILD_SCRIPT);
      // A build that merely WARNED here would produce a bundle that looks complete — the exact
      // shape D-110 found. Each check must exit non-zero.
      expect(script).toMatch(/if \[\[ ! -s "\$REMOTE_INIT_BIN" \]\]; then[\s\S]{0,220}?exit 1/);
      expect(script).toMatch(/if \[\[ ! -x "\$REMOTE_INIT_BIN" \]\]; then[\s\S]{0,220}?exit 1/);
      // ...and refuse to build at all when the SOURCE entrypoint has gone missing, rather than
      // silently shipping a bundle without it.
      expect(script).toMatch(
        new RegExp(`! -f "\\$DEPLOY_DRIVER_SRC/bin/${ENTRYPOINT_BASENAME}\\.ts"[\\s\\S]{0,400}?exit 1`),
      );
    });
  },
);

describe.skipIf(!desktopPresent)(
  'workspace-host remote initializer — packaging carrier (tauri.vm-release.conf.json)',
  () => {
    it('the vm-release resource set carries sidecar/bin', () => {
      const conf = JSON.parse(read(VM_RELEASE_CONF)) as {
        bundle?: { resources?: string[] };
      };
      const resources = conf.bundle?.resources ?? [];
      // Asserted as PARSED JSON, not a substring: a glob that had been commented out or moved to
      // a different key would still match a naive text search of the file.
      expect(resources).toContain('sidecar/bin/**/*');
    });
  },
);

describe.skipIf(!desktopPresent)(
  'workspace-host remote initializer — finished-package verifier (verify-sidecar-bundle.sh)',
  () => {
    it('lists the entrypoint as a required tool', () => {
      const script = read(VERIFY_SCRIPT);
      expect(script).toMatch(new RegExp(`REQUIRED_TOOLS="[^"]*\\b${ENTRYPOINT_BASENAME}\\b`));
    });

    it('allowlists it in the script-shim scan so its own presence cannot fail the build', () => {
      const script = read(VERIFY_SCRIPT);
      // Section [2] fails ANY unlisted `#!`-file in sidecar/bin. Emitting a shebanged bundle
      // without this allowlist entry would make the producer and the verifier contradict each
      // other — a build that cannot pass its own gate.
      expect(script).toMatch(
        new RegExp(`^\\s*${ENTRYPOINT_BASENAME}\\)[\\s\\S]{0,400}?allowlisted`, 'm'),
      );
    });

    it('runs a real protocol cycle against the packaged artifact', () => {
      const script = read(VERIFY_SCRIPT);
      // The runtime half of this guard. Presence + executable bit are satisfied by an empty file;
      // only executing the thing distinguishes "a file is there" from "the initializer shipped".
      expect(script).toContain('papercusp-gcp-iap-initialization-v1');
      expect(script).toContain('WorkspaceHostRemoteInitializerProtocolError');
      expect(script).toContain('--json-stdin');
      // And the stdout-purity contract: a diagnostic on stdout is reported at the controller as a
      // malformed response, which mis-names whatever actually went wrong.
      expect(script).toMatch(/wrote to STDOUT on the error path/);
    });
  },
);
