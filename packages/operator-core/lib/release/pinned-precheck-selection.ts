/** Pinned, conservative proof that an implicit test is excluded by its root Vitest route. */
import ts from 'typescript';
import type { PinnedPrecheckSelection, PinnedTestExclusion } from './precheck-selection';
export { pinnedSelectionPage } from './precheck-selection';
export type { PinnedPrecheckSelection, PinnedTestExclusion } from './precheck-selection';

export interface PinnedSelectionFile { sha: string; content: string | null }

function source(text: string): ts.SourceFile {
  return ts.createSourceFile('pinned-config.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function declarations(file: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const statement of file.statements) if (ts.isVariableStatement(statement)) {
    for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
  }
  return out;
}
function assertUnescapedBindings(file: ts.SourceFile, names: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const p = node.parent;
      if (!((ts.isVariableDeclaration(p) && p.name === node) ||
          (ts.isSpreadElement(p) && p.expression === node) || (ts.isSpreadAssignment(p) && p.expression === node) ||
          (ts.isPropertyAssignment(p) && p.initializer === node))) throw new Error('pinned policy binding escapes or mutates: ' + node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
function key(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
}
function resolve(node: ts.Expression, vars: Map<string, ts.Expression>, seen = new Set<string>()): ts.Expression {
  node = unwrap(node);
  if (!ts.isIdentifier(node)) return node;
  if (seen.has(node.text) || !vars.has(node.text)) throw new Error('unknown pinned declaration');
  seen.add(node.text);
  return resolve(vars.get(node.text)!, vars, seen);
}
function strings(node: ts.Expression, vars: Map<string, ts.Expression>): string[] {
  node = resolve(node, vars);
  if (!ts.isArrayLiteralExpression(node)) throw new Error('non-literal pinned array');
  return node.elements.flatMap(element => {
    if (ts.isSpreadElement(element)) return strings(element.expression, vars);
    if (!ts.isStringLiteralLike(element)) throw new Error('dynamic pinned string');
    return [element.text];
  });
}
function property(node: ts.Expression, name: string, vars: Map<string, ts.Expression>, safeCalls = new Set<string>()): ts.Expression | undefined {
  node = resolve(node, vars);
  if (name === 'exclude' && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && safeCalls.has(node.expression.text)) return undefined;
  if (ts.isConditionalExpression(node)) {
    const yes = property(node.whenTrue, name, vars, safeCalls), no = property(node.whenFalse, name, vars, safeCalls);
    if (!yes && !no) return undefined;
    throw new Error('conditional pinned property: ' + name);
  }
  if (!ts.isObjectLiteralExpression(node)) throw new Error('non-literal pinned object for ' + name + ': ' + ts.SyntaxKind[node.kind]);
  for (const p of [...node.properties].reverse()) {
    if (ts.isSpreadAssignment(p)) { const value = property(p.expression, name, vars, safeCalls); if (value) return value; }
    else if (ts.isPropertyAssignment(p) && key(p.name) === name) return p.initializer;
    else if (p.name && key(p.name) === name) throw new Error('unsupported pinned property: ' + name);
    else if (!p.name || key(p.name) === undefined) throw new Error('dynamic pinned property');
  }
  return undefined;
}
function protectedRoots(text: string, names: string[], field: string): string[] {
  const vars = declarations(source(text));
  return names.flatMap(name => {
    const array = resolve(vars.get(name)!, vars);
    if (!ts.isArrayLiteralExpression(array)) throw new Error('unknown pinned runner registry');
    return array.elements.map(row => {
      const value = property(row as ts.Expression, field, vars);
      if (!value || !ts.isStringLiteralLike(unwrap(value))) throw new Error('dynamic pinned runner root');
      return (unwrap(value) as ts.StringLiteral).text.replace(/^\.\//, '').replace(/\/$/, '') + '/';
    });
  });
}
function imported(file: ts.SourceFile): Map<string, { name: string; from: string }> {
  const out = new Map<string, { name: string; from: string }>();
  for (const s of file.statements) if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const b of bindings.elements) out.set(b.name.text,
      { name: b.propertyName?.text ?? b.name.text, from: s.moduleSpecifier.text });
  }
  return out;
}
function returned(file: ts.SourceFile, name: string): ts.Expression[] {
  const fn = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!fn?.body) throw new Error('missing pinned config factory');
  const results: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (!node.expression) throw new Error('empty config return');
      results.push(node.expression);
    } else ts.forEachChild(node, visit);
  };
  visit(fn.body);
  if (!results.length) throw new Error('unknown config return');
  return results;
}
function routerConfigPatterns(text: string): RegExp[] {
  const file = source(text), vars = declarations(file);
  const patterns = returned(file, 'configsIn').flatMap(expression => {
    const node = unwrap(expression);
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) return [];
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'filter')
      throw new Error('unknown pinned config discovery');
    const read = node.expression.expression, filter = node.arguments[0];
    if (!ts.isCallExpression(read) || !ts.isIdentifier(read.expression) || read.expression.text !== 'readdirSync' ||
        !filter || !ts.isArrowFunction(filter) || filter.parameters.length !== 1 || !ts.isIdentifier(filter.parameters[0]!.name) ||
        ts.isBlock(filter.body)) throw new Error('unknown pinned config discovery filter');
    const parameter = filter.parameters[0]!.name.text;
    const parse = (predicate: ts.Expression): RegExp[] => {
      predicate = unwrap(predicate);
      if (ts.isBinaryExpression(predicate) && predicate.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        return [...parse(predicate.left), ...parse(predicate.right)];
      if (!ts.isCallExpression(predicate) || !ts.isPropertyAccessExpression(predicate.expression) ||
          predicate.expression.name.text !== 'test' || predicate.arguments.length !== 1 ||
          !ts.isIdentifier(predicate.arguments[0]!) || predicate.arguments[0]!.text !== parameter)
        throw new Error('unknown pinned config discovery predicate');
      const regex = resolve(predicate.expression.expression, vars);
      if (!ts.isRegularExpressionLiteral(regex)) throw new Error('dynamic pinned config pattern');
      const end = regex.text.lastIndexOf('/');
      return [new RegExp(regex.text.slice(1, end), regex.text.slice(end + 1))];
    };
    return parse(filter.body);
  });
  if (!patterns.length) throw new Error('missing pinned config discovery patterns');
  return patterns;
}
function objectReturn(node: ts.Expression): ts.ObjectLiteralExpression {
  node = unwrap(node);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineConfig' && node.arguments[0]) node = unwrap(node.arguments[0]);
  if (!ts.isObjectLiteralExpression(node)) throw new Error('unknown config return object');
  return node;
}
/** Prove which pinned inputs reach every returned exclusion array. */
function factoryExclusionSources(shared: ts.SourceFile, name: string): { base: boolean; options: boolean } {
  const arrays = returned(shared, name).map(expression => {
    const object = objectReturn(expression);
    const vars = declarations(shared);
    const test = name === 'defineVitestConfig' ? property(object, 'test', vars) : object;
    if (!test) throw new Error('missing pinned test configuration');
    const excludes = property(test, 'exclude', vars, new Set(workerCapCannotExclude(shared) ? ['sharedHostWorkerCap'] : []));
    if (!excludes || !ts.isArrayLiteralExpression(unwrap(excludes))) throw new Error('unknown pinned exclusion array');
    return unwrap(excludes) as ts.ArrayLiteralExpression;
  });
  const base = arrays.every(array => array.elements.some(e => ts.isSpreadElement(e) &&
    ts.isIdentifier(e.expression) && e.expression.text === 'baseExclude'));
  const fn = shared.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  const parameter = fn?.parameters[0];
  if (name !== 'gateParticipationConfig' || !parameter || !ts.isIdentifier(parameter.name)) return { base, options: false };
  const parameterName = parameter.name.text;
  const reads = new Set<ts.PropertyAccessExpression>();
  const options = arrays.every(array => array.elements.some(e => {
    if (!ts.isSpreadElement(e)) return false;
    const node = unwrap(e.expression);
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return false;
    const left = unwrap(node.left), right = unwrap(node.right);
    if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression) || left.expression.text !== parameterName ||
        left.name.text !== 'exclude' || !ts.isArrayLiteralExpression(right) || right.elements.length !== 0) return false;
    reads.add(left);
    return true;
  }));
  let unescaped = true;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === parameterName && node !== parameter.name) {
      const parent = node.parent;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node ||
          (parent.name.text === 'exclude' && !reads.has(parent))) unescaped = false;
    }
    ts.forEachChild(node, visit);
  };
  if (fn?.body) visit(fn.body);
  return { base, options: options && unescaped };
}
function workerCapCannotExclude(shared: ts.SourceFile): boolean {
  const safe = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (ts.isConditionalExpression(node)) return safe(node.whenTrue) && safe(node.whenFalse);
    return ts.isObjectLiteralExpression(node) && node.properties.every(p => ts.isPropertyAssignment(p) && key(p.name) !== undefined && key(p.name) !== 'exclude');
  };
  return returned(shared, 'sharedHostWorkerCap').every(safe);
}
function rootExcludes(text: string, sharedText: string): string[] {
  const file = source(text), vars = declarations(file), imports = imported(file), shared = source(sharedText);
  assertUnescapedBindings(shared, new Set(['baseExclude']));
  assertUnescapedBindings(file, new Set([...vars].filter(([, value]) => {
    const node = unwrap(value);
    return ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) ||
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imports.get(node.expression.text)?.name === 'gateParticipationConfig');
  }).map(([name]) => name)));
  const base = strings(declarations(shared).get('baseExclude')!, declarations(shared));
  const configCall = (node: ts.Expression): string[] | undefined => {
    node = resolve(node, vars);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = imports.get(node.expression.text);
      if (binding?.from === '@papercusp/test-config/vitest-config') {
        if (binding.name === 'sharedHostWorkerCap' && workerCapCannotExclude(shared)) return undefined;
        if (binding.name === 'gateParticipationConfig' || binding.name === 'defineVitestConfig') {
          const sources = factoryExclusionSources(shared, binding.name);
          if (!sources.base && !sources.options) throw new Error('unproved pinned exclusion sources');
          const extra = node.arguments[0] && property(node.arguments[0], 'exclude', vars);
          return [...(sources.base ? base : []), ...(sources.options && extra ? strings(extra, vars) : [])];
        }
      }
      if (binding?.from === 'vitest/config' && binding.name === 'defineConfig' && node.arguments[0]) {
        const test = property(node.arguments[0], 'test', vars);
        if (test) return configCall(test);
      }
      throw new Error('unknown pinned config call: ' + node.expression.text);
    }
    if (!ts.isObjectLiteralExpression(node)) throw new Error('unknown pinned test config');
    let patterns: string[] | undefined;
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) patterns = configCall(p.expression) ?? patterns;
      else if (ts.isPropertyAssignment(p) && key(p.name) === 'exclude') patterns = strings(p.initializer, vars);
      else if (p.name && key(p.name) === 'exclude') throw new Error('unsupported pinned property: exclude');
      else if (!p.name || key(p.name) === undefined) throw new Error('unknown pinned test property');
    }
    return patterns;
  };
  const exported = file.statements.find((s): s is ts.ExportAssignment => ts.isExportAssignment(s) && !s.isExportEquals);
  return exported ? configCall(exported.expression) ?? [] : [];
}

/** Unknown ownership/configuration retains the test. Only whole directory-segment globs are proved here. */
export function pinnedImplicitTestExclusions(input: {
  commit: string;
  files: ReadonlyMap<string, PinnedSelectionFile>;
  tests: readonly string[];
  explicitTests: readonly string[];
}): PinnedPrecheckSelection {
  const excluded: PinnedTestExclusion[] = [];
  const selection: PinnedPrecheckSelection = { schemaVersion: 1, commit: input.commit, excluded };
  const router = 'scripts/test-files.mjs', registry = 'libs/test-config/src/execution-details.ts', shared = 'libs/test-config/src/vitest-config.ts';
  try {
    const read = (path: string): string => {
      const text = input.files.get(path)?.content;
      if (text == null) throw new Error('unavailable pinned source: ' + path);
      return text;
    };
    const roots = [...protectedRoots(read(router), ['NON_WORKSPACE_VITEST_ROUTES', 'NON_WORKSPACE_NODE_ROUTES'], 'prefix'),
      ...protectedRoots(read(registry), ['REGISTERED_VITEST_FILE_PROJECTS'], 'root')];
    const configPatterns = routerConfigPatterns(read(router));
    const configDirectories = new Set([...input.files.keys()].filter(file => configPatterns.some(pattern => {
      pattern.lastIndex = 0;
      return pattern.test(file.split('/').at(-1)!);
    }))
      .map(file => file.split('/').slice(0, -1).join('/')));
    const packageOwnership = new Map<string, boolean>();
    for (const [path, file] of input.files) if (path.endsWith('/package.json')) {
      let owns = file.content == null;
      if (file.content != null) {
        try { owns = /\bvitest\b/.test(JSON.parse(file.content)?.scripts?.test ?? ''); }
        catch { owns = true; }
      }
      packageOwnership.set(path.slice(0, -'/package.json'.length), owns);
    }
    const cache = new Map<string, string[]>();
    for (const path of [...new Set(input.tests)].sort()) {
      if (input.explicitTests.some(explicit => path === explicit || path.endsWith('/' + explicit))) continue;
      if (roots.some(prefix => path.startsWith(prefix))) continue;
      const parts = path.split('/');
      let owned = false;
      for (let i = parts.length - 1; i > 0; i--) {
        const dir = parts.slice(0, i).join('/');
        if (configDirectories.has(dir)) { owned = true; break; }
        if (packageOwnership.get(dir)) { owned = true; break; }
      }
      if (owned) continue;
      const config = /\.integration\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ? 'vitest.integration.config.ts' : 'vitest.config.ts';
      let patterns = cache.get(config);
      if (!patterns) { patterns = rootExcludes(read(config), read(shared)); cache.set(config, patterns); }
      const pattern = patterns.find(pattern => {
        const match = /^\*\*\/([^/*?\[\]{}!]+)\/\*\*$/.exec(pattern);
        return !!match && parts.includes(match[1]!);
      });
      if (pattern) excluded.push({ path, pattern, config, evidence: [config, shared, router, registry].map(path => ({ path, blob: input.files.get(path)!.sha })) });
    }
  } catch (error) {
    // An unproved policy cannot remove a test. The complete original population remains runnable.
    excluded.length = 0;
    selection.unavailable = error instanceof Error ? error.message : String(error);
  }
  return selection;
}

