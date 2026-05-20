/**
 * GET /api/agent-mcp/el-admin-creds
 *
 * Loopback-only admin endpoint that returns the raw ElevenLabs API key
 * + agent id from PG (operator_voice_credentials, operator_voice_prefs).
 * Used by scripts/el-agent-sync.mjs and scripts/el-voice-preview.mjs as
 * a fallback when the legacy ~/.papercusp/credentials.json file isn't
 * present (post-PG-migration).
 *
 * Bound to 127.0.0.1 by default (PAPERCUSP_BIND_HOST). Even with that,
 * we double-check the request comes from loopback before returning the
 * raw key — never expose this over a public host.
 */
import { NextRequest } from 'next/server';
import { readElevenLabsKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  // Pre-migration behavior: any loopback request got the raw key. Preserved
  // as "any principal accepted" here. A future tightening (require
  // trust: ['trusted']) is a follow-up policy decision — the scripts that
  // consume this (el-agent-sync.mjs, el-voice-preview.mjs) currently send
  // no bearer; tightening would break them until they're updated.
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return Response.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
  const [apiKey, prefs] = await Promise.all([
    readElevenLabsKey(),
    loadVoicePrefs(),
  ]);
  return Response.json({
    apiKey: apiKey ?? null,
    agentId: prefs.elevenLabsAgentId || null,
  });
}
