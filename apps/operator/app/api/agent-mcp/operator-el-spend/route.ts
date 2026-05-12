/**
 * GET /api/agent-mcp/operator-el-spend
 *
 * Returns the current month's ElevenLabs Conv AI usage and the
 * configured cap. Used by voice-mode at session-start to refuse to
 * connect when the cap is hit. Used by the settings UI to show
 * progress.
 *
 * Response shape (unchanged for backward compat — settings UI +
 * voice-mode pre-connect check both read it):
 *
 *   {
 *     minutes_used: number,
 *     minutes_cap:  number | null,
 *     ym:           string,        // 'YYYY-MM' (local time)
 *     over_cap:     boolean,
 *     pct_used:     number | null, // 0..1
 *     source:       'elevenlabs' | 'pg-fallback' | 'no-agent',
 *   }
 *
 * Source of truth: ElevenLabs `/v1/convai/conversations` filtered by
 * the workspace's configured `elevenLabsAgentId` + a Unix-seconds time
 * range covering the start of the current local-time month. We walk
 * the cursor and sum `call_duration_seconds`. EL is canonical — it
 * counts conversations regardless of which surface (desktop tab,
 * phone, /el-min diag page) initiated them and is unaffected by our
 * post-call webhook drops or field-shape changes.
 *
 * Fallback: if EL API is unreachable (network error / 5xx / missing
 * key), we sum from `harness_shared.el_conv_calls` (PG) and return
 * `source: 'pg-fallback'`. The PG table is still populated by the
 * post-call webhook so we have something to fall back on.
 *
 * Cache: 60 seconds per agentId in-memory. Voice-mode hits this
 * endpoint on every session-start; without caching, rapid tap of the
 * voice FAB would burst EL. Usage changes slowly enough that 60s of
 * staleness is irrelevant.
 *
 * Month boundary: LOCAL time (server's clock). For self-hosted
 * papercup the server and the user are usually the same machine.
 */

import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { loadVoicePrefs } from '@/lib/voice-prefs';
import { readElevenLabsKey } from '@/lib/voice-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SpendCacheEntry {
  secsUsed: number;
  source: 'elevenlabs' | 'pg-fallback';
  fetchedAt: number;
}
const SPEND_CACHE_TTL_MS = 60_000;
const spendCache = new Map<string, SpendCacheEntry>();

interface ElConversation {
  call_duration_seconds?: number;
  callDurationSeconds?: number;
  start_time_unix_secs?: number;
}
interface ElConversationsPage {
  conversations: ElConversation[];
  has_more?: boolean;
  hasMore?: boolean;
  next_cursor?: string | null;
  nextCursor?: string | null;
}

function localYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function localMonthStartUnixSecs(): number {
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  return Math.floor(monthStart.getTime() / 1000);
}

async function fetchElSpendSecs(
  agentId: string,
  apiKey: string,
  monthStartUnix: number,
): Promise<number> {
  let cursor: string | undefined;
  let totalSecs = 0;
  let pageCount = 0;
  while (true) {
    const u = new URL('https://api.elevenlabs.io/v1/convai/conversations');
    u.searchParams.set('agent_id', agentId);
    u.searchParams.set('call_start_after_unix', String(monthStartUnix));
    u.searchParams.set('page_size', '100');
    u.searchParams.set('summary_mode', 'exclude');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u.toString(), {
      headers: { 'xi-api-key': apiKey, 'accept': 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      throw new Error(`el-list ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = (await res.json()) as ElConversationsPage;
    const convs = Array.isArray(data.conversations) ? data.conversations : [];
    for (const c of convs) {
      const d = c.call_duration_seconds ?? c.callDurationSeconds ?? 0;
      if (typeof d === 'number' && Number.isFinite(d) && d > 0) totalSecs += d;
    }
    const hasMore = (data.has_more ?? data.hasMore) === true;
    const next = data.next_cursor ?? data.nextCursor ?? null;
    pageCount += 1;
    if (!hasMore || !next || pageCount >= 20) break;
    cursor = next;
  }
  return totalSecs;
}

async function fetchPgFallbackSecs(workspace: string, ym: string): Promise<number> {
  try {
    return await withWorkspace(workspace, async (tx) => {
      const rows = await tx`
        SELECT COALESCE(SUM(duration_secs), 0)::int AS total
        FROM harness_shared.el_conv_calls
        WHERE ym = ${ym}
      `;
      return Number(rows[0]?.total ?? 0);
    });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (/relation .*el_conv_calls.* does not exist/i.test(msg)) return 0;
    throw e;
  }
}

export async function GET(): Promise<Response> {
  const ym = localYm();
  const workspace = activeWorkspaceId();
  const prefs = await loadVoicePrefs();
  const agentId = prefs.elevenLabsAgentId;
  const minutesCap = prefs.fullAgentMonthlyMinuteCap > 0 ? prefs.fullAgentMonthlyMinuteCap : null;

  if (!agentId) {
    return Response.json({
      minutes_used: 0,
      minutes_cap: minutesCap,
      ym,
      over_cap: false,
      pct_used: minutesCap != null ? 0 : null,
      source: 'no-agent',
    });
  }

  const now = Date.now();
  const cached = spendCache.get(agentId);
  let secsUsed: number;
  let source: 'elevenlabs' | 'pg-fallback';

  if (cached && now - cached.fetchedAt < SPEND_CACHE_TTL_MS) {
    secsUsed = cached.secsUsed;
    source = cached.source;
  } else {
    const apiKey = await readElevenLabsKey();
    if (!apiKey) {
      secsUsed = await fetchPgFallbackSecs(workspace, ym);
      source = 'pg-fallback';
      console.warn('[el-spend] no EL API key configured; using PG fallback');
    } else {
      try {
        secsUsed = await fetchElSpendSecs(agentId, apiKey, localMonthStartUnixSecs());
        source = 'elevenlabs';
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? String(e);
        console.warn('[el-spend] EL API failed, falling back to PG:', msg.slice(0, 200));
        secsUsed = await fetchPgFallbackSecs(workspace, ym);
        source = 'pg-fallback';
      }
    }
    spendCache.set(agentId, { secsUsed, source, fetchedAt: now });
  }

  const minutesUsed = Math.round(secsUsed / 60);
  const overCap = minutesCap !== null && minutesUsed >= minutesCap;
  const pctUsed = minutesCap !== null ? Math.min(1, minutesUsed / minutesCap) : null;

  return Response.json({
    minutes_used: minutesUsed,
    minutes_cap: minutesCap,
    ym,
    over_cap: overCap,
    pct_used: pctUsed,
    source,
  });
}
