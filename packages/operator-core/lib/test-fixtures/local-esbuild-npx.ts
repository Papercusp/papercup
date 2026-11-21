import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const compilers = new Map<string, { binary: Buffer; api: Buffer; metadata: Buffer }>();

function packageFiles(root: string) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  return { binary: join(root, 'bin/esbuild'), api: join(root, 'lib/main.js'), metadata: join(root, 'package.json') };
}

function populateCompiler(repoRoot: string, { binary: compiler, api, metadata }: ReturnType<typeof packageFiles>): void {
  const retained = compilers.get(repoRoot);
  if (!retained) {
    // Copy while the REAL cache lease is held. The fixture can then exercise a
    // private lease domain without reading a shared cache the janitor owns.
    const version = execFileSync(process.execPath, [join(repoRoot, 'scripts/npm-install-safe.mjs'),
      '--repo-root', repoRoot, '--exec-under-cache-lock', '--', 'npx', '--offline', '--yes',
      '--package=esbuild@0.25.0', '-c',
      'node -e \'const fs=require("node:fs"),p=require("node:path");const root=p.dirname(p.dirname(fs.realpathSync(process.argv[1])));fs.copyFileSync(p.join(root,"lib/main.js"),process.env.BUNDLE_TEST_COMPILER_API_OUTPUT);fs.copyFileSync(p.join(root,"package.json"),process.env.BUNDLE_TEST_COMPILER_METADATA_OUTPUT);\' "$(command -v esbuild)" && cp "$(command -v esbuild)" "$BUNDLE_TEST_COMPILER_OUTPUT" && "$BUNDLE_TEST_COMPILER_OUTPUT" --version'], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BUNDLE_TEST_COMPILER_OUTPUT: compiler,
        BUNDLE_TEST_COMPILER_API_OUTPUT: api, BUNDLE_TEST_COMPILER_METADATA_OUTPUT: metadata },
    }).trim();
    if (version !== '0.25.0') throw new Error(`Pinned fixture compiler must be 0.25.0; received ${version}`);
    compilers.set(repoRoot, { binary: readFileSync(compiler), api: readFileSync(api), metadata: readFileSync(metadata) });
  } else {
    writeFileSync(compiler, retained.binary, { mode: 0o755 });
    writeFileSync(api, retained.api);
    writeFileSync(metadata, retained.metadata);
  }
}

/** Resolve the pinned compiler under the cache lease and publish a private package for the fixture. */
export function localEsbuildNpxPath(directory: string, repoRoot: string): string {
  const destination = packageFiles(join(directory, 'esbuild'));
  const staging = mkdtempSync(join(directory, '.esbuild-'));
  try {
    const files = packageFiles(staging);
    populateCompiler(repoRoot, files);
    // Copies from an immutable dependency generation may be read-only. Replace the
    // directory entries without opening the old files for writing.
    for (const key of ['binary', 'api', 'metadata'] as const) {
      renameSync(files[key], destination[key]);
    }
    const quotedCompiler = `'${destination.binary.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(staging, 'npx'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$*" == "--yes --package=esbuild@0.25.0 -c command -v esbuild" ]]; then',
      `  printf '%s\\n' ${quotedCompiler}; exit 0`,
      'fi',
      'if [[ "${1:-}" != --yes || "${2:-}" != esbuild@0.25.0 ]]; then',
      '  echo "unexpected npm exec in bundle fixture: $*" >&2; exit 78',
      'fi',
      'shift 2',
      `exec ${quotedCompiler} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    renameSync(join(staging, 'npx'), join(directory, 'npx'));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return `${directory}:${process.env.PATH ?? ''}`;
}
