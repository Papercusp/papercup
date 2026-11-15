import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { dbRefOriginLookup, isOwnerTurnVerdict } from '../../activation-item-provenance';
import { astGrepFacade, type AstGrepLanguage } from '../../code-intelligence/ast-grep-facade';
import { lspFacade } from '../../code-intelligence/lsp-facade';
import type { CitationDeps } from '../../plan-audits';
import { indexDeclaredPackages, readWorkspaceManifests, type DeclaredPackageIndex } from '../../workspace-manifests';
import type { LibraryCheckDeps, ReferenceLookup, ReuseReferenceResolvers } from './plan-declarations';
import type { DependencyBaseline } from './plan-library-ship-check';
import { createHash } from 'node:crypto';
import { discoverySubjectSnapshot, type DiscoveryAuditContext, type DiscoveryAuditPayload } from '../../plan-audits';
import ts from 'typescript';
import { defaultBlobBatchReader, locateCommittedBlobs, readCommittedFiles, resolveMeasurementCommit,
  type CommittedTreeDeps } from './committed-tree-reader';
import { gitBlobId } from './evidence-measurement-pin';
import { previewDiscoveryDeclaration } from './plan-declarations';
import { listSpecEvidence } from './spec-evidence-store';
import { resolveSessionTurnRefs, SESSION_TURN_REF_PREFIX } from '../sessions/_shared';

/** Existing source research and canonical evidence bindings supply facts; the
 * declaration supplies only the conclusion and the selected references. */
export async function resolveDiscoveryAuditContext(content: string, previous: string | null,
  options: DefaultReuseResolverOptions & { harnessSlug: string; ownerId: string; planSlug: string;
    prior?: DiscoveryAuditPayload | null; historicalTargets?: Record<string, string> },
): Promise<DiscoveryAuditContext> {
  const current = discoverySubjectSnapshot(content);
  const before = { ...options.historicalTargets, ...options.prior?.targets,
    ...(previous ? discoverySubjectSnapshot(previous) : {}) };
  const targets: DiscoveryAuditContext['targets'] = [
    ...Object.keys(current).map(ref => ({ ref, change: ref.startsWith('P-') ||
      (options.prior && options.prior.targets[ref] !== current[ref]) ? 'proposed' as const : 'existing' as const })),
    ...Object.keys(before).filter(ref => !(ref in current)).map(ref => ({ ref, change: 'removed' as const })),
  ];
  const refs = [...new Set(previewDiscoveryDeclaration(content).data?.findings.flatMap(row => row.evidenceRefs) ?? [])];
  const evidence: DiscoveryAuditContext['evidence'] = [];
  const proofIds = refs.filter(ref => /^proof:[1-9]\d*$/.test(ref)).map(ref => Number(ref.slice(6)));
  const proofs = proofIds.length && options.workspaceId ? await listSpecEvidence({
    workspaceId: options.workspaceId, harnessSlug: options.harnessSlug, planSlugs: [options.planSlug],
    bindingIds: proofIds, limit: proofIds.length + 1,
  }).catch(() => []) : [];
  const sessionRefs = refs.filter(ref => ref.startsWith(SESSION_TURN_REF_PREFIX));
  const sessionTurns = sessionRefs.length && options.sql && options.workspaceId
    ? await resolveSessionTurnRefs(options.sql, options.workspaceId, sessionRefs, {
      evidenceForOwner: options.ownerId,
    }) : [];
  // Research capture is optional client assistance, not source authority.
  // Resolve every selected source through the existing citation boundary, then
  // measure all of them at their committed HEAD in one batch per repository.
  // A `#<Symbol>` anchor scopes the fingerprint to that declaration (WI-6554700010049338):
  // a committed change elsewhere in a hub file no longer re-stales the finding.
  const sourceRefs = new Map(refs.filter(ref => ref.startsWith('source:'))
    .map(ref => [ref, parseSourceEvidenceRef(ref)] as const));
  const sourceLocations = new Map(await Promise.all([...sourceRefs]
    .map(async ([ref, parsed]) => [ref, await locateReference(options, parsed.path)] as const)));
  const locatedWhere = (anchored: boolean) => [...sourceLocations].flatMap(([ref, row]) =>
    row.location && Boolean(sourceRefs.get(ref)!.anchor) === anchored ? [row.location] : []);
  const [committedDigests, committedTexts] = await Promise.all([
    committedSourceDigests(locatedWhere(false)), committedSourceTexts(locatedWhere(true))]);
  for (const ref of refs.sort()) {
    const unknown = (reason: string) => evidence.push({ ref, state: 'unknown', usable: false, fingerprint: null, reason });
    if (ref.startsWith('source:')) {
      const parsed = sourceRefs.get(ref)!;
      if (parsed.anchorError) { unknown(parsed.anchorError); continue; }
      const located = sourceLocations.get(ref)!;
      if (!located.location) { unknown('reason' in located.lookup ? located.lookup.reason : 'Source unavailable.'); continue; }
      try {
        if (parsed.anchor) {
          const text = committedTexts.get(located.location.absolutePath)
            ?? await readFile(located.location.absolutePath, 'utf8');
          const measured = declarationFingerprint(located.location.relativePath, text, parsed.anchor);
          if ('reason' in measured) unknown(measured.reason);
          else evidence.push({ ref, state: 'current', usable: true, fingerprint: measured.fingerprint });
          continue;
        }
        const bytes = await readFile(located.location.absolutePath);
        evidence.push({ ref, state: 'current', usable: true,
          fingerprint: committedDigests.get(located.location.absolutePath) ?? createHash('sha256').update(bytes).digest('hex') });
      } catch { unknown('The selected source could not be read at finalization.'); }
    } else if (ref.startsWith(SESSION_TURN_REF_PREFIX)) {
      const turn = sessionTurns.find(row => row.ref === ref);
      if (!turn?.ok || !turn.evidence) {
        unknown('The selected session turn is unavailable or not readable for this owner.');
        continue;
      }
      evidence.push({ ref, state: 'current', usable: true, fingerprint: turn.evidence.fingerprint,
        reason: `Measured ${turn.source} session source; origin ${turn.evidence.origin.verdict}. Source readability does not establish owner authority.` });
    } else if (/^proof:[1-9]\d*$/.test(ref)) {
      const proof = proofs.find(row => row.id === Number(ref.slice(6)));
      if (!proof) { unknown('Canonical evidence binding unavailable.'); continue; }
      evidence.push({ ref, state: proof.currentness.overall, usable: !proof.withdrawal &&
        proof.currentness.provenance === 'server-measured' && proof.currentness.overall === 'current' &&
        !['independent-verification', 'manual'].includes(proof.evidenceKind),
      fingerprint: proof.bindingFingerprint ?? null, reason: [...proof.currentness.staleReasons, ...proof.currentness.unknownReasons].join('; ') });
    } else if (ref.startsWith('doc:') && options.sql && options.workspaceId) {
      const [doc] = await options.sql<Array<{ content: string; status: string }>>`
        SELECT content, status FROM harness_shared.harness_docs WHERE workspace_id=${options.workspaceId}
          AND harness_slug=${options.harnessSlug} AND doc_id=${ref.slice(4)} AND retired_at IS NULL
          AND content IS NOT NULL LIMIT 1`.catch(() => []);
      if (!doc) { unknown('Canonical document unavailable.'); continue; }
      evidence.push({ ref, state: doc.status === 'fresh' ? 'current' : 'unknown', usable: doc.status === 'fresh',
        fingerprint: createHash('sha256').update(doc.content).digest('hex') });
    } else unknown('Select source:<path> (or source:<path>#<Symbol> / #<Class.member> to track one declaration), session_turn:<kind>:<session>:<turn>, proof:<canonical binding id>, or doc:<canonical slug>; an invocation alone is not evidence.');
  }
  return { targets, evidence };
}

/**
 * Discovery `source:` evidence is measured at the owning repository's committed HEAD —
 * the basis the ship gate's CitationMeasurement already uses (plan-audits.ts, P-019) — so
 * a peer's UNCOMMITTED edit on the shared tree cannot stale a finding while a COMMITTED
 * change still does (EI-28781813683751020: a dirty work-items.ts re-staled DF-004 between
 * every reconcile and plans:start). The digest is sha256 of the committed bytes, so a clean
 * file keeps exactly the fingerprint the working-tree measurement produced and existing
 * audits stay current. Returns absolutePath → sha256; a path with no committed regular
 * file (untracked, outside a repository top level, unmeasurable) is absent and keeps the
 * working-tree fingerprint, which can only over-report staleness, never waive it.
 */
export async function committedSourceDigests(
  locations: readonly LocatedReference[],
  treeDeps: CommittedTreeDeps = {},
): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  const files = (await Promise.all(locations.map(async location =>
    ((await stat(location.absolutePath).catch(() => null))?.isFile() ? location : null))))
    .filter((location): location is LocatedReference => location !== null);
  const byRoot = new Map<string, LocatedReference[]>();
  for (const file of files) byRoot.set(file.repoRoot, [...(byRoot.get(file.repoRoot) ?? []), file]);
  await Promise.all([...byRoot].map(async ([root, rows]) => {
    try {
      const commit = await resolveMeasurementCommit(root, treeDeps.git);
      if (!commit) return;
      const committed = await readCommittedFiles(root, commit, [...new Set(rows.map(row => row.relativePath))], treeDeps);
      for (const row of rows) {
        const file = committed.get(row.relativePath);
        if (file) digests.set(row.absolutePath, file.sha256);
      }
    } catch {
      // Unmeasured (tree read failed, a cited path is not a regular file at HEAD): this
      // repository's sources keep their working-tree fingerprints.
    }
  }));
  return digests;
}

const SOURCE_ANCHOR_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/;

/** `source:<path>` or `source:<path>#<Name>` / `#<Class.member>`. A malformed anchor is
 * reported, never silently widened to the whole file. */
export function parseSourceEvidenceRef(ref: string): { path: string; anchor: string | null; anchorError?: string } {
  const body = ref.slice('source:'.length);
  const at = body.indexOf('#');
  if (at < 0) return { path: body, anchor: null };
  const anchor = body.slice(at + 1);
  if (SOURCE_ANCHOR_RE.test(anchor)) return { path: body.slice(0, at), anchor };
  return { path: body.slice(0, at), anchor: null,
    anchorError: `Symbol anchor '#${anchor}' is not <Name> or <Class.member>; cite source:<path>#<Symbol>, or the whole file.` };
}

/**
 * The committed text of each anchored source (absolutePath → utf8), measured at the same
 * commit as committedSourceDigests. A path with no committed regular file is absent and
 * keeps its working-tree text, which can only over-report staleness, never waive it.
 */
export async function committedSourceTexts(
  locations: readonly LocatedReference[],
  treeDeps: CommittedTreeDeps = {},
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const readBlobs = treeDeps.readBlobs ?? defaultBlobBatchReader;
  const byRoot = new Map<string, LocatedReference[]>();
  for (const row of locations) byRoot.set(row.repoRoot, [...(byRoot.get(row.repoRoot) ?? []), row]);
  await Promise.all([...byRoot].map(async ([root, rows]) => {
    try {
      const commit = await resolveMeasurementCommit(root, treeDeps.git);
      if (!commit) return;
      const located = await locateCommittedBlobs(root, commit, [...new Set(rows.map(row => row.relativePath))], treeDeps);
      const blobsByRepo = new Map<string, Set<string>>();
      for (const entry of located.values()) {
        if (entry?.isFile) blobsByRepo.set(entry.repo, (blobsByRepo.get(entry.repo) ?? new Set()).add(entry.object));
      }
      const contents = new Map<string, Buffer>();
      for (const [repo, blobs] of blobsByRepo) {
        const read = await readBlobs(repo === '.' ? root : path.posix.join(root, repo), [...blobs]);
        for (const [blob, content] of read) if (gitBlobId(content) === blob) contents.set(blob, content);
      }
      for (const row of rows) {
        const entry = located.get(row.relativePath);
        const content = entry?.isFile ? contents.get(entry.object) : undefined;
        if (content) texts.set(row.absolutePath, content.toString('utf8'));
      }
    } catch {
      // Unmeasured: this repository's anchored sources keep their working-tree text.
    }
  }));
  return texts;
}

const ANCHOR_SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX,
};

function topLevelNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap(d => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement))
    && statement.name && ts.isIdentifier(statement.name)) return [statement.name.text];
  return [];
}

function memberNodes(owner: ts.Statement, member: string): ts.Node[] {
  const members: ReadonlyArray<ts.ClassElement | ts.TypeElement | ts.EnumMember> =
    ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner) || ts.isEnumDeclaration(owner) ? owner.members : [];
  return members.filter(node => node.name !== undefined && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
    || ts.isNumericLiteral(node.name)) && node.name.text === member);
}

/**
 * sha256 over the text of every parser-certified declaration the anchor names, in source
 * order (overloads and merged declarations together): a top-level function, class,
 * interface, type, enum, namespace or variable, or a member of a class, interface or
 * enum. Comments outside the declaration and the rest of the file do not contribute.
 */
export function declarationFingerprint(fileName: string, text: string, anchor: string):
  { fingerprint: string } | { reason: string } {
  const kind = ANCHOR_SCRIPT_KINDS[path.extname(fileName).toLowerCase()];
  if (kind === undefined) {
    return { reason: `Symbol anchors are measured in TypeScript/JavaScript sources only; cite source:${fileName} as a whole file.` };
  }
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const [name, member] = anchor.split('.') as [string, string | undefined];
  const owners = source.statements.filter(statement => topLevelNames(statement).includes(name));
  const nodes = member === undefined ? owners : owners.flatMap(owner => memberNodes(owner, member));
  if (!nodes.length) {
    return { reason: `${fileName} declares no ${member === undefined ? 'top-level' : 'class, interface or enum member'} `
      + `#${anchor} at the measured commit; re-cite the declaration the finding relies on.` };
  }
  return { fingerprint: createHash('sha256').update(nodes.map(node => node.getText(source)).join('\n')).digest('hex') };
}

/**
 * Production lookups for the plan reuse reference resolver (R-4). Kept apart
 * from plan-declarations.ts so the lifecycle gate, which imports the schemas,
 * does not load the code-intelligence and tool-registry graphs.
 *
 *   file     → the tree (fs.stat under the plan's repo root)
 *   symbol   → lsp:query workspace symbols, ast-grep fallback
 *   tool     → the projected tool registry
 *   table    → the PG catalog (to_regclass)
 *   package  → workspace manifests (workspace-manifests.ts)
 *   routine  → harness_shared.routines by name
 *   doc      → harness_shared.harness_docs by slug
 *
 * Every lookup returns `unavailable` (→ "unverified") when its backend is down,
 * so a broken server never refuses a plan and never passes one as found.
 */

const AST_GREP_LANGUAGE_BY_EXT: Record<string, AstGrepLanguage> = {
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
  '.rs': 'rust', '.py': 'python', '.pyi': 'python', '.go': 'go',
};
const LSP_TYPESCRIPT_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);

const unavailable = (reason: string): ReferenceLookup => ({ outcome: 'unavailable', reason });
const found = (via: string): ReferenceLookup => ({ outcome: 'found', via });
const notFound = (via: string): ReferenceLookup => ({ outcome: 'not-found', via });

function insideRoot(repoRoot: string, relPath: string): string | null {
  const abs = path.resolve(repoRoot, relPath);
  const rel = path.relative(repoRoot, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

type LocatedReference = { repoRoot: string; absolutePath: string; relativePath: string };

/** Keep the citation policy's owning root; never reinterpret an admitted sibling
 * relative to the parent, and never let a symlink widen that admission. */
async function locateReference(options: DefaultReuseResolverOptions, relPath: string): Promise<{
  lookup: ReferenceLookup; location?: LocatedReference;
}> {
  if (!options.repoRoot) return { lookup: unavailable('the plan\'s repository root could not be resolved') };
  try {
    const deps = options.citationDeps;
    const selected = deps?.locateRepository
      ? deps.locateRepository(relPath)
      : { repoRoot: options.repoRoot, absolutePath: deps?.locate ? deps.locate(relPath, options.repoRoot) : insideRoot(options.repoRoot, relPath) };
    if (!selected?.absolutePath) return { lookup: unavailable('citation path is not admitted') };
    const root = await realpath(selected.repoRoot);
    let absolutePath: string;
    try { absolutePath = await realpath(selected.absolutePath); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { lookup: code === 'ENOENT' || code === 'ENOTDIR'
        ? notFound('no such path in the admitted tree') : unavailable(`tree read failed: ${code ?? String(error)}`) };
    }
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
      return { lookup: unavailable('canonical path escapes its admitted repository') };
    }
    const info = await stat(absolutePath);
    return { lookup: found(`${info.isDirectory() ? 'directory' : 'file'} in admitted tree: ${absolutePath}`),
      location: { repoRoot: root, absolutePath, relativePath } };
  } catch (error) {
    return { lookup: unavailable(`citation context unavailable: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

/** Names are extracted only from parser-certified declaration nodes, never from
 * arbitrary identifier occurrences, comments, strings, imports or call sites. */
function declarationName(language: AstGrepLanguage, text: string): string | null {
  const pattern = language === 'rust'
    ? /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern\s+"[^"]*")\s+)*(?:fn|struct|enum|trait|type)\s+([A-Za-z_$][\w$]*)/
    : language === 'python'
      ? /^(?:async\s+)?(?:def|class)\s+([A-Za-z_$][\w$]*)/
      : language === 'go'
        ? /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_$][\w$]*)/
        : /^(?:(?:export|default|declare|async|abstract)\s+)*(?:function\s*\*?\s*|class\s+|interface\s+|type\s+)([A-Za-z_$][\w$]*)/;
  return pattern.exec(text.trim())?.[1] ?? null;
}

export interface DefaultReuseResolverOptions {
  /** Repository root the plan's paths are relative to (the citation root); null when it could not be resolved. */
  repoRoot: string | null;
  /** Existing citation context, including admitted sibling/registered repository identity. */
  citationDeps?: Pick<CitationDeps, 'locate' | 'locateRepository'> | null;
  /** Operator database handle for the table, routine and doc lookups. */
  sql?: postgres.Sql<any> | null;
  workspaceId?: string | null;
}

/**
 * Production lookups for the library checks (R-5): the shared manifest walk, the
 * session-turn origin classifier the item-provenance check uses, and installed
 * dependencies' package descriptions for the researched-row advice. Any lookup
 * that cannot be built is null, which leaves its rows unverified.
 */
export async function defaultLibraryCheckDeps(options: DefaultReuseResolverOptions): Promise<LibraryCheckDeps> {
  const { repoRoot, sql, workspaceId } = options;
  const manifests = repoRoot ? await readWorkspaceManifests(repoRoot).catch(() => null) : null;
  const packages = manifests ? indexDeclaredPackages(manifests) : null;
  const lookupOrigins = sql && workspaceId ? dbRefOriginLookup(sql as Parameters<typeof dbRefOriginLookup>[0], workspaceId) : null;
  return {
    packages,
    ownerTurns: lookupOrigins
      ? async (refs) => {
          const verdicts = await lookupOrigins(refs);
          return new Map([...verdicts].map(([ref, verdict]) => [ref, isOwnerTurnVerdict(verdict) ? 'owner' as const : 'not-owner' as const]));
        }
      : null,
    dependencyDescriptions: manifests && repoRoot
      ? async () => {
          const names = [...new Set(manifests.filter((m) => m.ecosystem === 'npm').flatMap((m) => m.dependencies))];
          const entries = await Promise.all(names.map(async (name) => {
            try {
              const pkg = JSON.parse(await readFile(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8')) as { description?: unknown };
              return typeof pkg.description === 'string' ? [name, pkg.description] as const : null;
            } catch {
              return null;
            }
          }));
          return new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null));
        }
      : null,
  };
}

export function defaultReuseReferenceResolvers(options: DefaultReuseResolverOptions): ReuseReferenceResolvers {
  const { repoRoot, sql } = options;
  let packageIndex: Promise<DeclaredPackageIndex> | null = null;
  const noRoot = unavailable('the plan\'s repository root could not be resolved');
  const packages = (root: string) => (packageIndex ??= readWorkspaceManifests(root).then(indexDeclaredPackages));

  return {
    file: async (ref) => (await locateReference(options, ref.path!)).lookup,

    symbol: async (ref) => {
      if (!repoRoot) return noRoot;
      const located = await locateReference(options, ref.path!);
      if (!located.location) return located.lookup;
      const { repoRoot: symbolRoot, relativePath: file } = located.location;
      const name = ref.symbol!;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return unavailable('only one terminal declaration identifier is supported');
      const ext = path.extname(file).toLowerCase();
      let lspDetail = 'lsp not consulted for this language';
      if (LSP_TYPESCRIPT_EXTS.has(ext)) {
        try {
          const answer = await lspFacade('workspace_symbols', { name, file, rootPath: symbolRoot, limit: 50 }, { workspaceId: options.workspaceId ?? undefined });
          const exact = answer.sites.filter((site) => site.path === file && site.name === name);
          if (!answer.error && answer.truncation?.truncated) return unavailable('lsp symbol set is truncated');
          if (!answer.error && exact.length > 1) return unavailable('symbol identity is ambiguous in the admitted file');
          if (!answer.error && exact.length === 1) return found(`unique lsp declaration in ${located.location.absolutePath}`);
          lspDetail = answer.error ? `lsp unavailable: ${answer.error}` : 'lsp found no declaration in that file';
        } catch (error) {
          lspDetail = `lsp unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const language = AST_GREP_LANGUAGE_BY_EXT[ext];
      if (!language) return unavailable(`${lspDetail}; ast-grep has no grammar for ${ext || 'this file'}`);
      const syntax = await astGrepFacade('syntax_index', { pattern: name, language, paths: [file], rootPath: symbolRoot, limit: 500 })
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error), sites: [],
          truncation: { truncated: false }, evidence: undefined }));
      if (syntax.error) return unavailable(`${lspDetail}; ast-grep unavailable: ${syntax.error}`);
      if (syntax.truncation?.truncated) return unavailable('syntax declaration set is truncated');
      const declarations = syntax.sites.filter((site) => site.path === file && site.kind === 'declaration'
        && declarationName(language, site.detail ?? '') === name);
      if (declarations.length > 1) return unavailable('symbol identity is ambiguous in the admitted file');
      if (declarations.length === 1) return found(`unique parsed declaration in ${located.location.absolutePath}`);
      if (!syntax.evidence?.sourceScope.supportingFiles?.some((source) => source.path === file)) {
        return unavailable('syntax backend did not certify this source file');
      }
      // This index covers selected declaration forms, not every binding a
      // language can express. An empty result cannot certify symbol absence.
      return unavailable(`${name} has no uniquely certified supported declaration in ${file}`);
    },

    tool: async (ref) => {
      let names: Set<string>;
      try {
        names = new Set(listAllProjectedTools().flatMap((tool) => [tool.expose.mcp?.name, (tool as { name?: string }).name]).filter((n): n is string => !!n));
      } catch (error) {
        return unavailable(`tool registry unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (names.size === 0) return unavailable('tool registry is empty');
      if (names.has(ref.name!)) return found('projected tool registry');
      // Plugin tools (server.verb) are not projected into the registry.
      if (!ref.name!.includes(':')) return unavailable('plugin tools (server.verb) are not in the projected tool registry');
      return notFound('no such tool in the projected tool registry');
    },

    table: async (ref) => {
      if (!sql) return unavailable('no database handle');
      try {
        const rows = await sql<{ present: boolean }[]>`SELECT to_regclass(${`${ref.schema}.${ref.table}`}) IS NOT NULL AS present`;
        return rows[0]?.present ? found('PG catalog') : notFound('no such relation in the PG catalog');
      } catch (error) {
        return unavailable(`PG catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    package: async (ref) => {
      if (!repoRoot) return noRoot;
      try {
        const matches = (await packages(repoRoot)).find(ref.name!);
        return matches.length > 0 ? found(`declared in ${matches[0]!.path}`) : notFound('declared in no workspace manifest');
      } catch (error) {
        return unavailable(`workspace manifests unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    routine: async (ref) => {
      if (!sql) return unavailable('no database handle');
      try {
        const rows = await sql`SELECT 1 FROM harness_shared.routines WHERE name = ${ref.name!} LIMIT 1`;
        return rows.length > 0 ? found('routine registry') : notFound('no routine with that name');
      } catch (error) {
        return unavailable(`routine registry unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    doc: async (ref) => {
      if (!sql) return unavailable('no database handle');
      try {
        const rows = await sql`SELECT 1 FROM harness_shared.harness_docs WHERE doc_id = ${ref.name!} LIMIT 1`;
        return rows.length > 0 ? found('docs store') : notFound('no doc with that slug');
      } catch (error) {
        return unavailable(`docs store unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * R-6 baseline (D-013 #4): every dependency name the workspace manifests declare
 * at activation, recorded on the activation audit row. Null when the manifests
 * cannot be read, which leaves the ship check unverified rather than wrong.
 */
export async function captureDependencyBaseline(repoRoot: string | null): Promise<DependencyBaseline | null> {
  if (!repoRoot) return null;
  const manifests = await readWorkspaceManifests(repoRoot).catch(() => null);
  if (!manifests) return null;
  const packages = new Set(manifests.filter((manifest) => manifest.ecosystem === 'npm').flatMap((manifest) => manifest.dependencies));
  return { packages: [...packages].sort(), manifests: manifests.length, capturedAt: new Date().toISOString() };
}

/** The npm workspace packages' own names: imports of these are first-party, not third-party. */
export async function readWorkspacePackageNames(repoRoot: string): Promise<Set<string> | null> {
  const manifests = await readWorkspaceManifests(repoRoot).catch(() => null);
  if (!manifests) return null;
  return new Set(manifests.flatMap((manifest) => (manifest.ecosystem === 'npm' && manifest.name ? [manifest.name] : [])));
}

/**
 * `filesChanged` from the completions of the plan's work-items (linked by
 * source_plan_slug or by the plan_item payload), the ship check's second
 * population source. Null when the ledger cannot be read.
 */
export async function readPlanCompletionFilesChanged(input: {
  sql: postgres.Sql<any>;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}): Promise<string[] | null> {
  try {
    const rows = await input.sql<{ path: string }[]>`
      SELECT DISTINCT p.path
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(wi.payload->'_completionEvidence'->'filesChanged') = 'array'
               THEN wi.payload->'_completionEvidence'->'filesChanged' ELSE '[]'::jsonb END
          || CASE WHEN jsonb_typeof(wi.payload->'_completionEvidence'->'verification'->'filesChanged') = 'array'
               THEN wi.payload->'_completionEvidence'->'verification'->'filesChanged' ELSE '[]'::jsonb END) p(path)
       WHERE wi.workspace_id = ${input.workspaceId}
         AND wi.harness_slug = ${input.harnessSlug}
         AND (wi.source_plan_slug = ${input.planSlug} OR wi.payload->'plan_item'->>'plan_slug' = ${input.planSlug})
       ORDER BY p.path
       LIMIT 2000`;
    return rows.map((row) => row.path).filter((p) => p.length > 0 && !p.startsWith('/') && !p.split('/').includes('..'));
  } catch {
    return null;
  }
}
