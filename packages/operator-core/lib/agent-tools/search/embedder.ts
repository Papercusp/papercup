/**
 * Query-embedding provider for `search:semantic` — the operator's
 * EmbedderProvider seam for `@papercusp/search`. Same cascade mem0 uses
 * (OpenAI when a key is configured, else local transformers), but lazy.
 * Returns null when no embedder is available — the engine then falls back
 * to BM25-only.
 *
 * Extracted out of search/semantic.ts per
 * papercusp-systems-abstraction-2026-05-29 (P-020).
 */

import type { Embedder } from '@papercusp/search';

const EMBEDDER_DIM = 384;
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const LOCAL_EMBEDDER_MODEL = 'Xenova/bge-small-en-v1.5';

type ResolvedMode = 'openai' | 'local';

export async function buildQueryEmbedder(): Promise<Embedder | null> {
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const { readCredentials } = await import('../../credentials');
    const creds = await readCredentials();
    if (creds.openai_api_key) key = creds.openai_api_key;
  } catch {
    /* env fallback */
  }
  let mode: ResolvedMode | null = null;
  try {
    const { loadVoicePrefs } = await import('../../voice-prefs');
    const prefs = await loadVoicePrefs();
    const m = prefs.memoryEmbedderMode;
    if (m === 'openai' && key) mode = 'openai';
    else if (m === 'local') mode = 'local';
    else if (m === 'auto' || !m) {
      if (key) mode = 'openai';
      else mode = 'local';
    }
  } catch {
    if (key) mode = 'openai';
  }
  if (mode === 'openai' && key) {
    return async (text: string) => {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: OPENAI_EMBEDDER_MODEL,
          input: text,
          dimensions: EMBEDDER_DIM,
        }),
      });
      if (!r.ok) throw new Error(`openai_embed_${r.status}`);
      const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
      return j.data[0].embedding;
    };
  }
  if (mode === 'local') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicImport = new Function('s', 'return import(s)') as any;
      const transformers = await dynamicImport('@huggingface/transformers');
      const pipe = await transformers.pipeline('feature-extraction', LOCAL_EMBEDDER_MODEL);
      return async (text: string) => {
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(result.data) as number[];
      };
    } catch {
      return null;
    }
  }
  return null;
}
