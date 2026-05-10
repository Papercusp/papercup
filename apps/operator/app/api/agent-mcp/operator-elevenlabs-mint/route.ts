/**
 * GET /api/agent-mcp/operator-elevenlabs-mint?agentId=<id>
 *
 * Diagnostic-only token mint. Lets the el-fresh-test.html page mint a
 * token for ANY agent id (not just the one in voice-prefs). Used for
 * comparing the production agent against fresh test agents to isolate
 * agent-config corruption from SDK/network issues.
 *
 * Response: { token: string, agentId: string }
 */

import { NextRequest } from 'next/server';
import { readElevenLabsKey } from '@/lib/voice-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const agentId = new URL(req.url).searchParams.get('agentId')?.trim();
  if (!agentId || !/^agent_[A-Za-z0-9]+$/.test(agentId)) {
    return Response.json({ error: 'invalid-agent-id' }, { status: 400 });
  }
  const apiKey = await readElevenLabsKey();
  if (!apiKey) return Response.json({ error: 'no-api-key' }, { status: 404 });

  let res: Response;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}&source=js_sdk&version=1.4.0`,
      { method: 'GET', headers: { 'xi-api-key': apiKey, 'accept': 'application/json' }, signal: AbortSignal.timeout(8000) },
    );
  } catch (err: unknown) {
    return Response.json({ error: 'mint-failed', detail: (err as Error)?.message ?? String(err) }, { status: 502 });
  }
  if (!res.ok) {
    return Response.json({ error: 'mint-rejected', status: res.status, detail: (await res.text()).slice(0, 400) }, { status: 502 });
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string; conversation_token?: string };
  const token = data.token ?? data.conversation_token;
  if (!token) return Response.json({ error: 'mint-shape' }, { status: 502 });
  return Response.json({ token, agentId });
}
