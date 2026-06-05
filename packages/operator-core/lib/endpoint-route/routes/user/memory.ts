/**
 * /api/user/memory — list + delete + edit persistent memories for the
 * session user. Rides the neutral `MemoryBackend` seam
 * (generalize-memory-backend-swappable D-003) — rows are the neutral
 * entry shape `{ id, text, kind, scope, harness_slug?, metadata }`,
 * regardless of which store backs them.
 *
 * The audit enrichment (state + broken anchors) reads the mem0
 * canonical tables directly — it is mem0-specific by design and
 * degrades silently for other backends (no matching ids → no audit
 * fields).
 *
 * Ported from app/api/user/memory/route.ts. `auth: 'public'` —
 * session-cookie auth via getSessionUser(req.headers).
 */
import { getSessionUser } from '../../../auth';
import {
  getMemoryBackend,
  registeredMemoryBackends,
  type MemoryEntry,
} from '../../../memory/backend';
import {
  currentMemoryBackendChoice,
  writeMemoryBackendChoice,
} from '../../../memory/backend-selection';
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

/**
 * Map a neutral entry's opaque scope string onto the display grouping
 * the settings page renders: the session user's pool → 'user',
 * `harness:<slug>` → 'harness' (+ slug), legacy `workspace:<id>` →
 * 'workspace', anything else → 'user' (still the user's own view).
 */
function displayScope(e: MemoryEntry, userId: string): {
  scope: 'user' | 'harness' | 'workspace';
  harness_slug?: string;
} {
  if (e.scope.startsWith('harness:')) {
    return { scope: 'harness', harness_slug: e.scope.slice('harness:'.length) };
  }
  if (e.scope.startsWith('workspace:')) return { scope: 'workspace' };
  return e.scope === userId ? { scope: 'user' } : { scope: 'user' };
}

const list = defineTool({
  method: 'GET',
  path: '/user/memory',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) {
      return Response.json({
        results: [],
        reason: avail.reason,
        backend: backend.name,
        currentBackend: currentMemoryBackendChoice(),
        availableBackends: registeredMemoryBackends(),
      });
    }
    const ws = activeWorkspaceId();

    // User pool + one pool per harness. The per-pool fan-out is the
    // backend's concern; the deprecated workspace-shared pool was
    // drained (docs-and-memory-as-projections D-005).
    let harnessSlugs: string[] = [];
    try {
      const reg = await loadHarnessRegistry(ws);
      harnessSlugs = reg.projects.map((p) => p.slug);
    } catch { /* leave empty — section will just be empty */ }

    const entries = await backend.list({
      scope: [user.id, ...harnessSlugs.map((slug) => `harness:${slug}`)],
    });

    const combined = entries.map((e) => ({
      id: e.id,
      text: e.text,
      kind: e.kind,
      metadata: e.metadata,
      ...displayScope(e, user.id),
    }));
    combined.sort((a, b) => {
      const tA = ((a.metadata as Record<string, unknown> | undefined)?.turn_at as number) ?? 0;
      const tB = ((b.metadata as Record<string, unknown> | undefined)?.turn_at as number) ?? 0;
      return tB - tA;
    });

    // Enrich with canonical audit state (state column + broken anchors).
    // mem0-specific; silently absent for other backends / pre-085 schemas.
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

    return Response.json({
      results: enriched,
      backend: backend.name,
      currentBackend: currentMemoryBackendChoice(),
      availableBackends: registeredMemoryBackends(),
    });
  },
});

/**
 * POST /api/user/memory/backend — switch the active MemoryBackend
 * (mem0-revive-or-retire / Brief 30). Operator-wide, persisted, live: the
 * next memory call serves the new store with no restart. The owner uses
 * this to flip to `claude-file` (the real ~/.claude store) to see real
 * data + inform the revive-vs-retire decision. Validated against the
 * registry so an unknown name can't make getMemoryBackend() throw.
 */
const setBackend = defineTool({
  method: 'POST',
  path: '/user/memory/backend',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { backend?: string } | null;
    const choice = body?.backend?.trim();
    if (!choice) return Response.json({ error: 'backend_required' }, { status: 400 });
    const available = registeredMemoryBackends();
    if (!available.includes(choice)) {
      return Response.json(
        { error: 'unknown_backend', backend: choice, availableBackends: available },
        { status: 400 },
      );
    }
    await writeMemoryBackendChoice(choice);
    // Probe the newly-selected store so the UI can warn if it's unavailable
    // (e.g. selecting claude-file on a box with no ~/.claude store).
    let availability: { ok: boolean; reason?: string } = { ok: true };
    try {
      const a = await getMemoryBackend().available();
      availability = a.ok ? { ok: true } : { ok: false, reason: a.reason };
    } catch (e) {
      availability = { ok: false, reason: String((e as Error)?.message ?? e) };
    }
    return Response.json({ ok: true, backend: choice, availability });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/user/memory',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) return Response.json({ error: avail.reason }, { status: 503 });
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const all = url.searchParams.get('all');
    if (all === '1') {
      const mine = await backend.list({ scope: user.id });
      let n = 0;
      for (const entry of mine) {
        try {
          await backend.forget(entry.id);
          await recordFeedback({
            memId: entry.id, userId: user.id, action: 'forget_all',
            kind: entry.kind ?? null,
            priorText: entry.text || null,
          });
          n += 1;
        } catch { /* best-effort */ }
      }
      backend.invalidate?.();
      return Response.json({ ok: true, deleted: n });
    }
    if (!id) return Response.json({ error: 'id_or_all_required' }, { status: 400 });
    let priorText: string | null = null;
    let priorKind: string | null = null;
    try {
      const got = await backend.get(id);
      priorText = got?.text ?? null;
      priorKind = got?.kind ?? null;
    } catch { /* best-effort */ }
    await backend.forget(id);
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
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) return Response.json({ error: avail.reason }, { status: 503 });
    const body = (await req.json().catch(() => null)) as { id?: string; text?: string; memory?: string } | null;
    // `text` is the neutral field; `memory` accepted from older clients.
    const nextText = (body?.text ?? body?.memory)?.trim();
    if (!body?.id || !nextText) {
      return Response.json({ error: 'id_and_text_required' }, { status: 400 });
    }
    let priorText: string | null = null;
    let priorKind: string | null = null;
    try {
      const got = await backend.get(body.id);
      priorText = got?.text ?? null;
      priorKind = got?.kind ?? null;
    } catch { /* best-effort */ }
    await backend.update(body.id, { text: nextText });
    await recordFeedback({
      memId: body.id, userId: user.id, action: 'edit',
      kind: priorKind, priorText, newText: nextText,
    });
    return Response.json({ ok: true });
  },
});

export default [list, del, patch, setBackend];
