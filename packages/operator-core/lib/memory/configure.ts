/**
 * Operator host binding for `@papercusp/memory`.
 *
 * Wires the seams the store core needs: where the embedded-pg lives, the
 * LLM credentials for mem0's fact-extraction, the resolved embedder (the
 * operator owns the openai → local → disabled cascade and hands back a
 * pre-built embed fn), an explicit-mode embedder builder for the re-embed
 * pass, and the optional adaptive-instruction feed from the learning loop.
 *
 * Imported for its side-effect by `./index` and the deep-path shims
 * (`./mem0-client`, `./mem0-connection`, `./reembed`) so `configureMemory()`
 * runs before any store API is touched, regardless of entry point.
 *
 * The embedder cascade mirrors `lib/agent-tools/search/embedder.ts`
 * (search uses the same OpenAI-or-local resolution). They're deliberately
 * kept separate for now — search returns just `(text)=>number[]|null`,
 * while memory also needs the resolved `mode` to pick the per-model vec
 * table. A future share could lift the common core; not worth blocking
 * the extraction on it.
 *
 * Part of papercusp-systems-abstraction-2026-05-29 (P-021).
 */

import os from 'node:os';
import path from 'node:path';
import {
  configureMemory,
  buildLocalEmbedder,
  registerMemoryBackend,
  ClaudeFileMemoryBackend,
  CLAUDE_FILE_BACKEND_NAME,
  claudeProjectMemoryDir,
  HybridBackend,
  Mem0Backend,
  type EmbedFn,
  type ResolvedEmbedder,
} from '@papercusp/memory';
import { readCredentials } from '../credentials';
import { loadVoicePrefs } from '../voice-prefs';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { buildLearningInstructions } from './learning';
import {
  currentMemoryBackendChoice,
  initMemoryBackendSelection,
} from './backend-selection';
import { getSessionExtractionLlm } from './session-extraction-llm';

const EMBEDDER_DIM = 384;
const OPENAI_EMBEDDER_MODEL = 'text-embedding-3-small';
const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

// Dodge bundler static analysis — @huggingface/transformers is an
// optional, lazily-resolved dependency (only present when local mode is
// in play).
const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as <T>(specifier: string) => Promise<T>;

/** Resolve the OpenAI key: operator credentials first, env fallback.
 *  Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export async function resolveOpenAiKey(): Promise<string> {
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const creds = await readCredentials();
    if (creds.openai_api_key) key = creds.openai_api_key;
  } catch {
    /* PG creds unavailable — fall back to env */
  }
  return key;
}

/** OpenAI text-embedding-3-small, truncated to 384 dims via the API.
 *
 * Resilient: a TRANSIENT failure (429 rate-limit, 5xx, network/fetch error) is
 * retried with exponential backoff before giving up — a burst of writes (e.g.
 * learning-pack seeding fires items in concurrent batches) used to fail wholesale
 * the moment OpenAI rate-limited or hiccupped, surfacing as "N write(s) failed".
 * A NON-retryable client error (401 bad/expired key, 400, 403) fails fast with a
 * clear message — retrying won't help, and the caller should fix the key. */
export function buildOpenAiEmbedder(apiKey: string): EmbedFn {
  const MAX_ATTEMPTS = 4; // 1 try + 3 retries
  return async (text: string): Promise<number[]> => {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // 300ms, 600ms, 1200ms backoff — rides out a transient rate-limit/blip.
        await new Promise((res) => setTimeout(res, 300 * 2 ** (attempt - 1)));
      }
      try {
        const r = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: OPENAI_EMBEDDER_MODEL,
            input: text,
            dimensions: EMBEDDER_DIM,
          }),
        });
        if (r.ok) {
          const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
          return j.data[0].embedding;
        }
        const body = await r.text().catch(() => '');
        const err = new Error(`openai_embed_failed_${r.status}: ${body}`);
        // 429 (rate limit) + 5xx are transient → retry; other 4xx (401/400/403)
        // are a config/auth problem → fail fast (no point retrying a bad key).
        if (r.status === 429 || r.status >= 500) {
          lastErr = err;
          continue;
        }
        throw err;
      } catch (e) {
        // A non-retryable openai_embed_failed_4xx (thrown above) propagates; a
        // network/fetch error is transient → retry until attempts are exhausted.
        if (e instanceof Error && /^openai_embed_failed_4(?!29)/.test(e.message)) throw e;
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastErr ?? new Error('openai_embed_failed: retries exhausted');
  };
}

/** Is the local transformers package installed?
 *  Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export async function localAvailable(): Promise<boolean> {
  try {
    await dynamicImport(TRANSFORMERS_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/** Read the live embedder preference (env override → persisted voice pref →
 *  'auto'). Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export async function readEmbedderPreference(): Promise<'auto' | 'openai' | 'local' | 'disabled'> {
  // Env override first (memory-backend-improve-and-hybrid P-004b): lets the
  // bench force one leg (e.g. PAPERCUSP_MEMORY_EMBEDDER=local to measure the
  // BGE-ONNX leg) without flipping the live operator preference in PG.
  const env = process.env.PAPERCUSP_MEMORY_EMBEDDER;
  if (env === 'auto' || env === 'openai' || env === 'local' || env === 'disabled') return env;
  try {
    const prefs = await loadVoicePrefs();
    return prefs.memoryEmbedderMode;
  } catch {
    return 'auto';
  }
}

/**
 * Build an embedder for an explicit mode. Throws if that mode's
 * credentials/packages aren't available (the re-embed pass surfaces it).
 */
async function buildEmbedderForMode(mode: 'openai' | 'local'): Promise<EmbedFn> {
  if (mode === 'openai') {
    const key = await resolveOpenAiKey();
    if (!key) throw new Error('openai_api_key not configured');
    return buildOpenAiEmbedder(key);
  }
  // local — worker-thread isolated, inline fallback.
  return buildLocalEmbedder();
}

/**
 * Injectable seams for the embedder cascade — the pure core
 * (`resolveEmbedderWith`) takes these so the four-way cascade can be
 * table-tested without real network/credential/package I/O (GAP 4). The
 * production `resolveEmbedder` wires the real implementations.
 */
export interface ResolveEmbedderDeps {
  readPreference: () => Promise<'auto' | 'openai' | 'local' | 'disabled'>;
  resolveKey: () => Promise<string>;
  localInstalled: () => Promise<boolean>;
  buildOpenAi: (key: string) => EmbedFn;
  buildLocal: () => Promise<EmbedFn>;
}

/**
 * Pure cascade core. 'disabled' is a hard stop; 'openai'/'local' are forced
 * (fall to disabled with a specific reason if their dependency is missing);
 * 'auto' cascades openai → local → disabled. No runtime behavior differs from
 * the previous inline form — the seams are just injected.
 */
export async function resolveEmbedderWith(deps: ResolveEmbedderDeps): Promise<ResolvedEmbedder> {
  const preference = await deps.readPreference();
  if (preference === 'disabled') {
    return { mode: 'disabled', reason: 'user_disabled' };
  }

  const key = await deps.resolveKey();

  if (preference === 'openai') {
    if (key) return { mode: 'openai', dims: EMBEDDER_DIM, embed: deps.buildOpenAi(key) };
    return { mode: 'disabled', reason: 'openai_forced_but_no_key' };
  }

  if (preference === 'local') {
    if (await deps.localInstalled()) {
      return { mode: 'local', dims: EMBEDDER_DIM, embed: await deps.buildLocal() };
    }
    return { mode: 'disabled', reason: 'local_forced_but_not_installed' };
  }

  // 'auto' — openai first, then local, then disabled.
  if (key) return { mode: 'openai', dims: EMBEDDER_DIM, embed: deps.buildOpenAi(key) };
  if (await deps.localInstalled()) {
    return { mode: 'local', dims: EMBEDDER_DIM, embed: await deps.buildLocal() };
  }
  return { mode: 'disabled', reason: 'no_openai_key_and_local_not_installed' };
}

/**
 * Resolve the embedder for the current user preference. 'disabled' is a
 * hard stop; 'auto' cascades openai → local → disabled. Thin production
 * wrapper over `resolveEmbedderWith` with the real seams.
 */
async function resolveEmbedder(): Promise<ResolvedEmbedder> {
  return resolveEmbedderWith({
    readPreference: readEmbedderPreference,
    resolveKey: resolveOpenAiKey,
    localInstalled: localAvailable,
    buildOpenAi: buildOpenAiEmbedder,
    buildLocal: buildLocalEmbedder,
  });
}

// The Claude Code topic-file bridge (generalize-memory-backend-swappable
// D-005 / claude-memory-projection-integration P-004): select with
// PAPERCUSP_MEMORY_BACKEND=claude-file to read/write the owner's native
// Claude file memory through the neutral seam. The store location is the
// Claude project derived from $HOME (where the owner runs Claude Code) —
// override the dir with PAPERCUSP_CLAUDE_MEMORY_DIR or the project with
// PAPERCUSP_CLAUDE_PROJECT_DIR. Never creates the dir: a box without a
// Claude store reports unavailable rather than inventing one. MEMORY.md
// (the auto-generated index) is never touched; the SessionStart
// memory-compact hook projects new topic files into it.
function makeClaudeFileBackend(): ClaudeFileMemoryBackend {
  return new ClaudeFileMemoryBackend({
    memoryDir:
      process.env.PAPERCUSP_CLAUDE_MEMORY_DIR ||
      claudeProjectMemoryDir(
        process.env.PAPERCUSP_CLAUDE_PROJECT_DIR || os.homedir(),
        path.join(os.homedir(), '.claude'),
      ),
  });
}
registerMemoryBackend(CLAUDE_FILE_BACKEND_NAME, makeClaudeFileBackend);

// The hybrid store (memory-backend-improve-and-hybrid P-020): select with
// PAPERCUSP_MEMORY_BACKEND=hybrid (or the live settings flip). Fuses a
// LEXICAL leg (the claude-file topic-file token search — wins exact-identifier
// recall) and a COSINE leg (the mem0/canonical pgvector store — wins
// paraphrase recall) via cosine-gated reciprocal-rank fusion, so one backend
// captures both bench columns without admitting hard-negative noise (the
// cosine leg's FP floor is the gate). WRITES delegate to the mem0 leg — the
// canonical PG store — so the hybrid is cross-backend by construction (D-002).
registerMemoryBackend('hybrid', () => new HybridBackend(makeClaudeFileBackend(), new Mem0Backend()));

configureMemory({
  getAdminUrl: getHarnessAdminUrl,
  // The operator's memory tables live in the harness_shared schema
  // (migration 081); the embedded-pg database is `papercusp`; the SQLite
  // event-history log persists under ~/.papercusp.
  schema: 'harness_shared',
  defaultDbName: 'papercusp',
  localStoreDir: path.join(os.homedir(), '.papercusp'),
  // The swappable-store selector (generalize-memory-backend-swappable
  // D-004): which MemoryBackend getMemoryBackend() serves. A LIVE thunk
  // (mem0-revive-or-retire / Brief 30) reading the persisted operator
  // setting → PAPERCUSP_MEMORY_BACKEND → 'mem0', re-evaluated every call
  // so a UI flip on the settings memory page takes effect with no
  // restart. An unknown name fails loud at first use.
  backend: () => currentMemoryBackendChoice(),
  getCredentials: async () => {
    const c = await readCredentials();
    return { openai_api_key: c.openai_api_key, anthropic_api_key: c.anthropic_api_key };
  },
  // Fact-extraction cascade rung #1 (mem0-extraction-via-claude-session
  // D-001/D-002): Haiku on the Claude-session anthropic-direct transport —
  // no API key to rot, $0 marginal on the subscription. Resolves null
  // (key rungs unchanged) when there's no session, the probe fails, the
  // rung auth-died this process, or PAPERCUSP_MEM0_SESSION_EXTRACTION=0.
  getExtractionLlm: () => getSessionExtractionLlm(),
  resolveEmbedder,
  buildEmbedderForMode,
  // Optional: adaptive extraction instructions from the operator's
  // learning loop. Best-effort — the package treats it as a black box.
  getLearningInstructions: async () => (await buildLearningInstructions()) ?? undefined,
});

// Best-effort: hydrate the persisted memory-backend selection into the
// in-process cache so getMemoryBackend()'s thunk reflects it. Until this
// resolves (or if PG isn't up), the thunk falls back to the env/default.
// A UI write (writeMemoryBackendChoice) also updates the cache live.
void initMemoryBackendSelection();
