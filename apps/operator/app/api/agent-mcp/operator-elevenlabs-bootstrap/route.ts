/**
 * GET /api/agent-mcp/operator-elevenlabs-bootstrap
 *
 * Mints a short-lived conversation token for the configured ElevenLabs
 * Conv AI agent so the browser can open a WebRTC session to it without
 * exposing the workspace API key.
 *
 * Returns:
 *   {
 *     conversationToken: string,    // pass as `conversationToken` to Conversation.startSession
 *     agentId: string,
 *     expiresAt?: number,            // unix ms
 *   }
 *
 * Errors are returned as JSON with 4xx/5xx status so the client-side
 * caller can fall back gracefully (toast → ask user to switch engine
 * in settings, etc.).
 */

import { readElevenLabsKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';
import { readCooldownMark, writeCooldownMark } from '@/lib/cooldown-marks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Per-agent mint throttle. EL workspace concurrency on Free tier is 1;
 * each mint reserves the slot for ~30s server-side even if the client
 * never connects. Without throttling, a refresh storm or a multi-tab
 * user can DoS themselves out of being able to start any session.
 *
 * Two protections:
 *  - **In-flight dedupe**: parallel requests for the same agent share
 *    one upstream call (returns the same promise/result).
 *  - **Cooldown**: after a successful mint, refuse new mints for 8s
 *    with a 429 + a clear "wait" hint. 8s is shorter than EL's
 *    server-side hold so a connected session naturally takes precedence,
 *    and long enough that a user spamming refresh doesn't pile up.
 */
// In-flight dedupe stays process-local (Promise refs can't serialize).
// The cooldown timestamp moved to harness_shared.cooldown_marks (migration
// 032) — survives operator restart, shared across multi-instance.
const inFlight = new Map<string, Promise<{ token: string } | { error: string; status: number; detail: string }>>();
const COOLDOWN_MS = 8_000;
const cooldownKey = (agentId: string) => `el-mint:${agentId}`;

export async function GET(): Promise<Response> {
  const prefs = await loadVoicePrefs();
  if (prefs.fullAgentEngine !== 'elevenlabs-conv' &&
      prefs.fullAgentEngine !== 'elevenlabs-conversational') {
    return Response.json({ error: 'not-enabled' }, { status: 404 });
  }

  const agentId = prefs.elevenLabsAgentId?.trim();
  if (!agentId) {
    return Response.json(
      { error: 'no-agent-id', hint: 'Set the ElevenLabs agent ID in /settings/voice.' },
      { status: 404 },
    );
  }

  const apiKey = await readElevenLabsKey();
  if (!apiKey) {
    return Response.json(
      { error: 'no-api-key', hint: 'Add your ElevenLabs API key in /settings/api-keys.' },
      { status: 404 },
    );
  }

  // Cooldown: refuse if we minted very recently. The client-side knows
  // to retry after the suggested delay rather than bombard EL.
  const lastMintMs = (await readCooldownMark(cooldownKey(agentId))) ?? 0;
  const since = Date.now() - lastMintMs;
  if (since < COOLDOWN_MS) {
    const retryInMs = COOLDOWN_MS - since;
    return Response.json(
      {
        error: 'mint-cooldown',
        hint: `Slow down — minted a fresh EL token ${(since / 1000).toFixed(1)}s ago. Retry in ${(retryInMs / 1000).toFixed(1)}s.`,
        retryAfterMs: retryInMs,
      },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(retryInMs / 1000)) } },
    );
  }

  // In-flight dedupe: if a parallel request is already minting for this
  // agent, await its result instead of firing a second EL call.
  let pending = inFlight.get(agentId);
  if (!pending) {
    pending = mintFromEL(agentId, apiKey).finally(() => {
      inFlight.delete(agentId);
    });
    inFlight.set(agentId, pending);
  }
  const result = await pending;

  if ('error' in result) {
    if (result.error === 'concurrent-limit') {
      return Response.json(
        {
          error: 'concurrent-limit',
          hint: 'Another tab or browser still has an active EL session. Close other operator tabs and retry. (EL Conv AI workspace concurrency limit.)',
          status: result.status,
          detail: result.detail,
        },
        { status: 503 },
      );
    }
    return Response.json(
      { error: result.error, status: result.status, detail: result.detail },
      { status: result.status >= 500 ? 502 : result.status },
    );
  }
  // Successful mint — record so subsequent calls are throttled.
  await writeCooldownMark(cooldownKey(agentId));
  return Response.json({
    conversationToken: result.token,
    agentId,
  });
}

async function mintFromEL(
  agentId: string,
  apiKey: string,
): Promise<{ token: string } | { error: string; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}&source=js_sdk&version=1.4.0`,
      {
        method: 'GET',
        headers: { 'xi-api-key': apiKey, 'accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    );
  } catch (err: unknown) {
    return { error: 'mint-failed', status: 502, detail: (err as Error)?.message ?? String(err) };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    if (res.status === 429 && /concurrent_limit_exceeded|workspace_concurrency_limit/i.test(detail)) {
      return { error: 'concurrent-limit', status: res.status, detail };
    }
    return { error: 'mint-rejected', status: res.status, detail };
  }
  const rawText = await res.text();
  let data: { token?: string; conversation_token?: string } = {};
  try { data = JSON.parse(rawText); } catch { /* leave empty */ }
  const token = data.token ?? data.conversation_token;
  if (typeof token !== 'string' || !token) {
    return { error: 'mint-shape', status: 502, detail: `no token in response; raw: ${rawText.slice(0, 200)}` };
  }
  return { token };
}
