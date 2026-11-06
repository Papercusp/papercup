/** P-008: exact linked declarations reuse the existing source-pinned impact reader. */
import * as ts from 'typescript';
import { withBoundedTimeout } from '../bounded-timeout';
import { declarationContentHash, type PlanItemAnchor } from '../plan-items/anchors';
import { liveLockHoldingsStrict, type LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { nativeChangeReport, type ChangeReportRequest } from './packer-facade';
import type { CodeIntelAnswer } from './contracts';
import type { PackerEffects } from './packer-facade';
import type { FirstTouchContext } from './push-channel';

export interface TaskAnchorContext {
  subjects: Array<{
    path: string | null; symbol: string; freshness: 'fresh' | 'stale' | 'missing' | 'unknown';
    status: 'measured' | 'unknown'; callers: string[]; tests: string[]; impact: string[];
    addedSincePlanning: string[] | null; removedSincePlanning: string[] | null; reason?: string;
  }>;
  docs: string[] | null; specs: string[] | null;
  locks: Array<{ path: string; owner: string; goalRef?: string }> | null;
  /** Unknown context must identify the unread leg rather than look like an empty census. */
  unavailable?: string[];
}
export interface TaskAnchorDeps {
  writeArtifact?: (body: string) => Promise<string>;
  graph?: (request: ChangeReportRequest, root: string, budgetMs: number) => Promise<CodeIntelAnswer>;
  links?: (input: { workspace: string; harness: string; root: string; owner: string }, paths: string[]) =>
    Promise<Pick<FirstTouchContext, 'docs' | 'specs' | 'byPath'>>;
  locks?: () => Promise<LiveLockHolding[]>;
}

/** An anchor array is authoritative even when malformed; never fall back to another function. */
export function taskAnchors(payload: unknown): PlanItemAnchor[] | null {
  const raw = (payload as { anchors?: unknown } | null)?.anchors;
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.slice(0, 8).map(value => value && typeof value === 'object' ? value as PlanItemAnchor
    : { requested: 'invalid anchor', path: null } as PlanItemAnchor);
}

const siteKey = (site: { path: string; line1?: number | null }) => `${site.path}:${site.line1 ?? '?'}`;
const unique = (values: string[]) => [...new Set(values)].sort();

export async function readTaskAnchorContext(input: {
  workspace: string; harness: string; root: string; owner: string;
  anchors: PlanItemAnchor[]; texts: ReadonlyMap<string, string>; deadline: number; effects: PackerEffects;
}, deps: TaskAnchorDeps = {}): Promise<TaskAnchorContext> {
  const paths = [...input.texts.keys()];
  const budget = () => Math.max(1, input.deadline - Date.now() - 100);
  const context = { workspace: input.workspace, harness: input.harness, root: input.root, owner: input.owner };
  const links = withBoundedTimeout(() => deps.links ? deps.links(context, paths)
    : import('./push-channel').then(m => m.readPushSourceLinks({ ...context, calls: [] }, paths)),
  { timeoutMs: budget(), fallback: null, warn: false, label: 'task-anchor-links' });
  const locks = withBoundedTimeout(() => (deps.locks ?? liveLockHoldingsStrict)(),
    { timeoutMs: budget(), fallback: null, warn: false, label: 'task-anchor-locks' });
  const subjects = await Promise.all(input.anchors.map(async anchor => {
    const symbol = typeof anchor.symbolName === 'string' ? anchor.symbolName
      : typeof anchor.requested === 'string' ? anchor.requested : 'invalid anchor';
    const path = typeof anchor.path === 'string' ? anchor.path : null;
    const empty: TaskAnchorContext['subjects'][number] = { path, symbol, freshness: 'unknown', status: 'unknown',
      callers: [], tests: [], impact: [], addedSincePlanning: null, removedSincePlanning: null };
    const text = path ? input.texts.get(path) : undefined;
    if (!path || text === undefined || anchor.anchorKind !== 'symbol' || !/^[A-Za-z_$][\w$]*$/.test(symbol))
      return { ...empty, reason: 'No safely packed, exact named declaration is available for this link.' };
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const declarations: Array<ts.Declaration & { name: ts.Node }> = [];
    function visit(node: ts.Node): void {
      if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
        && node.name?.getText(source) === symbol) declarations.push(node as ts.Declaration & { name: ts.Node });
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (declarations.length !== 1) return { ...empty, freshness: declarations.length ? 'unknown' as const : 'missing' as const,
      reason: declarations.length ? 'The linked declaration is ambiguous in its file.' : 'The linked declaration no longer exists.' };
    const position = source.getLineAndCharacterOfPosition(declarations[0]!.name.getStart(source));
    const contentHash = await declarationContentHash(text, { id: '', name: symbol, path,
      line: position.line + 1, column: position.character + 1, sha256: '', signature: '', aliases: [], callers: [] });
    const freshness: TaskAnchorContext['subjects'][number]['freshness'] = anchor.contentHash && contentHash
      ? anchor.contentHash === contentHash ? 'fresh' : 'stale' : 'unknown';
    const request: ChangeReportRequest = { symbol, file: path, line1: position.line + 1, paths: ['.'], limit: 50, phase: 'pre-edit' };
    const result = await withBoundedTimeout(() => nativeChangeReport({ rootPath: input.root, include: [path] }, request, {
      exec: input.effects.exec,
      // The task assembler owns the shared deadline, including a never-settling worker.
      graph: (query, root) => deps.graph ? deps.graph(query, root, budget()) : firstPartyCallersOffthread({
        root, vendorDir: LSP_VENDOR_DIR, name: query.symbol, filePath: query.file, line1: query.line1,
        paths: ['.'], op: 'impact', direction: 'downstream', maxDepth: 5, maxPaths: 20, limit: 50,
      }, { budgetMs: budget() }),
      writeArtifact: deps.writeArtifact,
    }), { timeoutMs: budget(), fallback: null, warn: false, label: 'task-anchor-impact' });
    if (!result.value || result.value.answer.error || result.value.report.freshness === 'unmeasured')
      return { ...empty, freshness, reason: result.value?.answer.error ?? 'Linked-function impact was unavailable within the brief budget.' };
    const { answer, report } = result.value;
    const direct = answer.evidence?.relationships.filter(edge => edge.knowledge === 'observed'
      && edge.target?.site.path === path && edge.target.site.name === symbol) ?? [];
    const callers = unique(direct.flatMap(edge => answer.sites[edge.siteIndex] ? [siteKey(answer.sites[edge.siteIndex]!)] : []));
    const baseline = Array.isArray(anchor.consumers) && anchor.resolution === 'resolved'
      ? unique(anchor.consumers.filter(site => typeof site.path === 'string' && Number.isInteger(site.line))
        .map(site => `${site.path}:${site.line}`)) : null;
    return { ...empty, freshness, status: 'measured' as const, callers,
      tests: unique(report.testReach.tests.map(site => site.path)), impact: unique(report.consumers.map(site => site.path)),
      addedSincePlanning: baseline ? callers.filter(site => !baseline.includes(site)) : null,
      removedSincePlanning: baseline ? baseline.filter(site => !callers.includes(site)) : null,
      ...(answer.truncation.truncated ? { reason: 'Static impact and planning caller samples are bounded lower bounds.' } : {}),
    };
  }));
  const [sourceLinks, holdings] = await Promise.all([links, locks]);
  const byPath = sourceLinks.value?.byPath;
  const consumers = new Set(subjects.flatMap(subject => subject.impact));
  const unavailable = [sourceLinks.degraded ? `source-links:${sourceLinks.reason}` : null,
    holdings.degraded ? `consumer-locks:${holdings.reason}` : null].filter((value): value is string => value !== null);
  return { subjects, docs: sourceLinks.value ? unique(paths.flatMap(path => [...(byPath?.[path]?.docs ?? sourceLinks.value?.docs ?? [])])) : null,
    specs: sourceLinks.value ? unique(paths.flatMap(path => [...(byPath?.[path]?.specs ?? sourceLinks.value?.specs ?? [])])) : null,
    locks: holdings.value?.filter(lock => lock.owner !== input.owner && lock.coordinationDomain === input.root && consumers.has(lock.path))
      .map(({ path, owner, goalRef }) => ({ path, owner, ...(goalRef ? { goalRef } : {}) })) ?? null,
    ...(unavailable.length ? { unavailable } : {}) };
}
