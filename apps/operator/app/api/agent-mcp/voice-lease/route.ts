/**
 * Cross-surface voice lease — desktop side. Mirrors the mobile routes at
 * /api/mobile/voice-lease/* but session-cookie-gated instead of device JWT.
 *
 * The desktop tab calls `claim` when it goes leader (per the
 * BroadcastChannel election), heartbeats every 5s, releases on tab close
 * or leader yield. When the phone preempts, the sync-invalidate event
 * `voiceLease.current` flips desktop subscribers off.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import {
  claimVoiceLease,
  releaseVoiceLease,
  readVoiceLease,
} from '@/lib/voice-lease';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function requireSession(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  return { ok: true };
}

export async function GET() {
  const auth = await requireSession();
  if (!auth.ok) return auth.res;
  const lease = await readVoiceLease(activeWorkspaceId());
  return NextResponse.json({ lease });
}

export async function POST(req: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => ({}))) as {
    op?: 'claim' | 'heartbeat';
    tabId?: string;
    force?: boolean;
  };
  if (typeof body.tabId !== 'string' || body.tabId.length === 0) {
    return NextResponse.json({ error: 'tabId required' }, { status: 400 });
  }
  const result = await claimVoiceLease({
    workspaceId: activeWorkspaceId(),
    ownerId: body.tabId,
    ownerKind: 'desktop',
    force: body.op === 'claim' && body.force === true,
  });
  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return auth.res;
  const tabId = req.nextUrl.searchParams.get('tabId');
  if (!tabId) return NextResponse.json({ error: 'tabId required' }, { status: 400 });
  await releaseVoiceLease({ workspaceId: activeWorkspaceId(), ownerId: tabId });
  return NextResponse.json({ ok: true });
}
