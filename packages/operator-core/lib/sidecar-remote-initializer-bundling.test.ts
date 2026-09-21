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
 * re-proves it on the built bundle. It also emits the initializer with the producer's exact esbuild
 * flags and executes both reject probes. Deleting or corrupting any link fails HERE, red, at
 * unit-test speed.
 *
 * WHAT THIS GUARD DOES NOT DO — stated so nobody reads it as more than it is. The focused emission
 * probe proves the initializer entrypoint can be bundled and executed; it does not prove the whole
 * sidecar build ran or that this exact file reached the finished package. That remains
 * `verify-sidecar-bundle.sh` section [7], which execs the packaged artifact and drives the same
 * protocol cycle. Both halves are required.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const LIB_DIR = import.meta.dirname ?? __dirname;
// operator-core/lib → operator-core → packages → repo root
//
// FALSIFIABILITY SEAM. `PAPERCUSP_REMOTE_INIT_GUARD_ROOT` repoints every subject below at a copy
// of the tree. It exists so this guard can be PROVEN to fail — mutate the copy, run the suite
// against it, watch it go red — without mutating the shared checkout, which git-sync commits on a
// schedule and would therefore publish the mutant (see CLAUDE.md, "Proving a guard is
// falsifiable"). Unset in every normal run, so the default is the real tree.
const REPO_ROOT = process.env.PAPERCUSP_REMOTE_INIT_GUARD_ROOT ?? join(LIB_DIR, '..', '..', '..');

const BUILD_SCRIPT = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');
const VERIFY_SCRIPT = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'verify-sidecar-bundle.sh');
const VM_RELEASE_CONF = join(REPO_ROOT, 'papercusp-desktop', 'src-tauri', 'tauri.vm-release.conf.json');
const DRIVER_SRC = join(REPO_ROOT, 'libs', 'generic', 'deployment-driver');
const MANIFEST_SRC = join(DRIVER_SRC, 'src', 'workspace-host-build-manifest.ts');
const BOOTSTRAP_SRC = join(DRIVER_SRC, 'src', 'workspace-host-bootstrap.ts');
const REMOTE_INITIALIZER_SRC = join(DRIVER_SRC, 'src', 'workspace-host-remote-initializer.ts');
const ENTRYPOINT_TS = join(DRIVER_SRC, 'bin', 'papercusp-remote-initializer.ts');
const ESBUILD_BIN = join(REPO_ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');

/** The one string all five surfaces must agree on. */
const ENTRYPOINT_BASENAME = 'papercusp-remote-initializer';
const ENTRYPOINT_PATH = `bin/${ENTRYPOINT_BASENAME}`;
/**
 * The SECOND controller-spawned program (D-215). The producer emits both from one loop, so this
 * guard has to name both: when the loop replaced two hand-written blocks, every assertion here
 * still described the initializer alone and went stale in the same commit that made the script
 * correct.
 */
const DELIVERY_BASENAME = 'papercusp-deliver-material';

/**
 * WI-3831: a release SOURCE BUNDLE excludes the whole `papercusp-desktop/` directory (it is the
 * Tauri shell, not shipped inside its own bundle target), so on that install these scripts are
 * genuinely absent and there is nothing to assert. Skipping is correct there — but it must be
 * skipping because the DIRECTORY is gone, not because a path was mistyped, so the deployment-driver
 * assertions below run unconditionally and would fail loudly on a typo'd repo root.
 */
const desktopPresent = existsSync(BUILD_SCRIPT);
const read = (path: string): string => readFileSync(path, 'utf8');
const remoteInitializerProtocolVersion = (): string => {
  const source = read(REMOTE_INITIALIZER_SRC);
  const match = source.match(
    /WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION\s*=\s*['"]([^'"]+)['"]/,
  );
  if (!match?.[1]) {
    throw new Error('remote initializer protocol version constant is missing or not a string literal');
  }
  return match[1];
};

/**
 * WI-42161: run the verifier's OWN derivation pipeline, in bash, against the real source file.
 * Asserting the shell TEXT alone would still pass if the pipeline were subtly broken — a wrong
 * `-A` window, or a regex that no longer matches the constant's formatting — and a derivation
 * that silently yields nothing is exactly the failure the fail-closed branch exists to catch.
 * Executing it is what proves the verifier resolves a real version at build time.
 */
const deriveVerifierProtocolVersion = (): string => {
  // EXTRACT the verifier's pipeline from the script rather than restating it here. A
  // hand-copied replica is what broke this test: the script was made quote-AGNOSTIC on
  // 2026-09-01 (its own comment cites the build that failed when the TS formatter moved
  // the constant to double quotes), while this copy kept demanding single quotes. The
  // test then failed against a verifier that was correct — the exact inverse of the drift
  // it exists to catch, and a false alarm is a worse failure here than silence, because
  // it sends someone to "fix" a shipped script that already works.
  const script = read(VERIFY_SCRIPT);
  const match = script.match(/_ri_ver="\$\(([\s\S]*?)\)"\r?\n/);
  if (!match?.[1]?.trim()) {
    throw new Error(
      `could not extract the _ri_ver derivation pipeline from ${VERIFY_SCRIPT} — ` +
        'if the verifier renamed or restructured it, update this extractor rather than ' +
        're-copying the pipeline, or the two ends can silently drift again',
    );
  }
  // The pipeline reads "$_ri_src"; bind it to the real source file the same way the
  // script does, then let the command substitution's body write to stdout as usual.
  const result = spawnSync('bash', ['-c', `_ri_src="$1"\n${match[1]}`, 'bash', REMOTE_INITIALIZER_SRC], {
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return (result.stdout ?? '').trim();
};

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
      // The emission itself. ONE loop bundles BOTH controller-spawned programs to their exact
      // packaged basenames, so assert the loop enumerates each by name and derives source and
      // output from the loop variable — a bundle missing either is refused by the release gate.
      expect(script).toMatch(new RegExp(`for _wh_entrypoint in[^\\n]*\\b${ENTRYPOINT_BASENAME}\\b`));
      expect(script).toMatch(new RegExp(`for _wh_entrypoint in[^\\n]*\\b${DELIVERY_BASENAME}\\b`));
      expect(script).toContain('_wh_src="$DEPLOY_DRIVER_SRC/bin/$_wh_entrypoint.ts"');
      expect(script).toContain('_wh_bin="$SIDECAR_DIR/bin/$_wh_entrypoint"');
      expect(script).toMatch(/--outfile="\$_wh_bin"/);
    });

    it('marks the artifact executable and preserves exactly the source-owned shebang', () => {
      const script = read(BUILD_SCRIPT);
      const entrypoint = read(ENTRYPOINT_TS);
      // Both are load-bearing: the controller spawns the file BY PATH, so without the executable
      // bit exec() fails EACCES and without a `#!` line it fails ENOEXEC. Neither failure names
      // itself usefully over SSH, which is why the producer asserts them rather than assuming.
      //
      // The source already owns the shebang and esbuild preserves it. Adding the same text with
      // --banner produces TWO shebangs; Node accepts only the first and parses line 2 as JavaScript,
      // so every invocation dies with `SyntaxError: Invalid or unexpected token` before argv or
      // protocol validation. Keep a single owner for this executable header.
      expect(script).toContain('chmod 755 "$_wh_bin"');
      expect(entrypoint.startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect(script).not.toMatch(/--banner:js=['"]#!\/usr\/bin\/env node['"]/);
    });

    it('executes the exact emitted bundle through its protocol and argv reject paths', () => {
      expect(existsSync(ESBUILD_BIN)).toBe(true);
      const scratch = mkdtempSync(join(tmpdir(), 'papercusp-remote-initializer-'));
      const output = join(scratch, ENTRYPOINT_BASENAME);

      try {
        const build = spawnSync(
          ESBUILD_BIN,
          [
            ENTRYPOINT_TS,
            '--bundle',
            '--platform=node',
            '--format=esm',
            '--target=node22',
            '--minify-whitespace',
            '--minify-syntax',
            `--outfile=${output}`,
          ],
          {
            cwd: join(REPO_ROOT, 'apps', 'operator'),
            encoding: 'utf8',
            timeout: 120_000,
            killSignal: 'SIGKILL',
          },
        );
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        chmodSync(output, 0o755);

        const bundle = read(output);
        expect(bundle.match(/^#!\/usr\/bin\/env node$/gm)).toHaveLength(1);

        const protocolVersion = remoteInitializerProtocolVersion();
        const protocol = spawnSync(
          output,
          ['--protocol-version', protocolVersion, '--json-stdin'],
          {
            input: `${JSON.stringify({ protocolVersion })}\n`,
            encoding: 'utf8',
            timeout: 30_000,
            killSignal: 'SIGKILL',
          },
        );
        expect(protocol.error).toBeUndefined();
        expect(protocol.status).toBe(1);
        expect(protocol.stdout).toBe('');
        expect(protocol.stderr).toContain('WorkspaceHostRemoteInitializerProtocolError');
        expect(protocol.stderr).not.toContain('unsupported protocol version');

        const argv = spawnSync(output, ['--version'], {
          input: '{}\n',
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
        });
        expect(argv.error).toBeUndefined();
        expect(argv.status).toBe(1);
        expect(argv.stdout).toBe('');
        expect(argv.stderr).toContain('remote initializer expects argv');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it('fails closed when the artifact is missing, empty, or not executable', () => {
      const script = read(BUILD_SCRIPT);
      // A build that merely WARNED here would produce a bundle that looks complete — the exact
      // shape D-110 found. Each check must exit non-zero.
      expect(script).toMatch(/if \[\[ ! -s "\$_wh_bin" \]\]; then[\s\S]{0,220}?exit 1/);
      expect(script).toMatch(/if \[\[ ! -x "\$_wh_bin" \]\]; then[\s\S]{0,220}?exit 1/);
      // ...and refuse to build at all when the SOURCE entrypoint has gone missing, rather than
      // silently shipping a bundle without it. Inside the loop this covers BOTH programs.
      expect(script).toMatch(/! -f "\$_wh_src"[\s\S]{0,400}?exit 1/);
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
      expect(script).toMatch(new RegExp(`REQUIRED_TOOLS="[^"]*\\b${DELIVERY_BASENAME}\\b`));
    });

    it('allowlists it in the script-shim scan so its own presence cannot fail the build', () => {
      const script = read(VERIFY_SCRIPT);
      // Section [2] fails ANY unlisted `#!`-file in sidecar/bin. Emitting a shebanged bundle
      // without this allowlist entry would make the producer and the verifier contradict each
      // other — a build that cannot pass its own gate.
      // Both controller-spawned programs share ONE case arm (`a|b)`), so the pattern must tolerate
      // the alternation instead of pinning a bare `<name>)` — and must name each program, or the
      // arm could drop one and still match.
      expect(script).toMatch(
        new RegExp(`^\\s*[^)\\n]*\\b${ENTRYPOINT_BASENAME}\\b[^)\\n]*\\)[\\s\\S]{0,900}?allowlisted`, 'm'),
      );
      expect(script).toMatch(
        new RegExp(`^\\s*[^)\\n]*\\b${DELIVERY_BASENAME}\\b[^)\\n]*\\)[\\s\\S]{0,900}?allowlisted`, 'm'),
      );
    });

    it('runs a real protocol cycle against the packaged artifact', () => {
      const script = read(VERIFY_SCRIPT);
      const protocolVersion = remoteInitializerProtocolVersion();
      // The runtime half of this guard. Presence + executable bit are satisfied by an empty file;
      // only executing the thing distinguishes "a file is there" from "the initializer shipped".
      //
      // WI-42161: this assertion used to pin a LITERAL (`_ri_ver="<version>"`) against the
      // protocol's source of truth, so that "a verifier literal that lags it fails immediately".
      // That guard was real but only ever judged the tree the TEST runs in. The r5c vm-release
      // build cut an immutable snapshot whose verifier said v1 while its own source constant said
      // v2, burned ~48 minutes, and failed at line 22,607 of a 22,612-line log — this test was
      // green throughout, because staging was self-consistent and the snapshot was never judged.
      // The verifier now DERIVES the version from the constant at runtime, so the two ends cannot
      // drift in ANY tree, snapshot included (which is what the source file's own comment already
      // promised). Assert the derivation, not a literal a future bump could desynchronize again.
      expect(script).toContain('WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION');
      expect(script).toMatch(/_ri_ver="\$\(grep -A1 'WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION/);
      // The derivation must still resolve to the real current version through the real file.
      expect(deriveVerifierProtocolVersion()).toBe(protocolVersion);
      // And it must FAIL CLOSED. `grep -qF ""` matches every artifact, so an empty _ri_ver would
      // turn the content assertion below into a silently vacuous gate — strictly worse than the
      // drift this replaced. Pin both halves so neither can be "simplified" away.
      expect(script).toContain('refusing a vacuous content assertion');
      expect(script).toContain('__UNDERIVABLE_INITIALIZER_PROTOCOL_VERSION__');
      expect(script).toContain('_ri_invalid_request="{\\"protocolVersion\\":\\"$_ri_ver\\"}"');
      expect(script).toContain('producer/verifier version skew');
      expect(script).toContain('WorkspaceHostRemoteInitializerProtocolError');
      expect(script).toContain('--json-stdin');
      // And the stdout-purity contract: a diagnostic on stdout is reported at the controller as a
      // malformed response, which mis-names whatever actually went wrong.
      expect(script).toMatch(/wrote to STDOUT on the error path/);
    });

    it('initializes NODE_BIN and falls back to host node for cross-target JavaScript probes', () => {
      const script = read(VERIFY_SCRIPT);
      // Cross-target bundles cannot execute their foreign bundled node on the build host. The
      // verifier must initialize the variable before the cross branch and then use host node for
      // platform-independent JS probes; otherwise set -u aborts after a successful package.
      expect(script).toContain('NODE_BIN="${NODE_BIN:-}"');
      expect(script).toContain('NODE_BIN="$(command -v node 2>/dev/null || true)"');
    });
  },
);
