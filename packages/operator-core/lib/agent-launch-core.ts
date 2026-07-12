/**
 * agent-launch-core — the ONE shared core for launching / resuming / forking
 * `psu` agent sessions from tools (agent-launch-resume-primitives-2026-07-12
 * P-001, D-001/D-002).
 *
 * `capability:terminal`, `capability:launch-agent` and `fleet:launch-on-plan`
 * consume these helpers instead of forking the spawn path:
 *   - the psu-command INJECTORS (fleet / launched-by / account) — targeted,
 *     idempotent rewrites of a raw command string, the capability:terminal
 *     arg-passing model the owner directed launch-agent to mimic;
 *   - the resume/fork RESOLVER (agent id OR native session id → the exact
 *     session to resume, with live-source detection so an in-place resume can
 *     never collide with a still-running CLI — WI-3882/D-007);
 *   - the post-resume KICKOFF INJECT (D-008): a resumed session boots idle and
 *     its presence rows are reaped, so roster-gated coord:wake cannot reach it —
 *     the first turn is delivered through the psu pty-host discovery socket.
 */
import { getOrgPg } from './org-pg';
import { mapAdvSessionRow, type AdvSessionRow } from './adv-sessions';
import { findLiveHost, injectIntoHost, type PsuPtyHost } from './events/await/psu-pty-discovery';

/** Match `psu` as a command token — start of line, or after whitespace / a
 *  shell separator — followed by whitespace. Shared by every injector. */
const PSU_TOKEN = /(^|[\s&;|(])psu(\s)/;

/**
 * named-su-agent-fleets / EI-5835: when the caller passes an explicit `fleet`, a
 * `psu …` launch inside a terminal command should JOIN that fleet — not merely
 * inherit its colour. The `fleet` arg alone is COLOUR-ONLY (it tints the window);
 * fleet MEMBERSHIP comes from psu's own `--fleet=<slug>` flag. Agents repeatedly
 * set `fleet` and forget `--fleet`, so members spawn with `fleetSlug:null` AND miss
 * the launcher's fleet auto-kickoff (they park). Auto-inject `--fleet=<slug>` into a
 * psu command that lacks it so colour and membership can't diverge. Non-psu commands,
 * and commands already carrying `--fleet`, are left untouched.
 */
export function injectFleetArg(
  command: string,
  fleetSlug: string | null,
): { command: string; injected: boolean } {
  if (!fleetSlug) return { command, injected: false };
  if (/(^|\s)--fleet(=|\s|$)/.test(command)) return { command, injected: false };
  if (!PSU_TOKEN.test(command)) return { command, injected: false };
  return { command: command.replace(PSU_TOKEN, `$1psu --fleet=${fleetSlug}$2`), injected: true };
}

/**
 * solo-launch-provenance (the EI-5835 pattern, applied to WHO-launched-you): a `psu …`
 * launch spawned from a tool should carry `--launched-by=<caller ownerId>` so
 * bootstrap-su can bake the provenance into the launched session (system prompt +
 * PAPERCUSP_LAUNCHED_BY + an owner-scoped standing fact). Without it a solo-launched
 * agent has NO way to answer "who launched / supervises you" — su-8ab32510
 * (2026-07-03) described its launcher as "an observer who doesn't assign or
 * supervise my work". Commands already carrying the flag, and non-psu commands,
 * are left untouched. The ownerId is injected into a shell string, so only
 * identity-shaped values are accepted.
 */
export function injectLaunchedByArg(
  command: string,
  launcherOwnerId: string | null,
): { command: string; injected: boolean } {
  if (!launcherOwnerId || !/^[A-Za-z0-9._:-]{1,120}$/.test(launcherOwnerId)) {
    return { command, injected: false };
  }
  if (/(^|\s)--launched-by(=|\s|$)/.test(command)) return { command, injected: false };
  if (!PSU_TOKEN.test(command)) return { command, injected: false };
  return {
    command: command.replace(PSU_TOKEN, `$1psu --launched-by=${launcherOwnerId}$2`),
    injected: true,
  };
}

/**
 * Account pinning for SCRIPTED launches (P-012, owner-hit 2026-07-12): a psu
 * launch/resume with no `--account` prompts an INTERACTIVE account picker
 * (chooseResumeAccount), which blocks a tool-spawned session until a human
 * answers it. Inject `--account=default` (or the caller's explicit account —
 * `default` | `auto` | a pool account id, the account-routing-3-options
 * grammar) into any psu command that lacks one. Value-guarded: an account id
 * lands in a shell string, so only identity-shaped values are accepted.
 */
export function injectAccountArg(
  command: string,
  account: string | null = 'default',
): { command: string; injected: boolean } {
  if (!account || !/^[A-Za-z0-9._:-]{1,120}$/.test(account)) return { command, injected: false };
  if (/(^|\s)--account(=|\s|$)/.test(command)) return { command, injected: false };
  if (!PSU_TOKEN.test(command)) return { command, injected: false };
  return { command: command.replace(PSU_TOKEN, `$1psu --account=${account}$2`), injected: true };
}

/** A resume/fork target fully resolved to the exact session to act on. */
export interface ResumeTarget {
  /** The native CLI session uuid `psu --resume` takes. */
  sessionId: string;
  /** The session's coord identity — the pty-host discovery key + the identity an
   *  in-place resume re-attaches. */
  ownerId: string | null;
  agent: string | null;
  cwd: string | null;
  endedAt: string | null;
  /** A live pty host currently serves this identity — an in-place resume would
   *  collide (WI-3882/WI-3455); the caller must fork instead (D-007). */
  live: boolean;
  advSessionId: number;
}

export type ResolveResumeError =
  | { ok: false; error: 'not_found'; detail: string }
  | { ok: false; error: 'no_native_session_id'; detail: string };

export type ResolveResumeResult = ({ ok: true } & ResumeTarget) | ResolveResumeError;

/**
 * Resume/fork RESOLVER (P-004, D-004): given an AGENT id (`su-…`) or a native
 * CLI session uuid, resolve the most-recent matching `adv_sessions` row so a
 * caller never hunts a transcript uuid by hand — and detect a still-LIVE
 * source (via the pty-host discovery dir) so the caller forks instead of
 * colliding in place (D-007).
 */
export async function resolveResumeTarget(ref: {
  agentId?: string | null;
  sessionId?: string | null;
}): Promise<ResolveResumeResult> {
  const agentId = ref.agentId?.trim() || null;
  const sessionId = ref.sessionId?.trim() || null;
  if (!agentId && !sessionId) {
    return { ok: false, error: 'not_found', detail: 'pass resume.agentId or resume.sessionId' };
  }
  const { sql } = getOrgPg();
  // Exact-pin by native session id wins; else newest row for the agent id.
  // An agentId may be a prefix (short handle) — match prefix, newest first.
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
           window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
      FROM harness_shared.adv_sessions
     WHERE ${
       sessionId
         ? sql`session_id = ${sessionId}`
         : sql`coord_owner_id LIKE ${agentId + '%'}`
     }
     ORDER BY started_at DESC
     LIMIT 1
  `;
  if (!rows.length) {
    return {
      ok: false,
      error: 'not_found',
      detail: sessionId
        ? `no adv_sessions row records native session ${sessionId}`
        : `no adv_sessions row for agent ${agentId} — check the id (coord:presence / sessions:list)`,
    };
  }
  const row: AdvSessionRow = mapAdvSessionRow(rows[0] as never);
  if (!row.sessionId) {
    return {
      ok: false,
      error: 'no_native_session_id',
      detail:
        `adv session #${row.id} (${row.coordOwnerId ?? 'no coord id'}, agent ${row.agent ?? '?'}) carries no ` +
        'native session uuid — it predates native-id tracking or is an omp thread; resume it by hand ' +
        '(`psu --resume` picker) instead.',
    };
  }
  const host: PsuPtyHost | null = row.coordOwnerId ? findLiveHost(row.coordOwnerId) : null;
  return {
    ok: true,
    sessionId: row.sessionId,
    ownerId: row.coordOwnerId,
    agent: row.agent,
    cwd: row.cwd,
    endedAt: row.endedAt,
    live: host != null,
    advSessionId: row.id,
  };
}

/**
 * Compose the scripted `psu` command for launch-agent (P-003/P-005). Always
 * `--no-picker` (a tool launch must never block on an interactive picker) and
 * always account-pinned (P-012). The fleet / launched-by flags are left to the
 * injectors so launch-agent and capability:terminal share one code path.
 */
export function buildAgentLaunchCommand(opts: {
  mode: 'fresh' | 'resume' | 'fork';
  sessionId?: string | null;
  agent?: string | null;
  plan?: string | null;
  account?: string | null;
  extraArgs?: string[] | null;
}): string {
  const parts = ['psu', '--no-picker', `--account=${opts.account?.trim() || 'default'}`];
  if (opts.mode === 'resume' || opts.mode === 'fork') {
    if (!opts.sessionId) throw new Error(`buildAgentLaunchCommand: mode ${opts.mode} requires sessionId`);
    parts.push(`--resume=${opts.sessionId}`);
    if (opts.mode === 'fork') parts.push('--fork');
  } else {
    if (opts.agent) parts.push(`--agent=${opts.agent}`);
    if (opts.plan) parts.push(`--plan=${opts.plan}`);
  }
  for (const a of opts.extraArgs ?? []) {
    // Verbatim passthrough, but never allow shell metacharacters into the
    // command string — these args land inside a terminal greeting one-liner.
    if (!/^[A-Za-z0-9._:=@/,+-]+$/.test(a)) {
      throw new Error(`buildAgentLaunchCommand: refusing extraArg with shell metacharacters: ${JSON.stringify(a)}`);
    }
    parts.push(a);
  }
  return parts.join(' ');
}

/**
 * Post-resume kickoff delivery (P-011, D-008): a resumed session boots IDLE and
 * its presence rows were reaped at death, so roster-gated coord:wake / coord:send
 * reject it (`unknown_recipient`) — nothing coord-side can deliver the first
 * turn. Deliver it through the psu pty-host discovery socket instead
 * (`{v:1, mode:'turn', data}` — idle-gated wake-as-Enter): poll for the host's
 * discovery file (the resumed psu host writes it once the pty is up), then
 * inject. Loud result either way; live-proven on the desktop-release-0-0-8 legs
 * (2026-07-12).
 */
export async function injectKickoffAfterResume(
  ownerId: string,
  kickoff: string,
  {
    timeoutMs = 120_000,
    pollMs = 2_000,
    findHost = findLiveHost,
    inject = injectIntoHost,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    timeoutMs?: number;
    pollMs?: number;
    findHost?: typeof findLiveHost;
    inject?: typeof injectIntoHost;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ delivered: boolean; waitedMs: number; error?: string }> {
  const started = Date.now();
  for (;;) {
    const host = findHost(ownerId);
    if (host?.sock) {
      const ok = await inject(host.sock, { mode: 'turn', data: kickoff });
      return ok
        ? { delivered: true, waitedMs: Date.now() - started }
        : {
            delivered: false,
            waitedMs: Date.now() - started,
            error: `pty host found (pid ${host.pid}) but the socket write failed — inject manually or re-wake once the session registers presence`,
          };
    }
    if (Date.now() - started + pollMs > timeoutMs) {
      return {
        delivered: false,
        waitedMs: Date.now() - started,
        error:
          `no live pty host appeared for ${ownerId} within ${Math.round(timeoutMs / 1000)}s — the resume may have `
          + 'failed to boot (check the terminal window) or the session is headless (kickoff rides the command instead)',
      };
    }
    await sleep(pollMs);
  }
}
