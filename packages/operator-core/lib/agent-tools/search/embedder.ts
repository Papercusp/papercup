/**
 * Query-embedding provider for `search:semantic` — the operator's
 * EmbedderProvider seam for `@papercusp/search`. Same cascade mem0 uses
 * (OpenAI when a key is configured, else local transformers), but lazy.
 * Returns null when no embedder is available — the engine then falls back
 * to BM25-only.
 *
 * Extracted out of search/semantic.ts per
 * papercusp-systems-abstraction-2026-05-29 (P-020).
 *
 * MODE RESOLUTION is delegated to `memory/configure.ts`'s `resolveEmbedderWith`
 * cascade (EI-8913) — this used to re-derive its own openai/local decision
 * independently (env override missed, OpenAI post-failure cooldown ignored),
 * which could silently pick a DIFFERENT embedder than memory for the exact
 * same text, desynchronizing query vectors from stored ones. Only the actual
 * embed-fn BODIES stay bespoke here (the admission-governed OpenAI fetch and
 * the local-transformers pipeline) — the decision of WHICH one to build now
 * has exactly one source of truth, shared with mem0.
 */

import type { Embedder } from '@papercusp/search';
import { embedAdmission, headersToRecord, retryAfterMs } from '../../memory/embed-admission';
import {
  resolveEmbedderWith,
  readEmbedderPreference,
  resolveOpenAiKey,
  localAvailable,
  isOpenAiEmbedInCooldown,
} from '../../memory/configure';

const EMBEDDER_DIM = 384;
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const LOCAL_EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';

function buildAdmissionGovernedOpenAiEmbedder(key: string): Embedder {
  return async (text: string) => {
    // BENCH lane of the shared embed-TPM admission governor
    // (watchdog-and-exposed-systems-improvement-2026-06-18 P-002). This is the high-volume
    // path that exhausted the org TPM and starved memory. Acquire a governed slot; a SHED
    // (null) throws — runHybridSearch try/catches the embedder → degrades to BM25 (P-008),
    // so the search still returns rather than hard-failing. The governor's concurrency + itpm
    // caps keep aggregate embed rate under the ceiling so prod memory keeps its headroom.
    const adm = embedAdmission();
    const slot = await adm.acquire(text, 'bench');
    if (slot === null) throw new Error('openai_embed_shed'); // admission shed → engine falls to BM25
    try {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: OPENAI_EMBEDDER_MODEL,
          input: text,
          dimensions: EMBEDDER_DIM,
        }),
      });
      adm.recordResponse(headersToRecord(r.headers)); // learn the live limit / pause on remaining=0
      if (!r.ok) {
        if (r.status === 429) adm.penalize({ retryAfterMs: retryAfterMs(headersToRecord(r.headers)) });
        throw new Error(`openai_embed_${r.status}`);
      }
      const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
      return j.data[0].embedding;
    } finally {
      slot.release();
    }
  };
}

async function buildLocalTransformersEmbedder(): Promise<Embedder> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamicImport = new Function('s', 'return import(s)') as any;
  const transformers = await dynamicImport('@huggingface/transformers');
  const pipe = await transformers.pipeline('feature-extraction', LOCAL_EMBEDDER_MODEL);
  return async (text: string) => {
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data) as number[];
  };
}

export async function buildQueryEmbedder(): Promise<Embedder | null> {
  try {
    const resolved = await resolveEmbedderWith({
      readPreference: readEmbedderPreference,
      resolveKey: resolveOpenAiKey,
      localInstalled: localAvailable,
      isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
      buildOpenAi: buildAdmissionGovernedOpenAiEmbedder,
      buildLocal: buildLocalTransformersEmbedder,
    });
    if (resolved.mode === 'disabled') return null;
    return resolved.embed;
  } catch {
    // Mirrors the prior local-mode behavior: a pipeline load failure (package missing,
    // model fetch failed, …) degrades to BM25-only rather than throwing.
    return null;
  }
}
