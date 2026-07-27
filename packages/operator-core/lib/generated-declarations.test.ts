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

  // WI-6396 converted these four from HAND-WRITTEN declarations. The hand-written
  // files carried real parameter types that the sources' JSDoc did not, so the
  // conversion moved that information into the `.mjs` as `@param` tags. Each
  // assertion below pins a type that exists ONLY because those tags are applied —
  // i.e. it fails in exactly the case a byte-compare cannot see, where the tags are
  // deleted or detached and generation quietly re-emits `any`. Before this item,
  // dropping any of these was a silent loss of checking for every importer.
  it('preserve the parameter types their hand-written predecessors carried (WI-6396)', () => {
    const syncWrite = readDeclaration('scripts/lib/sync-write.d.mts');
    expect(syncWrite, 'writeAllSync lost `fd: number` — a string fd would now typecheck').toMatch(
      /writeAllSync\(fd:\s*number,\s*text:\s*unknown\):\s*void;/,
    );
    expect(syncWrite, 'outSync/errSync lost their optional-parameter shape').toMatch(
      /outSync\(msg\?:\s*unknown\):\s*void;/,
    );

    const procGuard = readDeclaration('scripts/proc-guard.d.mts');
    expect(procGuard, 'parseCmdline lost `Buffer | string`').toMatch(
      /parseCmdline\(raw:\s*Buffer\s*\|\s*string\):\s*string;/,
    );
    // The richest type here: nothing in the implementation reveals the Map's value
    // type, so this survives only via the `@param` tag.
    expect(procGuard, 'getAncestryChain lost its Map<number, number | null> parameter type').toMatch(
      /getAncestryChain\(pid:\s*number,\s*byPid:\s*Map<number,\s*number\s*\|\s*null>/,
    );
    expect(procGuard, 'ProcRow type collapsed').toMatch(/ppid:\s*number\s*\|\s*null;/);

    const viteGate = readDeclaration('scripts/lint-tsc-operator-vite.d.mts');
    // `@type {string}` deliberately widens the const off its literal type; losing
    // the tag re-narrows it to the literal command string.
    expect(viteGate, 'TSC_COMMAND lost its `@type {string}` annotation').toMatch(
      /TSC_COMMAND:\s*string;/,
    );
    expect(viteGate, 'ForeignBaseline.label stopped being optional').toMatch(
      /label\?:\s*string\s*\|\s*undefined;/,
    );

    // This module has no JSDoc parameter tags, so its parameters are legitimately
    // `any`. Its RETURN types come from the implementation, which makes them the
    // right canary for "did the emit collapse entirely" without asserting a
    // precision the source does not claim.
    const baselineGate = readDeclaration('scripts/lib/tsc-baseline-gate.d.mts');
    expect(baselineGate, 'tsc-baseline-gate return types collapsed').toMatch(
      /parseTscErrors\([^)]*\):\s*\(\{/,
    );

    const vacuous = readDeclaration('scripts/check-vacuous-negative-assertions.d.mts');
    // The named types are what the importing test drives the judge with; losing any of
    // them degrades that whole test file to `any` without failing anything.
    expect(vacuous, 'VacuousVerdict stopped being a literal union').toMatch(
      /VacuousVerdict\s*=\s*"DRIFTED"\s*\|\s*"ORPHANED"/,
    );
    expect(vacuous, 'VacuousFinding lost its verdict/fragment types').toMatch(
      /verdict:\s*VacuousVerdict;[\s\S]*?fragment:\s*string\s*\|\s*null;/,
    );
    expect(vacuous, 'IncludesFn stopped being a function type').toMatch(
      /IncludesFn\s*=\s*\(needle:\s*string\)\s*=>\s*boolean/,
    );
    // The most fragile type here: `residue` is built as an array literal, which infers as
    // `string[]`. The fixed-pair tuple exists ONLY because driftFragment's `@returns`
    // spells it out, so this is the first thing to disappear if that tag is touched.
    expect(vacuous, 'driftFragment.residue decayed from a [string, string] tuple').toMatch(
      /residue:\s*\[string,\s*string\];/,
    );
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
