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
import { readFileSync, existsSync } from 'node:fs';
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
 */
export function findLiveHost(ownerId: string, dir: string = PSU_PTY_DIR): PsuPtyHost | null {
  const metaPath = join(dir, `${sanitizeKey(ownerId)}.json`);
  if (!existsSync(metaPath)) return null;
  try {
    const h = JSON.parse(readFileSync(metaPath, 'utf8')) as PsuPtyHost;
    if (h && h.sock && existsSync(h.sock) && h.pid && pidAlive(h.pid)) return h;
  } catch {
    /* unreadable / partial write — treat as no host */
  }
  return null;
}

/**
 * Inject one control message into a live host's socket. `mode:'turn'` = a wake
 * turn (idle-gated host-side, then submitted); `mode:'raw'` = verbatim +
 * IMMEDIATE (force-interrupt bytes: Ctrl-C '\x03' / Esc '\x1b'). Resolves true
 * on a clean write, false on connect error / timeout. Mirrors psu-pty-host.mjs's
 * v1 envelope.
 */
export function injectIntoHost(
  sock: string,
  msg: { mode: 'turn' | 'raw'; data: string },
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
      c.write(JSON.stringify({ v: 1, mode: msg.mode, data: msg.data }));
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
