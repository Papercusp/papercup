import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const compilers = new Map<string, string>();

/** Resolve the real pinned compiler once for these behavior fixtures, under
 * the maintained cache lease. Every fixture invocation then avoids registry
 * resolution, while retaining the production compiler version. */
export function localEsbuildNpxPath(directory: string, repoRoot: string): string {
  mkdirSync(directory, { recursive: true });
  let compiler = compilers.get(repoRoot);
  if (!compiler) {
    compiler = execFileSync(process.execPath, [join(repoRoot, 'scripts/npm-install-safe.mjs'),
      '--repo-root', repoRoot, '--exec-under-cache-lock', '--', 'npx', '--offline', '--yes',
      '--package=esbuild@0.25.0', '-c', 'command -v esbuild'], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    compilers.set(repoRoot, compiler);
  }
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
