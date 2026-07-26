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
import { z } from 'zod';
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

const CHOICE_IDS = ['resume', 'fork', 'focus'] as const;
type Choice = (typeof CHOICE_IDS)[number];

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

registerChatAction({
  id: 'session-actions',
  label: 'Session',
  group: 'session',
  available: (ctx) => {
    const c = ctx as SessionActionCtx;
    return Boolean(c.sessionOwnerId) && (resumableSessionId(c) !== null || canFocusWindow(c));
  },
  params: async (ctx) => {
    const c = ctx as SessionActionCtx;
    const resumable = resumableSessionId(c) !== null;
    const forkable = resumable && canForkSession(c);
    const focusable = canFocusWindow(c);
    const options: { id: Choice; label: string; hint: string }[] = [];
    if (resumable) {
      options.push({
        id: 'resume',
        label: 'Resume in new terminal',
        hint: '`-r <id>` — resumes the transcript in place; opens a second CLI if the source is still live',
      });
    }
    if (forkable) {
      options.push({
        id: 'fork',
        label: 'Fork in new terminal',
        hint: '`-r <id> --fork-session` — branches a fresh session; the source (if live) keeps running untouched',
      });
    }
    if (focusable) {
      options.push({ id: 'focus', label: 'Focus window', hint: "Raise this agent's terminal window" });
    }
    return {
      prompt: 'Session action',
      dataSchema: z.object({ picks: z.tuple([z.enum(CHOICE_IDS)]) }),
      presentation: { kind: 'radio', options },
      allowDecline: true,
    };
  },
  run: async (ctx, value) => {
    const c = ctx as SessionActionCtx;
    const [choice] = (value as { picks: [Choice] }).picks;
    if (choice === 'resume') return launchInNewTerminal(c, false);
    if (choice === 'fork') return launchInNewTerminal(c, true);
    return focusWindow(c);
  },
});
