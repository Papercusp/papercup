/**
 * /api/user/memory — list + delete + edit operator memories for the
 * session user. Wraps mem0's getAll/delete/update with session-user
 * scoping + workspace-shared union.
 *
 * Ported from app/api/user/memory/route.ts. `auth: 'public'` —
 * session-cookie auth via getSessionUser(req.headers).
 */
import { getSessionUser } from '@/lib/auth';
import { getMemoryClient, invalidateMemoryClient } from '@/lib/memory/mem0-client';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { recordFeedback } from '@/lib/memory/feedback';
import { defineTool } from '@papercusp/agent-mcp';

const list = defineTool({
  method: 'GET',
  path: '/user/memory',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const client = await getMemoryClient();
    if (!client) {
      return Response.json({ results: [], reason: 'mem0_unavailable' });
    }
    const ws = activeWorkspaceId();
    const [userResults, sharedResults] = await Promise.all([
      client.getAll({ filters: { user_id: user.id }, topK: 5000 }),
      client.getAll({ filters: { user_id: `workspace:${ws}` }, topK: 5000 }),
    ]);
    const combined = [
      ...((userResults.results ?? []).map((r) => ({ ...r, scope: 'user' as const }))),
      ...((sharedResults.results ?? []).map((r) => ({ ...r, scope: 'workspace' as const }))),
    ];
    combined.sort((a, b) => {
      const tA = ((a.metadata as Record<string, unknown>)?.turn_at as number) ?? 0;
      const tB = ((b.metadata as Record<string, unknown>)?.turn_at as number) ?? 0;
      return tB - tA;
    });
    return Response.json({ results: combined });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/user/memory',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const client = await getMemoryClient();
    if (!client) return Response.json({ error: 'mem0_unavailable' }, { status: 503 });
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const all = url.searchParams.get('all');
    if (all === '1') {
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
      invalidateMemoryClient();
      return Response.json({ ok: true, deleted: n });
    }
    if (!id) return Response.json({ error: 'id_or_all_required' }, { status: 400 });
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
    return Response.json({ ok: true });
  },
});

const patch = defineTool({
  method: 'PATCH',
  path: '/user/memory',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const client = await getMemoryClient();
    if (!client) return Response.json({ error: 'mem0_unavailable' }, { status: 503 });
    const body = (await req.json().catch(() => null)) as { id?: string; memory?: string } | null;
    if (!body?.id || typeof body.memory !== 'string' || !body.memory.trim()) {
      return Response.json({ error: 'id_and_memory_required' }, { status: 400 });
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
    return Response.json({ ok: true });
  },
});

export default [list, del, patch];
