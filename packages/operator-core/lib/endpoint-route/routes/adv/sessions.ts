/**
 * /api/adv/sessions/* — read + control routes for the /adv/sessions
 * UI. Backed by harness_shared.adv_sessions (migration 079).
 *
 *   GET /api/adv/sessions                 → list rows
 *   POST /api/adv/sessions/focus           → bring a window to front
 *   GET /api/adv/sessions/alive?pid=N      → is the pid still alive?
 *
 * Public endpoints — operator binds loopback-only. Mirrors the
 * /api/admin/* pattern (no extra principal gate at the route layer).
 */

import os from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import {
  focusWindowId,
  getAdvSession,
  listAdvSessions,
  listEndedAdvSessions,
  listPendingWorkbenchLaunches,
  listResumableSessions,
  markAdvSessionLaunched,
  resolveWindowIdForPid,
  resolveWindowIdForTitleFragment,
  setAdvSessionOmpThreadId,
  setAdvSessionWindowId,
} from '../../../adv-sessions';
import {
  mergeRosterWithAssignments,
  dedupeEndedAgainstActive,
  pendingLaunchesToRosterEntries,
} from '../../../adv-roster';
import { gatherOnDesktopSessions } from '../../../desktop-window-liveness';
import { setOnDesktopWindowsCache, type WindowsDesktopWindow } from '../../../windows-desktop-windows';
import { readOmpConfig } from '../../../omp-config';
import {
  findOmpSessionNear,
  getOmpSessionRowSummary,
  getOmpSessionState,
  searchOmpSessions,
} from '../../../omp-sessions';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

async function readOmpMemoryConfig(): Promise<Record<string, unknown>> {
  const wanted = new Set([
    'memory.backend',
    'hindsight.apiUrl',
    'hindsight.scoping',
    'hindsight.autoRecall',
    'hindsight.autoRetain',
    'hindsight.retainMode',
    'hindsight.recallBudget',
    'hindsight.recallMaxTokens',
  ]);
  try {
    const sections = await readOmpConfig();
    const values: Record<string, { value: unknown; raw: string; isUnset: boolean }> = {};
    for (const section of sections) {
      for (const setting of section.settings) {
        if (!wanted.has(setting.key)) continue;
        values[setting.key] = {
          value: setting.parsed,
          raw: setting.raw,
          isUnset: setting.isUnset,
        };
      }
    }
    return {
      ok: true,
      backend: values['memory.backend']?.value ?? null,
      hindsight: {
        apiUrl: values['hindsight.apiUrl']?.value ?? null,
        scoping: values['hindsight.scoping']?.value ?? null,
        autoRecall: values['hindsight.autoRecall']?.value ?? null,
        autoRetain: values['hindsight.autoRetain']?.value ?? null,
        retainMode: values['hindsight.retainMode']?.value ?? null,
        recallBudget: values['hindsight.recallBudget']?.value ?? null,
        recallMaxTokens: values['hindsight.recallMaxTokens']?.value ?? null,
      },
      values,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function resolveOmpSessionForRequest(req: Request): Promise<{
  advSession: Awaited<ReturnType<typeof getAdvSession>> | null;
  sessionId: string | null;
  filePath: string | null;
  match: ReturnType<typeof findOmpSessionNear> | null;
}> {
  const url = new URL(req.url);
  const advId = Number(url.searchParams.get('id') ?? NaN);
  const directSessionId = url.searchParams.get('sessionId');
  const directFilePath = url.searchParams.get('filePath');

  if (directSessionId || directFilePath) {
    return {
      advSession: null,
      sessionId: directSessionId,
      filePath: directFilePath,
      match: null,
    };
  }

  if (!Number.isFinite(advId) || advId <= 0) {
    return { advSession: null, sessionId: null, filePath: null, match: null };
  }

  const advSession = await getAdvSession(advId);
  if (!advSession || advSession.mode !== 'omp') {
    return { advSession, sessionId: null, filePath: null, match: null };
  }

  if (advSession.ompThreadId) {
    return { advSession, sessionId: advSession.ompThreadId, filePath: null, match: null };
  }

  const match = findOmpSessionNear({
    startedAtMs: new Date(advSession.startedAt).getTime(),
    cwd: advSession.cwd ?? undefined,
    windowMs: 5 * 60_000,
  });
  if (match?.id) {
    await setAdvSessionOmpThreadId(advSession.id, match.id);
  }
  return {
    advSession: match?.id ? { ...advSession, ompThreadId: match.id } : advSession,
    sessionId: match?.id ?? null,
    filePath: match?.filePath ?? null,
    match,
  };
}

function requestHasExplicitSessionScope(url: URL): boolean {
  return (
    url.searchParams.has('id') ||
    url.searchParams.has('sessionId') ||
    url.searchParams.has('filePath')
  );
}

const list = defineTool({
  method: 'GET',
  path: '/adv/sessions',
  auth: 'public',
  async handler() {
    const rows = await listAdvSessions(200);
    // Which of these sessions currently have a live OS window (a desktop the user
    // is looking at). Best-effort → empty set on a headless box / wmctrl failure,
    // so the column is simply absent rather than wrong.
    const onDesktop = await gatherOnDesktopSessions().catch(() => null);
    const onDesktopIds = onDesktop?.advSessionIds ?? new Set<number>();
    // For every OMP row, attach a lightweight row-summary read from
    // the JSONL. Done server-side so the client sees the final filtered
    // list on first paint — the previous client-side filter ran AFTER
    // a per-row lazy /state fetch and caused empty rows to flash in
    // and out as the summaries arrived.
    //
    // Filter rule (only applies to OMP rows):
    //   - If the JSONL is found AND has 0 user messages → drop (truly empty).
    //   - A missing JSONL (summary === null) is NOT proof of emptiness —
    //     the file may have been in a different path, cleaned up, or the
    //     ompThreadId hasn't been lazily resolved yet. Keep these rows.
    //   - The DB-level filter already removes truly dead-on-arrival rows
    //     (ended in <5s with no ompThreadId), so no additional startup-
    //     grace check is needed here.
    const withSummary = await Promise.all(
      rows.map(async (row) => {
        if (row.mode !== 'omp') return { row, summary: null };
        const summary = row.ompThreadId
          ? getOmpSessionRowSummary({ id: row.ompThreadId })
          : null;
        return { row, summary };
      }),
    );
    const STARTUP_GRACE_MS = 60_000;
    const now = Date.now();
    const filtered = withSummary.filter(({ row, summary }) => {
      if (row.mode !== 'omp') return true;
      // JSONL found with real content → definitely keep.
      if (summary && summary.userMessages > 0) return true;
      // JSONL found but confirmed empty (0 user messages) → drop unless
      // the session is fresh enough to still be initializing.
      if (summary !== null && summary.userMessages === 0) {
        const startedMs = Date.parse(row.startedAt);
        const inStartupGrace =
          Number.isFinite(startedMs) && now - startedMs < STARTUP_GRACE_MS;
        return inStartupGrace;
      }
      // summary === null: JSONL missing or ompThreadId not yet resolved.
      // Keep — the UI shows "state unavailable" gracefully; hiding the
      // row entirely loses the row from the user's session history.
      return true;
    });
    const responseRows = filtered.map(({ row, summary }) => ({
      ...row,
      summary,
      // true ⇒ this session has a live OS window on screen right now (and is
      // hard-exempt from the idle-session reaper).
      onDesktop: onDesktopIds.has(row.id),
    }));
    return new Response(JSON.stringify({ rows: responseRows }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

const focus = defineTool({
  method: 'POST',
  path: '/adv/sessions/focus',
  auth: 'loopback',
  async handler(req) {
    let body: { id?: number; pid?: number; windowId?: string | null } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore */ }

    let wid = body.windowId ?? null;
    const latestRow =
      typeof body.id === 'number' && body.id > 0
        ? await getAdvSession(body.id)
        : null;
    if (!wid && latestRow?.windowId) {
      wid = latestRow.windowId;
    }
    if (!wid && typeof body.pid === 'number') {
      wid = await resolveWindowIdForPid(body.pid);
    }
    if (!wid && latestRow?.id) {
      wid = await resolveWindowIdForTitleFragment(`[adv:${latestRow.id}]`);
      if (wid) await setAdvSessionWindowId(latestRow.id, wid);
    }
    if (!wid) {
      return new Response(
        JSON.stringify({
          status: 'error',
          error: 'could not resolve a window id (wmctrl missing, no DISPLAY, or pid has no window)',
        }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    const ok = await focusWindowId(wid);
    return new Response(
      JSON.stringify({ status: ok ? 'ok' : 'error', windowId: wid }),
      { status: ok ? 200 : 500, headers: JSON_HEADERS },
    );
  },
});

const alive = defineTool({
  method: 'GET',
  path: '/adv/sessions/alive',
  auth: 'public',
  async handler(req) {
    const pidStr = new URL(req.url).searchParams.get('pid');
    const pid = pidStr ? Number(pidStr) : NaN;
    if (!Number.isFinite(pid) || pid <= 0) {
      return new Response(JSON.stringify({ alive: false }), { status: 200, headers: JSON_HEADERS });
    }
    let live = false;
    try {
      // process.kill(pid, 0) throws if the pid is gone; succeeds (and
      // sends no signal) if alive + we have permission.
      process.kill(pid, 0);
      live = true;
    } catch { live = false; }
    return new Response(JSON.stringify({ alive: live }), { status: 200, headers: JSON_HEADERS });
  },
});

const state = defineTool({
  method: 'GET',
  path: '/adv/sessions/state',
  auth: 'public',
  async handler(req) {
    const resolved = await resolveOmpSessionForRequest(req);
    const sessionState =
      resolved.sessionId || resolved.filePath
        ? getOmpSessionState({ id: resolved.sessionId ?? undefined, filePath: resolved.filePath ?? undefined })
        : null;
    const memory = await readOmpMemoryConfig();
    return new Response(
      JSON.stringify({
        ok: sessionState !== null,
        advSession: resolved.advSession,
        match: resolved.match,
        state: sessionState,
        memory,
        error: sessionState ? null : 'omp_session_not_found',
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

const search = defineTool({
  method: 'GET',
  path: '/adv/sessions/search',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const query = url.searchParams.get('q')?.trim() ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!query) {
      return new Response(
        JSON.stringify({ ok: true, query, matches: [], truncated: false, searchedSessions: 0 }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    const resolved = await resolveOmpSessionForRequest(req);
    const scoped = requestHasExplicitSessionScope(url);
    if (scoped && !resolved.sessionId && !resolved.filePath) {
      return new Response(
        JSON.stringify({
          ok: false,
          query,
          matches: [],
          truncated: false,
          searchedSessions: 0,
          advSession: resolved.advSession,
          match: resolved.match,
          error: 'omp_session_not_found',
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    const result = searchOmpSessions({
      query,
      sessionId: resolved.sessionId ?? undefined,
      filePath: resolved.filePath ?? undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
      context: 1,
    });
    return new Response(
      JSON.stringify({ ok: true, advSession: resolved.advSession, match: resolved.match, ...result }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

/**
 * GET /api/adv/sessions/ended — the paged "inactive sessions" feed for the
 * agents-running popover (agents-pill-inactive-search-2026-07-09 P-001).
 * ended_at DESC with a keyset cursor: `?before=<iso>` returns rows that ended
 * strictly before it; the response's `nextBefore` is the cursor for the next
 * page (null ⇒ no more). `limit+1` probe ⇒ `hasMore` without a COUNT.
 * Workspace-scoped via `?workspace=<id>`; omit or `all` for every workspace.
 */
const ended = defineTool({
  method: 'GET',
  path: '/adv/sessions/ended',
  // Consistent with the sibling /adv/* UI content routes: the operator binds
  // loopback-only and the desktop webview has no principal/bearer path.
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const wsParam = url.searchParams.get('workspace');
    const workspaceId = wsParam && wsParam !== 'all' ? wsParam : null;
    const before = url.searchParams.get('before')?.trim() || null;
    if (before && Number.isNaN(Date.parse(before))) {
      return new Response(
        JSON.stringify({ ok: false, error: 'invalid_before_cursor' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }
    const limitRaw = Number(url.searchParams.get('limit') ?? 30);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 30));
    const rows = await listEndedAdvSessions({ workspaceId, before, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const nextBefore = hasMore && page.length > 0 ? page[page.length - 1].endedAt : null;
    return new Response(
      JSON.stringify({ ok: true, sessions: page, hasMore, nextBefore }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

/**
 * GET /api/adv/sessions/search-transcripts — the agents-pill "search ANYTHING
 * in the sessions" endpoint (agents-pill-inactive-search-2026-07-09 P-002).
 *
 * Runs the SHARED search engine — `runHybridSearch` over the `session_turn`
 * source of the @papercusp/search SEARCH_SOURCES registry, the exact engine +
 * corpus the `sessions:search` agent tool and /api/user/search use (BM25 +
 * embeddings via the buildQueryEmbedder cascade; degrades to BM25-only when no
 * embedder is available). Turn-level hits are rolled up per SESSION and
 * classified against the live roster (active → the popover groups by fleet)
 * and adv_sessions rows (inactive metadata + open handles); ts_headline
 * `<mark>` highlights ride through for the UI.
 *
 * SECURITY (auth: 'loopback'): hits carry transcript excerpts — the same
 * sensitivity as /adv/session/thinking (full agent reasoning can hold file
 * contents + secrets), so the same loopback gate applies.
 */
const searchTranscripts = defineTool({
  method: 'GET',
  path: '/adv/sessions/search-transcripts',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 500);
    if (!q) {
      return new Response(
        JSON.stringify({ ok: true, query: '', sessions: [] }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    const limitRaw = Number(url.searchParams.get('limit') ?? 30);
    const hitLimit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 30));

    const [{ runHybridSearch }, { SEARCH_SOURCES }, { buildQueryEmbedder }, { parseTurnRef }, { activeWorkspaceId }, { getOrgPg }] =
      await Promise.all([
        import('@papercusp/search'),
        import('../../../agent-tools/search/sources'),
        import('../../../agent-tools/search/embedder'),
        import('../../../agent-tools/sessions/_shared'),
        import('../../../workspace-registry'),
        import('@papercusp/db-org'),
      ]);
    const { groupHitsBySession, classifySessionGroups } = await import('../../../adv-session-search');
    const { advSessionsByTranscriptHandles } = await import('../../../adv-sessions');

    const sources = SEARCH_SOURCES.filter((s) => s.name === 'session_turn');
    const embedder = await buildQueryEmbedder();
    const { sql } = getOrgPg();
    const { results } = await runHybridSearch(sources, {
      sql,
      query: q,
      workspaceId: activeWorkspaceId(),
      scopeFilter: null,
      limit: hitLimit,
      mode: 'hybrid',
      embedder,
    });

    // Engine hits → turn refs (source_id = `<sourceKind>:<sessionId>:<turnIdx>`).
    const turnHits: Array<{
      sourceKind: string; sessionId: string; turnIdx: number;
      excerpt: string; highlight: string; score: number;
      ts?: string | null; speaker?: string | null; owner?: string | null;
    }> = [];
    for (const r of results) {
      const ref = parseTurnRef(r.source_id);
      if (!ref) continue;
      turnHits.push({
        sourceKind: ref.sourceKind,
        sessionId: ref.sessionId,
        turnIdx: ref.turnIdx,
        excerpt: r.excerpt,
        highlight: r.highlight,
        score: r.score,
      });
    }

    // Hydrate per-turn metadata (ts/speaker/owner) — ts anchors the deep-link
    // into the transcript viewer; owner matches claude isolation transcripts to
    // their roster agent. One batched unnest join, never per-hit queries.
    if (turnHits.length > 0) {
      try {
        const kinds = turnHits.map((h) => h.sourceKind);
        const sids = turnHits.map((h) => h.sessionId);
        const idxs = turnHits.map((h) => h.turnIdx);
        const metaRows = await sql<
          Array<{ source_kind: string; session_id: string; turn_idx: number; ts: string | null; speaker: string | null; owner: string | null }>
        >`
          SELECT st.source_kind, st.session_id, st.turn_idx, st.ts::text AS ts, st.speaker, st.owner
            FROM harness_shared.session_turns st
            JOIN unnest(${kinds}::text[], ${sids}::text[], ${idxs}::int[]) AS t(k, s, i)
              ON st.source_kind = t.k AND st.session_id = t.s AND st.turn_idx = t.i
        `;
        const metaByKey = new Map(metaRows.map((m) => [`${m.source_kind}:${m.session_id}:${m.turn_idx}`, m]));
        for (const h of turnHits) {
          const m = metaByKey.get(`${h.sourceKind}:${h.sessionId}:${h.turnIdx}`);
          if (m) { h.ts = m.ts; h.speaker = m.speaker; h.owner = m.owner; }
        }
      } catch { /* metadata is a bonus — never fail the search */ }
    }

    const groups = groupHitsBySession(turnHits);
    const [{ active }, sessionRows] = await Promise.all([
      mergeRosterWithAssignments({ workspaceId: null }),
      advSessionsByTranscriptHandles({
        sessionIds: groups.filter((g) => g.sourceKind === 'claude').map((g) => g.sessionId),
        ompThreadIds: groups.filter((g) => g.sourceKind === 'omp').map((g) => g.sessionId),
      }),
    ]);
    const sessions = classifySessionGroups(groups, active, sessionRows);
    return new Response(
      JSON.stringify({ ok: true, query: q, totalHits: turnHits.length, sessions }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

/**
 * GET /api/adv/sessions/resumable — recent psu-tracked sessions (agent +
 * cwd present), cross-workspace, most-recent first. Feeds the
 * `psu --resume` picker, which `cd`s to each row's cwd and resumes the
 * agent there.
 */
const resumable = defineTool({
  method: 'GET',
  path: '/adv/sessions/resumable',
  auth: 'public',
  async handler(req) {
    const limit = Number(new URL(req.url).searchParams.get('limit') ?? 30);
    const sessions = await listResumableSessions(Number.isFinite(limit) && limit > 0 ? limit : 30);
    return new Response(JSON.stringify({ sessions }), { status: 200, headers: JSON_HEADERS });
  },
});

/**
 * GET /api/adv/roster — the live "who's active, on what" roster (plan
 * adv-sessions-live-roster, P-003). coord_presence is the primary source (every
 * active psu agent heartbeats per tool call), LEFT-joined to adv_sessions on
 * coord_owner_id for plan/role/feature + Focus/Resume handles. Returns:
 *   - active: RosterEntry[]  (presence-primary, liveness from heartbeat)
 *   - ended:  AdvSessionRow[] (recently-ended terminals not already live above)
 * Workspace-scoped via `?workspace=<id>`; omit or `all` for every workspace.
 * Non-breaking: leaves GET /adv/sessions intact until the UI rewires (P-005).
 */
const roster = defineTool({
  method: 'GET',
  path: '/adv/roster',
  // auth:'public' is deliberate + consistent with the 6 sibling /adv routes and
  // the whole /coord/* surface: the operator binds loopback-only (127.0.0.1) and
  // the desktop webview has no principal/bearer path to these UI content routes.
  // The data is already public via GET /coord/presence (the presence half) and
  // GET /adv/sessions (the session half), and is single-user (no tenant boundary
  // to IDOR; ?workspace= only selects among the one owner's own workspaces).
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const wsParam = url.searchParams.get('workspace');
    const workspaceId = !wsParam || wsParam === 'all' ? null : wsParam;
    const endedLimitRaw = Number(url.searchParams.get('endedLimit') ?? 50);
    const endedLimit = Number.isFinite(endedLimitRaw) && endedLimitRaw > 0 ? endedLimitRaw : 50;

    const [{ active, orphanedClaims }, endedAll, pendingRows] = await Promise.all([
      mergeRosterWithAssignments({ workspaceId }),
      listEndedAdvSessions({ workspaceId, limit: endedLimit }),
      listPendingWorkbenchLaunches({ workspaceId }),
    ]);
    const ended = dedupeEndedAgainstActive(endedAll, active);
    // Pending workbench launches (pui-reactive-session-panes D-006): recorded but
    // not-yet-running sessions the pui reactively opens a pane for. Synthesized as
    // RosterEntry-shaped rows (liveness 'pending', local host) in a SEPARATE tier
    // so the human roster (`active`) is untouched; only the pui consumes `pending`.
    const pending = pendingLaunchesToRosterEntries(pendingRows, os.hostname());

    // Each active entry carries `claims` from the canonical fleet_assignment
    // view; `orphanedClaims` is the claim-keyed remainder — active claims whose
    // holder is absent/stale from the roster (state-not-chat-fleet-state D-002).
    return new Response(JSON.stringify({ active, ended, orphanedClaims, pending }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

/**
 * POST /api/adv/sessions/mark-launched — the pui consumed a pending workbench
 * launch by opening its pane (pui-reactive-session-panes D-006). Stamps
 * launched_at so the row drops out of the `pending` roster tier (idempotent —
 * a roster-refresh race can't double-consume). Body: `{ id: number }`.
 */
const markLaunched = defineTool({
  method: 'POST',
  path: '/adv/sessions/mark-launched',
  auth: 'loopback',
  async handler(req) {
    let body: { id?: number } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore — validated below */ }
    const id = typeof body.id === 'number' ? body.id : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      return new Response(JSON.stringify({ status: 'error', error: 'id required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const stamped = await markAdvSessionLaunched(id);
    return new Response(JSON.stringify({ status: 'ok', stamped }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

/**
 * GET /api/adv/roster/agent?owner=<ownerId> — the lazy Tier-3 dossier for ONE
 * agent (plan adv-sessions-live-roster, P-009). Joins across stores that the
 * cheap roster query deliberately skips: SU file-locks (held + waiting, with
 * blockers) and coord state (last message, unread, open handoffs/escalations).
 * Fetched on demand when a detail pane opens, keyed by coord owner id.
 */
const agentDetail = defineTool({
  method: 'GET',
  path: '/adv/roster/agent',
  auth: 'public',
  async handler(req) {
    const owner = new URL(req.url).searchParams.get('owner')?.trim() ?? '';
    if (!owner) {
      return new Response(JSON.stringify({ error: 'owner_required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    // Lazy import: the dossier joins the heavy locks + coord graph, but it's
    // hit only when a detail pane opens. Keeping it out of the route module's
    // top-level import keeps registration (and the roster route) light.
    const { getAgentDetail } = await import('../../../adv-agent-detail');
    const detail = await getAgentDetail(owner);
    return new Response(JSON.stringify(detail), { status: 200, headers: JSON_HEADERS });
  },
});

/**
 * POST /api/adv/on-desktop-windows — the Session-1 Tauri renderer pushes the
 * native desktop window list here (WI-1675, D-002 part 2). On Windows the
 * operator runs inside the WSL2 distro (Session 0) and CANNOT enumerate the
 * interactive desktop, so the renderer invokes the `list_windows_by_title` Rust
 * command on a timer and POSTs the result; this seeds the in-process cache that
 * windows-desktop-windows.ts's listWindowsByTitle — and thus the reaper's
 * on-desktop exemption (gatherOnDesktopSessions) — reads. Body:
 * `{ windows: { title: string; pid: number; hwnd: string }[] }`. Coerces
 * defensively (never trust a POST body) and is a no-op-safe [] push.
 */
const onDesktopWindows = defineTool({
  method: 'POST',
  path: '/adv/on-desktop-windows',
  auth: 'loopback',
  async handler(req) {
    let body: { windows?: unknown } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore — validated below */ }
    const raw = Array.isArray(body.windows) ? body.windows : null;
    if (!raw) {
      return new Response(JSON.stringify({ status: 'error', error: 'windows[] required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const windows: WindowsDesktopWindow[] = [];
    for (const w of raw) {
      if (!w || typeof w !== 'object') continue;
      const { title, pid, hwnd } = w as { title?: unknown; pid?: unknown; hwnd?: unknown };
      if (typeof title === 'string' && typeof pid === 'number' && typeof hwnd === 'string') {
        windows.push({ title, pid, hwnd });
      }
    }
    setOnDesktopWindowsCache(windows);
    return new Response(JSON.stringify({ status: 'ok', count: windows.length }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

export default [list, focus, alive, state, search, ended, searchTranscripts, resumable, roster, markLaunched, agentDetail, onDesktopWindows];
