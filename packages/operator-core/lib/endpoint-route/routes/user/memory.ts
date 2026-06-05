/**
 * /api/user/memory — list + delete + edit operator memories for the
 * session user. Wraps mem0's getAll/delete/update with session-user
 * scoping + workspace-shared union.
 *
 * Ported from app/api/user/memory/route.ts. `auth: 'public'` —
 * session-cookie auth via getSessionUser(req.headers).
 */
import { getSessionUser } from '../../../auth';
import { getMemoryClient, invalidateMemoryClient } from '../../../memory/mem0-client';
import { activeWorkspaceId } from '../../../workspace-registry';
import { loadHarnessRegistry } from '../../../harness-registry';
import { recordFeedback } from '../../../memory/feedback';
import { pgClientFields } from '../../../memory/mem0-connection';
import { defineTool } from '@papercusp/agent-mcp';

interface AuditEnrichment {
  state: string;
  last_validated_at: string | null;
  last_surfaced_at: string | null;
  broken_anchors: Array<{ kind: string; value: string; reason: string | null }>;
}

async function loadAuditEnrichment(
  ids: string[],
): Promise<Map<string, AuditEnrichment>> {
  const out = new Map<string, AuditEnrichment>();
  if (ids.length === 0) return out;
  let Client: typeof import('pg').Client;
  try {
    ({ Client } = await import('pg'));
  } catch {
    return out;
  }
  const fields = await pgClientFields();
  const client = new Client(fields);
  try {
    await client.connect();
  } catch {
    return out;
  }
  try {
    // Probe migration 085 — quietly degrade if not applied yet.
    try {
      await client.query(
        `SELECT 1 FROM harness_shared.memory_canonical
         WHERE state IS NOT NULL LIMIT 1`,
      );
    } catch {
      return out;
    }

    type CanonRow = {
      id: string;
      state: string | null;
      last_validated_at: string | null;
      last_surfaced_at: string | null;
    };
    const canon = await client.query<CanonRow>(
      `SELECT id, state, last_validated_at, last_surfaced_at
       FROM harness_shared.memory_canonical
       WHERE id = ANY($1::text[])`,
      [ids],
    );
    for (const r of canon.rows) {
      out.set(r.id, {
        state: r.state ?? 'active',
        last_validated_at: r.last_validated_at,
        last_surfaced_at: r.last_surfaced_at,
        broken_anchors: [],
      });
    }

    // Pull broken anchors so the UI can surface a per-row reason.
    try {
      type AnchorRow = {
        memory_id: string;
        kind: string;
        value: string;
        last_check_ok: boolean | null;
      };
      const anchors = await client.query<AnchorRow>(
        `SELECT memory_id, kind, value, last_check_ok
         FROM harness_shared.memory_anchors
         WHERE memory_id = ANY($1::text[]) AND last_check_ok = false`,
        [ids],
      );
      for (const a of anchors.rows) {
        const e = out.get(a.memory_id);
        if (!e) continue;
        e.broken_anchors.push({
          kind: a.kind,
          value: a.value,
          reason: a.last_check_ok === false ? 'check_failed' : null,
        });
      }
    } catch { /* memory_anchors absent → leave list empty */ }
  } finally {
    try { await client.end(); } catch { /* swallow */ }
  }
  return out;
}

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

    // Two-way fan-out: user-scoped + per-harness (one pull per slug). The
    // deprecated workspace-shared pool was drained (docs-and-memory-as-projections
    // D-005). mem0's PGVector adapter doesn't support OR/IN filters, so each pool
    // is a separate getAll() — see the memory-harness-scope plan for the audit.
    let harnessSlugs: string[] = [];
    try {
      const reg = await loadHarnessRegistry(ws);
      harnessSlugs = reg.projects.map((p) => p.slug);
    } catch { /* leave empty — section will just be empty */ }

    const userPull = client.getAll({ filters: { user_id: user.id }, topK: 5000 });
    const harnessPulls = harnessSlugs.map((slug) =>
      client.getAll({ filters: { user_id: `harness:${slug}` }, topK: 5000 })
        .then((r) => ({ slug, results: r.results ?? [] })),
    );

    const [userRes, ...harnessResults] = await Promise.all([
      userPull,
      ...harnessPulls,
    ]);

    const combined = [
      ...((userRes.results ?? []).map((r) => ({ ...r, scope: 'user' as const }))),
      ...harnessResults.flatMap((h) =>
        h.results.map((r) => ({ ...r, scope: 'harness' as const, harness_slug: h.slug })),
      ),
    ];
    combined.sort((a, b) => {
      const tA = ((a.metadata as Record<string, unknown>)?.turn_at as number) ?? 0;
      const tB = ((b.metadata as Record<string, unknown>)?.turn_at as number) ?? 0;
      return tB - tA;
    });

    // Enrich with canonical audit state (state column + broken anchors).
    // Silent no-op until migration 085 is applied.
    const audit = await loadAuditEnrichment(combined.map((r) => r.id));
    const enriched = combined.map((r) => {
      const e = audit.get(r.id);
      if (!e) return r;
      return {
        ...r,
        audit: {
          state: e.state,
          last_validated_at: e.last_validated_at,
          last_surfaced_at: e.last_surfaced_at,
          broken_anchors: e.broken_anchors,
        },
      };
    });

    return Response.json({ results: enriched });
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
