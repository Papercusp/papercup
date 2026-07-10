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
import { buildSidecarAwareEmbedder } from '../../memory/embed-sidecar-wiring';
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

/** The query embedder PLUS its resolved mode + dims. Consumers whose stored
 *  vectors carry a space discriminator (migration 530/551 `<col>_mode`) need
 *  the mode to filter `WHERE <col>_mode = <active>` — cosine against a
 *  foreign-space vector is meaningless (embedding-space-vs-dimension). */
export interface ResolvedQueryEmbedder {
  mode: 'openai' | 'local' | 'gemma' | 'harrier';
  dims: number;
  embed: Embedder;
}

/** Opt-in bound on the query-embedder ACQUISITION (the resolveEmbedderWith
 *  cascade: OpenAI-key resolve, or — when OpenAI embed quota is exhausted — the
 *  local sidecar spawn + ONNX pipeline cold-start that runs 15–30s the first
 *  time). `acquireBudgetMs` caps that wait: on timeout the acquisition resolves
 *  `null`, which is the SAME "no embedder → degrade to BM25" signal every caller
 *  already handles, so bounding it is backward-compatible (0/undefined ⇒ today's
 *  unbounded wait — background/batch callers keep it). This is the shared, central
 *  form of the bound WI-3860 first applied inline in
 *  endpoint-route/routes/adv/sessions.ts; see WI-3922. */
export interface QueryEmbedderAcquireOpts {
  acquireBudgetMs?: number;
}

/** Interactive default acquisition budget (ms) — env-overridable via
 *  PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS; ≤0 disables the bound. */
export function interactiveEmbedAcquireBudgetMs(): number {
  const v = Number(process.env.PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : 4000;
}

/** Race an acquisition against a time budget → resolve `null` on timeout. The
 *  losing acquisition is NOT cancelled (no cancel seam on the cascade); it runs
 *  on to warm the process-memoized pipeline for a later query, and its late
 *  settle is swallowed so it never surfaces as an unhandled rejection.
 *  Exported for unit test (embedder.test.ts) — internal otherwise. */
export async function withAcquireBudget<T>(p: Promise<T | null>, budgetMs: number): Promise<T | null> {
  if (!(budgetMs > 0)) return await p;
  return await new Promise<T | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: T | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => finish(null), budgetMs);
    p.then((v) => finish(v), () => finish(null));
  });
}

export async function buildQueryEmbedderResolved(
  opts?: QueryEmbedderAcquireOpts,
): Promise<ResolvedQueryEmbedder | null> {
  try {
    const acquire = resolveEmbedderWith({
      readPreference: readEmbedderPreference,
      resolveKey: resolveOpenAiKey,
      localInstalled: localAvailable,
      isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
      buildOpenAi: buildAdmissionGovernedOpenAiEmbedder,
      // Sidecar-first local legs (P-004): shared warm model when the host
      // runs the embed sidecar, bit-identical in-process fallback otherwise.
      buildLocal: () => buildSidecarAwareEmbedder('local', 'query'),
      // This is the QUERY embedder, so EmbeddingGemma gets the query prompt
      // (its dual-encoder is trained so query-prompt vectors match the
      // document-prompt vectors written on the storage side).
      buildGemma: () => buildSidecarAwareEmbedder('gemma', 'query'),
      // harrier-oss (P-014, selectable only): queries carry the instruct
      // prefix; documents embed raw. Native 1024 — a vector(384) surface
      // must check `dims` before ranking against it.
      buildHarrier: () => buildSidecarAwareEmbedder('harrier', 'query'),
    });
    const resolved = await withAcquireBudget(acquire, opts?.acquireBudgetMs ?? 0);
    if (resolved === null || resolved.mode === 'disabled') return null;
    return { mode: resolved.mode, dims: resolved.dims, embed: resolved.embed };
  } catch {
    // Mirrors the prior local-mode behavior: a pipeline load failure (package missing,
    // model fetch failed, …) degrades to BM25-only rather than throwing.
    return null;
  }
}

export async function buildQueryEmbedder(opts?: QueryEmbedderAcquireOpts): Promise<Embedder | null> {
  const resolved = await buildQueryEmbedderResolved(opts);
  return resolved ? resolved.embed : null;
}
