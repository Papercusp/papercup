import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(__dirname, '..');

const SERVER_HEAVY_OPERATOR_CORE_IMPORTS = [
  /@papercusp\/operator-core\/lib\/agent-tools(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/cross-hive-asks-pg(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/dbos(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/endpoint-route(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/harness-readers(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/harness-issues(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/harness\/routines(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/memory\/knowledge-read$/,
  /@papercusp\/operator-core\/lib\/operator-audit(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/operator-notes(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/plugin-loader(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/storage(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/sync\/hyperbee(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/sync-resolver(?:$|\/(?!list-meta$))/,
  /@papercusp\/operator-core\/lib\/text-artifacts(?:\/|$)/,
  /@papercusp\/operator-core\/lib\/work-items(?:\/|$)/,
];

const DIRECT_SERVER_IMPORTS = [
  /^drizzle-orm(?:\/|$)/,
  /^postgres(?:\/|$)/,
  /^@papercusp\/papercusp-db(?:\/|$)/,
  /^@papercusp\/db(?:\/|$)/,
];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(abs);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) yield abs;
  }
}

function valueImports(source: string): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(/\bimport\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g)) {
    imports.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push(match[1]);
  }
  return imports;
}

function isForbiddenClientImport(specifier: string): boolean {
  return (
    SERVER_HEAVY_OPERATOR_CORE_IMPORTS.some((pattern) => pattern.test(specifier)) ||
    DIRECT_SERVER_IMPORTS.some((pattern) => pattern.test(specifier))
  );
}

describe('operator-core client boundary', () => {
  it('keeps server-heavy operator-core and DB modules out of Vite client value imports', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
      const rel = relative(SRC_ROOT, file);
      const imports = valueImports(readFileSync(file, 'utf8'));
      for (const specifier of imports) {
        if (isForbiddenClientImport(specifier)) {
          violations.push(`${rel}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
