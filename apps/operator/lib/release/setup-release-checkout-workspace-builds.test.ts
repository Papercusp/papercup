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
 *      block's explicit registry.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SCRIPT_PATH = resolve(HERE, '../../bin/release/setup-release-checkout.sh');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');

function extractRuntimeBuildBlock(): string {
  const lines = SCRIPT.split('\n');
  const start = lines.findIndex((line) => /^# 3c-2\. Pinned workspace RUNTIME BUILDS/.test(line));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((line) => /^# \d+[a-z]?(-\d+)?\. /.test(line));
  return lines.slice(start, endRel === -1 ? undefined : start + 1 + endRel).join('\n');
}

const BLOCK = extractRuntimeBuildBlock();

function registeredRuntimeBuildWorkspaces(): Set<string> {
  const body = BLOCK.match(/RUNTIME_BUILD_WORKSPACES=\(([\s\S]*?)\)/)?.[1] ?? '';
  return new Set([...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]));
}

function exportRuntimeTargets(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [condition, target] of Object.entries(value as Record<string, unknown>)) {
    if (condition === 'require' || condition === 'default') {
      if (typeof target === 'string') out.push(target);
      else out.push(...exportRuntimeTargets(target));
      continue;
    }
    // Export subpaths (".", "./react", ...) contain their own condition maps.
    if (condition.startsWith('.')) out.push(...exportRuntimeTargets(target));
  }
  return out;
}

function ignoredRuntimeEntryWorkspaces(): Array<{ name: string; manifest: string; target: string }> {
  const manifests = execFileSync(
    'git',
    ['ls-files', '--recurse-submodules', '--', ':(glob)**/package.json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);

  const hits: Array<{ name: string; manifest: string; target: string }> = [];
  for (const manifest of manifests) {
    const packageDir = dirname(resolve(REPO_ROOT, manifest));
    let parsed: { name?: string; main?: unknown; exports?: unknown };
    try {
      parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest), 'utf8')) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed.name?.startsWith('@papercusp/') && !parsed.name?.startsWith('@papercup/')) continue;

    const targets = new Set<string>();
    if (typeof parsed.main === 'string') targets.add(parsed.main);
    for (const target of exportRuntimeTargets(parsed.exports)) targets.add(target);

    for (const rawTarget of targets) {
      const target = rawTarget.replace(/^\.\//, '');
      if (!target || target.includes('*')) continue;
      const ignored = spawnSync('git', ['check-ignore', '-q', '--', target], { cwd: packageDir });
      if (ignored.status === 0) hits.push({ name: parsed.name, manifest, target });
    }
  }
  return hits;
}

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
    const registered = registeredRuntimeBuildWorkspaces();
    const uncovered = ignoredRuntimeEntryWorkspaces().filter(({ name }) => !registered.has(name));
    expect(
      uncovered,
      'A workspace package exposes a gitignored main/require/default entry but the release setup does not ' +
        'build it from pinned source. Add its package name to RUNTIME_BUILD_WORKSPACES; copying integration ' +
        'dist would violate submodule pin isolation.',
    ).toEqual([]);
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
