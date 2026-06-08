/**
 * turn:interrupt — end a peer agent's CURRENT turn (turn-lifecycle-control
 * Phase 4: P-016/P-018/P-019; D-007/D-008/D-009). The dual of the always-arm
 * wake: a wake RESUMES an idle agent; an interrupt ENDS a running agent's turn.
 *
 * Two modes:
 *  - cooperative: inject a high-priority `yield` coord message mid-turn. The
 *    peer reaches a safe checkpoint, persists partial state, releases locks,
 *    writes a successor note, then ends its turn (persona P-017). The polite
 *    default — DEFERS if the target is in a critical section (holds file locks).
 *  - force: end the turn NOW, mid-thinking. A managed-pty session gets a Ctrl+C
 *    inject over its control socket (Phase-3 psu-pty host contract); a headless
 *    spawn gets SIGINT to the session pid (the `-p`/`exec` turn ends but the
 *    session stays resumable by id — the TURN ends, not the agent).
 *
 * Operator-mediated (D-008): every fleet agent runs as the SAME OS user, so
 * authorization / attribution / rate-limit cannot live at the OS socket — they
 * live HERE. Per-agent identity from the MCP call, a REQUIRED reason, every call
 * audited (who → whom / mode / reason / outcome), and storm-rate-limited so a
 * confused or looping agent cannot halt the fleet (D-009).
 */

import net from 'node:net';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { sendMessage } from '../coordination/messages';
import { shortHandle } from '../../coord-schema';
import { COORD_ROLES } from '../coordination/roles';
import { latestAdvSessionByCoordOwner } from '../../adv-sessions';
import { readIdentity } from '../locks/identity';
import { ensureBootstrap, getTxPool, readQueue } from '../locks/su-lock-store';

/** Storm guard (D-009): max interrupts one actor may issue per rolling window
 *  before we refuse — the audit log IS the rate source (no extra table). */
const STORM_WINDOW_MS = 60_000;
const STORM_MAX = 10;

export interface InterruptInput {
  actor: string;
  workspaceId: string;
  owner: string;
  mode: 'cooperative' | 'force';
  reason: string;
}

export interface InterruptDeps {
  /** Inject the cooperative yield coord message; returns the msg id. */
  sendYield?: (input: InterruptInput) => Promise<string>;
  /** Active file-lock paths the target currently holds (critical-section signal). */
  heldLockPaths?: (owner: string) => Promise<string[]>;
  /** Interrupts this actor has issued in the storm window (rate source). */
  recentInterrupts?: (actor: string) => Promise<number>;
  /** The target's live session pid, or null when not interruptibly live. */
  liveSessionPid?: (owner: string) => Promise<number | null>;
  /** Managed-pty Ctrl+C inject over the session control socket; true on success. */
  ptyForce?: (owner: string) => Promise<boolean>;
  /** Send SIGINT to a pid; true on success. */
  sigint?: (pid: number) => boolean;
  /** Append an audit row (who → whom / action / details). */
  audit?: (
    action: string,
    subject: string,
    details: Record<string, unknown>,
    workspaceId: string,
    actor: string,
  ) => Promise<void>;
}

export interface InterruptResult {
  ok: boolean;
  mode: 'cooperative' | 'force';
  deferred?: boolean;
  channel?: 'pty-ctrl-c' | 'sigint';
  delivered?: string;
  error?: string;
  reason?: string;
  held?: string[];
  critical_warning?: string;
  note?: string;
}

/**
 * The testable core (deps injected, mirrors wake-executor's executeWake).
 * Never throws — every failure is a structured result.
 */
export async function performInterrupt(input: InterruptInput, deps: InterruptDeps): Promise<InterruptResult> {
  const audit = deps.audit ?? (async () => {});

  // Self-interrupt is a footgun — refuse.
  if (input.owner === input.actor) {
    return { ok: false, mode: input.mode, error: 'cannot interrupt your own turn' };
  }

  // Storm guard (D-009): cap interrupts/min/actor so a looping agent can't halt the fleet.
  const recent = (await deps.recentInterrupts?.(input.actor).catch(() => 0)) ?? 0;
  if (recent >= STORM_MAX) {
    await audit('turn.interrupt_rate_limited', input.owner, { mode: input.mode, reason: input.reason, recent }, input.workspaceId, input.actor);
    return {
      ok: false,
      mode: input.mode,
      error: 'rate_limited',
      reason: `more than ${STORM_MAX} interrupts in the last ${STORM_WINDOW_MS / 1000}s — refusing (storm guard)`,
    };
  }

  // Critical-section signal (D-009): active file locks = a mid multi-file edit.
  const held = (await deps.heldLockPaths?.(input.owner).catch(() => [])) ?? [];
  const critical = held.length > 0;

  if (input.mode === 'cooperative') {
    if (critical) {
      // Honor the critical section: a hard yield mid-edit can orphan a lock /
      // leave a half-written file. Let it finish its atomic edit + release.
      await audit('turn.interrupt_deferred', input.owner, { reason: input.reason, held }, input.workspaceId, input.actor);
      return {
        ok: false,
        mode: 'cooperative',
        deferred: true,
        held,
        reason: `target is in a critical section (holds ${held.length} file lock(s)) — cooperative yield DEFERRED so it can finish its atomic edit + release locks. Retry shortly, or use mode:'force' (warns + may orphan the edit).`,
      };
    }
    let msgId = '';
    try {
      msgId = (await deps.sendYield?.(input)) ?? '';
    } catch (e) {
      await audit('turn.interrupt_failed', input.owner, { mode: 'cooperative', error: String(e) }, input.workspaceId, input.actor);
      return { ok: false, mode: 'cooperative', error: `failed to deliver yield: ${String(e)}` };
    }
    await audit('turn.interrupt_cooperative', input.owner, { reason: input.reason, msg_id: msgId }, input.workspaceId, input.actor);
    return {
      ok: true,
      mode: 'cooperative',
      delivered: msgId,
      note: 'yield injected — the peer wraps up + ends its turn at its next checkpoint (it is NOT killed; if it ignores the yield, escalate to force).',
    };
  }

  // ── force ──
  let channel: 'pty-ctrl-c' | 'sigint' | null = null;
  let err: string | null = null;

  // (1) managed-pty Ctrl+C over the session control socket (graceful for a TUI).
  const ptyOk = (await deps.ptyForce?.(input.owner).catch(() => false)) ?? false;
  if (ptyOk) {
    channel = 'pty-ctrl-c';
  } else {
    // (2) headless SIGINT to the session pid — ends the turn; session stays resumable.
    const pid = (await deps.liveSessionPid?.(input.owner).catch(() => null)) ?? null;
    if (pid != null) {
      const ok = deps.sigint?.(pid) ?? false;
      if (ok) channel = 'sigint';
      else err = `SIGINT to pid ${pid} failed`;
    } else {
      err =
        'no live interruptible session (no managed-pty control socket and no live session pid) — nothing to force-interrupt; the peer may be idle (use a wake instead) or already ended its turn';
    }
  }

  const warn = critical
    ? `target held ${held.length} file lock(s) (${held.slice(0, 3).join(', ')}${held.length > 3 ? '…' : ''}) — a forced interrupt may have orphaned a half-written edit or a lock; check + recover`
    : undefined;

  if (channel) {
    await audit('turn.interrupt_force', input.owner, { reason: input.reason, channel, critical, held: critical ? held : undefined }, input.workspaceId, input.actor);
    return { ok: true, mode: 'force', channel, ...(warn ? { critical_warning: warn } : {}) };
  }
  await audit('turn.interrupt_failed', input.owner, { mode: 'force', error: err, critical }, input.workspaceId, input.actor);
  return { ok: false, mode: 'force', error: err ?? 'force interrupt failed', ...(warn ? { critical_warning: warn } : {}) };
}

// ── real-dependency helpers (the production wiring) ──

function pidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeInterruptAudit(
  action: string,
  subject: string,
  details: Record<string, unknown>,
  workspaceId: string,
  actor: string,
): Promise<void> {
  // Mirror process-kill.ts: inline INSERT into harness_shared.audit_log (the
  // table audit:list reads). Audit failures never block the operation.
  try {
    const { sql } = getOrgPg();
    const id = `interrupt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, action, subject, JSON.stringify(details), workspaceId],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[turn:interrupt] audit write failed:', err);
  }
}

async function recentInterruptCount(actor: string): Promise<number> {
  try {
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.audit_log
        WHERE actor = $1
          AND action IN ('turn.interrupt_cooperative', 'turn.interrupt_force')
          AND ts > $2`,
      [actor, Date.now() - STORM_WINDOW_MS],
    )) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

async function liveSessionPid(owner: string): Promise<number | null> {
  const s = await latestAdvSessionByCoordOwner(owner);
  if (!s || s.endedAt) return null;
  return s.pid != null && pidAlive(s.pid) ? s.pid : null;
}

/**
 * Force-interrupt a managed-pty session by writing a raw Ctrl+C envelope to its
 * control socket (Phase-3 psu-pty host contract: `{v:1,mode:'raw',data:''}`
 * bypasses the wake idle-gate and writes the byte verbatim). The discovery
 * helper `findLiveHost(owner)` is added with the Phase-3 wake channel; until it
 * lands this dynamic import misses and force falls back to headless SIGINT — so
 * there is ZERO build-order coupling between this tool and Phase 3.
 */
async function ptyForceInterrupt(owner: string): Promise<boolean> {
  try {
    const mod = (await import('../../events/await/psu-pty-discovery').catch(() => null)) as
      | { findLiveHost?: (owner: string) => Promise<{ sock?: string } | null> }
      | null;
    const findLiveHost = mod?.findLiveHost;
    if (typeof findLiveHost !== 'function') return false;
    const host = await findLiveHost(owner);
    const sock = host?.sock;
    if (!sock) return false;
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      const c = net.createConnection(sock, () => {
        c.write(JSON.stringify({ v: 1, mode: 'raw', data: '' }), (e) => {
          c.end();
          finish(!e);
        });
      });
      c.on('error', () => finish(false));
      setTimeout(() => {
        try {
          c.destroy();
        } catch {
          /* ignore */
        }
        finish(false);
      }, 2000);
    });
  } catch {
    return false;
  }
}

export default defineTool({
  name: 'turn:interrupt',
  description:
    "End a peer agent's CURRENT turn (the dual of a wake). mode:'cooperative' injects a high-priority `yield` so the peer reaches a safe checkpoint, saves partial state, releases locks, and ends its turn (the polite default; DEFERS if the target holds file locks). mode:'force' ends the turn NOW, mid-thinking — Ctrl+C to a managed-pty session or SIGINT to a headless one (the turn ends; the session stays resumable). reason is REQUIRED + audited; storm-rate-limited so it can't be used to halt the fleet.",
  guidance: {
    when: "A peer is doing the wrong thing / working on something now-obsolete / looping, and you need its current turn to STOP. Prefer cooperative (it wraps up cleanly + saves); use force only when it must stop mid-thinking and cooperative was ignored or there's no time.",
    notWhen:
      "To wake an IDLE peer, use coord:send {wake:true} — interrupt is for a RUNNING peer. To hand work over, coord:handoff. Don't force a peer that holds file locks unless necessary (it can orphan a half-written edit) — cooperative defers exactly to avoid that.",
  },
  capability: 'turn:interrupt',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    owner: z.string().min(1).describe('ownerId of the peer whose current turn to end (NOT yourself).'),
    mode: z
      .enum(['cooperative', 'force'])
      .describe(
        "cooperative = injected yield, peer wraps up at its next checkpoint (deferred if it holds locks); force = end the turn now (pty Ctrl+C / headless SIGINT), mid-thinking.",
      ),
    reason: z.string().min(1).describe('REQUIRED — why you are ending their turn. Audited + shown to the peer.'),
  }),
  async handler(args, ctx) {
    const me = resolveAgentIdentity(ctx);
    // The caller's coordination domain — file locks are domain-scoped, and the
    // whole fleet shares one domain, so the target's active locks resolve here.
    let coordinationDomain: string | null = null;
    try {
      coordinationDomain = readIdentity(ctx).coordinationDomain;
    } catch {
      coordinationDomain = null;
    }

    const input: InterruptInput = {
      actor: me.ownerId,
      workspaceId: me.workspaceId ?? '*',
      owner: args.owner,
      mode: args.mode,
      reason: args.reason,
    };

    const result = await performInterrupt(input, {
      sendYield: async (i) =>
        (
          await sendMessage(me, {
            to: [i.owner],
            summary: `yield requested by ${shortHandle(i.actor)}: ${i.reason}`,
            body:
              `A peer (${shortHandle(i.actor)}) asks you to YIELD your current turn — reason: ${i.reason}\n\n` +
              'Reach a safe checkpoint, persist partial state to your work_item, heartbeat/release any locks you hold, write a one-line successor note, then END YOUR TURN. You are NOT killed — a fresh turn can resume the work. (turn:interrupt cooperative)',
            kind: 'yield',
          })
        ).msg_id,
      heldLockPaths: async (owner) => {
        if (!coordinationDomain) return [];
        try {
          await ensureBootstrap();
          const sql = getTxPool();
          const q = await readQueue(sql, { coordinationDomain, owner });
          return q.active_locks.map((l) => l.path);
        } catch {
          return [];
        }
      },
      recentInterrupts: recentInterruptCount,
      liveSessionPid,
      ptyForce: ptyForceInterrupt,
      sigint: (pid) => {
        try {
          process.kill(pid, 'SIGINT');
          return true;
        } catch {
          return false;
        }
      },
      audit: writeInterruptAudit,
    });

    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
