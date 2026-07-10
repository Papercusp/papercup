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
 *   4. nothing live + nothing resumable → DEGRADE to a coord inbox
 *      notification (P-001, wake-delivery-degradation-fix-2026-07-09): per the
 *      events:await registration contract a `notify`-policy subscriber always
 *      has an inbox to fall back to, so losing liveness/resumability is not
 *      the same as having no resolvable owner. Delivered with channel='inbox'
 *      (`degradeToInboxOrDrop`). Only a genuinely undeliverable inbox write
 *      (no resolvable owner / a durable write fault) still DROPS, visibly
 *      (D-004 net #2).
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
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import {
  sessionClaudeConfigDir,
  sessionMcpJsonPath,
  codexHomeForSessionKey,
} from '@papercusp/orchestrator/session-launch-dirs';
import { nativeSchedulerDenyFlag } from '@papercusp/orchestrator/native-scheduler-deny';
import { noSubagentToolsDenyFlag } from '@papercusp/orchestrator/no-subagent-deny';
import { readFleetClaudeToken } from '@papercusp/orchestrator/fleet-claude-token';
import { getAdvSession } from '../../adv-sessions';
import {
  collectSessionFiles as defaultCollectSessionFiles,
  findArchivedSessionIdForAdv as defaultFindArchivedSessionIdForAdv,
  rematerializeSession as defaultRematerializeSession,
} from '../../session-archive';
import { ompSessionsRoot } from '../../omp-sessions';
import { findPtyByPid, killPty, spawnPty, writePty } from '../../pty-bridge';
import {
  freshContextWarmInjectTarget,
  runFreshContextWarmInject,
  type FreshContextDeps,
} from './wake-executor-fresh-context';
import { getPresence } from '../../agent-tools/coordination/presence';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { findLiveHost, injectIntoHost } from './psu-pty-discovery';
import {
  decideColdWake,
  readColdLoopMarker,
  renderColdWakeInjection,
  type ColdWakeDecision,
} from '../../su-cold-loop';
import { getLoopCarryNote } from '../../carry-note';
import type { ResumeTurnExitRaw } from './resume-turn-outcome';
import type { DeliveryWork, WakeOutcome } from './types';

/** Bounded output-tail capture for an observed resume turn (P0a). The CLIs print
 *  API errors (incl. the 429 / usage-limit lines) to STDOUT; the dying turn's error
 *  is at the END of its output, so a tail is enough to classify it. */
const RESUME_OUTPUT_TAIL_BYTES = Number(process.env.PAPERCUSP_RESUME_OUTPUT_TAIL_BYTES) || 8192;

/** A growing-but-bounded byte tail — keeps only the last `maxBytes`, so an observed
 *  resume turn that prints megabytes never accumulates more than the tail in memory. */
export function makeTailCollector(maxBytes: number): { push: (b: Buffer) => void; value: () => string } {
  let buf = Buffer.alloc(0);
  return {
    push: (b: Buffer) => {
      buf = buf.length === 0 ? Buffer.from(b) : Buffer.concat([buf, b]);
      if (buf.length > maxBytes) buf = buf.subarray(buf.length - maxBytes);
    },
    value: () => buf.toString('utf8'),
  };
}

/**
 * The default detached-resume spawn (P0a). When an `onExit` observer is wired it
 * spawns with piped stdout/stderr, ACTIVELY DRAINS them into bounded tails (an
 * undrained pipe would backpressure-deadlock the turn), and fires `onExit` once on
 * close — so a turn that 429s after the PID is assigned is observable. Without an
 * observer it is byte-identical to the original (`stdio:'ignore'`, zero overhead).
 * Always returns the PID immediately (the delivery is 'delivered' on spawn either way);
 * the observation is asynchronous + best-effort (a missed exit degrades to the
 * reconcile stuck-park backstop). Exported so the integration test can drive it with a
 * real subprocess (the deadlock-prone path).
 */
export function defaultSpawnDetached(
  bin: string,
  args: string[],
  o: { cwd: string; env: Record<string, string> },
  onExit?: (exit: ResumeTurnExitRaw) => void,
): number | null {
  const child = childSpawn(bin, args, {
    cwd: o.cwd,
    env: { ...process.env, ...o.env },
    detached: true,
    stdio: onExit ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  if (onExit) {
    const out = makeTailCollector(RESUME_OUTPUT_TAIL_BYTES);
    const err = makeTailCollector(RESUME_OUTPUT_TAIL_BYTES);
    // Attaching a `data` listener puts the stream in flowing mode → continuously
    // drained → no backpressure. Errors on the pipe are swallowed (a dead pipe is not
    // a turn outcome). unref the pipes so they never keep the operator alive.
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    // unref the pipe sockets so they never keep the operator's loop alive on the child
    // (Readable doesn't type `unref`, but the socket-backed stdio pipes have it).
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      try {
        onExit({ exitCode: code, signal, stdoutTail: out.value(), stderrTail: err.value() });
      } catch {
        /* the outcome observer must NEVER throw back into the spawn path */
      }
    };
    // 'close' = stdio fully flushed (complete tails). 'error' (post-pid failure) →
    // settle as a death. Best-effort: a missed exit degrades to the reconcile stuck-park
    // backstop (≥30min), exactly as today.
    child.on('close', (code, signal) => settle(code, signal));
    child.on('error', () => settle(null, null));
  }
  child.unref();
  return child.pid ?? null;
}

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
  type RolloutMatch = { id: string; mtime: number };
  let best: RolloutMatch | null = null;
  const walk = (dir: string): void => {
    let entries: Dirent[];
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
  return (best as RolloutMatch | null)?.id ?? null;
}

/** The per-session CODEX_HOME bootstrap-su/psu minted for a tracked codex
 *  session, keyed by the adv-session row id (`writeSuCodexHome`). Delegates to
 *  the ONE shared key helper so launch + resume never drift (unify-launch-mechanics
 *  P-004). */
export function codexHomeForAdvSession(advSessionId: number): string {
  return codexHomeForSessionKey(advSessionId);
}

/** Whether a (possibly coalesced) delivery payload carries a timeout fire.
 *  A plain timeout fire is `{ timeout: true }` (engine.ts sweeper). A COALESCED
 *  wake replaces that headline with `{ coalesced, count, events, latest }`
 *  (engine.ts coalesceDeliveries), so the raw `payload.timeout` is gone — look
 *  inside the union (the latest fire AND any folded event) or the marker would be
 *  silently dropped and the agent told the event FIRED when it actually TIMED OUT. */
/** WI-3940: default upper bound on each rematerialize-on-miss PG call in the
 *  wake resume leg. Generous for a healthy restore (a 2.6MB session restores
 *  in well under a second) while bounding the WI-2009 wedged-connection class. */
export const REMATERIALIZE_TIMEOUT_MS = 30_000;

/** WI-3940: race a wake-hot-path promise against a timer. Resolves the value,
 *  or `null` on TIMEOUT or REJECTION (both logged) — never throws, never
 *  hangs. The rematerialize seams are fail-soft on rejection, but a wedged PG
 *  connection HANGS past every try/catch; this is what actually bounds the
 *  wake pipeline. The timer is unref'd so it never holds the process open;
 *  the underlying promise is abandoned on expiry, not cancelled. */
export function withWakeTimeout<T>(p: Promise<T>, label: string, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[wake-executor] ${label} timed out after ${ms}ms — proceeding without it (WI-3940)`);
      resolve(null);
    }, ms);
    t.unref?.();
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        console.warn(`[wake-executor] ${label} failed: ${(e as Error)?.message ?? e}`);
        resolve(null);
      },
    );
  });
}

function payloadIsTimeout(payload: unknown): boolean {
  if (payload == null || typeof payload !== 'object') return false;
  const p = payload as {
    timeout?: boolean;
    latest?: { payload?: { timeout?: boolean } };
    events?: { payload?: { timeout?: boolean } }[];
  };
  if (p.timeout === true) return true;
  if (p.latest?.payload?.timeout === true) return true;
  if (Array.isArray(p.events) && p.events.some((e) => e?.payload?.timeout === true)) return true;
  return false;
}

/** Compose the single-line wake turn injected/submitted into the woken session. */
export function wakeTurnText(d: DeliveryWork): string {
  const note = d.note ? ` (your note: ${d.note})` : '';
  const summary = d.summary ? ` — ${d.summary}` : '';
  const payload =
    d.payload != null ? ` payload: ${JSON.stringify(d.payload).slice(0, 400)}` : '';
  const timeout = payloadIsTimeout(d.payload)
    ? ' [TIMEOUT — the event did NOT fire before your deadline]'
    : '';
  // P-006 (fleet-member-dx, EI-9018): `d.id` is the DELIVERY-LOG row id, not a
  // wake count — unlabeled "wake #12672" next to a loop's own "wake #5" read as
  // two contradictory counters and confused resuming agents. Label it as an id.
  return (
    `[await-event] ${d.eventKey} fired${timeout}${summary}.${note}${payload} ` +
    `(event-wake delivery #${d.id} — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.)`
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

/** System identity for the degrade-to-inbox notify send below (mirrors
 *  engine.ts's own `emitterIdentity` — kept as a private duplicate rather
 *  than a shared export to avoid a wake-executor↔engine import cycle). */
function inboxNotifierIdentity(workspaceId: string): AgentIdentity {
  return {
    ownerId: 'await-event',
    ownerLabel: 'await-event',
    source: 'static-client',
    workspaceId,
    userId: null,
  } as AgentIdentity;
}

/**
 * Degrade a would-be DROP to a coord inbox notification (P-001,
 * wake-delivery-degradation-fix-2026-07-09). Per the events:await
 * registration contract, a subscriber always has a coord inbox to fall back
 * to — no live pty/socket to inject into and nothing safely resumable is NOT
 * the same as "no resolvable owner". Only when the inbox write itself fails
 * (the one case where delivery is genuinely impossible) does this still drop,
 * visibly, folding the inbox failure into the reason.
 */
async function degradeToInboxOrDrop(
  d: DeliveryWork,
  reason: string,
  send: typeof sendMessage,
): Promise<WakeOutcome> {
  try {
    await send(inboxNotifierIdentity(d.workspaceId), {
      to: [d.subscriberId],
      summary: `[await-event] ${d.eventKey} fired — delivered to your coord inbox (${reason})`,
      body: wakeTurnText(d),
      category: 'event',
      extra: { auto: true, event_key: d.eventKey, wake_delivery_id: d.id },
    });
    return { kind: 'delivered', channel: 'inbox' };
  } catch (err) {
    return {
      kind: 'drop',
      reason: `${reason} — inbox delivery also failed (no resolvable owner): ${err instanceof Error ? err.message : String(err)}`,
    };
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
      const cfg = sessionMcpJsonPath(handle.coordOwnerId);
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
        // Native-scheduler lockout (native-scheduler-lockout-2026-06-09): CLI
        // flags don't persist into resumes, so every autonomous wake re-arms
        // the deny. MUST stay the single `=` token — the space form is
        // variadic and would eat the positional wakeText below (D-002).
        nativeSchedulerDenyFlag(),
        // Subagent-fanout deny (owner mandate 2026-07-02): SAME persistence gap —
        // a spawn-time `--disallowedTools=Task,Agent` does NOT survive into a
        // resume, so a woken bee would silently regain its subagent-launch tool.
        // Re-arm it every wake. Also a single `=` token (same greed-guard).
        noSubagentToolsDenyFlag(),
        ...mcpArgs,
        wakeText,
      ],
      promptViaPty: false,
    };
  }
  if (handle.agent === 'omp') {
    if (!handle.ompThreadId) return null;
    if (process.env.PAPERCUSP_OMP_RESUME_VIA_PTY === '1') {
      // Fallback for older OMP builds: resume interactively and inject once the
      // TUI is ready. The default modern path below is true headless one-turn.
      return {
        bin: 'omp',
        args: ['-r', handle.ompThreadId, '--approval-mode', 'yolo'],
        promptViaPty: true,
      };
    }
    // OMP supports the same shape as `--continue "prompt"`: combine resume
    // with `-p` and the wake text as the one turn. Prefer this over PTY
    // injection so a wake has a bounded subprocess lifecycle.
    return {
      bin: 'omp',
      args: ['-r', handle.ompThreadId, '--approval-mode', 'yolo', '-p', wakeText],
      promptViaPty: false,
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

/**
 * Fresh-per-wake fire for the Hive Queen (queen-brief-cache-assembly B-01 / P-012).
 * The Queen NEVER resumes a prior conversation — she re-derives her working state
 * from durable world-state every wake (D-009). Her own declared/event/watchdog
 * wakes already spawn fresh (`--session-id <new uuid>` via the hive launch
 * blueprint); this routes the ONE remaining resume path (a `coord:send {wake:true}`
 * inbox-wake, or an events:await she registered) through the SAME fresh hive-launch
 * path, with the wake text as the kickoff. Mirrors the `pot:wake` tool's core
 * (floor-debounce + record) so a burst of bee-wakes collapses to one fresh launch.
 * Lazy imports keep the await engine free of the blueprint graph (module header).
 * Returns true when the wake is handled (fired OR floor-skipped — a recent fresh
 * wake already covers it); false on failure so the caller parks rather than resumes.
 */
async function defaultFireHiveWake(input: { installSlug: string; kickoff: string }): Promise<boolean> {
  try {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { fireLaunchBlueprint } = await import('../../blueprint/launch-blueprint');
    const { POT_BLUEPRINT_ID, readPotWakeState, recordPotWake, withinWakeFloor, effectivePotWakeFloorSec } =
      await import('../../pot/wake');
    const workspaceId = activeWorkspaceId();
    const state = await readPotWakeState(workspaceId);
    // A fresh wake within the floor window already covers this delivery — the
    // just-launched (or about-to-survey) Queen will see the same durable state.
    // Honour the owner's raised wake-cadence floor (queen-steering-panel P-006).
    const floorSec = await effectivePotWakeFloorSec(workspaceId, input.installSlug);
    if (withinWakeFloor(state, Date.now(), floorSec)) return true;
    // EI-7871 (WI-3082 follow-up): this fire is a genuine coord/events:await wake
    // continuation (the Queen's ended session getting a fresh-launch in place of a
    // resume, D-010) — override the /invoke route's 'cron' default so her
    // agent_usage_samples row is attributed 'coord-wake', matching the semantics
    // every OTHER coord-wake-triggered spawn already carries (bee/spawn.ts,
    // place_batch.ts, and this same file's resume-channel env above).
    await fireLaunchBlueprint(POT_BLUEPRINT_ID, {
      installSlug: input.installSlug,
      workspaceId,
      kickoff: input.kickoff,
      bodyExtra: { turnTrigger: 'coord-wake' },
    });
    await recordPotWake(workspaceId);
    return true;
  } catch {
    return false;
  }
}

/** Parse the install slug out of a hive-operator adv_sessions label
 *  (`hive · <slug>/<role>`, set at spawn.ts on the bpkind=hive invoke). null when
 *  the row is not a hive operator. */
export function hiveInstallSlugFromLabel(label: string | null | undefined): string | null {
  const l = (label ?? '').trim();
  if (!l.startsWith('hive · ')) return null;
  const slug = l.slice('hive · '.length).split('/')[0]?.trim();
  return slug || null;
}

/** Upper bound for an omp resume PTY to present an injectable screen. */
const OMP_RESUME_READY_TIMEOUT_MS = Number(process.env.PAPERCUSP_OMP_RESUME_READY_TIMEOUT_MS) || 15_000;

/** A settled OMP screen is injectable even when its prompt chrome changes. */
const OMP_RESUME_QUIET_READY_MS = Number(process.env.PAPERCUSP_OMP_RESUME_QUIET_READY_MS) || 750;

const OMP_RESUME_TRANSCRIPT_TAIL_BYTES = 4_096;

const OMP_READY_PATTERNS = [
  /(^|[\r\n])\s*(>|[$#])\s*$/m,
  /(?:type|enter|send)\s+(?:a\s+)?(?:message|prompt|request)/i,
  /(?:what would you like|how can i help|ask me anything)/i,
  /\/help/i,
];

/** Delay before the submit Enter (CR) is sent as its OWN keystroke after a turn's
 *  text. A one-shot `text + CR` burst is swallowed by the Claude Code TUI's paste
 *  detector — the CR becomes a literal newline in the input box and the turn never
 *  submits. This is the SAME fix as the psu-pty-host.mjs `controlWrites` split; the
 *  two live in different processes/pty-owners so they can't share code, but they
 *  read the SAME env var to stay in lockstep. */
const TURN_SUBMIT_CR_DELAY_MS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS) || 150;

interface OmpResumePtyLike {
  id: string;
  onData?: Set<(chunk: Buffer) => void>;
  onExit?: Set<(code: number, signal: number) => void>;
  history?: Buffer[];
  killed?: boolean;
  exitCode?: number | null;
}

export type OmpPtyPromptInjectionResult =
  | { ok: true; transcriptTail: string }
  | { ok: false; error: string; transcriptTail: string };

function timer(fn: () => void, ms: number): NodeJS.Timeout {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    timer(resolve, ms);
  });
}

function tailBytes(chunks: Buffer[], maxBytes: number): string {
  if (chunks.length === 0) return '';
  let bytes = 0;
  const out: Buffer[] = [];
  for (let i = chunks.length - 1; i >= 0 && bytes < maxBytes; i -= 1) {
    const b = chunks[i];
    if (!b) continue;
    bytes += b.length;
    out.unshift(b);
  }
  return Buffer.concat(out).subarray(-maxBytes).toString('utf8');
}

export function ompResumePtyLooksReady(transcript: string): boolean {
  return OMP_READY_PATTERNS.some((p) => p.test(transcript));
}

export async function injectOmpWakeTurnWhenReady(input: {
  pty: OmpResumePtyLike;
  wakeText: string;
  write: typeof writePty;
  readyTimeoutMs?: number;
  quietReadyMs?: number;
  submitCrDelayMs?: number;
}): Promise<OmpPtyPromptInjectionResult> {
  const readyTimeoutMs = input.readyTimeoutMs ?? OMP_RESUME_READY_TIMEOUT_MS;
  const quietReadyMs = input.quietReadyMs ?? OMP_RESUME_QUIET_READY_MS;
  const submitCrDelayMs = input.submitCrDelayMs ?? TURN_SUBMIT_CR_DELAY_MS;
  const chunks = [...(input.pty.history ?? [])];

  const transcript = () => tailBytes(chunks, OMP_RESUME_TRANSCRIPT_TAIL_BYTES);
  const initial = transcript();
  if (!ompResumePtyLooksReady(initial)) {
    const ready = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      let done = false;
      let quietTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        done = true;
        clearTimeout(timeoutTimer);
        if (quietTimer) clearTimeout(quietTimer);
        input.pty.onData?.delete(onData);
        input.pty.onExit?.delete(onExit);
      };
      const finish = (result: { ok: true } | { ok: false; error: string }) => {
        if (done) return;
        cleanup();
        resolve(result);
      };
      const markQuietReady = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = timer(() => finish({ ok: true }), quietReadyMs);
      };
      const onData = (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const t = transcript();
        if (ompResumePtyLooksReady(t)) finish({ ok: true });
        else markQuietReady();
      };
      const onExit = (code: number, signal: number) => {
        finish({ ok: false, error: `omp resume pty exited before readiness (code ${code}, signal ${signal})` });
      };
      const timeoutTimer = timer(() => {
        finish({ ok: false, error: `omp resume pty did not become ready within ${readyTimeoutMs}ms` });
      }, readyTimeoutMs);

      if (input.pty.killed || input.pty.exitCode !== null) {
        finish({ ok: false, error: 'omp resume pty is already closed' });
        return;
      }
      input.pty.onData?.add(onData);
      input.pty.onExit?.add(onExit);
    });
    if (!ready.ok) return { ok: false, error: ready.error, transcriptTail: transcript() };
  }

  try {
    const wrotePrompt = input.write(input.pty.id, Buffer.from(input.wakeText, 'utf8'));
    if (!wrotePrompt) return { ok: false, error: 'omp resume pty rejected prompt write', transcriptTail: transcript() };
    await sleep(submitCrDelayMs);
    const wroteSubmit = input.write(input.pty.id, Buffer.from('\r', 'utf8'));
    if (!wroteSubmit) return { ok: false, error: 'omp resume pty rejected submit write', transcriptTail: transcript() };
    return { ok: true, transcriptTail: transcript() };
  } catch (err) {
    return {
      ok: false,
      error: `omp resume pty injection failed: ${err instanceof Error ? err.message : String(err)}`,
      transcriptTail: transcript(),
    };
  }
}

export interface ExecuteWakeDeps {
  /** Injected for tests; default real implementations below. */
  getSession?: typeof getAdvSession;
  findPty?: typeof findPtyByPid;
  write?: typeof writePty;
  spawnManagedPty?: typeof spawnPty;
  spawnDetached?: (
    bin: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
    /** P0a: when provided, the default spawn captures bounded output tails + observes
     *  the detached turn's exit, firing this on close. */
    onExit?: (exit: ResumeTurnExitRaw) => void,
  ) => number | null;
  /** P0a (loop-wake-rate-limit-robustness): observe the eventual EXIT of a detached
   *  `resume-headless` turn. Fired best-effort when the subprocess closes, carrying the
   *  exit code/signal + bounded stdout/stderr tails — the seam the loop turn-outcome
   *  handler uses to feed the autoloop circuit on a 429 turn-DEATH (the wake records
   *  `delivered` on spawn, so a later death is otherwise invisible). Absent ⇒ today's
   *  fire-and-forget (`stdio:'ignore'`, zero capture overhead); delivery still returns
   *  `delivered` the instant a PID is assigned either way. */
  onResumeTurnExit?: (d: DeliveryWork, exit: ResumeTurnExitRaw) => void;
  kill?: typeof killPty;
  presence?: typeof getPresence;
  alive?: (pid: number | null) => boolean;
  /** P-001 (wake-delivery-degradation-fix-2026-07-09): the coord-message send
   *  used to degrade a would-be DROP into a durable inbox notification.
   *  Injected for tests; defaults to the real sendMessage. */
  sendCoordMessage?: typeof sendMessage;
  resumePlanRun?: (input: { runId: number; wakeText: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** turn-lifecycle-control Phase 3 (P-014): discover + inject into a live
   *  psu-hosted managed-pty session's control socket. The operator can't see it
   *  via findPty — the pty lives in the psu process (D-006). */
  findPsuHost?: typeof findLiveHost;
  injectPsuHost?: typeof injectIntoHost;
  /** queen-brief-cache-assembly B-01/P-012: fire a FRESH hive launch instead of
   *  resuming a hive-operator session. Injected for tests; default fires the
   *  hive blueprint with the wake text as kickoff. */
  fireHiveWake?: (input: { installSlug: string; kickoff: string }) => Promise<boolean>;
  /** bee-context-efficiency P-005: the fresh-context warm-inject fork seam (flag
   *  gate + fresh-bee spawn + stale-claim release). Injected for tests; defaults to
   *  the real bindings (flag OFF ⇒ never fires, legacy `--resume` carry preserved). */
  freshContext?: FreshContextDeps;
  /** session-db-archive-retire-dirs-2026-07-10 P-008: the rematerialize-on-miss
   *  seams used by the resume leg. Injected for tests; default to the real
   *  session-archive bindings, which READ PG. A unit test that leaves these
   *  un-stubbed does not merely touch the DB — it BLOCKS: the PG read never
   *  settles, so it hangs *past* the surrounding try/catch (which only catches
   *  throws) until the suite timeout. That wedged the green gate on 2026-07-10
   *  (11 wake-executor tests × 180s). Stub them in any hermetic unit test. */
  collectSessionFiles?: typeof defaultCollectSessionFiles;
  rematerializeSession?: typeof defaultRematerializeSession;
  findArchivedSessionIdForAdv?: typeof defaultFindArchivedSessionIdForAdv;
  /** WI-3940: upper bound (ms) on each rematerialize-on-miss PG call in the
   *  resume leg. The seams above are fail-soft on REJECTION, but a WEDGED PG
   *  connection HANGS past every try/catch and stalls the whole wake pipeline
   *  (the WI-2009 hung-await class — a1a71's gate-unwedge flagged this hot
   *  path). On expiry the wake logs and proceeds down the normal miss path;
   *  the underlying query is abandoned, not cancelled. Injected for tests. */
  rematerializeTimeoutMs?: number;
  /** su-cold-auto-mode-2026-07-03 Phase 2 (P-005/P-006/P-007): the cold-auto MASTER
   *  GATE, resolved by the caller (the P-007 flag lands Phase 3). DEFAULT ()=>false ⇒
   *  the psu-host cold fork stays DORMANT — every loop wake injects the warm
   *  `mode:'turn'` turn, byte-identical to today — until a real caller wires an enabled
   *  gate. Read ONLY when a wake carries a `carry:'cold'` loop marker (never on the
   *  warm hot path). */
  coldAutoEnabled?: () => Promise<boolean>;
  /** Read an su AUTO loop's carry-note — the P-006 cold-start anchor a RESET-CONTEXT /
   *  RECYCLE reconstructs from. Injected for tests; defaults to the real
   *  getLoopCarryNote (carry-note.ts). */
  getLoopCarryNoteFn?: (ref: {
    harness: string;
    ownerId: string;
    workspaceId?: string;
  }) => Promise<string | null>;
  /** compaction-continuity-hardening-2026-07-07 P-003: assemble the subscriber's
   *  carry BRIEF (held work-items + checkpoints, standing facts/walls, armed awaits,
   *  fleet pointer) appended to a COLD injection after the carry-note. Injected for
   *  tests; defaults to the real buildCarryBrief (carry-brief.ts). Best-effort — a
   *  failed read injects the note alone. */
  buildCarryBriefFn?: (
    ownerId: string,
    opts?: { workspaceId?: string },
  ) => Promise<import('../../carry-brief').CarryBrief>;
}

/**
 * Inject a wake into a live psu-pty host, forking WARM (default) vs COLD
 * (su-cold-auto-mode-2026-07-03 Phase 2). Shared by BOTH executeWake psu-host inject
 * branches (the handle-less always-armed path + the main adv-session path) so the
 * cold fork can never be wired into one and missed in the other.
 *
 * DORMANT BY DEFAULT: the cold branch fires ONLY when decideColdWake says so — the
 * loop was armed `carry:'cold'` (the payload marker), cold-auto is enabled
 * (deps.coldAutoEnabled, DEFAULT ()=>false so nothing is cold until a caller wires the
 * P-007 gate), AND a carry-note anchor EXISTS (P-006). On {cold:true} it injects the
 * RESET-CONTEXT / RECYCLE control verb carrying the carry-note; otherwise the warm
 * `mode:'turn'` inject, byte-identical to today. FAIL-SOFT end to end: a marker-parse /
 * flag / carry-note error falls back to warm, and a failed COLD inject retries warm in
 * place — the cold path never drops or corrupts a wake.
 *
 * Returns the delivered WakeOutcome on a clean inject, or null on a socket miss (the
 * caller then falls through to the normal channels, exactly as before).
 */
async function injectPsuHostWake(
  d: DeliveryWork,
  sock: string,
  warmText: string,
  injectPsuHost: typeof injectIntoHost,
  deps: ExecuteWakeDeps,
): Promise<WakeOutcome | null> {
  const injectWarm = async (): Promise<WakeOutcome | null> => {
    const ok = await injectPsuHost(sock, { mode: 'turn', data: warmText });
    return ok ? { kind: 'delivered', channel: 'psu-socket-inject' } : null;
  };

  let decision: ColdWakeDecision = { cold: false, reason: 'warm (cold fork not engaged)' };
  try {
    const marker = readColdLoopMarker(d.payload);
    // Cheap short-circuit: only a cold-armed loop wake WITH a harness scope can go
    // cold — otherwise resolve nothing (no flag read, no PG carry-note read) and warm.
    if (marker?.carry === 'cold' && marker.harness) {
      const coldEnabled = await (deps.coldAutoEnabled ?? (async () => false))();
      const getNote = deps.getLoopCarryNoteFn ?? getLoopCarryNote;
      // Only pay the carry-note read when the master gate is actually on (P-006's
      // anchor is moot if cold-auto is disabled).
      const carryNote = coldEnabled
        ? await getNote({ harness: marker.harness, ownerId: d.subscriberId, workspaceId: d.workspaceId })
        : null;
      decision = decideColdWake({ payload: d.payload, coldEnabled, carryNote });
    }
  } catch {
    // Any resolution failure ⇒ warm (never let the cold path drop a wake).
    decision = { cold: false, reason: 'cold resolution threw — warm fallback' };
  }

  if (decision.cold) {
    // Wrap the carry-note with the standing re-checkpoint mandate (P-002 producer): the
    // injected text is the cold agent's ENTIRE opening context, so it must both frame the
    // note as the working state AND tell the agent to refresh it before ending — else the
    // note goes stale after one cold wake.
    // P-003: append the wider carry brief (held items + checkpoints, walls/facts, awaits,
    // fleet pointer) after the note — best-effort, note-only on any failure.
    let extras = '';
    try {
      const buildBrief =
        deps.buildCarryBriefFn ?? (await import('../../carry-brief')).buildCarryBrief;
      const { renderCarryBriefColdExtras } = await import('../../carry-brief');
      extras = renderCarryBriefColdExtras(
        await buildBrief(d.subscriberId, { workspaceId: d.workspaceId }),
      );
    } catch {
      /* note-only injection */
    }
    const ok = await injectPsuHost(sock, {
      mode: decision.mode,
      data: renderColdWakeInjection(decision.carryNote, extras),
    });
    if (ok) {
      return {
        kind: 'delivered',
        channel: decision.mode === 'recycle' ? 'psu-socket-recycle' : 'psu-socket-reset',
      };
    }
    // Cold inject missed → warm in place rather than drop the wake.
  }
  return injectWarm();
}

/**
 * Re-verify the interactive host after a failed socket write before parking the
 * delivery. A bg-host/desktop freeze can leave the discovery record and socket
 * path present while the first connect attempt races a host restart or a
 * transiently wedged socket. Re-reading discovery is cheap and, importantly,
 * can pick up a host that rebound the socket under the same owner. The delivery
 * remains durable and parked if the bounded second attempt also misses, so the
 * normal parked-row recheck still provides the later retry.
 */
async function injectPsuHostWakeWithReverify(
  d: DeliveryWork,
  warmText: string,
  findPsuHost: (ownerId: string) => { sock: string } | null,
  injectPsuHost: typeof injectIntoHost,
  deps: ExecuteWakeDeps,
): Promise<WakeOutcome | null> {
  let host = findPsuHost(d.subscriberId);
  for (let attempt = 0; host && attempt < 2; attempt += 1) {
    const outcome = await injectPsuHostWake(d, host.sock, warmText, injectPsuHost, deps);
    if (outcome) return outcome;
    // Re-read the owner-scoped discovery record after a miss. Do not reuse the
    // first host object: a live psu host may have rebound its control socket.
    host = findPsuHost(d.subscriberId);
  }
  return null;
}

/** Execute one wake delivery attempt. Never throws — every failure is an outcome. */
export async function executeWake(d: DeliveryWork, deps: ExecuteWakeDeps = {}): Promise<WakeOutcome> {
  const getSession = deps.getSession ?? getAdvSession;
  const findPty = deps.findPty ?? findPtyByPid;
  const write = deps.write ?? writePty;
  const spawnManaged = deps.spawnManagedPty ?? spawnPty;
  const kill = deps.kill ?? killPty;
  const presence = deps.presence ?? getPresence;
  const alive = deps.alive ?? pidAlive;
  const findPsuHost = deps.findPsuHost ?? findLiveHost;
  const injectPsuHost = deps.injectPsuHost ?? injectIntoHost;
  const fireHiveWake = deps.fireHiveWake ?? defaultFireHiveWake;
  const sendCoordMessage = deps.sendCoordMessage ?? sendMessage;
  const collectSessionFiles = deps.collectSessionFiles ?? defaultCollectSessionFiles;
  const rematerializeSession = deps.rematerializeSession ?? defaultRematerializeSession;
  const findArchivedSessionIdForAdv = deps.findArchivedSessionIdForAdv ?? defaultFindArchivedSessionIdForAdv;
  const rematerializeTimeoutMs = deps.rematerializeTimeoutMs ?? REMATERIALIZE_TIMEOUT_MS;

  try {
    const handle = d.wakeHandle;
    if (!handle) {
      // Registered without a resumable session (warned at registration). BUT a
      // live psu-pty host socket can still wake it in place — it injects into the
      // live session by ownerId and needs no resumable handle (EI-152: handle-less
      // always-armed inbox-wakes were parking even with a live socket available,
      // because the socket inject below sat under this early-return).
      const outcome = await injectPsuHostWakeWithReverify(
        d,
        wakeTurnText(d),
        findPsuHost,
        injectPsuHost,
        deps,
      );
      if (outcome) return outcome;
      // No injectable socket: presence fresh → park (a one-time inbox nudge
      // reaches it, engine.ts); gone/stale → degrade straight to a durable
      // coord inbox delivery instead of dropping outright (P-001).
      const p = await presence(d.subscriberId).catch(() => null);
      if (p && !p.stale && !p.revoked) return { kind: 'park', reason: 'no wake handle; presence live — inbox only' };
      return degradeToInboxOrDrop(d, 'no wake handle and presence gone/stale — dead waiter', sendCoordMessage);
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

    // Channel 1b (turn-lifecycle-control Phase 3, P-014): a live INTERACTIVE psu
    // session hosts its pty + control socket in the psu PROCESS (D-006), so our
    // findPty can't see it and the pid logic below would PARK it (or worse,
    // resume a concurrent second client). A live psu-pty host is the
    // authoritative "alive + injectable" signal — self-validating (host pid alive
    // + socket present) — so inject the wake turn in place; on any miss fall
    // through to the normal channels.
    const outcome = await injectPsuHostWakeWithReverify(
      d,
      text,
      findPsuHost,
      injectPsuHost,
      deps,
    );
    if (outcome) return outcome;

    if (isAlive && pidKnown) {
      // Channel 1: one of our managed ptys? (pid match — /adv-spawned sessions).
      // Owner-scoped (EI-151): a recorded pid the OS recycled to a DIFFERENT
      // agent's live managed pty must NOT match — injecting here would deliver
      // THIS subscriber's wake turn into the unrelated agent's session. The
      // finder rejects a pty tagged with a foreign owner; an untagged pty
      // (shell pane / legacy) still matches.
      const pty = findPty(pid, d.subscriberId);
      if (pty) {
        // Submit as TWO writes: the text, then the Enter (CR) as a SEPARATE
        // keystroke after a settle. A one-shot text+CR burst is swallowed by the
        // claude TUI's paste detector (CR → literal newline, turn never submits).
        // Mirror of psu-pty-host.mjs controlWrites (different process + pty owner,
        // so the code can't be shared — kept in lockstep via the shared env var).
        const okWrite = write(pty.id, Buffer.from(text, 'utf8'));
        if (okWrite) {
          setTimeout(() => {
            try {
              write(pty.id, Buffer.from('\r', 'utf8'));
            } catch {
              /* pty may have closed between the text write and the CR */
            }
          }, TURN_SUBMIT_CR_DELAY_MS).unref?.();
          return { kind: 'delivered', channel: 'pty-inject' };
        }
      }
      // Channel 3: alive in a terminal we don't own, OR the live managed pty at
      // this pid belongs to a different agent (recycled pid, EI-151) — either
      // way not an injectable pty for THIS subscriber → park (+ inbox nudge).
      return { kind: 'park', reason: `session pid ${pid} alive but not an injectable managed pty for this subscriber` };
    }
    if (isAlive) {
      // No pid recorded but presence is fresh — the session is (very likely)
      // still open somewhere we can't see. Never concurrent-resume it; park.
      return { kind: 'park', reason: 'no recorded pid but presence is fresh — parking to avoid a concurrent resume of a live session' };
    }

    // Fresh-per-wake cutover for the Hive Queen (queen-brief-cache-assembly
    // B-01 / P-012): a hive-operator session is NEVER resumed. Its ended-session
    // wake (an inbox-wake `coord:send {wake:true}`, or an events:await it
    // registered) routes through the SAME fresh hive-launch path its scheduled
    // wakes use, carrying the wake text as the kickoff — so the Queen opens fresh
    // and re-derives from durable world-state (D-009) instead of carrying a stale
    // transcript. On a fire failure we PARK (never resume): the always-armed
    // time/watchdog wake re-surveys, so the no-resume invariant holds absolutely.
    const hiveInstallSlug = hiveInstallSlugFromLabel(fresh?.label ?? null);
    if (hiveInstallSlug) {
      const fired = await fireHiveWake({ installSlug: hiveInstallSlug, kickoff: text }).catch(() => false);
      if (fired) return { kind: 'delivered', channel: 'hive-fresh-wake' };
      return { kind: 'park', reason: 'hive operator: fresh-wake fire failed; next time/watchdog wake will re-survey (never resumed)' };
    }

    // bee-context-efficiency P-005 (D-018/D-021): fresh-context warm-inject. We only
    // reach here for an EXITED process (a live session PARKs above, D-005 — within-task
    // is never forked). If this wake is a Queen warm-inject of a NEW work-item AND the
    // CUP_FRESH_CONTEXT_WARM_INJECT flag is on, the legacy `--resume` below would reload
    // the bee's grown transcript (~138K/turn dead-weight carry, D-011). Instead route to
    // a FRESH spawn for that work-item (fresh session + full preamble + the hydration
    // tail: dossier P-008 + the work-item CHECKPOINT P-011 = the continuity, D-002). The
    // marker payload is stamped by place_batch ONLY when the flag is on, so flag-off is
    // byte-identical to today (the carry-seam oracle). Fail-soft: false ⇒ legacy resume.
    const freshTarget = freshContextWarmInjectTarget(d);
    if (freshTarget) {
      const forked = await runFreshContextWarmInject(d, freshTarget, deps.freshContext, (m) =>
        console.log(`[wake-executor:fresh-context] ${m}`),
      );
      if (forked) return { kind: 'delivered', channel: 'fresh-context-warm-inject' };
      // else fall through to the legacy resume below (fail-soft).
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
      // Rematerialize-on-miss (session-db-archive-retire-dirs-2026-07-10
      // P-008): archive-at-death deletes a dead session's rollout + sqlite
      // once sha-verified in PG; a wake landing later pulls them back
      // byte-exactly before codex resumes. No-op when the home is intact or
      // nothing was ever archived.
      let sid: string | null = (fresh?.sessionId ?? handle.sessionId) || null;
      if (!existsSync(home) || !findCodexRolloutSessionId(home)) {
        // WI-3940: every PG call on this leg is time-bounded — a wedged
        // connection must degrade to the normal miss path, never stall the wake.
        if (!sid) {
          sid = await withWakeTimeout(
            findArchivedSessionIdForAdv(handle.advSessionId),
            `archived-session-id lookup for adv #${handle.advSessionId}`,
            rematerializeTimeoutMs,
          );
        }
        if (sid) {
          const r = await withWakeTimeout(
            rematerializeSession({ sourceKind: 'codex', sessionId: sid, targetRoot: home }),
            `rematerialize codex/${sid}`,
            rematerializeTimeoutMs,
          );
          if (r?.ok && r.written) {
            console.log(`[wake-executor] rematerialized codex/${sid}: ${r.written} file(s) → ${home}`);
          }
        }
      }
      if (existsSync(home)) {
        codexHome = home;
        codexSessionId = sid || findCodexRolloutSessionId(home);
      }
    }
    // omp keeps flat per-cwd transcripts under the shared sessions root — same
    // rematerialize-on-miss before the thread resume (P-008).
    if (resumeAgent === 'omp') {
      const sid = fresh?.sessionId ?? handle.sessionId;
      if (sid) {
        try {
          const have = await collectSessionFiles({ sourceKind: 'omp', sessionId: sid, sessionRoot: ompSessionsRoot() });
          if (!have.length) {
            // WI-3940: time-bounded — see the codex leg.
            const r = await withWakeTimeout(
              rematerializeSession({ sourceKind: 'omp', sessionId: sid }),
              `rematerialize omp/${sid}`,
              rematerializeTimeoutMs,
            );
            if (r?.ok && r.written) console.log(`[wake-executor] rematerialized omp/${sid}: ${r.written} file(s)`);
          }
        } catch (e) {
          console.warn(`[wake-executor] omp rematerialize check failed: ${(e as Error)?.message ?? e}`);
        }
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
      return degradeToInboxOrDrop(d, 'session ended, not resumable, presence gone — dead waiter', sendCoordMessage);
    }

    const env: Record<string, string> = {
      PAPERCUSP_SID: d.subscriberId,
      // Scope the resumed agent's user-level MCP to the bee's workspace. omp's
      // ~/.omp/agent/mcp.json sends x-papercusp-workspace via
      // `!printf "${PAPERCUSP_WORKSPACE:-}"`, and claude's user-level MCP url
      // env-expands the same var into `&workspace=`. Without this export the
      // header/param are EMPTY, so the ONLY workspace signal is the
      // SID->adv-row lookup (workspaceForCoordOwner) — which is null for a fresh
      // or under-load bee -> the MCP session is scoped_superuser_workspace_unresolved
      // -> EVERY coord:* tool 404s ("Tool coord:orient not found"). The coord hook
      // still works (it resolves the workspace itself), which masked this break.
      // (Since mcp-outage-triage-2026-07-02 the clamp falls back to the box's
      // ACTIVE workspace instead of rejecting — a net, not a replacement: this
      // explicit export stays the correct primary carrier.)
      // Mirrors bootstrap-su's envelopeEnv + console-launcher (the fresh-launch
      // legs that already set this). d.workspaceId is the delivery's workspace.
      PAPERCUSP_WORKSPACE: d.workspaceId,
      PAPERCUSP_WAKE_DELIVERY_ID: String(d.id),
      // MCP handshake headroom: under fleet load the operator's event loop can
      // stall past claude's default MCP connect timeout, and claude then marks
      // the server offline for the WHOLE resumed session (no retry) — a woken
      // Queen with no voice (Stage-A finding, 2026-06-07, load ~200).
      MCP_TIMEOUT: process.env.PAPERCUSP_WAKE_MCP_TIMEOUT_MS || '120000',
      // An autonomous wake turn IS an agent session, whoever the recipient:
      // arm the hook-level scheduler guard (native-scheduler-lockout P-010).
      PAPERCUSP_AGENT_SESSION: '1',
      // WI-3082: this whole codepath (Channel 2: "process gone → resume") is a
      // genuinely FRESH child process spawned specifically to deliver a
      // coord/events:await wake — invoke.ts reads this as PAPERCUSP_TURN_TRIGGER
      // and stamps it onto the run's agent_usage_samples row (source='jsonl').
      // Before this, only a bee/queen's FIRST spawn (bee/spawn.ts, place_batch.ts)
      // was labeled 'coord-wake'; every persistent long-running agent (queen,
      // overwatch, doc-steward, and a bee resumed after its process exited
      // rather than freshly spawned) resumes through exactly this path and had
      // NO PAPERCUSP_TURN_TRIGGER set at all — the single largest unattributed
      // jsonl-source slice the token-usage audit (P-002) found. `resumeCommandFor`
      // always fires FOR a wake (there is no other caller of this env block), so
      // 'coord-wake' is unconditionally correct here — no branching needed.
      PAPERCUSP_TURN_TRIGGER: 'coord-wake',
    };
    // Tracked hive launches keep their per-session CLAUDE_CONFIG_DIR (transcript
    // + plugin isolation) at a conventional path — point the resumed claude at
    // it so `--resume <sessionId>` finds the session file (D-010 resume leg).
    const owner = fresh?.coordOwnerId ?? null;
    if (owner) {
      const cfgDir = sessionClaudeConfigDir(owner);
      // Rematerialize-on-miss (P-008): the transcript may have been archived+
      // deleted at death — restore it byte-exactly (sha-verified) so
      // `--resume <sessionId>` finds the session file. FS-only when the file
      // is already on disk; one PG read otherwise.
      const sid = fresh?.sessionId ?? handle.sessionId;
      if (resumeAgent === 'claude' && sid) {
        try {
          const have = await collectSessionFiles({ sourceKind: 'claude', sessionId: sid, sessionRoot: cfgDir });
          if (!have.length) {
            // WI-3940: time-bounded — see the codex leg.
            const r = await withWakeTimeout(
              rematerializeSession({ sourceKind: 'claude', sessionId: sid, targetRoot: cfgDir }),
              `rematerialize claude/${sid}`,
              rematerializeTimeoutMs,
            );
            if (r?.ok && r.written) {
              console.log(`[wake-executor] rematerialized claude/${sid}: ${r.written} file(s) → ${cfgDir}`);
            }
          }
        } catch (e) {
          console.warn(`[wake-executor] claude rematerialize check failed: ${(e as Error)?.message ?? e}`);
        }
      }
      if (existsSync(cfgDir)) env.CLAUDE_CONFIG_DIR = cfgDir;
    }
    // Fleet token (claude-credential-sync-2026-06-10 P-003): an autonomous wake
    // turn authenticates with the dedicated non-rotating setup-token when the
    // owner has minted one, so fleet refreshes never consume the interactive
    // OAuth family's single-use refresh token (the every-terminal-relogin
    // cascade). Mirrors the orchestrator spawn leg (invoke.ts). Absent token ⇒
    // unchanged (the session's config-dir credentials).
    if (resumeAgent === 'claude') {
      const fleetToken = readFleetClaudeToken();
      if (fleetToken) env.CLAUDE_CODE_OAUTH_TOKEN = fleetToken;
    }
    // codex finds the session's history + baked superuser MCP only inside its
    // per-session CODEX_HOME — point the resumed `codex exec resume` at it
    // (turn-lifecycle-control P-009).
    if (codexHome) env.CODEX_HOME = codexHome;

    const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;

    // A non-PTY resume is HEADLESS one-turn (set in resumeCommandFor) — it must
    // run DETACHED with stdio:'ignore', NOT in a managed pty. In a pty claude's
    // stdin is a TTY, so `-p` waits for
    // interactive input instead of consuming the positional prompt and exiting —
    // the process hangs alive, never runs the turn, and "delivered:resume" is a
    // lie (Stage-B finding, 2026-06-07: every pty resume sat idle 2+ min; the
    // manual non-tty `-p` ran one turn and exited). codex `exec` and modern omp
    // `-r … -p` are likewise non-interactive single-turn. The pty path stays as
    // an explicit OMP fallback (promptViaPty), where a live TTY is the point.
    if (!resume.promptViaPty) {
      // P0a: forward the detached turn's eventual exit to the outcome handler (if any).
      // Bound to THIS delivery `d` so the handler can attribute a loop-sourced death to
      // its routine. The delivery is still 'delivered' the instant a PID lands — the
      // observation is asynchronous + additive, never on the delivery's hot path.
      const onExit = deps.onResumeTurnExit
        ? (exit: ResumeTurnExitRaw) => deps.onResumeTurnExit!(d, exit)
        : undefined;
      const pid2 = spawnDetached(resume.bin, resume.args, { cwd, env }, onExit);
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
        const injected = await injectOmpWakeTurnWhenReady({ pty: h, wakeText: text, write });
        if (!injected.ok) {
          try {
            kill(h.id);
          } catch {
            /* best-effort cleanup of a non-ready resume pty */
          }
          const tail = injected.transcriptTail ? ` transcript tail: ${JSON.stringify(injected.transcriptTail.slice(-1000))}` : '';
          return { kind: 'error', error: `${injected.error}.${tail}` };
        }
      }
      return { kind: 'delivered', channel: 'resume' };
    } catch (err) {
      return { kind: 'error', error: `resume spawn failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
