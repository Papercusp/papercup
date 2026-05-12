/**
 * mem0 client singleton for the operator's persistent memory.
 *
 * Plan 3. Backed by mem0ai v3 OSS in library mode:
 *   - storage: pgvector (embedded PG)
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
 * Per-user scoping: userId = session.user.id (Plan 4 dependency).
 * Workspace-shared memories: userId = `workspace:<id>`, metadata.shared.
 *
 * Vector dimensions are kept at 384 across both embedders so the
 * pgvector schema is uniform. OpenAI text-embedding-3-small supports
 * a `dimensions` request parameter that truncates from native 1536 to
 * 384 with negligible quality loss (per OpenAI's own benchmarks).
 *
 * Vector SPACES still differ — a vector from BGE-small and one from
 * OpenAI aren't comparable even at the same dim count. So we use a
 * per-mode collection: `operator_memory_openai` vs `operator_memory_local`.
 * Switching mode "loses" your old memories until you switch back, but
 * doesn't corrupt either set. A future ship can add re-embed-on-switch
 * if it becomes a real friction point.
 *
 * Failure mode: if a fatal load error occurs (missing npm package),
 * memory tools return graceful no-ops. Logs once per process per
 * distinct reason. Recoverable failures (transient PG, missing key the
 * user can add via /settings/api-keys) DON'T poison-cache, so the next
 * call retries.
 */

const EMBEDDER_DIM = 384;
const LOCAL_EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const LLM_MODEL = 'claude-haiku-4-5';
const MEM0_COLLECTION_PREFIX = 'operator_memory';

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

  return async (text: string): Promise<number[]> => {
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
  if (_client) return _client;
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

  // Per-mode collection name keeps vector spaces from mixing.
  const collectionName = `${MEM0_COLLECTION_PREFIX}_${resolution.mode}`;

  // Vector-store selection. Prefer pgvector when available; fall back
  // to mem0's in-process `memory` provider when the PG doesn't ship
  // the `vector` extension. The in-process store is volatile (lost on
  // restart) but lets memory:* work end-to-end.
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
        provider: 'pgvector',
        config: {
          host: pgFields.host,
          port: pgFields.port,
          user: pgFields.user,
          password: pgFields.password,
          dbname: pgFields.dbname,
          collectionName,
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

  try {
    const { Memory } = await dynamicImport<Mem0Module>(MEM0_PACKAGE);
    _client = new Memory({
      embedder: embedderConfig,
      vectorStore: vectorStoreConfig,
      llm: llmConfig,
      historyDbPath: ':memory:',
    });
    _clientMode = resolution.mode;
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

