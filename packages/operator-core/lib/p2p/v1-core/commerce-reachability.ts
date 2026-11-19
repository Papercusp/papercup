import { posix } from 'node:path';
import ts from 'typescript';

export const COMMERCE_CORE_ROOT = 'packages/operator-core/lib';
export const COMMERCE_SCAN_ROOTS = [COMMERCE_CORE_ROOT, 'apps/operator/lib', 'bin'];

const excludedDirectories = new Set(['node_modules', 'dist', 'dist-verify', '.vitest-tmp', 'coverage', '__tests__', '__fixtures__', 'e2e']);
const sourceExtension = /\.(ts|tsx|mts|cts)$/;
const excludedSource = /\.d\.ts$|\.(test|spec)\.(ts|tsx|mts)$|\.fixture\.ts$/;
const coreAlias = '@papercusp/operator-core/lib/';

export function isCommerceSourcePath(path: string): boolean {
  return COMMERCE_SCAN_ROOTS.some(root => path.startsWith(`${root}/`)) &&
    sourceExtension.test(path) && !excludedSource.test(path) &&
    !path.split('/').slice(0, -1).some(part => excludedDirectories.has(part));
}

function resolveSpecifier(from: string, specifier: string, files: ReadonlyMap<string, string>): string | undefined {
  let base: string;
  if (specifier.startsWith('.')) base = posix.join(posix.dirname(from), specifier);
  else if (specifier.startsWith(coreAlias)) base = posix.join(COMMERCE_CORE_ROOT, specifier.slice(coreAlias.length));
  else return;

  const stem = base.replace(/\.(m|c)?js$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, posix.join(stem, 'index.ts'), posix.join(stem, 'index.tsx')]
    .find(candidate => files.has(candidate));
}

/** Static value imports and re-exports. Dynamic imports and type-only edges do not load a module. */
function staticValueSpecifiers(file: string, text: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue;
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.length > 0 && statement.exportClause.elements.every(element => element.isTypeOnly)) continue;
    } else continue;
    const specifier = statement.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
  }
  return specifiers;
}

/** Return the complete reverse closure of the commerce roots in the supplied source tree. */
export function deriveCommerceReachability(files: ReadonlyMap<string, string>, roots: readonly string[]): string[] {
  const reachable = roots.map(root => posix.join(COMMERCE_CORE_ROOT, root));
  const visited = new Set(reachable);
  for (const root of reachable) {
    if (!files.has(root)) throw new Error(`commerce root ${root} is missing from the tree`);
  }

  const importers = new Map<string, Set<string>>();
  for (const [file, text] of files) {
    for (const specifier of staticValueSpecifiers(file, text)) {
      const target = resolveSpecifier(file, specifier, files);
      if (!target) continue;
      let edges = importers.get(target);
      if (!edges) importers.set(target, edges = new Set());
      edges.add(file);
    }
  }

  for (const file of reachable) {
    for (const importer of importers.get(file) ?? []) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      reachable.push(importer);
    }
  }
  return reachable.sort();
}

/** The instrument reads the roots from the measured commit's scope contract. */
export function readCommittedCommerceRoots(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'V1_COMMERCE_ROOTS') continue;
      const value = declaration.initializer;
      const array = value && ts.isAsExpression(value) ? value.expression : value;
      if (array && ts.isArrayLiteralExpression(array) && array.elements.length > 0 && array.elements.every(ts.isStringLiteral)) {
        const roots = array.elements.map(element => element.text);
        if (new Set(roots).size === roots.length) return roots;
      }
      throw new Error(`invalid V1_COMMERCE_ROOTS in ${file}`);
    }
  }
  throw new Error(`missing V1_COMMERCE_ROOTS in ${file}`);
}
