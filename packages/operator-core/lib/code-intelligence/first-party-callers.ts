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
import { join, relative } from 'node:path';
import type * as TsModule from 'typescript';
import type { CodeIntelAnswer, SymbolSite } from './contracts';
import {
  incomingCallSites,
  isExternalPath,
  openScopedTsTree,
  tsDeclarations,
  type Ts,
} from './typescript-service';

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
  readonly name: string;
  readonly limit?: number;
  /** ripgrep binary. Default `rg` from PATH (the desktop install ships a shim). */
  readonly rgPath?: string;
  readonly now?: () => number;
}

export interface CandidateSearch {
  /** Absolute paths. */
  readonly files: readonly string[];
  /** Set when ripgrep could not answer at all. */
  readonly error: string | null;
  /** Set when ripgrep answered but reported unreadable paths (exit 2 with matches). */
  readonly partial: string | null;
}

/** Source files under `root` that contain `name` as a whole word. */
export function findCandidateFiles(root: string, name: string, rgPath = 'rg'): CandidateSearch {
  const r = spawnSync(
    rgPath,
    ['-l', '-w', '-F', '-g', FIRST_PARTY_SOURCE_GLOB, '-g', '!**/node_modules/**', '--', name, '.'],
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

function answer(
  name: string,
  started: number,
  now: () => number,
  parts: { sites?: SymbolSite[]; total?: number; error?: string | null; attribution?: FirstPartyCallersAttribution | null; limitations?: string[] },
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
  };
}

/** Who calls `name`, from the first-party TypeScript backend. Synchronous: run it off the main thread. */
export function firstPartyCallers(q: FirstPartyCallersQuery): FirstPartyCallersAnswer {
  const now = q.now ?? (() => Date.now());
  const started = now();
  const limit = Math.max(1, Math.floor(q.limit ?? FIRST_PARTY_CALLERS_DEFAULT_LIMIT));
  if (!IDENTIFIER.test(q.name)) {
    return answer(q.name, started, now, { error: `callers needs one identifier; "${q.name}" is not one` });
  }
  const search = findCandidateFiles(q.root, q.name, q.rgPath);
  if (search.error) return answer(q.name, started, now, { error: search.error });
  const partial = search.partial ? [`ripgrep could not read every path: ${search.partial}`] : [];
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
    return answer(q.name, started, now, {
      sites: all.slice(0, limit),
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
