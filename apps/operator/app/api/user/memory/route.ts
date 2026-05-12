/**
 * /api/user/memory — list + delete operator memories for the current
 * user. Used by /settings/user/memory page.
 *
 * Plan 3.7. Wraps mem0's getAll + delete with session-user scoping +
 * workspace-shared union.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getMemoryClient } from '@/lib/memory/mem0-client';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const client = await getMemoryClient();
  if (!client) {
    return NextResponse.json({ results: [], reason: 'mem0_unavailable' });
  }
  const ws = activeWorkspaceId();
  const [userResults, sharedResults] = await Promise.all([
    client.getAll({ userId: user.id }),
    client.getAll({ userId: `workspace:${ws}` }),
  ]);
  const combined = [
    ...((userResults.results ?? []).map((r) => ({ ...r, scope: 'user' as const }))),
    ...((sharedResults.results ?? []).map((r) => ({ ...r, scope: 'workspace' as const }))),
  ];
  // Sort newest first by metadata.turn_at if present, fallback to id.
  combined.sort((a, b) => {
    const tA = ((a.metadata as Record<string, unknown>)?.turn_at as number) ?? 0;
    const tB = ((b.metadata as Record<string, unknown>)?.turn_at as number) ?? 0;
    return tB - tA;
  });
  return NextResponse.json({ results: combined });
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const client = await getMemoryClient();
  if (!client) return NextResponse.json({ error: 'mem0_unavailable' }, { status: 503 });
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const all = url.searchParams.get('all');
  if (all === '1') {
    // Forget-everything-mine action from /settings/user.
    const myResults = await client.getAll({ userId: user.id });
    let n = 0;
    for (const r of myResults.results ?? []) {
      try { await client.delete(r.id); n += 1; } catch { /* best-effort */ }
    }
    return NextResponse.json({ ok: true, deleted: n });
  }
  if (!id) return NextResponse.json({ error: 'id_or_all_required' }, { status: 400 });
  await client.delete(id);
  return NextResponse.json({ ok: true });
}
