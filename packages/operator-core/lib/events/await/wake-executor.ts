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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAdvSession } from '../../adv-sessions';
import { findPtyByPid, spawnPty, writePty } from '../../pty-bridge';
import { getPresence } from '../../agent-tools/coordination/presence';
import type { DeliveryWork, WakeOutcome } from './types';

/** A codex rollout filename ends `…-<uuid>.jsonl`; the trailing UUID is the
 *  conversation id `codex exec resume <uuid>` wants. */
const CODEX_ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Recover a codex session's conversation UUID from its per-session CODEX_HOME —
 * the newest `<home>/sessions/**​/rollout-*-<uuid>.jsonl` (turn-lifecycle-control
 * P-009). codex doesn't take a forced `--session-id`, so tracked rows carry no
 * native id; recovering it lets a wake `resume <uuid> <prompt>` resolve EXACTLY
 * this session with two positionals — avoiding the `resume --last <prompt>`
 * clap ambiguity where the prompt would be read as the session id. null if none.
 */
export function findCodexRolloutSessionId(codexHome: string): string | null {
  let best: { id: string; mtime: number } | null = null;
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const m = e.name.match(CODEX_ROLLOUT_UUID_RE);
      if (!m) continue;
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        /* ignore */
      }
      if (!best || mtime > best.mtime) best = { id: m[1], mtime };
    }
  };
  walk(join(codexHome, 'sessions'));
  return best?.id ?? null;
}

/** The per-session CODEX_HOME bootstrap-su/psu minted for a tracked codex
 *  session, keyed by the adv-session row id (`writeSuCodexHome`). */
export function codexHomeForAdvSession(advSessionId: number): string {
  return join(
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR || join(homedir(), '.papercusp', 'su-codex-homes'),
    `session-${advSessionId}`,
  );
}

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
  /** adv_sessions.coord_owner_id — for tracked hive launches this is the spawn
   *  id that keys the persistent signed MCP config dir (D-010 resume leg). */
  coordOwnerId?: string | null;
}, wakeText: string): { bin: string; args: string[]; promptViaPty: boolean } | null {
  if (handle.agent === 'claude') {
    // Exact-session resume only (see header). Prompt rides as the positional
    // arg — claude submits it as the first user message of the resumed turn.
    if (!handle.sessionId) return null;
    // Tracked hive launches (invoke route, bpkind=hive) bake their signed MCP
    // config at a PERSISTENT conventional path keyed by the coord owner id —
    // remount it on resume or the resumed Queen wakes toolless (her original
    // spawn loaded it via --mcp-config; resume must too).
    const mcpArgs: string[] = [];
    if (handle.coordOwnerId) {
      const root =
        process.env.PAPERCUSP_SESSION_MCP_DIR || join(homedir(), '.papercusp', 'session-mcp');
      const cfg = join(root, handle.coordOwnerId, '.mcp.json');
      if (existsSync(cfg)) mcpArgs.push('--mcp-config', cfg, '--strict-mcp-config');
    }
    return {
      bin: 'claude',
      args: [
        '--resume', handle.sessionId,
        // Headless one-turn (`-p`): a wake IS one turn — run the resumed turn to
        // completion and exit, leaving the session file updated for the NEXT
        // wake. WITHOUT `-p`, claude boots its interactive TUI which, spawned
        // into a managed pty nothing drives, just sits idle and never runs the
        // turn — every "delivered:resume" produced silence (Stage-B finding,
        // 2026-06-07; the manual `-p` resume is what actually worked).
        '-p',
        '--dangerously-skip-permissions',
        '--permission-mode', 'bypassPermissions',
        ...mcpArgs,
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
    // Headless single-turn resume (codex 0.137 `exec resume <uuid> <prompt>`):
    // runs the wake turn to completion in the session's CODEX_HOME (set by
    // executeWake from the adv-session id) and exits, leaving the session
    // updated for the next wake — the codex counterpart of claude's
    // `--resume … -p`. `sessionId` is the conversation UUID executeWake
    // recovered from the rollout; without it we degrade to park/inbox (a bare
    // `--last <prompt>` would have clap read the prompt as the session id).
    // Bypass flags mirror the interactive su resume. (turn-lifecycle-control
    // P-009 / D-004.)
    if (!handle.sessionId) return null;
    return {
      bin: 'codex',
      args: [
        'exec',
        '--dangerously-bypass-hook-trust',
        '--dangerously-bypass-approvals-and-sandbox',
        'resume',
        handle.sessionId,
        wakeText,
      ],
      promptViaPty: false,
    };
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
    const pidKnown = pid != null && pid > 0;
    // Liveness: a recorded pid is authoritative; with NO pid recorded (hook-
    // bootstrapped sessions), FRESH presence is the alive-evidence — resuming
    // a session whose process is actually still open would run a concurrent
    // second client on the same session file. When in doubt, park (the parked
    // row converts to a resume once presence goes stale or the row ends).
    let isAlive: boolean;
    if (ended) {
      isAlive = false;
    } else if (pidKnown) {
      isAlive = alive(pid);
    } else {
      const p = await presence(d.subscriberId).catch(() => null);
      isAlive = Boolean(p && !p.stale && !p.revoked);
    }

    const text = wakeTurnText(d);

    if (isAlive && pidKnown) {
      // Channel 1: one of our managed ptys? (pid match — /adv-spawned sessions)
      const pty = findPty(pid);
      if (pty) {
        const okWrite = write(pty.id, Buffer.from(`${text}\r`, 'utf8'));
        if (okWrite) return { kind: 'delivered', channel: 'pty-inject' };
      }
      // Channel 3: alive in a terminal we don't own — park (+ inbox nudge by pump).
      return { kind: 'park', reason: `session pid ${pid} alive but not an injectable managed pty` };
    }
    if (isAlive) {
      // No pid recorded but presence is fresh — the session is (very likely)
      // still open somewhere we can't see. Never concurrent-resume it; park.
      return { kind: 'park', reason: 'no recorded pid but presence is fresh — parking to avoid a concurrent resume of a live session' };
    }

    // Channel 2: process gone → resume.
    const resumeAgent = fresh?.agent ?? handle.agent;
    // codex resumes from its per-session CODEX_HOME (keyed by the adv-session
    // id, exactly as bootstrap-su/psu minted it) and needs the conversation
    // UUID recovered from that home's rollout — codex carries no native id on
    // the row (turn-lifecycle-control P-009/P-010).
    let codexHome: string | null = null;
    let codexSessionId: string | null = null;
    if (resumeAgent === 'codex') {
      const home = codexHomeForAdvSession(handle.advSessionId);
      if (existsSync(home)) {
        codexHome = home;
        codexSessionId = (fresh?.sessionId ?? handle.sessionId) || findCodexRolloutSessionId(home);
      }
    }
    const resume = resumeCommandFor(
      {
        agent: resumeAgent,
        sessionId: resumeAgent === 'codex' ? codexSessionId : (fresh?.sessionId ?? handle.sessionId),
        ompThreadId: fresh?.ompThreadId ?? handle.ompThreadId,
        coordOwnerId: fresh?.coordOwnerId ?? null,
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
      // MCP handshake headroom: under fleet load the operator's event loop can
      // stall past claude's default MCP connect timeout, and claude then marks
      // the server offline for the WHOLE resumed session (no retry) — a woken
      // Queen with no voice (Stage-A finding, 2026-06-07, load ~200).
      MCP_TIMEOUT: process.env.PAPERCUSP_WAKE_MCP_TIMEOUT_MS || '120000',
    };
    // Tracked hive launches keep their per-session CLAUDE_CONFIG_DIR (transcript
    // + plugin isolation) at a conventional path — point the resumed claude at
    // it so `--resume <sessionId>` finds the session file (D-010 resume leg).
    const owner = fresh?.coordOwnerId ?? null;
    if (owner) {
      const cfgDir = join(
        process.env.PAPERCUSP_SESSION_CLAUDE_DIR || join(homedir(), '.papercusp', 'session-claude'),
        owner,
      );
      if (existsSync(cfgDir)) env.CLAUDE_CONFIG_DIR = cfgDir;
    }
    // codex finds the session's history + baked superuser MCP only inside its
    // per-session CODEX_HOME — point the resumed `codex exec resume` at it
    // (turn-lifecycle-control P-009).
    if (codexHome) env.CODEX_HOME = codexHome;

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

    // A claude (`-p`) or codex (`exec resume`) resume is HEADLESS one-turn (set
    // in resumeCommandFor) — it must run DETACHED with stdio:'ignore', NOT in a
    // managed pty. In a pty claude's stdin is a TTY, so `-p` waits for
    // interactive input instead of consuming the positional prompt and exiting —
    // the process hangs alive, never runs the turn, and "delivered:resume" is a
    // lie (Stage-B finding, 2026-06-07: every pty resume sat idle 2+ min; the
    // manual non-tty `-p` ran one turn and exited). codex `exec` is likewise
    // non-interactive single-turn. The pty path stays for omp/interactive
    // injection (promptViaPty), where a live TTY is the whole point.
    if ((resume.bin === 'claude' || resume.bin === 'codex') && !resume.promptViaPty) {
      const pid2 = spawnDetached(resume.bin, resume.args, { cwd, env });
      if (pid2) return { kind: 'delivered', channel: 'resume-headless' };
      return { kind: 'error', error: 'headless resume spawn failed' };
    }

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
      return { kind: 'error', error: `resume spawn failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
