/** P-012: one bounded task brief at the existing claim/resume seam; no cache or store. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import * as ts from 'typescript';
import { loadHarnessRegistry } from '../harness-registry';
import { activeWorkspaceId } from '../workspace-registry';
import type { ClaimTimeEnrichmentSubject } from '../claim-time-enrichment';
import { DEFAULT_PACKER_EFFECTS, packerFacade, type PackerEffects, type PackerResult } from './packer-facade';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import type { CodeIntelAnswer } from './contracts';
import { getClaimTimePlanDecisions, type ClaimTimePlanDecisionsBrief } from '../plan-decisions-claim-port';

export const TASK_BRIEF_BUDGET_MS = 6_000;
export const TASK_BRIEF_MAX_CHARS = 3_000;
const MAX_FILES = 12;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Ref = { workItem?: ClaimTimeEnrichmentSubject | null; harness?: string | null; workspaceId?: string | null };
export interface TaskBrief {
  status: 'current' | 'unknown';
  scope: { harness: string | null; paths: string[] };
  repository?: { workspaceId: string; rootPath: string };
  decisions?: { status: 'measured' | 'unknown'; refs: { plan: string; id: string }[];
    recover: { tool: 'plans:get'; args: { slug: string; harness: string; heading: 'Decisions' } } };
  sourceFingerprint: string | null;
  commit: string | null;
  files: { path: string; sha256: string; kind: 'implementation' | 'test' | 'doc' }[];
  excerpts: { path: string; text: string }[];
  graph: { status: 'measured' | 'unknown'; consumers: string[]; relationships: string[]; reason?: string };
  exclusions: string[];
  recover: { tool: 'code:pack'; args: { op: 'pack'; include: string[]; rootPath: string } }
    | { tool: 'work_items:get'; args: { id: string; harness?: string } };
}
export interface TaskBriefDeps {
  root: (workspaceId: string, harness: string) => Promise<string | null>;
  effects: PackerEffects;
  pack: typeof packerFacade;
  graph: (root: string, name: string, file: string, paths: string[], budgetMs: number) => Promise<CodeIntelAnswer>;
  decisions?: (ref: Ref) => Promise<ClaimTimePlanDecisionsBrief | null>;
}
const defaults: TaskBriefDeps = {
  root: async (workspaceId, harness) =>
    (await loadHarnessRegistry(workspaceId)).projects.find(project => project.slug === harness)?.path ?? null,
  effects: DEFAULT_PACKER_EFFECTS,
  pack: packerFacade,
  graph: (root, name, filePath, paths, budgetMs) => firstPartyCallersOffthread({
    root, vendorDir: LSP_VENDOR_DIR, name, filePath, paths, op: 'callers', limit: 8,
  }, { budgetMs }),
  decisions: ref => getClaimTimePlanDecisions({ workItem: ref.workItem ? { payload: ref.workItem.payload } : undefined,
    planSlug: ref.workItem?.sourcePlanSlug, harness: ref.workItem?.harness ?? ref.harness,
    workspaceId: ref.workspaceId ?? activeWorkspaceId() }),
};
const inside = (root: string, file: string) => {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};
const safePath = (path: string) => Boolean(path.trim()) && path !== '.' && !isAbsolute(path)
  && !path.startsWith('-') && !/[\\\r\n\0*?\[\]{},]/.test(path)
  && !path.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'));
const kindOf = (path: string): TaskBrief['files'][number]['kind'] =>
  /\.(?:md|mdx)$/.test(path) ? 'doc' : /(?:^|\/)(?:tests?|__tests__)(?:\/|\.)|\.(?:test|spec)\./.test(path) ? 'test' : 'implementation';

/** Root authority is the workspace registry, never payload.rootPath or operator cwd. */
export async function buildTaskBrief(ref: Ref, deps: TaskBriefDeps = defaults): Promise<TaskBrief> {
  const wi = ref.workItem;
  const harness = wi?.harness ?? ref.harness ?? null;
  const payload = wi?.payload as { paths?: unknown } | null;
  const requested = Array.isArray(payload?.paths) ? payload.paths.filter((path): path is string => typeof path === 'string') : [];
  const brief: TaskBrief = {
    status: 'unknown', scope: { harness, paths: [] }, sourceFingerprint: null, commit: null,
    files: [], excerpts: [], graph: { status: 'unknown', consumers: [], relationships: [] }, exclusions: [],
    recover: { tool: 'work_items:get', args: { id: wi?.id ?? '', ...(harness ? { harness } : {}) } },
  };
  const finish = () => {
    // Omit whole records, preserving explicit omissions and recovery rather than clipping code.
    if (JSON.stringify(brief).length > TASK_BRIEF_MAX_CHARS) brief.exclusions.push('Additional inline evidence omitted; use the scoped recovery readers.');
    while (JSON.stringify(brief).length > TASK_BRIEF_MAX_CHARS && brief.excerpts.length) brief.excerpts.pop();
    while (JSON.stringify(brief).length > TASK_BRIEF_MAX_CHARS && brief.graph.relationships.length) brief.graph.relationships.pop();
    while (JSON.stringify(brief).length > TASK_BRIEF_MAX_CHARS && brief.graph.consumers.length) brief.graph.consumers.pop();
    // Long repository paths can consume the budget even without excerpts. Keep
    // the scoped pack reader and a measured card before omitting the whole brief.
    while (JSON.stringify(brief).length > TASK_BRIEF_MAX_CHARS && brief.files.length > 1) brief.files.pop();
    while (JSON.stringify(brief).length > TASK_BRIEF_MAX_CHARS && brief.decisions?.refs.length) brief.decisions.refs.pop();
    if (JSON.stringify(brief).length > TASK_BRIEF_MAX_CHARS) {
      brief.files = []; brief.excerpts = []; brief.scope.paths = [];
      brief.status = 'unknown'; brief.sourceFingerprint = null; brief.commit = null;
      brief.graph = { status: 'unknown', consumers: [], relationships: [], reason: 'Task scope could not fit the inline budget.' };
      delete brief.repository; delete brief.decisions;
      brief.exclusions = ['Task scope exceeded the inline brief budget; use the recovery reader.'];
      brief.recover = { tool: 'work_items:get', args: { id: wi?.id ?? '', ...(harness ? { harness } : {}) } };
    }
    return brief;
  };
  if (!wi?.id || !harness || requested.length === 0) {
    brief.exclusions.push('No identified work item, registered harness, or stored payload.paths; no repository scope was inferred.');
    return finish();
  }
  const deadline = Date.now() + TASK_BRIEF_BUDGET_MS;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('task brief deadline exceeded');
    return ms;
  };
  const effects: PackerEffects = { ...deps.effects, exec: (bin, argv, opts) => deps.effects.exec(bin, argv, {
    ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? TASK_BRIEF_BUDGET_MS, remaining()),
    maxBuffer: Math.min(opts?.maxBuffer ?? 262144, 262144),
  }) };
  try {
    const workspaceId = ref.workspaceId ?? activeWorkspaceId();
    const registered = await deps.root(workspaceId, harness);
    if (!registered) throw new Error('harness is not registered in the task workspace');
    const root = await realpath(registered);
    brief.repository = { workspaceId, rootPath: root };
    const planPayload = wi.payload as { plan_item?: { plan_slug?: string } } | null;
    const planSlug = wi.sourcePlanSlug ?? planPayload?.plan_item?.plan_slug;
    if (planSlug) {
      const authority = await deps.decisions?.({ ...ref, workspaceId, harness }).catch(() => null);
      brief.decisions = { status: authority && !authority.authorityReadFailed ? 'measured' : 'unknown',
        refs: authority?.decisions.slice(0, 8).map(decision => ({ plan: decision.sourcePlanSlug ?? authority.planSlug, id: decision.id })) ?? [],
        recover: { tool: 'plans:get', args: { slug: planSlug, harness, heading: 'Decisions' } } };
      if (!authority || authority.authorityReadFailed || authority.totalDecisions > brief.decisions.refs.length) {
        brief.exclusions.push('Governing decision bodies or unread authority remain at the canonical plan reader.');
      }
    }
    for (const path of [...new Set(requested)].slice(0, 8)) {
      if (!safePath(path)) { brief.exclusions.push('Rejected unsafe, hidden, or unbounded stored task path.'); continue; }
      try {
        const abs = await realpath(join(root, path));
        if (!inside(root, abs)) { brief.exclusions.push('Rejected task path escaping its registered repository.'); continue; }
        if ((await stat(abs)).isDirectory()) {
          const { stdout } = await effects.exec('rg', ['--files', '--', path], { cwd: root });
          brief.scope.paths.push(...stdout.split(/\r?\n/).filter(Boolean));
        } else brief.scope.paths.push(path);
      } catch { brief.exclusions.push('A stored task path is unavailable.'); }
    }
    if (requested.length > 8 || brief.scope.paths.length > MAX_FILES) brief.exclusions.push('Additional task paths omitted by the bounded selection.');
    const candidates = [...new Set(brief.scope.paths)].filter(safePath).sort().slice(0, MAX_FILES);
    brief.scope.paths = [];
    const texts = new Map<string, string>();
    for (const path of candidates) {
      const abs = await realpath(join(root, path));
      if (!inside(root, abs) || (await stat(abs)).size > 64_000) { brief.exclusions.push('Escaping or oversized task source omitted.'); continue; }
      // Metadata may cover docs and tests, but no source excerpt is emitted before safe packing.
      texts.set(path, await readFile(abs, 'utf8'));
      brief.scope.paths.push(path);
    }
    if (!brief.scope.paths.length) throw new Error('no accessible bounded task files');
    brief.recover = { tool: 'code:pack', args: { op: 'pack', include: brief.scope.paths, rootPath: root } };
    const before = hash(JSON.stringify([...texts].map(([path, text]) => [path, hash(text)])));
    const packed: PackerResult = await deps.pack('pack', {
      rootPath: root, include: brief.scope.paths, format: 'xml', compress: false,
    }, effects);
    if (packed.answer.error || !packed.artifact?.path) throw new Error(packed.answer.error ?? 'safe pack unavailable');
    const after = await Promise.all([...texts.keys()].map(async path => [path, hash(await readFile(join(root, path), 'utf8'))]));
    if (hash(JSON.stringify(after)) !== before) throw new Error('task source changed while packing; re-read before using excerpts');
    brief.sourceFingerprint = before;
    brief.commit = packed.artifact.provenance.commit;
    const included = new Set(packed.answer.sites.map(site => site.path));
    brief.files = [...texts].filter(([path]) => included.has(path)).map(([path, text]) => ({ path, sha256: hash(text), kind: kindOf(path) }));
    const body = await readFile(packed.artifact.path, 'utf8');
    for (const match of body.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g)) {
      if (included.has(match[1]!) && brief.files.some(file => file.path === match[1])) {
        brief.excerpts.push({ path: match[1]!, text: match[2]!.trim().slice(0, 350) });
      }
    }
    for (const path of texts.keys()) if (!included.has(path)) brief.exclusions.push('A scoped file was excluded by the safe packer.');
    const implementation = brief.files.find(file => {
      if (file.kind !== 'implementation' || !/\.[cm]?[jt]sx?$/.test(file.path)) return false;
      const source = ts.createSourceFile(file.path, texts.get(file.path)!, ts.ScriptTarget.Latest, true);
      return source.statements.some(statement => (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name);
    });
    if (implementation) {
      brief.excerpts.sort((a, b) => Number(b.path === implementation.path) - Number(a.path === implementation.path));
      const source = ts.createSourceFile(implementation.path, texts.get(implementation.path)!, ts.ScriptTarget.Latest, true);
      const declaration = source.statements.find(statement =>
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name);
      const name = declaration && (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) ? declaration.name?.text : null;
      if (name) {
        const graph = await deps.graph(root, name, implementation.path, brief.scope.paths, Math.min(2_000, remaining()));
        const scope = graph.evidence?.sourceScope;
        if (!graph.error && scope?.repositoryId && scope.supportingFiles.length
          && scope.supportingFiles.every(file => texts.has(file.path) && file.contentHash === hash(texts.get(file.path)!))) {
          brief.graph = { status: 'measured', consumers: graph.sites.filter((site, index) => texts.has(site.path)
            && graph.evidence?.relationships.some(edge => edge.siteIndex === index && edge.knowledge === 'observed'))
            .map(site => `${site.path}:${site.line1 ?? '?'}`),
            relationships: (graph.evidence?.relationships ?? []).slice(0, 8).map(edge => `${edge.knowledge}:${edge.kind}:${edge.source?.site.path ?? '?'}->${edge.target?.site.path ?? '?'}`) };
          if (graph.truncation.truncated) brief.exclusions.push('Additional compiler sites omitted by the bounded query.');
        } else brief.graph.reason = graph.error?.slice(0, 180) ?? 'Compiler evidence is unavailable or outside the measured task files.';
      } else brief.graph.reason = 'No named function or class in the bounded implementation scope.';
    } else brief.graph.reason = 'No supported implementation in the stored task scope.';
    const final = await Promise.all([...texts.keys()].map(async path => {
      if (!inside(root, await realpath(join(root, path)))) throw new Error('task source escaped during capture');
      return [path, hash(await readFile(join(root, path), 'utf8'))];
    }));
    if (hash(JSON.stringify(final)) !== before) throw new Error('task source changed during compiler capture; re-read the brief');
    brief.status = 'current';
    brief.exclusions.push('Evidence outside the stored task scope is excluded; compiler dependencies may be read internally. Static consumers do not prove runtime execution.');
    return finish();
  } catch (error) {
    brief.files = []; brief.excerpts = []; brief.sourceFingerprint = null;
    brief.graph = { status: 'unknown', consumers: [], relationships: [], reason: 'No current compiler evidence.' };
    brief.exclusions.push(error instanceof Error ? error.message.slice(0, 220) : 'task brief unavailable');
    return finish();
  }
}

export async function getClaimTimeTaskBrief(ref: Ref): Promise<{ taskBrief: TaskBrief } | null> {
  const payload = ref.workItem?.payload as { paths?: unknown } | null;
  if (!ref.workItem?.id || !Array.isArray(payload?.paths) || payload.paths.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return { taskBrief: await Promise.race([buildTaskBrief(ref), new Promise<TaskBrief>(resolve => {
      timer = setTimeout(() => resolve({ status: 'unknown', scope: { harness: ref.workItem?.harness ?? ref.harness ?? null, paths: [] },
        sourceFingerprint: null, commit: null, files: [], excerpts: [],
        graph: { status: 'unknown', consumers: [], relationships: [] }, exclusions: ['Task brief exceeded its bounded read deadline.'],
        recover: { tool: 'work_items:get', args: { id: ref.workItem?.id ?? '' } } }), TASK_BRIEF_BUDGET_MS);
    })]) };
  } finally { clearTimeout(timer); }
}
