/**
 * POST /api/agent-mcp/operator-standing-mark-shown
 *   body: { capability, targetHarness }
 *
 * Sets `firstShownAt` on a standing candidate. Settings page calls this
 * when the candidate row first renders. Required for voice-approve
 * eligibility per voice-mode-plan-v4 §5d.
 */

import { NextRequest } from 'next/server';
import { markCandidateShown } from '@/lib/operator-standing-candidates';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { capability?: unknown; targetHarness?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const capability = typeof body.capability === 'string' ? body.capability : '';
  const targetHarness = typeof body.targetHarness === 'string' ? body.targetHarness : '';
  if (!capability || !targetHarness) {
    return new Response('capability + targetHarness required', { status: 400 });
  }
  await markCandidateShown(capability, targetHarness);
  return Response.json({ ok: true });
}
