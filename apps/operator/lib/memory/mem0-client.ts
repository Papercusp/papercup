/**
 * mem0 client singleton for the operator's persistent memory.
 *
 * Plan 3 (storage layer rewritten 2026-05-24 per memory-harness-scope plan).
 *
 * Stack:
 *   - storage: CanonicalVectorStore (our own pgvector layer) —
 *              one canonical `memory_canonical` row per fact, with
 *              per-embedder-model vec tables joined by memory_id.
 *              Switching embedder mode no longer "loses" your old
 *              memories; only the recall side picks a different vec
 *              table. Re-embedding into the other model is an INSERT
 *              into the other vec table without touching the canonical
 *              row. See apps/operator/lib/memory/canonical-store.ts +
 *              migration 081-memory-canonical.sql.
 *   - LLM:     Anthropic Haiku 4.5 (cheap fact extraction; only generative
 *              vendor we use — Anthropic does not offer embeddings)
 *   - embedder: cascade with three modes (configurable via voice-prefs
 *              `memoryEmbedderMode`):
 *                openai   — text-embedding-3-small (default; needs key)
 *                local    — @huggingface/transformers BGE-small (heavy
 *                           but free; ~400MB RAM, ~120MB disk)
 *                disabled — memory tools no-op silently
 *              When mode='auto' (default), resolution order is:
 *                openai (if key present)
 *                → local (if package installed)
 *                → disabled (silent)
 *
 * Per-user scoping: userId = session.user.id.
 * Harness-scoped: userId = `harness:<slug>`.
 * Legacy workspace-shared (deprecated): userId = `workspace:<id>`,
 *   metadata.shared. Read-through only; the write path no longer
 *   emits these (see memory:remember).
 *
 * Vector dimensions: 384 across both embedders. OpenAI's native 1536
 * is truncated via its `dimensions` parameter. BGE-small is natively
 * 384. Same wire shape lets both vec tables share migration 081's
 * schema.
 *
 * Vector SPACES still differ across embedders, so each model writes
 * to its own vec table — `memory_vec_openai` vs `memory_vec_local`.
 * The canonical text is shared.
 *
 * Failure mode: if a fatal load error occurs (missing npm package),
 * memory tools return graceful no-ops. Logs once per process per
 * distinct reason. Recoverable failures (transient PG, missing key the
 * user can add via /settings/api-keys) DON'T poison-cache, so the next
 * call retries.
 */

import { CanonicalVectorStore } from './canonical-store';

const EMBEDDER_DIM = 384;
const LOCAL_EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const LLM_MODEL = 'claude-haiku-4-5';
// The collectionName is passed to mem0 for its internal bookkeeping
// but our CanonicalVectorStore ignores it — scope lives in payload.
const MEM0_COLLECTION_PREFIX = 'operator_memory';

let _factoryPatched = false;
/**
 * Register CanonicalVectorStore as a `'canonical'` provider on mem0's
 * VectorStoreFactory. mem0's OSS factory uses a hard-coded switch with
 * no plugin hook, so we patch the static `create` method in place at
 * first construction. Idempotent — subsequent calls no-op.
 */
function patchVectorStoreFactory(mem0Module: {
  VectorStoreFactory: { create: (provider: string, config: Record<string, unknown>) => unknown };
}): void {
  if (_factoryPatched) return;
  const Factory = mem0Module.VectorStoreFactory;
  if (!Factory || typeof Factory.create !== 'function') {
    warnOnce('mem0 VectorStoreFactory not patchable (interface changed?); canonical store unavailable');
    return;
  }
  const orig = Factory.create.bind(Factory);
  Factory.create = (provider: string, config: Record<string, unknown>) => {
    if (provider === 'canonical') {
      // mem0 passes the inner config object directly (not wrapped in
      // { provider, config }) — see Memory constructor invoking
      // VectorStoreFactory.create(this.config.vectorStore.provider,
      // this.config.vectorStore.config).
      return new CanonicalVectorStore(config as unknown as ConstructorParameters<typeof CanonicalVectorStore>[0]);
    }
    return orig(provider, config);
  };
  _factoryPatched = true;
}

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
  add(content: string | unknown[], opts: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  get(id: string): Promise<MemoryEntry | null>;
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

type EmbedderMode = 'auto' | 'openai' | 'local' | 'disabled';
type ResolvedMode = 'openai' | 'local' | 'disabled';

const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as <T>(specifier: string) => Promise<T>;

const MEM0_PACKAGE = 'mem0ai/oss';
const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

let _client: MemoryClient | null = null;
let _clientMode: ResolvedMode | null = null;
let _clientBuiltAt = 0;
/**
 * mem0's customInstructions is set at construction time and the
 * Memory class doesn't expose a mutator. We refresh by tearing the
 * client down after this TTL so the next call rebuilds with current
 * learning-loop instructions. Cheap — no network, just JS object
 * construction.
 */
const _clientTtlMs = 60 * 60 * 1000; // 1 hour
/**
 * "Permanent" failure cache — only set when the failure is from a
 * truly fixed cause (mem0ai npm package missing). For recoverable
 * failures (missing API key, transient PG hiccup), we do NOT cache
 * so the next call retries.
 */
let _clientPermanentFailure = false;
const _seenWarnReasons = new Set<string>();

function warnOnce(reason: string): void {
  if (_seenWarnReasons.has(reason)) return;
  _seenWarnReasons.add(reason);
  console.warn(`[mem0] ${reason}.`);
}

interface EmbedderResolution {
  mode: ResolvedMode;
  apiKey?: string;
  reason?: string;
}

/**
 * Pick the actual embedder mode given the user's preference + what
 * credentials/packages are actually available.
 *
 * 'disabled' is a hard stop — never falls back. Auto cascades.
 */
async function resolveEmbedder(preference: EmbedderMode): Promise<EmbedderResolution> {
  if (preference === 'disabled') {
    return { mode: 'disabled', reason: 'user_disabled' };
  }

  const tryOpenAi = async (): Promise<EmbedderResolution | null> => {
    let key = process.env.OPENAI_API_KEY ?? '';
    try {
      const { readCredentials } = await import('../credentials');
      const creds = await readCredentials();
      if (creds.openai_api_key) key = creds.openai_api_key;
    } catch {
      /* PG creds unavailable — fall back to env */
    }
    if (!key) return null;
    return { mode: 'openai', apiKey: key };
  };

  const tryLocal = async (): Promise<EmbedderResolution | null> => {
    try {
      // We don't need to actually load the model here — just resolve
      // the module path. If the package isn't installed, this throws.
      await dynamicImport<TransformersModule>(TRANSFORMERS_PACKAGE);
      return { mode: 'local' };
    } catch {
      return null;
    }
  };

  if (preference === 'openai') {
    const openai = await tryOpenAi();
    if (openai) return openai;
    return { mode: 'disabled', reason: 'openai_forced_but_no_key' };
  }

  if (preference === 'local') {
    const local = await tryLocal();
    if (local) return local;
    return { mode: 'disabled', reason: 'local_forced_but_not_installed' };
  }

  // 'auto' — try openai first, then local, then disabled.
  const openai = await tryOpenAi();
  if (openai) return openai;
  const local = await tryLocal();
  if (local) return local;
  return { mode: 'disabled', reason: 'no_openai_key_and_local_not_installed' };
}

async function readEmbedderPreference(): Promise<EmbedderMode> {
  try {
    const { loadVoicePrefs } = await import('../voice-prefs');
    const prefs = await loadVoicePrefs();
    const mode = (prefs as Record<string, unknown>).memoryEmbedderMode;
    if (mode === 'auto' || mode === 'openai' || mode === 'local' || mode === 'disabled') {
      return mode;
    }
  } catch {
    /* voice-prefs unavailable — fall through to default */
  }
  return 'auto';
}

async function buildLocalEmbedder(): Promise<(text: string) => Promise<number[]>> {
  let pipelinePromise: Promise<Pipeline> | null = null;
  let workerDisabled = false;

  return async (text: string): Promise<number[]> => {
    // Step B1 (Tier-3 follow-up arc): try the worker-thread isolated
    // embedder first so ONNX inference doesn't block the main event
    // loop. Falls back to inline when worker_threads is unavailable
    // OR the worker fails to spawn (older Node, vitest environments
    // that don't support worker_threads imports cleanly, etc).
    if (!workerDisabled) {
      try {
        const { embedViaWorker } = await import('./local-embedder-worker');
        return await embedViaWorker(text);
      } catch {
        // Worker spawn or embedding failed — disable for subsequent
        // calls in this process and fall through to inline.
        workerDisabled = true;
      }
    }

    // Inline (main-thread) fallback path.
    if (!pipelinePromise) {
      const transformers = await dynamicImport<TransformersModule>(TRANSFORMERS_PACKAGE);
      pipelinePromise = transformers.pipeline('feature-extraction', LOCAL_EMBEDDER_MODEL);
    }
    const pipe = await pipelinePromise;
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data);
  };
}

/**
 * Try to load the mem0 client. Returns null if dependencies aren't
 * installed, mode is 'disabled', or config can't be assembled.
 */
async function tryLoad(): Promise<MemoryClient | null> {
  if (_client && Date.now() - _clientBuiltAt < _clientTtlMs) return _client;
  if (_client) {
    // TTL expired — drop and rebuild so learning-loop instructions
    // refresh. mem0 doesn't ship a mutator for customInstructions.
    _client = null;
  }
  if (_clientPermanentFailure) return null;

  const preference = await readEmbedderPreference();
  const resolution = await resolveEmbedder(preference);

  if (resolution.mode === 'disabled') {
    // Don't cache — user can change preference or add a key any time.
    if (resolution.reason && resolution.reason !== 'user_disabled') {
      warnOnce(`embedder unavailable: ${resolution.reason} (set memoryEmbedderMode in /settings/user)`);
    }
    return null;
  }

  // Resolve PG connection as discrete fields — mem0's PGVector provider
  // expects user/password/host/port/dbname, NOT a connectionString.
  // Transient failures retry next call.
  let pgFields: { host: string; port: number; user: string; password: string; dbname: string };
  try {
    const { pgFields: getFields } = await import('./mem0-connection');
    pgFields = await getFields();
  } catch (e) {
    warnOnce(`couldn't resolve PG connection: ${(e as Error).message}`);
    return null;
  }

  // LLM for fact extraction. Cascade: prefer Anthropic Haiku (cheaper)
  // if a raw API key is available; fall back to OpenAI gpt-4o-mini
  // when only OpenAI is configured. PG-first, env fallback for both.
  // Recoverable failure — don't poison-cache.
  let anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  let openaiKey = process.env.OPENAI_API_KEY ?? '';
  try {
    const { readCredentials } = await import('../credentials');
    const creds = await readCredentials();
    if (creds.anthropic_api_key) anthropicKey = creds.anthropic_api_key;
    if (creds.openai_api_key) openaiKey = creds.openai_api_key;
  } catch {
    /* PG creds unavailable — fall back to env */
  }

  let llmConfig: Record<string, unknown>;
  if (anthropicKey) {
    llmConfig = {
      provider: 'anthropic',
      config: { apiKey: anthropicKey, model: LLM_MODEL },
    };
  } else if (openaiKey) {
    // Slightly more expensive than Haiku 4.5 ($1.50 vs $0.80/M input)
    // but lets the user run mem0 with just one vendor configured.
    llmConfig = {
      provider: 'openai',
      config: { apiKey: openaiKey, model: 'gpt-4o-mini' },
    };
  } else {
    warnOnce('no Anthropic or OpenAI API key in operator-credentials or env (add at /settings/api-keys)');
    return null;
  }

  // Per-mode collection name kept only for mem0's internal logging /
  // bookkeeping (its DEFAULT_MEMORY_CONFIG reads it). Our
  // CanonicalVectorStore ignores it — scope lives in payload.user_id.
  const collectionName = `${MEM0_COLLECTION_PREFIX}_${resolution.mode}`;
  const vecTable = resolution.mode === 'openai' ? 'memory_vec_openai' : 'memory_vec_local';

  // Vector-store selection. Prefer the canonical store (migration 081)
  // when pgvector is present; fall back to mem0's in-process `memory`
  // provider when it isn't. The in-process store is volatile (lost on
  // restart) but lets memory:* work end-to-end during local-dev /
  // pre-extension setups.
  let vectorStoreConfig: Record<string, unknown>;
  try {
    // Probe: does PG have the vector extension available?
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const probe = new Client({ host: pgFields.host, port: pgFields.port, user: pgFields.user, password: pgFields.password, database: pgFields.dbname });
    await probe.connect();
    const r = await probe.query("SELECT 1 FROM pg_available_extensions WHERE name='vector'");
    await probe.end();
    if (r.rowCount && r.rowCount > 0) {
      vectorStoreConfig = {
        provider: 'canonical',
        config: {
          host: pgFields.host,
          port: pgFields.port,
          user: pgFields.user,
          password: pgFields.password,
          dbname: pgFields.dbname,
          collectionName,
          vecTable,
          embeddingModelDims: EMBEDDER_DIM,
        },
      };
    } else {
      warnOnce('pgvector extension not available in embedded PG — falling back to in-process memory store (volatile)');
      vectorStoreConfig = {
        provider: 'memory',
        config: { collectionName, embeddingModelDims: EMBEDDER_DIM },
      };
    }
  } catch (e) {
    warnOnce(`pgvector probe failed: ${(e as Error).message}; falling back to in-process memory store`);
    vectorStoreConfig = {
      provider: 'memory',
      config: { collectionName, embeddingModelDims: EMBEDDER_DIM },
    };
  }

  // Build the embedder config for mem0.
  let embedderConfig: Record<string, unknown>;
  if (resolution.mode === 'openai') {
    embedderConfig = {
      provider: 'openai',
      config: {
        apiKey: resolution.apiKey,
        model: OPENAI_EMBEDDER_MODEL,
        // OpenAI's text-embedding-3-small supports the `dimensions`
        // parameter to truncate from native 1536 → 384, keeping the
        // pgvector schema uniform between modes.
        embeddingDims: EMBEDDER_DIM,
      },
    };
  } else {
    // local
    const customEmbedder = await buildLocalEmbedder();
    embedderConfig = {
      provider: 'custom',
      config: { embed: customEmbedder },
    };
  }

  // mem0 tracks add/update/delete event history in SQLite. Default was
  // `:memory:` (lost on restart). Persist under ~/.papercusp/ so the
  // event log survives so /settings/user/memory can show it.
  let historyDbPath = ':memory:';
  try {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const dir = path.join(os.homedir(), '.papercusp');
    await fs.mkdir(dir, { recursive: true });
    historyDbPath = path.join(dir, 'mem0-history.db');
  } catch {
    /* fall back to in-memory if we can't write */
  }

  // Feed user-feedback patterns into mem0's extraction prompt so it
  // adapts over time. Best-effort: if the table doesn't exist or PG is
  // unreachable, we just don't pass customInstructions.
  let customInstructions: string | undefined;
  try {
    const { buildLearningInstructions } = await import('./learning');
    customInstructions = (await buildLearningInstructions()) ?? undefined;
  } catch { /* best-effort */ }

  try {
    const mem0 = await dynamicImport<Mem0Module & { VectorStoreFactory: { create: (provider: string, config: Record<string, unknown>) => unknown } }>(MEM0_PACKAGE);
    patchVectorStoreFactory(mem0);
    const { Memory } = mem0;
    _client = new Memory({
      embedder: embedderConfig,
      vectorStore: vectorStoreConfig,
      llm: llmConfig,
      historyDbPath,
      ...(customInstructions ? { customInstructions } : {}),
    });
    _clientMode = resolution.mode;
    _clientBuiltAt = Date.now();
    return _client;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/cannot find module|MODULE_NOT_FOUND|Cannot resolve/i.test(msg)) {
      _clientPermanentFailure = true;
      warnOnce(`${msg}. Run 'npm install --legacy-peer-deps' in apps/operator to enable.`);
    } else {
      // Unknown failure — retry next call.
      warnOnce(msg);
    }
    return null;
  }
}

/**
 * Returns the mem0 client OR null if dependencies aren't installed,
 * the user disabled memory, or PG isn't reachable. Callers handle the
 * null case as a no-op.
 */
export async function getMemoryClient(): Promise<MemoryClient | null> {
  return tryLoad();
}

/**
 * Inspection helper for the settings UI / status displays.
 */
export function getResolvedMode(): ResolvedMode | null {
  return _clientMode;
}

/**
 * Force the cached client to be rebuilt on next access. Called by the
 * feedback path after high-impact mutations (forget_all) so the
 * learning-loop instructions apply immediately rather than waiting
 * for the 1-hour TTL.
 */
export function invalidateMemoryClient(): void {
  _client = null;
  _clientBuiltAt = 0;
}

