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

import { defineTool } from '@papercusp/agent-mcp';
import {
  focusWindowId,
  getAdvSession,
  listAdvSessions,
  resolveWindowIdForPid,
  setAdvSessionOmpThreadId,
} from '@/lib/adv-sessions';
import { readOmpConfig } from '@/lib/omp-config';
import {
  findOmpSessionNear,
  getOmpSessionState,
  searchOmpSessions,
} from '@/lib/omp-sessions';

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
    return new Response(JSON.stringify({ rows }), { status: 200, headers: JSON_HEADERS });
  },
});

const focus = defineTool({
  method: 'POST',
  path: '/adv/sessions/focus',
  auth: 'public',
  async handler(req) {
    let body: { pid?: number; windowId?: string | null } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore */ }

    let wid = body.windowId ?? null;
    if (!wid && typeof body.pid === 'number') {
      wid = await resolveWindowIdForPid(body.pid);
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

export default [list, focus, alive, state, search];
