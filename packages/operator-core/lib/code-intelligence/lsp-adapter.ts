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
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** Absolute path to a pinned server binary, or null when not provisioned. */
export function resolveServerBin(language: LspLanguage): string | null {
  if (language === 'typescript') {
    const bin = join(LSP_VENDOR_DIR, 'node_modules', '.bin', 'typescript-language-server');
    return existsSync(bin) ? bin : null;
  }
  // rust-analyzer is a rustup COMPONENT, so its version is pinned by the repo's
  // toolchain rather than floating.
  const raBin = join(
    homedir(),
    '.rustup',
    'toolchains',
    'stable-x86_64-unknown-linux-gnu',
    'bin',
    'rust-analyzer',
  );
  return existsSync(raBin) ? raBin : null;
}

interface LspClient {
  connection: MessageConnection;
  child: ChildProcess;
  taskId: string;
  language: LspLanguage;
  rootUri: string;
  openDocs: Set<string>;
  health: BackendHealth;
  lastError: string | null;
  startedAt: number;
  coldStartMs: number;
}

interface AdapterState {
  /** Keyed by `${language}::${rootPath}`. */
  clients: Map<string, LspClient>;
}

/**
 * Pinned via @papercusp/module-singleton: a duplicate module record would
 * otherwise produce a second registry whose servers nobody can shut down, and
 * the split is invisible until you go looking for the orphaned children.
 */
const state = pinModuleState<AdapterState>(
  '@papercusp/operator-core.code-intelligence.lsp-adapter',
  () => ({ clients: new Map<string, LspClient>() }),
);

function clientKey(language: LspLanguage, rootPath: string): string {
  return `${language}::${rootPath}`;
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
    openDocs: new Set(),
    health: 'unknown',
    lastError: null,
    startedAt: Date.now(),
    coldStartMs: 0,
  };

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
      },
      workspace: { workspaceFolders: true },
    },
  });
  client.coldStartMs = Date.now() - t0;
  connection.sendNotification('initialized', {});
  client.health = 'healthy';

  state.clients.set(clientKey(language, rootPath), client);
  return client;
}

async function getClient(language: LspLanguage, rootPath: string): Promise<LspClient> {
  const existing = state.clients.get(clientKey(language, rootPath));
  if (existing && existing.health !== 'unhealthy') return existing;
  return startClient(language, rootPath);
}

/** Open a document if the server has not seen it yet (LSP requires didOpen). */
async function ensureOpen(client: LspClient, absPath: string): Promise<string> {
  const uri = pathToFileURL(absPath).href;
  if (client.openDocs.has(uri)) return uri;
  const text = await readFile(absPath, 'utf8');
  client.connection.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: client.language === 'typescript' ? 'typescript' : 'rust',
      version: 1,
      text,
    },
  });
  client.openDocs.add(uri);
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

  try {
    const client = await getClient(language, query.rootPath);
    const uri = await ensureOpen(client, query.file);

    const params: Record<string, unknown> = {
      textDocument: { uri },
      // Back to ZERO-indexed on the way OUT: the caller speaks one-indexed,
      // the wire speaks zero-indexed, and this is the only place that converts.
      position: { line: query.line1 - 1, character: query.character },
    };
    if (intent === 'references') params.context = { includeDeclaration: false };

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
        health: client.health,
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

/** Shut down every live language server. Safe to call repeatedly. */
export async function shutdownAllLspClients(): Promise<number> {
  const clients = [...state.clients.values()];
  state.clients.clear();
  await Promise.all(
    clients.map(async (c) => {
      try {
        await c.connection.sendRequest('shutdown');
        c.connection.sendNotification('exit');
      } catch {
        /* already gone */
      } finally {
        c.connection.dispose();
        if (!c.child.killed) c.child.kill('SIGTERM');
      }
    }),
  );
  return clients.length;
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
