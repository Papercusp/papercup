/**
 * The repo's `.mjs` modules that TypeScript imports ship GENERATED `.d.mts`
 * declarations, driven by `tsconfig.declarations.json` (WI-6394). This guards
 * them.
 *
 * Two independent failure modes, and neither test catches the other's:
 *
 *  1. STALENESS — someone edits a `.mjs` and does not re-run
 *     `npm run gen:declarations`, so the committed declaration describes code
 *     that no longer exists. This is the failure the repo has already paid for
 *     twice on the previously HAND-WRITTEN `scripts/lint-tsc.d.mts`, where an
 *     export added to the `.mjs` and forgotten in the `.d.mts` became TS2305 for
 *     every importer.
 *
 *  2. SILENT WIDENING — generation runs, the committed files match, but the
 *     emitted types have degraded to `any`. A byte-compare is BLIND to this:
 *     regenerate after the source stops producing types and both sides agree on
 *     the same worthless output.
 *
 * Mode 2 is not hypothetical. Its sibling change (EI-18804531117413708) found a
 * complete `@param` block that had drifted ABOVE a `const`, so TypeScript bound
 * it to that const instead of to the function — every `@param` inert and all
 * four parameters `any`, in a function that read as fully documented. Anything
 * placed between a JSDoc block and its declaration detaches it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readDeclaration(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

describe('generated .d.mts declarations', () => {
  it('are up to date with their .mjs sources — run `npm run gen:declarations` if this fails', () => {
    // Delegates to the SAME `--check` the CI script runs, so the test and the
    // build cannot disagree about what "up to date" means. It regenerates into a
    // temp dir and compares; it never writes into this shared working tree.
    try {
      execFileSync('npx', ['tsx', 'scripts/gen-declarations.ts', '--check'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`gen:declarations:check failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
  });

  it('stay genuinely typed — a byte-compare cannot catch types silently widening to `any`', () => {
    // Each assertion below pins a type that is only produced because the source's
    // JSDoc is actually being applied. If a JSDoc block is detached (or deleted),
    // these regenerate as `any` and a byte-compare would happily agree with
    // itself; only this test notices.
    const quarantine = readDeclaration('scripts/lib/quarantine.d.mts');
    expect(quarantine, 'parseQuarantineWorkspaces lost its JSDoc types').toMatch(
      /parseQuarantineWorkspaces\(text:\s*string\):\s*Set<string>/,
    );

    const boundary = readDeclaration('scripts/check-transitive-boundary.d.mts');
    expect(boundary, 'check-transitive-boundary.mjs is the best-documented of these — it should not be all `any`').not.toMatch(
      /^export function \w+\(\w+: any\): any;$/m,
    );

    // Return types are inferred from the IMPLEMENTATION, not from JSDoc, so they
    // hold even for the undocumented modules — which makes them a good canary for
    // "did the emit silently collapse".
    const migrations = readDeclaration('scripts/lint-migrations.d.mts');
    expect(migrations, 'lint-migrations return types collapsed').toMatch(/stripSqlBodies\([^)]*\):\s*string;/);
    expect(migrations, 'const literal types collapsed').toMatch(/ENFORCED_FROM:\s*\d+/);
  });

  it('exist for every module the config lists — a missing one silently reverts that importer to `any`', () => {
    const raw = readFileSync(join(REPO_ROOT, 'tsconfig.declarations.json'), 'utf8');
    const files = (JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { files: string[] }).files;

    expect(files.length, 'tsconfig.declarations.json lists no files').toBeGreaterThan(0);
    for (const mjs of files) {
      const dts = mjs.replace(/\.mjs$/, '.d.mts');
      expect(() => readDeclaration(dts), `${dts} is missing — run \`npm run gen:declarations\``).not.toThrow();
    }
  });
});
