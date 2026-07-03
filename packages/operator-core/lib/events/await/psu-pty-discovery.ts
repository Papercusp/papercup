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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import net from 'node:net';

/** Shared with psu-pty-host.mjs PSU_PTY_DIR. */
export const PSU_PTY_DIR = join(homedir(), '.papercusp', 'psu-pty');

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

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
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
export function findLiveHost(ownerId: string, dir: string = PSU_PTY_DIR): PsuPtyHost | null {
  const metaPath = join(dir, `${sanitizeKey(ownerId)}.json`);
  if (!existsSync(metaPath)) return null;
  try {
    const h = JSON.parse(readFileSync(metaPath, 'utf8')) as PsuPtyHost;
    // Identity must match (EI-151): the file's recorded owner is authoritative;
    // a sanitize-collision / stale-reuse leaves a file whose `ownerId` is a
    // different agent — never hand that back as this owner's host.
    if (h && h.ownerId && h.ownerId !== ownerId) return null;
    if (h && h.sock && existsSync(h.sock) && h.pid && pidAlive(h.pid)) return h;
  } catch {
    /* unreadable / partial write — treat as no host */
  }
  return null;
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
export function listLiveHosts(dir: string = PSU_PTY_DIR): PsuPtyHost[] {
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
      if (h && h.ownerId && h.sock && existsSync(h.sock) && h.pid && pidAlive(h.pid)) out.push(h);
    } catch {
      /* unreadable / partial write — skip this host */
    }
  }
  return out;
}

/**
 * Inject one control message into a live host's socket. `mode:'turn'` = a wake
 * turn (idle-gated host-side, then submitted); `mode:'raw'` = verbatim +
 * IMMEDIATE (force-interrupt bytes: Ctrl-C '\x03' / Esc '\x1b'); `mode:'osc'` =
 * recolor escape bytes written to the host's STDOUT (the visible terminal), not
 * the agent's stdin — the fleet-recolor path. Resolves true on a clean write,
 * false on connect error / timeout. Mirrors psu-pty-host.mjs's v1 envelope.
 */
export function injectIntoHost(
  sock: string,
  msg: { mode: 'turn' | 'raw' | 'osc' | 'compact'; data: string; focus?: string },
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const c = net.connect(sock, () => {
      // `focus` rides the envelope only for mode:'compact' (WI-1804) — the host uses it
      // as the `/compact <focus>` argument, keeping `data` for the carry-note continuation.
      const envelope: { v: 1; mode: string; data: string; focus?: string } =
        { v: 1, mode: msg.mode, data: msg.data };
      if (msg.focus !== undefined) envelope.focus = msg.focus;
      c.write(JSON.stringify(envelope));
      c.end();
    });
    c.on('error', () => finish(false));
    c.on('close', () => finish(true));
    const t = setTimeout(() => {
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
      finish(false);
    }, timeoutMs);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Force-interrupt a live psu-hosted INTERACTIVE session by injecting a control
 * byte into its pty (turn-lifecycle-control Phase 4 pty-force leg, D-007). The
 * byte lands IMMEDIATELY (raw mode bypasses the wake idle-gate) — the
 * mid-thinking Ctrl-C semantics force requires. `'sigint'` = Ctrl-C (\x03,
 * ends the current turn, session stays resumable); `'esc'` = Esc (\x1b, the
 * claude/omp TUI's stop-generating key).
 *
 * Returns false when the owner has NO live psu-pty host — the caller
 * (`turn:interrupt`) then falls back to headless SIGINT on the resolved pid.
 * Authorization, attribution, audit + storm-limit are the operator-mediated
 * `turn:interrupt` tool's job (D-008); this is the dumb transport leg.
 */
export async function interruptViaPty(
  ownerId: string,
  key: 'sigint' | 'esc' = 'sigint',
): Promise<boolean> {
  const host = findLiveHost(ownerId);
  if (!host) return false;
  const data = key === 'esc' ? '\x1b' : '\x03';
  return injectIntoHost(host.sock, { mode: 'raw', data });
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
export async function recolorViaPty(ownerId: string, osc: string): Promise<boolean> {
  if (!osc) return false;
  const host = findLiveHost(ownerId);
  if (!host) return false;
  return injectIntoHost(host.sock, { mode: 'osc', data: osc });
}
