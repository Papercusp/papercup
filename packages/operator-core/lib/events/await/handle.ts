/**
 * Wake-handle capture (await-event-primitive-2026-06-05 D-003) — shared by
 * every verb that registers a wake await (events:await, locks:acquire's
 * wake_on_grant, future precondition waits).
 *
 * The caller's coord ownerId joins adv_sessions.coord_owner_id (latest row);
 * the stamped handle is what the wake executor re-reads at fire time. The
 * human-readable note tells the registering agent — honestly, up front —
 * how good its wake path is (injectable/resumable vs inbox-degraded).
 */

import { latestAdvSessionByCoordOwner } from '../../adv-sessions';
import type { WakeHandle } from './types';

export interface CapturedHandle {
  handle: WakeHandle | null;
  /** One line describing the wake path quality — surface it in the tool result. */
  note: string;
}

export async function captureWakeHandleForOwner(
  ownerId: string,
  opts: { planRunId?: number } = {},
): Promise<CapturedHandle> {
  if (opts.planRunId) {
    return {
      handle: { kind: 'plan-run', runId: opts.planRunId },
      note: `plan-run ${opts.planRunId} — woken via the plans:resume path`,
    };
  }
  const session = await latestAdvSessionByCoordOwner(ownerId);
  if (!session) {
    return {
      handle: null,
      note: 'no tracked session for your coord id — the wake degrades to an inbox notification (delivered mid-turn if you are active, on your next turn otherwise)',
    };
  }
  const handle: WakeHandle = {
    kind: 'adv-session',
    advSessionId: session.id,
    agent: session.agent,
    sessionId: session.sessionId,
    ompThreadId: session.ompThreadId,
    cwd: session.cwd,
    pid: session.pid,
  };
  // Which clients the wake executor can re-invoke after the process exits:
  //   - claude  → `--resume <nativeUUID>` (needs the native session id; D-003);
  //   - omp     → `-r <threadId>`;
  //   - codex   → `exec resume <uuid>` (the executor recovers the conversation
  //               UUID from the per-session CODEX_HOME rollout, so a row whose
  //               sessionId is already stamped is resumable too — codex was
  //               wrongly excluded here and a tracked codex session got the
  //               "NOT safely resumable" note despite executeWake resuming it).
  const resumable =
    (session.agent === 'claude' && session.sessionId) ||
    (session.agent === 'omp' && session.ompThreadId) ||
    (session.agent === 'codex' && session.sessionId);
  return {
    handle,
    note: resumable
      ? `session #${session.id} (${session.agent}) — injectable/resumable`
      : `session #${session.id} (${session.agent ?? 'unknown client'}) — NOT safely resumable (no native session id); you will get an inbox nudge while alive, and the wake degrades to notify if your process exits`,
  };
}
