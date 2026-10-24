/** Static preparation only. Sites are syntax evidence, never runtime/callee closure. */
import ts from 'typescript';
import { createHash } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
const functions = node => ts.isFunctionLike(node) && !!node.body;
const unwrap = node => ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)
  ? unwrap(node.expression) : node;
const label = node => {
  if (node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();
  if (ts.isCallExpression(node.parent)) return node.parent.expression.getText() + '.callback';
  return '<anonymous>';
};

/** Retain every call/import occurrence, its source span, function and predicate context. */
export function censusSites(path, text) {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error('Source parse failed: ' + path);
  const sites = [], bindings = new Map();
  const span = node => {
    const start = node.getStart(ast), end = node.end;
    const point = ast.getLineAndCharacterOfPosition(start);
    return { start, end, byteStart: Buffer.byteLength(text.slice(0, start)),
      byteEnd: Buffer.byteLength(text.slice(0, end)), line: point.line + 1, column: point.character + 1 };
  };
  const bind = (pattern, expression) => {
    if (!pattern || !expression) return;
    expression = unwrap(expression);
    if (ts.isArrayBindingPattern(pattern) && ts.isCallExpression(expression)
        && expression.expression.getText() === 'Promise.all' && ts.isArrayLiteralExpression(expression.arguments[0])) {
      pattern.elements.forEach((element, i) => {
        if (ts.isBindingElement(element)) bind(element.name, expression.arguments[0].elements[i]);
      });
      return;
    }
    if (!ts.isObjectBindingPattern(pattern)) return;
    const imports = [];
    const find = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, find);
    };
    find(expression);
    for (const element of pattern.elements) if (ts.isIdentifier(element.name)) {
      const entry = { imported: (element.propertyName ?? element.name).getText(), specifiers: [...new Set(imports)] };
      // A second lexical binding is ambiguous; never silently pick one scope.
      bindings.set(element.name.text, bindings.has(element.name.text) ? null : entry);
    }
  };
  const visit = (node, context = [], predicates = []) => {
    if (ts.isVariableDeclaration(node)) bind(node.name, node.initializer);
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        const entry = { imported: (element.propertyName ?? element.name).text, specifiers: [node.moduleSpecifier.text] };
        bindings.set(element.name.text, bindings.has(element.name.text) ? null : entry);
      }
    }
    const isImport = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
    const isCall = ts.isCallExpression(node) || ts.isNewExpression(node);
    if (isImport || isCall) {
      const dynamicImport = isCall && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require');
      const literal = isImport ? node.moduleSpecifier : dynamicImport ? node.arguments?.[0] : null;
      const kind = isImport ? 'import' : dynamicImport ? 'dynamic-import' : 'call';
      const typeOnly = !!(isImport && (node.isTypeOnly || node.importClause?.isTypeOnly));
      sites.push({ path, ...span(node), kind, typeOnly,
        expression: isImport ? 'import' : node.expression.getText(),
        specifier: literal && ts.isStringLiteralLike(literal) ? literal.text : null,
        source: node.getText(ast), enclosingFunctions: context, predicates,
        initialization: context.length === 0, node });
    }
    const nextContext = functions(node) ? [...context, label(node)] : context;
    if (ts.isIfStatement(node)) {
      visit(node.expression, nextContext, predicates);
      visit(node.thenStatement, nextContext, [...predicates, { condition: node.expression.getText(), side: true, ...span(node) }]);
      if (node.elseStatement) visit(node.elseStatement, nextContext, [...predicates, { condition: node.expression.getText(), side: false, ...span(node) }]);
    } else ts.forEachChild(node, child => visit(child, nextContext, predicates));
  };
  visit(ast);
  const occurrences = new Map();
  for (const site of sites) {
    const base = JSON.stringify([site.kind, site.enclosingFunctions, site.predicates.map(p => [p.condition, p.side]), site.source]);
    const occurrence = (occurrences.get(base) ?? 0) + 1; occurrences.set(base, occurrence);
    site.fingerprint = hash(base + '\0' + occurrence);
    site.binding = bindings.get(site.expression) ?? null;
    site.calleeCoverage = site.kind === 'call' ? 'UNKNOWN' : null;
  }
  return { path, sha256: hash(text), ast, sites, span };
}

export function changedSites(before, after) {
  const old = new Set(before.sites.map(site => site.fingerprint));
  const current = new Set(after.sites.map(site => site.fingerprint));
  return { addedOrChanged: after.sites.filter(site => !old.has(site.fingerprint)),
    removedOrChanged: before.sites.filter(site => !current.has(site.fingerprint)) };
}

const terminal = node => ts.isReturnStatement(node) || ts.isThrowStatement(node)
  || ts.isBlock(node) && node.statements.length > 0 && terminal(node.statements[node.statements.length - 1]);

/** Select a declared source path. Only exact predicates and unconditional terminal blocks exclude sites. */
export function selectSourcePath(unit, { functionName, containerName, branchValues = {} }) {
  const cutoffs = [];
  const containers = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === containerName) containers.push(unit.span(node));
    if (ts.isBlock(node)) for (const statement of node.statements) {
      if (!ts.isIfStatement(statement)) continue;
      const condition = statement.expression.getText();
      if (!Object.hasOwn(branchValues, condition)) continue;
      const branch = branchValues[condition] ? statement.thenStatement : statement.elseStatement;
      if (branch && terminal(branch)) cutoffs.push({ after: statement.end, until: node.end,
        condition, value: branchValues[condition], terminalBranch: unit.span(branch) });
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.ast);
  const selected = [], excluded = [];
  for (const site of unit.sites) {
    if (site.typeOnly) continue;
    if (!site.initialization && !site.enclosingFunctions.includes(functionName)) continue;
    if (!site.initialization && containerName && !containers.some(c => site.start >= c.start && site.end <= c.end)) continue;
    const mismatch = site.predicates.find(p => Object.hasOwn(branchValues, p.condition) && branchValues[p.condition] !== p.side);
    const cutoff = cutoffs.find(c => site.start > c.after && site.end <= c.until
      && !site.predicates.some(p => Object.hasOwn(branchValues, p.condition) && branchValues[p.condition] !== p.side));
    if (mismatch || cutoff) excluded.push({ site, reason: mismatch ? 'declared-predicate-excludes-branch' : 'selected-branch-terminates-before-site', proof: mismatch ?? cutoff });
    else selected.push(site);
  }
  return { selected, excluded };
}

/** One bound over a union, including seeds supplied by earlier preparation. Never reset per root. */
export function boundedFrontier(edges, { baseline = [], priorAdditions = [], bound = 60 } = {}) {
  const retained = new Set(baseline), additions = new Set(priorAdditions), frontier = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (!edge.path || retained.has(edge.path) || additions.has(edge.path)) continue;
    if (additions.size >= bound) return { status: 'STOPPED-bound', bound, additions: [...additions],
      frontier, refusedEdge: edge, pending: edges.slice(i), complete: false };
    additions.add(edge.path); frontier.push(edge);
  }
  return { status: 'PARTIAL-seeded-frontier', bound, additions: [...additions], frontier, complete: false };
}

/** Remove parser nodes/functions before persistence; the complete source is separately hash-bound. */
export function siteEvidence(site) {
  const { node, ...evidence } = site;
  return { ...evidence, sourceSha256: hash(site.source), source: site.source.slice(0, 500),
    sourceTruncated: site.source.length > 500 };
}
