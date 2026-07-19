/**
 * cache-policy.ts — provider-agnostic PROMPT-CACHE request-body rewrites
 * (gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-001/P-003/P-005/P-008).
 *
 * WHY: prompt-cache entries are ORG-scoped, MODEL-scoped and EXACT-PREFIX-BYTE-scoped on both
 * providers, so every fleet session launched with the same tool-list variant COULD share one
 * boot-prefix cache entry instead of each paying its own ~60-70k write. Measured 2026-07-19
 * (97 sessions/48h): fleet read:write ratio 16.6:1, ~24% of write tokens still on the 5-minute
 * tier (an overage/billing-mode fallback the CLI exposes no knob for). The one place we can act
 * is the REQUEST BODY as it leaves this machine — hence these rewrites, applied by BOTH
 * forward points (the inference gateway for pool-routed sessions, and the transparent
 * cache-proxy for default-account sessions, which are the largest single sharing cohort).
 *
 * INVARIANTS (why this is safe to run on every request):
 *  - PURE + IN-PLACE on an already-parsed body; never touches responses.
 *  - IDEMPOTENT: re-running on an already-rewritten body is a no-op (an existing ttl/key/
 *    breakpoint is respected, never doubled).
 *  - NEVER EXCEEDS the provider's breakpoint budget (Anthropic hard-caps at 4 cache_control
 *    markers per request; a 5th is a 400). We count first and skip injection when full.
 *  - CLIENT INTENT WINS: an explicit client-set ttl / prompt_cache_key / breakpoint is left
 *    alone. We only fill in what the client omitted.
 *  - Kill-switched by the callers via env, so a bad interaction is one restart from reverted.
 */

/** Anthropic hard limit — a 5th `cache_control` marker in one request is a 400. */
export const ANTHROPIC_MAX_BREAKPOINTS = 4;

/** The extended cache tier [owner:Avi 2026-07-19 "just enable 1h everywhere"]. Accepted values
 *  are '5m' (default when absent) and '1h'. 1h writes cost 2× base input vs 1.25× for 5m, and
 *  read at the same ~0.1×, so the tier pays for itself after ~3 reads — the fleet's measured
 *  median session takes 63 requests. */
export const ANTHROPIC_EXTENDED_TTL = '1h';

export interface AnthropicCacheStats {
  /** The body object was mutated (caller must re-serialize). */
  changed: boolean;
  /** How many existing cache_control markers were upgraded to the extended ttl. */
  ttlUpgraded: number;
  /** cache_control markers present BEFORE our injection (the budget denominator). */
  breakpointsBefore: number;
  /** We added the shared tools-span breakpoint (P-003). */
  toolsBreakpointInjected: boolean;
  /** We wanted the tools breakpoint but the client already used all 4 slots. */
  toolsBreakpointSkippedNoBudget: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every object in an Anthropic request body that may legally carry a `cache_control` marker,
 *  in RENDER ORDER (tools → system → messages) — the order that defines prefix nesting. */
function cacheableBlocks(body: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (isRecord(v)) out.push(v);
  };
  if (Array.isArray(body.tools)) body.tools.forEach(push);
  if (Array.isArray(body.system)) body.system.forEach(push);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!isRecord(m)) continue;
      if (Array.isArray(m.content)) m.content.forEach(push);
    }
  }
  return out;
}

/** An ephemeral cache_control marker, if this block carries one. */
function ephemeralMarker(block: Record<string, unknown>): Record<string, unknown> | null {
  const cc = block.cache_control;
  if (!isRecord(cc)) return null;
  if (cc.type !== 'ephemeral') return null; // an unknown/other type is not ours to touch
  return cc;
}

/**
 * Apply the fleet prompt-cache policy to a parsed Anthropic `/v1/messages` body, IN PLACE.
 *
 * 1. TTL (P-001): every ephemeral `cache_control` without an explicit `ttl` gets the extended
 *    tier. A client-set ttl (either value) is left alone — client intent wins.
 * 2. Shared tools breakpoint (P-003): the `tools` array renders at prefix position 0 and is
 *    byte-identical across every session on the same tool-list variant + model, so a breakpoint
 *    at its END creates a cache entry that EVERY same-variant session in the org reads instead
 *    of writing. Without it the earliest breakpoint typically sits after the system prompt,
 *    whose per-session bytes fork the entry per session. Injected only when the client left
 *    the last tool unmarked AND the 4-marker budget has room.
 */
export function applyAnthropicCachePolicy(
  body: Record<string, unknown>,
  opts: { ttl?: string; injectToolsBreakpoint?: boolean } = {},
): AnthropicCacheStats {
  const ttl = opts.ttl ?? ANTHROPIC_EXTENDED_TTL;
  const stats: AnthropicCacheStats = {
    changed: false,
    ttlUpgraded: 0,
    breakpointsBefore: 0,
    toolsBreakpointInjected: false,
    toolsBreakpointSkippedNoBudget: false,
  };

  const blocks = cacheableBlocks(body);
  for (const b of blocks) {
    const cc = ephemeralMarker(b);
    if (!cc) continue;
    stats.breakpointsBefore++;
    if (typeof cc.ttl === 'string' && cc.ttl.length > 0) continue; // explicit client intent
    cc.ttl = ttl;
    stats.ttlUpgraded++;
    stats.changed = true;
  }

  // Top-level automatic caching (`cache_control` on the request itself) occupies a slot too:
  // the API auto-places it on the last cacheable block. Count it, and upgrade its ttl.
  const topLevel = isRecord(body.cache_control) && body.cache_control.type === 'ephemeral' ? body.cache_control : null;
  if (topLevel) {
    stats.breakpointsBefore++;
    if (!(typeof topLevel.ttl === 'string' && topLevel.ttl.length > 0)) {
      topLevel.ttl = ttl;
      stats.ttlUpgraded++;
      stats.changed = true;
    }
  }

  if (opts.injectToolsBreakpoint !== false) {
    const tools = body.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      const last = tools[tools.length - 1];
      if (isRecord(last) && !isRecord(last.cache_control)) {
        if (stats.breakpointsBefore < ANTHROPIC_MAX_BREAKPOINTS) {
          last.cache_control = { type: 'ephemeral', ttl };
          stats.toolsBreakpointInjected = true;
          stats.changed = true;
        } else {
          // At budget: a 5th marker is a 400. Skipping costs us the shared span, never the request.
          stats.toolsBreakpointSkippedNoBudget = true;
        }
      }
    }
  }

  return stats;
}

/** Buffer-level wrapper: parse → policy → re-serialize. Returns the ORIGINAL buffer untouched
 *  when the body is not JSON, is not an object, or the policy changed nothing (so a no-op
 *  request forwards byte-identically). Never throws. */
export function rewriteAnthropicCacheBody(
  bodyBuf: Buffer,
  opts: { ttl?: string; injectToolsBreakpoint?: boolean } = {},
): { body: Buffer; stats: AnthropicCacheStats | null } {
  if (!bodyBuf.length) return { body: bodyBuf, stats: null };
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
    if (!isRecord(parsed)) return { body: bodyBuf, stats: null };
    const stats = applyAnthropicCachePolicy(parsed, opts);
    if (!stats.changed) return { body: bodyBuf, stats };
    return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), stats };
  } catch {
    return { body: bodyBuf, stats: null };
  }
}

// ── OpenAI / codex ───────────────────────────────────────────────────────────

/**
 * OpenAI splits prompt-cache control by model GENERATION (developers.openai.com prompt-caching
 * guide, read 2026-07-19):
 *  - 'modern' (gpt-5.6+): retention is `prompt_cache_options.ttl` (only '30m' is accepted), cache
 *    WRITES cost 1.25× (no longer free), and explicit `prompt_cache_breakpoint` markers exist.
 *  - 'legacy' (gpt-5.5 and earlier, incl. gpt-5.x, gpt-4.1, gpt-4o): retention is
 *    `prompt_cache_retention: '24h'` and writes are FREE — so retention there is pure upside.
 * Sending the wrong family's parameter is a request error, hence this discriminator.
 */
export type OpenAiCacheGeneration = 'modern' | 'legacy';

/** Parse the `gpt-<major>[.<minor>]` version out of a model id (tolerating suffixes like
 *  `-codex`, `-mini`, dated snapshots). Unrecognized ids are treated as 'legacy' — the
 *  conservative choice, since legacy params are the wider-supported pair. */
export function openAiCacheGeneration(model: unknown): OpenAiCacheGeneration {
  if (typeof model !== 'string') return 'legacy';
  const m = /gpt-(\d+)(?:\.(\d+))?/i.exec(model);
  if (!m) return 'legacy';
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  if (!Number.isFinite(major)) return 'legacy';
  if (major > 5) return 'modern';
  if (major === 5 && minor >= 6) return 'modern';
  return 'legacy';
}

export interface OpenAiCacheStats {
  changed: boolean;
  generation: OpenAiCacheGeneration;
  /** legacy: prompt_cache_retention was set by us. */
  retentionSet: boolean;
  /** modern: prompt_cache_options.ttl was set by us. */
  ttlSet: boolean;
  /** prompt_cache_key was set by us (routing affinity). */
  cacheKeySet: boolean;
}

/**
 * Apply the fleet prompt-cache policy to a parsed OpenAI request body, IN PLACE.
 *
 * `cacheKey` (P-008) steers prefix-hash ROUTING: OpenAI hashes ~the first 256 tokens to pick a
 * cache shard, and `prompt_cache_key` is combined with that hash — so same-variant sessions
 * sharing a key land on the same shard and share entries. ⚠ The guide caps a single key at
 * ~15 requests/minute before it starts missing, so callers pass a key that already includes a
 * shard bucket (see `shardedCacheKey`).
 */
export function applyOpenAiCachePolicy(
  body: Record<string, unknown>,
  opts: { cacheKey?: string } = {},
): OpenAiCacheStats {
  const generation = openAiCacheGeneration(body.model);
  const stats: OpenAiCacheStats = { changed: false, generation, retentionSet: false, ttlSet: false, cacheKeySet: false };

  if (generation === 'legacy') {
    // Writes are free on this family — extended retention is strictly beneficial.
    if (body.prompt_cache_retention === undefined) {
      body.prompt_cache_retention = '24h';
      stats.retentionSet = true;
      stats.changed = true;
    }
  } else {
    // '30m' is the only accepted value today; writes cost 1.25× here, so this is a real
    // (small) tradeoff rather than free — kept because a 30m floor still beats the 5–10min
    // in-memory eviction a busy shard otherwise gives us.
    const existing = body.prompt_cache_options;
    if (existing === undefined) {
      body.prompt_cache_options = { ttl: '30m' };
      stats.ttlSet = true;
      stats.changed = true;
    } else if (isRecord(existing) && existing.ttl === undefined) {
      existing.ttl = '30m';
      stats.ttlSet = true;
      stats.changed = true;
    }
  }

  if (opts.cacheKey && body.prompt_cache_key === undefined) {
    body.prompt_cache_key = opts.cacheKey;
    stats.cacheKeySet = true;
    stats.changed = true;
  }

  return stats;
}

/**
 * Build a sharded `prompt_cache_key`: `<variant>-<bucket>`. Sharing is maximized by ONE key per
 * variant, but OpenAI degrades a key past ~15 req/min — so we spread across `shards` buckets,
 * chosen by a STABLE hash of `sessionId` (a session keeps its bucket for life, so its own
 * conversation prefix keeps hitting). Fewer shards = more sharing; more shards = more headroom.
 */
export function shardedCacheKey(variant: string, sessionId: string, shards: number): string {
  const n = Number.isFinite(shards) && shards > 0 ? Math.floor(shards) : 1;
  if (n === 1) return `${variant}-0`;
  let h = 2166136261; // FNV-1a — stable across processes (Math.random/hashCode would not be)
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${variant}-${Math.abs(h) % n}`;
}

/** Buffer-level wrapper for the OpenAI path. Same no-op-safety contract as the Anthropic one. */
export function rewriteOpenAiCacheBody(
  bodyBuf: Buffer,
  opts: { cacheKey?: string } = {},
): { body: Buffer; stats: OpenAiCacheStats | null } {
  if (!bodyBuf.length) return { body: bodyBuf, stats: null };
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown;
    if (!isRecord(parsed)) return { body: bodyBuf, stats: null };
    const stats = applyOpenAiCachePolicy(parsed, opts);
    if (!stats.changed) return { body: bodyBuf, stats };
    return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), stats };
  } catch {
    return { body: bodyBuf, stats: null };
  }
}
