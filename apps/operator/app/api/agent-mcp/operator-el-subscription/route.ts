/**
 * GET /api/agent-mcp/operator-el-subscription
 *
 * Returns the workspace's ElevenLabs plan-level state — characters
 * used vs. characters allowed, tier, next reset, account status.
 *
 * Why a separate endpoint from /operator-el-spend:
 *   - /operator-el-spend tracks our self-imposed monthly-minute cap
 *     (`fullAgentMonthlyMinuteCap`) by summing Conv-AI conversations.
 *   - This endpoint tracks ElevenLabs' OWN plan limits (character
 *     budget, concurrent-session ceiling) — the limits that surface
 *     as "exceeds your quota limit" 1011/1002 errors when the SDK
 *     can't connect at all.
 *
 * Both matter; they're orthogonal. Voice-mode + settings show both so
 * the user can tell whether they're hitting OUR cap (auto-disconnect)
 * or EL's plan limit (genuine "service refused").
 *
 * Response:
 *   {
 *     tier:                    string | null,   // 'free' | 'creator' | 'pro' | ...
 *     status:                  string | null,   // 'active' | 'past_due' | 'canceled' | ...
 *     character_count:         number,          // characters used this period
 *     character_limit:         number | null,   // characters allowed this period (null = unlimited)
 *     character_limit_exceeded:boolean,         // EL's own flag
 *     pct_used:                number | null,   // 0..1
 *     next_reset_unix:         number | null,   // when the budget resets
 *     next_reset_iso:          string | null,
 *     concurrent_session_limit:number | null,   // null if EL doesn't expose it
 *     currency:                string | null,
 *     billing_period:          string | null,
 *     can_extend:              boolean | null,
 *     source:                  'elevenlabs' | 'no-key' | 'error',
 *     error_detail:            string | null,
 *   }
 *
 * Cache: 60s in-memory, single key (the EL account is global, not
 * per-agent). Voice-mode hits this pre-connect; without caching, every
 * tap of the voice FAB would burst EL.
 */

import { readElevenLabsKey } from '@/lib/voice-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SubCacheEntry {
  body: Record<string, unknown>;
  fetchedAt: number;
}
const SUB_CACHE_TTL_MS = 60_000;
let subCache: SubCacheEntry | null = null;

interface ElSubscriptionRaw {
  tier?: string;
  status?: string;
  character_count?: number;
  characterCount?: number;
  character_limit?: number;
  characterLimit?: number;
  character_limit_exceeded?: boolean;
  characterLimitExceeded?: boolean;
  next_character_count_reset_unix?: number;
  nextCharacterCountResetUnix?: number;
  currency?: string;
  billing_period?: string;
  billingPeriod?: string;
  can_extend_character_limit?: boolean;
  canExtendCharacterLimit?: boolean;
  has_open_invoices?: boolean;
  max_concurrent_calls?: number;
  maxConcurrentCalls?: number;
  max_voice_add_edits?: number;
}

function pickNum(...vals: (number | undefined)[]): number | null {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
function pickBool(...vals: (boolean | undefined)[]): boolean | null {
  for (const v of vals) if (typeof v === 'boolean') return v;
  return null;
}
function pickStr(...vals: (string | undefined)[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  if (subCache && now - subCache.fetchedAt < SUB_CACHE_TTL_MS) {
    return Response.json(subCache.body);
  }

  const apiKey = await readElevenLabsKey();
  if (!apiKey) {
    const body = {
      tier: null,
      status: null,
      character_count: 0,
      character_limit: null,
      character_limit_exceeded: false,
      pct_used: null,
      next_reset_unix: null,
      next_reset_iso: null,
      concurrent_session_limit: null,
      currency: null,
      billing_period: null,
      can_extend: null,
      source: 'no-key' as const,
      error_detail: null,
    };
    return Response.json(body);
  }

  let raw: ElSubscriptionRaw;
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const body = {
        tier: null,
        status: null,
        character_count: 0,
        character_limit: null,
        character_limit_exceeded: false,
        pct_used: null,
        next_reset_unix: null,
        next_reset_iso: null,
        concurrent_session_limit: null,
        currency: null,
        billing_period: null,
        can_extend: null,
        source: 'error' as const,
        error_detail: `el ${res.status}: ${detail}`,
      };
      return Response.json(body);
    }
    raw = (await res.json()) as ElSubscriptionRaw;
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    const body = {
      tier: null,
      status: null,
      character_count: 0,
      character_limit: null,
      character_limit_exceeded: false,
      pct_used: null,
      next_reset_unix: null,
      next_reset_iso: null,
      concurrent_session_limit: null,
      currency: null,
      billing_period: null,
      can_extend: null,
      source: 'error' as const,
      error_detail: msg.slice(0, 300),
    };
    return Response.json(body);
  }

  const charCount = pickNum(raw.character_count, raw.characterCount) ?? 0;
  const charLimit = pickNum(raw.character_limit, raw.characterLimit);
  const exceeded = pickBool(raw.character_limit_exceeded, raw.characterLimitExceeded) ?? false;
  const resetUnix = pickNum(raw.next_character_count_reset_unix, raw.nextCharacterCountResetUnix);
  const concurrent = pickNum(raw.max_concurrent_calls, raw.maxConcurrentCalls);
  const pctUsed = charLimit !== null && charLimit > 0
    ? Math.min(1, charCount / charLimit)
    : null;

  const body = {
    tier: pickStr(raw.tier),
    status: pickStr(raw.status),
    character_count: charCount,
    character_limit: charLimit,
    character_limit_exceeded: exceeded,
    pct_used: pctUsed,
    next_reset_unix: resetUnix,
    next_reset_iso: resetUnix !== null ? new Date(resetUnix * 1000).toISOString() : null,
    concurrent_session_limit: concurrent,
    currency: pickStr(raw.currency),
    billing_period: pickStr(raw.billing_period, raw.billingPeriod),
    can_extend: pickBool(raw.can_extend_character_limit, raw.canExtendCharacterLimit),
    source: 'elevenlabs' as const,
    error_detail: null,
  };

  subCache = { body, fetchedAt: now };
  return Response.json(body);
}
