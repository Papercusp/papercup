/**
 * Wake executor — the liveness-adaptive re-invoke ladder
 * (await-event-primitive-2026-06-05 D-003/D-009).
 *
 * Given one due wake delivery + its await's stamped handle, pick the channel:
 *
 *   1. live managed pty (pid-matched in pty-bridge) → INJECT a wake turn.
 *   2. process exited → RESUME the session under a fresh managed pty
 *      (`spawnPty`), per-client resume args; the resumed session is then
 *      observable in /adv AND itself injectable for the next wake. claude
 *      falls back to a detached headless `-p` turn when the pty cap is hit.
 *   3. process alive but uninjectable (a detached terminal emulator — the
 *      common psu case; console-launch spawns gnome-terminal etc., we don't
 *      own its stdin) → PARK + a one-time inbox nudge; the pump re-checks and
 *      converts to a resume when the pid dies. Never inject keystrokes into a
 *      terminal we don't own (focus/ownership rules).
 *   4. nothing live + nothing resumable → DROP, visibly (D-004 net #2).
 *
 * Identity survives the resume: PAPERCUSP_SID is re-exported so the woken
 * session keeps its coord identity, lock hooks, and (crucially) its OWN
 * await registrations.
 *
 * claude resume REQUIRES the native session UUID — `--continue` resumes
 * most-recent-in-cwd, and on the shared papercup tree (one cwd for the whole
 * fleet) that would resume a RANDOM PEER's conversation. Without the UUID we
 * degrade to the inbox, visibly.
 */

import { spawn as childSpawn } from 'node:child_process';
import { getAdvSession } from '../../adv-sessions';
import { findPtyByPid, spawnPty, writePty, PtyError } from '../../pty-bridge';
import { getPresence } from '../../agent-tools/coordination/presence';
import type { DeliveryWork, WakeOutcome } from './types';

/** Compose the single-line wake turn injected/submitted into the woken session. */
export function wakeTurnText(d: DeliveryWork): string {
  const note = d.note ? ` (your note: ${d.note})` : '';
  const summary = d.summary ? ` — ${d.summary}` : '';
  const payload =
    d.payload != null ? ` payload: ${JSON.stringify(d.payload).slice(0, 400)}` : '';
  const timeout = (d.payload as { timeout?: boolean } | null)?.timeout
    ? ' [TIMEOUT — the event did NOT fire before your deadline]'
    : '';
  return (
    `[await-event] ${d.eventKey} fired${timeout}${summary}.${note}${payload} ` +
    `(wake #${d.id}; you registered this with events:await — continue the work that was waiting on it.)`
  ).replace(/\s*\n\s*/g, ' ');
}

function pidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Per-client resume invocation (mirrors psu-launcher resumeArgsFor, headless-
 *  capable). Returns null when the session is not safely resumable. */
export function resumeCommandFor(handle: {
  agent: string | null;
  sessionId: string | null;
  ompThreadId: string | null;
}, wakeText: string): { bin: string; args: string[]; promptViaPty: boolean } | null {
  if (handle.agent === 'claude') {
    // Exact-session resume only (see header). Prompt rides as the positional
    // arg — claude submits it as the first user message of the resumed turn.
    if (!handle.sessionId) return null;
    return {
      bin: 'claude',
      args: [
        '--resume', handle.sessionId,
        '--dangerously-skip-permissions',
        '--permission-mode', 'bypassPermissions',
        wakeText,
      ],
      promptViaPty: false,
    };
  }
  if (handle.agent === 'omp') {
    if (!handle.ompThreadId) return null;
    // omp takes no positional prompt on resume — inject it into the pty once
    // the TUI is up (promptViaPty).
    return {
      bin: 'omp',
      args: ['-r', handle.ompThreadId, '--approval-mode', 'yolo'],
      promptViaPty: true,
    };
  }
  if (handle.agent === 'codex') {
    // codex resume needs the per-session CODEX_HOME bootstrap-su minted at
    // launch; re-deriving it here is not yet wired (P-004 deferral, visible
    // in the delivery row) — degrade to park/inbox.
    return null;
  }
  return null;
}

/** How long an omp resume gets before we inject the prompt into its pty. */
const PTY_PROMPT_DELAY_MS = 2_500;

export interface ExecuteWakeDeps {
  /** Injected for tests; default real implementations below. */
  getSession?: typeof getAdvSession;
  findPty?: typeof findPtyByPid;
  write?: typeof writePty;
  spawnManagedPty?: typeof spawnPty;
  spawnDetached?: (bin: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => number | null;
  presence?: typeof getPresence;
  alive?: (pid: number | null) => boolean;
  resumePlanRun?: (input: { runId: number; wakeText: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Execute one wake delivery attempt. Never throws — every failure is an outcome. */
export async function executeWake(d: DeliveryWork, deps: ExecuteWakeDeps = {}): Promise<WakeOutcome> {
  const getSession = deps.getSession ?? getAdvSession;
  const findPty = deps.findPty ?? findPtyByPid;
  const write = deps.write ?? writePty;
  const spawnManaged = deps.spawnManagedPty ?? spawnPty;
  const presence = deps.presence ?? getPresence;
  const alive = deps.alive ?? pidAlive;

  try {
    const handle = d.wakeHandle;
    if (!handle) {
      // Registered without a resumable session (warned at registration).
      // Presence fresh → the inbox nudge will reach it; gone → drop visibly.
      const p = await presence(d.subscriberId).catch(() => null);
      if (p && !p.stale && !p.revoked) return { kind: 'park', reason: 'no wake handle; presence live — inbox only' };
      return { kind: 'drop', reason: 'no wake handle and presence gone/stale — dead waiter' };
    }

    if (handle.kind === 'plan-run') {
      // Woken via the plans:resume path — fire the continuation turn with the
      // wake reason as the prompt. Lazy import keeps the engine free of a
      // static plans-tool dependency.
      const resumePlanRun =
        deps.resumePlanRun ?? (await import('./plan-run-wake')).resumePlanRunForWake;
      const r = await resumePlanRun({ runId: handle.runId, wakeText: wakeTurnText(d) });
      if (r.ok) return { kind: 'delivered', channel: 'plan-run-resume' };
      return { kind: 'error', error: r.error };
    }

    // ── adv-session handle ───────────────────────────────────────────────
    const fresh = await getSession(handle.advSessionId).catch(() => null);
    const pid = fresh?.pid ?? handle.pid;
    const ended = fresh?.endedAt != null;
    const isAlive = !ended && alive(pid);

    const text = wakeTurnText(d);

    if (isAlive && pid) {
      // Channel 1: one of our managed ptys? (pid match — /adv-spawned sessions)
      const pty = findPty(pid);
      if (pty) {
        const okWrite = write(pty.id, Buffer.from(`${text}\r`, 'utf8'));
        if (okWrite) return { kind: 'delivered', channel: 'pty-inject' };
      }
      // Channel 3: alive in a terminal we don't own — park (+ inbox nudge by pump).
      return { kind: 'park', reason: `session pid ${pid} alive but not an injectable managed pty` };
    }

    // Channel 2: process gone → resume.
    const resume = resumeCommandFor(
      {
        agent: fresh?.agent ?? handle.agent,
        sessionId: fresh?.sessionId ?? handle.sessionId,
        ompThreadId: fresh?.ompThreadId ?? handle.ompThreadId,
      },
      text,
    );
    const cwd = fresh?.cwd ?? handle.cwd;
    if (!resume || !cwd) {
      const p = await presence(d.subscriberId).catch(() => null);
      if (p && !p.stale && !p.revoked) {
        return { kind: 'park', reason: 'session ended but not safely resumable (no native session id / unsupported client) — inbox only' };
      }
      return { kind: 'drop', reason: 'session ended, not resumable, presence gone — dead waiter' };
    }

    const env: Record<string, string> = {
      PAPERCUSP_SID: d.subscriberId,
      PAPERCUSP_WAKE_DELIVERY_ID: String(d.id),
    };

    try {
      const h = spawnManaged({
        command: resume.bin,
        args: resume.args,
        cwd,
        env,
        cols: 120,
        rows: 36,
      });
      if (resume.promptViaPty) {
        const ptyId = h.id;
        setTimeout(() => {
          try {
            write(ptyId, Buffer.from(`${text}\r`, 'utf8'));
          } catch {
            /* the resumed session still surfaces the inbox copy */
          }
        }, PTY_PROMPT_DELAY_MS).unref?.();
      }
      return { kind: 'delivered', channel: 'resume' };
    } catch (err) {
      if (err instanceof PtyError && err.code === 'PTY_CAP_REACHED' && resume.bin === 'claude' && !resume.promptViaPty) {
        // Headless fallback: a bounded one-turn `-p` run, fully detached.
        const spawnDetached =
          deps.spawnDetached ??
          ((bin: string, args: string[], o: { cwd: string; env: Record<string, string> }) => {
            const child = childSpawn(bin, args, {
              cwd: o.cwd,
              env: { ...process.env, ...o.env },
              detached: true,
              stdio: 'ignore',
            });
            child.unref();
            return child.pid ?? null;
          });
        const headlessArgs = ['-p', ...resume.args];
        const pid2 = spawnDetached(resume.bin, headlessArgs, { cwd, env });
        if (pid2) return { kind: 'delivered', channel: 'resume-headless' };
        return { kind: 'error', error: 'headless resume spawn failed' };
      }
      return { kind: 'error', error: `resume spawn failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
