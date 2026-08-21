/**
 * The thin Papercusp-owned in-operator LSP adapter (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, D-002 / D-006, P-008).
 *
 * We own the CLIENT; we do not own or fork the servers. This speaks JSON-RPC
 * over stdio to the PINNED official language servers provisioned under
 * `~/.papercusp/vendor/lsp` (typescript-language-server + rust-analyzer),
 * normalizes their answers into the `CodeIntelAnswer` shape from
 * `./contracts.ts`, and exposes strictly READ-ONLY operations.
 *
 * Four rails, each load-bearing here rather than decorative:
 *
 *  1. READ-ONLY BY CONSTRUCTION. Only definition / references / implementations
 *     are ever sent. There is no `workspace/applyEdit` handler and no rename
 *     execution: a write that bypassed the PreToolUse lock arbitration would
 *     silently clobber a peer on this shared checkout.
 *  2. managedSpawn-ENROLLED. A language server is a long-lived child meant to
 *     outlive the call that made it, so it is spawned through the task ledger
 *     (`lint:no-unenrolled-spawn`) and is therefore visible in
 *     `processes:list` and killable by taskId — never by name.
 *  3. pinModuleState FOR THE REGISTRY. The client registry is module-scoped
 *     mutable state in a shared package; pinned so a duplicate module record
 *     cannot produce two registries and orphan a server child.
 *  4. HEALTH IS REPORTED, NEVER ASSUMED. If a server dies, every subsequent
 *     answer carries health!=healthy so `isTrustworthyEmpty()` refuses it. A
 *     confident empty list from a dead server is the disqualifying failure this
 *     whole design is built to prevent.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

import { pinModuleState } from '@papercusp/module-singleton';
import { managedSpawn } from '../task-manager/managed-spawn.ts';

import {
  toOneIndexed,
  type BackendHealth,
  type CodeIntelAnswer,
  type CodeIntelIntent,
  type SymbolSite,
} from './contracts.ts';

/**
 * The languages this adapter can drive.
 *
 * WI-40250: widening this union is NOT sufficient on its own — every
 * language-varying behaviour is declared in `LANGUAGE_SPECS` below, which is a
 * `Record` over this union and therefore exhaustive by construction. Adding a
 * member here without adding its spec is a COMPILE error, which is exactly the
 * point: it used to be a silent runtime mislabel.
 */
export type LspLanguage = 'typescript' | 'rust';

/** Where the pinned pilot environment lives (P-007). */
export const LSP_VENDOR_DIR = join(homedir(), '.papercusp', 'vendor', 'lsp');

/**
 * Resolve the tsserver entrypoint — D-009, and the single most confusing
 * failure in this whole subsystem.
 *
 * The repo pins `typescript` to `npm:@typescript/typescript6`, which ships NO
 * `lib/tsserver.js`; `typescript-language-server` is a tsserver WRAPPER, so it
 * exits at `initialize` with "provides no tsserver.js". The stock TypeScript
 * that DOES ship one arrives transitively as `@typescript/old`
 * (itself `npm:typescript@^6`).
 *
 * `@typescript/old` is NOT installable by name — `npm view` 404s it, because it
 * is an alias onto stock typescript, not a published package. So we RESOLVE it
 * rather than hardcode a path (npm can rehoist it), and we fail LOUDLY with the
 * full explanation rather than letting the server exit with a message nobody
 * can act on.
 */
export function resolveTsserverPath(vendorDir: string = LSP_VENDOR_DIR): string {
  const req = createRequire(join(vendorDir, 'noop.js'));
  const candidates = ['@typescript/old/lib/tsserver.js', 'typescript/lib/tsserver.js'];
  for (const spec of candidates) {
    try {
      const resolved = req.resolve(spec);
      if (existsSync(resolved)) return resolved;
    } catch {
      /* try the next candidate */
    }
  }
  // Direct path fallback before giving up, so a resolution quirk does not mask
  // an install that is actually fine.
  const direct = join(vendorDir, 'node_modules', '@typescript', 'old', 'lib', 'tsserver.js');
  if (existsSync(direct)) return direct;

  throw new Error(
    `No tsserver.js found under ${vendorDir}. This is the D-009 failure: the repo's ` +
      `pinned typescript (@typescript/typescript6) ships tsc.js/typescript.js/` +
      `tsserverlibrary.js but NO tsserver.js, and typescript-language-server is a ` +
      `tsserver wrapper. The stock TypeScript that does ship one arrives transitively ` +
      `as @typescript/old (npm:typescript@^6) — it is NOT installable by name. ` +
      `Re-provision with: npm install --prefix ${vendorDir} typescript-language-server@6.0.0 ` +
      `'typescript@npm:@typescript/typescript6@6.0.2'`,
  );
}

/**
 * Everything that varies BY LANGUAGE, declared in ONE place.
 *
 * WI-40250. This used to be three separate `if (language === 'typescript') …`
 * branches whose ELSE ARM WAS RUST — in `resolveServerBin` and in two
 * `languageId` ternaries. Widening `LspLanguage` therefore compiled cleanly and
 * then silently resolved the new language to the rust-analyzer binary while
 * labelling its documents `rust`: a confident wrong answer from the one module
 * whose entire purpose is refusing to produce them. No `switch` existed, so
 * TypeScript's exhaustiveness checking could not see it.
 *
 * `Record<LspLanguage, LanguageSpec>` is the structural fix and the `Record` is
 * load-bearing: it is exhaustive BY CONSTRUCTION, so adding a member to the
 * union without adding its spec here fails the typecheck. Do not relax this to
 * `Partial<Record<…>>` or an index signature — either one silently restores the
 * original failure mode.
 */
interface LanguageSpec {
  /** The `textDocument.languageId` this server expects. */
  readonly languageId: string;
  /** Absolute path to the pinned server binary, or null when not provisioned. */
  readonly resolveBin: () => string | null;
  /**
   * Readiness must come from the server's OWN progress signal rather than from
   * an idle heuristic (WI-40224 — a server that is still indexing answers
   * "no references" indistinguishably from a server that is ready).
   */
  readonly requiresProgressSignal: boolean;
}

const LANGUAGE_SPECS: Readonly<Record<LspLanguage, LanguageSpec>> = {
  typescript: {
    languageId: 'typescript',
    resolveBin: () => {
      const bin = join(LSP_VENDOR_DIR, 'node_modules', '.bin', 'typescript-language-server');
      return existsSync(bin) ? bin : null;
    },
    requiresProgressSignal: false,
  },
  rust: {
    languageId: 'rust',
    // rust-analyzer is a rustup COMPONENT, so its version is pinned by the
    // repo's toolchain rather than floating.
    resolveBin: () => {
      const raBin = join(
        homedir(),
        '.rustup',
        'toolchains',
        'stable-x86_64-unknown-linux-gnu',
        'bin',
        'rust-analyzer',
      );
      return existsSync(raBin) ? raBin : null;
    },
    requiresProgressSignal: true,
  },
};

/**
 * The spec for a language, or a LOUD refusal.
 *
 * The runtime guard is NOT redundant with the compile-time `Record`: this
 * module is reachable from plain-JS callers, from persisted values, and from
 * request payloads, where an unrecognised id would otherwise fall through to
 * whichever branch happened to be last — which is precisely the WI-40250 bug.
 */
export function specForLanguage(language: LspLanguage): LanguageSpec {
  const spec = LANGUAGE_SPECS[language];
  if (!spec) {
    throw new Error(
      `Unknown LSP language ${JSON.stringify(language)}. Known: ` +
        `${Object.keys(LANGUAGE_SPECS).join(', ')}. Add a LANGUAGE_SPECS entry — never ` +
        `let an unknown language fall through to another language's server (WI-40250).`,
    );
  }
  return spec;
}

/** Absolute path to a pinned server binary, or null when not provisioned. */
export function resolveServerBin(language: LspLanguage): string | null {
  return specForLanguage(language).resolveBin();
}

interface LspClient {
  connection: MessageConnection;
  child: ChildProcess;
  taskId: string;
  language: LspLanguage;
  rootUri: string;
  /**
   * URIs the server currently holds open, each stamped with the disk state we
   * opened them AT (WI-40251). The stamp is what makes staleness detectable:
   * an open document ignores disk per the LSP spec, so without it a peer's
   * write is invisible and the server answers about text that is gone.
   */
  openDocs: Map<string, { mtimeMs: number; size: number }>;
  health: BackendHealth;
  lastError: string | null;
  startedAt: number;
  coldStartMs: number;
  /**
   * Outstanding `window/workDoneProgress` tokens. While ANY is open the server
   * is still loading the project and its answers are not yet trustworthy —
   * see `awaitProjectReady`.
   */
  pendingProgress: Set<string | number>;
  /**
   * True once at least one progress cycle has completed.
   *
   * ⚠ "HAS SETTLED ONCE" IS STRICTLY WEAKER THAN "IS DONE" (WI-40224). A server
   * that loads in several phases — rust-analyzer does cargo metadata, then
   * proc-macro build, then indexing — has a legitimately EMPTY pending set
   * between phases, with this flag already true. Gating readiness on it alone
   * answered from a half-loaded server for ~8-10s. Use `quiescent` for any
   * language in REQUIRES_PROGRESS_SIGNAL.
   */
  everSettled: boolean;
  /**
   * The server's OWN readiness verdict, from rust-analyzer's
   * `experimental/serverStatus` notification. `null` means the server has not
   * reported (or does not implement it).
   *
   * This is the difference between asking "is the server idle right now?" —
   * which our progress bookkeeping answers, and which is true between loading
   * phases — and "does the server consider itself ready?", which only it can
   * answer. Everything else is an inference from a signal designed for
   * progress bars.
   */
  quiescent: boolean | null;
  /**
   * Latest `textDocument/publishDiagnostics` payload per document URI.
   *
   * Diagnostics are PUSHED, not requested, which creates a false-empty trap
   * the definition path does not have: a document the server has never
   * published for is indistinguishable from a clean one unless we track
   * whether a publish was ever OBSERVED. We therefore record receipt, and the
   * diagnostics reader refuses to report "clean" for a URI with no entry.
   */
  diagnostics: Map<string, { diags: LspDiagnostic[]; receivedAt: number }>;
}

/** The subset of the LSP `Diagnostic` shape this adapter reads. */
export interface LspDiagnostic {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message?: string;
}

/**
 * How long to wait for the project to finish loading before answering.
 * Measured 2026-08-21 on this repo: the TypeScript server needed ~4.7s after
 * didOpen before `textDocument/definition` stopped returning the WRONG answer.
 * 60s is a generous ceiling for a cold monorepo load, not an expected wait.
 */
const PROJECT_READY_TIMEOUT_MS = 60_000;

/**
 * Servers that ALWAYS announce their indexing via `$/progress`, and so must be
 * required to SETTLE rather than being assumed ready when no token is pending.
 * For these, "no progress token" means "has not started yet", never "done".
 */
/**
 * DERIVED from LANGUAGE_SPECS — never hand-maintained. A second hand-written
 * list of languages is a second place to forget one (WI-40250).
 */
const REQUIRES_PROGRESS_SIGNAL: ReadonlySet<LspLanguage> = new Set<LspLanguage>(
  (Object.keys(LANGUAGE_SPECS) as LspLanguage[]).filter(
    (language) => LANGUAGE_SPECS[language].requiresProgressSignal,
  ),
);

/**
 * How long the progress set must stay CONTINUOUSLY empty before a
 * REQUIRES_PROGRESS_SIGNAL server is treated as loaded — used only as the
 * FALLBACK when the server never sends `experimental/serverStatus` (WI-40224).
 *
 * An instantaneous "nothing pending" reading cannot distinguish the gap
 * between two of rust-analyzer's loading phases from the end of the last one.
 * A sustained one can. This is strictly weaker evidence than the server's own
 * `quiescent` verdict, which is why it is the fallback and not the primary
 * gate — and why an empty answer produced under it is NOT blessed as
 * trustworthy (see `lspQuery`'s freshness handling).
 */
const PROGRESS_SETTLE_WINDOW_MS = 2_000;

/**
 * How long a language may take to load its project before we call it degraded.
 * Per-language because the honest numbers differ by an order of magnitude:
 * MEASURED 2026-08-21 on this repo, tsserver was ready in ~5s while
 * rust-analyzer needed ~89s (cargo metadata + proc-macro build for the Tauri
 * crate). A single 60s ceiling would mark every cold Rust query degraded.
 */
function readyTimeoutFor(language: LspLanguage): number {
  return language === 'rust' ? 300_000 : PROJECT_READY_TIMEOUT_MS;
}

interface AdapterState {
  /** Keyed by `${language}::${rootPath}`. */
  clients: Map<string, LspClient>;
  /**
   * In-flight `startClient` promises, same key.
   *
   * MEASURED DEFECT, not a theoretical one: without this, two concurrent
   * first-calls both miss the `clients` cache (nothing is written to it until
   * `initialize` returns, ~3.5s later) and each spawns its own language
   * server. The task ledger recorded exactly that — two `lsp:typescript`
   * sidecars 18ms apart from one test run — doubling RSS and breaking the
   * `childProcMax: 1` budget while every individual answer still looked
   * perfectly correct. Caching the PROMISE, not just the result, is what makes
   * the cache cover the window it was meant to cover.
   */
  starting: Map<string, Promise<LspClient>>;
}

/**
 * Pinned via @papercusp/module-singleton: a duplicate module record would
 * otherwise produce a second registry whose servers nobody can shut down, and
 * the split is invisible until you go looking for the orphaned children.
 */
const state = pinModuleState<AdapterState>(
  '@papercusp/operator-core.code-intelligence.lsp-adapter',
  () => ({
    clients: new Map<string, LspClient>(),
    starting: new Map<string, Promise<LspClient>>(),
  }),
);

function clientKey(language: LspLanguage, rootPath: string): string {
  return `${language}::${rootPath}`;
}

/**
 * The directory a language server must be ROOTED at to answer about `file`.
 *
 * This is NOT the same as the repo root, and getting it wrong is silent.
 * rust-analyzer derives its entire crate graph from the `Cargo.toml` at its
 * root; point it somewhere without one and it loads NOTHING, then answers
 * every query with an empty result while reporting itself healthy. That empty
 * passes `isTrustworthyEmpty` — so an agent asking "who implements this
 * trait?" is told, authoritatively, "nobody".
 *
 * MEASURED 2026-08-21 (P-010): this repo has NO Cargo.toml at its root — the
 * crates live at papercusp-desktop/src-tauri, apps/tui, apps/pui-companion-proto
 * and apps/pui-zellij-plugin — so every Rust query returned a false-empty.
 * Confirmed not a loading race: 179 polls over 90s never filled.
 *
 * Returning an `error` rather than a silent fallback is the durable half. A
 * caller that cannot find a project root MUST refuse to answer, because a loud
 * failure is honest (`isTrustworthyEmpty` treats `error !== null` as such) and
 * a healthy-looking empty is not.
 */
export function resolveProjectRoot(
  language: LspLanguage,
  file: string,
  fallbackRoot: string,
): { root: string; error: string | null } {
  // TypeScript: the monorepo root carries the tsconfig and the workspace
  // symlinks, so it is genuinely the right project root.
  if (language !== 'rust') return { root: fallbackRoot, error: null };

  let dir = dirname(file);
  while (dir.startsWith(fallbackRoot)) {
    if (existsSync(join(dir, 'Cargo.toml'))) return { root: dir, error: null };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return {
    root: fallbackRoot,
    error:
      `no Cargo.toml found between ${file} and ${fallbackRoot}, so rust-analyzer ` +
      `would have no crate graph and would answer EMPTY for every query while ` +
      `reporting itself healthy. Refusing to answer rather than returning a ` +
      `false-empty that reads as "nothing implements this".`,
  };
}

/** Language for a file, or null when we have no pinned server for it. */
export function languageForFile(path: string): LspLanguage | null {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return 'typescript';
  if (/\.rs$/.test(path)) return 'rust';
  return null;
}

async function startClient(language: LspLanguage, rootPath: string): Promise<LspClient> {
  const bin = resolveServerBin(language);
  if (!bin) {
    throw new Error(
      `Pinned ${language} language server is not provisioned. Expected it under ` +
        `${language === 'typescript' ? LSP_VENDOR_DIR : '~/.rustup/toolchains/stable-*/bin'}. ` +
        `Provision it (P-007) rather than falling back to an unpinned server — a floating ` +
        `version silently changes answers between runs.`,
    );
  }

  const args = language === 'typescript' ? ['--stdio'] : [];
  const spawned = await managedSpawn(
    bin,
    args,
    {
      class: 'sidecar',
      title: `lsp:${language}`,
      argv: [bin, ...args],
      cwd: rootPath,
      // Provenance is the whole reason the task ledger exists — `ps` cannot say
      // who launched a server or why. Without it a stray language server looks
      // anonymous in processes:list.
      launchedBy: 'code-intelligence:lsp-adapter',
      planSlug: 'code-intelligence-routing-lsp-gitnexus-2026-08-20',
      detail: { subsystem: 'code-intelligence', language, rootPath },
    },
    { spawnOptions: { cwd: rootPath, stdio: ['pipe', 'pipe', 'pipe'] } },
  );

  const child = spawned.child;
  if (!child.stdout || !child.stdin) {
    throw new Error(`managedSpawn returned a ${language} server child without piped stdio`);
  }

  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();

  const client: LspClient = {
    connection,
    child,
    taskId: spawned.taskId,
    language,
    rootUri: pathToFileURL(rootPath).href,
    openDocs: new Map(),
    health: 'unknown',
    lastError: null,
    startedAt: Date.now(),
    coldStartMs: 0,
    pendingProgress: new Set(),
    everSettled: false,
    quiescent: null,
    diagnostics: new Map(),
  };

  // ── Project-load readiness ────────────────────────────────────────────────
  // MEASURED, and the reason this machinery exists: for ~4.7s after didOpen the
  // TypeScript server answers `textDocument/definition` with the IMPORT SITE
  // rather than the real cross-package declaration. That is a false POSITIVE —
  // a well-formed, plausible, wrong location — which is strictly more dangerous
  // than an empty result, because nothing about it looks like a failure. The
  // server tells us when it is done via workDoneProgress; we wait for that
  // instead of sleeping a magic number.
  connection.onRequest('window/workDoneProgress/create', (params: { token: string | number }) => {
    client.pendingProgress.add(params.token);
    return null;
  });
  connection.onNotification(
    '$/progress',
    (params: { token: string | number; value?: { kind?: string } }) => {
      if (params?.value?.kind === 'end') {
        client.pendingProgress.delete(params.token);
        if (client.pendingProgress.size === 0) client.everSettled = true;
      }
    },
  );

  // WI-40224: rust-analyzer's own readiness verdict. `quiescent` means the
  // server has finished its work — as distinct from our progress bookkeeping,
  // which can only observe that nothing is in flight AT THIS INSTANT, and is
  // therefore true between two loading phases as well as after the last one.
  //
  // `health` here is the SERVER's self-report and is deliberately NOT mapped
  // onto our BackendHealth: a rust-analyzer 'warning' (e.g. a build-script it
  // declined to run) still answers correctly, so treating it as unhealthy
  // would suppress good answers. Only 'error' is escalated.
  connection.onNotification(
    'experimental/serverStatus',
    (params: { health?: string; quiescent?: boolean; message?: string }) => {
      if (typeof params?.quiescent === 'boolean') client.quiescent = params.quiescent;
      if (params?.health === 'error') {
        client.health = 'degraded';
        client.lastError = params.message ?? 'server reported health=error';
      }
    },
  );

  // Diagnostics arrive as a PUSH notification, never as a reply to a request.
  // Recording receipt (not just content) is what lets the reader below tell
  // "this file is clean" from "the server has not spoken about this file yet".
  connection.onNotification(
    'textDocument/publishDiagnostics',
    (params: { uri?: string; diagnostics?: LspDiagnostic[] }) => {
      if (!params?.uri) return;
      client.diagnostics.set(params.uri, {
        diags: Array.isArray(params.diagnostics) ? params.diagnostics : [],
        receivedAt: Date.now(),
      });
    },
  );

  // A dead server must never answer emptily and confidently again.
  child.on('exit', (code, signal) => {
    client.health = 'unhealthy';
    client.lastError = `language server exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
    state.clients.delete(clientKey(language, rootPath));
  });

  const initializationOptions =
    language === 'typescript'
      ? { tsserver: { path: resolveTsserverPath() } }
      : { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } };

  const t0 = Date.now();
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: client.rootUri,
    workspaceFolders: [{ uri: client.rootUri, name: 'papercusp' }],
    initializationOptions,
    capabilities: {
      textDocument: {
        definition: { linkSupport: false },
        references: {},
        implementation: { linkSupport: false },
        // Declaring publishDiagnostics is what makes the server push them at
        // all; without it `lsp.diagnostics` would report every file clean.
        publishDiagnostics: { relatedInformation: false },
        // `rename` here buys the PREVIEW only — the returned WorkspaceEdit is
        // never applied by this adapter (see the read-only rail above and
        // P-013, which gates application separately).
        rename: { prepareSupport: false },
      },
      workspace: { workspaceFolders: true, symbol: { dynamicRegistration: false } },
      // REQUIRED for the readiness protocol above. Without declaring this the
      // server never sends workDoneProgress, we can never tell "still loading"
      // from "done", and every early query silently returns the wrong answer.
      window: { workDoneProgress: true },
      // WI-40224: opt IN to rust-analyzer's `experimental/serverStatus`. It is
      // the only signal that means "ready" rather than "not currently busy",
      // and the server sends it ONLY if the client advertises this capability —
      // so omitting it is what left us inferring readiness from progress-token
      // bookkeeping that was never designed to answer the question.
      experimental: { serverStatusNotification: true },
    },
  });
  client.coldStartMs = Date.now() - t0;
  connection.sendNotification('initialized', {});
  client.health = 'healthy';

  state.clients.set(clientKey(language, rootPath), client);
  return client;
}

async function getClient(language: LspLanguage, rootPath: string): Promise<LspClient> {
  const key = clientKey(language, rootPath);
  const existing = state.clients.get(key);
  if (existing && existing.health !== 'unhealthy') return existing;

  // Defensive: a process that pinned an OLDER shape of this state (before
  // `starting` existed) keeps that object until it restarts.
  if (!state.starting) state.starting = new Map();

  // The whole point — see AdapterState.starting. A concurrent caller joins the
  // start already in flight instead of racing a second server into existence.
  const inFlight = state.starting.get(key);
  if (inFlight) return inFlight;

  const pending = startClient(language, rootPath).finally(() => {
    state.starting.delete(key);
  });
  state.starting.set(key, pending);
  return pending;
}

/**
 * Block until the server has finished loading the project, so we never answer
 * from a half-loaded program.
 *
 * Returns true when the project is genuinely ready, false when we gave up
 * waiting — and the caller MUST degrade health on false rather than answering
 * as if the result were trustworthy. Returning a bare boolean (instead of
 * throwing) is deliberate: a timeout here is a FRESHNESS fact about the answer,
 * not an error that should erase the difference between "broken" and "empty".
 */
async function awaitProjectReady(
  client: LspClient,
  timeoutMs = readyTimeoutFor(client.language),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Give the server a beat to CREATE its progress token; without this grace a
  // query issued microseconds after didOpen sees an empty pending set and
  // concludes — wrongly — that loading already finished.
  const graceUntil = Date.now() + 1_000;
  let idleSince: number | null = null;
  for (;;) {
    if (client.health === 'unhealthy') return false;
    const idle = client.pendingProgress.size === 0;
    // Track how long the pending set has been CONTINUOUSLY empty. A single
    // instantaneous reading cannot tell the gap between two loading phases
    // from the end of the last one; a sustained one can.
    if (idle) idleSince ??= Date.now();
    else idleSince = null;

    // WI-40224 — a server that reports its OWN readiness is authoritative, and
    // OUTRANKS our progress bookkeeping in BOTH directions:
    //
    //   quiescent === true  -> ready, even with a progress token open (a
    //                          background task is not a half-loaded project).
    //   quiescent === false -> NOT ready, even though `idle && everSettled`.
    //                          This is the false-empty window: between
    //                          rust-analyzer's phases the pending set is empty
    //                          and everSettled is already true, so the old gate
    //                          green-lit a query against a partially-loaded
    //                          index and returned a healthy EMPTY answer that
    //                          isTrustworthyEmpty() blessed as "nothing
    //                          implements this trait".
    if (client.quiescent === true) return true;
    if (client.quiescent !== false) {
      // quiescent === null: the server has never reported. Do NOT hang waiting
      // for a signal that may never come (an older rust-analyzer, or one that
      // ignored our capability) — but do not accept a bare instantaneous idle
      // either, which is the defect. Require the idle to have been SUSTAINED,
      // which closes the inter-phase gap without depending on the notification.
      const settled =
        idle &&
        client.everSettled &&
        (!REQUIRES_PROGRESS_SIGNAL.has(client.language) ||
          (idleSince !== null && Date.now() - idleSince >= PROGRESS_SETTLE_WINDOW_MS));
      if (settled) return true;
    }
    if (idle && Date.now() > graceUntil && !REQUIRES_PROGRESS_SIGNAL.has(client.language)) {
      // No progress was ever reported. Either the server does not implement
      // workDoneProgress or it had nothing to load. Treat as ready, but only
      // after the grace window has actually elapsed — and only for a server
      // that might legitimately never report progress at all (tsserver).
      //
      // ⚠ This branch is VACUOUS for a server that always reports progress:
      // it fires precisely because the token has not been created YET, so it
      // green-lights a query against a completely unloaded server. MEASURED
      // 2026-08-21 (P-010): rust-analyzer answered `textDocument/implementation`
      // healthy-and-EMPTY for 88.6 SECONDS before its index filled, and
      // isTrustworthyEmpty() blesses every one of those empties — an agent
      // asking "who implements this trait?" is told "nobody", authoritatively.
      // Hence REQUIRES_PROGRESS_SIGNAL: such a server must SETTLE, never be
      // assumed ready from the absence of a signal it has not sent yet.
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The health an ANSWER may claim — which is not always the health the client
 * has. WI-40224's class fix, and the durable half of it.
 *
 * `awaitProjectReady` decides WHEN to answer; this decides whether an answer
 * is entitled to be BELIEVED. They are different questions, and conflating
 * them is what let a bounded readiness bug become an authoritative lie:
 * `isTrustworthyEmpty()` blesses any empty whose health is 'healthy', so the
 * moment readiness was wrong, absence became "proof" of absence.
 *
 * The rule: an EMPTY answer from a server that announces its indexing
 * (REQUIRES_PROGRESS_SIGNAL) but has never told us it is `quiescent` is
 * reported DEGRADED. We got there via the settle-window fallback, which is
 * strictly weaker evidence than the server's own verdict — good enough to
 * answer on, not good enough to certify an absence.
 *
 * Deliberately asymmetric: a NON-EMPTY answer keeps the client's health. Sites
 * are positive evidence and cannot be a false-empty, so withholding trust
 * there would suppress good answers for no safety gain.
 */
export function healthForAnswer(
  client: Pick<LspClient, 'health' | 'language' | 'quiescent'>,
  siteCount: number,
): BackendHealth {
  if (siteCount > 0) return client.health;
  if (!REQUIRES_PROGRESS_SIGNAL.has(client.language)) return client.health;
  if (client.quiescent === true) return client.health;
  return client.health === 'healthy' ? 'degraded' : client.health;
}

/**
 * Open a document, or RE-open it if the file on disk has changed since we did.
 *
 * WI-40251, and the reason this is not merely `if (open) return`: per the LSP
 * spec an OPEN document's CLIENT copy is authoritative and the server MUST
 * ignore disk. So once opened, a document is frozen at the text we sent until
 * we say otherwise. `lspResyncDocument` says otherwise — but its only caller is
 * `lsp.apply`, so a write through ANY other path (Edit/Write via the lock hook,
 * a git-sync pull, the merge-resolver, a human's editor) leaves the server
 * answering about text that no longer exists, and reporting it as healthy.
 *
 * That is a FLEET bug, not a single-agent one: the client registry is
 * module-scoped, so one warm server per language is shared by every agent and
 * one agent's unsynced write corrupts everyone's answers. Staleness scales with
 * agent count.
 *
 * The check is PULL rather than push (a lock-release hook) deliberately. Pull
 * catches every staleness source, including the ones no lock brackets; a
 * lock-release push would catch only agent writes through Edit/Write, and would
 * invert the dependency by making the lock plane know about code-intelligence.
 * A lock release is still a precise "content settled" signal worth exploiting
 * later as an optimisation — but correctness must not depend on it.
 *
 * Cost is one `stat` per query on an already-open document. mtime+size is
 * deliberate: it catches every writer here (git checkouts and normal writes all
 * move mtime) without hashing file contents on the hot path.
 */
async function ensureOpen(client: LspClient, absPath: string): Promise<string> {
  const uri = pathToFileURL(absPath).href;
  const seen = client.openDocs.get(uri);

  let stamp: { mtimeMs: number; size: number } | null = null;
  try {
    const st = await stat(absPath);
    stamp = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    // Unstattable (deleted mid-flight, permissions). Fall through: if we have
    // it open, keep the copy we have rather than dropping it; if we do not, the
    // readFile below will surface the real error.
    if (seen) return uri;
  }

  if (seen) {
    if (stamp && seen.mtimeMs === stamp.mtimeMs && seen.size === stamp.size) return uri;
    // Disk moved under us. Close before re-opening: the adapter never
    // established incremental sync (documents open at version 1 and never
    // advance), so didChange would carry a version the server has no baseline
    // for. Re-opening restores the invariant the rest of the adapter assumes.
    client.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
    client.openDocs.delete(uri);
  }

  const text = await readFile(absPath, 'utf8');
  client.connection.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: specForLanguage(client.language).languageId,
      version: 1,
      text,
    },
  });
  // Stamp from AFTER the read where the stat failed, so a transient stat error
  // cannot pin a document as permanently fresh.
  client.openDocs.set(uri, stamp ?? { mtimeMs: -1, size: -1 });
  return uri;
}

/** An LSP Location or LocationLink, normalized to a one-indexed SymbolSite. */
function toSite(raw: unknown, rootPath: string): SymbolSite | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const uri = (r.uri ?? r.targetUri) as string | undefined;
  const range = (r.range ?? r.targetSelectionRange ?? r.targetRange) as
    | { start?: { line?: number } }
    | undefined;
  if (!uri) return null;

  let path: string;
  try {
    path = fileURLToPath(uri);
  } catch {
    return null;
  }
  const rel = path.startsWith(rootPath + '/') ? path.slice(rootPath.length + 1) : path;

  return {
    path: rel,
    // The LSP wire protocol is ZERO-indexed (`Position.line` is zero-based by
    // spec). Every line leaves this adapter one-indexed, via the same
    // normalizer GitNexus results go through — see D-008.
    line1: toOneIndexed('lsp-adapter', range?.start?.line),
    kind: null,
  };
}

export interface LspQuery {
  /** Absolute path to the file the cursor is in. */
  file: string;
  /** ONE-indexed line, as a human/grep/editor would state it. */
  line1: number;
  /** Zero-indexed character offset within the line. */
  character: number;
  /** Repo root (the LSP project root). */
  rootPath: string;
}

const METHOD_BY_INTENT: Partial<Record<CodeIntelIntent, string>> = {
  definition: 'textDocument/definition',
  references: 'textDocument/references',
  implementations: 'textDocument/implementation',
};

/**
 * Ask the pinned language server one READ-ONLY question.
 *
 * Never throws for a server-side failure: it returns an answer carrying
 * `error` and a non-healthy `health`, because a thrown exception loses the
 * distinction between "it broke" and "there are none" — which is exactly the
 * false-empty this design refuses to allow.
 */
export async function lspQuery(
  intent: CodeIntelIntent,
  query: LspQuery,
): Promise<CodeIntelAnswer> {
  const method = METHOD_BY_INTENT[intent];
  const started = Date.now();

  const fail = (error: string, health: BackendHealth = 'unhealthy'): CodeIntelAnswer => ({
    backend: 'lsp-adapter',
    intent,
    query: `${query.file}:${query.line1}:${query.character}`,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - started,
    error,
  });

  if (!method) return fail(`intent '${intent}' is not served by the LSP adapter`, 'unknown');

  const language = languageForFile(query.file);
  if (!language) return fail(`no pinned language server for file ${query.file}`, 'unknown');

  // Root the server at the project that actually owns this file. For Rust that
  // is the nearest ancestor Cargo.toml, NOT the repo root — see
  // resolveProjectRoot. Sites are still reported relative to query.rootPath.
  const project = resolveProjectRoot(language, query.file, query.rootPath);
  if (project.error) return fail(project.error, 'unhealthy');

  try {
    const client = await getClient(language, project.root);
    const uri = await ensureOpen(client, query.file);

    // Never answer from a half-loaded project — that returns a plausible WRONG
    // location, not an error (measured: ~4.7s window on this repo).
    const ready = await awaitProjectReady(client);
    if (!ready) {
      return fail(
        `language server did not finish loading the project within ` +
          `${readyTimeoutFor(client.language)}ms; refusing to answer from a half-loaded` +
          ` program because it returns a plausible WRONG location rather than an error`,
        'degraded',
      );
    }

    const params: Record<string, unknown> = {
      textDocument: { uri },
      // Back to ZERO-indexed on the way OUT: the caller speaks one-indexed,
      // the wire speaks zero-indexed, and this is the only place that converts.
      position: { line: query.line1 - 1, character: query.character },
    };
    if (intent === 'references') {
      // INCLUDE the declaration. This was `false` with no comment justifying
      // it, and that default is wrong for our caller: an agent asking "who
      // references this symbol?" is orienting itself, and the declaration is
      // the single most useful site in the answer — it is where the thing IS.
      // Standard editor behaviour agrees (VS Code's Find All References lists
      // the declaration), and the acceptance corpus's own ground truth for
      // `references-through-barrel-reexport` expects it.
      //
      // Excluding it also made a whole class of answer indistinguishable from
      // a false-empty: a symbol referenced ONLY at its declaration returned
      // `[]` from a healthy server, which isTrustworthyEmpty then blessed as
      // "nothing uses this" — the exact failure the corpus case exists to
      // catch.
      params.context = { includeDeclaration: true };
    }

    const raw = await client.connection.sendRequest(method, params);
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const sites = list
      .map((r) => toSite(r, query.rootPath))
      .filter((s): s is SymbolSite => s !== null);

    return {
      backend: 'lsp-adapter',
      intent,
      query: `${query.file}:${query.line1}:${query.character}`,
      sites,
      truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
      freshness: {
        // NOT client.health directly (WI-40224): an EMPTY answer from a server
        // that has never reported itself quiescent must not be certifiable as
        // absence — "no results", "file is clean" and "nothing to rename" are
        // all read as facts by callers via isTrustworthyEmpty().
        health: healthForAnswer(client, sites.length),
        indexedAt: new Date(client.startedAt).toISOString(),
        // The server reads from disk on didOpen, so an opened document is
        // never stale against disk. We do NOT claim to know about files the
        // server has not opened — that would be exactly the unfounded
        // freshness claim corpus case 6 exists to catch.
        staleVsDisk: false,
        indexedCommit: null,
      },
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * How long to wait for a `publishDiagnostics` push after the project is ready.
 * Diagnostics are not requestable on this server version, so this is the only
 * bound available; on timeout we report DEGRADED rather than "clean".
 */
const DIAGNOSTICS_PUSH_TIMEOUT_MS = 15_000;

/** LSP `DiagnosticSeverity`, 1-based per spec. */
const SEVERITY_NAME: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
};

/**
 * Read the diagnostics the server has published for one file.
 *
 * The false-empty trap here is DIFFERENT from the definition path's, and worse
 * in one specific way: diagnostics are PUSHED, so a file the server has never
 * spoken about produces exactly the same empty array as a genuinely clean one.
 * We therefore require an OBSERVED publish for the URI and return
 * `health:'degraded'` + an error when none arrived — "I have not been told"
 * must never render as "this file is clean".
 */
export async function lspDiagnostics(query: {
  file: string;
  rootPath: string;
}): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const intent: CodeIntelIntent = 'diagnostics';
  const fail = (error: string, health: BackendHealth = 'unhealthy'): CodeIntelAnswer => ({
    backend: 'lsp-adapter',
    intent,
    query: query.file,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - started,
    error,
  });

  const language = languageForFile(query.file);
  if (!language) return fail(`no pinned language server for file ${query.file}`, 'unknown');

  const project = resolveProjectRoot(language, query.file, query.rootPath);
  if (project.error) return fail(project.error, 'unhealthy');

  try {
    const client = await getClient(language, project.root);
    const uri = await ensureOpen(client, query.file);
    const ready = await awaitProjectReady(client);
    if (!ready) {
      return fail(
        `language server did not finish loading the project within ` +
          `${readyTimeoutFor(client.language)}ms; diagnostics from a half-loaded program` +
          ` are not evidence of a clean file`,
        'degraded',
      );
    }

    const deadline = Date.now() + DIAGNOSTICS_PUSH_TIMEOUT_MS;
    while (!client.diagnostics.has(uri) && Date.now() < deadline) {
      if (client.health === 'unhealthy') return fail(client.lastError ?? 'server died');
      await new Promise((r) => setTimeout(r, 100));
    }

    const entry = client.diagnostics.get(uri);
    if (!entry) {
      return fail(
        `no textDocument/publishDiagnostics received for ${query.file} within ` +
          `${DIAGNOSTICS_PUSH_TIMEOUT_MS}ms. Reporting DEGRADED rather than "clean": ` +
          `an absent push is silence, not a clean bill of health`,
        'degraded',
      );
    }

    const rel = query.file.startsWith(query.rootPath + '/')
      ? query.file.slice(query.rootPath.length + 1)
      : query.file;
    const sites: SymbolSite[] = entry.diags.map((d) => ({
      path: rel,
      line1: toOneIndexed('lsp-adapter', d.range?.start?.line),
      kind: SEVERITY_NAME[d.severity ?? 0] ?? null,
      detail: [d.source, d.code, d.message].filter(Boolean).join(' ') || null,
    }));

    return {
      backend: 'lsp-adapter',
      intent,
      query: query.file,
      sites,
      truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
      freshness: {
        // NOT client.health directly (WI-40224): an EMPTY answer from a server
        // that has never reported itself quiescent must not be certifiable as
        // absence — "no results", "file is clean" and "nothing to rename" are
        // all read as facts by callers via isTrustworthyEmpty().
        health: healthForAnswer(client, sites.length),
        indexedAt: new Date(entry.receivedAt).toISOString(),
        staleVsDisk: false,
        indexedCommit: null,
      },
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Search declared symbols across the workspace by name (`workspace/symbol`).
 *
 * `rootFile` picks WHICH pinned server answers — the protocol has one symbol
 * index per server, so a TypeScript query cannot see Rust symbols and vice
 * versa. We take a representative file rather than guessing from the query
 * string, because guessing would silently answer from the wrong index.
 */
export async function lspWorkspaceSymbols(query: {
  name: string;
  rootPath: string;
  language: LspLanguage;
  limit?: number;
}): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const intent: CodeIntelIntent = 'symbol-search';
  const limit = query.limit ?? 50;
  const fail = (error: string, health: BackendHealth = 'unhealthy'): CodeIntelAnswer => ({
    backend: 'lsp-adapter',
    intent,
    query: query.name,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - started,
    error,
  });

  try {
    const client = await getClient(query.language, query.rootPath);
    const ready = await awaitProjectReady(client);
    if (!ready) {
      return fail(
        `language server did not finish loading the project within ` +
          `${readyTimeoutFor(client.language)}ms; a symbol index that is still building` +
          ` returns a PARTIAL list that looks complete`,
        'degraded',
      );
    }

    const raw = await client.connection.sendRequest('workspace/symbol', { query: query.name });
    const list = Array.isArray(raw) ? raw : [];
    const all = list
      .map((entry): SymbolSite | null => {
        const e = entry as { location?: unknown; containerName?: string; kind?: number };
        const site = toSite(e.location, query.rootPath);
        if (!site) return null;
        return { ...site, detail: e.containerName ?? null };
      })
      .filter((s): s is SymbolSite => s !== null);

    const sites = all.slice(0, limit);
    return {
      backend: 'lsp-adapter',
      intent,
      query: query.name,
      sites,
      truncation: {
        // Stated, never inferred from length: the caller must be able to tell
        // a 50-of-50 cut from a true 50.
        truncated: all.length > limit,
        totalAvailable: all.length,
        continuation: null,
      },
      freshness: {
        health: client.health,
        indexedAt: new Date(client.startedAt).toISOString(),
        staleVsDisk: null,
        indexedCommit: null,
      },
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Compute a rename's affected sites WITHOUT applying anything.
 *
 * This asks the server for a `WorkspaceEdit` and reads it as a REPORT. Nothing
 * in this adapter writes a file: applying an edit would bypass the PreToolUse
 * lock arbitration that keeps this shared checkout collision-free, which is
 * why application is a separately gated capability (P-013) rather than a flag
 * on this function. The name carries "preview" for the same reason the
 * corpus's PREVIEW_ONLY_ALLOWLIST exists — the promise is verified by the
 * no-mutation case, not by the name.
 */
export async function lspRenamePreview(query: LspQuery & { newName: string }): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const intent: CodeIntelIntent = 'rename-preview';
  const q = `${query.file}:${query.line1}:${query.character}→${query.newName}`;
  const fail = (error: string, health: BackendHealth = 'unhealthy'): CodeIntelAnswer => ({
    backend: 'lsp-adapter',
    intent,
    query: q,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - started,
    error,
  });

  const language = languageForFile(query.file);
  if (!language) return fail(`no pinned language server for file ${query.file}`, 'unknown');

  const project = resolveProjectRoot(language, query.file, query.rootPath);
  if (project.error) return fail(project.error, 'unhealthy');

  try {
    const client = await getClient(language, project.root);
    const uri = await ensureOpen(client, query.file);
    const ready = await awaitProjectReady(client);
    if (!ready) {
      return fail(
        `language server did not finish loading the project within ` +
          `${readyTimeoutFor(client.language)}ms; a rename plan computed from a half-loaded` +
          ` program MISSES call sites, which is the most dangerous possible partial answer`,
        'degraded',
      );
    }

    const raw = (await client.connection.sendRequest('textDocument/rename', {
      textDocument: { uri },
      position: { line: query.line1 - 1, character: query.character },
      newName: query.newName,
    })) as
      | { changes?: Record<string, Array<{ range?: { start?: { line?: number } }; newText?: string }>> }
      | null;

    const sites: SymbolSite[] = [];
    for (const [editUri, edits] of Object.entries(raw?.changes ?? {})) {
      for (const edit of edits ?? []) {
        const site = toSite({ uri: editUri, range: edit.range }, query.rootPath);
        if (site) sites.push({ ...site, detail: edit.newText ?? null });
      }
    }

    return {
      backend: 'lsp-adapter',
      intent,
      query: q,
      sites,
      truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
      freshness: {
        // NOT client.health directly (WI-40224): an EMPTY answer from a server
        // that has never reported itself quiescent must not be certifiable as
        // absence — "no results", "file is clean" and "nothing to rename" are
        // all read as facts by callers via isTrustworthyEmpty().
        health: healthForAnswer(client, sites.length),
        indexedAt: new Date(client.startedAt).toISOString(),
        staleVsDisk: false,
        indexedCommit: null,
      },
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The RAW `WorkspaceEdit` behind `lspRenamePreview`, both encodings intact.
 *
 * `lspRenamePreview` flattens the edit into `SymbolSite[]` for an agent to
 * read, and in doing so it (a) drops `documentChanges` — the encoding a server
 * uses when it wants to say more than "replace this range" — and (b) discards
 * the newText/range pairing needed to actually apply anything. Both are correct
 * for a REPORT and useless for an application, so P-013's writer takes this
 * instead of re-deriving an edit from the flattened sites.
 *
 * Still read-only: this sends `textDocument/rename` and returns what came back.
 * Nothing here touches the filesystem. The application lives in `lsp-apply.ts`,
 * behind its own flag and its own lock.
 */
export async function lspRenameWorkspaceEdit(
  query: LspQuery & { newName: string },
): Promise<
  | { ok: true; edit: unknown; projectRoot: string; language: LspLanguage }
  | { ok: false; error: string; health: BackendHealth }
> {
  const language = languageForFile(query.file);
  if (!language) return { ok: false, error: `no pinned language server for file ${query.file}`, health: 'unknown' };

  const project = resolveProjectRoot(language, query.file, query.rootPath);
  if (project.error) return { ok: false, error: project.error, health: 'unhealthy' };

  try {
    const client = await getClient(language, project.root);
    const uri = await ensureOpen(client, query.file);
    const ready = await awaitProjectReady(client);
    if (!ready) {
      // The same refusal `lspRenamePreview` makes, and for a stronger reason
      // here: a rename plan computed from a half-loaded program MISSES call
      // sites, and this caller WRITES. A partial rename that compiles is the
      // worst outcome available — it renames the definition and leaves callers
      // pointing at a symbol that no longer exists, or worse, at a different one.
      return {
        ok: false,
        error:
          `language server did not finish loading the project within ` +
          `${readyTimeoutFor(client.language)}ms; refusing to compute an edit for application`,
        health: 'degraded',
      };
    }

    const edit = await client.connection.sendRequest('textDocument/rename', {
      textDocument: { uri },
      position: { line: query.line1 - 1, character: query.character },
      newName: query.newName,
    });
    return { ok: true, edit, projectRoot: project.root, language };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), health: 'unhealthy' };
  }
}

/**
 * Tell a live server that a file we had open now holds different text.
 *
 * REQUIRED for an honest post-write diagnostic delta, and the reason is the
 * same asymmetry P-013 is built around: per the LSP spec, for an OPEN document
 * the client's copy is authoritative and the server MUST ignore disk. So after
 * `lsp.apply` writes, every diagnostic the server reports still describes the
 * PRE-write text — a delta computed from it would be confidently wrong, and
 * wrong in the reassuring direction ("no new errors").
 *
 * `didClose` + `didOpen` rather than `didChange`: the adapter never established
 * incremental sync (documents are opened at `version: 1` and never advanced),
 * so a `didChange` would be a version the server has no baseline for. Re-opening
 * restores exactly the invariant the rest of the adapter assumes.
 *
 * A no-op when no server is live for that language/root, or when the document
 * was never opened — both mean there is nothing holding a stale copy.
 */
export function lspResyncDocument(absPath: string, rootPath: string, newText: string): boolean {
  const language = languageForFile(absPath);
  if (!language) return false;
  const project = resolveProjectRoot(language, absPath, rootPath);
  if (project.error) return false;
  const client = state.clients.get(clientKey(language, project.root));
  if (!client || client.health === 'unhealthy') return false;

  const uri = pathToFileURL(absPath).href;
  if (!client.openDocs.has(uri)) return false;
  try {
    client.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
    client.connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: specForLanguage(client.language).languageId,
        version: 1,
        text: newText,
      },
    });
    // Re-stamp so ensureOpen's staleness check (WI-40251) does not immediately
    // re-open a document we just synced by hand. Dropping the entry rather than
    // stat-ing is deliberate: the caller wrote this text, so the next query
    // re-reads and re-stamps from disk, which is the conservative direction.
    client.openDocs.delete(uri);
    return true;
  } catch {
    // A dead pipe here costs us the delta's accuracy, not the write that already
    // landed. Report false so the caller marks the delta UNMEASURED rather than
    // reporting a clean one it did not earn.
    return false;
  }
}

/** Shut down every live language server. Safe to call repeatedly. */
export async function shutdownAllLspClients(): Promise<number> {
  const clients = [...state.clients.values()];
  state.clients.clear();
  await Promise.all(
    clients.map(async (c) => {
      // Only speak to a server whose pipe is actually still open. Writing to a
      // destroyed stream raises ERR_STREAM_DESTROYED as an UNHANDLED rejection
      // (vscode-jsonrpc writes asynchronously), which Vitest reports as an
      // unhandled error and warns can cause false-positive tests — so this is a
      // correctness guard, not tidiness.
      const writable = c.child.exitCode === null && !c.child.killed && c.child.stdin?.writable;
      if (writable) {
        try {
          await c.connection.sendRequest('shutdown');
          // sendNotification also returns a promise that can reject once the
          // server closes its end in response to `shutdown` — await it so the
          // rejection is HANDLED here rather than surfacing globally.
          await c.connection.sendNotification('exit');
        } catch {
          /* the server closed its pipe first — expected on a clean exit */
        }
      }
      try {
        c.connection.dispose();
      } catch {
        /* already disposed */
      }

      // GIVE THE PROTOCOL SHUTDOWN TIME TO LAND before reaching for a signal.
      // Measured defect: this used to SIGTERM immediately after `exit`, when
      // `exitCode` is of course still null because the server has had
      // microseconds to react. Under managedSpawn the child we hold is the
      // `systemd-run` CLIENT, not the server itself — so that signal killed the
      // wrapper while its scope still held the real process, and managed-spawn
      // logged exactly that, leaving the ledger row live for the reconciler.
      // A protocol `exit` makes the SERVER terminate itself inside the scope,
      // which is the only clean way out from here; killing a subtree by hand is
      // `processes:kill { taskId }`'s job, never a bare signal.
      if (!(await waitForChildExit(c.child, GRACEFUL_EXIT_WAIT_MS))) {
        if (c.child.exitCode === null && !c.child.killed) c.child.kill('SIGTERM');
      }
    }),
  );
  return clients.length;
}

/** How long a server gets to honour a protocol `exit` before we signal it. */
const GRACEFUL_EXIT_WAIT_MS = 5_000;

/** Resolve true when the child has exited, false on timeout. Never throws. */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    // Do not hold the event loop open purely to watch a shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', onExit);
  });
}

/** Live server inventory — for health surfaces and the corpus runner. */
export function lspClientInventory(): Array<{
  language: LspLanguage;
  rootPath: string;
  taskId: string;
  health: BackendHealth;
  coldStartMs: number;
  openDocs: number;
  pid: number | null;
}> {
  return [...state.clients.entries()].map(([key, c]) => ({
    language: c.language,
    rootPath: key.slice(key.indexOf('::') + 2),
    taskId: c.taskId,
    health: c.health,
    coldStartMs: c.coldStartMs,
    openDocs: c.openDocs.size,
    pid: c.child.pid ?? null,
  }));
}
