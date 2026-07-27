/**
 * `@papercusp/embedded-postgres-server` ships plain JS; its `.d.ts` files are
 * GENERATED from the sources' JSDoc by `tsconfig.types.json` and committed.
 * This file guards that arrangement (EI-18804531117413708).
 *
 * Two DIFFERENT failure modes are checked here, and neither test catches the
 * other's — that separation is the whole point:
 *
 *  1. STALENESS (`regenerates identically`) — someone edits `src/*.js` and does
 *     not re-run `npm run gen:types`, so the committed declaration describes a
 *     function that no longer exists. This is the failure the repo has already
 *     paid for twice on the hand-maintained `scripts/lint-tsc.d.mts`, where an
 *     export added to the `.mjs` and forgotten in the `.d.mts` became TS2305 for
 *     every importer.
 *
 *  2. SILENT WIDENING (`stays genuinely typed`) — the generator runs fine and
 *     the committed file matches, but the emitted types have degraded to `any`.
 *     A byte-compare is BLIND to this: regenerate after the source stops
 *     producing types and both sides agree on the same worthless output.
 *
 * Mode 2 is not hypothetical — it is the bug this work item found. The JSDoc
 * block for `applyPendingMigrations` had drifted ABOVE the `MANUAL_ONLY` const,
 * so TypeScript bound it to that const instead of to the function. Every
 * `@param` was inert, all four parameters inferred as `any`, and `skipFile`
 * came out REQUIRED — in a function that read as fully documented. Nothing in
 * the repo noticed, because the importers' TS7016 errors were already absorbed
 * into their permanent per-file tsc baselines.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PKG_DIR = fileURLToPath(new URL('../../../libs/papercusp/packages/embedded-postgres-server/', import.meta.url));
const DECLARATIONS = ['index.d.ts', 'migration-runner.d.ts'] as const;

const REGEN = 'npm run gen:types --prefix libs/papercusp/packages/embedded-postgres-server';

describe('@papercusp/embedded-postgres-server generated declarations', () => {
  it(`regenerate identically from source — run \`${REGEN}\` if this fails`, () => {
    const out = mkdtempSync(join(tmpdir(), 'epg-dts-drift-'));
    try {
      // Same tsconfig the regen script uses, so the two can never disagree
      // about flags; only the output directory is redirected.
      execFileSync('npx', ['tsc', '-p', 'tsconfig.types.json', '--outDir', out], {
        cwd: PKG_DIR,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      for (const name of DECLARATIONS) {
        const committed = readFileSync(join(PKG_DIR, 'src', name), 'utf8');
        const fresh = readFileSync(join(out, name), 'utf8');
        expect(
          fresh,
          `${name} is STALE: the committed declaration no longer matches what the source generates. Run \`${REGEN}\`.`,
        ).toBe(committed);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('stay genuinely typed — a byte-compare cannot catch types silently widening to `any`', () => {
    const dts = readFileSync(join(PKG_DIR, 'src', 'migration-runner.d.ts'), 'utf8');

    // The one symbol every operator-core importer of this package actually uses.
    expect(dts).toContain('export function applyPendingMigrations');

    // Each of these was literally `any` while the JSDoc block sat detached above
    // `MANUAL_ONLY`. Asserting the real types is what makes a re-detachment fail
    // LOUDLY here instead of silently handing every consumer `any` again.
    expect(dts, 'client lost its type — is the JSDoc block still adjacent to the function?').toMatch(
      /client:\s*object/,
    );
    expect(dts, 'sqlDir lost its type — is the JSDoc block still adjacent to the function?').toMatch(
      /sqlDir:\s*string/,
    );
    expect(dts, 'log lost its parameter — it inferred `() => void` (wrong arity) when the JSDoc was inert').toMatch(
      /log\?:\s*\(\(s:\s*string\)\s*=>\s*void\)/,
    );
    // Not just typed but OPTIONAL: with the JSDoc inert this was `skipFile: any`,
    // i.e. a required parameter, which every real caller omits.
    expect(dts, 'skipFile must be optional — it was required-`any` while the JSDoc was inert').toMatch(
      /skipFile\?:\s*\(\(file:\s*string\)\s*=>\s*boolean\)/,
    );

    // A blunt backstop for the general case: no parameter of the exported
    // signature should be `any`.
    const signature = dts.slice(dts.indexOf('export function applyPendingMigrations'));
    expect(signature, 'a parameter regressed to `any` — the JSDoc is no longer being applied').not.toMatch(
      /^\s+\w+\??:\s*any;/m,
    );
  });

  it('index.d.ts declares the FULL export surface, so no runtime export reads as missing', () => {
    // A partial hand-written shim would make a runtime-present export a TS2305
    // compile error, which reads as a missing feature rather than a missing
    // declaration. Generation is what keeps this list complete for free; this
    // asserts the property rather than trusting it.
    const js = readFileSync(join(PKG_DIR, 'src', 'index.js'), 'utf8');
    const dts = readFileSync(join(PKG_DIR, 'src', 'index.d.ts'), 'utf8');

    const exported = [...js.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map((m) => m[1]);
    expect(exported.length, 'parsed no exports from index.js — the regex needs updating').toBeGreaterThan(5);

    const undeclared = exported.filter((name) => !new RegExp(`\\b${name}\\b`).test(dts));
    expect(undeclared, `declared in index.js but absent from index.d.ts: ${undeclared.join(', ')}`).toEqual([]);
  });
});
