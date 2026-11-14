import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const compilers = new Map<string, { binary: Buffer; api: Buffer; metadata: Buffer }>();

/** Resolve the real pinned compiler once for these behavior fixtures, under
 * the maintained cache lease. Every fixture invocation then avoids registry
 * resolution, while retaining the production compiler version. */
export function localEsbuildNpxPath(directory: string, repoRoot: string): string {
  const compilerRoot = join(directory, 'esbuild');
  mkdirSync(join(compilerRoot, 'bin'), { recursive: true });
  mkdirSync(join(compilerRoot, 'lib'), { recursive: true });
  const compiler = join(compilerRoot, 'bin/esbuild');
  const api = join(compilerRoot, 'lib/main.js'), metadata = join(compilerRoot, 'package.json');
  let retained = compilers.get(repoRoot);
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
    retained = { binary: readFileSync(compiler), api: readFileSync(api), metadata: readFileSync(metadata) };
    compilers.set(repoRoot, retained);
  }
  writeFileSync(compiler, retained.binary, { mode: 0o755 });
  writeFileSync(api, retained.api);
  writeFileSync(metadata, retained.metadata);
  const quotedCompiler = `'${compiler.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(directory, 'npx'), [
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
  return `${directory}:${process.env.PATH ?? ''}`;
}
