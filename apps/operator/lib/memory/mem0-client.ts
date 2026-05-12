/**
 * mem0 client singleton for the operator's persistent memory.
 *
 * Plan 3. Backed by mem0ai v3 OSS in library mode:
 *   - storage: pgvector (embedded PG)
 *   - LLM:     Anthropic Haiku 4.5 (cheap fact extraction)
 *   - embedder: @xenova/transformers BGE-small (local, no API key)
 *
 * Lazy-loaded. The actual mem0ai + transformers modules are heavy
 * (~400MB combined resident memory when loaded). We don't load them
 * until the first .add() or .search() call so cold boot stays fast.
 *
 * Per-user scoping: userId = session.user.id (Plan 4 dependency).
 * Workspace-shared memories are stored with metadata.shared: true and
 * filtered in via OR(workspace_id=ws, shared=true) at search time.
 *
 * Failure mode: if mem0ai isn't installed (npm install pending), all
 * methods return empty arrays / no-op writes. Logs once per process so
 * users notice without spamming.
 */

import { getOrgPg } from '@restart/db-org';

const MEM0_COLLECTION = 'operator_memory';
const EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';
const EMBEDDER_DIM = 384;
const LLM_MODEL = 'claude-haiku-4-5';


type MemoryEntry = {
  id: string;
  memory?: string;
  metadata?: Record<string, unknown>;
  score?: number;
  [key: string]: unknown;
};

type MemoryListResult = {
  results?: MemoryEntry[];
  [key: string]: unknown;
};

type MemoryClient = {
  add(content: string, opts: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  getAll(opts: Record<string, unknown>): Promise<MemoryListResult>;
  search(query: string, opts: Record<string, unknown>): Promise<MemoryListResult>;
  update(id: string, content: string): Promise<unknown>;
};

type Mem0Module = {
  Memory: new (config: Record<string, unknown>) => MemoryClient;
};

type TransformersModule = {
  pipeline: (task: string, model: string) => Promise<Pipeline>;
};

type Pipeline = (text: string, opts: unknown) => Promise<{ data: Float32Array }>;

const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as <T>(specifier: string) => Promise<T>;

const MEM0_PACKAGE = 'mem0ai/oss';
const TRANSFORMERS_PACKAGE = '@xenova/transformers';
let _client: MemoryClient | null = null;
/**
 * "Permanent" failure cache — only set when the failure is from a
 * truly fixed cause (missing npm package, unparseable config). For
 * recoverable failures (missing Anthropic API key — user can add via
 * /settings/credentials), we do NOT cache so the client retries on
 * the next call.
 */
let _clientPermanentFailure = false;
const _seenWarnReasons = new Set<string>();

function warnOnce(reason: string): void {
  // Each distinct reason logs once per process. Avoids spamming the
  // log when many tool calls hit the same missing-key failure but
  // surfaces a credentials-then-deps double issue clearly.
  if (_seenWarnReasons.has(reason)) return;
  _seenWarnReasons.add(reason);
  console.warn(`[mem0] not available: ${reason}.`);
}

/**
 * Try to load the mem0 client. Returns null if the dependencies aren't
 * installed or if config can't be assembled.
 */
async function tryLoad(): Promise<MemoryClient | null> {
  if (_client) return _client;
  // Permanent failures (deps not installed) skip retries — those won't
  // resolve mid-process. Recoverable ones (missing API key, transient
  // PG error) are NOT cached so the next call retries.
  if (_clientPermanentFailure) return null;

  // Resolve the embedded PG connection string the same way every other
  // module in this app does — via getOrgPg's connection metadata. We
  // need a raw connection string to hand to pgvector.
  let connectionString: string;
  try {
    const { connectionString: cs } = await import('./mem0-connection');
    connectionString = await cs();
  } catch (e) {
    // PG resolution failure is transient (the discovery file may not
    // be written yet on cold boot). Retry on next call.
    warnOnce(`couldn't resolve PG connection: ${(e as Error).message}`);
    return null;
  }

  // Anthropic API key: PG-first (operator stores in operator_credentials),
  // env as fallback. A missing key is RECOVERABLE — user can add via
  // /settings/credentials, so don't poison-cache the failure.
  let anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  try {
    const { readCredentials } = await import('../credentials');
    const creds = await readCredentials();
    if (creds.anthropic_api_key) anthropicKey = creds.anthropic_api_key;
  } catch {
    /* PG creds unavailable — fall back to env */
  }
  if (!anthropicKey) {
    warnOnce('no Anthropic API key in operator-credentials or env (add at /settings/api-keys)');
    return null;
  }

  try {
    // Dynamic imports so this module can be imported even when the
    // deps aren't yet installed (build-time + boot-time safety).
    const { Memory } = await dynamicImport<Mem0Module>(MEM0_PACKAGE);
    const customEmbedder = await buildLocalEmbedder();

    _client = new Memory({
      embedder: {
        provider: 'custom',
        config: { embed: customEmbedder },
      },
      vectorStore: {
        provider: 'pgvector',
        config: {
          connectionString,
          collectionName: MEM0_COLLECTION,
          dimension: EMBEDDER_DIM,
        },
      },
      llm: {
        provider: 'anthropic',
        config: {
          apiKey: anthropicKey,
          model: LLM_MODEL,
        },
      },
      historyDbPath: ':memory:',
    });

    return _client;
  } catch (e) {
    // The dynamic-import errors here are the permanent class: missing
    // mem0ai or @xenova/transformers packages. Those don't resolve
    // mid-process, so cache.
    const msg = (e as Error).message ?? String(e);
    if (/cannot find module|MODULE_NOT_FOUND|Cannot resolve/i.test(msg)) {
      _clientPermanentFailure = true;
      warnOnce(`${msg}. Run 'npm install' in apps/operator to enable.`);
    } else {
      // Unknown failure — retry next call but log it.
      warnOnce(msg);
    }
    return null;
  }
}

async function buildLocalEmbedder(): Promise<(text: string) => Promise<number[]>> {
  // @xenova/transformers loads ~400MB. Singleton per process.
  type Pipeline = (text: string, opts: unknown) => Promise<{ data: Float32Array }>;
  let pipelinePromise: Promise<Pipeline> | null = null;

  return async (text: string): Promise<number[]> => {
    if (!pipelinePromise) {
      const transformers = await dynamicImport<TransformersModule>(TRANSFORMERS_PACKAGE);
      pipelinePromise = transformers.pipeline('feature-extraction', EMBEDDER_MODEL);
    }
    const pipe = await pipelinePromise;
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data);
  };
}

/**
 * Returns the mem0 client OR null if dependencies aren't installed
 * or PG isn't reachable. Callers handle the null case as a no-op.
 */
export async function getMemoryClient(): Promise<MemoryClient | null> {
  return tryLoad();
}
