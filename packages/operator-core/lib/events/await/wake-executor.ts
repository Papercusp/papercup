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
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveInheritedOperatorBaseUrl } from '../../mcp-base-url';
import { capInjectionText, computeTurnDoors } from '../../context-doors';
import { getDoorConstantsSync } from '../../context-doors-config';
import {
  sessionClaudeConfigDir,
  sessionMcpJsonPath,
  codexHomeForSessionKey,
} from '@papercusp/orchestrator/session-launch-dirs';
import { nativeSchedulerDenyFlag } from '@papercusp/orchestrator/native-scheduler-deny';
import { noSubagentToolsDenyFlag } from '@papercusp/orchestrator/no-subagent-deny';
import { readFleetClaudeToken } from '@papercusp/orchestrator/fleet-claude-token';
import { getAdvSession } from '../../adv-sessions';
import { resolveAgentBinarySync } from '../../agent-bin-detect';
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
import {
  getSessionBriefLifecycle,
  type SessionBriefLifecycle,
} from '../../session-brief';
// EI-20489286325396940: `payloadIsTimeout` + `wakeSummaryHeadline` live in
// timeout-fallback.ts (PG-free, beside the other timeout wording) so engine.ts can
// import the summary renderer WITHOUT going through this module — engine.test.ts
// mocks './wake-executor' wholesale, which silently undefined-ed it and deleted the
// park nudge inside a best-effort catch.
import { payloadIsTimeout, wakeSummaryHeadline } from './timeout-fallback';
import { prepareCellWakeFold } from './cell-wake-fold';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import {
  findLiveHost,
  injectIntoHost,
  injectIntoHostWithConfirmation,
  type InjectConfirmation,
} from './psu-pty-discovery';
import {
  decideColdWake,
  readColdLoopMarker,
  renderColdWakeInjection,
  COLD_NOTE_POST_TURN_FLOOR_MS,
  type ColdWakeDecision,
} from '../../su-cold-loop';
import {
  getLoopCarryNote,
  getLoopCarryNoteWithMeta as defaultGetLoopCarryNoteWithMeta,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
} from '../../carry-note';
import {
  clipLoopCheckpointForWake,
  renderLoopChecksBlock,
  renderLoopWallsBlock,
} from '../../harness/routines/loop-fire';
import { getLoopStatus, countAgentToolCallsInWindow } from '../../harness/routines/loop';
import {
  formatEnvelope,
  mintNonce,
  tagTurnForInjection,
} from '../../turn-provenance/turn-provenance';
import { isInboxOwnerReplyPayload } from '../../agent-tools/coordination/inbox-reply';
import {
  readOwnerChatTurnText,
  ownerChatTurnText,
  OWNER_CHAT_TURN_ORIGIN,
} from '../../agent-tools/coordination/owner-chat-turn';
import type { ResumeTurnExitRaw } from './resume-turn-outcome';
import type { DeliveryWork, WakeChannel, WakeOutcome } from './types';

/** Bounded output-tail capture for an observed resume turn (P0a). The CLIs print
 *  API errors (incl. the 429 / usage-limit lines) to STDOUT; the dying turn's error
 *  is at the END of its output, so a tail is enough to classify it. */
const RESUME_OUTPUT_TAIL_BYTES = Number(process.env.PAPERCUSP_RESUME_OUTPUT_TAIL_BYTES) || 8192;

/** WI-666: bound the attended-loop recovery leg. A resumable loop owner may be
 * alive in a terminal the operator cannot inject, so send SIGINT and wait only
 * briefly for the current process to exit before falling back to the safe park.
 * The loop marker is the safety boundary: ordinary interactive sessions are
 * never force-interrupted by the wake pump. */
export const FORCE_RESUME_EXIT_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_WAKE_FORCE_RESUME_TIMEOUT_MS) || 2_000;
const FORCE_RESUME_POLL_MS = 50;

export function waitForProcessExit(
  pid: number,
  alive: (pid: number | null) => boolean,
  timeoutMs = FORCE_RESUME_EXIT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      resolve(exited);
    };
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const poll = () => {
      let stillAlive = true;
      try {
        stillAlive = alive(pid);
      } catch {
        stillAlive = true;
      }
      if (!stillAlive) {
        finish(true);
        return;
      }
      if (Date.now() >= deadline) {
        finish(false);
        return;
      }
      pollTimer = setTimeout(poll, FORCE_RESUME_POLL_MS);
      pollTimer.unref?.();
    };
    poll();
  });
}

async function defaultForceResume(
  pid: number,
  alive: (pid: number | null) => boolean,
): Promise<boolean> {
  try {
    // SIGINT ends the current CLI turn while preserving the native session for
    // the normal headless resume leg below. It is intentionally not SIGTERM.
    process.kill(pid, 'SIGINT');
  } catch {
    // A race with natural exit is already a successful force-resume boundary.
    try {
      return !alive(pid);
    } catch {
      return false;
    }
  }
  return waitForProcessExit(pid, alive);
}

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
  // The operator services intentionally run with a stripped PATH. Resolve the
  // known agent CLIs through the shared resolver before spawning so an npm
  // install beside the node running the operator remains reachable even when
  // that node prefix is absent from the service environment. Keep arbitrary
  // commands (the real-subprocess test uses process.execPath) byte-identical.
  const spawnBin = resolveResumeSpawnBin(bin);
  const child = childSpawn(spawnBin, args, {
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

const RESUMABLE_AGENT_BINS = new Set(['claude', 'codex', 'omp']);

/** Resolve a headless-resume backend without changing arbitrary subprocesses. */
export function resolveResumeSpawnBin(bin: string): string {
  if (!RESUMABLE_AGENT_BINS.has(bin)) return bin;
  return resolveAgentBinarySync(bin) ?? bin;
}

/** A codex rollout filename ends `…-<uuid>.jsonl`; the trailing UUID is the
 *  conversation id `codex exec resume <uuid>` wants. */
const CODEX_ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_HISTORY_TAIL_BYTES = 1024 * 1024;

/**
 * Codex 0.144+ may persist the live thread in state_5.sqlite and remove the
 * rollout JSONL while keeping a bounded prompt history. Each history row is
 * stamped with the native `session_id`, which is exactly the id accepted by
 * `codex exec resume`. Read only the tail so a long-running session never puts
 * its whole history on the wake hot path.
 */
function findCodexHistorySessionId(codexHome: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(join(codexHome, 'history.jsonl'), 'r');
    const total = fstatSync(fd).size;
    const size = Math.min(total, CODEX_HISTORY_TAIL_BYTES);
    if (size <= 0) return null;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, total - size);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]?.trim()) continue;
      try {
        const row = JSON.parse(lines[i]) as { session_id?: unknown };
        if (typeof row.session_id === 'string' && CODEX_SESSION_UUID_RE.test(row.session_id)) {
          return row.session_id;
        }
      } catch {
        // The bounded tail may begin in the middle of a JSON line.
      }
    }
  } catch {
    // Absent/raced history is the normal pre-0.144 or not-yet-started case.
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close on a read-only diagnostic path.
      }
    }
  }
  return null;
}

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
  return (best as RolloutMatch | null)?.id ?? findCodexHistorySessionId(codexHome);
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


/** The per-agent inbox-wake key prefix (`coord:inbox-wake:<owner>`). Kept in
 *  lockstep with the canonical export in agent-tools/coordination/inbox-wake.ts —
 *  duplicated (not imported) ONLY to avoid the wake-executor → inbox-wake →
 *  engine → wake-executor import cycle (engine.ts imports THIS module; inbox-wake
 *  imports engine). Same "two owners, one string, in lockstep" pattern as
 *  TURN_SUBMIT_CR_DELAY_MS above. */
const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:';

/** Compose the single-line wake turn injected/submitted into the woken session. */
export function wakeTurnText(d: DeliveryWork): string {
  // EI-20130618357432548 — the owner's own chat-pane message is delivered AS the
  // turn, not wrapped in the machinery below. The wrapper is right for every
  // agent/system wake (it names the key, the delivery id and the reconcile rule),
  // and wrong for exactly this one case: the chat pane renders the agent's
  // transcript back to the owner, so the wrapper is what the OWNER ends up
  // reading in place of their own message — and its text is what defeated the
  // pane's echo absorption. Gated on the marker the authenticated owner-GUI send
  // path stamps (owner-chat-turn.ts); the same payload-marker gate the
  // inbox-owner-reply path already uses at tagWakeText below. Every other
  // delivery is byte-identical.
  const ownerChatText = readOwnerChatTurnText(d.payload);
  if (ownerChatText) return ownerChatTurnText(ownerChatText);

  const note = d.note ? ` (your note: ${d.note})` : '';
  const summary = d.summary ? ` — ${d.summary}` : '';
  const payload =
    d.payload != null ? ` payload: ${JSON.stringify(d.payload).slice(0, 400)}` : '';
  const timeout = payloadIsTimeout(d.payload)
    ? ' [TIMEOUT (fired_reason: timeout) — the event did NOT fire before your deadline;' +
      ' the awaited source did NOT complete]'
    : '';
  // EI-16648: an always-armed inbox-wake (`coord:inbox-wake:<owner>`) can be
  // CONSUMED late. A continuously-busy recipient's OWN periodic coord:inbox
  // polling may already have surfaced + acted on the quoted message before the
  // injected wake turn is drained from its CLI's input queue — a PUSH (wake
  // injection) vs PULL (the recipient's own inbox read) race, not a duplicate-row
  // or stale-pump bug (each delivery is distinct + fresh at fire time; the
  // staleness only emerges at consumption). Presenting the possibly-already-
  // handled `summary`/`payload` as fresh actionable work ("continue the work…")
  // then misleads the woken agent into re-doing handled mail. So for inbox-wake
  // keys ONLY, stamp a self-identifying reconciliation instruction (the EI-15799
  // precedent for the analogous stale cold-loop-wake delivery) — keep the quoted
  // body (useful when genuinely new) but tell the agent to reconcile against
  // coord:inbox before trusting it. The agent-facing inbox is a cursor-free
  // VIEW (D-013); only the delivery hook owns an internal floor. Every
  // non-inbox-wake key is byte-identical.
  const inboxWakeReconcile = d.eventKey.startsWith(COORD_INBOX_WAKE_PREFIX)
    ? ' NOTE (inbox-wake): the quoted message may ALREADY have been surfaced + handled by your own coord:inbox read before this wake was consumed — reconcile against coord:inbox\'s cursor-free VIEW and do NOT re-do handled mail or trust the quoted body as necessarily new.'
    : '';
  // P-006 (fleet-member-dx, EI-9018): `d.id` is the DELIVERY-LOG row id, not a
  // wake count — unlabeled "wake #12672" next to a loop's own "wake #5" read as
  // two contradictory counters and confused resuming agents. Label it as an id.
  const base = (
    `[await-event] ${d.eventKey} fired${timeout}${summary}.${note}${payload} ` +
    `(event-wake delivery #${d.id} — a delivery-log id, not your wake count; you registered this with events:await — continue the work that was waiting on it.)${inboxWakeReconcile}`
  ).replace(/\s*\n\s*/g, ' ');
  // Ambient-push rail (P-003) and the P-022 cell fold: prepared blocks ride the wake
  // injection. Appended AFTER the collapse so they keep their own line formatting;
  // both undefined on the default path ⇒ byte-identical. They then flow through
  // applyInjectionDoor. The cell fold goes FIRST: it re-answers the very value quoted
  // in `payload` above, so it belongs next to what it corrects, not below unrelated
  // ambient material.
  const blocks = [d.cellWakeFoldBlock, d.ambientPushBlock].filter((b): b is string => !!b);
  return blocks.length ? `${base}\n\n${blocks.join('\n\n')}` : base;
}

/**
 * EI-10935: a loop wake's `d.summary` (built by {@link wakeTurnText}, which embeds
 * loop-fire.ts's rendered checkpoint + walls block) is a SNAPSHOT taken at FIRE
 * time. If ACTUAL delivery is delayed — staged behind the manual wake-mode gate,
 * queued behind another delivery, retried after a missed inject, coalesced with a
 * later event — the agent may have written a NEWER `loop:checkpoint` (clearing an
 * owner-gated wall, updating its next-action) in the gap between fire and
 * delivery. The stale snapshot then RE-SERVES a CLEARED wall as still-open: a
 * live incident (2026-07-13) resurrected an irreversible-action wall the owner
 * had already cleared, risking either a re-run of the irreversible action or a
 * manufactured re-ask of consent already given. This is CRITICAL, not cosmetic —
 * walls exist precisely to survive context loss, and a wall surface that can't be
 * cleared is worse than none.
 *
 * Fix: at ACTUAL delivery time (inside `executeWake`, right before injection —
 * every channel: live psu-socket inject, plan-run resume, adv-session inject),
 * for a LOOP wake ONLY (`readColdLoopMarker` finds a `harness` on the payload —
 * stamped for BOTH warm and cold loops per loop-fire.ts), re-read the carry-note
 * FRESH and append a live re-check block. The block is appended EVEN WHEN walls
 * are now empty — silence there would NOT override a stale walls block rendered
 * above it, so "no open walls" must be stated explicitly, not omitted.
 *
 * A non-loop wake (marker null — the overwhelming majority of deliveries) is
 * BYTE-IDENTICAL: this returns `baseText` unchanged without ever reading the
 * carry-note store. Fail-soft end to end: any read/render error falls back to
 * the original text unmodified — a rehydration hiccup must never block or alter
 * a delivery that would otherwise have succeeded.
 *
 * EI-18825117783927950: the walls/checks re-read above fixes the CONTENT going
 * stale between fire and delivery, but not the loop's OWN lifecycle going stale
 * the same way — `loop:end` (or a re-arm) only stops *future* fires; a fire
 * already created and sitting gate-waited/queued when the owner ends (or
 * re-arms with a new goal) the loop still lands, carrying a FROZEN goal and the
 * imperative "this is the authority for what to do this wake" framing for a
 * loop that, by delivery time, no longer means that. Observed live: a session
 * called `loop:end`, was told "no further wakes will fire", and ~10min later
 * received exactly such a stale fire — avoided only by the receiving agent's
 * own suspicion. Since this function already runs at the true "about to
 * deliver" moment for every channel (live psu-socket inject, plan-run resume,
 * adv-session inject), it is the natural single choke point to ALSO re-check
 * the loop's current `active`/`armedAt` state and, if superseded, append an
 * unmissable banner stripping the stale imperative framing — same
 * annotate-don't-drop posture as the walls/checks re-check (a wake is never
 * silently swallowed; the agent is told plainly not to trust it).
 */
export async function rehydrateLoopWakeText(
  d: DeliveryWork,
  baseText: string,
  deps: {
    getLoopCarryNoteWithMetaFn?: typeof defaultGetLoopCarryNoteWithMeta;
    getLoopStatusFn?: typeof getLoopStatus;
  } = {},
): Promise<string> {
  try {
    const marker = readColdLoopMarker(d.payload);
    if (!marker?.harness) return baseText; // not a loop wake — untouched, no DB read
    const getNoteMeta = deps.getLoopCarryNoteWithMetaFn ?? defaultGetLoopCarryNoteWithMeta;
    const meta = await getNoteMeta({
      harness: marker.harness,
      ownerId: d.subscriberId,
      workspaceId: d.workspaceId,
    });
    const { walls } = splitCarryNoteWalls(meta.note);
    const wallsNow = renderLoopWallsBlock(walls) ?? '  (none open — any wall shown OPEN above has been CLEARED since)';
    // P-001 (cold-carry-system-hardening) delivery parity: the live re-read covers
    // carried checks too — a stale staged wake must not resurrect a cleared check
    // (or hide a fresh one) any more than a wall.
    const { checks } = splitCarryNoteChecks(meta.note);
    const checksNow = renderLoopChecksBlock(checks);
    const ageMs = meta.updatedAtMs != null ? Date.now() - meta.updatedAtMs : null;
    const ageStr = ageMs != null ? `${Math.max(0, Math.round(ageMs / 1000))}s` : 'unknown';

    // EI-20230529647745311: the re-check used to be appended after the fire-time
    // snapshot. The injection door intentionally keeps the HEAD and spills the TAIL,
    // so a delayed loop wake could still inject the old candidate/next-action while
    // the fresh read lived only in the spill file. Put the delivery-time state first
    // so the state that governs the turn survives the door. Keep the narrative note in
    // this high-priority block (not only walls/checks): those fields carry the candidate
    // and next action that a stale wake can otherwise resurrect.
    const liveNote = meta.note ? clipLoopCheckpointForWake(meta.note, 2_200) : null;
    const checkpointState = liveNote
      ? `Current verified loop:checkpoint (resolved at delivery for owner ${d.subscriberId}, harness ${marker.harness}):\n${liveNote}`
      :
        `⚠ NO delivery-time loop:checkpoint was found for owner ${d.subscriberId}, harness ${marker.harness}. ` +
        `If the wake text below contains a checkpoint, it is a stale fire-time snapshot; do not trust or re-execute it. ` +
        `Reconcile the carry-note store identity and write loop:checkpoint before ending this turn.`;

    // EI-18825117783927950: best-effort, SEPARATELY caught so a status-read hiccup
    // degrades only this banner, never the walls/checks rehydration above it.
    let supersededNote = '';
    try {
      const getStatus = deps.getLoopStatusFn ?? getLoopStatus;
      const status = await getStatus(d.subscriberId);
      if (!status || status.active === false) {
        supersededNote =
          `\n\n🛑 THIS LOOP WAS ENDED (loop:end) before this wake was actually delivered — it was queued while ` +
          `the loop was still active and only reached you afterward. The goal/checkpoint text above is FROZEN ` +
          `from before the end and is NOT authoritative: do not resume, re-open, or re-do work off it. Call ` +
          `loop:status to confirm before acting; if the loop's goal was already achieved, take no further ` +
          `action on it this turn.`;
      } else if (
        status.armedAt != null &&
        typeof d.createdAt === 'string' &&
        new Date(status.armedAt).getTime() > new Date(d.createdAt).getTime()
      ) {
        supersededNote =
          `\n\n🛑 THIS LOOP WAS RE-ARMED (loop:arm) after this wake was queued but before it was delivered — the ` +
          `goal/checkpoint text above is from the PRIOR arm and may no longer reflect the current goal. Call ` +
          `loop:status / coord:orient to read the CURRENT goal before treating the text above as authoritative.`;
      }
    } catch {
      /* best-effort — never blocks or alters the walls/checks rehydration above */
    }

    const liveRecheck =
      `🔄 LIVE RE-CHECK at actual delivery time (EI-10935 / EI-20230529647745311 — this delivery may have been ` +
      `queued/staged, so the checkpoint/walls text below can be a stale snapshot from when the wake FIRED, not ` +
      `from now). Freshest carry-note is ${ageStr} old.\n\n` +
      checkpointState +
      `\n\nCurrent open walls:\n${wallsNow}\n` +
      (checksNow ? `${checksNow}\n` : '') +
      `TRUST THIS BLOCK — it is the delivery-time re-read and outranks the fire-time snapshot below: do not re-execute an irreversible action ` +
      `or re-ask the owner about a wall not listed here.`;

    // Keep both the live state and a lifecycle supersession warning ahead of the
    // generic fire-time text. The latter is just as important to preserve: an ended
    // or re-armed loop must not be revived by a queued stale imperative.
    return `${liveRecheck}${supersededNote}\n\n${baseText}`;
  } catch {
    // The delivery itself remains fail-soft, but do not silently present a loop
    // snapshot as authoritative when the delivery-time read failed completely.
    return (
      `⚠ LOOP CHECKPOINT RE-CHECK FAILED at delivery time for owner ${d.subscriberId}. ` +
      `The checkpoint below may be stale; reconcile the loop:checkpoint store/identity before acting.\n\n${baseText}`
    );
  }
}

/** Injections door (deterministic-context-carry P-006 enforcement leg (b), plan D-007):
 *  the per-hop budget for machine-composed injected text. The FLOOR door — /26 lands
 *  virtually every fleet model AT the 8K floor (the brief's own observation), and the spill
 *  pointer preserves the full text for the models the floor over-trims. Resolved per
 *  delivery through the P-023 config surface (workspace defaults ⟵ the RECIPIENT
 *  session's override; fail-soft to this baked floor); `PAPERCUSP_INJECTION_DOOR_OFF=1`
 *  stays the operational kill-switch. */
function injectionDoorTokens(subscriberId: string | null | undefined): number {
  return computeTurnDoors(0, getDoorConstantsSync(subscriberId)).injections;
}

/**
 * Cap a composed wake text at the injections door, spilling the FULL original to a file
 * the recipient can read back (`~/.papercusp/wake-spills/<subscriber>/delivery-<id>.md`)
 * and appending a pointer line. A wake's unbounded fields (`summary` carries a loop's
 * whole carry-note; a coord body can ride a wake) previously injected without ANY cap —
 * the exact "injections" lane of the 2026-07-13 hop-budget analysis. FAIL-SOFT: a spill
 * write failure delivers the FULL untrimmed text (a lost wake tail is worse than a fat
 * hop), and the kill-switch env bypasses entirely. Applied BEFORE provenance tagging so
 * the envelope is never sheared.
 */
export function applyInjectionDoor(d: DeliveryWork, text: string): string {
  try {
    if (process.env.PAPERCUSP_INJECTION_DOOR_OFF === '1') return text;
    const doorTokens = injectionDoorTokens(d.subscriberId);
    const { kept, overflow } = capInjectionText(text, doorTokens);
    if (overflow == null) return text;
    const dir = join(homedir(), '.papercusp', 'wake-spills', String(d.subscriberId ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `delivery-${d.id}.md`);
    writeFileSync(
      file,
      `# Wake spill — delivery #${d.id} (event ${d.eventKey})\n\n` +
        `The injected wake exceeded the per-hop injection door (~${doorTokens} tokens); ` +
        `this file carries the FULL original text. Safe to delete after reading.\n\n---\n\n${text}\n`,
      { mode: 0o600 },
    );
    return (
      `${kept}\n[injection-door: wake text exceeded the ~${doorTokens}-token per-hop injection budget and was truncated; ` +
      `the FULL text is at ${file} — read it if this truncated tail matters for your next action.]`
    );
  } catch {
    return text;
  }
}

/**
 * turn-provenance P-002 (turn-provenance-owner-vs-agent-2026-07-11): envelope +
 * ledger-tag a wake turn BEFORE it is typed into a PTY / submitted as a resume
 * prompt, so the recipient's UserPromptSubmit hook classifies it as verified
 * agent-origin instead of owner input. Applied ONLY to PTY/prompt deliveries —
 * never to inbox bodies (coord messages carry native `from` provenance).
 * Origin: a loop fire's wake (cold-loop marker on the payload) tags `loop-fire`;
 * an owner-Inbox-authored reply wake (owner-inbox-single-pane-2026-07-17 D-006 —
 * `inbox-reply.ts`'s marker on the payload) tags `coord-inject:owner`; every
 * other await delivery tags `wake-pump`. Fail-soft by construction: a failed
 * ledger write still returns deliverable tagged text (the turn then shows as
 * UNVERIFIED at the hook — visible, never a dropped wake).
 */
function tagWakeText(d: DeliveryWork, text: string, tag: typeof tagTurnForInjection): string {
  const origin = readColdLoopMarker(d.payload)
    ? 'loop-fire'
    : // EI-20130618357432548: an owner CHAT-PANE turn is the same authority as an
      // owner INBOX reply — both are authored by the authenticated human through an
      // admin-only surface — so it mints the SAME existing distinguished origin
      // rather than a new one. Deliberately still ENROLLED: delivering it
      // unenveloped would classify it OWNER (interactive), and the admin route
      // accepts a no-Origin localhost POST, so that would let any agent curl an
      // owner-stamped turn (and thus an auto-registered mode grant) into a peer's
      // session. See owner-chat-turn.ts's SECURITY note.
      // EI-20135573616431912: the SHARED constant, not a literal — the owner's
      // chat pane hides every user turn whose origin is not this exact string,
      // so a drift between here and that filter would silently VANISH the
      // owner's own messages from their conversation.
      isInboxOwnerReplyPayload(d.payload) || readOwnerChatTurnText(d.payload)
      ? OWNER_CHAT_TURN_ORIGIN
      : 'wake-pump';
  try {
    return tag({ sid: d.subscriberId, origin, text }).taggedText;
  } catch {
    // The wake itself is fail-soft, but returning it without an envelope turns a
    // machine prompt into affirmative owner speech in every transcript reader.
    // Keep delivery moving with a syntactically valid, unverified envelope; the
    // prompt hook can classify it as unverified (there is no ledger row), while
    // owner-visible readers still fail closed on the non-owner origin.
    return `${formatEnvelope(origin, mintNonce())}\n${text}`;
  }
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
 *
 * Exported (EI-16559) so the pump's exhausted-retries path (engine.ts) can
 * reuse the SAME fallback for a delivery that keeps ERRORing until it burns
 * through MAX_ATTEMPTS — see that call site for why this was previously drop
 * -only and left `error`-exhausted deliveries silently 'dead'.
 */
export async function degradeToInboxOrDrop(
  d: DeliveryWork,
  reason: string,
  send: typeof sendMessage,
): Promise<WakeOutcome> {
  try {
    await send(inboxNotifierIdentity(d.workspaceId), {
      to: [d.subscriberId],
      summary: `${wakeSummaryHeadline(d.eventKey, d.payload)} — delivered to your coord inbox (${reason})`,
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
        // Machine-readable completion proof. A detached wake is not complete
        // merely because the wrapper exits zero: the outcome classifier requires
        // Codex's terminal `turn.completed` JSONL event and reopens/re-arms the
        // delivery when the marker is missing or `turn.failed` is emitted.
        '--json',
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

/** Parse the install slug out of a pot-operator adv_sessions label
 *  (`pot · <slug>/<role>`, set at spawn.ts on the bpkind=hive invoke). null when
 *  the row is not a pot operator.
 *  WI-3967: prefix corrected from the stale 'hive · ' literal to 'pot · ' —
 *  the hive→pot rename updated spawn.ts's WRITER (see its own comment) but this
 *  reader was left on the old prefix, so it silently matched ZERO real sessions
 *  and the "fresh-per-wake, never resumed" cutover below never fired post-rename. */
export function hiveInstallSlugFromLabel(label: string | null | undefined): string | null {
  const l = (label ?? '').trim();
  if (!l.startsWith('pot · ')) return null;
  const slug = l.slice('pot · '.length).split('/')[0]?.trim();
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
  /** EI-203843: durable release-latch read, before any wake reanimation. */
  getSessionLifecycle?: (ownerId: string) => Promise<SessionBriefLifecycle | null>;
  alive?: (pid: number | null) => boolean;
  /** WI-666: whether this owner has an active engine loop. Only loop owners
   *  are eligible for the bounded alive-but-uninjectable recovery leg. */
  isLoopArmed?: (ownerId: string) => Promise<boolean>;
  /** WI-666: injected force-resume seam for hermetic tests. */
  forceResume?: (pid: number) => Promise<boolean>;
  /** P-001 (wake-delivery-degradation-fix-2026-07-09): the coord-message send
   *  used to degrade a would-be DROP into a durable inbox notification.
   *  Injected for tests; defaults to the real sendMessage. */
  sendCoordMessage?: typeof sendMessage;
  /** turn-provenance P-002: the envelope+ledger tagger applied to every PTY/prompt
   *  wake delivery (never inbox bodies). Injected for tests (a hermetic test stubs
   *  it to avoid real ~/.papercusp/turn-provenance writes, or to a passthrough to
   *  assert un-tagged text); defaults to the real tagTurnForInjection. */
  tagTurn?: typeof tagTurnForInjection;
  resumePlanRun?: (input: { runId: number; wakeText: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** turn-lifecycle-control Phase 3 (P-014): discover + inject into a live
   *  psu-hosted managed-pty session's control socket. The operator can't see it
   *  via findPty — the pty lives in the psu process (D-006). */
  findPsuHost?: typeof findLiveHost;
  injectPsuHost?: typeof injectIntoHost;
  /** WI-6862: the confirmation-carrying transport used for a COLD context-reset, so the delivery
   *  ledger can distinguish a host ACK from the optimistic bare-close fallback. Defaults to the
   *  real one — but ONLY when no `injectPsuHost` stub was supplied, since a stub has no
   *  confirmation channel and must keep today's behavior. */
  injectPsuHostWithConfirmation?: typeof injectIntoHostWithConfirmation;
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
  /** deterministic-context-carry P-021: the verdict-gated cold-by-default resolver —
   *  given the wake target's live host view, decide whether its session CLASS is
   *  drill-proven cold (COLD_BY_DEFAULT_PROVEN_CLASSES flag + gradeColdBootDrills
   *  sufficientClasses + no active interactive exchange; su-cold-by-default.ts).
   *  DEFAULT ()=>false ⇒ only explicitly cold-armed loops ever cold (today's
   *  behavior) — engine.ts wires the real classDefaultColdForWake, mirroring
   *  coldAutoEnabled so this module stays flag-system-free. Read ONLY on a loop-
   *  marked wake with no explicit carry, AFTER the master gate passed. */
  classDefaultCold?: (host: {
    bridgeTty?: boolean | null;
    lastInputAt?: number | null;
  }) => Promise<boolean>;
  /** Read an su AUTO loop's carry-note — the P-006 cold-start anchor a RESET-CONTEXT /
   *  RECYCLE reconstructs from. Injected for tests; defaults to the real
   *  getLoopCarryNote (carry-note.ts). */
  getLoopCarryNoteFn?: (ref: {
    harness: string;
    ownerId: string;
    workspaceId?: string;
  }) => Promise<string | null>;
  /** EI-10935: read an su AUTO loop's carry-note WITH its write-instant, used at
   *  ACTUAL delivery time (not just fire time) by {@link rehydrateLoopWakeText}
   *  to re-check whether a queued/staged delivery's pre-rendered checkpoint/
   *  walls text is still current. Injected for tests; defaults to the real
   *  getLoopCarryNoteWithMeta (carry-note.ts). */
  getLoopCarryNoteWithMetaFn?: typeof defaultGetLoopCarryNoteWithMeta;
  /** WI-6860: read the subscriber's loop status (for `lastTurnAt`) — used ONLY by
   *  the EI-19294445744419497 un-checkpointed-work staleness hint to compare a
   *  cold carry-note's write instant against the subscriber's actual last turn.
   *  Injected for tests; defaults to the real getLoopStatus (harness/routines/loop.ts).
   *  Without this seam, the real getLoopStatus (which opens a live Postgres
   *  connection via getOrgPg) is unmockable, so any unit test that reaches this
   *  branch trips assertRealPgAllowed and fails via vitest-fail-on-console. */
  getLoopStatusFn?: typeof getLoopStatus;
  /** EI-19984789589075138: count agent-authored tool calls in the post-note window, to
   *  distinguish a genuine working turn from a usage-wall/withheld-fire bounce that still
   *  moves `lastRealTurnAt` but did zero work. Injected for tests (same unmockable-real-PG
   *  reason as getLoopStatusFn above); defaults to the real countAgentToolCallsInWindow
   *  (harness/routines/loop.ts). */
  countAgentToolCallsFn?: typeof countAgentToolCallsInWindow;
  /** compaction-continuity-hardening-2026-07-07 P-003: assemble the subscriber's
   *  carry BRIEF (held work-items + checkpoints, standing facts/walls, armed awaits,
   *  fleet pointer) appended to a COLD injection after the carry-note. Injected for
   *  tests; defaults to the real buildCarryBrief (carry-brief.ts). Best-effort — a
   *  failed read injects the note alone. */
  buildCarryBriefFn?: (
    ownerId: string,
    opts?: { workspaceId?: string },
  ) => Promise<import('../../carry-brief').CarryBrief>;
  /** ambient-semantic-push P-003: prepare + record the ambient teaser block that
   *  rides this wake's injection (default: real prepareAmbientPushBlock, imported
   *  lazily and ONLY when PAPERCUSP_AMBIENT_CURSOR is on). Inject a stub for tests;
   *  pass `null` to force-disable even with the flag on (hermetic tests that must
   *  not touch the ambient store). */
  prepareAmbientPushBlock?: ((input: { ownerId: string }) => Promise<string>) | null;
}

/**
 * The minimal live-host view the psu-host inject fork needs: the control socket
 * to write, plus the P-021 class-verdict fields (bridgeTty → session class;
 * lastInputAt → the active-interactive-exchange guard). A real PsuPtyHost
 * satisfies it; hermetic tests hand in a literal.
 */
type PsuInjectHostView = {
  sock: string;
  bridgeTty?: boolean | null;
  lastInputAt?: number | null;
};

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
  host: PsuInjectHostView,
  warmText: string,
  injectPsuHost: typeof injectIntoHost,
  deps: ExecuteWakeDeps,
): Promise<WakeOutcome | null> {
  const sock = host.sock;
  // WI-5510: read the loop-fire marker ONCE up front — both the warm and cold
  // branches below need {wakeCount, routineId} to stamp the delivery-side
  // stale-fire guard (psu-pty-host.mjs), not only the cold path's carry
  // decision. A non-loop wake (no marker) yields undefined for both — the
  // guard is then a no-op for this delivery, exactly like today.
  const loopMarker = readColdLoopMarker(d.payload);
  const fireNumber = loopMarker?.wakeCount;
  const routineId = loopMarker?.routineId;
  const injectWarm = async (): Promise<WakeOutcome | null> => {
    // EI-19311270129974785: thread this delivery's own durable id so a retry the
    // CLIENT believes is fresh (its ack-wait timed out, or the host's ack write
    // back failed) is recognized by the host as the SAME delivery it already
    // committed to, instead of injecting a second real duplicate turn.
    const ok = await injectPsuHost(sock, {
      mode: 'turn',
      data: warmText,
      fireNumber,
      routineId,
      ownerId: d.subscriberId,
      deliveryId: String(d.id),
    });
    return ok ? { kind: 'delivered', channel: 'psu-socket-inject' } : null;
  };

  let decision: ColdWakeDecision = { cold: false, reason: 'warm (cold fork not engaged)' };
  // EI-18224278118395857: the carry-note's absolute write instant, threaded into
  // renderColdWakeInjection so a cold successor can detect a note that went stale in
  // the fire→busy-gate-flush gap (see that function's `updatedAtMs` doc). null when
  // unknown (the getLoopCarryNoteFn test seam is note-only) ⇒ no stamp, byte-identical.
  let noteUpdatedAtMs: number | null = null;
  try {
    const marker = loopMarker;
    // Cheap short-circuit: only a harness-scoped LOOP wake can go cold — either
    // explicitly cold-armed (carry:'cold') or, P-021, a no-carry loop marker whose
    // session class is drill-proven cold-by-default. Anything else resolves nothing
    // (no flag read, no PG carry-note read) and warms.
    if (marker?.harness && (marker.carry === 'cold' || marker.carry === undefined)) {
      const coldEnabled = await (deps.coldAutoEnabled ?? (async () => false))();
      // P-021 verdict route: resolved ONLY behind the master gate, and only for a
      // loop wake WITHOUT an explicit carry (the opt-in route needs no verdict).
      // DEFAULT ()=>false keeps the fork dormant until engine.ts wires the real
      // resolver — mirroring coldAutoEnabled.
      const classDefaultCold =
        coldEnabled && marker.carry === undefined
          ? await (deps.classDefaultCold ?? (async () => false))(host)
          : false;
      if (marker.carry === 'cold' || classDefaultCold) {
        // Only pay the carry-note read when the master gate is actually on (P-006's
        // anchor is moot if cold-auto is disabled). A test-injected getLoopCarryNoteFn
        // seam is note-only (no meta stamp); the production read uses the META variant
        // (same pinned-then-newest precedence as getLoopCarryNote) so it ALSO carries
        // the write instant for the staleness stamp — no extra DB round-trip.
        let carryNote: string | null = null;
        if (coldEnabled) {
          if (deps.getLoopCarryNoteFn) {
            carryNote = await deps.getLoopCarryNoteFn({
              harness: marker.harness,
              ownerId: d.subscriberId,
              workspaceId: d.workspaceId,
            });
          } else {
            const meta = await (deps.getLoopCarryNoteWithMetaFn ?? defaultGetLoopCarryNoteWithMeta)({
              harness: marker.harness,
              ownerId: d.subscriberId,
              workspaceId: d.workspaceId,
            });
            carryNote = meta.note;
            noteUpdatedAtMs = meta.updatedAtMs;
          }
        }
        decision = decideColdWake({ payload: d.payload, coldEnabled, carryNote, classDefaultCold });
      }
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
    } catch (e) {
      // Note-only injection — but NEVER silently (EI-8593, then EI-11484: twice a
      // CarryBrief contract drift crashed the renderer here and this swallow hid a
      // fleet-wide loss of cold-wake continuity extras until a test caught it).
      console.warn('[wake-executor] cold carry-brief extras failed (note-only injection):', e as Error);
    }
    // turn-provenance P-002: the cold injection is composed HERE (not by the
    // callers, who tag the warm text) — tag it as a loop fire so the reset/
    // recycle continuation prompt classifies as verified agent-origin.
    // EI-15799: stamp the fire number into the cold-wake text so a receiving agent
    // (or the agent's own reconciliation) can detect a delivery that lagged past a
    // later fire — see renderColdWakeInjection's wakeCount doc. WI-5510 (the
    // follow-up EI-15799 left open): ALSO stamp {fireNumber, routineId} onto the
    // envelope itself (not just the text) so the delivery-side stale-fire guard
    // can DROP a superseded delivery instead of merely labeling it.
    const coldFireCount = loopMarker?.wakeCount;
    // EI-18224278118395857: pass the note's write instant so the cold injection stamps its
    // age — the successor's only signal that a late-flushed note may be stale (its transcript
    // is gone). Undefined on the note-only test-seam path ⇒ no stamp, byte-identical.
    // EI-19294445744419497: the note's write instant only tells the successor how OLD the
    // note is; this tells it whether the note is INCOMPLETE. A turn that completed after the
    // write is un-checkpointed work, so the note's "Next action" may already be done — the
    // near-miss that motivated this had a dead session's finished-and-committed work still
    // being advertised as the next thing to do. Only meaningful alongside the write instant
    // (the render compares the two), and strictly best-effort: a cold wake must never be
    // dropped or delayed for a staleness HINT.
    let lastTurnAtMs: number | null = null;
    if (noteUpdatedAtMs != null) {
      try {
        // WI-6860: go through the injectable seam (defaults to the real
        // getLoopStatus) instead of calling the direct import — the direct call
        // was unmockable and opened a real Postgres connection in unit tests.
        const st = await (deps.getLoopStatusFn ?? getLoopStatus)(d.subscriberId);
        // WI-6951: `lastRealTurnAt` (session_turn_journal only), NOT `lastTurnAt` — and
        // deliberately with NO `?? st.lastTurnAt` fallback, which would reintroduce the bug
        // on exactly the sessions that trip it. lastTurnAt unions in the '■ session ended'
        // lifecycle marker, which is a session DEATH; a cold reset kills its predecessor, so
        // that marker lands after the final loop:checkpoint and this check reported the kill
        // instant as "you completed a turn at …". Live on this very path (su-7854d874 fire
        // #12): note written 05:29:48Z, real last turn 05:30:24Z (36s later, inside the
        // floor), session-end marker 06:00:23Z — the successor was told it had 31m of
        // un-checkpointed work and spent its opening turn recovering work that never existed.
        // A null here correctly yields NO banner: absent a journal row we cannot show a turn
        // happened, and this is a HINT — silence beats a false alarm that trains readers to
        // skip the one case (a dead session's finished work still advertised) it exists for.
        lastTurnAtMs = st?.lastRealTurnAt ? new Date(st.lastRealTurnAt).getTime() : null;
        if (lastTurnAtMs != null && !Number.isFinite(lastTurnAtMs)) lastTurnAtMs = null;
      } catch (e) {
        console.warn('[wake-executor] cold last-turn read failed (staleness hint omitted):', e as Error);
      }
    }
    // EI-19984789589075138: only worth the extra query when the banner is actually about
    // to fire (postNoteMs would clear the floor) — mirrors renderColdWakeInjection's own
    // floor check so a routine cold wake (turn shortly after the note) never pays for it.
    let agentToolCallsSinceNote: number | null = null;
    if (
      noteUpdatedAtMs != null &&
      lastTurnAtMs != null &&
      lastTurnAtMs - noteUpdatedAtMs >= COLD_NOTE_POST_TURN_FLOOR_MS
    ) {
      try {
        agentToolCallsSinceNote = await (deps.countAgentToolCallsFn ?? countAgentToolCallsInWindow)(
          d.subscriberId,
          noteUpdatedAtMs,
          lastTurnAtMs,
        );
      } catch (e) {
        console.warn('[wake-executor] cold work-evidence read failed (banner unchanged):', e as Error);
      }
    }
    const coldText = tagWakeText(
      d,
      renderColdWakeInjection(
        decision.carryNote,
        extras,
        coldFireCount,
        noteUpdatedAtMs ?? undefined,
        lastTurnAtMs ?? undefined,
        agentToolCallsSinceNote,
      ),
      deps.tagTurn ?? tagTurnForInjection,
    );
    // WI-6862: book what we actually KNOW. injectIntoHost's bare boolean cannot tell a host ACK
    // from the optimistic bare-close fallback, and that fallback explicitly covers a host that
    // crashed or was killed mid-delivery after accepting the connection — precisely what a
    // provider usage-limit wall does to a respawn. So a cold context-reset that never re-execed
    // was booked status='delivered' and read back to whoever was diagnosing it as a clean
    // success (observed on WI-6852: a reset booked delivered at 02:58:02.883Z whose respawn hit
    // the wall at 02:58:07.310Z).
    //
    // The confirmation is only available from the REAL transport, so when a caller/test supplied
    // its own `injectPsuHost` stub we fall through to today's exact behavior rather than
    // inventing a confirmation we do not have — additive by construction, like the WI-6852
    // part-(a) watermark.
    const confirming = deps.injectPsuHostWithConfirmation ?? (deps.injectPsuHost ? null : injectIntoHostWithConfirmation);
    // EI-19311270129974785: same delivery-id dedup rationale as injectWarm above —
    // the cold reset/recycle path goes through the identical gated pipeline and
    // is exposed to the identical ack-loss-then-retry duplicate.
    const injectMsg = {
      mode: decision.mode,
      data: coldText,
      fireNumber: coldFireCount,
      routineId,
      ownerId: d.subscriberId,
      deliveryId: String(d.id),
    };
    let ok: boolean;
    let confirmation: InjectConfirmation | null = null;
    if (confirming) {
      const r = await confirming(sock, injectMsg);
      ok = r.ok;
      confirmation = r.confirmation;
    } else {
      ok = await injectPsuHost(sock, injectMsg);
    }
    if (ok) {
      // A re-exec the host never confirmed is reported as such instead of as a clean success.
      const unconfirmed = confirmation === 'assumed-close';
      const channel: WakeChannel =
        decision.mode === 'recycle'
          ? unconfirmed
            ? 'psu-socket-recycle-unconfirmed'
            : 'psu-socket-recycle'
          : unconfirmed
            ? 'psu-socket-reset-unconfirmed'
            : 'psu-socket-reset';
      return { kind: 'delivered', channel };
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
  findPsuHost: (ownerId: string) => PsuInjectHostView | null,
  injectPsuHost: typeof injectIntoHost,
  deps: ExecuteWakeDeps,
): Promise<WakeOutcome | null> {
  let host = findPsuHost(d.subscriberId);
  for (let attempt = 0; host && attempt < 2; attempt += 1) {
    const outcome = await injectPsuHostWake(d, host, warmText, injectPsuHost, deps);
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
  const getSessionLifecycle = deps.getSessionLifecycle ?? getSessionBriefLifecycle;
  const alive = deps.alive ?? pidAlive;
  const isLoopArmed =
    deps.isLoopArmed ??
    (async (ownerId: string) => Boolean((await getLoopStatus(ownerId).catch(() => null))?.active));
  const forceResume = deps.forceResume ?? ((pid: number) => defaultForceResume(pid, alive));
  const findPsuHost = deps.findPsuHost ?? findLiveHost;
  const injectPsuHost = deps.injectPsuHost ?? injectIntoHost;
  const fireHiveWake = deps.fireHiveWake ?? defaultFireHiveWake;
  const sendCoordMessage = deps.sendCoordMessage ?? sendMessage;
  const tagTurn = deps.tagTurn ?? tagTurnForInjection;
  const collectSessionFiles = deps.collectSessionFiles ?? defaultCollectSessionFiles;
  const rematerializeSession = deps.rematerializeSession ?? defaultRematerializeSession;
  const findArchivedSessionIdForAdv = deps.findArchivedSessionIdForAdv ?? defaultFindArchivedSessionIdForAdv;
  const rematerializeTimeoutMs = deps.rematerializeTimeoutMs ?? REMATERIALIZE_TIMEOUT_MS;

  try {
    // EI-203843: this is deliberately the first delivery decision. A queued
    // wake can outlive the stand-down cue by minutes (especially on a cold
    // carry respawn), so every handle-less/plan-run/pty/resume path must share
    // this terminal gate before it can inject, spawn, or resume anything.
    const lifecycle = await getSessionLifecycle(d.subscriberId).catch(() => null);
    const released = lifecycle?.released;
    if (released) {
      return {
        kind: 'drop',
        reason:
          `session ${d.subscriberId} is released from fleet ${released.fleet} ` +
          `(marked ${released.at} by ${released.by}) — end now; queued wake suppressed`,
      };
    }

    // Ambient-push delivery rail (ambient-semantic-push P-003) — DEFAULT-OFF behind
    // PAPERCUSP_AMBIENT_CURSOR. Best-effort: prepare + record the teaser block that
    // rides THIS wake's injection (capped by applyInjectionDoor below — the injection
    // door tally). The env check is BEFORE the dynamic import so the off-path loads no
    // ambient code, and the whole thing is fail-soft — an ambient fault never blocks a
    // wake. Skipped for a deps-overridden test harness that opts out.
    const ambientFlag = process.env.PAPERCUSP_AMBIENT_CURSOR;
    if ((ambientFlag === '1' || ambientFlag === 'true') && deps.prepareAmbientPushBlock !== null) {
      try {
        const prepare =
          deps.prepareAmbientPushBlock ??
          (await import('../../ambient-push-delivery')).prepareAmbientPushBlock;
        const block = await prepare({ ownerId: d.subscriberId });
        if (block) d.ambientPushBlock = block;
      } catch {
        /* ambient delivery must never break a wake */
      }
    }

    /**
     * P-022 / D-007 — fold the subscribed cell's DELIVERY-TIME reading into this wake.
     *
     * Here, and not at the fire site, is the whole point: `payload.observed` is a
     * fire-time snapshot and the fire→delivery gap is where it goes stale (a parked
     * session boots, a cold carry respawns, a busy session drains its queue first).
     * Same fail-soft contract as the ambient block above — the helper is TOTAL and
     * budget-bounded, so a slow or broken resolver costs this wake nothing.
     */
    try {
      const fold = await prepareCellWakeFold({ eventKey: d.eventKey, workspaceId: d.workspaceId });
      if (fold) d.cellWakeFoldBlock = fold;
    } catch {
      /* a fold must never break a wake */
    }

    const handle = d.wakeHandle;
    if (!handle) {
      // Registered without a resumable session (warned at registration). BUT a
      // live psu-pty host socket can still wake it in place — it injects into the
      // live session by ownerId and needs no resumable handle (EI-152: handle-less
      // always-armed inbox-wakes were parking even with a live socket available,
      // because the socket inject below sat under this early-return).
      const outcome = await injectPsuHostWakeWithReverify(
        d,
        tagWakeText(d, applyInjectionDoor(d, await rehydrateLoopWakeText(d, wakeTurnText(d), deps)), tagTurn),
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
      const planRunText = tagWakeText(
        d,
        applyInjectionDoor(d, await rehydrateLoopWakeText(d, wakeTurnText(d), deps)),
        tagTurn,
      );
      const r = await resumePlanRun({ runId: handle.runId, wakeText: planRunText });
      if (r.ok) return { kind: 'delivered', channel: 'plan-run-resume' };
      return { kind: 'error', error: r.error };
    }

    // ── adv-session handle ───────────────────────────────────────────────
    const fresh = await getSession(handle.advSessionId).catch(() => null);
    // The await/delivery plane is intentionally pinned to DEFAULT_COORD_WORKSPACE
    // (WI-3575), so d.workspaceId is the coordination workspace, not necessarily
    // the agent's tenant. A process-exit resume must re-export the persisted
    // adv-session workspace or a loop wake can silently relaunch the agent in
    // `default` even while its session row and coord identity remain correctly
    // scoped to another workspace.
    const sessionDelivery = fresh?.workspaceId
      ? { ...d, workspaceId: fresh.workspaceId }
      : d;
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

    const text = tagWakeText(
      sessionDelivery,
      applyInjectionDoor(sessionDelivery, await rehydrateLoopWakeText(sessionDelivery, wakeTurnText(sessionDelivery), deps)),
      tagTurn,
    );

    // Channel 1b (turn-lifecycle-control Phase 3, P-014): a live INTERACTIVE psu
    // session hosts its pty + control socket in the psu PROCESS (D-006), so our
    // findPty can't see it and the pid logic below would PARK it (or worse,
    // resume a concurrent second client). A live psu-pty host is the
    // authoritative "alive + injectable" signal — self-validating (host pid alive
    // + socket present) — so inject the wake turn in place; on any miss fall
    // through to the normal channels.
    const outcome = await injectPsuHostWakeWithReverify(
      sessionDelivery,
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
      // WI-666: a warm engine-loop owner is explicitly unattended and its
      // native session is resumable. If its process is alive but no longer
      // injectable (the detached-terminal / curl dead zone), end this turn
      // with a bounded SIGINT and continue through the normal resume leg once
      // the process exits. Ordinary interactive sessions stay parked: without
      // the active loop marker, forcing a live terminal would be unsafe.
      const resumable = Boolean(
        (handle.agent === 'claude' && (fresh?.sessionId ?? handle.sessionId)) ||
          (handle.agent === 'omp' && (fresh?.ompThreadId ?? handle.ompThreadId)) ||
          (handle.agent === 'codex' && (fresh?.sessionId ?? handle.sessionId)),
      );
      const loopArmed = resumable
        ? await withWakeTimeout(
            isLoopArmed(d.subscriberId),
            `loop status/${d.subscriberId}`,
            1_000,
          )
        : false;
      if (loopArmed === true) {
        const exited = await forceResume(pid).catch(() => false);
        if (exited) {
          isAlive = false;
        } else {
          return {
            kind: 'park',
            reason: `loop owner pid ${pid} stayed alive after bounded force-resume; parked safely for a later retry`,
          };
        }
      }
      if (!isAlive) {
        // The bounded force leg ended the old turn; continue to Channel 2
        // below instead of attempting a keystroke against a dead process.
      } else {
        // Channel 3: alive in a terminal we don't own, OR the live managed pty at
        // this pid belongs to a different agent (recycled pid, EI-151) — either
        // way not an injectable pty for THIS subscriber → park (+ inbox nudge).
        return { kind: 'park', reason: `session pid ${pid} alive but not an injectable managed pty for this subscriber` };
      }
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
    const freshTarget = freshContextWarmInjectTarget(sessionDelivery);
    if (freshTarget) {
      const forked = await runFreshContextWarmInject(sessionDelivery, freshTarget, deps.freshContext, (m) =>
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
      // legs that already set this). The event delivery's workspace is the flat
      // coordination workspace; use the persisted session scope for the child.
      PAPERCUSP_WORKSPACE: sessionDelivery.workspaceId,
      ...(fresh?.harnessSlug ? { PAPERCUSP_HARNESS_SLUG: fresh.harnessSlug } : {}),
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
    // Bug fix (found chasing a coord-wake papercusp-su MCP disconnect): this
    // env is inherited from the operator process, which some producers (e.g.
    // dbos/orchestrator-runner.ts) set to the full `.../api/mcp` endpoint
    // rather than a bare origin. claude's/omp's own `.mcp.json` templates
    // append `/api/mcp` themselves, so an inherited suffixed value doubles
    // into a 404ing `.../api/mcp/api/mcp` and the resumed session comes up
    // with zero papercusp-su tools. Normalize it down to a bare (proxy-routed)
    // origin before the child spawns.
    const normalizedOperatorUrl = resolveInheritedOperatorBaseUrl(process.env.PAPERCUSP_OPERATOR_URL);
    if (normalizedOperatorUrl) env.PAPERCUSP_OPERATOR_URL = normalizedOperatorUrl;
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
        ? (exit: ResumeTurnExitRaw) =>
            deps.onResumeTurnExit!(
              d,
              resumeAgent === 'codex' ? { ...exit, outputProtocol: 'codex-jsonl' } : exit,
            )
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
