/**
 * `graph:query { op:'callers' }` from the first-party backend (WI-10006543).
 *
 * Plan `gitnexus-deterministic-integration-2026-10-05`, D-026: the vendored
 * TypeScript's call hierarchy is the graph backend of record. This module answers
 * "who calls NAME" from it, scoped so a single query costs seconds, not the
 * 13.9 GiB whole-tree program the bench built.
 *
 * ── How one question is answered ───────────────────────────────────────────
 *  1. CANDIDATES. `rg -l -w -F NAME` over source files. A file that does not
 *     contain the word cannot call it, so this is the search space grep itself
 *     answers from. ripgrep's defaults apply: gitignored, hidden and
 *     node_modules paths are not searched.
 *  2. PROGRAM. A LanguageService rooted at the candidates; every other source
 *     file is reduced to its re-export statements (typescript-service.ts
 *     `reExportStub`, which documents why that is enough and how it was measured).
 *  3. RESOLVED callers. The call hierarchy into EVERY declaration named NAME,
 *     unioned. grep never chooses between same-named symbols, so neither does
 *     this: there is no "ambiguous" refusal. Each site is a call line.
 *  4. UNATTRIBUTED calls. Every syntactic `NAME(…)`, `x.NAME(…)` or
 *     `new NAME(…)` in a candidate file that step 3 did not cover, with the
 *     checker's reason: it resolves outside the repo (a default-lib or package
 *     declaration), elsewhere in the repo, or not at all (an untyped receiver,
 *     JS). These are the call lines a grep finds that a pure call graph drops.
 *     Listing them is what makes an empty answer mean what grep's absence
 *     means: no call to NAME in any searched source file.
 *
 * Comments, strings and the declarations themselves are not calls, so they are
 * not sites. That is the one way this answer is deliberately narrower than grep.
 *
 * Pure and synchronous over the file system. It blocks for seconds, so the
 * operator runs it off the main thread (first-party-callers-offthread.ts).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import type * as TsModule from 'typescript';
import { unmeasuredSourceEvidence, versionedSymbolIdentity, type CodeIntelAnswer, type CodeIntelSourceEvidence, type CodeIntelSourceFile, type SymbolSite } from './contracts.ts';
// Explicit `.ts`: the off-thread worker runs this graph under Node's native type
// stripping, which resolves no extension-less relative import.
import {
  incomingCallSites,
  isExternalPath,
  openScopedTsTree,
  tsDeclarations,
  type Ts,
} from './typescript-service.ts';

/** ripgrep glob for every extension the program takes (typescript-service TS_TREE_EXTENSIONS). */
export const FIRST_PARTY_SOURCE_GLOB = '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

/** A name this backend can ask about: one JavaScript identifier. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Default cap on returned sites. Matches the facade budget graph:query documents. */
export const FIRST_PARTY_CALLERS_DEFAULT_LIMIT = 500;

/** How an unattributed call resolves, as the checker sees it. */
export type UnattributedReason = 'external' | 'other-in-repo' | 'unresolved';

export interface FirstPartyCallersAttribution {
  /** Sites the call hierarchy links to a declaration named NAME. */
  readonly resolved: number;
  /** Syntactic calls the hierarchy did not cover, by checker reason. */
  readonly unattributed: Readonly<Record<UnattributedReason, number>>;
  /** Every declaration named NAME the resolved set unions over (capped at 50). */
  readonly declarations: readonly SymbolSite[];
  readonly declarationCount: number;
  /** Source files containing NAME as a word: the program's root files. */
  readonly candidateFiles: number;
  /** Other in-repo files the program reached, served as re-export stubs. */
  readonly stubbedFiles: number;
}

export interface FirstPartyCallersAnswer extends CodeIntelAnswer {
  readonly attribution: FirstPartyCallersAttribution | null;
}

export interface FirstPartyCallersQuery {
  readonly ts: Ts;
  /** Absolute repository root; site paths are relative to it. */
  readonly root: string;
  /** Registry identity when the dispatching repository registry supplies one. */
  readonly repositoryId?: string;
  readonly name: string;
  readonly limit?: number;
  /**
   * Repository-relative files or directories to search (WI-10006543). Default: the
   * whole repository. A grep over `packages/x/lib apps/y/bin` asks about those roots
   * only; answering it repo-wide costs a program over every file that names a common
   * identifier (`fetch`: 2,578 files exhausted the worker's heap).
   */
  readonly paths?: readonly string[];
  /** ripgrep binary. Default: {@link resolveRipgrep}. */
  readonly rgPath?: string;
  readonly now?: () => number;
}

/** At most this many search roots per question. */
export const FIRST_PARTY_CALLERS_MAX_PATHS = 50;

/**
 * Normalise caller-supplied search roots: repository-relative, existing, and never
 * outside the repository. Returns the roots to hand ripgrep, or why they cannot be
 * searched. An empty or absent list means the whole repository.
 */
export function resolveSearchPaths(
  root: string,
  paths: readonly string[] | undefined,
): { ok: true; paths: string[]; scoped: boolean } | { ok: false; error: string } {
  if (!paths || paths.length === 0) return { ok: true, paths: ['.'], scoped: false };
  if (paths.length > FIRST_PARTY_CALLERS_MAX_PATHS) {
    return { ok: false, error: `callers takes at most ${FIRST_PARTY_CALLERS_MAX_PATHS} paths; got ${paths.length}` };
  }
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed || isAbsolute(trimmed)) {
      return { ok: false, error: `path "${raw}" must be relative to the repository root` };
    }
    const rel = posix(relative(root, join(root, trimmed)));
    if (rel === '..' || rel.startsWith('../')) return { ok: false, error: `path "${raw}" is outside the repository` };
    const normalised = rel === '' ? '.' : rel;
    try {
      accessSync(join(root, normalised), fsConstants.R_OK);
    } catch {
      return { ok: false, error: `path "${raw}" does not exist in the repository` };
    }
    if (!out.includes(normalised)) out.push(normalised);
  }
  return { ok: true, paths: out, scoped: !out.includes('.') };
}

export interface CandidateSearch {
  /** Absolute paths. */
  readonly files: readonly string[];
  /** Set when ripgrep could not answer at all. */
  readonly error: string | null;
  /** Set when ripgrep answered but reported unreadable paths (exit 2 with matches). */
  readonly partial: string | null;
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The ripgrep binary to run, or null. An operator under a systemd user unit
 * does not necessarily inherit the login shell's PATH, and ripgrep is commonly
 * installed per user (~/.local/bin, ~/.cargo/bin), so those are searched after
 * PATH. `PAPERCUSP_RG` overrides all of them.
 */
export function resolveRipgrep(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  executable: (path: string) => boolean = isExecutable,
): string | null {
  const override = env.PAPERCUSP_RG?.trim();
  if (override) return isAbsolute(override) && executable(override) ? override : null;
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d)),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const dir of dirs) {
    const candidate = join(dir, 'rg');
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** Source files under `root` (or under its relative `paths`) that contain `name` as a whole word. */
export function findCandidateFiles(
  root: string,
  name: string,
  rgPath = 'rg',
  paths: readonly string[] = ['.'],
): CandidateSearch {
  const r = spawnSync(
    rgPath,
    ['-l', '-w', '-F', '-g', FIRST_PARTY_SOURCE_GLOB, '-g', '!**/node_modules/**', '--', name, ...paths],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.error) return { files: [], error: `ripgrep could not run (${rgPath}): ${r.error.message}`, partial: null };
  if (r.status === 1) return { files: [], error: null, partial: null };
  const files = r.stdout.split('\n').filter(Boolean).map((p) => join(root, p.replace(/^\.\//, '')));
  if (r.status === 0) return { files, error: null, partial: null };
  const why = `ripgrep exited ${r.status ?? r.signal}: ${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`.trim();
  // rg exits 2 when any path was unreadable, even after printing matches.
  return files.length > 0 ? { files, error: null, partial: why } : { files: [], error: why, partial: null };
}

/** The name token a call expression invokes, when it is `name`, `x.name`, `x?.name`, `x['name']`. */
function calleeNameNode(ts: Ts, expr: TsModule.Expression): TsModule.Node | null {
  let e: TsModule.Expression = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e;
  if (ts.isPropertyAccessExpression(e)) return e.name;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression;
  return null;
}

const nameText = (ts: Ts, n: TsModule.Node): string =>
  ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? n.text : ts.isStringLiteralLike(n) ? n.text : '';

interface SyntacticCall {
  readonly site: SymbolSite;
  readonly nameNode: TsModule.Node;
}

/** Every `name(…)` / `x.name(…)` / `new name(…)` in one source file. */
function syntacticCalls(ts: Ts, sf: TsModule.SourceFile, path: string, name: string): SyntacticCall[] {
  const out: SyntacticCall[] = [];
  const visit = (node: TsModule.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const nameNode = calleeNameNode(ts, node.expression);
      if (nameNode && nameText(ts, nameNode) === name) {
        const line1 = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
        out.push({ site: { path, line1, kind: null }, nameNode });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const posix = (p: string): string => p.split('\\').join('/');
const keyOf = (s: Pick<SymbolSite, 'path' | 'line1'>): string => `${s.path}:${s.line1 ?? '?'}`;
const bySite = (a: SymbolSite, b: SymbolSite): number => a.path.localeCompare(b.path) || (a.line1 ?? 0) - (b.line1 ?? 0);

/** Why the checker did not put this call in the hierarchy, as a reason and a human detail. */
function classify(
  ts: Ts,
  checker: TsModule.TypeChecker,
  root: string,
  program: TsModule.Program,
  call: SyntacticCall,
): { reason: UnattributedReason; detail: string } {
  let sym = checker.getSymbolAtLocation(call.nameNode);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.declarations?.[0];
  if (!decl) {
    return {
      reason: 'unresolved',
      detail: 'unattributed: the checker cannot type the receiver (any, untyped JS, or a type only inferable outside this query)',
    };
  }
  const sf = decl.getSourceFile();
  const rel = posix(relative(root, sf.fileName));
  if (isExternalPath(rel) || program.isSourceFileDefaultLibrary(sf)) {
    return { reason: 'external', detail: `unattributed: resolves to a declaration outside the repo (${rel.split('/').slice(-2).join('/')})` };
  }
  const line1 = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
  return { reason: 'other-in-repo', detail: `unattributed: resolves to ${rel}:${line1}, which the call hierarchy did not report` };
}

function buildAnswer(
  name: string,
  started: number,
  now: () => number,
  parts: { sites?: SymbolSite[]; total?: number; error?: string | null; attribution?: FirstPartyCallersAttribution | null; limitations?: string[]; evidence?: CodeIntelSourceEvidence },
): FirstPartyCallersAnswer {
  const sites = parts.sites ?? [];
  const total = parts.total ?? sites.length;
  const error = parts.error ?? null;
  return {
    backend: 'typescript-service',
    intent: 'callers',
    query: name,
    sites,
    truncation: { truncated: total > sites.length, totalAvailable: total, continuation: null },
    freshness: {
      health: error ? 'unhealthy' : 'healthy',
      // Built from disk for this query: there is no index to go stale.
      indexedAt: new Date(started).toISOString(),
      staleVsDisk: error ? null : false,
      indexedCommit: null,
    },
    coverage: {
      basis: 'compiler-project',
      sourceCompleteness: 'unverified',
      limitations: [
        'Searched files are the source files ripgrep finds containing the name as a whole word; gitignored, hidden and node_modules paths are not searched.',
        'Unattributed sites are syntactic calls the checker did not link to a declaration of this name; each says why.',
        'A site is a line: two calls on one line are one site.',
        ...(parts.limitations ?? []),
      ],
    },
    latencyMs: Math.round(now() - started),
    error,
    attribution: parts.attribution ?? null,
    ...(parts.evidence ? { evidence: parts.evidence } : {}),
  };
}

/**
 * The answer for a question this backend could not run at all (the off-thread
 * worker failed, timed out, or could not load TypeScript). Never a bare empty:
 * `error` is set and health is unhealthy.
 */
export function failedCallersAnswer(name: string, error: string, startedMs: number, nowMs: number = Date.now(),
  scope?: Pick<FirstPartyCallersQuery, 'root' | 'repositoryId' | 'paths'>): FirstPartyCallersAnswer {
  const result = buildAnswer(name, startedMs, () => nowMs, { error });
  return { ...result, evidence: unmeasuredCallersEvidence(result, scope) };
}

function unmeasuredCallersEvidence(result: Pick<CodeIntelAnswer, 'intent' | 'sites'>,
  scope?: Pick<FirstPartyCallersQuery, 'root' | 'repositoryId' | 'paths'>): CodeIntelSourceEvidence {
  let repositoryId = scope?.repositoryId ?? null;
  let identityKind: CodeIntelSourceEvidence['sourceScope']['identityKind'] = repositoryId ? 'registry' : 'unknown';
  if (!repositoryId && scope?.root) {
    try {
      repositoryId = `local-root:${createHash('sha256').update(realpathSync(scope.root)).digest('hex')}`;
      identityKind = 'local-root';
    } catch { /* An inaccessible root has no verified local identity. */ }
  }
  return unmeasuredSourceEvidence(result, { repositoryId, identityKind,
    paths: scope?.paths ?? ['.'], basis: 'compiler-project' }, [
    'No compiler snapshot was measured; an empty or failed query does not establish source completeness.',
  ]);
}

/** Who calls `name`, from the first-party TypeScript backend. Synchronous: run it off the main thread. */
export function firstPartyCallers(q: FirstPartyCallersQuery): FirstPartyCallersAnswer {
  const now = q.now ?? (() => Date.now());
  const started = now();
  const answer = (name: string, startedAt: number, clock: () => number, parts: Parameters<typeof buildAnswer>[3]) => {
    const result = buildAnswer(name, startedAt, clock, parts);
    return parts.evidence ? result : { ...result, evidence: unmeasuredCallersEvidence(result, q) };
  };
  const limit = Math.max(1, Math.floor(q.limit ?? FIRST_PARTY_CALLERS_DEFAULT_LIMIT));
  if (!IDENTIFIER.test(q.name)) {
    return answer(q.name, started, now, { error: `callers needs one identifier; "${q.name}" is not one` });
  }
  const rgPath = q.rgPath ?? resolveRipgrep();
  if (rgPath === null) {
    return answer(q.name, started, now, {
      error: 'ripgrep (rg) was not found on PATH, in ~/.local/bin, ~/.cargo/bin or the system bin dirs; set PAPERCUSP_RG',
    });
  }
  const scope = resolveSearchPaths(q.root, q.paths);
  if (!scope.ok) return answer(q.name, started, now, { error: scope.error });
  const search = findCandidateFiles(q.root, q.name, rgPath, scope.paths);
  if (search.error) return answer(q.name, started, now, { error: search.error });
  const partial = [
    ...(scope.scoped ? [`Searched only under: ${scope.paths.join(', ')}.`] : []),
    ...(search.partial ? [`ripgrep could not read every path: ${search.partial}`] : []),
  ];
  if (search.files.length === 0) {
    // No searched source file contains the word: as strong an absence as grep's.
    return answer(q.name, started, now, {
      limitations: partial,
      attribution: {
        resolved: 0,
        unattributed: { external: 0, 'other-in-repo': 0, unresolved: 0 },
        declarations: [],
        declarationCount: 0,
        candidateFiles: 0,
        stubbedFiles: 0,
      },
    });
  }

  const tree = openScopedTsTree(q.ts, q.root, search.files);
  try {
    const program = tree.service.getProgram();
    if (!program) return answer(q.name, started, now, { error: 'TypeScript produced no program for the candidate files' });
    const decls = tsDeclarations(tree, program, q.name);
    const resolved = incomingCallSites(tree, program, decls);
    const resolvedKeys = new Set(resolved.map(keyOf));
    const declKeys = new Set(decls.map((d) => keyOf(d.site)));

    const checker = program.getTypeChecker();
    const counts: Record<UnattributedReason, number> = { external: 0, 'other-in-repo': 0, unresolved: 0 };
    const unattributed: SymbolSite[] = [];
    const seen = new Set<string>();
    for (const file of search.files) {
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      for (const call of syntacticCalls(q.ts, sf, posix(relative(q.root, file)), q.name)) {
        const key = keyOf(call.site);
        if (resolvedKeys.has(key) || declKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        const { reason, detail } = classify(q.ts, checker, q.root, program, call);
        counts[reason] += 1;
        unattributed.push({ ...call.site, detail });
      }
    }

    const all = [...resolved.sort(bySite), ...unattributed.sort(bySite)];
    const reported = all.slice(0, limit);
    // Hash the exact compiler snapshots, including re-export stubs. Reading disk
    // after the worker answers could attach a different version to the old sites.
    const sources: CodeIntelSourceFile[] = program.getSourceFiles().flatMap(sf => {
      const path = posix(relative(q.root, sf.fileName));
      if (isExternalPath(path) || program.isSourceFileDefaultLibrary(sf)) return [];
      return [{ path, contentHash: createHash('sha256').update(sf.text).digest('hex'),
        language: /\.[cm]?jsx?$/.test(path) ? 'javascript' : 'typescript',
        representation: tree.rootFiles.has(sf.fileName) ? 'full-source' as const : 'reexport-stub' as const }];
    }).sort((a, b) => a.path.localeCompare(b.path));
    const repositoryId = q.repositoryId ?? `local-root:${createHash('sha256').update(realpathSync(q.root)).digest('hex')}`;
    const sourceByPath = new Map(sources.map(source => [source.path, source]));
    const supporting = new Set(reported.map(site => site.path));
    const evidence: CodeIntelSourceEvidence = {
      schemaVersion: 1,
      sourceScope: { repositoryId, identityKind: q.repositoryId ? 'registry' : 'local-root',
        sourceFingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
        paths: scope.paths, supportingFiles: sources.filter(source => supporting.has(source.path)) },
      graphScope: { basis: 'compiler-project', sourceCompleteness: 'unverified', limitations: [
        ...partial, 'Only candidate files are full compiler inputs; other reached files are re-export stubs.',
        'Compiler or syntactic relationships do not establish runtime execution; unresolved target bindings remain unknown.' ] },
      languageCapabilities: [...new Set(sources.map(source => source.language))].map(language =>
        ({ language, intent: 'callers', status: 'compiler-backed' })),
      siteIdentities: reported.map((site, siteIndex) => ({ siteIndex, sourcePath: site.path,
        contentHash: sourceByPath.get(site.path)?.contentHash ?? null,
        versionedSymbolId: versionedSymbolIdentity(repositoryId, site, sourceByPath.get(site.path)) })),
      relationships: reported.map((site, siteIndex) => ({ siteIndex, kind: 'callers',
        origin: resolvedKeys.has(keyOf(site)) ? 'compiler' : 'syntax',
        knowledge: resolvedKeys.has(keyOf(site)) ? 'observed' : 'unknown', runtimeExecution: 'unknown' })),
    };
    return answer(q.name, started, now, {
      sites: reported,
      evidence,
      total: all.length,
      limitations: partial,
      attribution: {
        resolved: resolved.length,
        unattributed: counts,
        declarations: decls.slice(0, 50).map((d) => d.site),
        declarationCount: decls.length,
        candidateFiles: search.files.length,
        stubbedFiles: tree.stubbedFiles(),
      },
    });
  } catch (err) {
    return answer(q.name, started, now, { error: `TypeScript failed: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    tree.service.dispose();
  }
}
