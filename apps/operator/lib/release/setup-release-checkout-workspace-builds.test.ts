/**
 * EI-20453835015280838 — release checkouts must materialize runtime outputs
 * from the exact pinned workspace source before the operator boot preflight.
 *
 * The failure that earned this guard is subtle: @papercusp/sse is a submodule,
 * its dist/ is gitignored, ESM/typecheck consumers load src/, and CommonJS boot
 * consumers load dist/. A developer tree therefore looks healthy while the
 * isolated release tree (correctly cleaned + cloned at its pin) lacks the only
 * files the real boot path can require.
 *
 * This suite locks both halves of the durable fix:
 *   1. the shipped shell block builds from RELEASE_ROOT (never copies a newer
 *      integration-tree artifact across the submodule pin), and
 *   2. a repository-wide detector requires every workspace package that
 *      declares a gitignored main/require/default target to appear in the
 *      block's explicit registry, and
 *   3. the desktop sidecar rebuilds the same registry after its scoped npm
 *      install, which can erase generated outputs behind intact symlinks.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  extractRegisteredRuntimeBuildWorkspaces,
  listIgnoredRuntimeEntryWorkspaces,
} from './runtime-workspace-build-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SCRIPT_PATH = resolve(HERE, '../../bin/release/setup-release-checkout.sh');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');
const SIDECAR_SCRIPT_PATH = resolve(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh');
const SIDECAR_SCRIPT = readFileSync(SIDECAR_SCRIPT_PATH, 'utf8');

function extractRuntimeBuildBlock(): string {
  const lines = SCRIPT.split('\n');
  const start = lines.findIndex((line) => /^# 3c-2\. Pinned workspace RUNTIME BUILDS/.test(line));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((line) => /^# \d+[a-z]?(-\d+)?\. /.test(line));
  return lines.slice(start, endRel === -1 ? undefined : start + 1 + endRel).join('\n');
}

const BLOCK = extractRuntimeBuildBlock();

function extractSidecarPostInstallRuntimeBuildBlock(): string {
  return SIDECAR_SCRIPT.match(
    /# POST-INSTALL RUNTIME BUILDS[^\n]*\n([\s\S]*?)# END POST-INSTALL RUNTIME BUILDS/,
  )?.[1] ?? '';
}

const SIDECAR_POST_INSTALL_BLOCK = extractSidecarPostInstallRuntimeBuildBlock();

describe('setup-release-checkout pinned workspace runtime builds', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('builds @papercusp/sse from the pinned release tree, never from integration output', () => {
    expect(BLOCK, 'the pinned workspace runtime-build block is missing').not.toBe('');

    const root = mkdtempSync(join(tmpdir(), 'setup-runtime-build-'));
    tempRoots.push(root);
    const releaseRoot = join(root, 'release');
    const integrationRoot = join(root, 'integration');
    const packageRoot = join(releaseRoot, 'libs/generic/sse');
    const integrationPackageRoot = join(integrationRoot, 'libs/generic/sse');
    const integrationDist = join(integrationRoot, 'libs/generic/sse/dist');
    const fakeBin = join(root, 'bin');
    const trace = join(root, 'npm-trace');

    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(releaseRoot, 'node_modules/@papercusp'), { recursive: true });
    mkdirSync(join(integrationRoot, 'node_modules/@papercusp'), { recursive: true });
    mkdirSync(join(integrationPackageRoot, 'node_modules'), { recursive: true });
    mkdirSync(integrationDist, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@papercusp/sse' }));
    writeFileSync(join(packageRoot, 'PINNED_SOURCE'), 'pinned');
    writeFileSync(join(integrationPackageRoot, 'node_modules/PINNED_TOOLCHAIN'), 'typescript-5.9');
    writeFileSync(join(integrationDist, 'index.js'), 'wrong-newer-integration-output');
    symlinkSync('../../libs/generic/sse', join(releaseRoot, 'node_modules/@papercusp/sse'));
    symlinkSync('../../libs/generic/sse', join(integrationRoot, 'node_modules/@papercusp/sse'));

    const fakeNpm = join(fakeBin, 'npm');
    writeFileSync(
      fakeNpm,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [ "$*" = "--workspace @papercusp/sse pkg get name" ]; then exit 0; fi',
        'test "$*" = "--workspace @papercusp/sse run build"',
        'printf "%s|%s\\n" "$PWD" "$*" > "$NPM_TRACE"',
        'test -f "$PWD/libs/generic/sse/node_modules/PINNED_TOOLCHAIN"',
        'mkdir -p "$PWD/libs/generic/sse/dist"',
        'printf "built-from-%s\\n" "$(cat "$PWD/libs/generic/sse/PINNED_SOURCE")" > "$PWD/libs/generic/sse/dist/index.js"',
      ].join('\n'),
    );
    chmodSync(fakeNpm, 0o755);

    const runner = join(root, 'run.sh');
    writeFileSync(
      runner,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'log() { echo "[log] $*"; }',
        'sync_one_node_modules() { mkdir -p "$2"; cp -a "$1/." "$2/"; }',
        `RELEASE_ROOT=${JSON.stringify(releaseRoot)}`,
        `INTEGRATION_ROOT=${JSON.stringify(integrationRoot)}`,
        'TARGET_SHA=0123456789abcdef',
        BLOCK,
      ].join('\n'),
    );

    const run = spawnSync('bash', [runner], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_TRACE: trace },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(trace, 'utf8').trim()).toBe(`${releaseRoot}|--workspace @papercusp/sse run build`);
    expect(readFileSync(join(packageRoot, 'node_modules/PINNED_TOOLCHAIN'), 'utf8')).toBe('typescript-5.9');
    expect(readFileSync(join(packageRoot, 'dist/index.js'), 'utf8')).toBe('built-from-pinned\n');
    expect(readFileSync(join(integrationDist, 'index.js'), 'utf8')).toBe('wrong-newer-integration-output');
    expect(BLOCK).not.toContain('run build 1>/dev/null');
  });

  it('covers every workspace package whose declared runtime entry is gitignored', () => {
    const registered = extractRegisteredRuntimeBuildWorkspaces(BLOCK);
    const uncovered = listIgnoredRuntimeEntryWorkspaces(REPO_ROOT)
      .filter(({ name }) => !registered.has(name));
    expect(
      uncovered,
      'A workspace package exposes a gitignored main/require/default entry but the release setup does not ' +
        'build it from pinned source. Add its package name to RUNTIME_BUILD_WORKSPACES; copying integration ' +
        'dist would violate submodule pin isolation.',
    ).toEqual([]);
  });

  it('rebuilds every ignored runtime entry after the desktop scoped install', () => {
    expect(
      SIDECAR_POST_INSTALL_BLOCK,
      'the desktop post-install runtime-build block is missing',
    ).not.toBe('');

    const installIndex = Math.max(
      SIDECAR_SCRIPT.indexOf('node scripts/npm-install-safe.mjs install'),
      SIDECAR_SCRIPT.indexOf('npm install --legacy-peer-deps'),
    );
    const blockIndex = SIDECAR_SCRIPT.indexOf('# POST-INSTALL RUNTIME BUILDS');
    const resolutionGuardIndex = SIDECAR_SCRIPT.indexOf('echo "→ verifying workspace deps resolved"');
    expect(installIndex).toBeGreaterThan(-1);
    expect(blockIndex).toBeGreaterThan(installIndex);
    expect(resolutionGuardIndex).toBeGreaterThan(blockIndex);

    const registered = extractRegisteredRuntimeBuildWorkspaces(SIDECAR_POST_INSTALL_BLOCK);
    const uncovered = listIgnoredRuntimeEntryWorkspaces(REPO_ROOT)
      .filter(({ name }) => !registered.has(name));
    expect(
      uncovered,
      'A workspace package exposes a gitignored runtime entry but the desktop sidecar does not rebuild it ' +
        'after its scoped install. Add it to the post-install RUNTIME_BUILD_WORKSPACES registry.',
    ).toEqual([]);

    const root = mkdtempSync(join(tmpdir(), 'sidecar-post-install-runtime-build-'));
    tempRoots.push(root);
    const fakeBin = join(root, 'bin');
    const packageRoot = join(root, 'libs/generic/sse');
    const trace = join(root, 'npm-trace');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/npm-install-safe.mjs'),
      [
        "#!/usr/bin/env node",
        "import { spawnSync } from 'node:child_process';",
        "const result = spawnSync('npm', process.argv.slice(2), { stdio: 'inherit' });",
        'process.exit(result.status ?? 1);',
      ].join('\n'),
    );
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@papercusp/sse',
        devDependencies: { typescript: '~6.0.0' },
      }),
    );

    const fakeNpm = join(fakeBin, 'npm');
    writeFileSync(
      fakeNpm,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'trace_npm() { printf "%s|%s\\n" "$PWD" "$(printf "%s" "$1" | tr "\\n" " ")" >> "$NPM_TRACE"; }',
        'case "$*" in',
        '  "install --legacy-peer-deps --no-audit --no-fund --ignore-scripts --include=dev --workspace=@papercusp/sse")',
        '    trace_npm "$*"',
        '    mkdir -p "$PWD/libs/generic/sse/node_modules/typescript"',
        '    printf "typescript-6.0.3\\n" > "$PWD/libs/generic/sse/node_modules/PINNED_TOOLCHAIN"',
        '    printf \'{"version":"6.0.3"}\\n\' > "$PWD/libs/generic/sse/node_modules/typescript/package.json"',
        '    ;;',
        '  "--workspace=@papercusp/sse exec -- node -e "*)',
        '    trace_npm "$*"',
        '    printf "  ✓ @papercusp/sse: TypeScript 6.0.3 satisfies ~6.0.0\\n"',
        '    ;;',
        '  "--workspace @papercusp/sse run build")',
        '    trace_npm "$*"',
        '    mkdir -p "$PWD/libs/generic/sse/dist"',
        '    printf "rebuilt-after-install\\n" > "$PWD/libs/generic/sse/dist/index.js"',
        '    ;;',
        '  *) echo "unexpected fake npm invocation: $*" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(fakeNpm, 0o755);

    const runner = join(root, 'run.sh');
    writeFileSync(
      runner,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `REPO_ROOT=${JSON.stringify(root)}`,
        SIDECAR_POST_INSTALL_BLOCK,
      ].join('\n'),
    );

    const run = spawnSync('bash', [runner], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_TRACE: trace },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const traceLines = readFileSync(trace, 'utf8').trim().split('\n');
    expect(traceLines).toHaveLength(3);
    expect(traceLines[0]).toBe(
      `${root}|install --legacy-peer-deps --no-audit --no-fund --ignore-scripts --include=dev --workspace=@papercusp/sse`,
    );
    expect(traceLines[1]).toContain(`${root}|--workspace=@papercusp/sse exec -- node -e `);
    expect(traceLines[2]).toBe(`${root}|--workspace @papercusp/sse run build`);
    expect(readFileSync(join(packageRoot, 'node_modules/PINNED_TOOLCHAIN'), 'utf8')).toBe(
      'typescript-6.0.3\n',
    );
    expect(readFileSync(join(packageRoot, 'dist/index.js'), 'utf8')).toBe(
      'rebuilt-after-install\n',
    );
  });

  it('skips a package present before an older rollback pin registered it as a workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-runtime-build-old-pin-'));
    tempRoots.push(root);
    const releaseRoot = join(root, 'release');
    const packageRoot = join(releaseRoot, 'libs/generic/sse');
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(releaseRoot, 'node_modules/@papercusp'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@papercusp/sse' }));
    symlinkSync('../../libs/generic/sse', join(releaseRoot, 'node_modules/@papercusp/sse'));
    const runner = join(root, 'run.sh');
    writeFileSync(
      runner,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'log() { echo "[log] $*"; }',
        `RELEASE_ROOT=${JSON.stringify(releaseRoot)}`,
        'TARGET_SHA=0123456789abcdef',
        BLOCK,
      ].join('\n'),
    );

    const run = spawnSync('bash', [runner], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('is not registered at 0123456789');
    expect(existsSync(join(releaseRoot, 'libs/generic/sse/dist'))).toBe(false);
  });
});
