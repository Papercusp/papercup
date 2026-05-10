/**
 * Voice debug ring-buffer (legacy browser route).
 *
 * Backed by `apps/operator/lib/voice-debug-ring.ts` so the MCP tool
 * `operator:voice_debug` shares the same buffer.
 *
 * POST /api/agent-mcp/voice-debug — append an event
 *   body: { event: string, detail?: any, ts?: number }
 * GET  /api/agent-mcp/voice-debug?since=<ts> — last 100 events newest-first
 * DELETE /api/agent-mcp/voice-debug — clear the ring
 */

import { NextRequest } from 'next/server';
import {
  appendVoiceDebugEvent,
  clearVoiceDebugEvents,
  readVoiceDebugEvents,
} from '@/lib/voice-debug-ring';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { event?: string; detail?: unknown; ts?: number } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }
  const count = appendVoiceDebugEvent(body);
  return Response.json({ ok: true, count });
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get('since') ?? '0');
  const events = readVoiceDebugEvents(since || undefined);
  return Response.json({
    count: events.length,
    events,
  });
}

export async function DELETE(): Promise<Response> {
  clearVoiceDebugEvents();
  return Response.json({ ok: true, cleared: true });
}
