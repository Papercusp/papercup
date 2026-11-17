/** Source evidence for phase admission. Inventory is independent of executing a writer.
 * Reuse the maintained TypeScript site collector and PostgreSQL grammar; a parse
 * failure or unresolved edge is retained, never interpreted as an exemption.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { parse } from 'pgsql-ast-parser';
import { censusSites } from '../../../../scripts/lib/source-path-census.mjs';
import { listFilesIncludingUntracked } from '../../../../scripts/lib/tracked-files.mjs';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';

export const PHASE_WRITER_ROOTS = ['packages/', 'apps/', 'libs/', 'scripts/'] as const;
export const PHASE_WRITER_RELATIONS = new Set([
  'plan_item_claims', 'work_items', 'engineer_issues', 'harness_features',
  'harness_features_consolidated', 'harness_plans', 'feature_claims',
]);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const relationText = /\b(?:plan_item_claims|work_items|engineer_issues|harness_features(?:_consolidated)?|harness_plans|feature_claims)\b/i;
const mutationText = /\b(?:insert\s+into|update|delete\s+from|merge\s+into|create\s+(?:or\s+replace\s+)?(?:function|trigger))\b/i;
const sqlMethod = /(?:^|\.)(?:unsafe|query|execute|exec)$/;
const sqlInvocationText = /\b(?:query|execute|executemany|executescript|unsafe)\s*\(/i;
const sqlReadText = /^\s*(?:select|with|call|do|execute)\b/i;

export interface PhaseWriterSource { path: string; content: string }
export interface PhaseWriterSite {
  /** Complete path, enclosing operation and statement digest; no display truncation. */
  id: string;
  path: string;
  operation: string;
  kind: 'sql' | 'sql-function' | 'authority-append' | 'helper-edge' | 'unresolved';
  sourceSha256: string;
  statementSha256: string;
  statement: string;
  line: number;
  relations: string[];
  columns: string[];
  dynamicEdges: string[];
  unresolved: string[];
  callees: string[];
  /** A maintained syntax-bound module resolution supplies review evidence,
   * never runtime reachability or a reason to exempt the call. */
  helperTarget?: { path: string; sha256: string; basis: 'syntax-bound-module-target-not-runtime-closure' };
}
export interface PhaseWriterInventory {
  schemaVersion: 1;
  scope: { kind: 'supplied-sources' } | { kind: 'repository'; root: string };
  sites: PhaseWriterSite[];
  sources: Array<{ path: string; sha256: string }>;
  /** Enumeration/read/parse gaps remain identities in the coverage population. */
  gaps: Array<{ id: string; reason: string }>;
}
export type PhaseWriterTreeManifest = Pick<PhaseWriterInventory, 'scope' | 'sources' | 'gaps'> & {
  excluded: Array<{ path: string; reason: string }>;
  enumeration: { scanned: string[]; unscanned: string[] };
};
export type PhaseWriterDisposition =
  'advancing' | 'safe-retreat' | 'metadata-only' | 'isolated-fixture' | 'historical/unreachable';
export interface PhaseWriterReview {
  siteId: string;
  sourceSha256: string;
  statementSha256: string;
  disposition: PhaseWriterDisposition;
  reason: string;
  evidenceRefs: string[];
  /** Every interpolation/call frontier needs its own inspected source proof. */
  resolvedEdges: Array<{ edge: string; reason: string; evidenceRefs: string[] }>;
  revalidationSeam?: string;
  raceTest?: string;
}
export interface PhaseWriterCoverage {
  population: string[];
  checked: string[];
  notChecked: string[];
  notApplicable: string[];
  residue: string[];
}

function canonicalPath(path: string): boolean {
  return !!path && !path.includes('\0') && !path.includes('\\') && !path.startsWith('/')
    && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}

/** The grammar walks nested WITH mutations and function bodies too. */
function sqlFacts(sql: string) {
  const relations = new Set<string>(), columns = new Set<string>();
  const unresolved: string[] = [], functions: string[] = [], callees = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (['update', 'insert', 'delete', 'merge'].includes(String(node.type))) {
      const table = (node.table ?? node.into ?? node.from) as { name?: string; schema?: string } | undefined;
      if (!table?.name) unresolved.push('mutation-relation-unresolved');
      else {
        // Keep other relation writers as candidates too: their triggers may
        // reach a phase relation. Exclusion requires a source-bound review.
        relations.add([table.schema, table.name].filter(Boolean).join('.'));
        const fields = node.type === 'insert' ? node.columns : node.sets;
        if (Array.isArray(fields)) for (const field of fields) {
          const name = field?.column?.name ?? field?.name;
          if (typeof name === 'string') columns.add(name);
          else unresolved.push('mutation-column-unresolved');
        }
        else if (node.type !== 'delete') unresolved.push('mutation-columns-unresolved');
        const sets = (node.onConflict as { do?: { sets?: Array<{ column?: { name?: string } }> } } | undefined)?.do?.sets;
        for (const set of sets ?? []) {
          if (set.column?.name) columns.add(set.column.name);
          else unresolved.push('upsert-column-unresolved');
        }
      }
    }
    if (node.type === 'call') {
      const fn = node.function as { schema?: string; name?: string } | undefined;
      if (fn?.name) callees.add([fn.schema, fn.name].filter(Boolean).join('.'));
      unresolved.push('sql-function-call-requires-reachability-review');
    }
    if (node.type === 'create function' && typeof node.code === 'string') {
      // PL/pgSQL is not the SQL grammar. Keep its whole body for review and
      // reachable-trigger analysis instead of treating an opaque body as clean.
      // A body that only calls a helper can write just as surely as one with
      // literal UPDATE text. Even an empty body stays bound to its source.
      functions.push(node.code);
      unresolved.push('sql-function-body-requires-reachability-review');
    }
    Object.values(node).forEach(visit);
  };
  try { visit(parse(sql)); }
  catch { unresolved.push('sql-parse-unresolved'); }
  return { relations: [...relations].sort(compare), columns: [...columns].sort(compare),
    unresolved: [...new Set(unresolved)], functions, callees: [...callees].sort(compare) };
}

/** No file/statement/identity limit: callers supply complete sources or explicit
 * gaps. Review bindings pin both the complete file and complete statement.
 */
export function inventoryPhaseWriters(input: readonly PhaseWriterSource[],
  gaps: PhaseWriterInventory['gaps'] = []): PhaseWriterInventory {
  const sites: PhaseWriterSite[] = [], sources: PhaseWriterInventory['sources'] = [];
  const seenPaths = new Set<string>();
  const byPath = new Map(input.map(source => [source.path, source]));
  const sourceHashes = new Map(input.map(source => [source.path, digest(source.content)]));
  const occurrences = new Map<string, number>();
  const calls: Array<{ path: string; operation: string; callee: string; statement: string;
    line: number; column: number; importedName?: string; importedCall: boolean; argumentNames: string[] }> = [];
  const aliases: Array<{ name: string; target: string }> = [];
  const add = (source: PhaseWriterSource, operation: string, statement: string, line: number,
    kind: PhaseWriterSite['kind'], facts: Partial<Pick<PhaseWriterSite,
      'relations' | 'columns' | 'dynamicEdges' | 'unresolved' | 'callees' | 'helperTarget'>> = {}) => {
    const statementSha256 = digest(statement), sourceSha256 = sourceHashes.get(source.path)!;
    // Identical statements in the same operation are separate source occurrences.
    const base = JSON.stringify([source.path, operation, kind, statementSha256]);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    sites.push({ id: base + '#' + occurrence, path: source.path, operation, kind,
      statement, line, statementSha256, sourceSha256, relations: [], columns: [],
      dynamicEdges: [], unresolved: [], callees: [], ...facts });
  };
  const retainedGaps = [...gaps];
  for (const source of [...input].sort((a, b) => compare(a.path, b.path))) {
    if (!canonicalPath(source.path) || seenPaths.has(source.path)) {
      throw new Error(`phase_writer_source_identity_invalid:${source.path}`);
    }
    seenPaths.add(source.path);
    sources.push({ path: source.path, sha256: sourceHashes.get(source.path)! });
    if (/\.[cm]?[jt]sx?$/.test(source.path)) {
      let unit: ReturnType<typeof censusSites>;
      try { unit = censusSites(source.path, source.content); }
      catch {
        retainedGaps.push({ id: `source:${source.path}`, reason: 'typescript-parse-unresolved' });
        continue;
      }
      const operation = (node: ts.Node): string => {
        const names: string[] = [];
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (!ts.isFunctionLike(parent)) continue;
          const name = parent.name ?? ((ts.isVariableDeclaration(parent.parent)
            || ts.isPropertyAssignment(parent.parent)) ? parent.parent.name : undefined);
          names.unshift(name?.getText(unit.ast) ?? '<callback>');
        }
        return names.join('::') || '<module>';
      };
      const inspectSql = (node: ts.Node, sql: string, edges: string[]) => {
        const facts = sqlFacts(sql);
        if (!edges.length && !facts.relations.length && !facts.functions.length && !facts.callees.length
          && !facts.unresolved.length && !mutationText.test(sql)) return;
        add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
          facts.functions.length ? 'sql-function' : 'sql', {
            relations: facts.relations, columns: facts.columns,
            dynamicEdges: edges, unresolved: facts.unresolved, callees: facts.callees,
          });
      };
      const literal = (node: ts.Node): { sql: string; edges: string[] } | null => {
        if (ts.isStringLiteralLike(node)) return { sql: node.text, edges: [] };
        if (!ts.isTemplateExpression(node)) return null;
        let sql = node.head.text;
        const edges: string[] = [];
        node.templateSpans.forEach((span, i) => {
          edges.push(span.expression.getText(unit.ast));
          sql += `$${i + 1}` + span.literal.text;
        });
        return { sql, edges };
      };
      const bindings = new Map(unit.sites.filter(site => site.kind === 'call')
        .map(site => [site.node, site.binding]));
      // Keep all import frontiers, including defaults, namespaces and shadowed
      // names. The shared symbol resolver may decline to assign their target.
      const importedLocals = new Set<string>();
      for (const node of unit.ast.statements) if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        if (node.importClause?.name) importedLocals.add(node.importClause.name.text);
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) importedLocals.add(named.name.text);
        else if (named) for (const part of named.elements) if (!part.isTypeOnly) importedLocals.add(part.name.text);
      }
      const targetName = (node: ts.Node | undefined): string | undefined => {
        if (!node) return;
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
          || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return targetName(node.expression);
        if (ts.isIdentifier(node)) return node.text;
        if (ts.isPropertyAccessExpression(node)) return node.name.text;
      };
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const target = targetName(node.initializer);
          if (target) aliases.push({ name: node.name.text, target });
        } else if (ts.isImportSpecifier(node) && !node.isTypeOnly) {
          aliases.push({ name: node.name.text, target: (node.propertyName ?? node.name).text });
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(node.left)) {
          const target = targetName(node.right);
          if (target) aliases.push({ name: node.left.text, target });
        }
        if (ts.isTaggedTemplateExpression(node)) {
          const text = literal(node.template);
          if (text) inspectSql(node, text.sql, text.edges);
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const callee = node.expression.getText(unit.ast);
          const args = node.arguments ?? [];
          const bindingSite = ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression) ? node.expression.name : node.expression;
          const rootName = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.expression.getText(unit.ast) : callee;
          calls.push({ path: source.path, operation: operation(node), callee,
            statement: node.getText(unit.ast), line: unit.span(bindingSite).line, column: unit.span(bindingSite).column,
            importedCall: importedLocals.has(rootName),
            argumentNames: args.map(targetName).filter((name): name is string => name !== undefined),
            ...(bindings.get(node)?.imported ? { importedName: bindings.get(node)!.imported } : {}) });
          let parameterCall = false;
          if (ts.isIdentifier(node.expression)) {
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
              if (ts.isFunctionLike(parent) && parent.parameters.some(parameter =>
                ts.isIdentifier(parameter.name) && parameter.name.text === callee)) parameterCall = true;
            }
          }
          if (parameterCall || ts.isElementAccessExpression(node.expression) || ts.isCallExpression(node.expression)) {
            add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
              'unresolved', { dynamicEdges: [callee], unresolved: ['indirect-call-target-requires-review'] });
          }
          if (sqlMethod.test(callee)) {
            const text = args[0] && literal(args[0]);
            if (text) inspectSql(node, text.sql, text.edges);
            else add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
              'unresolved', { dynamicEdges: [args[0]?.getText(unit.ast) ?? '<missing-query>'],
                unresolved: ['dynamic-sql-target-unresolved'] });
          }
          if (/\.(?:withAppendsHeld|appendBatch)$/.test(callee)
            || /\.append$/.test(callee) && /feature.claim|plan.item|work.item/i.test(source.content)) {
            add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
              'authority-append', { dynamicEdges: args.map(arg => arg.getText(unit.ast)) });
          }
        } else if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
          // A dormant/indirect SQL literal is still in the population. Looking
          // only at .unsafe/query calls would miss a newly introduced wrapper.
          const parent = node.parent;
          const alreadyInspected = ts.isTaggedTemplateExpression(parent)
            || ts.isCallExpression(parent) && sqlMethod.test(parent.expression.getText(unit.ast))
              && parent.arguments[0] === node;
          if (!alreadyInspected) {
            const text = literal(node);
            if (text && (mutationText.test(text.sql) || sqlReadText.test(text.sql))) inspectSql(node, text.sql, text.edges);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(unit.ast);
    } else if (/\.sql$/.test(source.path)) {
      const facts = sqlFacts(source.content);
      if (facts.relations.length || facts.functions.length || facts.callees.length
        || facts.unresolved.length || mutationText.test(source.content)) {
        add(source, '<sql-module>', source.content, 1, facts.functions.length ? 'sql-function' : 'sql', facts);
      }
    } else if (relationText.test(source.content) || mutationText.test(source.content)
      || sqlInvocationText.test(source.content)) {
      add(source, '<unparsed-source>', source.content, 1, 'unresolved', {
        unresolved: ['source-language-requires-review'],
      });
    }
  }
  // Fixed point over the full source population, not a prefix or a hop cap.
  // Name matching supplies candidates only; ambiguous/dynamic dispatch remains
  // an edge requiring review, not an assertion of a resolved callee.
  const writers = new Set(sites.map(site => site.operation.split('::')[0]!));
  const writerPaths = new Set(sites.map(site => site.path));
  const targets = new Map<string, string | null>();
  const fileSet = new Set(input.map(source => source.path));
  const helperSymbols = buildSymbolSnapshot({ files: [...fileSet].sort(compare), censusOnly: true,
    readSource: path => byPath.get(path)?.content ?? null,
    resolveModule: (importer, specifier) => relativeSymbolModule(importer, specifier, fileSet),
    callCensusSink: (call, target) => targets.set(JSON.stringify([call.path, call.line, call.column]), target) });
  // A partially propagated barrel can appear singular before another export
  // reaches it. Keep the full candidates but decline every such target proof.
  if (helperSymbols.stats.callCensusTruncated) targets.clear();
  const added = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    // Aliases supply candidates, never binding proof. Retain every assignment
    // and ambiguous name rather than choosing a convenient lexical scope.
    for (const alias of aliases) if (writers.has(alias.target) && !writers.has(alias.name)) {
      writers.add(alias.name); changed = true;
    }
    for (const call of calls) {
      const name = call.importedName ?? call.callee.split('.').at(-1)!;
      const key = JSON.stringify([call.path, call.operation, call.statement, call.line]);
      const target = targets.get(JSON.stringify([call.path, call.line, call.column]));
      if ((!writers.has(name) && !call.argumentNames.some(argument => writers.has(argument))
        && !(target && writerPaths.has(target)) && !call.importedCall) || added.has(key)) continue;
      added.add(key);
      const source = byPath.get(call.path)!;
      const helperTarget: PhaseWriterSite['helperTarget'] = target ? {
        path: target, sha256: sourceHashes.get(target)!, basis: 'syntax-bound-module-target-not-runtime-closure',
      } : undefined;
      add(source, call.operation, call.statement, call.line, 'helper-edge', {
        callees: [call.callee], dynamicEdges: [call.callee,
          ...(helperTarget ? [`source:${helperTarget.path}#${helperTarget.sha256}`] : [])],
        ...(helperTarget ? { helperTarget } : {}),
        unresolved: [...(!helperTarget && call.importedCall ? ['imported-call-target-requires-review'] : []),
          ...(helperSymbols.stats.callCensusTruncated ? ['helper-symbol-export-resolution-incomplete'] : [])],
      });
      if (!writerPaths.has(source.path)) { writerPaths.add(source.path); changed = true; }
      const wrapper = call.operation.split('::')[0]!;
      if (!writers.has(wrapper)) { writers.add(wrapper); changed = true; }
    }
  }
  return { schemaVersion: 1, scope: { kind: 'supplied-sources' }, sources, sites: sites.sort((a, b) => compare(a.id, b.id)),
    gaps: retainedGaps.sort((a, b) => compare(a.id, b.id)) };
}

/** Complete maintained tree enumeration, including checked-out submodules and
 * new source files. Missing submodules, unreadable files and symlinks are gaps.
 * Named exclusions retain every path; no page/file cap selects the truth.
 */
function readPhaseWriterTree(root: string) {
  const enumeration = listFilesIncludingUntracked(root);
  const input: PhaseWriterSource[] = [];
  const gaps: PhaseWriterInventory['gaps'] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  const files: string[] = [];
  for (const path of enumeration.files) {
    if (typeof path !== 'string' || !canonicalPath(path)) {
      throw new Error(`phase_writer_enumeration_identity_invalid:${String(path)}`);
    }
    files.push(path);
  }
  const generated = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.turbo']);
  const sourceExtension = /\.(?:[cm]?[jt]sx?|sql|py|rs|sh|bash|ps1|json|ya?ml|toml)$/;
  for (const path of [...new Set(files)].sort(compare)) {
    if (!PHASE_WRITER_ROOTS.some(prefix => path.startsWith(prefix))) {
      excluded.push({ path, reason: 'outside-declared-runtime-roots' }); continue;
    }
    if (path.split('/').some(part => generated.has(part))) {
      excluded.push({ path, reason: 'generated-or-vendor-output' }); continue;
    }
    if (!sourceExtension.test(path)) {
      excluded.push({ path, reason: 'non-runtime-source-extension' }); continue;
    }
    try {
      const fullPath = join(root, path), stat = lstatSync(fullPath);
      if (!stat.isFile()) { gaps.push({ id: `source:${path}`, reason: 'non-regular-source' }); continue; }
      const bytes = readFileSync(fullPath), content = bytes.toString('utf8');
      if (!Buffer.from(content).equals(bytes)) { gaps.push({ id: `source:${path}`, reason: 'source-not-utf8' }); continue; }
      input.push({ path, content });
    } catch { gaps.push({ id: `source:${path}`, reason: 'source-read-failed' }); }
  }
  for (const path of enumeration.unscanned) {
    if (PHASE_WRITER_ROOTS.some(prefix => path.startsWith(prefix))) {
      gaps.push({ id: `submodule:${path}`, reason: 'declared-submodule-not-enumerated' });
    }
  }
  return { input, gaps, scope: { kind: 'repository' as const, root: resolve(root) }, excluded,
    enumeration: { scanned: enumeration.scanned, unscanned: enumeration.unscanned } };
}

export function inventoryPhaseWriterTree(root: string) {
  const { input, gaps, ...manifest } = readPhaseWriterTree(root);
  return { ...inventoryPhaseWriters(input, gaps), ...manifest };
}

/** Re-enumerate and hash the complete tree, without repeating the SQL/call
 * analysis. A verified export is an old source snapshot until this comparison
 * succeeds. Added/deleted sources and changed exclusions are just as material
 * as changed reviewed statements. Gaps never become evidence of no change.
 * This measures filesystem bytes at observedAt, not executed-module identity.
 */
export function verifyPhaseWriterTreeSnapshot(expected: PhaseWriterTreeManifest) {
  if (expected.scope.kind !== 'repository') throw new Error('phase_writer_repository-snapshot-required');
  const { input, gaps, ...manifest } = readPhaseWriterTree(expected.scope.root);
  const actual: PhaseWriterTreeManifest = { ...manifest, gaps,
    sources: input.map(source => ({ path: source.path, sha256: digest(source.content) })) };
  const index = (value: PhaseWriterTreeManifest) => {
    const rows = new Map<string, string>();
    const add = (id: string, content: string) => {
      if (rows.has(id)) throw new Error(`phase_writer_duplicate-snapshot-identity:${id}`);
      rows.set(id, content);
    };
    for (const source of value.sources) {
      if (!canonicalPath(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256)) {
        throw new Error(`phase_writer_invalid-snapshot-source:${source.path}`);
      }
      add(`source:${source.path}`, source.sha256);
    }
    for (const gap of value.gaps) add(`gap:${gap.id}`, gap.reason);
    for (const exclusion of value.excluded) add(`excluded:${exclusion.path}`, exclusion.reason);
    for (const path of value.enumeration.scanned) add(`scanned:${path}`, path);
    for (const path of value.enumeration.unscanned) add(`unscanned:${path}`, path);
    return rows;
  };
  const before = index(expected), after = index(actual);
  const coverage: PhaseWriterCoverage = { population: [...new Set([...before.keys(), ...after.keys()])].sort(compare),
    checked: [], notChecked: [], notApplicable: [], residue: [] };
  const differences: Array<{ id: string; reason: 'added' | 'removed' | 'changed';
    expected: string | null; actual: string | null }> = [];
  for (const id of coverage.population) {
    const old = before.get(id), current = after.get(id);
    const changed = old !== current;
    if (changed) differences.push({ id, reason: old === undefined ? 'added' : current === undefined ? 'removed' : 'changed',
      expected: old ?? null, actual: current ?? null });
    if (changed || id.startsWith('gap:') || id.startsWith('unscanned:')) {
      coverage.notChecked.push(id); coverage.residue.push(id);
    } else if (id.startsWith('excluded:')) coverage.notApplicable.push(id);
    else coverage.checked.push(id);
  }
  return { schemaVersion: 1 as const, scope: actual.scope, observedAt: new Date().toISOString(),
    ready: coverage.residue.length === 0, coverage, differences };
}

const dispositions = new Set<PhaseWriterDisposition>([
  'advancing', 'safe-retreat', 'metadata-only', 'isolated-fixture', 'historical/unreachable',
]);

/** Reviews are exact source proofs. Neither an exemption nor an advancing seam
 * is accepted after its source/statement changes, even if it never executes.
 */
export function reconcilePhaseWriterCensus(inventory: PhaseWriterInventory,
  reviews: readonly PhaseWriterReview[]) {
  const coverage: PhaseWriterCoverage = { population: [], checked: [], notChecked: [], notApplicable: [], residue: [] };
  const problems: Array<{ id: string; reasons: string[] }> = [];
  const byId = new Map<string, PhaseWriterReview[]>();
  for (const review of reviews) byId.set(review.siteId, [...(byId.get(review.siteId) ?? []), review]);
  for (const site of inventory.sites) {
    coverage.population.push(site.id);
    const candidates = byId.get(site.id) ?? [];
    const review = candidates.length === 1 ? candidates[0] : undefined;
    const reasons: string[] = [];
    if (!review) reasons.push(candidates.length ? 'duplicate-review' : 'unclassified-writer');
    else {
      if (review.sourceSha256 !== site.sourceSha256 || review.statementSha256 !== site.statementSha256) reasons.push('stale-review');
      if (!dispositions.has(review.disposition) || !review.reason.trim()
        || !review.evidenceRefs.length || review.evidenceRefs.some(ref => !ref.trim())) reasons.push('review-proof-missing');
      if (review.disposition === 'advancing' && (!review.revalidationSeam?.trim() || !review.raceTest?.trim())) reasons.push('advancing-seam-or-race-test-missing');
      const edges = [...site.dynamicEdges, ...site.unresolved, ...site.callees];
      for (const edge of new Set(edges)) {
        const resolved = review.resolvedEdges.filter(row => row.edge === edge);
        if (resolved.length !== 1 || !resolved[0]!.reason.trim() || !resolved[0]!.evidenceRefs.length
          || resolved[0]!.evidenceRefs.some(ref => !ref.trim())) reasons.push(`unresolved-edge:${edge}`);
      }
      for (const resolved of review.resolvedEdges) if (!edges.includes(resolved.edge)) reasons.push(`stale-edge-review:${resolved.edge}`);
    }
    if (reasons.length) {
      coverage.notChecked.push(site.id); coverage.residue.push(site.id); problems.push({ id: site.id, reasons });
    } else if (review!.disposition === 'isolated-fixture' || review!.disposition === 'historical/unreachable') {
      coverage.notApplicable.push(site.id);
    } else coverage.checked.push(site.id);
    byId.delete(site.id);
  }
  for (const gap of inventory.gaps) {
    const id = `gap:${gap.id}`;
    coverage.population.push(id); coverage.notChecked.push(id); coverage.residue.push(id);
    problems.push({ id, reasons: [gap.reason] });
  }
  // An exemption for a deleted writer is stale too. Preserve the full identity.
  for (const [siteId] of byId) {
    const id = `orphan-review:${siteId}`;
    coverage.population.push(id); coverage.notChecked.push(id); coverage.residue.push(id);
    problems.push({ id, reasons: ['reviewed-writer-missing'] });
  }
  return { schemaVersion: 1 as const, scope: inventory.scope, ready: problems.length === 0, coverage, problems };
}

export function assertPhaseWriterCensus(inventory: PhaseWriterInventory, reviews: readonly PhaseWriterReview[]) {
  const report = reconcilePhaseWriterCensus(inventory, reviews);
  // Keep the complete report recoverable without serializing the population
  // into one enormous error string. The first reason is a labelled preview.
  if (!report.ready) throw Object.assign(new Error(`phase_writer_census_incomplete:${report.problems[0]?.reasons[0]}; first-reason-preview; complete report on error.report`), { report });
  return report;
}

const streamKinds = ['header', 'source', 'site', 'gap', 'excluded', 'scanned', 'unscanned', 'review', 'coverage'] as const;
type StreamKind = typeof streamKinds[number];
type StreamCounts = Record<StreamKind, number>;
type StreamInventory = PhaseWriterInventory & {
  excluded?: Array<{ path: string; reason: string }>;
  enumeration?: { scanned: string[]; unscanned: string[] };
};
interface CensusRecord { seq: number; kind: StreamKind; value: unknown }
interface CensusFooter {
  seq: number; kind: 'complete'; sha256: string; counts: StreamCounts; ready: boolean;
}
const streamCounts = (): StreamCounts => Object.fromEntries(streamKinds.map(kind => [kind, 0])) as StreamCounts;

/** Await each complete record, including sink backpressure. No aggregate JSON
 * string or record limit: large censuses retain the complete population and
 * coverage. A failed sink leaves an incomplete artifact; regenerate from source.
 */
export async function writePhaseWriterCensus(inventory: StreamInventory,
  reviews: readonly PhaseWriterReview[], write: (line: string) => void | Promise<void>) {
  const report = reconcilePhaseWriterCensus(inventory, reviews);
  const hash = createHash('sha256'), counts = streamCounts();
  let seq = 0;
  const emit = async (kind: StreamKind, value: unknown) => {
    const line = JSON.stringify({ seq, kind, value }) + '\n';
    await write(line);
    hash.update(line); counts[kind]++; seq++;
  };
  await emit('header', { schemaVersion: 'phase-writer-census-stream-v1', scope: inventory.scope,
    basis: 'source-inventory-not-acceptance-proof' });
  for (const value of inventory.sources) await emit('source', value);
  for (const value of inventory.sites) await emit('site', value);
  for (const value of inventory.gaps) await emit('gap', value);
  for (const value of inventory.excluded ?? []) await emit('excluded', value);
  for (const value of inventory.enumeration?.scanned ?? []) await emit('scanned', value);
  for (const value of inventory.enumeration?.unscanned ?? []) await emit('unscanned', value);
  for (const value of reviews) await emit('review', value);
  const checked = new Set(report.coverage.checked), notChecked = new Set(report.coverage.notChecked);
  const residue = new Set(report.coverage.residue), problems = new Map(report.problems.map(row => [row.id, row.reasons]));
  for (const id of report.coverage.population) await emit('coverage', { id,
    partition: checked.has(id) ? 'checked' : notChecked.has(id) ? 'notChecked' : 'notApplicable',
    residue: residue.has(id), reasons: problems.get(id) ?? [] });
  const footer: CensusFooter = { seq, kind: 'complete', sha256: hash.digest('hex'), counts, ready: report.ready };
  await write(JSON.stringify(footer) + '\n');
  return footer;
}

/** Consume every line through the completion footer before trusting any record.
 * onRecord receives provisional rows so consumers can spool instead of buffering
 * the artifact. Missing/corrupt/reordered records require regenerating the export;
 * no prefix is a successful census and no record is silently skipped.
 */
export async function readPhaseWriterCensus(lines: Iterable<string> | AsyncIterable<string>,
  onRecord: (record: CensusRecord) => void | Promise<void> = () => {}) {
  const hash = createHash('sha256'), counts = streamCounts();
  let seq = 0, footer: CensusFooter | undefined;
  for await (const raw of lines) {
    if (footer) throw new Error('phase_writer_stream_after_footer');
    let row: CensusRecord | CensusFooter;
    try { row = JSON.parse(raw); } catch { throw new Error('phase_writer_stream_invalid_record'); }
    if (!row || row.seq !== seq) throw new Error('phase_writer_stream_sequence');
    if (row.kind === 'complete') {
      if (counts.header !== 1 || row.sha256 !== hash.digest('hex')
        || typeof row.ready !== 'boolean' || !row.counts
        || Object.keys(row.counts).length !== streamKinds.length
        || streamKinds.some(kind => row.counts[kind] !== counts[kind])) {
        throw new Error('phase_writer_stream_integrity');
      }
      footer = row;
      continue;
    }
    if (!streamKinds.includes(row.kind) || (seq === 0) !== (row.kind === 'header')) {
      throw new Error('phase_writer_stream_kind');
    }
    if (row.kind === 'header'
      && (row.value as { schemaVersion?: string } | null)?.schemaVersion !== 'phase-writer-census-stream-v1') {
      throw new Error('phase_writer_stream_version');
    }
    hash.update(raw.endsWith('\n') ? raw : raw + '\n');
    counts[row.kind]++; seq++;
    await onRecord(row);
  }
  if (!footer) throw new Error('phase_writer_stream_incomplete:regenerate-from-source');
  return footer;
}
