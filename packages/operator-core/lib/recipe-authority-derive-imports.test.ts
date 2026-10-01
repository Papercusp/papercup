import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * P-007 recurrence guard (cupboard-release-pipeline-content-trust-2026-09-16, plan Decision D-010).
 *
 * `recipe-authority-derive.ts` is the pure static derivation the Cupboard Worker bundles to compute a
 * recipe's authority server-side (D-005: the Worker verifies, never launders). It is only bundle-safe
 * because it imports NOTHING but the `@papercusp/tooldef/parse-check` subpath. The failure this
 * guards is silent at the call site: one innocent `import { createHash } from 'node:crypto'`, a
 * `@papercusp/tooldef` BARREL import (drags in @opentelemetry/* and MDX/JSX — measured: wrangler
 * dry-run exits 1 `Could not resolve @opentelemetry/*`), or a relative import of the postgres-typed
 * `recipe-authority.ts` would still typecheck and pass every operator-core test, then break the
 * Worker build — or worse, ship a bundle whose analyzer is missing.
 *
 * The extractor walks the TypeScript AST (never a regex over text, so a specifier mentioned in a
 * comment or string cannot satisfy or trip it) and the guard has a POSITIVE CONTROL: a fixture that
 * imports every forbidden shape must be flagged by the same extractor, so an empty or broken
 * extractor cannot pass this file vacuously.
 */
const here = dirname(fileURLToPath(import.meta.url));
const DERIVE = resolve(here, 'recipe-authority-derive.ts');
const CONTENT_PIN = resolve(here, '../../../apps/operator-public/src/content-pin.ts');

/** Every module specifier a source file loads: static import/export-from, dynamic import(), require(). */
function moduleSpecifiers(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) out.push(expr.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isLoad =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
      if (isLoad) {
        const arg = node.arguments[0];
        // A non-literal argument is a dynamic specifier the allowlist cannot reason about: record it
        // as an explicit marker so it FAILS the allowlist instead of vanishing from the scan.
        out.push(arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : '<non-literal>');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const ALLOWED_DERIVE_IMPORTS = ['@papercusp/tooldef/parse-check'];
const ALLOWED_WORKER_OPERATOR_CORE_IMPORT = '@papercusp/operator-core/lib/recipe-authority-derive';

describe('recipe-authority-derive.ts import allowlist (Worker-bundle safety, P-007 / D-010)', () => {
  it('POSITIVE CONTROL: the extractor flags every forbidden import shape in a fixture', () => {
    const fixture = [
      `import { createHash } from 'node:crypto';`,
      `import type postgres from 'postgres';`,
      `import { loadTools } from '@papercusp/tooldef';`,
      `import { x } from './recipe-authority';`,
      `export { y } from '../agent-tools/_harness-scope';`,
      `const a = await import('node:fs');`,
      `const b = require('node:path');`,
      `const c = await import(someVariable);`,
      `// import { fake } from 'in-a-comment';`,
      `const s = "import { fake } from 'in-a-string'";`,
    ].join('\n');
    expect(moduleSpecifiers('fixture.ts', fixture).sort()).toEqual(
      [
        '../agent-tools/_harness-scope',
        './recipe-authority',
        '<non-literal>',
        '@papercusp/tooldef',
        'node:crypto',
        'node:fs',
        'node:path',
        'postgres',
      ].sort(),
    );
  });

  it('imports ONLY the @papercusp/tooldef/parse-check subpath — no node:*, no barrel, no relative module', () => {
    const specs = moduleSpecifiers(DERIVE, readFileSync(DERIVE, 'utf8'));
    // Positive control on the real file: a vacuous scan (zero specifiers) must not pass.
    expect(specs.length, 'recipe-authority-derive.ts has no imports at all — extractor or file is broken').toBeGreaterThan(0);
    const unexpected = specs.filter((s) => !ALLOWED_DERIVE_IMPORTS.includes(s));
    expect(
      unexpected,
      `recipe-authority-derive.ts imports ${unexpected.join(', ')}. The Cupboard Worker bundles this module ` +
        `(apps/operator-public/src/content-pin.ts); only ${ALLOWED_DERIVE_IMPORTS.join(', ')} is bundle-safe. ` +
        `node:* builtins, the @papercusp/tooldef barrel (pulls @opentelemetry/*), and recipe-authority.ts ` +
        `(postgres, harness-scope) do not resolve in a Worker. Put new I/O-bound logic in recipe-authority.ts.`,
    ).toEqual([]);
    expect(specs).toContain('@papercusp/tooldef/parse-check');
  });

  it('the Worker reaches operator-core through exactly one module: recipe-authority-derive', () => {
    const specs = moduleSpecifiers(CONTENT_PIN, readFileSync(CONTENT_PIN, 'utf8')).filter((s) =>
      s.startsWith('@papercusp/operator-core'),
    );
    expect(specs, 'content-pin.ts no longer loads the derive module — the Worker analyzer is unwired').toContain(
      ALLOWED_WORKER_OPERATOR_CORE_IMPORT,
    );
    expect(
      specs.filter((s) => s !== ALLOWED_WORKER_OPERATOR_CORE_IMPORT),
      'content-pin.ts imports another operator-core module; every one besides recipe-authority-derive ' +
        'drags non-Worker-safe dependencies into the bundle',
    ).toEqual([]);
  });
});
