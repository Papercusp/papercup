/** D-016 / P-026: behavioral conformance cannot detect an unused copy of host policy.
 * Scan package-owned source too, with planted, never-called counterexamples. URL pagination
 * validation and typed fault reporting remain provider responsibilities; recovery and policy
 * enforcement remain host responsibilities. The generated stdio bridge is checked separately
 * against the shared SDK builder before it can be excluded from the owned-source scan.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PLUGINS = join(REPO, 'libs/papercusp/plugins');
const packages = readdirSync(PLUGINS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGINS, entry.name, 'papercusp.json'), 'utf8'));
    return manifest.provider?.datatypes?.some((datatype: string) => ['social-post', 'blog-post'].includes(datatype)) ? [[entry.name, join(PLUGINS, entry.name)] as const] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
});

type Policy = 'retry/backoff' | 'cursor recovery' | 'egress enforcement';

/** Instagram observes an already-created media container before publishing it once.
 * Its bounded status-only loop is not a retry of creation/publication. An extra request
 * in that loop invalidates this exception, including inside an unused nested function.
 */
function isLifecycleObservation(timer: ts.CallExpression, source: ts.SourceFile): boolean {
  let ancestor: ts.Node | undefined = timer.parent;
  while (ancestor && !ts.isForStatement(ancestor)) ancestor = ancestor.parent;
  if (!ancestor || !ts.isForStatement(ancestor) || !ancestor.initializer ||
    !ts.isVariableDeclarationList(ancestor.initializer) || ancestor.initializer.declarations.length !== 1) return false;
  const counter = ancestor.initializer.declarations[0];
  if (!ts.isIdentifier(counter.name) || counter.initializer?.getText(source) !== '0') return false;
  const name = counter.name.text;
  if (!ancestor.condition || !ts.isBinaryExpression(ancestor.condition) ||
    ancestor.condition.left.getText(source) !== name || ancestor.condition.operatorToken.kind !== ts.SyntaxKind.LessThanEqualsToken ||
    ancestor.condition.right.getText(source) !== '5') return false;
  const step = ancestor.incrementor;
  const incrementsOnce = step && (
    ((ts.isPostfixUnaryExpression(step) || ts.isPrefixUnaryExpression(step)) && step.operator === ts.SyntaxKind.PlusPlusToken && step.operand.getText(source) === name) ||
    (ts.isBinaryExpression(step) && step.left.getText(source) === name && step.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && step.right.getText(source) === '1')
  );
  if (!incrementsOnce || timer.arguments.length !== 2 || !ts.isNumericLiteral(timer.arguments[1]) || Number(timer.arguments[1].text) !== 60_000) return false;
  const calls: string[] = [];
  const literals = new Set<string>();
  let changesCounter = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    if (ts.isStringLiteral(node)) literals.add(node.text);
    if ((ts.isBinaryExpression(node) && node.left.getText(source) === name &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && node.operand.getText(source) === name &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))) changesCounter = true;
    ts.forEachChild(node, visit);
  };
  visit(ancestor.statement);
  return !changesCounter && calls.filter((call) => call === 'statusOf').length === 1 &&
    calls.filter((call) => call === 'setTimeout').length === 1 && literals.has('FINISHED') && literals.has('IN_PROGRESS') &&
    calls.every((call) => ['statusOf', 'targetId', 'fault', 'status.toLowerCase', 'setTimeout'].includes(call));
}

/** Syntax, not comments or dead-code execution: these rules also inspect unused functions. */
function copiedPolicies(body: string): Policy[] {
  const source = ts.createSourceFile('provider.cjs', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Set<Policy>();
  const text = (node: ts.Node) => node.getText(source);
  const cursorCheck = (node: ts.Node) => /['"]cursor-expired['"]/.test(text(node));
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || (ts.isCallExpression(node) && text(node.expression) === 'require')) {
      const specifier = ts.isImportDeclaration(node) ? node.moduleSpecifier : node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) {
        if (/^(?:node:)?timers(?:\/promises)?$|^(?:p-retry|async-retry|retry|exponential-backoff)$/.test(specifier.text)) found.add('retry/backoff');
        if (/^(?:node:)?(?:http|https|http2|net|tls)$|^undici$/.test(specifier.text)) found.add('egress enforcement');
      }
    }
    if (ts.isCallExpression(node)) {
      const call = text(node.expression);
      if (/(?:^|\.)(?:setTimeout|setInterval|sleep)$|^Atomics\.wait(?:Async)?$/.test(call) &&
        !(call === 'setTimeout' && isLifecycleObservation(node, source))) found.add('retry/backoff');
      if (call === 'fetch' || /^(?:globalThis|global)\.fetch$/.test(call)) found.add('egress enforcement');
      if (/\.(?:has|includes|test|match)$/.test(call) && node.arguments.some((arg) => /\.(?:host|hostname|origin)\b/.test(text(arg)))) found.add('egress enforcement');
    }
    if (ts.isPropertyAccessExpression(node) && /^(?:egressHosts|host|hostname)$/.test(node.name.text)) found.add('egress enforcement');
    if (ts.isBinaryExpression(node) && /\.(?:host|hostname|origin)\b/.test(text(node)) &&
      (ts.isStringLiteral(node.left) || ts.isStringLiteral(node.right))) found.add('egress enforcement');
    if ((ts.isIfStatement(node) && cursorCheck(node.expression)) ||
      (ts.isConditionalExpression(node) && cursorCheck(node.condition)) ||
      (ts.isSwitchStatement(node) && node.caseBlock.clauses.some((clause) => ts.isCaseClause(clause) && cursorCheck(clause.expression)))) found.add('cursor recovery');
    if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      const loop = text(node);
      if (/\b(?:attempt|attempts|retries|retryCount|backoff)\b/.test(loop) ||
        (/\b(?:429|503)\b/.test(loop) && /\b(?:fetch|graph)\s*\(/.test(loop))) found.add('retry/backoff');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

function ownedSources(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.git'].includes(entry.name)) return [];
    const path = join(current, entry.name);
    if (entry.isDirectory()) return ownedSources(root, path);
    if (!entry.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) || /(?:\.test|\.spec|\.d)\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) return [];
    // This exact file is generated solely from the SDK, as the independent byte check proves.
    return relative(root, path) === 'daemon.cjs' ? [] : [path];
  });
}

describe('social packages keep shared host policy in the host', () => {
  it('discovers delivered social providers and verifies every excluded launcher against the SDK builder', () => {
    expect(packages.map(([name]) => name)).toEqual(expect.arrayContaining(['facebook-pages', 'instagram', 'x']));
    const generated = packages.filter(([, path]) => existsSync(join(path, 'daemon.cjs')));
    expect(generated.length).toBeGreaterThan(0);
    execFileSync(process.execPath, [join(REPO, 'packages/plugin-sdk/scripts/build-provider-daemons.mjs'), '--check', ...generated.map(([, path]) => path)], { cwd: REPO, stdio: 'pipe' });
  });

  it.each(packages)('%s carries no copied retry, cursor recovery or egress policy in owned source', (_name, root) => {
    const files = ownedSources(root);
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((path) => copiedPolicies(readFileSync(path, 'utf8')).map((policy) => `${relative(root, path)}: ${policy}`))).toEqual([]);
  });

  it.each([
    ['retry/backoff', 'async function unused() { await new Promise(resolve => setTimeout(resolve, 1000)); }'],
    ['retry/backoff', "const { setTimeout: pause } = require('node:timers/promises'); async function unused() { await pause(1000); }"],
    ['retry/backoff', 'async function unused(host) { for (let attempt = 0; attempt < 3; attempt++) await host.fetch({}); }'],
    ['cursor recovery', "function unused(error) { if (error.kind === 'cursor-expired') return syncPage({ cursor: null }); }"],
    ['cursor recovery', "function unused(error) { switch (error.kind) { case 'cursor-expired': return fresh(); } }"],
    ['egress enforcement', "function unused(url) { return ['api.example'].includes(new URL(url).hostname); }"],
    ['egress enforcement', "function unused(url) { return new URL(url).origin === 'https://api.example'; }"],
    ['egress enforcement', 'function unused(descriptor, url) { return descriptor.egressHosts.includes(url); }'],
  ] as const)('detects dormant %s code: %s', (policy, planted) => {
    expect(copiedPolicies(planted)).toContain(policy);
  });

  it('allows bounded container observation and rejects a request hidden in that loop', () => {
    const observe = `async function observe() {
      for (let minute = 0; minute <= 5; minute++) {
        status = await statusOf(host, source, targetId(container));
        if (status === 'FINISHED') break;
        if (status !== 'IN_PROGRESS') throw fault('transient', 'container_failed');
        await new Promise(resolve => setTimeout(resolve, 60_000));
      }
    }`;
    expect(copiedPolicies(observe)).toEqual([]);
    expect(copiedPolicies(observe.replace("if (status === 'FINISHED')", "await host.fetch({}); if (status === 'FINISHED')"))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('minute <= 5', 'minute <= 5000'))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('minute++', 'minute--'))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('minute++', 'minute += 0'))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('let minute = 0', 'let minute = -5000'))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace("if (status === 'FINISHED')", "minute = 0; if (status === 'FINISHED')"))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('60_000', 'delay'))).toContain('retry/backoff');
  });

  it('allows fault classification, host catch-up reporting and resource-bound pagination validation', () => {
    expect(copiedPolicies(`
      // retry/backoff, cursor-expired and egressHosts in comments are not implementations.
      const descriptor = { egressHosts: ['api.example'] };
      if (response.status === 429) throw fault('rate-limited', 'throttled', { retryAfterSeconds: 10 });
      if (!valid(cursor)) throw fault('cursor-expired', 'unreadable');
      const catchUp = request.catchUpFrom ? { reason: 'cursor-expired' } : undefined;
      if (next.origin !== current.origin || next.pathname !== current.pathname) throw fault('transient', 'outside_resource');
      await host.fetch({ source, request: { url } });
    `)).toEqual([]);
  });
});
