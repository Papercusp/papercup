/**
 * psu-pty-host — the production managed-PTY host for interactive psu sessions
 * (turn-lifecycle-control-2026-06-08 Phase 3, P-012/P-013/P-014; D-006/D-011).
 *
 * Why: by default `psu` launches the agent with `stdio:'inherit'` straight into
 * the user's terminal, so the operator doesn't own its stdin — a wake can only
 * PARK + inbox-nudge the live session (wake-executor Channel 3: "alive but not
 * an injectable managed pty"). This module instead launches the agent attached
 * to a `@lydell/node-pty` managed pty and bridges the user's real TTY <-> the
 * pty, exposing an owner-only control socket. The operator reaches that socket
 * to INJECT a wake turn (or, Phase 4, an interrupt) into the LIVE session.
 *
 * Crucial ownership boundary (D-006): the pty + control socket live IN THE PSU
 * PROCESS, not the operator. The operator only CONNECTS to the socket; an
 * operator restart never disturbs the human's session. This sidesteps the
 * operator-lifecycle coupling an operator-hosted pty would have.
 *
 * Security (D-011): the control socket lets a connector inject keystrokes into
 * an agent running with permissions bypassed — an injected line is effectively
 * command execution as this user. So the dir is 0700, the socket is 0600, and a
 * tight umask wraps the bind so the node is never even briefly world-accessible.
 * Same-UID is the OS boundary; per-agent auth/audit/rate-limit is layered on top
 * by the operator-mediated `turn:interrupt` tool (D-008, Phase 4).
 *
 * Discovery (P-014): the host writes a discovery file
 *   ~/.papercusp/psu-pty/<ownerId>.json  =  { ownerId, advSessionId, pid, ptyPid, sock, command, startedAt }
 * keyed by the session's coord ownerId (PAPERCUSP_SID — the same key the wake
 * handle joins on). The operator's wake-executor reads this dir to find a live
 * session's socket. The contract (dir + filename + {ownerId,pid,sock}) is
 * mirrored read-side in packages/operator-core/lib/events/await/psu-pty-discovery.ts —
 * keep the two in lockstep. A local-FS discovery file (not PG) is deliberate:
 * the socket is a same-host, process-lifetime-bound IPC resource that must be
 * removed on process exit, exactly like ~/.papercusp/voice-ipc.json /
 * embedded-pg.json.
 *
 * Derived from the validated psupty.mjs spike (which proved the feel + the
 * inject path end-to-end); this is the reusable, gated, operator-discoverable
 * version wired into psu-launcher's runWrapper.
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  chmodSync,
} from 'node:fs';
import net from 'node:net';

const require = createRequire(import.meta.url);

/** This script's own directory — used to locate sibling scripts (the session-compacted
 *  emit CLI) and the checkout root. */
const HOST_SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** The discovery dir. Owner-only (0700). Shared contract with the read side
 *  (operator-core psu-pty-discovery.ts). */
export const PSU_PTY_DIR = join(homedir(), '.papercusp', 'psu-pty');

/** How long the host waits for the user's input line to go idle before writing
 *  an injected turn into the pty (P-013 mid-keystroke safety). A burst of typing
 *  defers the inject until this much quiet has passed. */
const DEFAULT_IDLE_MS = Number(process.env.PAPERCUSP_PSU_PTY_IDLE_MS) || 750;
/** Cap on how long an inject will wait for idle before giving up and writing
 *  anyway — a wake must not be deferred forever by a user who keeps typing. */
const DEFAULT_IDLE_WAIT_CAP_MS = Number(process.env.PAPERCUSP_PSU_PTY_IDLE_CAP_MS) || 8_000;

/** After writing an injected TURN's text, the host sends the submit Enter (CR)
 *  as a SEPARATE keystroke this long later. A single `text + CR` burst is
 *  swallowed by the Claude Code TUI's paste detector — the CR lands as a literal
 *  newline in the input box and the turn sits UNSUBMITTED until a human presses
 *  Enter ("the wake text appeared but the turn didn't start"). An isolated CR,
 *  arriving after the paste settles, registers as a real submit. */
const TURN_SUBMIT_CR_DELAY_MS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS) || 150;
/** Codex's compose box needs a longer settle before the submit CR. With the
 *  Claude-tuned delay, live coord injections can leave the text sitting in
 *  Codex's input box until a human presses Enter. */
const CODEX_TURN_SUBMIT_CR_DELAY_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS) || 500;
/** If Codex treats the first submit CR as paste/input, the text is visibly left
 *  in the compose box. A second delayed CR is the same manual action the user
 *  had to take, but delivered by the host. Codex-only; Claude/OMP stay single-CR. */
const CODEX_TURN_RESUBMIT_CR_DELAY_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS) || 300;

/** WI-2930 submit VERIFICATION. An injected submit's CR can be SWALLOWED on any
 *  backend — the paste-settle race exists on Claude too, and a compact/reset
 *  carry can be typed into a TUI whose submission is momentarily locked (the
 *  agent-busy gate reads "compaction done" off output-quiet, which a silent
 *  summarizer gap / the post-compaction context-restore can fake). The failure
 *  is invisible-but-fatal: the turn text sits staged in the composer and the
 *  session parks until a human presses Enter (owner-reported, 6h stall).
 *  So after the FINAL CR of any injected submit the host VERIFIES instead of
 *  firing-and-forgetting: it polls the pty-output activity for a bounded window
 *  and, at each poll that finds the output QUIET (no turn running — a submitted
 *  turn repaints continuously), injects one bare resubmit CR. A bare CR at an
 *  idle prompt with an EMPTY composer is a no-op, so a redundant resubmit is
 *  harmless; one with staged text is exactly the Enter a human would press. */
const SUBMIT_VERIFY_POLL_MS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS) || 5_000;
const SUBMIT_VERIFY_POLLS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS) || 6;
const SUBMIT_VERIFY_MAX_RESUBMITS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR) || 3;

/** Mid-turn inject safety (coord-wake-mid-turn-2026-06-30). A wake `turn` (text +
 *  CR) written into a TUI that is MID-TURN — the agent is generating / mid
 *  tool-call — wedges the turn: the line lands as queued/garbled input and the
 *  session needs a manual ESC to recover. THIS was the multi-recipient
 *  `coord:send {wake:'required'}` broadcast hang — a broadcast wakes/keeps-busy
 *  many sessions at once, so a wake is far more likely to land on a mid-turn
 *  recipient (and the always-armed inbox-wake await is re-armed on every tool
 *  call, so a working agent is still wakeable). The host's existing idle gate only
 *  defers on the HUMAN's keystrokes (makeIdleGate) — it never sees the agent's
 *  turn state. The pty OUTPUT stream IS that state: a generating agent repaints
 *  its TUI constantly (spinner / elapsed-time counter), an idle-at-prompt agent is
 *  silent (agent-liveness-heartbeat-hardening P-006). So the host ALSO defers a
 *  `turn` inject until the agent's output has been quiet this long — i.e. it is
 *  back at its prompt. Must exceed the agent's busy repaint cadence (Claude Code's
 *  elapsed counter repaints ~1/s) so a working agent never reads as idle. */
const OUTPUT_QUIET_MS = Number(process.env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS) || 1500;
/** Cap on how long a `turn` inject waits for the agent to return to its prompt.
 *  On cap we DO NOT write into the still-busy turn (that is the wedge) — we DROP
 *  the live inject: the wake message is already durably in the recipient's inbox
 *  and is seen on its next natural turn ("queue to next-turn", the sanctioned safe
 *  default). Generous by default so a normal multi-minute turn still gets a clean
 *  live re-invoke the moment it ends; only a pathologically long turn drops. */
const TURN_INJECT_BUSY_CAP_MS = Number(process.env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS) || 180_000;

/** RESET-CONTEXT settle (su-cold-auto-mode P-004a). After the host submits the
 *  context-clear command (`/clear`) it waits this long before typing the
 *  carry-note turn, so the TUI has processed the clear and repainted a fresh
 *  prompt. Too short and the carry text lands in the clearing/animating TUI;
 *  the clear itself is fast, so this is a repaint budget, not a compute one. */
const CLEAR_SETTLE_MS = Number(process.env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS) || 1_500;
/** After submitting `/compact`, how long to let the compaction START emitting before
 *  the host waits for it to COMPLETE (post-compaction auto-continuation, WI-1804). The
 *  wait-for-completion is the agent-output idle gate (agentBusyGate) — this start-delay
 *  only ensures the compaction's own output has begun, so the gate reads it as mid-turn
 *  rather than the pre-compaction at-prompt quiet. Distinct from CLEAR_SETTLE_MS: /clear
 *  is a fast repaint budget, /compact runs a summarizer (seconds-to-minutes, variable),
 *  so the carry-note is gated on completion, NOT a fixed settle.
 *
 *  WI-1872 (2), START-RACE: this used to be a bare fixed delay before the
 *  completion-wait began. If `/compact`'s own summarizer is slow to emit its
 *  first byte, the busy-gate's output-quiet check at the 2s mark can still read
 *  as quiet (pre-compaction idle, never updated) → the completion-wait resolves
 *  IMMEDIATELY, and the continuation types into a still-compacting/thinking TUI
 *  (wedge / lost turn). `waitUntilBusy` (below) turns this into a BOUNDED poll
 *  for the agent to actually go busy, falling back to the old fixed-delay
 *  behavior if busy is never observed (e.g. a CLI that doesn't repaint during
 *  compaction) — same default budget, strictly safer in the race case. */
const COMPACT_START_MS = Number(process.env.PAPERCUSP_PSU_PTY_COMPACT_START_MS) || 2_000;

/** WI-1872 (1), COMPLETION-CAP DROP: the completion-wait for `/compact` used to
 *  reuse TURN_INJECT_BUSY_CAP_MS (180s) — sized for a normal wake turn, not a
 *  summarizer over a large transcript. A compaction that runs longer than 180s
 *  hit the cap and silently DROPPED the carry-note (the loop then sat cold with
 *  no continuation). Give compaction its own, generous, env-tunable completion
 *  budget — separate from (and independent of) the wake-turn busy cap. */
const COMPACT_BUSY_CAP_MS = Number(process.env.PAPERCUSP_PSU_PTY_COMPACT_BUSY_CAP_MS) || 600_000;

/** How long a RECYCLE waits for the killed child to actually exit before it
 *  spawns the fresh one, so we never double-spawn into a still-dying pty
 *  (su-cold-auto-mode P-004b). Fail-safe: on cap we spawn anyway (the old pid is
 *  being torn down regardless). */
const RECYCLE_KILL_TIMEOUT_MS = Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_KILL_MS) || 5_000;

/** WI-1941: total wall-clock budget the recycle carry-note inject retries across
 *  before it is dropped LOUDLY. A fresh COLD child can stay busy past one
 *  agent-busy cap (large compacted-context replay, MCP load, an auto-continued
 *  boot turn) and THEN settle — the old single-shot waitAtPrompt() dropped the
 *  iteration SILENTLY the instant it first deferred ('the wc8 recycle left no
 *  trace'). Generous, but kept < the loop interval so a retry can't outrun the
 *  next scheduled wake. Env-overridable like the sibling timings. */
const RECYCLE_CARRY_INJECT_BUDGET_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS) || 600_000;
/** Backoff between deferred carry-inject attempts (WI-1941). Each attempt's
 *  agent-busy cap already paces the bulk of the wait; this just avoids a tight
 *  requeue when an attempt defers fast. */
const RECYCLE_CARRY_RETRY_BACKOFF_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS) || 3_000;

/** Filename-safe key for an ownerId (SIDs are already `[a-z0-9-]`-ish, but a
 *  defensive sanitize keeps a stray char from escaping the dir). Pure. */
export function sanitizeKey(ownerId) {
  return String(ownerId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** Control-socket path for an ownerId. Pure. */
export function socketPathFor(ownerId) {
  return join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
}

/** Discovery-metadata path for an ownerId. Pure. */
export function metaPathFor(ownerId) {
  return join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
}

/** Is a pid alive? (signal 0 probe.) */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not ours (shouldn't happen same-UID); treat as alive.
    return e && e.code === 'EPERM';
  }
}

function ensureDir() {
  mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(PSU_PTY_DIR, 0o700);
  } catch {
    /* best-effort on a pre-existing dir */
  }
}

/** Read every discovery file; annotate each with `alive`. Skips unreadable. */
export function listHosts() {
  const out = [];
  let names;
  try {
    names = readdirSync(PSU_PTY_DIR);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(PSU_PTY_DIR, f), 'utf8'));
      meta.alive = pidAlive(meta.pid) && !!meta.sock && existsSync(meta.sock);
      meta.metaPath = join(PSU_PTY_DIR, f);
      out.push(meta);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Remove discovery files + sockets whose host process is gone. */
export function pruneDead() {
  for (const m of listHosts()) {
    if (pidAlive(m.pid)) continue;
    for (const p of [m.sock, m.metaPath]) {
      try {
        if (p && existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * The mid-keystroke idle gate (P-013). `touch()` on every stdin byte records
 * activity; `waitIdle()` resolves once `idleMs` of quiet has elapsed (or the cap
 * is hit). Pure-ish (uses timers + an injectable clock for tests).
 */
export function makeIdleGate({ idleMs = DEFAULT_IDLE_MS, capMs = DEFAULT_IDLE_WAIT_CAP_MS, now = Date.now } = {}) {
  let lastActivity = 0; // never-typed => immediately idle
  return {
    touch() {
      lastActivity = now();
    },
    /** ms until idle from `t` (0 = idle now). Pure helper, exported for tests. */
    remainingIdleMs(t = now()) {
      const since = t - lastActivity;
      return since >= idleMs ? 0 : idleMs - since;
    },
    /** Resolve once the input line has been idle for idleMs (bounded by capMs). */
    async waitIdle() {
      const deadline = now() + capMs;
      // Re-check in case typing continues during a wait.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const rem = this.remainingIdleMs();
        if (rem <= 0) return { deferred: false };
        if (now() >= deadline) return { deferred: true, reason: 'idle-cap' };
        const wait = Math.min(rem, Math.max(0, deadline - now()));
        await new Promise((r) => setTimeout(r, Math.max(10, wait)));
      }
    },
  };
}

/**
 * Session activity tracker (agent-liveness-heartbeat-hardening-2026-06-12
 * P-006): the OUTPUT-side sibling of makeIdleGate. The pty stream is a true
 * mid-turn signal — a generating agent repaints its TUI constantly — so
 * `lastOutputAt` distinguishes *generating* from *idle-at-prompt*, which
 * process-aliveness alone cannot. ANNOTATE-ONLY by design (plan D-002):
 * this feeds the discovery file / roster display, never the claim-release
 * rule — an attended-but-quiet session keeps its claims.
 * Pure (injectable clock); exported for tests.
 */
export function makeActivityTracker({ now = Date.now } = {}) {
  let lastInputAt = 0;
  let lastOutputAt = 0;
  return {
    touchInput() {
      lastInputAt = now();
    },
    touchOutput() {
      lastOutputAt = now();
    },
    snapshot() {
      return {
        lastInputAt: lastInputAt || null,
        lastOutputAt: lastOutputAt || null,
        lastActivityAt: Math.max(lastInputAt, lastOutputAt) || null,
      };
    },
  };
}

/**
 * Agent-busy (mid-turn) inject gate (coord-wake-mid-turn-2026-06-30). The
 * OUTPUT-side sibling of makeIdleGate: makeIdleGate defers a `turn` while the
 * HUMAN is mid-keystroke; THIS gate defers it while the AGENT is mid-turn. A
 * `turn` (text + CR) written into a generating TUI wedges it (needs ESC) — so we
 * hold the inject until the agent is back at its prompt, read off the pty output
 * stream (the established mid-turn signal — makeActivityTracker, P-006).
 *
 *   lastOutputAt() → ms epoch of the agent's most recent pty output (0 = none yet,
 *                    treated as "quiet"/at-prompt).
 *   waitAtPrompt() → resolves { deferred:false } once output has been quiet for
 *                    quietMs (agent at prompt → safe to inject), or
 *                    { deferred:true, reason:'agent-busy' } if the agent stays busy
 *                    past capMs (caller SKIPS the live inject; the durable inbox
 *                    message stands for the next natural turn).
 *
 * Pure (injectable clock + getter); exported for tests.
 */
export function makeAgentBusyGate({
  lastOutputAt,
  quietMs = OUTPUT_QUIET_MS,
  capMs = TURN_INJECT_BUSY_CAP_MS,
  now = Date.now,
} = {}) {
  const getLast = typeof lastOutputAt === 'function' ? lastOutputAt : () => 0;
  return {
    /** ms the agent output has been quiet (huge when never seen ⇒ at-prompt).
     *  Pure helper, exported for tests. */
    quietForMs(t = now()) {
      return t - (getLast() || 0);
    },
    /** Resolve once output has been quiet for quietMs (agent at its prompt), or
     *  defer after capMs (agent still mid-turn — drop the live inject).
     *  WI-1872 (1): `overrideCapMs` lets a caller use a DIFFERENT completion
     *  budget than this gate's own construction-time `capMs` (e.g. compaction's
     *  generous COMPACT_BUSY_CAP_MS vs the wake-turn's TURN_INJECT_BUSY_CAP_MS)
     *  without needing a second gate instance over the same activity tracker. */
    async waitAtPrompt(overrideCapMs) {
      const effectiveCapMs = overrideCapMs ?? capMs;
      const deadline = now() + effectiveCapMs;
      // Re-check in case the agent keeps emitting during the wait.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const quietFor = this.quietForMs();
        if (quietFor >= quietMs) return { deferred: false };
        if (now() >= deadline) return { deferred: true, reason: 'agent-busy' };
        const need = quietMs - quietFor;
        const wait = Math.min(need, Math.max(0, deadline - now()));
        await new Promise((r) => setTimeout(r, Math.max(10, wait)));
      }
    },
    /** WI-1872 (2): the START-RACE fix. Resolves as soon as output goes BUSY
     *  (quietForMs drops below quietMs — the agent started emitting), so a
     *  caller can safely gate the NEXT wait (waitAtPrompt, for completion) on
     *  actual activity instead of a fixed delay. Falls back to `{ started:
     *  false }` after `capMs` if busy is never observed — the caller should
     *  treat that exactly like the old fixed-delay behavior (proceed anyway;
     *  the completion-wait's own quiet check still protects against writing
     *  into a truly still-busy TUI). Pure — exported via the gate object. */
    async waitUntilBusy(capMs) {
      const deadline = now() + capMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.quietForMs() < quietMs) return { started: true };
        if (now() >= deadline) return { started: false };
        await new Promise((r) => setTimeout(r, Math.max(10, Math.min(50, deadline - now()))));
      }
    },
  };
}

/**
 * Submit verifier (WI-2930) — the POST-submit sibling of makeAgentBusyGate. The
 * gates above decide when it is safe to WRITE an injected turn; nothing verified
 * the submit actually TOOK (the CR can be swallowed by paste-settle, or land in a
 * briefly-locked TUI right around a compaction). This polls the output activity
 * for a bounded window after the final CR and, at each poll that finds the output
 * quiet (no turn running), writes one bare resubmit CR — capped, and harmless
 * when the composer is empty.
 *
 * Deliberately NO early-exit on a busy observation: around a compaction, "busy"
 * can be residual summarizer/context-restore output resuming after the quiet gap
 * that let the carry through — exactly the trap that strands the text. Polling
 * the full window costs seconds on a rare path and covers it.
 *
 * Human-input abort: any human keystroke after verification starts cancels the
 * remaining polls (never fight a human who is editing the staged line —
 * `lastInputAt` is the same signal makeIdleGate defers on).
 *
 * Pure (injectable clock/sleep + getters); exported for tests.
 */
export function makeSubmitVerifier({
  lastOutputAt,
  writeCr,
  lastInputAt = () => 0,
  quietMs = OUTPUT_QUIET_MS,
  pollMs = SUBMIT_VERIFY_POLL_MS,
  polls = SUBMIT_VERIFY_POLLS,
  maxResubmits = SUBMIT_VERIFY_MAX_RESUBMITS,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onResubmit = () => {},
} = {}) {
  const getOut = typeof lastOutputAt === 'function' ? lastOutputAt : () => 0;
  const getIn = typeof lastInputAt === 'function' ? lastInputAt : () => 0;
  return {
    /** Poll for the verify window; resubmit a bare CR at each quiet observation.
     *  Returns { polls, resubmits, aborted } (aborted = 'human-input' | null). */
    async verify() {
      const inputAtStart = getIn() || 0;
      let resubmits = 0;
      let i = 0;
      for (; i < polls; i++) {
        await sleep(pollMs);
        if ((getIn() || 0) > inputAtStart) return { polls: i + 1, resubmits, aborted: 'human-input' };
        const quietFor = now() - (getOut() || 0);
        if (quietFor < quietMs) continue; // output flowing — a turn is running
        if (resubmits >= maxResubmits) break;
        resubmits++;
        try {
          writeCr();
        } catch {
          /* child may have exited mid-verify */
        }
        onResubmit(resubmits);
      }
      return { polls: i, resubmits, aborted: null };
    },
  };
}

/** How often the discovery file's activity fields are refreshed. Coarse on
 *  purpose — the consumer question is "active or idle for minutes?", and a
 *  per-byte rewrite would turn the pty bridge into an fs hot loop. */
export const ACTIVITY_PERSIST_MS = 15_000;

/**
 * Control-socket wire protocol (v1). A connector writes ONE UTF-8 payload then
 * half-closes. If it parses as a `{ v:1, mode, data }` envelope we act on the
 * mode; otherwise the whole payload is treated as a legacy idle-gated turn (so
 * the psupty spike's raw `text\r` inject still works).
 *
 *   mode:'turn' → a wake turn: idle-gated (P-013), then `data` + CR submits it.
 *   mode:'raw'  → verbatim + IMMEDIATE (bypasses the idle gate): force-interrupt
 *                 control bytes (Ctrl-C '\x03' / Esc '\x1b') for the
 *                 operator-mediated `turn:interrupt` (Phase 4, D-007). data is
 *                 written exactly, no CR appended.
 *
 * The read side (host server below) and the operator's connectors
 * (wake-executor + turn:interrupt) share this format — mirrored in
 * operator-core/lib/events/await/psu-pty-discovery.ts. Pure — exported for tests.
 */
export function encodeControl({ mode, data }) {
  return JSON.stringify({ v: 1, mode, data });
}

/** Parse a control payload into { mode, data, gated }. A non-envelope payload is
 *  a legacy idle-gated turn. Pure — exported for tests. */
export function decodeControl(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  try {
    const o = JSON.parse(text);
    if (
      o &&
      o.v === 1 &&
      (o.mode === 'turn' ||
        o.mode === 'raw' ||
        o.mode === 'osc' ||
        o.mode === 'reset' ||
        o.mode === 'recycle' ||
        o.mode === 'compact')
    ) {
      if (o.mode === 'raw') return { mode: 'raw', data: String(o.data ?? ''), gated: false };
      // osc = recolor escape bytes for the terminal DISPLAY (not the agent) —
      // ungated + immediate, routed to the host stdout (see the handler sink).
      if (o.mode === 'osc') return { mode: 'osc', data: String(o.data ?? ''), gated: false };
      // reset (RESET-CONTEXT) / recycle — the cold-auto verbs (su-cold-auto-mode
      // P-004). Both are GATED like a turn (P-006 clean-boundary: fire ONLY at a
      // settled turn, never mid-turn) — the host's idle + agent-busy gates defer
      // them exactly as they defer a wake turn. `data` is the carry-note the fresh
      // context opens on. reset = in-place `/clear` (drop transcript, keep the
      // process + MCP warm); recycle = kill + respawn the child in this same host.
      if (o.mode === 'reset') return { mode: 'reset', data: String(o.data ?? ''), gated: true };
      if (o.mode === 'recycle') return { mode: 'recycle', data: String(o.data ?? ''), gated: true };
      // compact (WI-1804): post-compaction auto-continuation. GATED like a turn (fire at a
      // settled turn, never mid-turn). `focus` = the `/compact <focus>` argument; `data` =
      // the carry-note the compacted context opens on (empty ⇒ a bare compact, no carry).
      if (o.mode === 'compact')
        return {
          mode: 'compact',
          data: String(o.data ?? ''),
          focus: o.focus != null ? String(o.focus) : '',
          gated: true,
        };
      return { mode: 'turn', data: String(o.data ?? ''), gated: true };
    }
  } catch {
    /* not an envelope — fall through to legacy */
  }
  return { mode: 'turn', data: text, gated: true };
}

/** The full logical bytes a decoded control message represents (raw: verbatim;
 *  turn: text + CR). Pure — kept for tests / one-shot external callers. NOTE the
 *  host no longer writes a turn in one shot; see controlWrites. */
export function controlBytes(decoded) {
  return decoded.mode === 'raw' ? decoded.data : `${decoded.data}\r`;
}

/** The ordered write STEPS the host performs against the pty for a decoded
 *  message. raw → ONE immediate verbatim write (force-interrupt byte). turn →
 *  TWO writes: the line text, then the submit Enter (CR) as a SEPARATE keystroke
 *  `crDelayMs` later — because a single `text + CR` burst is swallowed by the
 *  Claude Code TUI's paste detector (the CR becomes a literal newline and the
 *  turn never submits). Pure — exported for tests. */
export function controlWrites(decoded, crDelayMs = TURN_SUBMIT_CR_DELAY_MS) {
  // raw (force-interrupt byte) and osc (recolor bytes) are both ONE immediate
  // verbatim write — no idle gate, no submit CR.
  if (decoded.mode === 'raw' || decoded.mode === 'osc') return [{ data: decoded.data, delayMs: 0 }];
  return [
    { data: decoded.data, delayMs: 0 },
    { data: '\r', delayMs: crDelayMs },
  ];
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The submit delay is backend-specific because each interactive TUI has its
 *  own paste/compose handling. Keep the wire protocol backend-neutral; the
 *  hosting psu process already knows its child agent via PAPERCUSP_AGENT. */
export function turnSubmitCrDelayForAgent(agent, env = process.env) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'codex') {
    return positiveNumber(env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS, CODEX_TURN_SUBMIT_CR_DELAY_MS);
  }
  return positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS, TURN_SUBMIT_CR_DELAY_MS);
}

function codexTurnResubmitCrDelay(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS, CODEX_TURN_RESUBMIT_CR_DELAY_MS);
}

/** Backend-aware write plan for an injected turn. Codex receives one redundant
 *  delayed submit CR because the first CR can be consumed as input, leaving the
 *  turn text visible but unsent. A `reset` (RESET-CONTEXT) is a turn PREFIXED by
 *  the backend's context-clear command (see resetWritesForAgent). */
export function controlWritesForAgent(decoded, agent, env = process.env) {
  if (decoded.mode === 'raw' || decoded.mode === 'osc') return controlWrites(decoded);
  if (decoded.mode === 'reset') return resetWritesForAgent(decoded, agent, env);
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized !== 'codex') {
    return controlWrites(decoded, turnSubmitCrDelayForAgent(agent, env));
  }
  return [
    { data: decoded.data, delayMs: 0 },
    { data: '\r', delayMs: turnSubmitCrDelayForAgent(agent, env) },
    { data: '\r', delayMs: codexTurnResubmitCrDelay(env) },
  ];
}

/** The in-place context-clear command for a backend (su-cold-auto-mode P-004a).
 *  RESET-CONTEXT drops the grown transcript while keeping the process + MCP
 *  connections warm — the cheap per-wake cold path. Each interactive CLI exposes
 *  this as a slash command: Claude Code / OMP `/clear`; Codex starts a fresh
 *  conversation with `/new`. Pure — exported for tests. */
export function contextClearCommandForAgent(agent) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'codex') return '/new';
  return '/clear';
}

/** The RESET-CONTEXT settle window (repaint budget after the clear submits).
 *  Session-env tunable, module default as fallback. */
export function clearSettleMs(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS, CLEAR_SETTLE_MS);
}

/** The compaction command for a backend (post-compaction auto-continuation, WI-1804).
 *  Claude Code / OMP expose `/compact [focus]` — summarize-and-continue, the WARM sibling
 *  of /clear's cold reset (transcript is summarized, not dropped). Codex ALSO has a native
 *  `/compact` (verified against the installed 0.142.5 binary: compact.rs + the TUI command
 *  table) but it takes NO focus argument — its summarizer isn't steerable — so the focus
 *  hint is dropped. Until 2026-07-05 codex mapped to null, which silently no-op'd the
 *  watchdog force-compact rung AND session:request-compaction for every codex session
 *  (the tool still reported "queued"). Pure — exported for tests. */
export function compactCommandForAgent(agent, focus) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'codex') return '/compact';
  const f = String(focus ?? '').trim();
  return f ? `/compact ${f}` : '/compact';
}

/** The compaction START delay (WI-1804): after submitting /compact, wait this long so the
 *  compaction output has begun before gating on its COMPLETION. Env-tunable, module default
 *  as fallback. */
export function compactStartMs(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_COMPACT_START_MS, COMPACT_START_MS);
}

/** The compaction COMPLETION-wait budget (WI-1872 (1)): dedicated, generous cap for how
 *  long the host waits for a `/compact` to finish before dropping the carry-note — distinct
 *  from TURN_INJECT_BUSY_CAP_MS (sized for a normal wake turn, not a summarizer pass over a
 *  large transcript). Env-tunable, module default as fallback. */
export function compactBusyCapMs(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_COMPACT_BUSY_CAP_MS, COMPACT_BUSY_CAP_MS);
}

/** Absolute path to the session-compacted emit CLI (a sibling script, built by the
 *  event-await-discoverability plan / P-103). The host resolves it relative to itself so
 *  the same path works from the staging AND release checkouts. */
export const SESSION_COMPACTED_EMIT_ENTRY = join(HOST_SCRIPT_DIR, 'emit-session-compacted.ts');

/**
 * Fire the server-side `session:compacted:<owner>` event (event-await-discoverability
 * P-103) after a server-requested compaction COMPLETES, so a peer can
 * `events:await { event: "session:compacted:<owner>" }` instead of polling.
 *
 * THE BRIDGE: this host is a deliberately-minimal standalone process — it has NO PG pool
 * and NO operator HTTP client (see the imports: node fs/net/pty only), so it CANNOT emit
 * the event in-process. Instead it spawns a short-lived DETACHED `tsx` CLI
 * (SESSION_COMPACTED_EMIT_ENTRY) that DOES reach org-PG — the connection resolves via
 * ~/.papercusp/embedded-pg.json (or the native :5432 fallback), independent of this host's
 * env, so the CLI needs no DATABASE_URL handed to it. Compaction is rare, so the tsx
 * cold-start cost is acceptable.
 *
 * FAIL-SOFT + fire-and-forget: if the entry does not exist yet (CLI not landed), or tsx /
 * PG fail, nothing touches the live session. Only the CALLER's real-completion path invokes
 * this (never the done.deferred drop). Pure side-effect; returns the spawned child or null.
 */
export function fireSessionCompactedEvent(ownerId, focus, opts = {}) {
  const entry = opts.entry ?? SESSION_COMPACTED_EMIT_ENTRY;
  const spawnFn = opts.spawnFn ?? spawn;
  const exists = opts.existsFn ?? existsSync;
  if (!ownerId) return null;
  // Don't spawn a doomed process before the CLI has landed — a missing entry is the
  // expected state until the event-await plan's P-103 CLI ships.
  if (!exists(entry)) return null;
  try {
    const child = spawnFn('npx', ['tsx', entry, String(ownerId), String(focus ?? '')], {
      cwd: join(HOST_SCRIPT_DIR, '..', '..', '..'), // checkout root — where npx finds tsx
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    // A spawn error (npx/tsx missing) must never surface into the session.
    child.on?.('error', () => {});
    child.unref?.();
    return child;
  } catch {
    return null; // best-effort — the awaiter falls back to its own timeout / next signal
  }
}

/** The ordered write STEPS for a RESET-CONTEXT (su-cold-auto-mode P-004a): submit
 *  the backend's context-clear command, wait `clearSettleMs` for the TUI to
 *  repaint a fresh prompt, then type + submit the carry-note as the opening turn
 *  of the fresh context (the SAME per-agent paste-safe turn plan, its first write
 *  delayed by the settle). An empty carry ⇒ a bare clear (no opening turn). Pure —
 *  exported for tests. */
export function resetWritesForAgent(decoded, agent, env = process.env) {
  const clearCmd = contextClearCommandForAgent(agent);
  const steps = [
    { data: clearCmd, delayMs: 0 },
    { data: '\r', delayMs: turnSubmitCrDelayForAgent(agent, env) },
  ];
  if (!decoded.data) return steps; // bare clear — no carry turn to open on
  // The carry turn reuses the normal per-agent turn plan; its FIRST write waits
  // for the clear to settle so the text lands on the fresh prompt, not mid-clear.
  const turnPlan = controlWritesForAgent({ mode: 'turn', data: decoded.data }, agent, env);
  turnPlan[0] = { ...turnPlan[0], delayMs: clearSettleMs(env) };
  steps.push(...turnPlan);
  return steps;
}

/**
 * The OSC recolor bytes for a fleet-bound session, from the PAPERCUSP_FLEET_BG /
 * PAPERCUSP_FLEET_FG / PAPERCUSP_FLEET_CURSOR env vars bootstrap-su resolves from
 * the fleet's bound scheme — or null when the session has no fleet (leave the
 * terminal's profile default untouched). OSC 10 (fg) / 11 (bg) / 12 (cursor),
 * each BEL-terminated. This is the launch-time twin of operator-core
 * console-color-schemes.oscRecolorSequence (the runtime fleet:join path emits the
 * same bytes over the 'osc' control mode); inlined here so this plain-mjs host
 * needs no cross-package import — keep the OSC format in lockstep. Pure;
 * exported for tests + psu-launcher's no-pty fallback. */
export function fleetOscFromEnv(env = process.env) {
  const bg = env.PAPERCUSP_FLEET_BG;
  if (!bg) return null;
  const fg = env.PAPERCUSP_FLEET_FG;
  const cursor = env.PAPERCUSP_FLEET_CURSOR;
  let s = '';
  if (fg) s += `\x1b]10;${fg}\x07`;
  s += `\x1b]11;${bg}\x07`;
  if (cursor) s += `\x1b]12;${cursor}\x07`;
  return s;
}

/**
 * Connect to a live host's control socket and inject `text` as a submitted turn
 * (idle-gated). Used by tooling/tests; the OPERATOR's wake-executor implements
 * its own connect (it's TS in operator-core) to the SAME contract. Resolves true
 * on a clean write, false on connect error.
 */
export function injectTurn(sock, text) {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(encodeControl({ mode: 'turn', data: text }));
      c.end();
    });
    c.on('error', () => resolve(false));
    c.on('close', () => resolve(true));
  });
}

/**
 * Host `command args` through a managed pty, bridging the user's TTY and
 * exposing the control socket. Returns a Promise that resolves with the child's
 * exit code (the caller maps that to its own exit). The pty + socket live in
 * THIS process (D-006).
 *
 * @param {object} o
 * @param {string} o.command            binary to launch (the *-su wrapper / raw CLI)
 * @param {string[]} [o.args]           its args
 * @param {string} [o.cwd]              launch dir
 * @param {object} [o.env]              child env (must carry PAPERCUSP_SID = ownerId)
 * @param {string} o.ownerId            coord ownerId (PAPERCUSP_SID) — the discovery key
 * @param {number|string} [o.advSessionId]  adv_sessions row id, when known
 * @param {object} [o.io]               { stdin, stdout } override (tests); default process.*
 * @param {(code:number)=>void} [o.onExit]  exit handler; default process.exit
 * @param {boolean} [o.bridgeTty]       force the TTY bridge on/off; default = stdin.isTTY
 */
export function hostThroughPty(o) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    ownerId,
    advSessionId = null,
    // WI-1980: injected by the launcher so the host stays launcher-agnostic
    // (launcher imports host → importing back would cycle). `mintRecycleArgs`
    // rewrites the argv for a RECYCLE respawn (fresh --session-id); `onRespawn`
    // re-anchors that fresh native id → coord ownerId. Defaults keep the
    // standalone host + existing tests behavior-identical (same args, no anchor).
    mintRecycleArgs = (a) => ({ args: a, nativeId: null }),
    onRespawn = () => {},
  } = o;
  const stdin = o.io?.stdin ?? process.stdin;
  const stdout = o.io?.stdout ?? process.stdout;
  const onExit = o.onExit ?? ((code) => process.exit(code ?? 0));
  const bridgeTty = o.bridgeTty ?? !!(stdin.isTTY && typeof stdin.setRawMode === 'function');

  let pty;
  try {
    pty = require('@lydell/node-pty');
  } catch (e) {
    process.stderr.write(
      `psu: failed to load @lydell/node-pty (${e.message}); falling back to a plain launch is the caller's job.\n`,
    );
    throw e;
  }

  ensureDir();
  pruneDead();
  const sock = socketPathFor(ownerId);
  const metaPath = metaPathFor(ownerId);
  // A stale socket from a crashed prior session of the SAME owner would block
  // bind; remove it (pruneDead already cleared dead ones, but be defensive).
  for (const p of [sock]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  const ptyName = env.TERM || process.env.TERM || 'xterm-256color';
  /** Spawn the child agent under a fresh pty in THIS host. Reused on RECYCLE
   *  (su-cold-auto-mode P-004b): same command/args/cwd/env means PAPERCUSP_SID,
   *  locks, hooks, and the control socket all survive — only the process is new.
   *  Reads the CURRENT terminal size each spawn. */
  const spawnChild = (spawnArgs = args) =>
    pty.spawn(command, spawnArgs, {
      name: ptyName,
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      cwd,
      env,
    });
  let child;
  try {
    child = spawnChild();
  } catch (e) {
    process.stderr.write(`psu: failed to spawn '${command}' under a pty: ${e.message}\n`);
    throw e;
  }
  // RECYCLE state (su-cold-auto-mode P-004b). `recycling` guards the child-exit
  // handler so an intended kill+respawn does NOT tear the host down. The three
  // fns are (re)assigned below — declared here so the control-socket handler
  // (created before the teardown Promise) can close over them; they stay no-ops
  // until assigned, and a recycle cannot arrive before the socket is listening.
  let recycling = false;
  let wireChildData = () => {};
  let wireChildExit = () => {};
  let recycleChild = async () => {};

  // P-006: activity annotation rides the SAME discovery file — additive
  // fields only (the read-side contract in operator-core psu-pty-discovery.ts
  // tolerates their absence for files written by older hosts).
  const activity = makeActivityTracker();
  const baseMeta = {
    ownerId,
    advSessionId: advSessionId != null ? String(advSessionId) : null,
    pid: process.pid,
    ptyPid: child.pid,
    sock,
    command,
    args,
    startedAt: Date.now(),
    // Control-socket capabilities beyond the v1 base set (WI-1804). The operator reads
    // this (psu-pty-discovery.hostSupports) to decide whether to send mode:'compact'
    // (post-compaction auto-continuation) or fall back to a plain /compact turn on an
    // older host that has no `caps` field. Additive — grow this as new modes land.
    caps: ['compact'],
  };
  const writeMeta = () => {
    try {
      writeFileSync(metaPath, JSON.stringify({ ...baseMeta, ...activity.snapshot() }));
    } catch {
      /* best-effort — discovery degrades to the base contract */
    }
  };
  writeMeta();
  // Fleet color at launch (fleet-color-schemes): if bootstrap-su bound this
  // session to a fleet (PAPERCUSP_FLEET_BG/FG/CURSOR from the fleet's scheme),
  // recolor THIS window now by writing the OSC straight to our stdout (= the
  // visible terminal), so the window opens in the fleet color instead of the
  // gnome profile default. No fleet ⇒ no write (profile default stands). The
  // runtime fleet:join path reuses the same bytes via the 'osc' control mode.
  const launchOsc = fleetOscFromEnv(env);
  if (launchOsc) {
    try {
      stdout.write(launchOsc);
    } catch {
      /* best-effort — a recolor must never break the session */
    }
  }
  let lastPersisted = 0;
  const activityTimer = setInterval(() => {
    const snap = activity.snapshot();
    if ((snap.lastActivityAt ?? 0) > lastPersisted) {
      lastPersisted = snap.lastActivityAt ?? 0;
      writeMeta();
    }
  }, ACTIVITY_PERSIST_MS);
  if (typeof activityTimer.unref === 'function') activityTimer.unref();

  const idleGate = makeIdleGate();
  // Mid-turn inject gate (coord-wake-mid-turn-2026-06-30): reads the SAME
  // lastOutputAt the activity tracker records on every `child.onData` below, so a
  // wake `turn` is held until the agent is back at its prompt (output quiescent)
  // — never written into a live, mid-turn TUI (which wedges it, needs ESC). The
  // windows are read from the SESSION env (per-call, like turnSubmitCrDelayForAgent)
  // with the module-level defaults as fallback, so a launch can tune them.
  const turnInjectBusyCapMs = positiveNumber(env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS, TURN_INJECT_BUSY_CAP_MS);
  const agentBusyGate = makeAgentBusyGate({
    lastOutputAt: () => activity.snapshot().lastOutputAt ?? 0,
    quietMs: positiveNumber(env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS, OUTPUT_QUIET_MS),
    capMs: turnInjectBusyCapMs,
  });
  // WI-1941: recycle carry-inject retry budget + backoff (per-session tunable,
  // like the busy cap above). The fresh cold child gets this long to reach its
  // prompt across retried waitAtPrompt() attempts before the carry is dropped.
  const recycleCarryInjectBudgetMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS,
    RECYCLE_CARRY_INJECT_BUDGET_MS,
  );
  const recycleCarryRetryBackoffMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS,
    RECYCLE_CARRY_RETRY_BACKOFF_MS,
  );

  // WI-2930: verify every injected submit actually started a turn — resubmit a
  // bare CR at each quiet observation in a bounded post-submit window (see
  // makeSubmitVerifier). writeCr reads the live `child` closure so it survives a
  // recycle; a fresh verifier per call keeps the human-input abort baseline fresh.
  const verifySubmitted = async (label) => {
    const verifier = makeSubmitVerifier({
      lastOutputAt: () => activity.snapshot().lastOutputAt ?? 0,
      lastInputAt: () => activity.snapshot().lastInputAt ?? 0,
      writeCr: () => child.write('\r'),
      quietMs: positiveNumber(env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS, OUTPUT_QUIET_MS),
      pollMs: positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS, SUBMIT_VERIFY_POLL_MS),
      polls: positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS, SUBMIT_VERIFY_POLLS),
      maxResubmits: positiveNumber(
        env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR,
        SUBMIT_VERIFY_MAX_RESUBMITS,
      ),
      onResubmit: (n) => {
        try {
          process.stderr.write(
            `psu-pty-host: ${label} submit not confirmed for ${ownerId} — resubmit CR #${n} (WI-2930)\n`,
          );
        } catch {
          /* never let a diagnostic write break the session */
        }
      },
    });
    return verifier.verify();
  };

  // Control socket: a connector writes one v1 envelope (or legacy raw bytes);
  // we inject it into the pty (a wake turn / a force-interrupt control byte).
  // P-013: a 'turn' (wake) is deferred until the user's input line is idle so a
  // mid-keystroke human line is never corrupted; a 'raw' (force interrupt) is
  // written IMMEDIATELY (the whole point of force is to land mid-thinking).
  const server = net.createServer((conn) => {
    const chunks = [];
    conn.on('data', (d) => chunks.push(d));
    conn.on('error', () => {});
    conn.on('end', async () => {
      const payload = Buffer.concat(chunks);
      if (!payload.length) return;
      const msg = decodeControl(payload);
      try {
        if (bridgeTty && msg.gated) {
          // (1) Human keystroke gate (P-013): don't corrupt a line the user is
          // mid-typing. (2) Agent mid-turn gate (coord-wake-mid-turn-2026-06-30):
          // don't write a wake `turn` into a TUI that is still generating — that
          // wedges the turn (needs ESC), the multi-recipient broadcast hang.
          await idleGate.waitIdle();
          const atPrompt = await agentBusyGate.waitAtPrompt();
          if (atPrompt.deferred) {
            // Agent stayed mid-turn past the cap. DROP the live inject rather than
            // wedge the turn — the wake is already durably in the recipient's
            // inbox and is seen on its next natural turn (queue-to-next-turn).
            try {
              process.stderr.write(
                `psu-pty-host: wake turn DEFERRED for ${ownerId} ` +
                  `(agent mid-turn > ${turnInjectBusyCapMs}ms cap); ` +
                  `left in inbox for the next natural turn\n`,
              );
            } catch {
              /* never let a diagnostic write break the session */
            }
            return;
          }
        }
        // RECYCLE (su-cold-auto-mode P-004b): a hard cold reset — kill + respawn
        // the child in THIS host, then open the fresh process on the carry-note.
        // Handled specially (not a pty write); the gate above already guaranteed a
        // settled turn (D-006 clean-boundary). reset/turn/raw/osc fall through to
        // the write plan below.
        if (msg.mode === 'recycle') {
          await recycleChild(msg.data);
          return;
        }
        // COMPACT (post-compaction auto-continuation, WI-1804): the /compact WARM sibling
        // of reset's cold /clear. The gate above already guaranteed a settled turn. Then,
        // as ONE sequential operation (no second racing socket inject): (1) submit
        // `/compact <focus>`; (2) let the compaction START emitting; (3) wait for the
        // compaction TURN to COMPLETE via the output-idle gate — the ONLY observable
        // "compaction done" signal; (4) open the compacted context on the carry-note turn.
        // If the compaction outruns the busy cap we DROP the carry (never type into a
        // still-compacting TUI) — the agent's loop / next natural turn still resumes it.
        if (msg.mode === 'compact') {
          const compactCmd = compactCommandForAgent(env.PAPERCUSP_AGENT, msg.focus);
          if (!compactCmd) {
            // No compaction command for this backend — every KNOWN backend (claude/omp/
            // codex) has one, so this only guards a future backend. Surface the drop
            // rather than silently returning (the pre-2026-07-05 codex behavior:
            // request-compaction reported "queued" while nothing ever ran).
            try {
              process.stderr.write(
                `psu-pty-host: mode:compact DROPPED for ${ownerId} — backend '${env.PAPERCUSP_AGENT}' has no compaction command\n`,
              );
            } catch {
              /* diagnostic only */
            }
            return;
          }
          const submit = async (text) => {
            for (const step of controlWritesForAgent({ mode: 'turn', data: text }, env.PAPERCUSP_AGENT, env)) {
              if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
              child.write(step.data);
            }
          };
          // (1) submit /compact <focus> — VERIFIED (WI-2930): a swallowed CR here
          // would leave "/compact …" staged and, worse, let the quiet gate below
          // pass immediately and type the carry into the same stranded composer.
          await submit(compactCmd);
          await verifySubmitted('compact command');
          if (!msg.data) return; // bare compact — no continuation requested
          // (2) WI-1872 (2): wait for the compaction to actually go BUSY (bounded —
          // falls back to the old fixed compactStartMs(env) delay if busy is never
          // observed), instead of unconditionally sleeping a fixed delay and hoping
          // the compaction has started by then. Fixes the START-RACE: a slow-to-emit
          // summarizer used to still read as quiet at the fixed-delay mark, so the
          // completion-wait below resolved immediately and typed the continuation
          // into a still-compacting TUI.
          await agentBusyGate.waitUntilBusy(compactStartMs(env));
          // (3) wait through the compaction to completion (or DROP the carry on cap).
          // WI-1872 (1): a DEDICATED, generous completion budget (compactBusyCapMs),
          // not the wake-turn's TURN_INJECT_BUSY_CAP_MS — a large-transcript compaction
          // can legitimately run past 180s and used to be dropped silently on that cap.
          const compactCapMs = compactBusyCapMs(env);
          const done = await agentBusyGate.waitAtPrompt(compactCapMs);
          if (done.deferred) {
            try {
              process.stderr.write(
                `psu-pty-host: compact carry-note DROPPED for ${ownerId} ` +
                  `(compaction still running > ${compactCapMs}ms cap); ` +
                  `the agent's loop / next turn resumes it\n`,
              );
            } catch {
              /* never let a diagnostic write break the session */
            }
            return;
          }
          // (3.5) The compaction has REALLY completed (not the done.deferred drop above),
          // and — crucially — the carry-note is durably in place. Fire session:compacted so
          // any peer awaiting this member's compaction wakes now (event-await P-103). Emitted
          // ONLY here: the host observes completion only on the continuation path, and only a
          // settled, non-deferred compaction is a true "member compacted" signal.
          fireSessionCompactedEvent(ownerId, msg.focus);
          // (4) open the compacted context on the continuation turn — VERIFIED
          // (WI-2930): this is the exact write that stranded a builder for ~6h
          // when its CR landed in a briefly-locked post-compaction TUI.
          await submit(msg.data);
          await verifySubmitted('compact carry-note');
          return;
        }
        // mode:'osc' targets the terminal DISPLAY — the host's stdout IS the
        // visible window — so a fleet:join recolors the LIVE window. Every other
        // mode targets the agent's stdin (a wake turn / a force-interrupt byte).
        const sink = msg.mode === 'osc' ? stdout : child;
        // Deliver as ordered steps: a turn writes its text, THEN the submit CR as
        // a separate keystroke after a settle (controlWrites). A one-shot text+CR
        // burst is swallowed by the TUI's paste detector — the turn never submits
        // and the human has to press Enter.
        for (const step of controlWritesForAgent(msg, env.PAPERCUSP_AGENT, env)) {
          if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
          sink.write(step.data);
        }
        // WI-2930: a turn/reset submit targets the agent's stdin and must be
        // verified like the compact writes above (raw = control bytes and osc =
        // display bytes have no submit to verify).
        if (msg.mode === 'turn' || msg.mode === 'reset') {
          await verifySubmitted(`${msg.mode} inject`);
        }
      } catch {
        /* child may have exited mid-inject */
      }
    });
  });
  server.on('error', (e) => process.stderr.write(`psu: control socket error: ${e.message}\n`));
  // Tight umask around bind so the node is never even briefly world-accessible,
  // then pin 0600 (owner-only).
  const prevUmask = process.umask(0o077);
  server.listen(sock, () => {
    try {
      chmodSync(sock, 0o600);
    } catch {
      /* best-effort */
    }
    try {
      process.umask(prevUmask);
    } catch {
      /* ignore */
    }
  });

  // pty -> stdout (output bytes = the mid-turn signal, P-006). Re-attachable: a
  // RECYCLE (P-004b) spawns a fresh child and re-wires this bridge to it (node-pty
  // listeners are per-process). onStdin/onResize below read the live `child`
  // closure, so they need no re-wiring.
  wireChildData = () => {
    child.onData((d) => {
      activity.touchOutput();
      stdout.write(d);
    });
  };
  wireChildData();

  // stdin (raw) -> pty, tracking activity for the idle gate
  if (bridgeTty) {
    try {
      stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
  }
  if (typeof stdin.resume === 'function') stdin.resume();
  const onStdin = (d) => {
    idleGate.touch();
    activity.touchInput();
    try {
      child.write(d.toString('utf8'));
    } catch {
      /* ignore */
    }
  };
  stdin.on('data', onStdin);

  // terminal resize (SIGWINCH) -> pty resize
  const onResize = () => {
    const c = stdout.columns;
    const r = stdout.rows;
    if (c && r) {
      try {
        child.resize(c, r);
      } catch {
        /* ignore */
      }
    }
  };
  if (typeof stdout.on === 'function') stdout.on('resize', onResize);

  return new Promise((resolve) => {
    let cleaned = false;
    const cleanup = (code) => {
      if (cleaned) return;
      cleaned = true;
      if (bridgeTty) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      try {
        stdin.off?.('data', onStdin);
        stdin.pause?.();
      } catch {
        /* ignore */
      }
      try {
        stdout.off?.('resize', onResize);
      } catch {
        /* ignore */
      }
      try {
        clearInterval(activityTimer);
      } catch {
        /* ignore */
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
      for (const p of [sock, metaPath]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
      resolve(code ?? 0);
      onExit(code ?? 0);
    };

    // Child-exit wiring, re-attachable for RECYCLE (P-004b). Double-guarded so a
    // recycle's intended kill never tears the host down: (1) `recycling` skips the
    // exit that IS the recycle kill; (2) the per-child capture skips a superseded
    // (already-recycled-away) child whose exit event arrives late. Only the CURRENT
    // child's genuine exit runs cleanup.
    wireChildExit = () => {
      const thisChild = child;
      thisChild.onExit(({ exitCode }) => {
        if (recycling) return; // an intended recycle kill — respawn re-wires; host lives on
        if (child !== thisChild) return; // a superseded child that died late — ignore
        cleanup(exitCode);
      });
    };
    wireChildExit();

    // RECYCLE (su-cold-auto-mode P-004b): the periodic HARD cold reset in the
    // HYBRID cadence (D-002) — kill the child + fresh-spawn it in THIS same host
    // (same socket / SID / locks / hooks / env survive, D-003), then open the fresh
    // process on the carry-note. Only ever reached at a settled turn (the handler's
    // clean-boundary gate ran first, D-006). Serialized by `recycling`; fail-soft
    // (a spawn failure leaves the host running, carry stays in the inbox).
    recycleChild = async (carryText) => {
      if (recycling) return;
      recycling = true;
      try {
        const dead = new Promise((res) => {
          try {
            child.onExit(() => res());
          } catch {
            res();
          }
        });
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        await Promise.race([dead, new Promise((r) => setTimeout(r, RECYCLE_KILL_TIMEOUT_MS))]);
        // WI-1980: a RECYCLE is a HARD cold reset — mint a FRESH --session-id so
        // we don't re-declare the prior child's already-on-disk id (which claude
        // rejects → boot-retry storm). env (PAPERCUSP_SID) is untouched, so coord
        // identity / locks / socket all survive; only the native claude id rotates.
        const { args: recycleArgs, nativeId } = mintRecycleArgs(args);
        child = spawnChild(recycleArgs);
        // Re-anchor the fresh native id → coord ownerId so a LATER untracked
        // resume still recovers this identity (else the 2026-07-02 orphaning bug
        // recurs). Fail-soft: onRespawn (recordSessionOwner) never throws.
        if (nativeId) {
          try {
            onRespawn(nativeId);
          } catch {
            /* anchoring is best-effort — never let it break the respawn */
          }
        }
        baseMeta.ptyPid = child.pid;
        writeMeta();
        wireChildData();
        wireChildExit();
      } catch (e) {
        try {
          process.stderr.write(`psu-pty-host: recycle spawn failed for ${ownerId}: ${e.message}\n`);
        } catch {
          /* never let a diagnostic write break the host */
        }
        recycling = false;
        return;
      }
      recycling = false;
      if (!carryText) return;
      // Open the fresh process on the carry-note once it has booted to its prompt
      // (boot output quiesces → the agent-busy gate clears). Same paste-safe per-
      // agent turn plan.
      //
      // WI-1941: the inject is GUARANTEED-or-retried, not a single best-effort
      // shot. A fresh cold child can stay busy past one agent-busy cap (large
      // compacted-context replay, MCP load, an auto-continued boot turn) and THEN
      // settle; the old single waitAtPrompt() dropped the iteration SILENTLY the
      // instant it deferred, leaving the session booted-but-idle with no trace
      // until its next scheduled wake. Now: RETRY waitAtPrompt across a bounded
      // wall-clock budget so we inject the moment the fresh child reaches its
      // prompt, and on ultimate exhaustion DROP LOUDLY (stderr + a durable meta
      // counter) — never silently. The carry note also stays in the inbox as the
      // last-resort next-turn resume, so a drop is observable, not lossy.
      const injectChild = child; // bail if a newer recycle supersedes this one
      const carryDeadline = Date.now() + recycleCarryInjectBudgetMs;
      let carryAttempts = 0;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (child !== injectChild) return; // a newer recycle owns the child now
          carryAttempts++;
          const atPrompt = await agentBusyGate.waitAtPrompt();
          if (child !== injectChild) return; // superseded while we waited
          if (!atPrompt.deferred) {
            for (const step of controlWritesForAgent({ mode: 'turn', data: carryText }, env.PAPERCUSP_AGENT, env)) {
              if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
              if (child !== injectChild) return;
              try {
                child.write(step.data);
              } catch {
                /* fresh child may have exited */
              }
            }
            // WI-2930: the recycle carry is a normal submit — verify it took
            // (writeCr reads the live child; a superseding recycle makes the
            // resubmit a harmless bare CR on the newer child's idle prompt).
            if (child === injectChild) await verifySubmitted('recycle carry-note');
            return; // injected — done
          }
          // Deferred: the fresh child is still mid-boot / mid-turn. Retry until
          // the budget is spent, then fall through to the loud drop.
          if (Date.now() >= carryDeadline) break;
          await new Promise((r) => setTimeout(r, recycleCarryRetryBackoffMs));
        }
      } catch {
        /* an unexpected inject error still falls through to the drop trace */
      }
      if (child !== injectChild) return; // superseded — the new recycle owns tracing
      // Ultimate drop: every attempt across the budget deferred. Make it LOUD and
      // durably observable (WI-1941) — the carry stays in the inbox for the next
      // natural turn, but the drop must never again be traceless.
      try {
        baseMeta.lastCarryDropAt = Date.now();
        baseMeta.carryDropCount = (baseMeta.carryDropCount || 0) + 1;
        writeMeta();
      } catch {
        /* meta is best-effort — discovery degrades to the base contract */
      }
      try {
        process.stderr.write(
          `psu-pty-host: recycle carry-note DROPPED for ${ownerId} ` +
            `(fresh child never settled to prompt within ${recycleCarryInjectBudgetMs}ms ` +
            `over ${carryAttempts} attempt(s)); left in inbox for the next natural turn\n`,
        );
      } catch {
        /* never let a diagnostic write break the host */
      }
    };

    // In raw mode the terminal does NOT generate SIGINT — Ctrl-C is a byte
    // forwarded to the child (what we want). Handle teardown signals only.
    const killChild = () => {
      try {
        child.kill();
      } catch {
        cleanup(0);
      }
    };
    process.on('SIGTERM', killChild);
    process.on('SIGHUP', killChild);
  });
}
