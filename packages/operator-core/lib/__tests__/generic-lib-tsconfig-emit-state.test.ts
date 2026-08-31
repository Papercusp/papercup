/**
 * EI-21984194348984224 — a `libs/generic/*` tsconfig must never sit in the state
 * that makes `tsc -p <lib>` fail TS5011.
 *
 * The incident: `npx tsc -p libs/generic/plan-parser` exited 2 with a single
 * TS5011 ("The common source directory ... 'rootDir' must be explicitly set"),
 * which is an OUTPUT-LAYOUT diagnostic that fires only when EMITTING. Measured
 * 2026-08-31 across all 60 generic libs: 32 were in that state — exactly the set
 * with `outDir` set, no `rootDir`, and `noEmit` not true.
 *
 * Why it is worth a guard rather than a memory:
 *
 *   - It fails in the expensive direction. The natural command to answer "do my
 *     changes typecheck?" returns a red-looking error on a lib whose types are
 *     fine, which invites either a bogus "the lib is broken" report or the habit
 *     of ignoring a non-zero tsc exit on these packages — and that habit would
 *     later swallow a REAL type error. This was not hypothetical: while fixing
 *     this, a genuine TS2677 in plan-parser (a peer's test file added the same
 *     day) was sitting behind exactly that noise.
 *   - Emitting also writes untracked `dist/` into the shared tree, which
 *     git-sync sweeps. One 60-package survey created 16 such directories.
 *
 * The fix was `"noEmit": true`, NOT the `rootDir` the diagnostic asks for. All
 * 32 declare `main: "./src/index.ts"` and none has a build script using
 * tsconfig.json, so nothing consumes their output — and 26 of the 28 libs that
 * already passed use `noEmit: true`, six of them with no rootDir at all, which
 * is the in-repo control proving noEmit alone resolves TS5011. The two libs that
 * really do build (`tooldef`, `tooldef-http`) emit from a separate
 * `tsconfig.build.json` that extends the base and re-sets `noEmit: false`.
 *
 * The rule below is deliberately the narrow one — "no config may sit in the
 * TS5011-producing state" — so a lib that legitimately emits (it sets rootDir,
 * like `sse` and `sync`) is untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const GENERIC_ROOT = resolve(__dirname, '../../../../libs/generic');

interface Config {
  lib: string;
  path: string;
  outDir: unknown;
  rootDir: unknown;
  noEmit: unknown;
}

/**
 * Reads every generic lib's base tsconfig. An unparseable file FAILS rather than
 * being skipped: a skip would let the population shrink silently, which is the
 * vacuous-pass this guard exists to prevent.
 */
function readConfigs(): Config[] {
  const libs = readdirSync(GENERIC_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out: Config[] = [];
  for (const lib of libs) {
    const path = join(GENERIC_ROOT, lib, 'tsconfig.json');
    if (!existsSync(path)) continue;
    let parsed: { compilerOptions?: Record<string, unknown> };
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new Error(`libs/generic/${lib}/tsconfig.json is not parseable JSON: ${(e as Error).message}`);
    }
    const co = parsed.compilerOptions ?? {};
    out.push({ lib, path, outDir: co.outDir, rootDir: co.rootDir, noEmit: co.noEmit });
  }
  return out;
}

/**
 * The TS5011-producing state: the config EMITS (noEmit is not literally true),
 * declares an `outDir`, and leaves `rootDir` for the compiler to infer. `tsc -p`
 * then refuses rather than inferring it.
 */
function producesTs5011(c: Pick<Config, 'outDir' | 'rootDir' | 'noEmit'>): boolean {
  return c.noEmit !== true && c.outDir !== undefined && c.rootDir === undefined;
}

describe('libs/generic tsconfigs are never in the TS5011-producing state', () => {
  it('finds a real population of generic lib tsconfigs (guards against a vacuous pass)', () => {
    const configs = readConfigs();
    // A glob that matches nothing passes every assertion below. Measured
    // population on 2026-08-31 was 60; pin a floor well under it so a genuine
    // removal does not fail the build, but a broken path does.
    expect(configs.length).toBeGreaterThanOrEqual(40);
  });

  it('no generic lib declares an outDir without a rootDir while still emitting', () => {
    const offenders = readConfigs()
      .filter(producesTs5011)
      .map((c) => `libs/generic/${c.lib}/tsconfig.json`);
    // Before this guard landed there were 32 of these. `tsc -p <lib>` exits 2 on
    // every one, reporting an output-layout complaint on a lib whose types are
    // fine — and emitting writes untracked dist/ into the shared tree.
    //
    // To repair a new offender: prefer `"noEmit": true` (the house shape — the
    // base tsconfig of a lib consumed from `./src/index.ts` is a TYPECHECK
    // config). Only add `rootDir` if the lib genuinely builds from this config,
    // and then give it a build script so the output has a consumer.
    expect(offenders).toEqual([]);
  });

  it('the rule actually fires on the offending shape (calibration, not a tautology)', () => {
    // Without this, the assertion above would pass just as happily if
    // `producesTs5011` were broken and always returned false.
    expect(producesTs5011({ outDir: './dist', rootDir: undefined, noEmit: false })).toBe(true);
    expect(producesTs5011({ outDir: './dist', rootDir: undefined, noEmit: undefined })).toBe(true);
    // ...and does NOT fire on the three legitimate shapes present in the tree:
    expect(producesTs5011({ outDir: './dist', rootDir: undefined, noEmit: true })).toBe(false);
    expect(producesTs5011({ outDir: './dist', rootDir: './src', noEmit: false })).toBe(false);
    expect(producesTs5011({ outDir: undefined, rootDir: undefined, noEmit: true })).toBe(false);
  });

  it('the two libs that really build still emit from their own build config', () => {
    // The base configs of tooldef/tooldef-http are typecheck-only like the rest;
    // their emit lives in tsconfig.build.json, which EXTENDS the base and
    // re-sets noEmit. If that inheritance is ever flattened, setting noEmit on
    // the base would silently stop producing their dist.
    for (const lib of ['tooldef', 'tooldef-http']) {
      const path = join(GENERIC_ROOT, lib, 'tsconfig.build.json');
      const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
        extends?: string;
        compilerOptions?: Record<string, unknown>;
      };
      expect(cfg.extends, `${lib}/tsconfig.build.json must extend the base config`).toBe('./tsconfig.json');
      expect(cfg.compilerOptions?.noEmit, `${lib} build config must re-enable emit`).toBe(false);
      expect(cfg.compilerOptions?.rootDir, `${lib} build config must set rootDir`).toBe('./src');
    }
  });
});
