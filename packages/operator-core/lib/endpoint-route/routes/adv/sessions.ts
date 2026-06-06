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
  auth: 'public',
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
  auth: 'public',
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

export default [list, focus, alive, state, search, resumable, roster, markLaunched, agentDetail];
