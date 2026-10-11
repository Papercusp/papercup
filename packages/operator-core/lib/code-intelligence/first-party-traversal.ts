/** P-008: bounded compiler call paths, reused by the existing graph worker. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import type * as TsModule from 'typescript';
import { versionedSymbolIdentity, unmeasuredSourceEvidence, type CodeIntelAnswer,
  type CodeIntelSourceEvidence, type CodeIntelSourceFile, type CodeIntelTraversal,
  type CodeIntelVersionedSite, type SymbolSite } from './contracts.ts';
import type { CandidateSearch, FirstPartyCallersQuery } from './first-party-callers.ts';
import { hierarchyItems, isExternalPath, tsDeclarations, tsSiteOf, type TsDeclaration, type TsTree } from './typescript-service.ts';

const posix = (path: string) => path.split('\\').join('/');
const nodeKey = (item: TsModule.CallHierarchyItem) => `${item.file}:${item.selectionSpan.start}`;
const MAX_NODES = 1_000;

/** Includes transitive consumers that do not contain the initial symbol name. */
export function traversalSourceFiles(root: string, rgPath: string, paths: readonly string[]): CandidateSearch {
  const result = spawnSync(rgPath, ['--files', '-g', '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
    '-g', '!**/node_modules/**', '--', ...paths], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) return { files: [], partial: null, error: `ripgrep could not enumerate the graph source scope: ${result.error.message}` };
  const files = result.stdout.split('\n').filter(Boolean).map(path => join(root, path)).sort();
  const error = result.status === 0 || result.status === 1 ? null : `ripgrep source enumeration exited ${result.status}: ${result.stderr.trim()}`;
  return { files, error: files.length ? null : error, partial: files.length ? error : null };
}

interface CallEdge {
  readonly source: TsModule.CallHierarchyItem;
  readonly target?: TsModule.CallHierarchyItem;
  readonly site: SymbolSite;
  readonly position: number;
  readonly binding: 'direct' | 'indirect' | 'dynamic' | 'unresolved';
}

export function compilerTraversal(q: FirstPartyCallersQuery, tree: TsTree, program: TsModule.Program,
  declarations: readonly TsDeclaration[], paths: readonly string[], limitations: readonly string[],
  started: number, now: () => number): CodeIntelAnswer {
  const intent = q.op === 'trace' ? 'trace' : 'impact';
  const fail = (error: string): CodeIntelAnswer => {
    const answer: CodeIntelAnswer = { backend: 'typescript-service', intent, query: q.name, sites: [], error,
      truncation: { truncated: false, totalAvailable: null, continuation: null },
      freshness: { health: 'unhealthy', indexedAt: new Date(started).toISOString(), indexedCommit: null, staleVsDisk: null }, latencyMs: now() - started };
    return { ...answer, evidence: unmeasuredSourceEvidence(answer,
      { repositoryId: q.repositoryId ?? null, identityKind: q.repositoryId ? 'registry' : 'unknown', paths, basis: 'compiler-project' }, [error]) };
  };
  const maxDepth = q.maxDepth ?? 5;
  const maxPaths = q.maxPaths ?? 20;
  const limit = Math.min(q.limit ?? 100, 500);
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 16 ||
    !Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 100 || !Number.isInteger(limit) || limit < 1) {
    return fail('Traversal limits require max_depth 0..16, max_paths 1..100 and a positive site limit');
  }
  if (declarations.length !== 1) return fail(declarations.length === 0
    ? `No declaration named '${q.name}' matches the defining-file/line/kind selector`
    : `Ambiguous symbol '${q.name}'; supply file_path and, when needed, line1.`);
  const initial = hierarchyItems(tree, declarations[0]!);
  if (initial.length !== 1) return fail('Call hierarchy is unsupported or ambiguous for the selected declaration');
  const start = initial[0]!;
  let target: TsModule.CallHierarchyItem | undefined;
  if (intent === 'trace') {
    const targetDeclarations = tsDeclarations(tree, program, q.target!).filter(d =>
      (!q.targetFilePath || d.site.path === posix(relative(q.root, join(q.root, q.targetFilePath)))) &&
      (q.targetLine1 === undefined || d.site.line1 === q.targetLine1));
    if (targetDeclarations.length !== 1) return fail(targetDeclarations.length === 0
      ? `No target declaration named '${q.target}' matches the target selector`
      : `Ambiguous target '${q.target}'; supply target_file_path and target_line1.`);
    const items = hierarchyItems(tree, targetDeclarations[0]!);
    if (items.length !== 1) return fail('Call hierarchy is unsupported or ambiguous for the target declaration');
    target = items[0]!;
  }
  const { ts } = tree;
  const siteOf = (item: TsModule.CallHierarchyItem): SymbolSite => ({
    ...tsSiteOf(tree, program, item.file, item.selectionSpan.start, item.kind), name: item.name,
  });
  const edges: CallEdge[] = [];
  const edgeIndices = new Map<string, number>();
  const reasons = new Set<CodeIntelTraversal['truncationReasons'][number]>();
  const recordedPaths: { siteIndices: number[]; walk: 'forward' | 'reverse' }[] = [];
  const visited = new Set<string>();
  const cache = new Map<string, CallEdge[]>();
  let uncertain = false;
  const neighbours = (item: TsModule.CallHierarchyItem, walk: 'forward' | 'reverse'): CallEdge[] => {
    const key = `${walk}:${nodeKey(item)}`;
    const prior = cache.get(key);
    if (prior) return prior;
    const result: CallEdge[] = [];
    if (walk === 'reverse') {
      for (const call of tree.service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
        if (isExternalPath(posix(relative(tree.root, call.from.file)))) continue;
        for (const span of call.fromSpans) result.push({ source: call.from, target: item, position: span.start, binding: 'direct',
          site: { ...tsSiteOf(tree, program, call.from.file, span.start, item.kind), name: item.name } });
      }
    } else {
      const knownPositions = new Set<number>();
      for (const call of tree.service.provideCallHierarchyOutgoingCalls(item.file, item.selectionSpan.start)) {
        for (const span of call.fromSpans) {
          knownPositions.add(span.start);
          const external = isExternalPath(posix(relative(tree.root, call.to.file)));
          result.push({ source: item, ...(external ? {} : { target: call.to }), position: span.start,
            binding: external ? 'unresolved' : 'direct',
            site: { ...tsSiteOf(tree, program, item.file, span.start, call.to.kind), name: call.to.name } });
        }
      }
      // Parameter/dynamic calls have no certified target. Keep the call site,
      // but never turn a callback passed as an argument into an execution edge.
      const file = program.getSourceFile(item.file)!;
      const scan = (node: TsModule.Node): void => {
        if (node.getStart(file) < item.span.start || node.end > item.span.start + item.span.length) {
          if (node.pos <= item.span.start && node.end >= item.span.start) ts.forEachChild(node, scan);
          return;
        }
        if (node !== file && ts.isFunctionLike(node) && node.getStart(file) !== item.span.start) return;
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !knownPositions.has(node.expression.getStart(file))) {
          const symbol = program.getTypeChecker().getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
          const indirect = symbol?.declarations?.some(d => ts.isParameter(d));
          result.push({ source: item, position: node.expression.getStart(file), binding: indirect ? 'indirect' : symbol ? 'unresolved' : 'dynamic',
            site: { ...tsSiteOf(tree, program, item.file, node.expression.getStart(file), 'call'), name: node.expression.getText(file),
              detail: 'Static call site; target binding and runtime execution are unknown.' } });
        }
        ts.forEachChild(node, scan);
      };
      scan(file);
    }
    result.sort((a, b) => a.site.path.localeCompare(b.site.path) || a.position - b.position || nodeKey(a.target ?? a.source).localeCompare(nodeKey(b.target ?? b.source)));
    cache.set(key, result);
    return result;
  };
  const addEdge = (edge: CallEdge): number | null => {
    const key = `${nodeKey(edge.source)}:${edge.position}:${edge.target ? nodeKey(edge.target) : '?'}`;
    const known = edgeIndices.get(key);
    if (known !== undefined) return known;
    if (edges.length >= limit) { reasons.add('sites'); return null; }
    edgeIndices.set(key, edges.length);
    edges.push(edge);
    return edges.length - 1;
  };
  const walkGraph = (walk: 'forward' | 'reverse'): void => {
    const queue = [{ item: start, indices: [] as number[], seen: new Set([nodeKey(start)]) }];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const state = queue[cursor]!;
      if (target && nodeKey(state.item) === nodeKey(target)) {
        if (recordedPaths.length >= maxPaths) { reasons.add('paths'); break; }
        recordedPaths.push({ siteIndices: state.indices, walk });
        continue;
      }
      if (!visited.has(nodeKey(state.item)) && visited.size >= MAX_NODES) { reasons.add('nodes'); break; }
      visited.add(nodeKey(state.item));
      const next = neighbours(state.item, walk);
      if (state.indices.length >= maxDepth) {
        if (next.some(edge => !edge.target || !state.seen.has(nodeKey(walk === 'forward' ? edge.target : edge.source)))) reasons.add('depth');
        continue;
      }
      for (const edge of next) {
        if (recordedPaths.length >= maxPaths && !target) { reasons.add('paths'); return; }
        const index = addEdge(edge);
        if (index === null) return;
        if (!edge.target) { uncertain = true; continue; }
        const destination = walk === 'forward' ? edge.target : edge.source;
        if (state.seen.has(nodeKey(destination))) continue;
        const indices = [...state.indices, index];
        if (!target) recordedPaths.push({ siteIndices: indices, walk });
        queue.push({ item: destination, indices, seen: new Set([...state.seen, nodeKey(destination)]) });
        // Bound the frontier as well as returned paths in a branching graph.
        if (queue.length >= MAX_NODES) { reasons.add('nodes'); return; }
      }
    }
  };
  const direction = intent === 'trace' ? 'forward' : q.direction ?? 'downstream';
  // Impact downstream means dependents (reverse calls); upstream means callees.
  if (direction === 'forward' || direction === 'upstream' || direction === 'both') walkGraph('forward');
  if (direction === 'downstream' || direction === 'both') walkGraph('reverse');

  const sources: CodeIntelSourceFile[] = program.getSourceFiles().flatMap(file => {
    const path = posix(relative(tree.root, file.fileName));
    if (isExternalPath(path) || program.isSourceFileDefaultLibrary(file)) return [];
    return [{ path, contentHash: createHash('sha256').update(file.text).digest('hex'),
      language: /\.[cm]?jsx?$/.test(path) ? 'javascript' : 'typescript', representation: 'full-source' as const }];
  }).sort((a, b) => a.path.localeCompare(b.path));
  const repositoryId = q.repositoryId ?? `local-root:${createHash('sha256').update(realpathSync(q.root)).digest('hex')}`;
  const sourceByPath = new Map(sources.map(source => [source.path, source]));
  const versioned = (site: SymbolSite): CodeIntelVersionedSite => {
    const source = sourceByPath.get(site.path)!;
    return { site, contentHash: source.contentHash, versionedSymbolId: versionedSymbolIdentity(repositoryId, site, source) };
  };
  const sites = edges.map(edge => edge.site);
  const supportingPaths = new Set([siteOf(start).path, ...(target ? [siteOf(target).path] : []),
    ...edges.flatMap(edge => [edge.site.path, siteOf(edge.source).path, ...(edge.target ? [siteOf(edge.target).path] : [])])]);
  const evidence: CodeIntelSourceEvidence = {
    schemaVersion: 1,
    sourceScope: { repositoryId, identityKind: q.repositoryId ? 'registry' : 'local-root', paths,
      sourceFingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
      supportingFiles: sources.filter(source => supportingPaths.has(source.path)) },
    graphScope: { basis: 'compiler-project', sourceCompleteness: 'unverified', limitations: [...limitations,
      'Static possible call paths only; compiler relationships do not establish runtime execution.',
      'The scoped source program excludes hidden, ignored and node_modules files; external, dynamic and indirect callback bindings remain unknown.'] },
    languageCapabilities: [...new Set(sources.map(source => source.language))].map(language => ({ language, intent, status: 'compiler-backed' })),
    siteIdentities: sites.map((site, siteIndex) => ({ siteIndex, sourcePath: site.path,
      contentHash: sourceByPath.get(site.path)!.contentHash, versionedSymbolId: versionedSymbolIdentity(repositoryId, site, sourceByPath.get(site.path)) })),
    relationships: edges.map((edge, siteIndex) => ({ siteIndex, kind: 'callees', origin: 'compiler',
      knowledge: edge.target ? 'observed' : 'unknown', runtimeExecution: 'unknown', binding: edge.binding,
      source: versioned(siteOf(edge.source)), ...(edge.target ? { target: versioned(siteOf(edge.target)) } : {}) })),
  };
  const outcome = target && recordedPaths.length > 0 ? 'found' : reasons.size || uncertain ? 'incomplete' : 'not-found-in-scope';
  return { backend: 'typescript-service', intent, query: q.name, sites, evidence, error: null,
    traversal: { direction, maxDepth, maxPaths, start: versioned(siteOf(start)), ...(target ? { target: versioned(siteOf(target)) } : {}),
      paths: recordedPaths, truncationReasons: [...reasons], outcome: intent === 'impact' && edges.length && !reasons.size && !uncertain ? 'found' : outcome },
    truncation: { truncated: reasons.size > 0, totalAvailable: reasons.size ? null : sites.length, continuation: null },
    coverage: evidence.graphScope,
    freshness: { health: 'healthy', indexedAt: new Date(started).toISOString(), indexedCommit: null, staleVsDisk: false },
    latencyMs: Math.round(now() - started) };
}
