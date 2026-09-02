/**
 * WI-2141049 — every lint:tsc leg that COMPILES a consumer of a generated `.d.mts` must
 * refresh those companions first.
 *
 * `tsconfig.declarations.json` generates a tracked `.d.mts` beside each listed `.mjs`, and that
 * companion is the ONLY type information a `.ts` importer ever sees for those modules. So the
 * first typecheck after any `.mjs` export change judges the STALE committed declaration and
 * attributes the resulting phantoms to whoever happened to run it — measured 2026-09-02 on the
 * `operator` leg as 14 phantom errors (11x TS2554 "Expected 2 arguments, but got 1", 3x TS2353
 * "'agent' does not exist in type '{ capBytes?: number }'") reported as `status=regressed`
 * against a signature change that was already correct.
 *
 * `lint-tsc.mjs` has carried the `gen:declarations` preflight since EI-21441555291852229, but
 * only that one leg did — and operator-core owns just 3 of the 70 generated inputs. The other 67
 * belong to legs that had no preflight, so the fix landed everywhere EXCEPT where these modules
 * actually live. This test derives the requirement from `tsconfig.declarations.json` and each
 * leg's own tsc project rather than restating a hand-kept roster, so a leg added (or a module
 * moved) later cannot reintroduce the gap silently — the derived-truth ladder's PIN rung.
 *
 * NOTE the preflight is NOT about `tsconfig.tsbuildinfo`. That was this bug's first and wrong
 * diagnosis: every leg already passes `--incremental false`, tsc 7.0.2 honours it, and a warm
 * cache was measured to produce a byte-identical diagnostic set (612 errors, identical
 * file:line:code). The variable that actually moved between the red run and the green one was
 * the regenerated `.d.mts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');

/** Strip `//` line comments so the JSONC configs in this repo parse with JSON.parse. */
function readJsonc(relPath: string): { files?: string[] } {
  const raw = readFileSync(resolve(REPO_ROOT, relPath), 'utf-8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(raw);
}

/** Every `.mjs` whose type surface is a generated, committed `.d.mts`. */
function generatedDeclarationInputs(): string[] {
  const files = readJsonc('tsconfig.declarations.json').files ?? [];
  return files.map((f) => f.replace(/^\.\//, ''));
}

/**
 * The lint:tsc legs, by the script that owns each one. Discovered from the root package.json so
 * a NEW leg is covered the moment it is wired, rather than when someone remembers this list.
 */
function discoverLegs(): { script: string; source: string }[] {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const legs: { script: string; source: string }[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!name.startsWith('lint:tsc')) continue;
    const m = /(scripts\/lint-tsc[\w-]*\.mjs)/.exec(cmd);
    if (!m) continue;
    legs.push({ script: name, source: readFileSync(resolve(REPO_ROOT, m[1]), 'utf-8') });
  }
  return legs;
}

/**
 * The directory a leg's `tsc -p <project>` compiles, e.g. `apps/operator`.
 *
 * Read ONLY out of the exported `TSC_COMMAND` assignment, never from the file at large: these
 * scripts quote example `tsc --noEmit -p tsconfig.json` invocations in their usage prose, and a
 * looser scan matches that instead — resolving a leg to the repo root, where nothing is owned,
 * so it silently drops out of the census with no assertion firing.
 *
 * `null` means the leg is a FAN-OUT (`lint:tsc:papercusp-libs`, `lint:tsc:workspaces`) that
 * discovers many per-package projects at runtime instead of naming one. Those are out of scope
 * here — they compile packages that own no generated-declaration inputs.
 */
function projectDirOf(source: string): string | null {
  const decl = /export const TSC_COMMAND\s*=\s*([\s\S]{0,200}?);/.exec(source);
  if (!decl) return null;
  const m = /-p\s+([\w./-]+tsconfig[\w.-]*\.json)/.exec(decl[1]);
  return m ? dirname(m[1]) : null;
}

describe('lint:tsc legs refresh generated .d.mts companions before typechecking', () => {
  const inputs = generatedDeclarationInputs();
  const legs = discoverLegs();

  it('the census is non-vacuous', () => {
    // Guard against the failure mode this whole file exists to prevent: an instrument that
    // measured nothing reporting a clean pass. If either census empties out, the assertions
    // below become vacuously true and the gap reopens unobserved.
    expect(inputs.length).toBeGreaterThan(20);
    expect(legs.length).toBeGreaterThan(4);

    // Single-project legs are the ones this rule can speak about at all. If the TSC_COMMAND
    // shape ever changes, this count collapses and the census below goes quiet — which would
    // read as "no leg is missing a preflight" rather than "no leg was examined".
    const single = legs.filter((l) => projectDirOf(l.source) !== null);
    expect(single.length).toBeGreaterThanOrEqual(4);

    // Every leg is either single-project or a known fan-out; nothing falls between.
    const unresolved = legs
      .filter((l) => projectDirOf(l.source) === null)
      .map((l) => l.script)
      .sort();
    expect(unresolved).toEqual(['lint:tsc:papercusp-libs', 'lint:tsc:workspaces']);
  });

  it('every leg whose project contains generated-declaration inputs runs the preflight', () => {
    const missing: string[] = [];
    const covered: string[] = [];

    for (const leg of legs) {
      const projectDir = projectDirOf(leg.source);
      if (!projectDir) continue;
      const owned = inputs.filter((f) => f.startsWith(`${projectDir}/`));
      if (owned.length === 0) continue;

      // Declaring the constant is not enough — it has to reach the shared gate.
      const wired =
        /TSC_PREFLIGHT_COMMAND\s*=\s*'npm run gen:declarations'/.test(leg.source) &&
        /preTscCommand:\s*TSC_PREFLIGHT_COMMAND/.test(leg.source);

      (wired ? covered : missing).push(`${leg.script} (${projectDir}, ${owned.length} inputs)`);
    }

    // operator-core, operator and scripts all own generated inputs; if this drops below three
    // the discovery above has broken rather than the tree having improved.
    expect(covered.length + missing.length).toBeGreaterThanOrEqual(3);
    expect(missing).toEqual([]);
  });

  it('a leg that consumes no generated declarations is not forced to pay for the preflight', () => {
    // The preflight compiles the whole declarations project (~5s). That is cheap against a
    // ~150s typecheck but pointless for a leg with nothing to refresh, and the shared gate
    // keeps it an explicit per-project hook precisely so it is not a hidden repo-wide mutation.
    const viteLeg = legs.find((l) => l.script === 'lint:tsc:operator-vite');
    expect(viteLeg).toBeDefined();
    const projectDir = projectDirOf(viteLeg!.source);
    expect(inputs.filter((f) => f.startsWith(`${projectDir}/`))).toEqual([]);
  });
});
