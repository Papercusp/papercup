#!/usr/bin/env node
/**
 * P-008: derive notification sites, then check curated delivery judgments.
 * Reuses the repository enumerator and TypeScript syntax tree; no runtime store.
 * --list --json is the reproducible seed, including source digests and gaps.
 * Scope: tracked JS/TS product source, including initialized submodules. Tests,
 * declarations, generated bundles and documentation are explicit exclusions.
 * This is conservative syntax/call-graph evidence, never delivery/restart proof.
 * Drift-stable (D-018): membership is judged only for the change under review
 * (--base <ref>, the window test:affected forwards, submodules included;
 * --files/--changed-paths/--files-from; else files changed since the seed pin);
 * --all restores the strict whole-tree verdict. See classificationReport.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coverageOf, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const digest = (s) => createHash('sha256').update(s).digest('hex');
const notificationName = (s) => /^(?:(?:notify|send|escalate)(?:$|[A-Z_])|(?:create|publish|push)Notification|(?:raise|create|emit)Escalation)/.test(s);
// Immutable genesis population: the records may shrink; new sites declare at source.
export const BASELINE_SEED_SHA256 = '77e7ce20ccd42b772d65e4c4fef328bf8706e9cc3675d088dd96d271b2d11a84';
const transparent = (n) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n)
  || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n);

export function inScope(path) {
  return /\.[cm]?[jt]sx?$/.test(path)
    && !/\.(?:d|test|spec|stories)\.[cm]?[jt]sx?$/.test(path)
    && !/(?:^|\/)(?:node_modules|\.git|\.papercusp|dist[^/]*|build|coverage|vendor|fixtures|__fixtures__|__tests__|test|tests|vitest-shims|e2e|docs|env-sidecars|storybook-static|\.astro|\.next|\.output|\.svelte-kit|out|target)(?:\/|$)/.test(path)
    && !path.startsWith('apps/operator-docs/');
}

function tokens(node, sourceFile) {
  // Reuse parser-resolved tokens. A standalone scan() does not resume template
  // tails or recognize regex literals in their expression context: it can hash
  // comments as template content and erase meaningful whitespace inside regexes.
  const out = [];
  function visit(token) {
    if (token.kind === ts.SyntaxKind.EndOfFileToken || token.kind === ts.SyntaxKind.JSDocComment) return;
    if (token.kind >= ts.SyntaxKind.FirstToken && token.kind <= ts.SyntaxKind.LastToken) {
      out.push(token.getText(sourceFile));
      return;
    }
    for (const child of token.getChildren(sourceFile)) visit(child);
  }
  visit(node);
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
  const manifests = new Map();
  const configs = new Map();
  for (const [path, source] of Object.entries(sources)) if (/(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(path)) {
    const parsed = ts.parseConfigFileTextToJson(path, source);
    if (parsed.error) { gaps.push({ path, kind: 'invalid-resolution-manifest' }); continue; }
    if (path.endsWith('package.json') && parsed.config.name) manifests.set(parsed.config.name, { dir: posix.dirname(path), data: parsed.config });
    if (path.endsWith('tsconfig.json')) configs.set(posix.dirname(path), parsed.config.compilerOptions ?? {});
  }
  let serial = 0;
  function symbol(name, scope) {
    const s = { id: ++serial, name, scope, edges: [], aliases: [], roots: new Set(), params: [] };
    symbols.set(s.id, s);
    return s;
  }
  const named = (scope, name) => ({ scope, name });
  const root = (name) => ({ root: name });
  function modulePath(from, specifier) {
    function candidate(base) {
      base = posix.normalize(base);
      const stem = base.replace(/\.[cm]?jsx?$/, '');
      return [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].flatMap(e => [stem + e, posix.join(base, 'index' + e)])].find(p => files.has(p)) ?? null;
    }
    if (specifier.startsWith('.')) return candidate(posix.join(posix.dirname(from), specifier));
    // Reuse source-owned paths/exports rather than a parallel hand-maintained map.
    const owner = [...configs].filter(([dir]) => dir === '.' || from.startsWith(dir + '/')).sort(([a], [b]) => b.length - a.length)[0];
    if (owner) for (const [pattern, paths] of Object.entries(owner[1].paths ?? {})) {
      const [prefix, suffix = ''] = pattern.split('*');
      if (!(pattern.includes('*') ? specifier.startsWith(prefix) && specifier.endsWith(suffix) : specifier === pattern)) continue;
      const part = specifier.slice(prefix.length, suffix.length ? -suffix.length : undefined);
      for (const p of paths) { const hit = candidate(posix.join(owner[0], owner[1].baseUrl ?? '.', p.replace('*', part))); if (hit) return hit; }
    }
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const pkg = manifests.get(name);
    if (!pkg) return null;
    const sub = specifier.slice(name.length).replace(/^\//, '');
    const key = sub ? './' + sub : '.';
    let entry = typeof pkg.data.exports === 'string' || !pkg.data.exports?.['.'] ? pkg.data.exports : pkg.data.exports[key];
    if (sub && pkg.data.exports && typeof pkg.data.exports === 'object') {
      entry = pkg.data.exports[key];
      if (!entry) for (const [pattern, value] of Object.entries(pkg.data.exports)) if (pattern.includes('*') && key.startsWith(pattern.split('*')[0]) && key.endsWith(pattern.split('*')[1])) {
        const middle = key.slice(pattern.split('*')[0].length, pattern.split('*')[1].length ? -pattern.split('*')[1].length : undefined);
        entry = JSON.parse(JSON.stringify(value).replaceAll('*', middle));
      }
    }
    const strings = v => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
    for (const p of [...strings(entry), ...(sub ? [sub, 'src/' + sub, 'lib/' + sub] : [pkg.data.source, pkg.data.module, pkg.data.main, 'src/index', 'lib/index', 'index'])].filter(Boolean)) {
      for (const variant of [p, p.replace(/^\.\/dist\//, './src/').replace(/\.d\.[cm]?ts$/, '.ts')]) {
        const hit = candidate(posix.join(pkg.dir, variant)); if (hit) return hit;
      }
    }
    return null;
  }
  let parsed = 0;
  for (const [path, source] of files) {
    if (process.env.NOTIFY_CENSUS_PROGRESS && parsed++ % 1000 === 0) console.error(`NOTIFY_CENSUS_PROGRESS parsed=${parsed - 1}/${files.size}`);
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lines = source.split('\n');
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
      if (ts.isStringLiteralLike(n)) return { literal: n.text };
      if (ts.isNumericLiteral(n) || ts.isBigIntLiteral(n) || ts.isPrefixUnaryExpression(n)
        || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword
        || n.kind === ts.SyntaxKind.NullKeyword) return { nonCallable: true };
      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        let s = scope; while (s && !s.classSymbol) s = s.parent;
        return s?.classSymbol ? { id: s.classSymbol.id } : null;
      }
      if (ts.isObjectLiteralExpression(n)) return objectIds.has(n) ? { id: objectIds.get(n).id } : null;
      if (ts.isFunctionLike(n)) return functionIds.get(n)?.id ? { id: functionIds.get(n).id } : null;
      if (ts.isPropertyAccessExpression(n)) return { base: ref(n.expression, scope), member: n.name.text };
      if (ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) return { base: ref(n.expression, scope), member: n.argumentExpression.text };
      if (ts.isElementAccessExpression(n) && n.argumentExpression) return { base: ref(n.expression, scope), memberRef: ref(n.argumentExpression, scope) };
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
        s.calls = [];
        s.hasRest = n.parameters.some(p => p.dotDotDotToken);
        if (n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exports.set(n.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : localName, { id: s.id });
        for (const p of n.parameters) if (p.initializer) visit(p.initializer, child);
        s.defaults = n.parameters.map(p => ({ present: !!p.initializer, ref: ref(p.initializer, child) }));
        // Defaults participate in the discovery graph just like supplied callback
        // arguments. Invocation refinement still substitutes an explicit caller's
        // value, but discovery and conservative fallback must include omitted ones.
        s.defaults.forEach((fallback, i) => {
          if (fallback.ref && s.params[i]) {
            s.params[i].edges.push(fallback.ref);
            s.params[i].aliases.push(fallback.ref);
          }
        });
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
        const annotations = lines.slice(Math.max(0, line - 4), line).join('\n').matchAll(/notify-classification:\s*(\{[^\n]*\})/g);
        const declarations = [];
        for (const annotation of annotations) {
          try { declarations.push(JSON.parse(annotation[1])); }
          catch { gaps.push({ path, kind: 'invalid-classification-json', offset: n.getStart(sf) }); }
        }
        const call = { index: calls.length, path, line, owner: scope.owner, context: scope.label, callee, args, declarations, discarded: discarded(n), expression: tokens(n, sf) };
        calls.push(call);
        if (scope.owner) { scope.owner.edges.push(callee); scope.owner.calls.push(call); }
      }
    }
    visit(sf, top);
  }
  // A branch needs an independent visited path, but copying all its ancestors
  // makes deep member/import aliases allocate cubic numbers of Set entries.
  // Roll back only additions made by this branch; sibling and cycle semantics
  // remain identical to resolving against a copy of the incoming set.
  function branchTargets(r, seen, context, trail) {
    const checkpoint = trail.length;
    try { return targets(r, seen, context, trail); }
    finally { while (trail.length > checkpoint) seen.delete(trail.pop()); }
  }
  function targets(r, seen = new Set(), context = null, trail = []) {
    if (!r || seen.has(r)) return [];
    seen.add(r); trail.push(r);
    // Primitive defaults are supported values, but never callback targets.
    // Keep computed keys conservative rather than guessing a property name.
    if (r.nonCallable) return [];
    if (r.literal !== undefined) return [{ literal: r.literal }];
    if (r.id) {
      if (context?.has(r.id)) {
        const bound = context.get(r.id);
        return targets(bound.ref, seen, bound.context, trail);
      }
      const s = symbols.get(r.id);
      if (!s || seen.has(`id:${r.id}`)) return [];
      seen.add(`id:${r.id}`); trail.push(`id:${r.id}`);
      return [context ? { ...s, boundContext: context } : s, ...s.aliases.flatMap(a => targets(a, seen, context, trail))];
    }
    if (r.root) return [{ roots: new Set([r.root]) }];
    if (r.module !== undefined) {
      const key = `module:${r.module}:${r.name}`;
      if (seen.has(key)) return [];
      seen.add(key); trail.push(key);
      const m = modules.get(r.module);
      if (r.name === '*') return [{ module: m }];
      return [...targets(m?.exports.get(r.name), seen, context, trail), ...(m?.stars ?? []).flatMap(s => targets({ ...s, name: r.name }, seen, context, trail)), ...(notificationName(r.name) ? targets(root(r.name), seen, context, trail) : [])];
    }
    if (r.memberRef !== undefined) {
      const keys = branchTargets(r.memberRef, seen, context, trail).map(t => t.literal).filter(k => k !== undefined);
      // Unknown computed dispatch is included conservatively, never silently clean.
      return keys.length ? keys.flatMap(member => branchTargets({ base: r.base, member }, seen, context, trail)) : [{ roots: new Set(['<unresolved-computed-dispatch>']) }];
    }
    if (r.member) {
      const bases = targets(r.base, seen, context, trail);
      if (/^(call|apply|bind)$/.test(r.member)) return bases;
      return [...bases.flatMap(b => b.module ? [...branchTargets(b.module.exports.get(r.member), seen, context, trail), ...b.module.stars.flatMap(s => branchTargets({ ...s, name: r.member }, seen, context, trail))] : b.members?.has(r.member) ? branchTargets({ id: b.members.get(r.member).id }, seen, b.boundContext ?? context, trail) : []), ...(notificationName(r.member) ? targets(root(r.member), seen, context, trail) : [])];
    }
    let scope = r.scope;
    while (scope && !scope.names.has(r.name)) scope = scope.parent;
    return [...(scope ? targets({ id: scope.names.get(r.name).id }, seen, context, trail) : []), ...(notificationName(r.name) ? targets(root(r.name), seen, context, trail) : [])];
  }
  // Parameter injection also reveals wrappers whose names contain no notify token.
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS graph symbols=${symbols.size} calls=${calls.length}`);
  for (const c of calls) for (const target of targets(c.callee)) c.args.forEach((a, i) => { if (target.params?.[i]) { target.params[i].edges.push(a); target.params[i].aliases.push(a); } });
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS injected at=${Date.now()}`);
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
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS linked at=${Date.now()} rooted=${queue.length}`);
  const queued = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; queued.delete(id);
    for (const receiver of reverse.get(id) ?? []) {
      const s = symbols.get(receiver); let changed = false;
      for (const r of symbols.get(id).roots) if (!s.roots.has(r)) { s.roots.add(r); changed = true; }
      if (changed && !queued.has(receiver)) { queued.add(receiver); queue.push(receiver); }
    }
  }
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS propagated at=${Date.now()}`);
  for (const c of calls) { c.targets = targets(c.callee); c.argumentTargets = c.args.flatMap(a => targets(a)); }
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS resolved at=${Date.now()}`);
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

  // Keep the global graph for discovery and conservative fallback, but do not
  // reuse its union of every caller's callback arguments as a call's own roots.
  // Bind arguments at each invocation, including the lexical context of forwarded
  // closures. Unsupported signatures, recursion and exhausted work budgets retain
  // the original roots instead of silently certifying a path as notification-free.
  const globalRoots = c => [...new Set(c.targets.flatMap(t => [...t.roots ?? []]))];
  function callRoots(c, context = new Map(), visiting = new Set(), budget = { remaining: 256 }) {
    const conservativeRoots = globalRoots(c);
    // Root-free calls cannot change this refinement. Do not spend the bounded
    // context work on them: a long read-only prefix must not force a later
    // callback to fall back to the union of unrelated callers' notice roots.
    if (!conservativeRoots.length) return [];
    if (--budget.remaining < 0 || visiting.size >= 24 || /^(call|apply|bind)$/.test(c.callee?.member ?? '')) return conservativeRoots;
    const roots = new Set();
    for (const t of targets(c.callee, new Set(), context)) {
      if (!t.id) { for (const r of t.roots ?? []) roots.add(r); continue; }
      if (!t.calls) {
        // Alias targets are also returned above. Their globally propagated roots
        // would reintroduce the caller union we are deliberately substituting.
        if (!t.aliases.length) for (const r of t.roots) roots.add(r);
        continue;
      }
      // Re-entering a shared wrapper from a different callsite can carry an
      // entirely different callback. Only a repeated callsite/callee pair is
      // a cycle; function identity alone imports unrelated callers' roots.
      const invocation = `${c.index}:${t.id}`;
      if (visiting.has(invocation) || t.hasRest || t.params.some(p => !p)) {
        for (const r of t.roots) roots.add(r);
        continue;
      }
      const bound = new Map(t.boundContext ?? context);
      let unsupported = false;
      t.params.forEach((p, i) => {
        const value = c.args[i];
        const fallback = t.defaults[i];
        if (value) {
          bound.set(p.id, { ref: value, context });
          // An unresolved argument can be undefined and select the default.
          // Only a resolved callback can rule out a rooted default safely.
          if (fallback?.present
            && !targets(value, new Set(), context).some(t => t.calls || t.roots?.size)
            && targets(fallback.ref, new Set(), bound).some(t => t.roots?.size)) unsupported = true;
        }
        else if (fallback?.present) {
          if (!fallback.ref) unsupported = true;
          else bound.set(p.id, { ref: fallback.ref, context: bound });
        } else bound.set(p.id, { ref: null, context });
      });
      if (unsupported) { for (const r of t.roots) roots.add(r); continue; }
      const nested = new Set(visiting); nested.add(invocation);
      for (const call of t.calls) for (const r of callRoots(call, bound, nested, budget)) roots.add(r);
    }
    return [...roots];
  }
  const occurrences = new Map();
  const sites = [];
  let refined = 0;
  for (const c of calls) {
    // This pass refines existing candidates; the global graph remains the
    // discovery authority. Do not recursively revisit the much larger clean
    // population or calls whose custody never becomes detached.
    if (!c.targets.some(t => t.roots?.size) || (!c.discarded && !detached.has(c.owner?.id))) continue;
    if (process.env.NOTIFY_CENSUS_PROGRESS && refined++ % 10000 === 0) console.error(`NOTIFY_CENSUS_PROGRESS refined=${refined - 1} at=${Date.now()}`);
    const roots = callRoots(c).sort();
    if (!roots.length || (!c.discarded && !detached.has(c.owner?.id))) continue;
    const key = `${c.path}#${c.context}:${digest(c.expression).slice(0, 20)}`;
    const ordinal = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, ordinal);
    const id = `${key}:${ordinal}`;
    // Resolve exact IDs after occurrence assignment, so neighboring declarations
    // cannot shadow one another or leak to nested calls. Preserve legacy unscoped
    // declarations only when no exact declaration names this site.
    const declaration = c.declarations.find(d => d?.id === id) ?? c.declarations.find(d => d && !d.id);
    sites.push({ id, path: c.path, line: c.line, context: c.context, expression: c.expression, roots, mode: c.discarded ? 'discarded' : 'detached-wrapper', ...(declaration ? { declaration } : {}) });
  }
  const resolutionFiles = Object.entries(sources).filter(([p]) => /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(p));
  return { schemaVersion: 1, files: [...files, ...resolutionFiles].map(([path, source]) => ({ path, sha256: digest(source) })).sort((a,b) => a.path.localeCompare(b.path)), sites: sites.sort((a, b) => a.id.localeCompare(b.id)), gaps };
}

/**
 * D-018 drift-stable scope. Census membership follows whole-program call-graph
 * roots, so a byte-identical file can gain or lose sites when OTHER files change.
 * Membership verdicts (unclassified, stale) are judged only for files in the change
 * under review; a membership finding in any other file is DRIFT, reported in full
 * but not failing. Registry integrity, coverage, the mandatory-notice safety gate
 * and removed seed records stay global: drift cannot cause the first three, and a
 * missing seed record for a live site is a registry edit that would otherwise drop
 * a judgment silently (restore the seed record). `judged` is a Set of repo-relative
 * paths, or null to judge every file (the pre-D-018 strict verdict). Every path
 * under a `judgedSubtrees` prefix is judged too (a submodule whose base could not
 * be compared; see changedSinceBase).
 */
export function classificationReport(census, records, seedIds = [], { judged = null, judgedSubtrees = [] } = {}) {
  const isJudged = path => judged === null || !path || judged.has(path)
    || judgedSubtrees.some(prefix => path.startsWith(`${prefix}/`));
  const drift = { unclassified: [], stale: [] };
  const errors = census.gaps.map(g => `coverage gap: ${g.path}: ${g.message ?? g.kind}`);
  const byId = new Map();
  for (const r of records) {
    if (byId.has(r.id)) errors.push(`duplicate classification: ${r.id}`);
    byId.set(r.id, r);
    if (!['durable', 'safe-to-lose'].includes(r.classification) || !r.reason?.trim() || !r.path?.trim()) errors.push(`incomplete classification: ${r.id}`);
    if (r.classification === 'durable' && !r.durablePath?.trim()) errors.push(`missing durable path: ${r.id}`);
  }
  const active = new Set(census.sites.map(s => s.id));
  if (active.size !== census.sites.length) errors.push('duplicate census site ID');
  for (const s of census.sites) {
    const r = byId.get(s.id);
    if (!r) { if (isJudged(s.path)) errors.push(`unclassified: ${s.id}`); else drift.unclassified.push(s.id); continue; }
    if (r.path !== s.path) errors.push(`path mismatch: ${s.id}`);
    if (r.classification === 'safe-to-lose' && (r.mandatory || /owner|human|escalat|grading|grader|lease.*expir|reap|approval|attention|alarm/i.test(`${s.path} ${s.expression} ${s.roots.join(' ')}`))) errors.push(`mandatory notice cannot be safe-to-lose: ${s.id}`);
  }
  for (const [id, r] of byId) if (!active.has(id)) {
    if (isJudged(r.path)) errors.push(`stale classification (remove it): ${id}`); else drift.stale.push(id);
  }
  for (const id of seedIds) if (!byId.has(id) && active.has(id)) errors.push(`seed classification removed while site remains: ${id}`);
  return { errors, drift };
}

export function validateClassifications(census, records, seedIds = [], options = {}) {
  return classificationReport(census, records, seedIds, options).errors;
}

/** Paths whose content differs from the registry's seed pin; new and deleted files differ. */
export function changedSinceSeed(census, seedFiles) {
  const pinned = new Map(seedFiles.map(f => [f.path, f.sha256]));
  const changed = new Set(census.files.filter(f => pinned.get(f.path) !== f.sha256).map(f => f.path));
  const present = new Set(census.files.map(f => f.path));
  for (const path of pinned.keys()) if (!present.has(path)) changed.add(path);
  return changed;
}

function gitOut(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}
const nulFields = text => (text ?? '').split('\0').filter(Boolean);

/** Gitlink path -> commit in `treeish` (ls-tree), or in the index when treeish is null. */
function gitlinksOf(cwd, treeish) {
  const out = treeish ? gitOut(cwd, ['ls-tree', '-r', '-z', treeish]) : gitOut(cwd, ['ls-files', '--stage', '-z']);
  const links = new Map();
  for (const entry of nulFields(out)) {
    const tab = entry.indexOf('\t');
    // ls-tree: "<mode> <type> <object>"; ls-files --stage: "<mode> <object> <stage>".
    const [mode, second, third] = entry.slice(0, tab).split(' ');
    if (mode === '160000') links.set(entry.slice(tab + 1), treeish ? third : second);
  }
  return links;
}

/** An empty, uninitialized submodule directory would otherwise run git in the parent repository. */
function ownsWorktree(dir) {
  const top = gitOut(dir, ['rev-parse', '--show-toplevel'])?.trim();
  try { return Boolean(top) && realpathSync(top) === realpathSync(dir); } catch { return false; }
}

/**
 * D-018 window: every path that differs between `base` and the working tree. A
 * superproject diff names a submodule only by its gitlink path, which no census
 * file carries, so each submodule is diffed inside its own repository against the
 * gitlink its parent records at the parent's base, recursively. A submodule that
 * cannot be compared (added or removed since base, not initialized, or its base
 * commit is not in its object store) is judged whole: its prefix is in `subtrees`.
 * Throws when `base` does not resolve: a silently empty window would judge nothing.
 */
export function changedSinceBase(base, root = ROOT) {
  const baseSha = gitOut(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`])?.trim();
  if (!baseSha) throw new Error(`--base ${base} does not resolve to a commit in ${root}; the judged window is unknown`);
  const files = new Set();
  const subtrees = [];
  const visit = (dir, prefix, repoBase) => {
    const diff = gitOut(dir, ['diff', '--name-only', '--no-renames', '-z', repoBase]);
    if (diff === null) throw new Error(`git diff ${repoBase} failed in ${dir}; the judged window is unknown`);
    const now = gitlinksOf(dir, null);
    const then = gitlinksOf(dir, repoBase);
    for (const path of nulFields(diff)) if (!now.has(path) && !then.has(path)) files.add(prefix + path);
    for (const path of new Set([...now.keys(), ...then.keys()])) {
      const sub = resolve(dir, path);
      const subBase = then.get(path);
      if (!now.has(path) || !subBase || !ownsWorktree(sub) || gitOut(sub, ['cat-file', '-e', `${subBase}^{commit}`]) === null) {
        subtrees.push(prefix + path);
        continue;
      }
      visit(sub, `${prefix}${path}/`, subBase);
    }
  };
  visit(root, '', baseSha);
  return { baseSha, files, subtrees: subtrees.sort() };
}

/**
 * The change under review. --files/--changed-paths take a comma list; --files-from
 * takes a JSON array or a newline list; --base <ref> judges every path changed since
 * that commit, submodules included (what test:affected forwards: forwardBase, not
 * forwardChangedPaths, whose superproject paths name a submodule change only by its
 * gitlink). Listed paths and a base window combine as a union. --all judges every
 * file. Otherwise the change is every path that differs from the registry's seed
 * pin. A registry with no seed pin cannot scope, so it is strict.
 */
export function resolveJudgedScope(argv, { census, seedFiles, root = ROOT }) {
  if (argv.includes('--all')) return { mode: 'all', judged: null, subtrees: [] };
  const normalize = (p) => {
    const path = String(p).trim();
    return (path.startsWith(root) ? path.slice(root.length) : path).replace(/^\.?\//, '');
  };
  const listed = [];
  let explicit = false;
  let base = null;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--base') { base = String(inline ?? argv[++i] ?? '').trim(); continue; }
    if (!['--files', '--changed-paths', '--files-from'].includes(flag)) continue;
    explicit = true;
    const value = inline ?? argv[++i] ?? '';
    if (flag !== '--files-from') { listed.push(...value.split(',')); continue; }
    const text = readFileSync(value, 'utf8');
    listed.push(...(text.trimStart().startsWith('[') ? JSON.parse(text) : text.split('\n')));
  }
  const listedPaths = listed.map(normalize).filter(Boolean);
  if (base !== null) {
    if (!base) throw new Error('--base needs a commit-ish; the judged window is unknown');
    const window = changedSinceBase(base, root);
    return { mode: 'base', base, baseSha: window.baseSha, judged: new Set([...window.files, ...listedPaths]), subtrees: window.subtrees };
  }
  if (explicit) return { mode: 'changed-paths', judged: new Set(listedPaths), subtrees: [] };
  if (!Array.isArray(seedFiles) || !seedFiles.length) return { mode: 'all', judged: null, subtrees: [] };
  return { mode: 'seed-pin', judged: changedSinceSeed(census, seedFiles), subtrees: [] };
}

export function validateSeed(registry, expectedHash = BASELINE_SEED_SHA256) {
  const ids = registry.seedIds;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || digest(JSON.stringify([...ids].sort())) !== expectedHash) return ['baseline seed changed; preserve the --list genesis population'];
  const seed = new Set(ids);
  return registry.records.filter(r => !seed.has(r.id)).map(r => `baseline grew: ${r.id}; classify the new site at source instead`);
}

export function inlineClassifications(census) {
  return census.sites.filter(s => s.declaration).map(s => ({ ...s.declaration, id: s.id, path: s.path }));
}

/**
 * A conservative policy seed, NOT a claim that delivery already is durable.
 * P-009 must verify the terminal consequence; wrapper records share that path,
 * never require one additional workflow per wrapper invocation. Lossy exemptions
 * need a specific reviewed reason and must still pass the mandatory-notice gate.
 */
export function seedClassifications(census) {
  if (census.gaps.length || !census.files.length || census.sourceDigest !== digest(JSON.stringify(census.files))) throw new Error('Refusing to seed an incomplete or unpinned census');
  const seedIds = census.sites.map(s => s.id).sort();
  if (new Set(seedIds).size !== seedIds.length) throw new Error('Refusing duplicate census site IDs');
  return {
    schemaVersion: 1,
    policy: 'Durable is a requirement. Delivery is UNVERIFIED until P-009 proves the terminal path; wrappers share that path, not separate workflows. No safe-to-lose exemption is inferred from a name.',
    seedSourceDigest: census.sourceDigest,
    seedCensusDigest: digest(JSON.stringify(census)),
    seedFiles: census.files,
    seedCoverage: census.coverage,
    seedIds,
    records: census.sites.map(s => ({
      id: s.id, path: s.path, classification: 'durable',
      reason: `No safe-to-lose proof recorded. This call reaches ${s.roots.slice(0, 6).join(', ')}; retain its terminal delivery obligation, including through aliases/wrappers.`,
      durablePath: 'UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009',
      deliveryState: 'unverified',
    })),
  };
}

export function scanRepository(cwd = ROOT) {
  const tracked = listTrackedFiles(cwd);
  const coverage = coverageOf(tracked.files, cwd);
  const sources = {};
  const unreadable = [];
  for (const path of tracked.files.filter(p => inScope(p) || /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(p) && !/(?:^|\/)(?:node_modules|env-sidecars|dist[^/]*|storybook-static|\.papercusp)(?:\/|$)/.test(p))) {
    try { sources[path] = readFileSync(resolve(cwd, path), 'utf8'); }
    catch (e) { unreadable.push({ path, kind: 'unreadable', message: e.message }); }
  }
  const census = censusSources(sources);
  census.gaps.push(...unreadable, ...coverage.unscannedPresent.map(path => ({ path, kind: 'unscanned-present' })));
  if (!census.files.length) census.gaps.push({ path: '.', kind: 'empty-source-population' });
  return { ...census, coverage, excluded: tracked.files.filter(p => /\.[cm]?[jt]sx?$/.test(p) && !inScope(p)), sourceDigest: digest(JSON.stringify(census.files)) };
}

function main() {
  const seedFrom = process.argv.indexOf('--seed-from');
  if (seedFrom !== -1) {
    const seed = seedClassifications(JSON.parse(readFileSync(process.argv[seedFrom + 1], 'utf8')));
    console.log(JSON.stringify(seed, null, 2));
    console.error(`NOTIFY_BASELINE_SEED_SHA256=${digest(JSON.stringify(seed.seedIds))}`);
    return;
  }
  const census = scanRepository();
  if (process.argv.includes('--list')) {
    console.log(process.argv.includes('--json') ? JSON.stringify(census, null, 2) : census.sites.map(s => `${s.id}\t${s.path}:${s.line}\t${s.roots.join(',')}`).join('\n'));
    if (census.gaps.length) process.exitCode = 2;
    return;
  }
  const registry = JSON.parse(readFileSync(new URL('./fire-and-forget-classification.json', import.meta.url), 'utf8'));
  let scope;
  try { scope = resolveJudgedScope(process.argv.slice(2), { census, seedFiles: registry.seedFiles }); }
  catch (e) {
    // Fail closed: an unknown window must never pass by judging nothing.
    console.error(`fire-and-forget classification NOT CHECKED: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const report = classificationReport(census, [...registry.records, ...inlineClassifications(census)], registry.seedIds, { judged: scope.judged, judgedSubtrees: scope.subtrees });
  const errors = [...validateSeed(registry), ...report.errors];
  const drift = { note: 'membership changes in files outside the judged change (D-018); reported, not failing', unclassifiedCount: report.drift.unclassified.length, staleCount: report.drift.stale.length, ...report.drift };
  const judged = { mode: scope.mode, ...(scope.baseSha ? { base: scope.base, baseSha: scope.baseSha } : {}), files: scope.judged ? scope.judged.size : census.files.length, subtrees: scope.subtrees };
  console.log(JSON.stringify({ scope: 'classification guard; not a durable-delivery verdict', judged, sites: census.sites.length, files: census.files.length, sourceDigest: census.sourceDigest, coverage: census.coverage, unverifiedDurable: registry.records.filter(r => r.classification === 'durable' && r.deliveryState !== 'verified').length, drift, errors }));
  process.exitCode = errors.length ? 1 : 0;
}
// Bundling changes import.meta.url to the host entrypoint. URL equality alone
// would then run this CLI while the host imports its reusable census functions.
if (process.argv[1] && basename(process.argv[1]) === 'check-fire-and-forget-classification.mjs'
  && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main();
