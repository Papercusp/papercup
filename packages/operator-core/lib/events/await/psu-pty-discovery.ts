/**
 * psu-pty-discovery — the operator's READ side of the session-hosted managed-pty
 * control socket (turn-lifecycle-control-2026-06-08 Phase 3, P-014).
 *
 * An interactive `psu` session hosts its pty + control socket IN THE PSU PROCESS
 * (D-006), so the operator's own pty-bridge (`findPtyByPid`) can't see it — a
 * wake for such a session would otherwise PARK ("alive but not an injectable
 * managed pty"). This module lets the operator DISCOVER a live session's socket
 * (by coord ownerId) and INJECT into it: a wake turn, or a force-interrupt
 * control byte (Phase 4, D-007/D-008).
 *
 * The on-disk contract (dir, filename, {ownerId,pid,sock}, and the v1 wire
 * envelope) is WRITTEN by apps/operator/scripts/psu-pty-host.mjs — keep the two
 * in lockstep. A local-FS discovery file (not PG) is deliberate: the socket is a
 * same-host, process-lifetime-bound IPC resource, like ~/.papercusp/voice-ipc.json.
 *
 * Same-UID (0600 socket) is the OS boundary; per-agent auth/audit/rate-limit is
 * the operator-mediated `turn:interrupt` tool's job (D-008).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import net from 'node:net';
import { managedSetInterval } from '@papercusp/scheduled-registry';

/** Shared with psu-pty-host.mjs PSU_PTY_DIR. */
export const PSU_PTY_DIR = join(homedir(), '.papercusp', 'psu-pty');

/** Shared wire ceiling with psu-pty-host.mjs. Enforce it before opening a
 * socket as well as host-side so an accidental giant wake fails cheaply and
 * never depends on backpressure or the receiver's implementation age. */
export const MAX_CONTROL_PAYLOAD_BYTES = 8 * 1024 * 1024;

export interface PsuPtyHost {
  ownerId: string;
  advSessionId: string | null;
  pid: number;
  ptyPid: number;
  sock: string;
  command: string;
  startedAt: number;
  // ── Activity annotation (liveness-hardening P-006; ADDITIVE — absent on
  //    files written by older hosts). The pty stream is a true mid-turn
  //    signal: lastOutputAt fresh = the agent is emitting right now;
  //    lastActivityAt = max(input, output). Display/triage only (D-002) —
  //    never an input to claim release.
  lastInputAt?: number | null;
  lastOutputAt?: number | null;
  lastActivityAt?: number | null;
  // ── Host capability advertisement (WI-1804; ADDITIVE — absent on files written
  //    by older hosts, which is exactly how the tool detects an old host and falls
  //    back). A new host lists the control-socket modes it understands beyond the
  //    v1 base set, e.g. `['compact']` for the post-compaction auto-continuation
  //    branch (mode:'compact' = /compact then a completion-gated carry-note turn).
  //    A consumer MUST treat a missing/empty `caps` as "base modes only".
  caps?: string[] | null;
  // ── Interactive-vs-headless advertisement (deterministic-context-carry P-021;
  //    ADDITIVE — absent on files written by older hosts). `false` = a headless/
  //    piped host (the psu-pty-host spawned with no bridgeable human TTY); `true`
  //    = a genuine interactive terminal. Consumers MUST fail-soft an absent value
  //    to "interactive" (sessionClassForHost) — the safe direction, since the
  //    interactive class additionally requires the no-recent-human-input guard
  //    before any cold-by-default action.
  bridgeTty?: boolean | null;
  // ── Launch provenance (WI-6638; ADDITIVE — absent on files written by older
  //    hosts). The `--launched-by=<caller ownerId>` that `injectLaunchedByArg`
  //    (agent-launch-core) stamps onto every TOOL-driven psu launch, re-exported by
  //    bootstrap-su as PAPERCUSP_LAUNCHED_BY. An owner-typed `psu` never carries one,
  //    which makes presence-vs-absence a STRUCTURAL agent-vs-human discriminator
  //    rather than a heuristic. Consumers MUST fail-soft an absent value to
  //    "human-launched" — the refusing direction (see hostIsAgentLaunched).
  launchedBy?: string | null;
}

/**
 * Was this session launched BY ANOTHER AGENT (a tool-driven psu launch) rather than
 * typed by the human? WI-6638. Fails soft to `false` for a null host or an older host
 * with no `launchedBy` field — the safe direction, since the only consumer uses it to
 * decide whether a window may be closed.
 *
 * Advisory only: the psu host re-checks its OWN env authoritatively before honouring a
 * shutdown, so a stale discovery file can never widen what is closable. Pure.
 */
export function hostIsAgentLaunched(host: PsuPtyHost | null | undefined): boolean {
  return !!String(host?.launchedBy ?? '').trim();
}

/**
 * The CANONICAL ownerId→sessionClass mapping (deterministic-context-carry P-021 /
 * P-026 — solve once, share). A session's CLASS is the join key between the
 * cold-boot drill ledger's per-class sufficiency verdicts (cold-boot-drill.ts
 * gradeColdBootDrills) and the live surfaces that ACT on those verdicts (the
 * wake-executor's cold-by-default fork, compact-reprime's enrichment retirement,
 * session:carry-drill's default class). One vocabulary, derived from the live
 * host discovery record:
 *
 *   - 'claude-headless'    — the host advertises bridgeTty:false (a headless /
 *                            piped psu host, no human TTY bridged);
 *   - 'claude-interactive' — everything else, INCLUDING an absent host or an
 *                            old host that predates the bridgeTty field.
 *
 * Fail-soft direction is deliberate: misclassifying headless→interactive only
 * DELAYS a cold-by-default flip (the interactive class must separately pass
 * drills, and its actuation additionally requires no recent human input); the
 * reverse misclassification is impossible because bridgeTty:false is only ever
 * written by a host that verifiably had no TTY at spawn. Pure.
 */
export function sessionClassForHost(
  host: Pick<PsuPtyHost, 'bridgeTty'> | null | undefined,
): string {
  return host?.bridgeTty === false ? 'claude-headless' : 'claude-interactive';
}

/**
 * Does a discovered host advertise a control-socket capability (WI-1804)? An old
 * host has no `caps` field, so this is false for it — the caller then falls back
 * to a base-mode inject (e.g. a plain `mode:'turn'` `/compact`, no auto-continue).
 * Null-safe: a null/absent host or caps yields false.
 */
export function hostSupports(host: PsuPtyHost | null | undefined, cap: string): boolean {
  return Array.isArray(host?.caps) && host!.caps!.includes(cap);
}

/** Shared with psu-pty-host.mjs sanitizeKey — MUST match byte-for-byte. */
export function sanitizeKey(ownerId: string): string {
  return String(ownerId || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200);
}

/** Bytes of `<owner>.events.jsonl` tail scanned for the newest `respawned`.
 *  The host appends one small JSON line per lifecycle event, so a few KB covers
 *  many respawns; bounded so a long-lived owner's log is never fully read. */
const RESPAWN_SCAN_TAIL_BYTES = 64 * 1024;

/**
 * One parsed line of a host's `<owner>.events.jsonl` lifecycle ledger.
 *
 * Deliberately open-shaped. The ledger is written by `appendHostEvent` in
 * psu-pty-host.mjs with a per-`kind` payload, and — the property that makes the
 * ledger worth reading at all — it is written IDENTICALLY by hosts of every code
 * vintage. A closed interface here would have to be widened for each new event
 * kind, and a reader that only understands today's kinds would silently drop the
 * evidence written by the OLD hosts that most need observing.
 */
export interface PtyHostEvent {
  kind?: unknown;
  ts?: unknown;
  [k: string]: unknown;
}

/**
 * The tail of an owner's lifecycle ledger, parsed, OLDEST-FIRST.
 *
 * Extracted from {@link latestRespawnNativeId} (which now consumes it) so a second
 * consumer cannot drift from the first on the two things that are easy to get
 * wrong here: the tail window may start MID-LINE, so the first line routinely
 * fails to parse and must be skipped rather than treated as corruption; and the
 * read must stay bounded, because a long-lived owner's ledger reaches megabytes
 * (13k `respawned` rows measured on this box) and no consumer wants all of it.
 *
 * Best-effort by contract: a missing/unreadable ledger yields `[]`, never a throw.
 * An EMPTY result therefore means "nothing readable", NOT "nothing happened" —
 * callers that treat absence as a verdict must say which they mean.
 */
export function readHostEventTail(
  ownerId: string,
  dir: string = PSU_PTY_DIR,
  maxBytes: number = RESPAWN_SCAN_TAIL_BYTES,
): PtyHostEvent[] {
  let text: string;
  try {
    const path = join(dir, `${sanitizeKey(ownerId)}.events.jsonl`);
    const { size } = statSync(path);
    const start = Math.max(0, size - maxBytes);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: PtyHostEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as PtyHostEvent);
    } catch {
      // A partial first line (the tail window can start mid-line) — skip it.
    }
  }
  return out;
}

/**
 * WI-5075 rung 3: the native session id of this owner's MOST RECENT
 * carry-respawn/recycle, straight from the host's own event log — or null when
 * the owner has never respawned (or the log is unreadable).
 *
 * Why this exists as a SERVER-side read. `adv_sessions.session_id` is the
 * authoritative owner→native mapping the compaction estimate resolves through,
 * and it is re-anchored by a REPORT the psu host POSTs after each respawn. A
 * host running launcher code older than that report (every psu session launched
 * before 2026-07-18 16:46 EDT) never sends it, so the row keeps naming the DEAD
 * predecessor — whose frozen, over-limit transcript the watchdog then reads as
 * the near-empty successor's usage and cuts it again, forever (the su-71c69
 * loop: 7 cuts in 105 min while the session was actively working).
 *
 * A host-side fix cannot heal an ALREADY-RUNNING old host — only a server-side
 * reconcile can, and the `respawned` host event carrying `nativeId` is written
 * by old and new hosts alike. Same-box, same-dir, bounded-tail read: the same
 * trust boundary and cost class as {@link findLiveHost}.
 *
 * The event log is append-only PER OWNER and outlives any one host, so a
 * respawn recorded by a PREVIOUS host is history, not the live child: a fresh
 * host that has not respawned yet would otherwise have its correct DB ref
 * overridden by a dead predecessor's id — the very bug this fixes, inverted.
 * Events older than the CURRENT host's `startedAt` are therefore ignored. No
 * discovery file (no live host) ⇒ null: nothing to reconcile against.
 */
export function latestRespawnNativeId(
  ownerId: string,
  dir: string = PSU_PTY_DIR,
): string | null {
  try {
    const startedAt = hostStartedAt(ownerId, dir);
    if (startedAt == null) return null;
    // Scan backwards: the newest respawn wins.
    const events = readHostEventTail(ownerId, dir, RESPAWN_SCAN_TAIL_BYTES);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as { kind?: unknown; nativeId?: unknown; ts?: unknown };
      // Drill respawns rotate the native id exactly like a real one.
      if (ev.kind !== 'respawned' && ev.kind !== 'carry-drill-respawned') continue;
      // A respawn from a PREVIOUS host (and everything before it) is history.
      const ts = typeof ev.ts === 'string' ? Date.parse(ev.ts) : NaN;
      if (!Number.isFinite(ts) || ts < startedAt) return null;
      return typeof ev.nativeId === 'string' && ev.nativeId ? ev.nativeId : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The CURRENT psu host's start time (epoch ms) from its discovery file, or null
 * when the owner has no host record. Deliberately NOT liveness-gated: a host
 * mid-restart must not silently re-enable a stale predecessor id.
 *
 * EXPORTED because it is the scoping boundary every ledger reader needs, not an
 * implementation detail of one. The `<owner>.events.jsonl` ledger is per-OWNER and
 * OUTLIVES any single host process, so events below this timestamp belong to a
 * PREVIOUS incarnation. Measured cost of forgetting that (2026-08-12): a wedge
 * census that counted defers unscoped charged four hosts with their predecessors'
 * incidents — caught only because several "defers" were timestamped BEFORE the host
 * they were attributed to had started.
 */
export function hostStartedAt(ownerId: string, dir: string = PSU_PTY_DIR): number | null {
  try {
    const meta = JSON.parse(
      readFileSync(join(dir, `${sanitizeKey(ownerId)}.json`), 'utf8'),
    ) as { ownerId?: unknown; startedAt?: unknown };
    // EI-151: the same cross-owner misroute guard findLiveHost applies.
    if (typeof meta.ownerId === 'string' && meta.ownerId !== ownerId) return null;
    return typeof meta.startedAt === 'number' && Number.isFinite(meta.startedAt)
      ? meta.startedAt
      : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Read a pid's `/proc/<pid>/cmdline` (NUL-delimited argv), NULs → spaces; null if
 *  unreadable. Injectable so `pidIsPsuHost`'s marker logic unit-tests without a real
 *  process (the DEFAULT is the only IO in the identity check). Local type (not exported):
 *  callers pass an inline reader, so there is no external consumer to import it. */
type ReadPidCmdline = (pid: number) => string | null;
const defaultReadCmdline: ReadPidCmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return null;
  }
};

/** The verify-identity seam findLiveHost/listLiveHosts accept (default `pidIsPsuHost`).
 *  A test writing `process.pid` as a live-host stand-in injects `() => true`. Local type
 *  (not exported): callers pass an inline `{ verifyIdentity: () => … }`. */
type VerifyPidIdentity = (pid: number) => boolean;

/**
 * Process-IDENTITY check (WI-2339 defect #2): is `pid` actually a psu session host,
 * or an UNRELATED process that inherited a RECYCLED pid? A dead host's discovery file
 * lingers (its graceful cleanup never runs on an abrupt SIGKILL/OOM/terminal-close),
 * so once the OS recycles that numeric pid, `pidAlive(pid) && existsSync(sock)` alone
 * reports a FALSE-POSITIVE live host forever — which makes probeWakeReachability report
 * `reachable:true` forever and permanently defeats the WI-1399 dead-owner terminal
 * guard (evaluateUnreachableTerminalGuard returns {breach:false} on any reachable:true).
 * This cross-checks the pid's cmdline for the psu session marker so a recycled pid held
 * by an unrelated process is rejected.
 *
 * EMPIRICAL (2026-07-04, verified against ~15 live hosts): the discovery file's recorded
 * `pid` is the **psu-launcher.mjs** process (it hosts the pty + control socket); a host
 * launched directly would be psu-pty-host.mjs. So the marker matches EITHER — an
 * unrelated recycled-pid process matches NEITHER and is rejected. ⚠ An earlier proposal
 * matched only 'psu-pty-host', which would have false-negatived EVERY real host and broken
 * fleet-wide wake delivery — do NOT narrow the marker back (WI-2339 post 50341).
 *
 * FAIL-OPEN where identity cannot be read (no /proc ⇒ non-Linux dev): return true, i.e.
 * trust pid-alive + socket-exists exactly as before. The PID-reuse hardening is a Linux /
 * ship-target concern; failing open NEVER rejects a real host, it only declines to add the
 * extra rejection where it can't be computed. An unreadable/empty cmdline on Linux (pid
 * vanished, zombie/defunct) ⇒ not a verifiable live host ⇒ reject (correct: it's dead).
 */
export function pidIsPsuHost(pid: number, readCmdline: ReadPidCmdline = defaultReadCmdline): boolean {
  if (!pid) return false;
  const cmdline = readCmdline(pid);
  // Unreadable cmdline: FAIL-OPEN only where /proc is absent (non-Linux dev — cannot verify
  // identity, so trust pid-alive + socket-exists exactly as before). On Linux a null read
  // means the pid vanished / is a zombie ⇒ NOT a verifiable live host ⇒ reject.
  if (cmdline == null) return !existsSync('/proc');
  // A readable cmdline is authoritative on every platform: it IS a psu host iff it carries
  // the psu session marker (empirically the psu-launcher.mjs process; psu-pty-host for a
  // direct launch). An unrelated recycled-pid process matches neither ⇒ rejected.
  return /psu-(launcher|pty-host)/.test(cmdline);
}

/**
 * The live psu-pty host for an ownerId, or null. Self-validating: the recorded
 * host pid must be alive AND its socket must still exist (a crashed host that
 * left its file behind is skipped). So a non-null result means "there is a live
 * interactive session whose pty I can inject into right now".
 *
 * Cross-owner safety (EI-151): the discovery file is located purely by FILENAME
 * (`<sanitizeKey(ownerId)>.json`), but `sanitizeKey` is lossy — it maps every
 * char outside `[a-zA-Z0-9._-]` to `_` and truncates to 200, so two DISTINCT
 * coord owner ids can resolve to the SAME file (e.g. a structured hive-Scout id
 * vs a colliding one, or a stale file left at a reused key during a `/loop`
 * re-host). Whoever wrote last owns the filename. So we ALSO require the file's
 * RECORDED `ownerId` to match the one we asked for: a mismatch means this file
 * belongs to a DIFFERENT agent, and returning it would let one agent's wake (or
 * `turn:interrupt`) land in another agent's live session — the exact cross-agent
 * misroute EI-151 reported. On mismatch we treat it as "no host" (→ park/inbox,
 * never the wrong session).
 */
export function findLiveHost(
  ownerId: string,
  dir: string = PSU_PTY_DIR,
  opts: { verifyIdentity?: VerifyPidIdentity } = {},
): PsuPtyHost | null {
  startJanitor();
  const verify = opts.verifyIdentity ?? pidIsPsuHost;
  const metaPath = join(dir, `${sanitizeKey(ownerId)}.json`);
  if (!existsSync(metaPath)) return null;
  try {
    const h = JSON.parse(readFileSync(metaPath, 'utf8')) as PsuPtyHost;
    // Identity must match (EI-151): the file's recorded owner is authoritative;
    // a sanitize-collision / stale-reuse leaves a file whose `ownerId` is a
    // different agent — never hand that back as this owner's host.
    if (h && h.ownerId && h.ownerId !== ownerId) return null;
    // WI-2339 defect #2: pid-alive + socket-exists is NOT enough — a recycled pid
    // held by an unrelated process would masquerade as a live host forever. Also
    // require the pid to actually BE a psu session host (pidIsPsuHost cmdline check).
    if (h && h.sock && existsSync(h.sock) && h.pid && pidAlive(h.pid) && verify(h.pid)) return h;
  } catch {
    /* unreadable / partial write — treat as no host */
  }
  return null;
}

/** Why a carry-respawn (session:request-compaction) cannot run for this session.
 *  These are exactly the two refusal branches request-compaction returns. */
export type SelfCompactionUnavailableReason = 'no_live_pty_host' | 'host_predates_carry_respawn';

/** Discriminated on `available` so the AVAILABLE case narrows `host` to non-null —
 *  request-compaction's own handler consumes this and then uses the host. */
export type SelfCompactionAvailability =
  | {
      /** Can `session:request-compaction` actually succeed for this owner RIGHT NOW? */
      available: true;
      reason: null;
      host: PsuPtyHost;
    }
  | {
      available: false;
      /** The refusal request-compaction would return. */
      reason: SelfCompactionUnavailableReason;
      /** The resolved host, when one was found (present even when it predates carry-respawn). */
      host: PsuPtyHost | null;
    };

/**
 * CAN this session self-compact? (EI-20209826138488049.)
 *
 * A carry-respawn is driven THROUGH a psu-pty host, so `session:request-compaction`
 * refuses in two distinct ways: no live host at all (`no_live_pty_host` — every
 * headless/autonomous fleet member, which has no psu-hosted TUI), or a live host too
 * old to carry-respawn (`host_predates_carry_respawn`). Both mean the same thing to a
 * CALLER deciding whether to RECOMMEND self-compaction: it is not an available
 * mechanism here.
 *
 * This exists so that recommendation and refusal cannot DRIFT. The continuation gate
 * used to tell every re-wake-less session to self-compact, because the advice was
 * written against an adjacent-but-different notion ("an agent near its limit should
 * compact") rather than the predicate the tool actually evaluates. A session with no
 * host then burned its last turn on a call that could only fail. Both consumers now
 * evaluate THIS function, so the advice is true by construction rather than by two
 * places agreeing to stay in sync.
 *
 * ⚠ SCOPE: this answers "can a carry-respawn be DRIVEN THROUGH A HOST", which is the
 * whole of request-compaction's HOST gate but not the whole of its handler. That
 * handler additionally accepts an armed COLD loop holding a verified carry-note as an
 * equivalent boundary (EI-20211379927723290) and answers `ok:true respawn:'cold-loop-settle'`
 * — a path this sync predicate cannot see, since it needs async loop + carry-note reads.
 * Unreachable from the continuation gate's escalation (that branch fires only when
 * rewakeGuaranteed is false, i.e. NO loop is armed), and the advice degrades safely
 * elsewhere: "arm a wake / end the turn" is what the cold-loop path prescribes anyway.
 */
export function selfCompactionAvailability(
  ownerId: string,
  dir: string = PSU_PTY_DIR,
  opts: { verifyIdentity?: VerifyPidIdentity } = {},
): SelfCompactionAvailability {
  const host = findLiveHost(ownerId, dir, opts);
  if (!host) return { available: false, reason: 'no_live_pty_host', host: null };
  if (!hostSupports(host, 'carry-respawn')) {
    return { available: false, reason: 'host_predates_carry_respawn', host };
  }
  return { available: true, reason: null, host };
}

/**
 * EVERY live psu-pty host on this box (the fleet's interactive sessions), not
 * just one owner's. Same self-validation as findLiveHost (recorded ownerId
 * present, socket exists, pid alive) so a crashed host's leftover file is
 * skipped. Consumers: desktop-window-liveness's ancestry-based on-desktop
 * detection (WI-1586) — the live host pid is the one session handle that cannot
 * rot, unlike the launch-recorded adv_sessions window_id/pid. Best-effort: a
 * missing dir or unreadable file yields fewer hosts, never a throw.
 */
export function listLiveHosts(
  dir: string = PSU_PTY_DIR,
  opts: { verifyIdentity?: VerifyPidIdentity } = {},
): PsuPtyHost[] {
  startJanitor();
  const verify = opts.verifyIdentity ?? pidIsPsuHost;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no discovery dir yet → no live interactive sessions
  }
  const out: PsuPtyHost[] = [];
  for (const f of files) {
    try {
      const h = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PsuPtyHost;
      // WI-2339 defect #2: same process-identity gate as findLiveHost — a recycled
      // pid held by an unrelated process must not count as a live interactive host.
      if (h && h.ownerId && h.sock && existsSync(h.sock) && h.pid && pidAlive(h.pid) && verify(h.pid)) out.push(h);
    } catch {
      /* unreadable / partial write — skip this host */
    }
  }
  return out;
}

function safeUnlink(p: string): void {
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* best-effort — a concurrent host cleaning up the same file races harmlessly */
  }
}

/**
 * Remove discovery files (+ their sockets) whose host is no longer a live psu session
 * (WI-2510). `pruneDead()` in psu-pty-host.mjs runs ONLY opportunistically — when a NEW
 * host boots on the box, scanning every file — so on a box with no new psu launches for
 * hours, a dead host's `~/.papercusp/psu-pty/<owner>.json` (+ orphaned socket) lingers
 * indefinitely (a slow disk leak; `listLiveHosts` also pays a per-file /proc read as they
 * accumulate). WI-2339 fix B already closed the correctness risk (a stale file can no
 * longer masquerade as a live host, via `pidIsPsuHost`'s cmdline cross-check), so this is
 * pure hygiene — it reuses the EXACT SAME liveness test `findLiveHost`/`listLiveHosts` apply
 * (pid alive + socket exists + `pidIsPsuHost` identity), so it only ever removes a file that
 * already reads as "no live host" to every consumer; a corrupt/unreadable file is pruned too
 * (it can never resolve to a live host either). Returns the count removed, for tests/logging.
 */
export function pruneDeadDiscoveryFiles(
  dir: string = PSU_PTY_DIR,
  opts: { verifyIdentity?: VerifyPidIdentity } = {},
): number {
  const verify = opts.verifyIdentity ?? pidIsPsuHost;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0; // no discovery dir yet — nothing to prune
  }
  let pruned = 0;
  for (const f of files) {
    const metaPath = join(dir, f);
    let h: PsuPtyHost | null = null;
    try {
      h = JSON.parse(readFileSync(metaPath, 'utf8')) as PsuPtyHost;
    } catch {
      safeUnlink(metaPath); // corrupt/partial write — can never resolve to a live host
      pruned += 1;
      continue;
    }
    const alive = !!(h && h.sock && existsSync(h.sock) && h.pid && pidAlive(h.pid) && verify(h.pid));
    if (alive) continue;
    safeUnlink(metaPath);
    if (h?.sock) safeUnlink(h.sock);
    pruned += 1;
  }
  return pruned;
}

const JANITOR_INTERVAL_MS = 30 * 60 * 1000; // hygiene only, no urgency (WI-2510)

type JanitorGlobals = typeof globalThis & { __papercuspPsuPtyJanitorStarted?: boolean };
const _janitorGlobals = globalThis as JanitorGlobals;

/**
 * Arm the standing sweep once (WI-2510), idempotently. Started LAZILY on first real use
 * (`findLiveHost` / `listLiveHosts`) rather than at module-import time — mirrors
 * `pty-bridge.ts`'s `startReaper()` pattern — so importing this module in isolation (e.g. a
 * unit test exercising `sanitizeKey`/`pidIsPsuHost`) never arms a real background timer;
 * only the operator's actual runtime use of the discovery path (wake delivery, desktop
 * window liveness, …) does.
 */
function startJanitor(): void {
  if (_janitorGlobals.__papercuspPsuPtyJanitorStarted) return;
  _janitorGlobals.__papercuspPsuPtyJanitorStarted = true;
  managedSetInterval(
    'psu-pty-discovery-janitor',
    JANITOR_INTERVAL_MS,
    () => {
      pruneDeadDiscoveryFiles();
    },
    { category: 'global-sweep' },
  );
}

/**
 * Inject one control message into a live host's socket. `mode:'turn'` = a wake
 * turn (idle-gated host-side, then submitted); `mode:'raw'` = verbatim +
 * IMMEDIATE (force-interrupt bytes: Ctrl-C '\x03' / Esc '\x1b'); `mode:'osc'` =
 * recolor escape bytes written to the host's STDOUT (the visible terminal), not
 * the agent's stdin — the fleet-recolor path. `mode:'compact'` (WI-1804) = /compact
 * then a completion-gated carry-note continuation (uses `focus`). `mode:'reset'` /
 * `mode:'recycle'` (su-cold-auto-mode-2026-07-03 Phase 2) = a COLD loop wake:
 * RESET-CONTEXT (`/clear` in place, keep the MCP warm) or RECYCLE (kill+respawn the
 * host), each carrying the carry-note as `data`; `mode:'carry-respawn'` is P-018's
 * deterministic successor cut and additionally carries a system-prompt addendum.
 * All lifecycle verbs are clean-boundary-gated
 * host-side (deferred mid-turn, P-006). Resolves true on a clean write, false on
 * connect error / timeout. Mirrors psu-pty-host.mjs's v1 envelope.
 */
/**
 * WHY a `true` happened — the distinction `injectIntoHost`'s bare boolean throws away (WI-6862).
 *
 * `'acked'` is the only value that means the HOST confirmed it. `'assumed-close'` is the
 * optimistic pre-WI-5872 fallback below: the connection closed without any ack, which covers
 * BOTH an old host that never sends one AND a host that crashed or was killed mid-delivery
 * after accepting the connection. Both resolve `ok: true`, so a caller reading only the boolean
 * cannot tell a confirmed delivery from a host that died on the wire — which is how a cold
 * context-reset that never re-execed gets booked `status='delivered'` in event_wake_deliveries
 * and then reads back as a clean success to whoever is diagnosing it.
 */
export type InjectConfirmation = 'acked' | 'assumed-close' | 'timeout' | 'error' | 'oversize';

export interface InjectHostResult {
  ok: boolean;
  confirmation: InjectConfirmation;
  /** The host's own `reason` from its JSON ack line, when it sent one (WI-6638;
   *  ADDITIVE and OMITTED when absent, so existing exact-shape assertions on this
   *  result are unaffected). Only an 'acked' confirmation can carry one — an
   *  assumed-close / timeout / error means no host verdict was received at all, so
   *  absence here NEVER means "the host had nothing to say". Today only the
   *  shutdown path reads it (to tell an owner-attended REFUSAL apart from a
   *  transport miss); every other caller branches on `ok` exactly as before. */
  reason?: string | null;
}

/**
 * The confirmation-carrying form of `injectIntoHost`. Identical wire behavior — same envelope,
 * same timeouts, same optimistic close fallback — it simply reports WHICH signal produced the
 * verdict. Prefer it wherever booking a durable delivery record; `injectIntoHost` remains the
 * boolean-returning wrapper for the ~100 call sites that only branch on success.
 */
export function injectIntoHostWithConfirmation(
  sock: string,
  msg: {
    mode:
      | 'turn'
      | 'raw'
      | 'osc'
      | 'compact'
      | 'reset'
      | 'recycle'
      | 'carry-respawn'
      | 'mcp-reconnect'
      | 'shutdown';
    data: string;
    /** WI-6638, mode:'shutdown' only: waive the mid-turn (agent-busy) refusal. It
     *  can NEVER waive the two human guards — those are evaluated by the host from
     *  its own process state and are not caller-influenced. */
    force?: boolean;
    focus?: string;
    systemPromptAddendum?: string;
    /** P-020 opt-in cold-boot drill correlation. Ignored by non-drill
     * carry-respawns and by older hosts (additive v1 fields). */
    drillId?: string;
    sessionClass?: string;
    /** WI-5510: the loop-fire identity riding a loop-wake delivery (turn/reset/
     * recycle/carry-respawn) — `su-cold-loop.ts`'s ColdLoopMarker.wakeCount /
     * .routineId, forwarded so psu-pty-host.mjs's delivery-side STALE-FIRE
     * GUARD can drop a superseded delivery instead of flushing it mid-turn.
     * Both additive v1 fields; omitted ⇒ the guard is a no-op (unchanged
     * behavior) — exactly like every other pre-existing optional field here. */
    fireNumber?: number;
    routineId?: string;
    /** EI-153: the coord ownerId the SENDER believes it is addressing (i.e. the
     * ownerId it passed to findLiveHost() to resolve `sock`) — a caller-supplied
     * identity assertion, NOT re-derived here. Riding it on the envelope lets the
     * RECEIVING host (which alone knows its own true ownerId) reject a delivery
     * addressed to someone else instead of blindly running whatever text arrives
     * on its socket — defense-in-depth against a leg-independent mis-route (a
     * swapped subscriberId, a stale/reused host object, …) that a socket-path-only
     * check (findLiveHost's own ownerId match, EI-151) cannot catch, because that
     * check only guards WHICH file gets read, not what the caller believed when it
     * built the envelope. Omitted ⇒ the receiving host's identity check is a no-op
     * (unchanged behavior) — every existing caller that omits it keeps working
     * exactly as before; new/updated callers should always pass it when the
     * intended recipient ownerId is known (it always is — it's the same ownerId
     * findLiveHost was just called with).
     */
    ownerId?: string;
    /** EI-19311270129974785: the SENDER's durable `event_wake_deliveries.id` for
     * this wake, when the message represents one (a loop-wake / event-wake
     * `turn`/`reset`/`recycle`/`carry-respawn` delivery — never a one-shot
     * `raw`/`osc`/`compact`/`mcp-reconnect` call, which has no delivery row).
     * Riding it on the envelope lets the RECEIVING host recognize a RETRY of a
     * delivery it already accepted (the client's own ack-wait can time out or
     * the ack write back can fail — either way is indistinguishable from a
     * genuine miss to the client, which then retries — even though the host,
     * having already ack'd 'accepted', is unstoppably committed to delivering
     * the ORIGINAL attempt) and short-circuit the duplicate instead of running
     * the gated pipeline (and writing a second real turn into the pty) again.
     * Omitted ⇒ the receiving host's dedup check is a no-op (unchanged
     * behavior) — every existing caller that omits it keeps working exactly
     * as before; new/updated callers should always pass it when the message
     * corresponds to a durable delivery row.
     */
    deliveryId?: string;
  },
  timeoutMs = 2000,
): Promise<InjectHostResult> {
  const envelope: {
    v: 1;
    mode: string;
    data: string;
    force?: boolean;
    focus?: string;
    systemPromptAddendum?: string;
    drillId?: string;
    sessionClass?: string;
    fireNumber?: number;
    routineId?: string;
    ownerId?: string;
    deliveryId?: string;
  } = {
    v: 1,
    mode: msg.mode,
    data: msg.data,
  };
  if (msg.force !== undefined) envelope.force = msg.force;
  if (msg.focus !== undefined) envelope.focus = msg.focus;
  if (msg.systemPromptAddendum !== undefined) envelope.systemPromptAddendum = msg.systemPromptAddendum;
  if (msg.drillId !== undefined) envelope.drillId = msg.drillId;
  if (msg.sessionClass !== undefined) envelope.sessionClass = msg.sessionClass;
  if (msg.fireNumber !== undefined) envelope.fireNumber = msg.fireNumber;
  if (msg.routineId !== undefined) envelope.routineId = msg.routineId;
  if (msg.ownerId !== undefined) envelope.ownerId = msg.ownerId;
  if (msg.deliveryId !== undefined) envelope.deliveryId = msg.deliveryId;
  const payload = JSON.stringify(envelope);
  if (Buffer.byteLength(payload, 'utf8') > MAX_CONTROL_PAYLOAD_BYTES)
    return Promise.resolve({ ok: false, confirmation: 'oversize' as const });

  return new Promise<InjectHostResult>((resolve) => {
    let settled = false;
    // EI-18676244363359331 / WI-5872: true delivery confirmation, when the host
    // sends one (see psu-pty-host.mjs's conn.on('end', ...) — it now writes a
    // single JSON-line ACK/NACK `{ v:1, ok, reason, ... }` back on this same
    // connection before closing its own end, instead of the bare TCP close this
    // client used to treat as its only signal). An ack, once parsed, is
    // authoritative and settles this promise on its own `ok` value.
    let ackReceived = false;
    let ackBuf = '';
    const finish = (ok: boolean, confirmation: InjectConfirmation, reason?: string) => {
      if (settled) return;
      settled = true;
      // Omit `reason` entirely when the host sent none, so this stays shape-compatible
      // with every existing exact-equality assertion on InjectHostResult.
      resolve(reason === undefined ? { ok, confirmation } : { ok, confirmation, reason });
    };
    const c = net.connect(sock, () => {
      // `focus` rides the envelope only for mode:'compact' (WI-1804) — the host uses it
      // as the `/compact <focus>` argument, keeping `data` for the carry-note continuation.
      c.write(payload);
      c.end();
    });
    c.on('data', (d) => {
      // A NOT-YET-RESTARTED host (running pre-WI-5872 code) never writes
      // anything here — ackBuf simply never gets a newline and the 'close'
      // fallback below reproduces exactly the OLD behavior for that case, so
      // this is safe to roll out without a coordinated host restart.
      ackBuf += d.toString('utf8');
      const nl = ackBuf.indexOf('\n');
      if (nl === -1) return;
      const line = ackBuf.slice(0, nl);
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed as { v?: unknown }).v === 1 &&
          typeof (parsed as { ok?: unknown }).ok === 'boolean'
        ) {
          ackReceived = true;
          const ackReason = (parsed as { reason?: unknown }).reason;
          finish(
            (parsed as { ok: boolean }).ok,
            'acked',
            typeof ackReason === 'string' ? ackReason : undefined,
          );
        }
      } catch {
        /* malformed ack line — ignore, the close/timeout fallback still applies */
      }
    });
    c.on('error', () => finish(false, 'error'));
    c.on('close', () => {
      // No ack ever arrived — either an old host (pre-WI-5872, never sends
      // one: preserve today's optimistic behavior so this client-side change
      // is safe against a host that hasn't restarted yet), or a host that
      // crashed/was killed mid-delivery after accepting the connection but
      // before writing back. Either way this is the EXACT pre-fix fallback:
      // bare close alone still resolves true. Once a real ack DID arrive,
      // `finish` already ran above and this is a no-op (the `settled` guard).
      if (!ackReceived) finish(true, 'assumed-close');
    });
    const t = setTimeout(() => {
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
      finish(false, 'timeout');
    }, timeoutMs);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Boolean-returning wrapper over `injectIntoHostWithConfirmation` — the long-standing signature
 * every existing caller uses. Behavior is byte-identical to before WI-6862; callers that need to
 * know whether a `true` was ACKED by the host or merely ASSUMED from a bare socket close (see
 * `InjectConfirmation`) should call the confirmation-carrying form directly.
 */
export function injectIntoHost(
  sock: string,
  msg: Parameters<typeof injectIntoHostWithConfirmation>[1],
  timeoutMs = 2000,
): Promise<boolean> {
  return injectIntoHostWithConfirmation(sock, msg, timeoutMs).then((r) => r.ok);
}

/**
 * Force-interrupt a live psu-hosted INTERACTIVE session by injecting a control
 * byte into its pty (turn-lifecycle-control Phase 4 pty-force leg, D-007). The
 * byte lands IMMEDIATELY (raw mode bypasses the wake idle-gate) — the
 * mid-thinking Ctrl-C semantics force requires. `'sigint'` = Ctrl-C (\x03,
 * ends the current turn, session stays resumable); `'esc'` = Esc (\x1b, the
 * claude/omp TUI's stop-generating key).
 *
 * EI-12460: retries once after a socket-write miss, re-reading the owner-scoped
 * discovery record before giving up — the SAME re-verify-after-miss pattern
 * WI-3683 added to wake-executor's psu-socket delivery (a bg-host/desktop
 * freeze can leave the discovery record + socket path present while the first
 * connect attempt races a host restart or a transiently wedged socket; a live
 * host may also have rebound its control socket to a new path in the interim
 * — never reuse the first host object, re-read discovery fresh). Confirmed
 * missing here (this leg's previous single-attempt form is exactly what a
 * ~15min, ~20-event burst of `turn.interrupt_failed` for 4 sessions during a
 * bg-host freeze produced — stall-waker's `unwedge` calls straight into this).
 *
 * Returns false when the owner has NO live psu-pty host (or both attempts
 * miss) — the caller (`turn:interrupt`) then falls back to headless SIGINT on
 * the resolved pid. Authorization, attribution, audit + storm-limit are the
 * operator-mediated `turn:interrupt` tool's job (D-008); this is the dumb
 * transport leg.
 */
export async function interruptViaPty(
  ownerId: string,
  key: 'sigint' | 'esc' = 'sigint',
  opts: { verifyIdentity?: VerifyPidIdentity } = {},
): Promise<boolean> {
  const data = key === 'esc' ? '\x1b' : '\x03';
  let host = findLiveHost(ownerId, PSU_PTY_DIR, opts);
  for (let attempt = 0; host && attempt < 2; attempt += 1) {
    const ok = await injectIntoHost(host.sock, { mode: 'raw', data, ownerId });
    if (ok) return true;
    // Re-read the owner-scoped discovery record after a miss. Do not reuse the
    // first host object: a live psu host may have rebound its control socket.
    host = findLiveHost(ownerId, PSU_PTY_DIR, opts);
  }
  return false;
}

/**
 * Recolor a live psu-hosted INTERACTIVE session's terminal by injecting OSC
 * escape bytes (fleet-color-schemes). Unlike interruptViaPty (which lands on the
 * agent's stdin), the host routes `mode:'osc'` to its OWN stdout — the visible
 * terminal — so an already-open window recolors LIVE with no relaunch. `osc` is
 * the escape string from console-color-schemes.oscRecolorSequence.
 *
 * Returns false when the owner has NO live psu-pty host (headless / no-pty / a
 * non-psu session): the recolor just doesn't land live — the bound scheme still
 * applies the next time the fleet opens a window. Best-effort by design (the
 * fleet:join/create callers ignore the result), so a recolor never fails a join.
 */
export async function recolorViaPty(
  ownerId: string,
  osc: string,
  opts: { verifyIdentity?: VerifyPidIdentity } = {},
): Promise<boolean> {
  if (!osc) return false;
  const host = findLiveHost(ownerId, PSU_PTY_DIR, opts);
  if (!host) return false;
  return injectIntoHost(host.sock, { mode: 'osc', data: osc, ownerId });
}

/**
 * Ask a live psu-hosted INTERACTIVE session's host to drive its claude TUI's
 * /mcp dialog and reconnect `serverName` IN PLACE (mcp-transport-resilience
 * P-003/P-004, 2026-07-13) — the owner-mandated headed-session heal for a
 * client-side severed MCP transport (kill+resume is reserved for headless).
 * The host runs the whole closed-loop macro itself (it owns the pty and sees
 * the TUI's output); this is just the envelope.
 *
 * `'no-host'` when the owner has NO live psu-pty host; `'no-cap'` when the
 * host predates the macro (caps without 'mcp-reconnect') — both mean the
 * caller (the mcp-dark watchdog heal ladder) falls back to notify-only.
 * `'sent'` means the envelope landed; the actual heal outcome is judged by
 * the caller off transport truth (the presence beat advancing), NEVER assumed
 * from a clean socket write.
 */
/** The outcomes of asking a psu host to wind down and exit (WI-6638). */
export type ShutdownViaPtyResult =
  | 'sent'
  | 'no-host'
  | 'no-cap'
  | 'send-failed'
  | 'refused-not-agent-launched'
  | 'refused-human-attended'
  | 'refused-agent-busy';

/**
 * Ask a live psu-hosted session to WIND DOWN AND EXIT — closing its own terminal tab
 * (WI-6638). psu runs as `exec <psu …>` inside `gnome-terminal --wait`, so the host
 * exiting IS the window closing. This is the fix for ~51 agent sessions from finished
 * fleets sitting in open tabs for up to 14 days holding ~14 GB.
 *
 * This is an ASK, never a kill: it signals nothing, opens no process handle, and the
 * HOST decides. The host refuses unless the session was agent-launched
 * (PAPERCUSP_LAUNCHED_BY) AND no human keystroke has ever reached its stdin — two
 * structural guards it evaluates from its own process state, which no caller can
 * spoof. `force` waives only the mid-turn (agent-busy) check, never those.
 *
 * Deliberately NOT wired into the idle-session reaper's kill path. Measured
 * 2026-08-03: `findIdleLiveSessions()` returns 0 for this entire cohort, because every
 * psu session classifies `driveMode:'responsive'` (agent-pane-kind rule 5) and is
 * excluded by the queen-fleet-authority-boundary ruling (P-001/D-001) BEFORE
 * `terminalWindowAlive`/`cgroupWindowProtects` is ever consulted. Two stacked,
 * owner-ratified protections say a system reaper may not kill these sessions. Nothing
 * here loosens either one — the session closes itself, which is what the owner chose.
 *
 * `'no-cap'` means the host predates the capability (it will keep idling; only a
 * relaunch picks up a current host). A `refused-*` result is a correct, expected
 * answer for an owner-attended window — not an error to retry around.
 */
export async function shutdownViaPty(
  ownerId: string,
  opts: { reason?: string; force?: boolean; verifyIdentity?: VerifyPidIdentity } = {},
): Promise<ShutdownViaPtyResult> {
  const host = findLiveHost(ownerId, PSU_PTY_DIR, { verifyIdentity: opts.verifyIdentity });
  if (!host) return 'no-host';
  if (!hostSupports(host, 'shutdown')) return 'no-cap';
  const res = await injectIntoHostWithConfirmation(host.sock, {
    mode: 'shutdown',
    data: String(opts.reason ?? '').slice(0, 500),
    force: opts.force === true,
    ownerId,
  });
  if (res.ok) return 'sent';
  const reason = String(res.reason ?? '');
  if (reason.startsWith('shutdown-refused:')) {
    const which = reason.slice('shutdown-refused:'.length);
    if (which === 'not-agent-launched') return 'refused-not-agent-launched';
    if (which === 'human-attended') return 'refused-human-attended';
    if (which === 'agent-busy') return 'refused-agent-busy';
  }
  return 'send-failed';
}

export async function mcpReconnectViaPty(
  ownerId: string,
  serverName = 'papercusp-su',
  opts: { verifyIdentity?: VerifyPidIdentity } = {},
): Promise<'sent' | 'no-host' | 'no-cap' | 'send-failed'> {
  const host = findLiveHost(ownerId, PSU_PTY_DIR, opts);
  if (!host) return 'no-host';
  if (!hostSupports(host, 'mcp-reconnect')) return 'no-cap';
  const ok = await injectIntoHost(host.sock, { mode: 'mcp-reconnect', data: serverName, ownerId });
  return ok ? 'sent' : 'send-failed';
}
