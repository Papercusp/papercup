/**
 * fleet:kill — the UNIFIED agent-termination endpoint (WI-3728, owner-directed
 * 2026-07-10): kill a DESKTOP agent (interactive psu session in a visible
 * terminal) or a HEADLESS agent (nursery cup/bee) through ONE verb, with
 * `close_terminal` controlling whether a desktop agent's terminal WINDOW is
 * also closed.
 *
 * Why one endpoint (owner design call): "killing is similar to close" — the
 * split surfaces before this were fleet:cancel (headless nursery subtrees
 * ONLY — it REFUSES interactive sessions) and NOTHING for desktop terminals
 * (stale fleet windows accumulated on the owner's desktop forever). fleet:kill
 * resolves each target's kind and routes:
 *
 *   - nursery spawn (spawn_id or session_owner match in
 *     harness_shared.spawned_agents) → the EXISTING cancelSubtree path
 *     (transitive cancel + claim/lock release + local process abort) — reuse,
 *     not a parallel system. `close_terminal` is meaningless here (headless)
 *     and reported as terminal:'none'.
 *
 *   - desktop psu session (live psu-pty host discovered by coord ownerId) →
 *     graceful SIGTERM to the session host process (escalating to SIGKILL if
 *     it lingers), and when `close_terminal` (default true) ALSO closes the
 *     enclosing terminal window. The window does NOT close on its own: the
 *     launch command ends with `exec $SHELL -l`, so after psu exits the tab
 *     drops to an interactive shell and sits there forever — closing means
 *     killing the tab's shell process, which we resolve by walking the psu
 *     host's ancestry BEFORE killing it (afterwards the link is gone).
 *
 *   - bare terminal window (`terminal_pids`) → close an ORPHANED/stale fleet
 *     window whose agent already exited (the post-`exec` shell). Validated:
 *     the pid must carry the papercusp console env marker
 *     (PAPERCUSP_HARNESS_SLUG in /proc/<pid>/environ) so this can never be
 *     aimed at an arbitrary host process.
 *
 * Safety (mirrors turn:interrupt D-008/D-009 + process-kill.ts): self-kill
 * refused; a REQUIRED reason; every kill audited (who → whom / kind / outcome)
 * to harness_shared.audit_log; bulk capped. Same-UID is the OS boundary — the
 * authorization/attribution layer is HERE, operator-mediated.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readFileSync } from 'node:fs';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { findLiveHost, type PsuPtyHost } from '../../events/await/psu-pty-discovery';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText } from '../limits';

/** Console-marker substring stamped into every fleet/desktop launch command
 *  (capability:terminal / fleet:launch-on-plan) — identifies a papercusp tab
 *  shell's cmdline while psu is still running. */
const CONSOLE_MARKER = '.papercup-console-active';

/** Env marker that SURVIVES the tab shell's `exec $SHELL -l` (cmdline does not)
 *  — the validation gate for closing a stale window by pid. */
const ENV_MARKER = 'PAPERCUSP_HARNESS_SLUG=';

const KILL_WAIT_POLLS = 6;
const KILL_WAIT_MS = 250;

// ── injectable process primitives (the DI seam, mirrors turn/interrupt) ──

export interface ProcInfo {
  ppid: number | null;
  cmdline: string | null;
  environHas: (marker: string) => boolean;
}

export interface KillDeps {
  /** Live psu-pty host for a coord ownerId (null = no live interactive session). */
  findHost?: (ownerId: string) => PsuPtyHost | null;
  /** Read a pid's ppid/cmdline/environ; null when the pid is gone. */
  readProc?: (pid: number) => ProcInfo | null;
  /** Send a signal; true when delivered. */
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  /** Is the pid alive? */
  alive?: (pid: number) => boolean;
  /** Resolve+cancel a nursery target (spawn_id or session_owner). Returns null
   *  when the target is not a nursery spawn. */
  cancelNursery?: (target: string, reason: string) => Promise<{ spawn_id: string; cancelled: string[]; processes_aborted: number } | null>;
  /** Append an audit row. */
  audit?: (action: string, subject: string, details: Record<string, unknown>) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface KillOneInput {
  actor: string;
  target: string;
  closeTerminal: boolean;
  reason: string;
}

export interface KillOneResult {
  ok: boolean;
  target: string;
  kind?: 'desktop' | 'nursery';
  killed?: boolean;
  signal?: 'SIGTERM' | 'SIGKILL';
  /** 'closed' | 'left-open' (close_terminal:false) | 'none' (headless) | 'not-found'. */
  terminal?: 'closed' | 'left-open' | 'none' | 'not-found';
  cancelled?: string[];
  processes_aborted?: number;
  code?: 'self_kill_refused' | 'not_found';
  error?: string;
}

const defaultReadProc = (pid: number): ProcInfo | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // stat: "pid (comm) state ppid …" — comm may contain spaces/parens; parse after the LAST ')'.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(after[1]);
    let cmdline: string | null = null;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      cmdline = null;
    }
    return {
      ppid: Number.isFinite(ppid) ? ppid : null,
      cmdline,
      environHas: (marker: string) => {
        try {
          return readFileSync(`/proc/${pid}/environ`, 'utf8').replace(/\0/g, '\n').includes(marker);
        } catch {
          return false;
        }
      },
    };
  } catch {
    return null;
  }
};

const defaultKill = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Walk UP from the psu host pid to the terminal TAB SHELL — the topmost
 * ancestor whose cmdline carries the papercusp console marker. Must run
 * BEFORE the host is killed (afterwards the chain is gone). Bounded walk;
 * null when no marked ancestor exists (e.g. psu launched from the user's own
 * shell — then there is NO fleet-owned window and we must NOT close anything).
 */
export function findTabShellPid(hostPid: number, readProc: (pid: number) => ProcInfo | null): number | null {
  let pid = hostPid;
  let found: number | null = null;
  for (let hop = 0; hop < 12; hop++) {
    const info = readProc(pid);
    if (!info || !info.ppid || info.ppid <= 1) break;
    const parent = readProc(info.ppid);
    if (parent?.cmdline?.includes(CONSOLE_MARKER)) found = info.ppid; // keep climbing — topmost marked wins
    pid = info.ppid;
  }
  return found;
}

/** Graceful-then-forceful process stop: SIGTERM, poll, SIGKILL if lingering. */
async function stopPid(
  pid: number,
  deps: Required<Pick<KillDeps, 'kill' | 'alive' | 'sleep'>>,
): Promise<'SIGTERM' | 'SIGKILL' | null> {
  if (!deps.alive(pid)) return null;
  deps.kill(pid, 'SIGTERM');
  for (let i = 0; i < KILL_WAIT_POLLS; i++) {
    if (!deps.alive(pid)) return 'SIGTERM';
    await deps.sleep(KILL_WAIT_MS);
  }
  deps.kill(pid, 'SIGKILL');
  return 'SIGKILL';
}

/** The testable core — never throws; every failure is a structured result. */
export async function killOne(input: KillOneInput, deps: KillDeps): Promise<KillOneResult> {
  const audit = deps.audit ?? (async () => {});
  const readProc = deps.readProc ?? defaultReadProc;
  const prims = { kill: deps.kill ?? defaultKill, alive: deps.alive ?? defaultAlive, sleep: deps.sleep ?? defaultSleep };

  if (input.target === input.actor) {
    return { ok: false, target: input.target, code: 'self_kill_refused', error: 'refusing to kill your own session — end your turn / loop:end instead' };
  }

  // ── leg 1: nursery (headless) — the existing cancel machinery, reused ──
  const nursery = await (deps.cancelNursery?.(input.target, input.reason).catch(() => null) ?? Promise.resolve(null));
  if (nursery) {
    await audit('fleet.kill_nursery', input.target, { reason: input.reason, spawn_id: nursery.spawn_id, cancelled: nursery.cancelled.length });
    return {
      ok: true,
      target: input.target,
      kind: 'nursery',
      killed: true,
      cancelled: nursery.cancelled,
      processes_aborted: nursery.processes_aborted,
      terminal: 'none',
    };
  }

  // ── leg 2: desktop interactive psu session ──
  const host = deps.findHost?.(input.target) ?? null;
  if (!host) {
    return {
      ok: false,
      target: input.target,
      code: 'not_found',
      error:
        'no live session: not a nursery spawn and no live psu-pty host for this ownerId — already dead/exited. ' +
        'A leftover WINDOW from an exited agent can be closed via `terminal_pids` (see the launch report or .papercup-console-active.<pid> marker files for the pid).',
    };
  }

  // Resolve the window BEFORE killing (the ancestry link dies with the host).
  const tabShellPid = input.closeTerminal ? findTabShellPid(host.pid, readProc) : null;

  const signal = (await stopPid(host.pid, prims)) ?? 'SIGTERM';
  if (host.ptyPid && host.ptyPid !== host.pid && prims.alive(host.ptyPid)) {
    prims.kill(host.ptyPid, 'SIGTERM');
  }

  let terminal: KillOneResult['terminal'] = 'left-open';
  if (input.closeTerminal) {
    if (tabShellPid) {
      // SIGHUP first (the "window closed" signal a shell expects), then TERM.
      prims.kill(tabShellPid, 'SIGHUP');
      await prims.sleep(KILL_WAIT_MS);
      if (prims.alive(tabShellPid)) prims.kill(tabShellPid, 'SIGTERM');
      terminal = 'closed';
    } else {
      terminal = 'not-found';
    }
  }

  await audit('fleet.kill_desktop', input.target, {
    reason: input.reason,
    host_pid: host.pid,
    signal,
    terminal,
    tab_shell_pid: tabShellPid ?? undefined,
  });
  return { ok: true, target: input.target, kind: 'desktop', killed: true, signal, terminal };
}

/** Close a bare (agent-already-exited) fleet terminal window by tab-shell pid.
 *  Gate: the pid MUST carry the papercusp console env marker — never a lever
 *  against arbitrary host processes. Exported for tests. */
export async function closeTerminalPid(
  pid: number,
  deps: Pick<KillDeps, 'readProc' | 'kill' | 'alive' | 'sleep'>,
): Promise<{ ok: boolean; pid: number; closed?: boolean; error?: string }> {
  const readProc = deps.readProc ?? defaultReadProc;
  const prims = { kill: deps.kill ?? defaultKill, alive: deps.alive ?? defaultAlive, sleep: deps.sleep ?? defaultSleep };
  const info = readProc(pid);
  if (!info) return { ok: false, pid, error: 'pid not found' };
  const marked = info.environHas(ENV_MARKER) || Boolean(info.cmdline?.includes(CONSOLE_MARKER));
  if (!marked) {
    return { ok: false, pid, error: 'refused: pid carries no papercusp console marker (PAPERCUSP_HARNESS_SLUG env / launch cmdline) — fleet:kill only closes papercusp fleet windows' };
  }
  prims.kill(pid, 'SIGHUP');
  await prims.sleep(KILL_WAIT_MS);
  if (prims.alive(pid)) prims.kill(pid, 'SIGTERM');
  return { ok: true, pid, closed: true };
}

// ── production wiring ──

async function writeKillAudit(
  action: string,
  subject: string,
  details: Record<string, unknown>,
  workspaceId: string,
  actor: string,
): Promise<void> {
  // Mirror process-kill.ts / turn:interrupt — inline INSERT into the table
  // audit:list reads; audit failures never block the operation.
  try {
    const { sql } = getOrgPg();
    const id = `fleetkill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, action, subject, JSON.stringify(details), workspaceId],
    );
  } catch (err) {
    console.warn('[fleet:kill] audit write failed:', err);
  }
}

async function cancelNurseryTarget(
  target: string,
  reason: string,
  workspaceId: string,
  actor: ReturnType<typeof resolveAgentIdentity>,
): Promise<{ spawn_id: string; cancelled: string[]; processes_aborted: number } | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ spawn_id: string }[]>`
    SELECT spawn_id
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND (spawn_id = ${target} OR session_owner = ${target})
     ORDER BY started_at DESC
     LIMIT 1
  `;
  if (!rows[0]) return null;
  const { cancelSubtree } = await import('../../fleet/nursery');
  const res = await cancelSubtree(sql, {
    workspaceId,
    rootSpawnId: rows[0].spawn_id,
    reason,
    actor,
  });
  let processes_aborted = 0;
  try {
    const { abortLocalSpawn } = await import('../../fleet/operator-spawn');
    for (const c of res.cancelled) if (abortLocalSpawn(c.spawnId)) processes_aborted++;
  } catch {
    /* best-effort local abort, mirrors fleet:cancel */
  }
  return { spawn_id: res.rootSpawnId, cancelled: res.cancelled.map((c) => c.spawnId), processes_aborted };
}

export default defineTool({
  name: 'fleet:kill',
  profile: 'engineer',
  description:
    'KILL an agent — desktop OR headless — through one verb. Desktop psu member: graceful SIGTERM (→SIGKILL) to its session, and close_terminal (default true) ALSO closes its terminal window (windows never close on their own — the tab drops to a shell after the agent exits). Headless nursery cup/bee: delegates to the transitive cancel path (claims + locks released). `terminal_pids` closes ORPHANED windows whose agent already exited. Self-kill refused; reason required; every kill audited.',
  guidance: {
    when: 'Winding down a fleet member for real (not just ending its turn — that is turn:interrupt), removing a dead member\'s stale window, or stopping a headless cup. "Close that agent\'s terminal" / "kill that bee" both land here.',
    notWhen: 'To END A TURN but keep the agent alive — turn:interrupt. To cancel a whole nursery subtree by spawn id with full bulk semantics — fleet:cancel (fleet:kill delegates to the same machinery for a single headless target).',
    chaining: 'coord:presence / fleet:assignments (find the ownerId) → fleet:kill { owner, reason } . Stale windows: fleet:kill { terminal_pids:[…], reason }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      owner: z.string().min(1).optional().describe('One agent to kill, by coord ownerId (n=1 shorthand for owners:[id]). Desktop psu member or headless nursery spawn — the tool resolves which.'),
      owners: z.array(z.string().min(1)).min(1).max(20).optional().describe('Many agents to kill (1–20).'),
      terminal_pids: z
        .array(z.number().int().positive())
        .min(1)
        .max(20)
        .optional()
        .describe('Close ORPHANED fleet terminal windows by tab-shell pid (the agent already exited; the window sits at a shell). Validated against the papercusp console marker — arbitrary host pids are refused.'),
      close_terminal: z.boolean().optional().describe('Desktop targets: also close the terminal window (default true). false = kill the agent, leave its window open at a shell for inspection. Ignored for headless targets (no terminal).'),
      reason: softText(4000).describe('Why — REQUIRED; goes to the audit row (who → whom / kind / outcome).'),
      workspace: z.string().max(120).optional(),
    })
    .refine((a) => Boolean(a.owner) || (a.owners?.length ?? 0) > 0 || (a.terminal_pids?.length ?? 0) > 0, {
      message: 'pass `owner`/`owners` (agents) and/or `terminal_pids` (orphaned windows)',
    }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const reason = clampText(args.reason, 4000) ?? 'fleet:kill';
    const closeTerminal = args.close_terminal !== false;
    const deps: KillDeps = {
      findHost: (ownerId) => findLiveHost(ownerId),
      cancelNursery: (target, why) => cancelNurseryTarget(target, why, workspaceId, actor),
      audit: (action, subject, details) => writeKillAudit(action, subject, details, workspaceId, actor.ownerId),
    };

    const ownerIds = mergeIds(args.owner, args.owners);
    const env = await runBulk(
      ownerIds,
      async (target) => killOne({ actor: actor.ownerId, target, closeTerminal, reason }, deps),
      { keyOf: (target) => ({ target }) },
    );

    // Orphaned-window leg (separate keyspace: pids, not ownerIds).
    const windows: Array<{ ok: boolean; pid: number; closed?: boolean; error?: string }> = [];
    for (const pid of args.terminal_pids ?? []) {
      const r = await closeTerminalPid(pid, {});
      if (r.ok) await writeKillAudit('fleet.kill_window', String(pid), { reason }, workspaceId, actor.ownerId);
      windows.push(r);
    }

    // One envelope: the ownerId results + (when requested) the window results,
    // both self-describing. bulkContent wraps in the canonical { data } shape.
    return bulkContent(windows.length === 0 ? env : { ...env, windows });
  },
});
