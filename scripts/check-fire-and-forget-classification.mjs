#!/usr/bin/env node
/**
 * P-008: derive notification sites, then check curated delivery judgments.
 * Reuses the repository enumerator and TypeScript syntax tree; no runtime store.
 * --list --json is the reproducible seed, including source digests and gaps.
 * Scope: tracked JS/TS product source, including initialized submodules. Tests,
 * declarations, generated bundles and documentation are explicit exclusions.
 * This is conservative syntax/call-graph evidence, never delivery/restart proof.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coverageOf, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const digest = (s) => createHash('sha256').update(s).digest('hex');
const notificationName = (s) => /notify|notification|send|escalat/i.test(s);
const transparent = (n) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n)
  || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n);

export function inScope(path) {
  return /\.[cm]?[jt]sx?$/.test(path)
    && !/\.(?:d|test|spec|stories)\.[cm]?[jt]sx?$/.test(path)
    && !/(?:^|\/)(?:node_modules|\.git|\.papercusp|dist[^/]*|build|coverage|vendor|fixtures|__fixtures__|__tests__|test|tests|e2e|docs|env-sidecars|storybook-static|\.astro|\.next|\.output|\.svelte-kit|out|target)(?:\/|$)/.test(path)
    && !path.startsWith('apps/operator-docs/');
}

function tokens(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source);
  const out = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) out.push(scanner.getTokenText());
  return out.join(' ');
}

/** Await/return and Promise combinators retain custody; catch alone does not. */
function discarded(node) {
  let n = node;
  while (n.parent) {
    const p = n.parent;
    if (ts.isAwaitExpression(p) || ts.isReturnStatement(p)) return false;
    if (ts.isArrowFunction(p) && p.body === n) return false;
    if (ts.isVoidExpression(p)) return true;
    if (transparent(p) || ts.isArrayLiteralExpression(p) || ts.isConditionalExpression(p)) { n = p; continue; }
    if (ts.isPropertyAccessExpression(p) && p.expression === n && /^(then|catch|finally)$/.test(p.name.text)) { n = p; continue; }
    if (ts.isCallExpression(p)) {
      if (p.expression === n || /^Promise\.(all|allSettled|race|any)$/.test(p.expression.getText())) { n = p; continue; }
    }
    return true;
  }
  return true;
}

/**
 * Small lexical graph rather than a repository-wide typechecking Program. Imports,
 * re-exports, assignments, destructuring, callback arguments and wrapper bodies
 * share the same fixed-point propagation. Shadowed bindings stay lexical.
 */
export function censusSources(sources) {
  const files = new Map(Object.entries(sources).filter(([p]) => inScope(p)).sort(([a], [b]) => a.localeCompare(b)));
  const symbols = new Map();
  const modules = new Map();
  const calls = [];
  const gaps = [];
  let serial = 0;
  function symbol(name, scope) {
    const s = { id: ++serial, name, scope, edges: [], aliases: [], roots: new Set(), params: [] };
    symbols.set(s.id, s);
    return s;
  }
  const named = (scope, name) => ({ scope, name });
  const root = (name) => ({ root: name });
  function modulePath(from, specifier) {
    if (!specifier.startsWith('.')) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const stem = base.replace(/\.[cm]?jsx?$/, '');
    return [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].flatMap(e => [stem + e, posix.join(base, 'index' + e)])].find(p => files.has(p)) ?? null;
  }
  let parsed = 0;
  for (const [path, source] of files) {
    if (process.env.NOTIFY_CENSUS_PROGRESS && parsed++ % 1000 === 0) console.error(`NOTIFY_CENSUS_PROGRESS parsed=${parsed - 1}/${files.size}`);
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const d of sf.parseDiagnostics) gaps.push({ path, kind: 'parse', offset: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') });
    const top = { parent: null, names: new Map(), owner: null, label: '<module>' };
    const exports = new Map();
    const stars = [];
    modules.set(path, { exports, stars });
    const functionIds = new WeakMap();
    const objectIds = new WeakMap();
    const bind = (scope, name) => {
      if (!scope.names.has(name)) scope.names.set(name, symbol(name, scope));
      return scope.names.get(name);
    };
    const imported = (specifier, name) => ({ module: modulePath(path, specifier), name, external: specifier });
    function ref(n, scope) {
      if (!n) return null;
      if (transparent(n) || ts.isAwaitExpression(n)) return ref(n.expression, scope);
      if (ts.isIdentifier(n)) return named(scope, n.text);
      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        let s = scope; while (s && !s.classSymbol) s = s.parent;
        return s?.classSymbol ? { id: s.classSymbol.id } : null;
      }
      if (ts.isObjectLiteralExpression(n)) return objectIds.has(n) ? { id: objectIds.get(n).id } : null;
      if (ts.isFunctionLike(n)) return functionIds.get(n)?.id ? { id: functionIds.get(n).id } : null;
      if (ts.isPropertyAccessExpression(n)) return { base: ref(n.expression, scope), member: n.name.text };
      if (ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) return { base: ref(n.expression, scope), member: n.argumentExpression.text };
      if (ts.isNewExpression(n)) return ref(n.expression, scope);
      if (ts.isCallExpression(n)) {
        if ((n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText(sf) === 'require') && ts.isStringLiteralLike(n.arguments[0])) return imported(n.arguments[0].text, '*');
        return ref(n.expression, scope);
      }
      return null;
    }
    function binding(n, value, scope) {
      if (ts.isIdentifier(n)) { const s = bind(scope, n.text); if (value) { s.edges.push(value); s.aliases.push(value); } return s; }
      if (ts.isObjectBindingPattern(n)) for (const e of n.elements) binding(e.name, { base: value, member: e.propertyName?.text ?? e.name.getText(sf) }, scope);
      if (ts.isArrayBindingPattern(n)) for (const e of n.elements) if (ts.isBindingElement(e)) binding(e.name, value, scope);
      return null;
    }
    function visit(n, scope) {
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
        const s = n.name ? bind(scope, n.name.text) : symbol('<class>', scope);
        s.members = new Map();
        const child = { parent: scope, names: new Map(), owner: scope.owner, label: `${scope.label}/${n.name?.text ?? '<class>'}`, classSymbol: s };
        for (const m of n.members) {
          visit(m, child);
          if (m.name) {
            const member = symbol(m.name.getText(sf), child);
            member.edges.push(ref(ts.isPropertyDeclaration(m) ? m.initializer : m, child));
            member.aliases.push(...member.edges); s.members.set(member.name, member);
          }
        }
        if (n.name && n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exports.set(n.name.text, { id: s.id });
        return;
      }
      if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier) && !n.importClause?.isTypeOnly) {
        const c = n.importClause;
        if (c?.name) binding(c.name, imported(n.moduleSpecifier.text, 'default'), scope);
        if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) binding(c.namedBindings.name, imported(n.moduleSpecifier.text, '*'), scope);
        if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!e.isTypeOnly) binding(e.name, imported(n.moduleSpecifier.text, e.propertyName?.text ?? e.name.text), scope);
      }
      if (ts.isExportDeclaration(n) && !n.isTypeOnly) {
        const spec = n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
        if (n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) exports.set(e.name.text, spec ? imported(spec, e.propertyName?.text ?? e.name.text) : named(scope, e.propertyName?.text ?? e.name.text));
        else if (spec) stars.push(imported(spec, '*'));
      }
      if (ts.isFunctionLike(n) && n.body) {
        const localName = n.name?.getText(sf) ?? (ts.isVariableDeclaration(n.parent) ? n.parent.name.getText(sf) : ts.isPropertyAssignment(n.parent) ? n.parent.name.getText(sf) : '<callback>');
        const s = symbol(localName, scope);
        functionIds.set(n, s);
        if (n.name && ts.isFunctionDeclaration(n)) {
          const b = bind(scope, localName); b.edges.push({ id: s.id }); b.aliases.push({ id: s.id });
        }
        const child = { parent: scope, names: new Map(), owner: s, label: `${scope.label}/${localName}` };
        s.params = n.parameters.map(p => binding(p.name, null, child));
        if (n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exports.set(n.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : localName, { id: s.id });
        for (const p of n.parameters) if (p.initializer) visit(p.initializer, child);
        visit(n.body, child);
        return;
      }
      if (ts.isBlock(n) || ts.isCatchClause(n)) {
        const child = { parent: scope, names: new Map(), owner: scope.owner, label: scope.label };
        if (ts.isCatchClause(n) && n.variableDeclaration) binding(n.variableDeclaration.name, null, child);
        ts.forEachChild(n, c => visit(c, child));
        return;
      }
      // Visit children first so arrow/function-valued aliases have an identity.
      ts.forEachChild(n, c => visit(c, scope));
      if (ts.isObjectLiteralExpression(n)) {
        const s = symbol('<object>', scope); s.members = new Map(); objectIds.set(n, s);
        for (const p of n.properties) {
          if (ts.isSpreadAssignment(p)) { s.aliases.push(ref(p.expression, scope)); continue; }
          const member = symbol(p.name?.getText(sf) ?? '<property>', scope);
          member.edges.push(ref(ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : p, scope));
          member.aliases.push(...member.edges); s.members.set(member.name, member);
        }
      }
      if (ts.isVariableDeclaration(n)) {
        const s = binding(n.name, ref(n.initializer, scope), scope);
        if (s && n.parent.parent.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exports.set(n.name.getText(sf), { id: s.id });
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
        let targetScope = scope; while (targetScope.parent && !targetScope.names.has(n.left.text)) targetScope = targetScope.parent;
        binding(n.left, ref(n.right, scope), targetScope);
      }
      if (ts.isExportAssignment(n)) exports.set('default', ref(n.expression, scope));
      if (ts.isCallExpression(n)) {
        const callee = ref(n.expression, scope);
        const args = n.arguments.map(a => ref(a, scope));
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        calls.push({ path, line, owner: scope.owner, context: scope.label, callee, args, discarded: discarded(n), expression: tokens(n.getText(sf)) });
        if (scope.owner) scope.owner.edges.push(callee);
      }
    }
    visit(sf, top);
  }
  function targets(r, seen = new Set()) {
    if (!r || seen.has(r)) return [];
    seen.add(r);
    if (r.id) {
      const s = symbols.get(r.id);
      if (!s || seen.has(`id:${r.id}`)) return [];
      seen.add(`id:${r.id}`);
      return [s, ...s.aliases.flatMap(a => targets(a, seen))];
    }
    if (r.root) return [{ roots: new Set([r.root]) }];
    if (r.module !== undefined) {
      const key = `module:${r.module}:${r.name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const m = modules.get(r.module);
      if (r.name === '*') return [{ module: m }];
      return [...targets(m?.exports.get(r.name), seen), ...(m?.stars ?? []).flatMap(s => targets({ ...s, name: r.name }, seen)), ...(notificationName(r.name) ? targets(root(r.name), seen) : [])];
    }
    if (r.member) {
      const bases = targets(r.base, seen);
      return [...bases.flatMap(b => b.module ? targets(b.module.exports.get(r.member), seen) : b.members?.has(r.member) ? [b.members.get(r.member)] : []), ...(notificationName(r.member) ? targets(root(r.member), seen) : [])];
    }
    let scope = r.scope;
    while (scope && !scope.names.has(r.name)) scope = scope.parent;
    return [...(scope ? targets({ id: scope.names.get(r.name).id }, seen) : []), ...(notificationName(r.name) ? targets(root(r.name), seen) : [])];
  }
  // Parameter injection also reveals wrappers whose names contain no notify token.
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS graph symbols=${symbols.size} calls=${calls.length}`);
  for (const c of calls) for (const target of targets(c.callee)) c.args.forEach((a, i) => { if (target.params?.[i]) { target.params[i].edges.push(a); target.params[i].aliases.push(a); } });
  const reverse = new Map();
  const forward = new Map();
  for (const s of symbols.values()) for (const e of s.edges) for (const t of targets(e)) {
    if (t.id) {
      if (!reverse.has(t.id)) reverse.set(t.id, new Set()); reverse.get(t.id).add(s.id);
      if (!forward.has(s.id)) forward.set(s.id, new Set()); forward.get(s.id).add(t.id);
    }
    else for (const r of t.roots ?? []) s.roots.add(r);
  }
  const queue = [...symbols.values()].filter(s => s.roots.size).map(s => s.id);
  const queued = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; queued.delete(id);
    for (const receiver of reverse.get(id) ?? []) {
      const s = symbols.get(receiver); let changed = false;
      for (const r of symbols.get(id).roots) if (!s.roots.has(r)) { s.roots.add(r); changed = true; }
      if (changed && !queued.has(receiver)) { queued.add(receiver); queue.push(receiver); }
    }
  }
  for (const c of calls) { c.targets = targets(c.callee); c.argumentTargets = c.args.flatMap(a => targets(a)); }
  const detached = new Set();
  const detachedQueue = [];
  const mark = (id) => { if (id && !detached.has(id)) { detached.add(id); detachedQueue.push(id); } };
  for (const c of calls) {
    if (c.discarded) for (const t of [...c.targets, ...c.argumentTargets]) mark(t.id);
    if (c.owner) for (const t of [...c.targets, ...c.argumentTargets]) if (t.id) {
      if (!forward.has(c.owner.id)) forward.set(c.owner.id, new Set()); forward.get(c.owner.id).add(t.id);
    }
  }
  for (let i = 0; i < detachedQueue.length; i++) for (const id of forward.get(detachedQueue[i]) ?? []) mark(id);
  const occurrences = new Map();
  const sites = [];
  for (const c of calls) {
    const roots = [...new Set(c.targets.flatMap(t => [...t.roots ?? []]))].sort();
    if (!roots.length || (!c.discarded && !detached.has(c.owner?.id))) continue;
    const key = `${c.path}#${c.context}:${digest(c.expression).slice(0, 20)}`;
    const ordinal = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, ordinal);
    sites.push({ id: `${key}:${ordinal}`, path: c.path, line: c.line, context: c.context, expression: c.expression, roots, mode: c.discarded ? 'discarded' : 'detached-wrapper' });
  }
  return { schemaVersion: 1, files: [...files].map(([path, source]) => ({ path, sha256: digest(source) })), sites: sites.sort((a, b) => a.id.localeCompare(b.id)), gaps };
}

export function validateClassifications(census, records, seedIds = []) {
  const errors = census.gaps.map(g => `coverage gap: ${g.path}: ${g.message ?? g.kind}`);
  const byId = new Map();
  for (const r of records) {
    if (byId.has(r.id)) errors.push(`duplicate classification: ${r.id}`);
    byId.set(r.id, r);
    if (!['durable', 'safe-to-lose'].includes(r.classification) || !r.reason?.trim() || !r.path?.trim()) errors.push(`incomplete classification: ${r.id}`);
    if (r.classification === 'durable' && !r.durablePath?.trim()) errors.push(`missing durable path: ${r.id}`);
  }
  const active = new Set(census.sites.map(s => s.id));
  for (const s of census.sites) {
    const r = byId.get(s.id);
    if (!r) { errors.push(`unclassified: ${s.id}`); continue; }
    if (r.path !== s.path) errors.push(`path mismatch: ${s.id}`);
    if (r.classification === 'safe-to-lose' && (r.mandatory || /owner|human|escalat|grading|grader|lease.*expir|reap|approval|attention|alarm/i.test(`${s.path} ${s.expression} ${s.roots.join(' ')}`))) errors.push(`mandatory notice cannot be safe-to-lose: ${s.id}`);
  }
  for (const id of byId.keys()) if (!active.has(id)) errors.push(`stale classification (remove it): ${id}`);
  for (const id of seedIds) if (!byId.has(id) && active.has(id)) errors.push(`seed classification removed while site remains: ${id}`);
  return errors;
}

export function scanRepository(cwd = ROOT) {
  const tracked = listTrackedFiles(cwd);
  const coverage = coverageOf(tracked.files, cwd);
  const sources = {};
  const unreadable = [];
  for (const path of tracked.files.filter(inScope)) {
    try { sources[path] = readFileSync(resolve(cwd, path), 'utf8'); }
    catch (e) { unreadable.push({ path, kind: 'unreadable', message: e.message }); }
  }
  const census = censusSources(sources);
  census.gaps.push(...unreadable, ...coverage.unscannedPresent.map(path => ({ path, kind: 'unscanned-present' })));
  if (!census.files.length) census.gaps.push({ path: '.', kind: 'empty-source-population' });
  return { ...census, coverage, excluded: tracked.files.filter(p => /\.[cm]?[jt]sx?$/.test(p) && !inScope(p)), sourceDigest: digest(JSON.stringify(census.files)) };
}

function main() {
  const census = scanRepository();
  if (process.argv.includes('--list')) {
    console.log(process.argv.includes('--json') ? JSON.stringify(census, null, 2) : census.sites.map(s => `${s.id}\t${s.path}:${s.line}\t${s.roots.join(',')}`).join('\n'));
    if (census.gaps.length) process.exitCode = 2;
    return;
  }
  const registry = JSON.parse(readFileSync(new URL('./fire-and-forget-classification.json', import.meta.url), 'utf8'));
  const errors = validateClassifications(census, registry.records, registry.seedIds);
  console.log(JSON.stringify({ sites: census.sites.length, files: census.files.length, sourceDigest: census.sourceDigest, coverage: census.coverage, errors }));
  process.exitCode = errors.length ? 1 : 0;
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main();
