/**
 * The TypeScript LanguageService core behind first-party code intelligence.
 *
 * Plan `gitnexus-deterministic-integration-2026-10-05`: D-026 made the
 * first-party arm (the vendored TypeScript's own LanguageService) the graph
 * backend of record, and WI-10006543 serves `graph:query` callers from it. This
 * module holds the parts that the P-017 bench arm (`fair-comparison-first-party.ts`)
 * and the production callers path (`first-party-callers.ts`) share, so the code
 * D-026 measured is the code production runs. It was moved here unchanged from
 * the bench module; it imports nothing from the bench, so a production bundle
 * that reaches it does not pull in the bench's engine clients.
 *
 * Two ways to open a tree:
 *  - `openTsTree`: every source file under the root as one program (the bench
 *    arm). Measured 2026-10-06 on this repo: 177 s to build, 13.9 GiB peak RSS.
 *  - `openScopedTsTree`: only the given root files in full; every other source
 *    file is served as its re-export statements alone (see `reExportStub`).
 */
import { createRequire } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import type * as TsModule from 'typescript';
import type { SymbolSite } from './contracts';

export type Ts = typeof TsModule;

const posix = (p: string): string => p.split('\\').join('/');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const siteId = (s: Pick<SymbolSite, 'path' | 'line1'>): string => `${s.path}:${s.line1 ?? '?'}`;

/** Zero-based column of `name` as a whole identifier in `text`, or -1. */
export function identifierColumn(text: string, name: string): number {
  const m = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`).exec(text);
  return m ? m.index : -1;
}

/** First site per `path:line1`, in input order. */
export function dedupeSites(sites: readonly SymbolSite[]): SymbolSite[] {
  const byId = new Map<string, SymbolSite>();
  for (const s of sites) if (!byId.has(siteId(s))) byId.set(siteId(s), s);
  return [...byId.values()];
}

/** Every source extension the program takes. JS is included because callers live in .mjs scripts too. */
export const TS_TREE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** The TypeScript that typescript-language-server runs, from the vendored LSP install. */
export function loadVendoredTypescript(vendorDir: string): Ts {
  return createRequire(join(vendorDir, 'noop.js'))('typescript') as Ts;
}

export interface TsTree {
  readonly ts: Ts;
  readonly root: string;
  readonly service: TsModule.LanguageService;
  readonly fileCount: number;
}

/** The root tsconfig's compiler options (when it has one), widened to read JS and never emit. */
function treeOptions(ts: Ts, root: string): TsModule.CompilerOptions {
  const configPath = join(root, 'tsconfig.json');
  let options: TsModule.CompilerOptions = {};
  if (ts.sys.fileExists(configPath)) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!read.error) options = ts.parseJsonConfigFileContent(read.config, ts.sys, root).options;
  }
  return { ...options, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true };
}

function serviceOver(
  ts: Ts,
  root: string,
  files: readonly string[],
  textOf: (fileName: string) => string | undefined,
): TsModule.LanguageService {
  const options = treeOptions(ts, root);
  const snapshots = new Map<string, TsModule.IScriptSnapshot | undefined>();
  const host: TsModule.LanguageServiceHost = {
    getScriptFileNames: () => [...files],
    getScriptVersion: () => '0',
    getScriptSnapshot: (f) => {
      if (!snapshots.has(f)) {
        const text = textOf(f);
        snapshots.set(f, text === undefined ? undefined : ts.ScriptSnapshot.fromString(text));
      }
      return snapshots.get(f);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/**
 * One LanguageService over every source file under `root` (node_modules
 * excluded), with the root tsconfig's compiler options when it has one.
 */
export function openTsTree(ts: Ts, root: string): TsTree {
  const files = ts.sys.readDirectory(root, TS_TREE_EXTENSIONS, ['**/node_modules'], undefined);
  return { ts, root, service: serviceOver(ts, root, files, ts.sys.readFile), fileCount: files.length };
}

/**
 * A file reduced to its re-export statements (`export … from '…'`), and
 * nothing else.
 *
 * Why this is enough for a callers question about `name`: a file that does not
 * contain `name` as a word can neither declare it nor call it. It matters only
 * as a link in a chain that carries `name` to its callers, and the one link a
 * file can be without naming the symbol is `export * from`. Keeping every
 * `export … from` keeps those chains intact while the program stops at the
 * files that matter. Measured 2026-10-06 against the full transitive closure on
 * this repo (WI-10006543): identical sites on every sampled name, at 1-6 s and
 * 0.7-1.1 GB instead of 20-27 s and 3.8-4.3 GB.
 */
export function reExportStub(ts: Ts, fileName: string, text: string): string {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const kept: string[] = [];
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.moduleSpecifier) kept.push(text.slice(st.getStart(sf), st.end));
  }
  return kept.join('\n');
}

export interface ScopedTsTree extends TsTree {
  /** The files served in full: the program's root files. */
  readonly rootFiles: ReadonlySet<string>;
  /** How many other files the program pulled in and served as re-export stubs so far. */
  stubbedFiles(): number;
}

/**
 * A LanguageService whose program is rooted at `rootFiles`. Files the program
 * reaches through imports are served as {@link reExportStub}s unless they are
 * root files or sit under node_modules (package declarations stay whole, so
 * library types still resolve).
 */
export function openScopedTsTree(ts: Ts, root: string, rootFiles: readonly string[]): ScopedTsTree {
  const full = new Set(rootFiles);
  let stubbed = 0;
  const textOf = (f: string): string | undefined => {
    const text = ts.sys.readFile(f);
    if (text === undefined || full.has(f) || f.split('/').includes('node_modules')) return text;
    stubbed += 1;
    return reExportStub(ts, f, text);
  };
  return {
    ts,
    root,
    service: serviceOver(ts, root, rootFiles, textOf),
    fileCount: rootFiles.length,
    rootFiles: full,
    stubbedFiles: () => stubbed,
  };
}

/** A path outside the tree: a default-lib or package declaration. */
export const isExternalPath = (path: string): boolean =>
  path.startsWith('../') || isAbsolute(path) || path.split('/').includes('node_modules');

export interface TsDeclaration {
  readonly file: string;
  /** Offset of the declared name: where the cursor goes for every follow-up query. */
  readonly namePos: number;
  readonly site: SymbolSite;
}

export function tsSiteOf(tree: TsTree, program: TsModule.Program, fileName: string, pos: number, kind: string | null): SymbolSite {
  const sf = program.getSourceFile(fileName);
  return { path: posix(relative(tree.root, fileName)), line1: sf ? sf.getLineAndCharacterOfPosition(pos).line + 1 : null, kind: kind || null };
}

/** Exact-name declarations from navigate-to (the search behind tsserver's workspace/symbol), default libs excluded. */
export function tsDeclarations(tree: TsTree, program: TsModule.Program, subject: string): TsDeclaration[] {
  const out: TsDeclaration[] = [];
  for (const item of tree.service.getNavigateToItems(subject, undefined, undefined, false, true)) {
    if (item.name !== subject) continue;
    const sf = program.getSourceFile(item.fileName);
    if (!sf) continue;
    const span = sf.text.slice(item.textSpan.start, item.textSpan.start + item.textSpan.length);
    const col = identifierColumn(span, subject);
    const namePos = item.textSpan.start + Math.max(col, 0);
    out.push({ file: item.fileName, namePos, site: tsSiteOf(tree, program, item.fileName, namePos, item.kind) });
  }
  return out;
}

export function hierarchyItems(tree: TsTree, d: TsDeclaration): TsModule.CallHierarchyItem[] {
  const r = tree.service.prepareCallHierarchy(d.file, d.namePos);
  return r === undefined ? [] : Array.isArray(r) ? r : [r];
}

/**
 * Every call line into any of `decls` (the call-hierarchy `fromSpans`), one
 * site per line, each carrying the CALLING scope's kind.
 */
export function incomingCallSites(tree: TsTree, program: TsModule.Program, decls: readonly TsDeclaration[]): SymbolSite[] {
  const out: SymbolSite[] = [];
  for (const item of decls.flatMap((d) => hierarchyItems(tree, d))) {
    for (const call of tree.service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
      for (const span of call.fromSpans) out.push(tsSiteOf(tree, program, call.from.file, span.start, call.from.kind));
    }
  }
  return dedupeSites(out);
}
