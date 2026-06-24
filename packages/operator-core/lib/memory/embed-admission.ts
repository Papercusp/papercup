/**
 * Shared embed-TPM admission lane.
 *
 * watchdog-and-exposed-systems-improvement-2026-06-18 P-002 (D-007/D-008);
 * watchdog-embed-resilience-and-dedup-2026-06-17 D-003.
 *
 * ── ROOT CAUSE this cures ────────────────────────────────────────────────────────────────
 * The high-volume `search:semantic` / `work_items:search` embed path
 * (`agent-tools/search/embedder.ts`) fired UNGOVERNED OpenAI `text-embedding-3-small`
 * calls. Under the xbench benchmark fleet this burned the shared org 1M-TPM ceiling, 429ing
 * EVERY embed FLEET-WIDE — which hard-failed all `memory:*` too (`memory/configure.ts` uses
 * the SAME org quota). The P-001 header-aware retry only RIDES OUT a 429; it does not stop the
 * workload from exhausting the org in the first place.
 *
 * ── THE CURE (no-money, code-only) ──────────────────────────────────────────────────────────
 * The owner approach-choice (governor vs a separate paid OpenAI key) is resolved here to the
 * GOVERNOR — no money, reversible. ONE process-wide `RateLimitGovernor` (the domain-free
 * resilience primitive — reuse-first, not a new parallel system) that BOTH embed paths acquire
 * from before each call:
 *   - its `itpm` budget caps AGGREGATE embed token-rate UNDER the org ceiling (so prod memory
 *     always has guaranteed headroom), and
 *   - its `maxConcurrent` cap bounds the burst (the governor's own docs: "capping how many run
 *     at once is the real burst fix").
 * Two LANES give priority WITHOUT starvation, via asymmetric wait budgets:
 *   - `'bench'`  (search:semantic / work_items:search — the CAUSE): a SHORT wait, then SHED →
 *     the caller throws and the search engine degrades to BM25 (`libs/generic/search/hybrid.ts`
 *     already try/catches the embedder → BM25, so a shed is graceful). High-volume work yields
 *     FIRST so it can never exhaust the org.
 *   - `'memory'` (memory:remember / recall — must succeed, low volume): a longer wait, and on
 *     denial it PROCEEDS anyway (passthrough) so production recall never hard-fails on
 *     admission; the existing P-001 header-aware retry is its 429 backstop.
 * A 429 from either path feeds `penalize()` → the shared bucket pauses → bench sheds, memory
 * rides it out.
 *
 * Flag-gated (`FLAGS.EMBED_ADMISSION`, default ON) — OFF ⇒ a byte-identical passthrough.
 */

import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

export type EmbedLane = 'memory' | 'bench';

// text-embedding-3-small org ceiling is 1,000,000 TPM. Govern AGGREGATE embed token-rate under
// it so the high-volume bench path can't exhaust the org and starve production memory. All knobs
// are env-tunable (launch/test config only — NOT a feature gate; the gate is the FLAG below).
const EMBED_ITPM_FLOOR = Number(process.env.PAPERCUSP_EMBED_ITPM) || 600_000;
const EMBED_MAX_CONCURRENT = Number(process.env.PAPERCUSP_EMBED_MAX_CONCURRENT) || 32;

/** Per-lane admission wait budget. memory > bench so under contention MEMORY wins the shared
 *  slot (it waits longer) while BENCH sheds fast → BM25. */
export const LANE_WAIT_MS: Record<EmbedLane, number> = {
  memory: Number(process.env.PAPERCUSP_EMBED_WAIT_MEMORY_MS) || 5_000,
  bench: Number(process.env.PAPERCUSP_EMBED_WAIT_BENCH_MS) || 2_500,
};

const FLAG_TTL_MS = 30_000;

/** ~4 chars/token for text-embedding-3-small — the `itpm` charge for one embed of `text`. */
export function estimateEmbedTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface EmbedSlot {
  /** Release the governed slot (idempotent). Always call in a `finally`. */
  release(): void;
}

const PASSTHROUGH: EmbedSlot = { release() {} };

/** Thrown by the BENCH embed fn when admission sheds — the search engine catches it → BM25. */
export class EmbedShedError extends Error {
  readonly lane: EmbedLane;
  constructor(lane: EmbedLane) {
    super(`embed_admission_shed:${lane}`);
    this.name = 'EmbedShedError';
    this.lane = lane;
  }
}

/** A fetch `Headers` → the plain record `recordResponse` wants (governor lowercases keys).
 *  Null-safe: a response with no/odd headers (mocked fetch, edge transports) yields `{}` rather
 *  than throwing on the embed hot path. */
export function headersToRecord(h: Headers | null | undefined): Record<string, string | undefined> {
  const o: Record<string, string | undefined> = {};
  if (h && typeof h.forEach === 'function') {
    h.forEach((v, k) => {
      o[k] = v;
    });
  }
  return o;
}

/** OpenAI `retry-after` (seconds or HTTP-date) → ms, or undefined. */
export function retryAfterMs(headers: Record<string, string | undefined>): number | undefined {
  const ra = headers['retry-after'] ?? headers['Retry-After'];
  if (!ra) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const dateMs = Date.parse(ra);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

export interface EmbedAdmissionDeps {
  governor: RateLimitGovernor;
  /** Resolve the flag (cached by the production singleton). */
  isEnabled: () => Promise<boolean>;
  /** Override per-lane wait budgets (tests). */
  laneWaitMs?: Record<EmbedLane, number>;
}

export interface EmbedAdmission {
  /** Acquire a governed slot for one embed of `text` on `lane`. Returns a release handle, or
   *  `null` ONLY for the bench lane when admission was denied within its wait budget (the caller
   *  then sheds → BM25). The memory lane never returns null (it passes through on denial). */
  acquire(text: string, lane: EmbedLane): Promise<EmbedSlot | null>;
  /** Feed an embed response's headers to the governor (learns the live limit; on remaining=0
   *  pauses to reset). Call on EVERY response (ok or 429). */
  recordResponse(headers: Record<string, string | undefined>): void;
  /** A 429: pause the shared bucket so every embed caller backs off. */
  penalize(opts: { retryAfterMs?: number; resetAt?: number }): void;
  readonly governor: RateLimitGovernor;
}

/**
 * Factory with an injected governor + flag so the lane/shed logic is unit-testable without real
 * network/credentials/flags. Production wires the process singleton via `embedAdmission()`.
 */
export function createEmbedAdmission(deps: EmbedAdmissionDeps): EmbedAdmission {
  const waits = deps.laneWaitMs ?? LANE_WAIT_MS;
  return {
    governor: deps.governor,
    async acquire(text: string, lane: EmbedLane): Promise<EmbedSlot | null> {
      // Flag off → byte-identical passthrough (no governing, never blocks/sheds).
      if (!(await deps.isEnabled())) return PASSTHROUGH;
      const release = await deps.governor.acquire(
        { inTok: estimateEmbedTokens(text) },
        { maxWaitMs: waits[lane] },
      );
      if (release) return { release };
      // Denied within the lane budget: bench SHEDS (caller → BM25); memory PROCEEDS (passthrough,
      // its P-001 retry is the 429 backstop) so production recall never hard-fails on admission.
      return lane === 'bench' ? null : PASSTHROUGH;
    },
    recordResponse(headers: Record<string, string | undefined>): void {
      deps.governor.recordResponse(headers);
    },
    penalize(opts: { retryAfterMs?: number; resetAt?: number }): void {
      deps.governor.penalize({ rateLimited: true, ...opts });
    },
  };
}

let _singleton: EmbedAdmission | null = null;
let _flagCache: { value: boolean; at: number } | null = null;

/** Cached flag read — the hot path can't afford a PG/cache round-trip per embed. Defaults ON
 *  (and on a read failure) so embeds are never blocked by a flag-store hiccup. */
async function embedAdmissionEnabled(): Promise<boolean> {
  const now = Date.now();
  if (_flagCache && now - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  let value = true;
  try {
    value = await getFlag(FLAGS.EMBED_ADMISSION, 'embed-admission');
  } catch {
    value = true; // default ON; never block embeds on a flag-read failure
  }
  _flagCache = { value, at: now };
  return value;
}

/** The process-wide embed admission lane (lazy singleton). BOTH embed paths share this so the
 *  governed budget spans search + memory in one window. */
export function embedAdmission(): EmbedAdmission {
  if (!_singleton) {
    const governor = new RateLimitGovernor({
      maxConcurrent: EMBED_MAX_CONCURRENT,
      itpm: EMBED_ITPM_FLOOR,
    });
    _singleton = createEmbedAdmission({ governor, isEnabled: embedAdmissionEnabled });
  }
  return _singleton;
}

/** Test seam: drop the singleton + flag cache so each test starts clean. */
export function __resetEmbedAdmissionForTest(): void {
  _singleton = null;
  _flagCache = null;
}
