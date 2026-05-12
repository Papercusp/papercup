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

import type { Memory } from 'mem0ai/oss';
import { getOrgPg } from '@restart/db-org';

const MEM0_COLLECTION = 'operator_memory';
const EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';
const EMBEDDER_DIM = 384;
const LLM_MODEL = 'claude-haiku-4-5';

let _client: Memory | null = null;
let _clientLoadFailed = false;
let _warnedAboutMissingDeps = false;

function warnOnceMissingDeps(reason: string): void {
  if (_warnedAboutMissingDeps) return;
  _warnedAboutMissingDeps = true;
  console.warn(`[mem0] not available: ${reason}. memory:* tools will no-op until 'npm install' brings in mem0ai + @xenova/transformers + @anthropic-ai/sdk.`);
}

/**
 * Try to load the mem0 client. Returns null if the dependencies aren't
 * installed or if config can't be assembled.
 */
async function tryLoad(): Promise<Memory | null> {
  if (_client) return _client;
  if (_clientLoadFailed) return null;

  // Resolve the embedded PG connection string the same way every other
  // module in this app does — via getOrgPg's connection metadata. We
  // need a raw connection string to hand to pgvector.
  let connectionString: string;
  try {
    const { connectionString: cs } = await import('./mem0-connection');
    connectionString = await cs();
  } catch (e) {
    _clientLoadFailed = true;
    warnOnceMissingDeps(`couldn't resolve PG connection: ${(e as Error).message}`);
    return null;
  }

  try {
    // Dynamic imports so this module can be imported even when the
    // deps aren't yet installed (build-time + boot-time safety).
    const { Memory } = await import('mem0ai/oss');
    // We import transformers lazily inside the custom embedder, not
    // here, so mem0 can construct without it.
    // The embedder runs INSIDE mem0's pipeline.
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
          apiKey: process.env.ANTHROPIC_API_KEY ?? '',
          model: LLM_MODEL,
        },
      },
      historyDbPath: ':memory:',
    });

    return _client;
  } catch (e) {
    _clientLoadFailed = true;
    warnOnceMissingDeps((e as Error).message);
    return null;
  }
}

async function buildLocalEmbedder(): Promise<(text: string) => Promise<number[]>> {
  // @xenova/transformers loads ~400MB. Singleton per process.
  type Pipeline = (text: string, opts: unknown) => Promise<{ data: Float32Array }>;
  let pipelinePromise: Promise<Pipeline> | null = null;

  return async (text: string): Promise<number[]> => {
    if (!pipelinePromise) {
      const transformers = (await import('@xenova/transformers')) as {
        pipeline: (task: string, model: string) => Promise<Pipeline>;
      };
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
export async function getMemoryClient(): Promise<Memory | null> {
  return tryLoad();
}
