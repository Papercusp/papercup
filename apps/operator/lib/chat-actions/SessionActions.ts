/**
 * Session actions — resume / fork / focus, as ONE ChatAction whose available
 * choices are computed live from the session's roster/session-resolve data
 * (gui-chat-session-controls-2026-07-25 P-006).
 *
 * The availability rules are LIFTED verbatim from
 * apps/operator-vite/src/components/adv/AgentsRunningPill.tsx
 * (`resumableSessionId`, `canForkSession`, `canFocusWindow`) — that app is a
 * separate bundle from apps/operator (this one), so the three pure
 * predicates are reproduced here rather than imported cross-app. Keep them in
 * sync if the source rules change:
 *   - resume/fork need a session id: codex is EXCLUDED (its rollout-resume is
 *     a different mechanism than `<cli> -r <id>`; passing its id would
 *     silently fail) — claude's `sessionId` or an omp `ompThreadId`.
 *   - fork (`--fork-session`) is claude-ONLY; omp has no fork command.
 *   - focus needs either a stored X11 `windowId` OR an `advSessionId` (the
 *     /adv/sessions/focus endpoint resolves the window from the adv row /
 *     its `[adv:<id>]` title fragment when windowId wasn't pre-resolved) —
 *     pid alone is never enough (every gnome-terminal shares one server pid).
 *
 * Both writes POST as text/plain, not application/json — the same CORS
 * workaround as AgentsRunningPill/AgentInspectorModal: application/json is
 * not a "simple request", so it triggers a preflight OPTIONS that the
 * desktop webkit2gtk build fails silently (WI-3988/WI-3989). The routes
 * parse the raw body as JSON regardless of content-type.
 */
import { registerChatAction } from './registry';
import type { ChatActionContext } from './types';

/** Extra ctx fields this action reads — supplied by SessionChatModal from the
 *  SAME advRoster.list entry (P-012) + the resolved Claude session id it
 *  already fetches. All optional: an action whose ctx lacks them is simply
 *  unavailable (`available` returns false), never a crash. */
export interface SessionActionCtx extends ChatActionContext {
  /** 'claude' | 'codex' | 'omp' | null — drives the fork/resume exclusions. */
  agent?: string | null;
  /** The resolved Claude transcript session id, when one was found. */
  sessionId?: string | null;
  /** An omp thread id, when this session is an omp backend. */
  ompThreadId?: string | null;
  /** adv_sessions row id — lets /adv/sessions/focus resolve the window even
   *  before windowId is pre-resolved. */
  advSessionId?: number | null;
  /** Direct X11 window handle, when already resolved. */
  windowId?: string | null;
  pid?: number | null;
}

/** The session id to fork/resume into a new terminal. null ⇒ neither action
 *  offered. Exported for tests. */
export function resumableSessionId(ctx: SessionActionCtx): string | null {
  if (ctx.agent === 'codex') return null;
  return ctx.sessionId ?? ctx.ompThreadId ?? null;
}

/** Whether this session can be FORKED (`--fork-session`, claude-only).
 *  Exported for tests. */
export function canForkSession(ctx: SessionActionCtx): boolean {
  return ctx.agent === 'claude';
}

/** Whether this session's terminal window can be focused. Exported for tests. */
export function canFocusWindow(ctx: SessionActionCtx): boolean {
  return Boolean(ctx.windowId) || ctx.advSessionId != null;
}

const postText = (url: string, payload: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(payload) });

/** POST the resume/fork launch. Exported for tests. */
export async function launchInNewTerminal(ctx: SessionActionCtx, fork: boolean): Promise<void> {
  const sessionId = resumableSessionId(ctx);
  if (!sessionId) throw new Error('no resumable session id');
  const label = ctx.ownerLabel ?? ctx.sessionOwnerId;
  const res = await postText('/api/agent-mcp/console/launch', {
    resumeSessionId: sessionId,
    fork,
    label: `${fork ? 'fork' : 'resume'} · ${label}`,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.status !== 'ok') {
    throw new Error(`${fork ? 'fork' : 'resume'} failed: ${data?.error ?? `HTTP ${res.status}`}`);
  }
}

/** POST the focus-window request. Exported for tests. */
export async function focusWindow(ctx: SessionActionCtx): Promise<void> {
  if (!canFocusWindow(ctx)) throw new Error('no focusable window');
  const res = await postText('/api/adv/sessions/focus', {
    id: ctx.advSessionId ?? undefined,
    windowId: ctx.windowId ?? undefined,
    pid: ctx.pid ?? undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`focus failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
  }
}

/** Stop the attached owner through the audited fleet:kill primitive. The
 * desktop webview cannot attach an agent bearer, so this uses the same
 * loopback-only admin proxy as the rest of the HUD's owner-scoped writes. */
export async function stopAgent(ctx: SessionActionCtx): Promise<void> {
  if (!ctx.sessionOwnerId) throw new Error('no session owner id');
  const res = await postText('/api/admin/coordination/fleet/kill', {
    owner: ctx.sessionOwnerId,
    close_terminal: true,
    reason: 'Stopped by the owner from the session pane.',
  });
  const data = await res.json().catch(() => null) as {
    data?: { results?: Array<{ ok?: boolean; error?: string }> };
    results?: Array<{ ok?: boolean; error?: string }>;
    error?: string;
  } | null;
  const result = data?.data?.results?.[0] ?? data?.results?.[0];
  if (!res.ok || !result?.ok) {
    throw new Error(`stop failed: ${result?.error ?? data?.error ?? `HTTP ${res.status}`}`);
  }
}

/**
 * THREE DIRECT BUTTONS, not one collapsed picker
 * (gui-chat-session-controls-2026-07-25 P-015, owner ask 2026-07-27:
 * "add the same resume/fork/focus buttons to the chat popup, the same ones
 * that show up in the turn history in the agents running dropdown").
 *
 * P-006 originally shipped these as a SINGLE `session-actions` entry whose
 * `params` opened a radio card — so reaching Fork cost click → card → pick →
 * confirm, and the three buttons the owner was looking for never appeared as
 * buttons at all. AgentInspectorModal (the agents-running dropdown this is
 * meant to mirror) renders them as three INDEPENDENT one-click buttons, each
 * gated by its own predicate. These three registrations restore that parity.
 *
 * Each declares NO `params`: per ChatAction.params' contract, an action
 * without it goes straight from click to `run`, which is the one-click
 * behaviour being matched. The availability predicates are unchanged and
 * still the single source of truth — each button simply consumes the ONE
 * predicate that governs it, instead of all three being OR-ed behind a single
 * entry (which is what let a session with, say, only a focusable window still
 * advertise a generic "Session" button).
 *
 * Icons/labels mirror AgentInspectorModal's verbatim (↻ / ⑂) so the two
 * surfaces read as the same control, per the owner's "the same ones".
 */
registerChatAction({
  id: 'session-resume',
  label: 'Resume in new terminal',
  shortLabel: 'Resume',
  icon: '↻',
  group: 'session',
  available: (ctx) => {
    const c = ctx as SessionActionCtx;
    return Boolean(c.sessionOwnerId) && resumableSessionId(c) !== null;
  },
  run: async (ctx) => launchInNewTerminal(ctx as SessionActionCtx, false),
});

registerChatAction({
  id: 'session-fork',
  label: 'Fork in new terminal',
  shortLabel: 'Fork',
  icon: '⑂',
  group: 'session',
  available: (ctx) => {
    const c = ctx as SessionActionCtx;
    // Fork needs BOTH a resumable id and a claude backend — `--fork-session`
    // is claude-only, so a forkable-but-unresumable session cannot exist.
    return Boolean(c.sessionOwnerId) && resumableSessionId(c) !== null && canForkSession(c);
  },
  run: async (ctx) => launchInNewTerminal(ctx as SessionActionCtx, true),
});

registerChatAction({
  id: 'session-focus',
  label: 'Focus window',
  group: 'session',
  available: (ctx) => {
    const c = ctx as SessionActionCtx;
    return Boolean(c.sessionOwnerId) && canFocusWindow(c);
  },
  run: async (ctx) => focusWindow(ctx as SessionActionCtx),
});

registerChatAction({
  id: 'session-stop',
  label: 'Stop agent',
  shortLabel: 'Stop',
  icon: '■',
  group: 'session',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  confirm: (ctx) => ({
    message: `Stop ${ctx.ownerLabel ?? ctx.sessionOwnerId}? This ends the agent and closes its terminal when one exists.`,
    confirmLabel: 'Stop agent',
  }),
  run: async (ctx) => stopAgent(ctx as SessionActionCtx),
});
