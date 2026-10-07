import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Keep real bundle compilation in behavior fixtures inside the installed
 * dependency generation. npm exec would add registry/cache work unrelated to
 * the bundle contract, even when the requested compiler is already cached. */
export function localEsbuildNpxPath(directory: string, repoRoot: string): string {
  mkdirSync(directory, { recursive: true });
  const compiler = join(repoRoot, 'node_modules/esbuild/bin/esbuild');
  const quotedCompiler = `'${compiler.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(directory, 'npx'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "${1:-}" != --yes || "${2:-}" != esbuild@0.25.0 ]]; then',
    '  echo "unexpected npm exec in bundle fixture: $*" >&2; exit 78',
    'fi',
    'shift 2',
    `exec ${quotedCompiler} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return `${directory}:${process.env.PATH ?? ''}`;
}
