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
} from '../../../memory/backend';
import {
  currentMemoryBackendChoice,
  writeMemoryBackendChoice,
} from '../../../memory/backend-selection';
import { listUserMemories } from '../../../memory/list-user-memories';
import { recordFeedback } from '../../../memory/feedback';
import { readClaudeHygiene } from '../../../memory/claude-hygiene';
import { notifySyncInvalidate } from '../../../sync-sse';
import { activeWorkspaceId } from '../../../workspace-registry';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

/**
 * Mark every cached `userMemory.list` stale (args omitted = all users /
 * all instances — see SSEAdapter). Best-effort: a notify failure must
 * never fail the write that triggered it.
 */
const invalidateMemoryList = (): void => {
  void notifySyncInvalidate('userMemory.list').catch(() => { /* best-effort */ });
};

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
    const enriched = await listUserMemories(user.id);

    return Response.json({
      results: enriched,
      backend: backend.name,
      currentBackend: currentMemoryBackendChoice(),
      availableBackends: registeredMemoryBackends(),
    });
  },
});

/**
 * GET /api/user/memory/backend — backend availability + selection meta
 * for the settings page. The row data itself rides the `userMemory.list`
 * sync query (P-007); this endpoint carries only the envelope the old
 * list response bundled (backend name / choices / unavailable-reason).
 */
const backendInfo = defineTool({
  method: 'GET',
  path: '/user/memory/backend',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const backend = getMemoryBackend();
    const avail = await backend.available();
    // Harness slugs for the add-memory scope select (P-010); claude-file
    // hygiene pressure for the curation banner (P-012). Both best-effort.
    let harnesses: string[] = [];
    try {
      const reg = await loadHarnessRegistry(activeWorkspaceId());
      harnesses = reg.projects.map((p) => p.slug);
    } catch { /* select just offers Personal */ }
    const hygiene = await readClaudeHygiene().catch(() => null);
    return Response.json({
      backend: backend.name,
      currentBackend: currentMemoryBackendChoice(),
      availableBackends: registeredMemoryBackends(),
      reason: avail.ok ? null : avail.reason,
      userId: user.id,
      harnesses,
      hygiene,
    });
  },
});

/**
 * POST /api/user/memory — create a memory from the settings page (P-010).
 * Writes through the neutral backend seam like the `memory:remember` MCP
 * verb, but trusts the page's free-form kind (the taxonomy is backend-
 * defined — D-001); records `create` feedback symmetrically with
 * edit/delete so the extractor learns from hand-curated entries too.
 */
const create = defineTool({
  method: 'POST',
  path: '/user/memory',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) return Response.json({ error: avail.reason }, { status: 503 });
    const body = (await req.json().catch(() => null)) as
      | { text?: string; kind?: string; harness_slug?: string }
      | null;
    const text = body?.text?.trim();
    if (!text) return Response.json({ error: 'text_required' }, { status: 400 });
    const kind = body?.kind?.trim() || undefined;
    if (kind && kind.length > 40) {
      return Response.json({ error: 'kind_too_long' }, { status: 400 });
    }
    const harnessSlug = body?.harness_slug?.trim() || undefined;

    const scopeKey = harnessSlug ? `harness:${harnessSlug}` : user.id;
    const metadata: Record<string, unknown> = {
      scope: harnessSlug ? 'harness' : 'user',
      created_by: user.id,
      display_name: user.display_name,
      source: 'settings-page',
    };
    if (harnessSlug) metadata.harness_slug = harnessSlug;

    // verbatim: the user typed exactly what they want stored — bypass the
    // mem0 leg's LLM fact-extraction (which can extract NOTHING from short
    // prose and silently store zero entries; observed live 2026-06-09).
    const { ids } = await backend.remember(text, { scope: scopeKey, kind, metadata, verbatim: true });
    for (const id of ids) {
      await recordFeedback({
        memId: id, userId: user.id, action: 'create', kind: kind ?? null, newText: text,
      });
    }
    invalidateMemoryList();
    return Response.json({ ok: true, ids });
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
  auth: 'loopback',
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
    invalidateMemoryList();
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
  auth: 'loopback',
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
      invalidateMemoryList();
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
    invalidateMemoryList();
    return Response.json({ ok: true });
  },
});

const patch = defineTool({
  method: 'PATCH',
  path: '/user/memory',
  auth: 'loopback',
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
    invalidateMemoryList();
    return Response.json({ ok: true });
  },
});

export default [list, create, del, patch, setBackend, backendInfo];
