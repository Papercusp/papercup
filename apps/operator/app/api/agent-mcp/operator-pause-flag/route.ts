/**
 * GET /api/agent-mcp/operator-pause-flag — read the operator pause state.
 * The chrome's BackgroundScanner polls this so `operator pause` (CLI)
 * stops scans even when the panel hasn't been opened.
 *
 * POST   — set paused=true.
 * DELETE — set paused=false.
 *
 * State now lives in `harness_shared.operator_paused` (PG, migration 029);
 * was previously `<ws>/system/operator/paused.flag` file existence.
 */

import { getSessionUser } from '@/lib/auth';
import { setPaused, setResumed, isPaused } from '@/lib/mobile-operator-actions';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ paused: await isPaused() });
}

export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  await setPaused(user.email);
  return Response.json({ ok: true, paused: true });
}

export async function DELETE() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  await setResumed();
  return Response.json({ ok: true, paused: false });
}
