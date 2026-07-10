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
 * embed-fn BODIES stay bespoke here (the admission-governed OpenAI fetch) —
 * the local leg now reuses `@papercusp/memory`'s `buildLocalEmbedder` (see
 * EI-9143 below) so there is exactly one local-transformers pipeline builder
 * in the codebase, shared with mem0.
 *
 * EI-9143 (2026-07-10): this file used to construct its OWN bare
 * `transformers.pipeline('feature-extraction', …)` call with no
 * `session_options`, independent of `libs/generic/memory`'s worker. ONNX
 * Runtime defaults intra-op threads to EVERY core and spin-waits them
 * (the same class of bug WI-3792 root-caused and fixed at the 3 pipeline
 * sites inside `libs/generic/memory` — this was an unfixed 4th site, since
 * it never routed through that package's capped/worker-isolated builder).
 * Every recipes:search / search:semantic call that fell through to the
 * local embedder (e.g. after an OpenAI quota/cooldown) could spin up an
 * uncapped, all-core spin-wait pool, explaining the ~5% recipes:search
 * timeouts (60s) tracked in EI-9143. Fixed by delegating to
 * `buildLocalEmbedder` (same model, same output shape — a drop-in
 * `Embedder` — but worker-thread isolated with `embedViaWorker` and,
 * on inline fallback, capped via `ORT_SESSION_OPTIONS`).
 */

import type { Embedder } from '@papercusp/search';
import { buildGemmaEmbedder, buildLocalEmbedder } from '@papercusp/memory';
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

export async function buildQueryEmbedder(): Promise<Embedder | null> {
  try {
    const resolved = await resolveEmbedderWith({
      readPreference: readEmbedderPreference,
      resolveKey: resolveOpenAiKey,
      localInstalled: localAvailable,
      isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
      buildOpenAi: buildAdmissionGovernedOpenAiEmbedder,
      buildLocal: buildLocalEmbedder,
      // This is the QUERY embedder, so EmbeddingGemma gets the query prompt
      // (its dual-encoder is trained so query-prompt vectors match the
      // document-prompt vectors written on the storage side).
      buildGemma: async () => buildGemmaEmbedder({ kind: 'query' }),
    });
    if (resolved.mode === 'disabled') return null;
    return resolved.embed;
  } catch {
    // Mirrors the prior local-mode behavior: a pipeline load failure (package missing,
    // model fetch failed, …) degrades to BM25-only rather than throwing.
    return null;
  }
}
