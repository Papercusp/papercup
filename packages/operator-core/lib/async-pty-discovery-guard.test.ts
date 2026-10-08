/**
 * Recurrence guard for synchronous psu-pty discovery on the operator event loop.
 * The synchronous finder touches metadata, socket paths, and /proc identity;
 * any async function or callback containing it can stall unrelated requests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isAsync(node: ts.FunctionLikeDeclaration): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

function syncDiscoveryCallsInAsyncContext(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];

  const visit = (node: ts.Node, asyncAncestor: boolean): void => {
    const nestedAsync = asyncAncestor || (isFunction(node) && isAsync(node));
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const callee = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : null;
      if (
        nestedAsync &&
        (callee === 'findLiveHost' || callee === 'selfCompactionAvailability')
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        findings.push(relative(LIB_ROOT, fileName) + ':' + line + ' ' + callee);
      }
    }
    ts.forEachChild(node, (child) => visit(child, nestedAsync));
  };

  visit(source, false);
  return findings;
}

function operatorSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : operatorSourceFiles(fullPath);
    }
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [fullPath]
      : [];
  });
}

describe('async PTY discovery recurrence guard', () => {
  it('detects sync host discovery inside async bodies and nested callbacks', () => {
    const fixture = `async function handler() {
      await Promise.resolve();
      const callback = () => findLiveHost('owner');
      return callback();
    }
    const syncOnly = () => selfCompactionAvailability('owner');`;
    expect(syncDiscoveryCallsInAsyncContext(join(LIB_ROOT, 'fixture.ts'), fixture)).toEqual([
      'fixture.ts:3 findLiveHost',
    ]);
  });

  it('keeps sync host discovery out of async operator source', () => {
    const findings = operatorSourceFiles(LIB_ROOT).flatMap((fileName) =>
      syncDiscoveryCallsInAsyncContext(fileName, readFileSync(fileName, 'utf8')),
    );
    expect(findings).toEqual([]);
  });
});
