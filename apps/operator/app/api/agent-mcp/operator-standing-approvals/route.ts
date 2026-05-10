/**
 * Standing-approval candidates + promotion endpoint.
 *
 * GET   → { candidates: StandingCandidate[] }   (auto-refreshes from audit_log)
 * POST  body: { capability, targetHarness, decision: 'approve'|'dismiss' }
 *   - approve → append `[OPERATOR-PROPOSED-USER-CONFIRMED-…] [STANDING-APPROVE] ...` to preferences.md
 *   - dismiss → drop from candidates list (won't re-prompt until pattern repeats)
 */

import { NextRequest } from 'next/server';
import { appendPreferenceEntry } from '@/lib/operator-preferences';
import {
  readCandidates,
  refreshCandidates,
} from '@/lib/operator-standing-candidates';

export const dynamic = 'force-dynamic';

export async function GET() {
  const candidates = await refreshCandidates().catch(async () => await readCandidates());
  return Response.json({ candidates });
}

export async function POST(req: NextRequest) {
  let body: { capability?: unknown; targetHarness?: unknown; decision?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const capability = typeof body.capability === 'string' ? body.capability : '';
  const target = typeof body.targetHarness === 'string' ? body.targetHarness : '';
  const decision = body.decision;
  if (!capability || !target || (decision !== 'approve' && decision !== 'dismiss')) {
    return new Response('capability + targetHarness + decision required', { status: 400 });
  }
  if (decision === 'approve') {
    const today = new Date().toISOString().slice(0, 10);
    const entry = `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n  capability=${capability}, target=${target}\n  pattern: ≥3 silent dispatches in 24h\n  user confirmed: ${new Date().toISOString()}`;
    await appendPreferenceEntry(entry);
  }
  // For both approve + dismiss we refresh candidates so the user-approved
  // pair drops out (loadPreferences will exclude it next pass).
  await refreshCandidates().catch(() => {});
  return Response.json({ ok: true });
}
