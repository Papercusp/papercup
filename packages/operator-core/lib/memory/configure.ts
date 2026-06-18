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

// ── Embedder retry budget (watchdog-embed-resilience-and-dedup-2026-06-17 P-001;
//    patience raised 2026-06-18 per owner ask, to ride out longer TPM bursts) ──
// A sustained org-wide TPM 429 on text-embedding-3-small (1M TPM) hard-failed
// memory:remember/search FLEET-WIDE on 2026-06-17. We ride the spikes out on the
// SAME embedder (no fallback) with a header-aware, JITTERED, budget-capped retry.
// Budget is ~50s — just UNDER the 60s per-tool-call timeout. SAFE for a multi-fact
// memory:remember because mem0 embeds facts in PARALLEL (Promise.all, mem0-client.ts
// embedBatch), so a call's embed phase is bounded by the SLOWEST single embed, not
// the sum — N facts don't multiply the wait.
// THUNDERING HERD: full jitter on the exponential path AND a widened jitter on the
// reset-header path (EMBED_RESET_JITTER_MS) so many clients waiting on the SAME reset
// window don't all re-fire at the exact same moment.
export const EMBED_MAX_ATTEMPTS = 12; // 1 try + 11 retries
const EMBED_MAX_TOTAL_WAIT_MS = 50_000; // never block ONE embed call past this (< the 60s tool timeout)
const EMBED_BACKOFF_BASE_MS = 500;
const EMBED_BACKOFF_CAP_MS = 8_000; // per-attempt ceiling (exponential / no-hint path)
const EMBED_RESET_JITTER_MS = 2_500; // spread post-reset retries across this window (anti-herd)

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

/** Tunable seams for the embedder retry loop (watchdog-embed-resilience-and-dedup
 *  -2026-06-17 P-001). Production passes none (defaults); tests inject a no-op
 *  `sleep` + deterministic `rand` to assert attempt counts without real delays. */
export interface OpenAiEmbedderOpts {
  maxAttempts?: number;
  maxTotalWaitMs?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** "2m59.56s" / "1.5s" / "6ms" / "150" (bare = seconds) → ms; null if unparseable.
 *  OpenAI's `x-ratelimit-reset-tokens`/`-requests` use the compact-duration form;
 *  `Retry-After` uses bare integer seconds. */
export function parseOpenAiDurationMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (s === '') return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000); // bare seconds
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : null;
}

/** The server's own "try again in N" hint from a 429/5xx response, in ms, or null.
 *  Prefers `Retry-After` (HTTP secs or an HTTP-date), then OpenAI's
 *  `x-ratelimit-reset-tokens`/`-requests` reset windows. */
export function retryDelayFromHeaders(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return (
    parseOpenAiDurationMs(headers.get('x-ratelimit-reset-tokens')) ??
    parseOpenAiDurationMs(headers.get('x-ratelimit-reset-requests'))
  );
}

/** Next backoff wait (ms) for `attempt` (0-based), honoring a server hint when
 *  present, with FULL jitter, clamped to the per-attempt cap AND the remaining
 *  total-wait budget. Returns null when the budget is spent → stop retrying. */
export function nextEmbedBackoffMs(
  attempt: number,
  serverHintMs: number | null,
  waitedMs: number,
  opts: Pick<OpenAiEmbedderOpts, 'maxTotalWaitMs' | 'baseMs' | 'capMs' | 'rand'> = {},
): number | null {
  const maxTotal = opts.maxTotalWaitMs ?? EMBED_MAX_TOTAL_WAIT_MS;
  const base = opts.baseMs ?? EMBED_BACKOFF_BASE_MS;
  const cap = opts.capMs ?? EMBED_BACKOFF_CAP_MS;
  const rand = opts.rand ?? Math.random;
  const remaining = maxTotal - waitedMs;
  if (remaining <= 0) return null;
  let wait: number;
  if (serverHintMs != null && serverHintMs > 0) {
    // Honor the server's FULL reset window (bounded only by the remaining budget below)
    // + a WIDENED jitter so many clients waiting on the SAME reset don't all re-fire at
    // once — de-correlates the retry storm at the window boundary (anti-thundering-herd).
    wait = serverHintMs + Math.floor(rand() * EMBED_RESET_JITTER_MS);
  } else {
    // Full jitter over an exponential window, with a small floor.
    const window = Math.min(cap, base * 2 ** attempt);
    wait = Math.max(base, Math.floor(rand() * window));
  }
  return Math.min(wait, remaining);
}

/** OpenAI text-embedding-3-small, truncated to 384 dims via the API.
 *
 * Resilient: a TRANSIENT failure (429 rate-limit, 5xx, network/fetch error) is
 * retried with HEADER-AWARE, jittered exponential backoff before giving up. A
 * burst of writes (learning-pack seeding fires concurrent batches) — or a
 * sustained org-wide TPM saturation (text-embedding-3-small, 1M TPM, which
 * hard-failed memory:remember/search FLEET-WIDE on 2026-06-17) — no longer fails
 * the moment OpenAI rate-limits. We ride it out on the SAME embedder (no
 * fallback): up to `maxAttempts` (8) across a capped ~30s budget, honoring the
 * server's own Retry-After / x-ratelimit-reset-tokens hint when present, with
 * full jitter to de-sync the post-unjam herd. A NON-retryable client error (401
 * bad/expired key, 400, 403) still fails fast — retrying won't help, fix the key.
 * (watchdog-embed-resilience-and-dedup-2026-06-17 P-001.) */
export function buildOpenAiEmbedder(apiKey: string, opts: OpenAiEmbedderOpts = {}): EmbedFn {
  const maxAttempts = opts.maxAttempts ?? EMBED_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? realSleep;
  return async (text: string): Promise<number[]> => {
    let lastErr: Error | null = null;
    let waitedMs = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let serverHintMs: number | null = null;
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
        if (r.status !== 429 && r.status < 500) throw err;
        lastErr = err;
        serverHintMs = retryDelayFromHeaders(r.headers);
      } catch (e) {
        // A non-retryable openai_embed_failed_4xx (thrown above) propagates; a
        // network/fetch error is transient → retry until attempts/budget run out.
        if (e instanceof Error && /^openai_embed_failed_4(?!29)/.test(e.message)) throw e;
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
      if (attempt >= maxAttempts - 1) break; // out of attempts — surface the failure now
      const waitMs = nextEmbedBackoffMs(attempt, serverHintMs, waitedMs, opts);
      if (waitMs == null) break; // total-wait budget spent — surface the failure now
      waitedMs += waitMs;
      await sleep(waitMs);
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
