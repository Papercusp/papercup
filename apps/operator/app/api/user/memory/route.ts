/**
 * /api/user/memory — list + delete operator memories for the current
 * user. Used by /settings/user/memory page.
 *
 * Plan 3.7. Wraps mem0's getAll + delete with session-user scoping +
 * workspace-shared union.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getMemoryClient, invalidateMemoryClient } from '@/lib/memory/mem0-client';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { recordFeedback } from '@/lib/memory/feedback';

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
  // mem0 v3 rejects top-level userId on getAll() — must go through
  // `filters.user_id` (snake_case; camelCase silently doesn't filter
  // because mem0 reads filters.user_id internally). topK high so
  // per-user listings aren't capped at mem0's default of 20.
  const [userResults, sharedResults] = await Promise.all([
    client.getAll({ filters: { user_id: user.id }, topK: 5000 }),
    client.getAll({ filters: { user_id: `workspace:${ws}` }, topK: 5000 }),
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
    const myResults = await client.getAll({ filters: { user_id: user.id }, topK: 5000 });
    let n = 0;
    for (const r of myResults.results ?? []) {
      try {
        await client.delete(r.id);
        const k = (r.metadata as Record<string, unknown> | undefined)?.kind;
        await recordFeedback({
          memId: r.id, userId: user.id, action: 'forget_all',
          kind: typeof k === 'string' ? k : null,
          priorText: r.memory ?? null,
        });
        n += 1;
      } catch { /* best-effort */ }
    }
    // High-impact action — force learning-loop instructions to refresh
    // on the next memory operation rather than waiting for TTL.
    invalidateMemoryClient();
    return NextResponse.json({ ok: true, deleted: n });
  }
  if (!id) return NextResponse.json({ error: 'id_or_all_required' }, { status: 400 });
  // Snapshot prior text + kind BEFORE delete so we can record feedback.
  let priorText: string | null = null;
  let priorKind: string | null = null;
  try {
    const got = await client.get(id);
    priorText = (got as { memory?: string } | null)?.memory ?? null;
    const k = (got as { metadata?: Record<string, unknown> } | null)?.metadata?.kind;
    priorKind = typeof k === 'string' ? k : null;
  } catch { /* best-effort */ }
  await client.delete(id);
  await recordFeedback({
    memId: id, userId: user.id, action: 'delete', kind: priorKind, priorText,
  });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const client = await getMemoryClient();
  if (!client) return NextResponse.json({ error: 'mem0_unavailable' }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { id?: string; memory?: string } | null;
  if (!body?.id || typeof body.memory !== 'string' || !body.memory.trim()) {
    return NextResponse.json({ error: 'id_and_memory_required' }, { status: 400 });
  }
  let priorText: string | null = null;
  let priorKind: string | null = null;
  try {
    const got = await client.get(body.id);
    priorText = (got as { memory?: string } | null)?.memory ?? null;
    const k = (got as { metadata?: Record<string, unknown> } | null)?.metadata?.kind;
    priorKind = typeof k === 'string' ? k : null;
  } catch { /* best-effort */ }
  await client.update(body.id, body.memory.trim());
  await recordFeedback({
    memId: body.id, userId: user.id, action: 'edit',
    kind: priorKind, priorText, newText: body.memory.trim(),
  });
  return NextResponse.json({ ok: true });
}
