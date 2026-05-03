/**
 * POST /api/agent-mcp/operator-nudge
 *   body: { kind: 'budget' | 'breaker' | 'pause' }
 *
 * Dedup arbitration for spoken nudges. Returns `{ fired: true, ... }`
 * when the nudge should be spoken (and persists the timestamp). Returns
 * `{ fired: false }` when within the per-kind dedup window.
 *
 * Per-kind windows:
 *   budget   30 min
 *   breaker  10 min
 *   pause     5 min
 *
 * Persisted in voice-prefs.json (sleep-through-midnight + reload safe).
 */

import { NextRequest } from 'next/server';
import { maybeFireNudge, type NudgeKind } from '@/lib/voice-nudges';

export const dynamic = 'force-dynamic';

const ALLOWED: ReadonlySet<NudgeKind> = new Set(['budget', 'breaker', 'pause']);

export async function POST(req: NextRequest) {
  let body: { kind?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const kind = body.kind as NudgeKind;
  if (!ALLOWED.has(kind)) {
    return new Response('kind must be budget|breaker|pause', { status: 400 });
  }
  const fired = maybeFireNudge(kind);
  return Response.json({ fired, kind });
}
