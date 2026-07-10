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
  buildGemmaEmbedder,
  registerMemoryBackend,
  ClaudeFileMemoryBackend,
  CLAUDE_FILE_BACKEND_NAME,
  claudeProjectMemoryDir,
  HybridBackend,
  Mem0Backend,
  invalidateMemoryClient,
  type EmbedFn,
  type ResolvedEmbedder,
} from '@papercusp/memory';
import { readCredentials } from '../credentials';
import { loadVoicePrefs } from '../voice-prefs';
import { embedAdmission, headersToRecord, EmbedBudgetExhaustedError } from './embed-admission';
import { clearEmbedExhaustionAlertIfActive, maybeEscalateEmbedExhaustion } from './embed-exhaustion-alert';
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

// ── Embedder retry budget (watchdog-embed-resilience-and-dedup-2026-06-17 P-001) ──
// A sustained org-wide TPM 429 on text-embedding-3-small (1M TPM) hard-failed
// memory:remember/search FLEET-WIDE on 2026-06-17. We ride SHORT spikes out on the
// SAME embedder (no fallback) with a header-aware, JITTERED, budget-capped retry.
//
// ⚠ DEADLINE COUPLING (mem0-timeout-fix-2026-06-24): the budget MUST stay UNDER the
// memory-tool deadline (`memoryToolTimeoutMs`, op-deadline.ts — default 10_000ms).
// HISTORY: this budget was once ~50s ("just under the 60s transport cap"), but B1
// (infra-fail-fast-build-integrity-2026-06-19) later bounded every memory backend
// call at 10s WITHOUT re-coupling this budget — so a throttled embed rode its own 50s
// retry well past the 10s deadline and surfaced as `memory_timeout` (an opaque hang +
// the agent's "mem0 timed out, retrying…" narration) instead of a fast, clean
// degraded envelope. Keep `EMBED_TOTAL_BUDGET_MS` < the deadline so a 429/slow embed
// FAILS FAST and CLEAN. A guard test (configure.test.ts) asserts this invariant.
// SAFE for a multi-fact memory:remember because mem0 embeds facts in PARALLEL
// (Promise.all, mem0-client.ts embedBatch) — a call's embed phase is bounded by the
// SLOWEST single embed, not the sum.
// THUNDERING HERD: full jitter on the exponential path AND a widened jitter on the
// reset-header path (EMBED_RESET_JITTER_MS) so many clients waiting on the SAME reset
// window don't all re-fire at the exact same moment.
export const EMBED_MAX_ATTEMPTS = 12; // 1 try + 11 retries (the WALL-CLOCK budget stops it first)
// Overall wall-clock budget for ONE embed call (all attempts + backoff sleeps + the
// actual fetch time). Must be < memoryToolTimeoutMs (10_000) with headroom for the PG
// op + overhead so the embed gives up BEFORE the outer deadline fires. Env-tunable.
export const EMBED_TOTAL_BUDGET_MS = Number(process.env.PAPERCUSP_EMBED_TOTAL_BUDGET_MS) || 7_000;
// Per-attempt fetch abort: a single OpenAI embed RTT is ~200ms; a call exceeding this
// is a network/connection STALL, so abort it (a hung fetch must not eat the budget).
export const EMBED_FETCH_TIMEOUT_MS = Number(process.env.PAPERCUSP_EMBED_FETCH_TIMEOUT_MS) || 5_000;
const EMBED_MAX_TOTAL_WAIT_MS = EMBED_TOTAL_BUDGET_MS; // cumulative-backoff budget (≤ wall budget)
const EMBED_BACKOFF_BASE_MS = 500;
const EMBED_BACKOFF_CAP_MS = 3_000; // per-attempt ceiling (exponential / no-hint path)
const EMBED_RESET_JITTER_MS = 2_500; // spread post-reset retries across this window (anti-herd)

// ── Single-key exhaustion fallback (EI-3381) ─────────────────────────────────────────────────
// The org's shared OpenAI embed key/quota can be drained by load OUTSIDE this process (another
// machine/service on the same org key, or a genuine billing stop) — the retry loop above rides
// out a SHORT spike on the SAME embedder, but a SUSTAINED exhaustion (openai_embed_quota_exhausted,
// or the retry budget exhausting because the reset window is longer than we can wait) means every
// memory:remember/search call keeps hard-failing for as long as the drain lasts, even though a
// local (BGE-ONNX) embedder may be installed and perfectly able to serve the request. Track the
// most recent such failure and let the 'auto' cascade (resolveEmbedderWith) prefer local for a
// short cooldown window afterward, rather than repeatedly re-trying a key it just learned is dead.
// Bounded, disclosed tradeoff: memories embedded during a cooldown window land in the LOCAL vec
// table (mode='local'), so a search issued during that same window will not see older
// openai-embedded memories (they live in a different per-mode vec table) — reduced recall BREADTH
// for the outage's duration, never a hard failure. A full fix (one shared table / re-embed) is the
// larger follow-up this ticket's other options describe; this is the narrow, safe lever available
// without a data migration or new routing infra.
const OPENAI_EMBED_COOLDOWN_MS = Number(process.env.PAPERCUSP_EMBED_FALLBACK_COOLDOWN_MS) || 60_000;
let openAiEmbedCooldownUntilMs = 0;

// WI-3615: a HARD billing stop (insufficient_quota) fails IDENTICALLY on every retry until the
// key is fixed — the 60s cooldown above is for SOFT/possibly-transient exhaustion (our own daily
// spend cap, which self-clears at UTC rollover; a long-but-finite server reset window). Latching
// those to only 60s on a genuinely dead key thrashes forever: fail -> 60s local -> re-try the same
// dead key -> fail -> repeat, indefinitely (reproduced live: harness_shared.memory_vec_local held
// exactly the memories written inside successive 60s windows, evidence of the thrash). A hard stop
// instead sets this STICKY latch (no auto-expiry) so 'auto' keeps preferring local until something
// that could plausibly have fixed the key happens — clearOpenAiEmbedHardExhaustion() below, called
// when the openai_api_key credential is re-saved (setup:save_key / POST /credentials).
let openAiEmbedHardExhaustedSinceMs: number | null = null;

/** Record an OpenAI embed failure severe enough to prefer local for a while (a hard quota/billing
 *  stop, or the retry budget exhausting entirely). Exported as a seam for tests (GAP 4).
 *
 *  `hard: true` (WI-3615) — an `insufficient_quota` billing stop, known to fail identically
 *  forever until the key is fixed — latches the STICKY exhaustion flag (see
 *  `openAiEmbedHardExhaustedSinceMs` above) in addition to the short cooldown, so 'auto' doesn't
 *  keep re-trying a key it has already proven is dead. Omitted/false (the daily-spend-cap and
 *  retry-budget-exhausted call sites) only sets the short, self-expiring cooldown — those cases
 *  are not necessarily permanent.
 *
 *  EI-7279: the cascade decision (resolveEmbedderWith, above) is only EVALUATED when the mem0
 *  client is (re)built — and mem0-client.ts caches that client for a 1-HOUR TTL. Setting the
 *  cooldown flag alone left it inert for the rest of that hour: the already-built client kept
 *  routing every embed through the SAME dead OpenAI key (each call's own HTTP request still
 *  fails, but the 'auto' cascade that would have picked local never re-runs), so `auto` mode
 *  hard-failed identically to `openai` mode for up to an hour after the fallback should have
 *  engaged — reproduced live 2026-07-04 (two back-to-back memory:remember probes, both
 *  embed_quota_exhausted, well inside one client lifetime). Force a rebuild on the VERY NEXT
 *  call so the cooldown just recorded is actually consulted immediately, not up to an hour late. */
export function markOpenAiEmbedFailure(now: number = Date.now(), opts: { hard?: boolean } = {}): void {
  openAiEmbedCooldownUntilMs = now + OPENAI_EMBED_COOLDOWN_MS;
  if (opts.hard) openAiEmbedHardExhaustedSinceMs = now;
  invalidateMemoryClient();
}

/** Is OpenAI embedding in its post-failure cooldown (the 'auto' cascade should prefer local)?
 *  True during the short self-expiring cooldown OR while the WI-3615 sticky hard-exhaustion latch
 *  is set (no auto-expiry — cleared only by clearOpenAiEmbedHardExhaustion()).
 *  Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export function isOpenAiEmbedInCooldown(now: number = Date.now()): boolean {
  return now < openAiEmbedCooldownUntilMs || openAiEmbedHardExhaustedSinceMs !== null;
}

/** WI-3615: clear the sticky hard-exhaustion latch (does NOT touch the short cooldown) — call
 *  when there's a real reason to believe the key might work again, i.e. the `openai_api_key`
 *  credential was just re-saved. The very next 'auto' resolution re-tries OpenAI once; if it's
 *  still dead the next hard failure re-latches. A no-op if the latch wasn't set. */
export function clearOpenAiEmbedHardExhaustion(): void {
  openAiEmbedHardExhaustedSinceMs = null;
}

/** Test-only reset so cooldown state from one test can't leak into the next. */
export function __resetOpenAiEmbedCooldownForTest(): void {
  openAiEmbedCooldownUntilMs = 0;
  openAiEmbedHardExhaustedSinceMs = null;
}

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
    // FAIL-FAST (mem0-timeout-fix-2026-06-24): when the server's reset window is LONGER
    // than our remaining budget, the reset will NOT arrive before we have to give up — so
    // sleeping the whole budget just to fail anyway is pure latency. Give up NOW (clean,
    // fast degraded envelope) rather than burning the budget on a doomed wait. This is the
    // case that hit memory:* during the org-wide 1M-TPM drain (reset ~15m ≫ 7s budget).
    if (serverHintMs > remaining) return null;
    // Otherwise honor the server's reset window + a WIDENED jitter so many clients waiting
    // on the SAME reset don't all re-fire at once (anti-thundering-herd).
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
 * (watchdog-embed-resilience-and-dedup-2026-06-17 P-001.)
 *
 * One 429 is NOT transient: `insufficient_quota` (the OpenAI account is out of credit
 * / hit its billing cap) fails identically on every retry regardless of load, so it is
 * classified as a HARD stop (fail fast, distinct `openai_embed_quota_exhausted` tag, no
 * shared-bucket penalty) rather than a rate-limit. (mem0-embed-insufficient-quota-classification.) */
export function buildOpenAiEmbedder(apiKey: string, opts: OpenAiEmbedderOpts = {}): EmbedFn {
  const maxAttempts = opts.maxAttempts ?? EMBED_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? realSleep;
  const totalBudgetMs = opts.maxTotalWaitMs ?? EMBED_TOTAL_BUDGET_MS;
  return async (text: string): Promise<number[]> => {
    let lastErr: Error | null = null;
    let waitedMs = 0;
    const adm = embedAdmission();
    // Wall-clock deadline for the WHOLE embed (fetch time + backoff sleeps), so a stalled
    // fetch or a long retry chain can't overshoot the memory-tool deadline (B1, 10s) and
    // surface as `memory_timeout` (mem0-timeout-fix-2026-06-24). The per-attempt fetch is
    // additionally aborted at EMBED_FETCH_TIMEOUT_MS (or the remaining budget, whichever is
    // smaller) so one hung connection never eats the budget.
    const embedDeadlineAt = Date.now() + totalBudgetMs;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remainingBudgetMs = embedDeadlineAt - Date.now();
      if (remainingBudgetMs <= 0) break; // budget spent → surface the failure now
      let serverHintMs: number | null = null;
      // MEMORY lane of the shared embed-TPM admission governor
      // (watchdog-and-exposed-systems-improvement-2026-06-18 P-002). Production recall must
      // succeed, so this lane PASSES THROUGH on a denial (acquire never returns null here) — it
      // only PACES against the shared window + feeds it headers/429s so the high-volume bench
      // path yields to memory rather than starving it. The retry loop below is the 429 backstop.
      let slot;
      try {
        slot = await adm.acquire(text, 'memory');
      } catch (e) {
        // EI-7596: our OWN daily spend cap (embed-admission's EmbedBudgetExhaustedError) tripped.
        // This is a SUSTAINED-exhaustion shape identical in kind to insufficient_quota — it will
        // fail IDENTICALLY on every embed until the UTC day rolls over, no retry helps — but unlike
        // insufficient_quota the local (BGE-ONNX) embedder is fully able to serve the request (it
        // costs nothing against the OpenAI budget the cap protects). Before this fix, the cap threw
        // HERE, before the retry loop's own markOpenAiEmbedFailure() calls (hard-billing-stop /
        // retry-budget-exhausted, below) were ever reached, so the EI-3381 local-fallback cooldown
        // never engaged and EVERY memory:remember/update hard-failed for the rest of the day even
        // though a working local embedder was available (EI-7596: reported blocking memory writes
        // fleet-wide during a heavy-load day). Mark the cooldown now so the NEXT resolveEmbedder()
        // call (a fresh memory:remember/search) routes to local instead of re-hitting this same cap.
        if (e instanceof EmbedBudgetExhaustedError) markOpenAiEmbedFailure();
        throw e;
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
          // Abort a STALLED connection so it can't consume the whole embed budget; bound by
          // the remaining wall-clock budget so the abort never pushes past the deadline.
          signal: AbortSignal.timeout(Math.max(1, Math.min(EMBED_FETCH_TIMEOUT_MS, remainingBudgetMs))),
        });
        adm.recordResponse(headersToRecord(r.headers)); // learn the live limit / pause on remaining=0
        if (r.ok) {
          clearEmbedExhaustionAlertIfActive('openai_billing');
          const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
          return j.data[0].embedding;
        }
        const body = await r.text().catch(() => '');
        // INSUFFICIENT_QUOTA (mem0-embed-insufficient-quota-classification): OpenAI returns
        // HTTP 429 for TWO unrelated conditions — a transient `rate_limit_exceeded` (retry and
        // it clears) AND a hard `insufficient_quota` (the account is out of credit / hit its
        // billing cap). The latter is NOT load-related: it fails IDENTICALLY on every embed,
        // one request or a thousand, until billing is fixed — so lumping it in with rate-limits
        // (retry the budget, penalize the shared bucket, narrate "rate-limited, retrying") both
        // wastes the budget and MISDIAGNOSES the cause (this exact conflation sent a multi-hour
        // investigation down the throughput path when the real fix was "add OpenAI credit").
        // Treat it like a 401/403: fail FAST (one attempt), do NOT penalize the shared admission
        // bucket (there is no reset window to wait for), and tag it DISTINCTLY so the memory
        // tools narrate "OpenAI quota exhausted — check billing" instead of "rate-limited".
        if (r.status === 429 && /insufficient_quota/.test(body)) {
          // EI-3381 / WI-3615: a hard billing stop fails identically forever until fixed —
          // latch the STICKY local-preference (not just the 60s cooldown) so the NEXT
          // resolveEmbedder() call (a fresh memory:remember/search) doesn't keep re-trying a
          // key we just learned is dead, indefinitely, every 60s.
          markOpenAiEmbedFailure(Date.now(), { hard: true });
          maybeEscalateEmbedExhaustion('openai_billing');
          throw new Error(`openai_embed_quota_exhausted: ${body}`);
        }
        const err = new Error(`openai_embed_failed_${r.status}: ${body}`);
        // 429 (rate limit) + 5xx are transient → retry; other 4xx (401/400/403)
        // are a config/auth problem → fail fast (no point retrying a bad key).
        if (r.status !== 429 && r.status < 500) throw err;
        serverHintMs = retryDelayFromHeaders(r.headers);
        if (r.status === 429) adm.penalize({ retryAfterMs: serverHintMs ?? undefined }); // back the whole bucket off
        lastErr = err;
      } catch (e) {
        // A non-retryable failure propagates immediately: a 4xx that isn't 429 (bad/expired
        // key, malformed request — thrown above) OR a 429 that is actually a hard
        // `insufficient_quota` billing stop (openai_embed_quota_exhausted). A bare
        // network/fetch error is transient → retry until attempts/budget run out.
        if (
          e instanceof Error &&
          (/^openai_embed_failed_4(?!29)/.test(e.message) || /^openai_embed_quota_exhausted/.test(e.message))
        ) {
          throw e;
        }
        lastErr = e instanceof Error ? e : new Error(String(e));
      } finally {
        slot?.release();
      }
      if (attempt >= maxAttempts - 1) break; // out of attempts — surface the failure now
      let waitMs = nextEmbedBackoffMs(attempt, serverHintMs, waitedMs, opts);
      if (waitMs == null) break; // backoff budget spent / reset won't arrive in time
      // Clamp to the remaining WALL-CLOCK budget (fetch time already consumed counts) so the
      // sleep can't push the total embed past the memory-tool deadline.
      waitMs = Math.min(waitMs, embedDeadlineAt - Date.now());
      if (waitMs <= 0) break;
      waitedMs += waitMs;
      await sleep(waitMs);
    }
    // EI-3381: the retry budget is spent (attempts exhausted, or the server's reset window
    // is longer than we can wait — the exact sustained org-wide TPM-drain shape this ticket
    // reports) — a SUSTAINED exhaustion, not a short spike. Prefer local for a cooldown.
    markOpenAiEmbedFailure();
    // EI-7475: this is the OTHER sustained-exhaustion shape (retry budget exhausted rather
    // than a hard insufficient_quota) — escalate here too, not just on the hard-billing branch
    // above, so a fleet riding out a long reset window still tells the owner.
    maybeEscalateEmbedExhaustion('openai_billing');
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

/** Every embedder preference, in ONE place: the env parser, the return type,
 *  and tests all derive from this. A hand-copied subset drifts the moment a
 *  leg is added or a default flips (it did, when 'gemma' became the default). */
export const EMBEDDER_PREFERENCES = ['auto', 'openai', 'local', 'gemma', 'disabled'] as const;
export type EmbedderPreference = (typeof EMBEDDER_PREFERENCES)[number];

const isEmbedderPreference = (v: string | undefined): v is EmbedderPreference =>
  !!v && (EMBEDDER_PREFERENCES as readonly string[]).includes(v);

/** Read the live embedder preference (env override → persisted voice pref →
 *  'auto'). Exported as a seam for the `resolveEmbedder` cascade tests (GAP 4). */
export async function readEmbedderPreference(): Promise<EmbedderPreference> {
  // Env override first (memory-backend-improve-and-hybrid P-004b): lets the
  // bench force one leg (e.g. PAPERCUSP_MEMORY_EMBEDDER=local to measure the
  // BGE-ONNX leg, or =gemma for EmbeddingGemma) without flipping the live
  // operator preference in PG.
  if (isEmbedderPreference(process.env.PAPERCUSP_MEMORY_EMBEDDER)) {
    return process.env.PAPERCUSP_MEMORY_EMBEDDER;
  }
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
async function buildEmbedderForMode(mode: 'openai' | 'local' | 'gemma'): Promise<EmbedFn> {
  if (mode === 'openai') {
    const key = await resolveOpenAiKey();
    if (!key) throw new Error('openai_api_key not configured');
    return buildOpenAiEmbedder(key);
  }
  if (mode === 'gemma') {
    // EmbeddingGemma-300m @ MRL-384. Storage / the re-embed pass use the
    // document prompt (search's query embedder uses the query prompt).
    return buildGemmaEmbedder({ kind: 'document' });
  }
  // local — BGE-small, worker-thread isolated, inline fallback.
  return buildLocalEmbedder();
}

/**
 * Injectable seams for the embedder cascade — the pure core
 * (`resolveEmbedderWith`) takes these so the four-way cascade can be
 * table-tested without real network/credential/package I/O (GAP 4). The
 * production `resolveEmbedder` wires the real implementations.
 */
export interface ResolveEmbedderDeps {
  readPreference: () => Promise<'auto' | 'openai' | 'local' | 'gemma' | 'disabled'>;
  resolveKey: () => Promise<string>;
  localInstalled: () => Promise<boolean>;
  buildOpenAi: (key: string) => EmbedFn;
  buildLocal: () => Promise<EmbedFn>;
  /** EmbeddingGemma-300m @ MRL-384 (the default local embedder). Gated by the
   *  same `localInstalled` (shares the @huggingface/transformers package). */
  buildGemma: () => Promise<EmbedFn>;
  /** EI-3381: is OpenAI embedding in its post-failure cooldown (a recent hard quota/billing
   *  stop, or a fully-exhausted retry budget)? Only consulted by the 'auto' cascade — a
   *  user-FORCED 'openai' preference still tries the key regardless (that's an explicit
   *  override, not a "pick the best available" decision). Sync + cheap (in-memory only), so
   *  it's checked on every 'auto' resolution with no extra I/O. */
  isOpenAiRecentlyExhausted: () => boolean;
}

/**
 * Pure cascade core. 'disabled' is a hard stop; 'openai'/'local' are forced
 * (fall to disabled with a specific reason if their dependency is missing);
 * 'auto' cascades openai → local → disabled, EXCEPT while OpenAI is in its
 * post-failure cooldown (EI-3381), when it cascades local → openai → disabled
 * instead — a sustained single-key exhaustion (org-wide TPM drain from another
 * process, or a billing stop) no longer hard-fails memory:* when a local
 * embedder is installed; it degrades to local until the cooldown lapses.
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

  if (preference === 'gemma') {
    // EmbeddingGemma uses the same @huggingface/transformers package as BGE, so
    // localInstalled() gates it. Its OWN space (dims 384, mode 'gemma' →
    // memory_vec_gemma) so its vectors never mix with BGE ('local') or OpenAI.
    if (await deps.localInstalled()) {
      return { mode: 'gemma', dims: EMBEDDER_DIM, embed: await deps.buildGemma() };
    }
    return { mode: 'disabled', reason: 'gemma_forced_but_transformers_not_installed' };
  }

  // 'auto': prefer local while OpenAI is in its post-failure cooldown (EI-3381) — a sustained
  // single-key exhaustion must not keep re-trying a key we just learned is unusable when a
  // local embedder can serve the request instead.
  if (deps.isOpenAiRecentlyExhausted() && (await deps.localInstalled())) {
    return { mode: 'local', dims: EMBEDDER_DIM, embed: await deps.buildLocal() };
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
 * hard stop; 'auto' cascades openai → local → disabled (or local → openai
 * while OpenAI is in its EI-3381 post-failure cooldown). Thin production
 * wrapper over `resolveEmbedderWith` with the real seams.
 */
async function resolveEmbedder(): Promise<ResolvedEmbedder> {
  return resolveEmbedderWith({
    readPreference: readEmbedderPreference,
    resolveKey: resolveOpenAiKey,
    localInstalled: localAvailable,
    buildOpenAi: buildOpenAiEmbedder,
    buildLocal: buildLocalEmbedder,
    // Storage/mem0 embed with the document prompt (search uses the query prompt).
    buildGemma: async () => buildGemmaEmbedder({ kind: 'document' }),
    isOpenAiRecentlyExhausted: isOpenAiEmbedInCooldown,
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
