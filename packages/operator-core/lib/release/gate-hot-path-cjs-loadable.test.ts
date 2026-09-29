/**
 * The green-checkpoint gate loads apps/operator/lib/release/green-checkpoint.ts through tsx in CJS
 * mode, so every plain-JS module it imports from scripts/ is transformed to CommonJS as well. A
 * top-level `await` anywhere in that import closure is rejected at transform time
 * ("Top-level await is currently not supported with the "cjs" output format") and the gate dies
 * before any suite runs — a WEDGE (no verdict), not a red. WI-10003836: a CLI entry written as
 * `process.exitCode = await main()` in scripts/check-vitest-config-enrollment.mjs took down the
 * gate on three hives at once.
 *
 * The root set is DERIVED from green-checkpoint.ts's own relative .mjs imports, so a new hot-path
 * module is covered without editing this test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GATE_ENTRY = resolve(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts');

const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(RELATIVE_SPECIFIER)].map((m) => m[1]!);
}

/** Relative plain-JS (.mjs/.js/.cjs) modules reachable from the gate entry, transitively. */
function gateHotPathJsClosure(): string[] {
  const roots = relativeSpecifiers(readFileSync(GATE_ENTRY, 'utf8'))
    .filter((s) => /\.[cm]?js$/.test(s))
    .map((s) => resolve(dirname(GATE_ENTRY), s))
    .filter((p) => existsSync(p));
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
      const next = resolve(dirname(file), spec);
      if (/\.[cm]?js$/.test(next) && existsSync(next) && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

function cjsTransformError(source: string): string | null {
  try {
    transformSync(source, { loader: 'js', format: 'cjs', target: 'node20' });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('green-checkpoint hot path stays loadable as CommonJS', () => {
  const closure = gateHotPathJsClosure();

  it('the derived closure reaches the modules the gate actually imports (positive control)', () => {
    const rel = closure.map((p) => relative(REPO_ROOT, p).split('\\').join('/'));
    expect(rel).toContain('scripts/lib/executed-source-map.mjs');
    expect(rel).toContain('scripts/check-vitest-config-enrollment.mjs');
  });

  it('rejects a top-level await under the CJS transform (the check is not vacuous)', () => {
    expect(cjsTransformError('export async function main() { return 0; }\nprocess.exitCode = await main();\n')).toMatch(
      /Top-level await is currently not supported with the "cjs" output format/,
    );
    expect(
      cjsTransformError('export async function main() { return 0; }\nmain().then((code) => { process.exitCode = code; });\n'),
    ).toBeNull();
  });

  it('every module in the closure transforms to CJS without error', () => {
    const failures = closure
      .map((file) => ({ file: relative(REPO_ROOT, file), error: cjsTransformError(readFileSync(file, 'utf8')) }))
      .filter((r) => r.error !== null);
    expect(failures).toEqual([]);
  });
});
