/**
 * Guard test for scripts/check-licenses.mjs — the npm + Rust dependency license gate
 * (plan open-source-release-2026-09-29, P-017 / D-001, WI-10003906).
 *
 * WHY THESE CONTROLS EXIST
 * The gate's value is one decision per package: allowed or denied. Both failure directions
 * look green from outside. An evaluator that reads `GPL-3.0 OR MIT` as denied red-pins the
 * fleet on a dual-licensed crate; one that reads `MIT AND GPL-3.0` as allowed, or guesses at
 * a malformed expression, lets a copyleft dependency into a public release. The first audit
 * only found a non-commercial package (@codesandbox/nodebox) because a person opened its
 * LICENSE file, so the exception path matters as much as the evaluator: an exception must
 * stop applying the moment the package's declared license changes.
 *
 * Every function under test is pure, so each case runs on inline fixtures: no lockfile
 * read, no cargo invocation, no shared-tree mutation. The one real-file case checks the
 * committed exceptions file against the same validator the gate runs first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Enrolled in tsconfig.declarations.json, so this import is typed by the generated
// sibling scripts/check-licenses.d.mts.
import {
  TIER,
  cargoPackagesOf,
  classify,
  declaredNpmLicense,
  evaluateExpression,
  npmPackagesOf,
  validateExceptions,
} from '../../../scripts/check-licenses.mjs';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const EXCEPTIONS_PATH = join(REPO_ROOT, 'scripts', 'license-exceptions.json');

const tier = (expr: unknown) => evaluateExpression(expr).tier;

describe('evaluateExpression — SPDX semantics', () => {
  it('classifies single ids into the three tiers', () => {
    expect(tier('MIT')).toBe(TIER.PERMISSIVE);
    expect(tier('Apache-2.0')).toBe(TIER.PERMISSIVE);
    expect(tier('MPL-2.0')).toBe(TIER.WEAK_COPYLEFT);
    expect(tier('LGPL-3.0-or-later')).toBe(TIER.WEAK_COPYLEFT);
    expect(tier('GPL-3.0-only')).toBe(TIER.DENIED);
    expect(tier('AGPL-3.0-only')).toBe(TIER.DENIED);
    expect(tier('BUSL-1.1')).toBe(TIER.DENIED);
    expect(tier('SSPL-1.0')).toBe(TIER.DENIED);
  });

  it('OR takes the best alternative', () => {
    expect(tier('GPL-3.0-only OR MIT')).toBe(TIER.PERMISSIVE);
    expect(tier('MPL-2.0 OR GPL-2.0-only')).toBe(TIER.WEAK_COPYLEFT);
  });

  it('AND takes the worst alternative — a permissive half never launders a copyleft half', () => {
    expect(tier('MIT AND GPL-3.0-only')).toBe(TIER.DENIED);
    expect(tier('Apache-2.0 AND MPL-2.0')).toBe(TIER.WEAK_COPYLEFT);
    expect(evaluateExpression('MIT AND GPL-3.0-only').ids).toEqual(['GPL-3.0-only']);
  });

  it('AND binds tighter than OR, and parentheses override it', () => {
    // MIT OR (GPL AND Apache) → permissive via MIT.
    expect(tier('MIT OR GPL-3.0-only AND Apache-2.0')).toBe(TIER.PERMISSIVE);
    // (MIT OR GPL) AND GPL → denied.
    expect(tier('(MIT OR GPL-3.0-only) AND GPL-2.0-only')).toBe(TIER.DENIED);
    expect(tier('(MIT OR Apache-2.0) AND (Zlib OR BSD-3-Clause)')).toBe(TIER.PERMISSIVE);
  });

  it('accepts the legacy forms real lockfiles carry: slash, lowercase operators, WITH, trailing +', () => {
    expect(tier('MIT/Apache-2.0')).toBe(TIER.PERMISSIVE);
    expect(tier('GPL-3.0-only/MIT')).toBe(TIER.PERMISSIVE);
    expect(tier('MIT or Apache-2.0')).toBe(TIER.PERMISSIVE);
    expect(tier('Apache-2.0 WITH LLVM-exception')).toBe(TIER.PERMISSIVE);
    expect(tier('LGPL-2.1+')).toBe(TIER.WEAK_COPYLEFT);
    expect(tier('LGPL-3.0')).toBe(TIER.WEAK_COPYLEFT);
    // The deprecated GPL forms stay denied.
    expect(tier('GPL-2.0+')).toBe(TIER.DENIED);
    expect(tier('GPL-3.0')).toBe(TIER.DENIED);
  });

  it('denies anything it cannot parse instead of guessing', () => {
    for (const bad of ['', '   ', 'MIT OR', '(MIT', 'MIT)', 'AND MIT', 'MIT WITH', undefined, null, 42]) {
      expect(tier(bad), String(bad)).toBe(TIER.DENIED);
    }
    // Unknown ids, "SEE LICENSE IN …" and the no-license sentinel are all denied.
    expect(tier('SEE LICENSE IN LICENSE.md')).toBe(TIER.DENIED);
    expect(tier('UNLICENSED')).toBe(TIER.DENIED);
    expect(tier('<none>')).toBe(TIER.DENIED);
  });
});

describe('declaredNpmLicense / npmPackagesOf — reading the lockfile', () => {
  it('reads string, legacy arrays and { type } objects; missing reads as <none>', () => {
    expect(declaredNpmLicense({ license: 'MIT' })).toBe('MIT');
    expect(declaredNpmLicense({ licenses: ['MIT', 'Apache-2.0'] })).toBe('MIT OR Apache-2.0');
    expect(declaredNpmLicense({ licenses: [{ type: 'BSD-3-Clause' }] })).toBe('BSD-3-Clause');
    expect(declaredNpmLicense({ license: { type: 'ISC' } })).toBe('ISC');
    expect(declaredNpmLicense({})).toBe('<none>');
    expect(declaredNpmLicense({ license: '' })).toBe('<none>');
    expect(declaredNpmLicense({ licenses: [{}] })).toBe('<none>');
  });

  it('takes every node_modules entry, including nested ones, and skips the root and workspace links', () => {
    const lock = {
      packages: {
        '': { name: 'root', license: 'UNLICENSED' },
        'packages/app': { name: 'app', license: 'UNLICENSED' },
        'node_modules/app': { link: true, resolved: 'packages/app' },
        'node_modules/left-pad': { version: '1.3.0', license: 'WTFPL' },
        'node_modules/a/node_modules/@scope/b': { version: '2.0.0', license: 'GPL-3.0-only', optional: true },
      },
    };
    expect(npmPackagesOf(lock)).toEqual([
      { name: 'left-pad', version: '1.3.0', declared: 'WTFPL' },
      { name: '@scope/b', version: '2.0.0', declared: 'GPL-3.0-only' },
    ]);
  });
});

describe('cargoPackagesOf — reading cargo metadata', () => {
  it('skips path crates (this repo’s own source) and falls back to license_file / <none>', () => {
    const meta = {
      packages: [
        { name: 'papercusp-desktop', version: '0.1.0', source: null, license: null },
        { name: 'serde', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index', license: 'MIT OR Apache-2.0' },
        { name: 'ring', version: '0.17.0', source: 'registry+x', license: null, license_file: 'LICENSE' },
        { name: 'mystery', version: '0.0.1', source: 'git+https://example.com/m', license: null },
      ],
    };
    expect(cargoPackagesOf(meta)).toEqual([
      { name: 'serde', version: '1.0.0', declared: 'MIT OR Apache-2.0' },
      { name: 'ring', version: '0.17.0', declared: '<license-file:LICENSE>' },
      { name: 'mystery', version: '0.0.1', declared: '<none>' },
    ]);
  });
});

describe('classify — policy plus reviewed exceptions', () => {
  const pkgs = [
    { name: 'ok', version: '1.0.0', declared: 'MIT', lockfile: 'package-lock.json' },
    { name: 'ok', version: '1.0.0', declared: 'MIT', lockfile: 'apps/x/package-lock.json' },
    { name: 'mpl', version: '2.0.0', declared: 'MPL-2.0', lockfile: 'package-lock.json' },
    { name: 'gpl', version: '3.0.0', declared: 'GPL-3.0-only', lockfile: 'package-lock.json' },
    { name: 'nolicense', version: '0.1.0', declared: '<none>', lockfile: 'package-lock.json' },
    { name: 'sdk', version: '1.0.0', declared: 'SEE LICENSE IN README.md', lockfile: 'package-lock.json' },
  ];

  it('without exceptions, denies GPL, missing and SEE-LICENSE packages and dedupes across lockfiles', () => {
    const r = classify(pkgs, {});
    expect(r.denied.map((x: { name: string }) => x.name)).toEqual(['gpl', 'nolicense', 'sdk']);
    expect(r.weakCopyleft.map((x: { name: string }) => x.name)).toEqual(['mpl']);
    const ok = r.rows.find((x: { name: string }) => x.name === 'ok');
    expect(ok.lockfiles).toEqual(['apps/x/package-lock.json', 'package-lock.json']);
  });

  it('an exception admits a package only while its declared value is unchanged', () => {
    const exceptions = {
      nolicense: { declared: '<none>', license: 'MIT', reason: 'LICENSE file in the tarball is MIT' },
      sdk: { declared: 'SEE LICENSE IN README.md', allow: true, reason: 'reviewed commercial terms allow redistribution' },
    };
    const r = classify(pkgs, exceptions);
    expect(r.denied.map((x: { name: string }) => x.name)).toEqual(['gpl']);
    expect(r.rows.find((x: { name: string }) => x.name === 'sdk').via).toBe('exception');

    // The package re-licenses: the recorded review no longer describes it.
    const relicensed = pkgs.map((p) => (p.name === 'nolicense' ? { ...p, declared: 'BUSL-1.1' } : p));
    const r2 = classify(relicensed, exceptions);
    const row = r2.denied.find((x: { name: string }) => x.name === 'nolicense');
    expect(row).toBeDefined();
    expect(row.exceptionMismatch).toBe('<none>');
  });

  it('an exception whose license is itself copyleft still classifies by that license', () => {
    const r = classify([{ name: 'x', version: '1', declared: '<none>' }], {
      x: { declared: '<none>', license: 'MPL-2.0', reason: 'LICENSE text is MPL-2.0' },
    });
    expect(r.weakCopyleft.map((x: { name: string }) => x.name)).toEqual(['x']);
  });

  it('reports exceptions that no longer match any package as stale', () => {
    const r = classify(pkgs, { gone: { declared: 'MIT', license: 'MIT', reason: 'removed dependency' } });
    expect(r.stale).toEqual(['gone']);
  });
});

describe('validateExceptions — a malformed entry must not admit anything', () => {
  it('refuses missing declared, a thin reason, both/neither of license|allow, and a denied license', () => {
    const problems = validateExceptions({
      npm: {
        a: { license: 'MIT', reason: 'long enough reason' },
        b: { declared: '<none>', license: 'MIT', reason: 'ok' },
        c: { declared: '<none>', license: 'MIT', allow: true, reason: 'long enough reason' },
        d: { declared: '<none>', reason: 'long enough reason' },
        e: { declared: '<none>', license: 'GPL-3.0-only', reason: 'long enough reason' },
      },
    });
    expect(problems.some((p: string) => p.startsWith('npm:a ') && p.includes('declared'))).toBe(true);
    expect(problems.some((p: string) => p.startsWith('npm:b ') && p.includes('reason'))).toBe(true);
    expect(problems.some((p: string) => p.startsWith('npm:c ') && p.includes('exactly one'))).toBe(true);
    expect(problems.some((p: string) => p.startsWith('npm:d ') && p.includes('exactly one'))).toBe(true);
    expect(problems.some((p: string) => p.startsWith('npm:e ') && p.includes('itself denied'))).toBe(true);
  });

  it('accepts a well-formed file and ignores $-prefixed comment keys', () => {
    expect(validateExceptions({
      npm: { $comment: 'notes', ok: { declared: '<none>', license: 'MIT', reason: 'LICENSE file is MIT' } },
      cargo: { crate: { declared: 'Custom', allow: true, reason: 'reviewed and permitted' } },
    })).toEqual([]);
  });

  it('the committed scripts/license-exceptions.json passes the same validation the gate runs first', () => {
    const file = JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8'));
    expect(validateExceptions(file)).toEqual([]);
    // Positive control: the file really carries entries in both ecosystems, so an empty
    // or mis-keyed file cannot pass this case vacuously.
    expect(Object.keys(file.npm ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(file.cargo ?? {}).length).toBeGreaterThan(0);
  });
});
