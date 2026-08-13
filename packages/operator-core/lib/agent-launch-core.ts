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
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { mapAdvSessionRow, type AdvSessionRow, type AdvSessionEndedBy } from './adv-sessions';
import { findLiveHost, injectIntoHost, type PsuPtyHost } from './events/await/psu-pty-discovery';
import { composeLaunchModelSpec, MIN_COMPACTION_LIMIT_TOKENS } from './agent-config-constants';

/** Match `psu` as a command token — start of line, or after whitespace / a
 *  shell separator — followed by whitespace. Shared by every injector. */
const PSU_TOKEN = /(^|[\s&;|(])psu(\s)/;

/**
 * Is this terminal command actually an AGENT LAUNCH wearing a command's clothes?
 * (P-004 — the wrong-door guard.)
 *
 * WHY THE DOOR MATTERS, and why this is not pedantry: `capability:terminal` is the
 * arbitrary-COMMAND door and hardcodes `preferProcessPerWindow: true`, which
 * resolves to xterm. `capability:launch-agent` uses `preferProcessPerWindow:
 * isResume`, so a fresh launch gets the owner's normal emulator. Both doors share
 * ONE spawn path — the divergence is emulator POLICY, not mechanism — but a
 * launch through the wrong door lands in a different window manager, skips the
 * backend preflight (P-002) and the started-verification (P-003), and is exactly
 * how the owner's two failed omp launches happened.
 *
 * DELIBERATELY NARROW. `psu --help`, `psu --version`, `psu-sentinel`, and any
 * `psu` mention inside a longer word are NOT launches and must keep working — a
 * guard that over-refuses teaches agents to route around it, which is worse than
 * no guard. The positive test is a `psu` COMMAND TOKEN (the same boundary rule
 * every injector uses) that is not one of the informational flags.
 */
export function classifyAgentLaunchCommand(command: string): {
  isAgentLaunch: boolean;
  mode: 'fresh' | 'resume' | null;
} {
  if (!PSU_TOKEN.test(command ?? '')) return { isAgentLaunch: false, mode: null };
  // Informational invocations print and exit — no agent, no window to supervise.
  if (/(^|\s)--(help|version)(\s|$|=)/.test(command)) return { isAgentLaunch: false, mode: null };
  const resume = /(^|\s)--(resume|fork)(=|\s|$)/.test(command);
  return { isAgentLaunch: true, mode: resume ? 'resume' : 'fresh' };
}

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
  /** ⚠ Only an end time when {@link endedBy} is `'self'`. Otherwise a sweeper stamped it on
   *  NOTICING the process was gone, so it cannot answer "when did this session end". */
  endedAt: string | null;
  /** Who wrote {@link endedAt} (migration 735). `null` = legacy row, provenance UNKNOWN —
   *  which is not the same as a clean self-reported exit. */
  endedBy: AdvSessionEndedBy | null;
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
  // An agentId may be a PREFIX (the short `su-b0fbf` handle agents actually say
  // out loud) — match by prefix, newest first. adv_sessions is deliberately NOT
  // workspace-scoped here: coord_owner_id and session_id are globally unique
  // (see advSessionsByCoordOwner's note), so a workspace predicate could only
  // drop valid rows.
  const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
    WITH indexed_owner AS (
      SELECT owner
        FROM harness_shared.session_turns
       WHERE ${sessionId ? sql`session_id = ${sessionId}` : sql`FALSE`}
         AND owner IS NOT NULL
       ORDER BY ingested_at DESC
       LIMIT 1
    )
    SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
           window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code,
           ended_by
      FROM harness_shared.adv_sessions
     WHERE ${
       sessionId
         ? sql`session_id = ${sessionId}
                 OR coord_owner_id = (SELECT owner FROM indexed_owner)`
         : sql`coord_owner_id LIKE ${agentId + '%'}`
     }
     ORDER BY ${sessionId ? sql`(session_id = ${sessionId}) DESC,` : sql``} started_at DESC
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
  const row: AdvSessionRow = mapAdvSessionRow(rows[0]);
  if (!row.sessionId && !sessionId) {
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
    // Codex cannot be born with a caller-selected native id, so its adv row
    // legitimately carries NULL. session_turns indexes the rollout uuid and
    // its coord owner; when that exact-pin fallback found the row, preserve the
    // requested native id instead of degrading to the interactive picker.
    sessionId: row.sessionId ?? sessionId!,
    ownerId: row.coordOwnerId,
    agent: row.agent,
    cwd: row.cwd,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
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
  harness?: string | null;
  account?: string | null;
  model?: string | null;
  /** psu reasoning effort — composed onto the model spec via {@link composeModelSpec}
   *  (psu has no standalone --effort flag), so it REQUIRES a `model` to attach to. */
  effort?: string | null;
  workspace?: string | null;
  headless?: boolean;
  /** psu --context-size: 'full' (~180k, whole tool catalog) or 'trimmed' (~50k spine). */
  contextSize?: 'full' | 'trimmed' | null;
  /** psu --compaction-limit: seed the session's soft compaction limit (tokens) at launch. */
  compactionLimit?: number | null;
  /** psu --role for the launched agent. */
  role?: string | null;
  /** psu --feature id the agent should pick up. */
  feature?: string | null;
  /** psu --profile launch profile name. */
  profile?: string | null;
  /** psu --brain: launch in brain mode. */
  brain?: boolean;
  /** psu --allow-subagents: opt the session back in to its own subagent-launch tool. */
  allowSubagents?: boolean;
  /** psu --add-dir (repeatable): extra directories added to the agent's workspace. */
  addDir?: string[] | null;
  /** psu --launch-context: path to a brief/markdown file injected as the launch context. */
  launchContext?: string | null;
  /**
   * psu --owner-id: PRE-PIN the launched session's coord identity instead of
   * letting bootstrap-su mint one (WI-5002/EI-13277 exist for exactly this
   * "state a spawner keys pre-spawn" case).
   *
   * The caller needs this whenever it must write a row ABOUT the new agent
   * before the agent exists — `goals:start` stamps `agent_modes` (mode 'goal',
   * subject = the goal id) for this id before it spawns, so the session's very
   * first orient already knows which goal it owns. Without a pre-pin that write
   * is a race against the agent's own boot, and losing it produces the exact
   * failure already filed as EI-20015592992797890: a goal and an agent with
   * nothing joining them.
   *
   * FRESH LAUNCHES ONLY — deliberately ignored on resume/fork. A resumed
   * session already HAS an identity; forcing a fresh one onto it would either
   * be refused by bootstrap-su or split the session away from its own history,
   * which is the pin's purpose inverted (the same rule `/api/adv/launch-su`
   * follows).
   */
  ownerId?: string | null;
  extraArgs?: string[] | null;
  platform?: NodeJS.Platform;
}): string {
  // Every value below lands inside a terminal greeting one-liner, so it is
  // VALIDATED rather than quoted: an identity-shaped value needs no quoting, and
  // anything else is a bug (or an injection) we want to hear about loudly.
  const safe = (label: string, v: string): string => {
    if (!/^[A-Za-z0-9._:=@/,+-]+$/.test(v)) {
      throw new Error(`buildAgentLaunchCommand: refusing ${label} with shell metacharacters: ${JSON.stringify(v)}`);
    }
    return v;
  };
  const parts = [
    'psu',
    '--no-picker',
    // P-012: never leave the account to an interactive picker in a scripted launch.
    // Omission is the explicit product default: the system/CLI credential. Gateway
    // auto-routing requires the caller to say `auto` on every platform.
    `--account=${safe('account', opts.account?.trim() || defaultLaunchAccount(opts.platform))}`,
  ];
  if (opts.mode === 'resume' || opts.mode === 'fork') {
    if (!opts.sessionId) throw new Error(`buildAgentLaunchCommand: mode ${opts.mode} requires sessionId`);
    parts.push(`--resume=${safe('sessionId', opts.sessionId)}`);
    if (opts.mode === 'fork') parts.push('--fork');
  } else {
    // psu REQUIRES --agent on a FRESH launch — an omitted one is not "psu's default",
    // it is a hard boot error (`--agent must be one of claude|omp|codex (got null)`) that
    // leaves the terminal sitting on a dead prompt. Default it here, in the core, so no
    // caller can compose an unlaunchable command. (A resume/fork carries the agent kind
    // in its recorded session, so it must NOT be passed there.)
    parts.push(`--agent=${safe('agent', opts.agent?.trim() || 'claude')}`);
    // Pre-pinned coord identity, in the same slot `/api/adv/launch-su` emits it
    // (after --agent, before --harness) so a GUI launch and a tool launch stay
    // argv-comparable. FRESH ONLY — see the option's doc for why a resume must
    // never carry one.
    if (opts.ownerId) parts.push(`--owner-id=${safe('ownerId', opts.ownerId)}`);
    if (opts.harness) parts.push(`--harness=${safe('harness', opts.harness)}`);
    if (opts.plan) parts.push(`--plan=${safe('plan', opts.plan)}`);
  }
  // --headless keeps the managed-pty host ON despite non-TTY stdio, so the session
  // stays injectable (wakes AND the resume kickoff both ride that pty). Without it a
  // windowless member parks forever after one turn.
  if (opts.headless) parts.push('--headless');
  // Effort rides the MODEL SPEC — psu has no --effort flag (D-001), so join them here.
  // Free-form-safe: a spec like `opus[1m]:high` carries `[]` outside the identity set,
  // so quote (matching memberLaunchCommand) rather than reject it via safe().
  const modelSpec = composeModelSpec(opts.model ?? undefined, opts.effort ?? undefined);
  if (modelSpec) parts.push(`--model=${quoteLaunchValue(modelSpec)}`);
  if (opts.workspace) parts.push(`--workspace=${safe('workspace', opts.workspace)}`);
  if (opts.contextSize) parts.push(`--context-size=${opts.contextSize}`);
  if (opts.compactionLimit) parts.push(`--compaction-limit=${Math.floor(opts.compactionLimit)}`);
  if (opts.role) parts.push(`--role=${quoteLaunchValue(opts.role)}`);
  if (opts.feature) parts.push(`--feature=${quoteLaunchValue(opts.feature)}`);
  if (opts.profile) parts.push(`--profile=${quoteLaunchValue(opts.profile)}`);
  if (opts.brain) parts.push('--brain');
  if (opts.allowSubagents) parts.push('--allow-subagents');
  for (const dir of opts.addDir ?? []) if (dir) parts.push(`--add-dir=${quoteLaunchValue(dir)}`);
  if (opts.launchContext) parts.push(`--launch-context=${quoteLaunchValue(opts.launchContext)}`);
  for (const a of opts.extraArgs ?? []) parts.push(safe('extraArg', a));
  return parts.join(' ');
}

/**
 * The account a scripted launch uses when the caller names none. The default is
 * always the system/CLI credential; platform credential mechanics must make that
 * route work rather than silently changing the user's routing choice.
 */
export function defaultLaunchAccount(_platform: NodeJS.Platform = process.platform): string {
  return 'default';
}

export interface MemberLaunchOpts {
  fleetSlug: string;
  agent: string;
  harness: string;
  /** psu --plan the member self-pulls on. OPTIONAL (P-003): a pure claim-spec fleet
   *  launches with no plan — members pull via their claim spec, so `--plan` is omitted. */
  plan?: string;
  headless?: boolean;
  /**
   * psu --owner-id: PRE-PIN this launch's coord identity instead of letting
   * bootstrap-su mint one. Same flag, same semantics and same FRESH-LAUNCH-ONLY
   * rule as buildAgentLaunchCommand's `ownerId` — see that option's doc for why a
   * resume/fork must never carry one (this composer only ever builds fresh
   * launches, so there is no resume case to guard here).
   *
   * goal-mode-hardening P-009 (NOT the leader-compaction-reseed P-009 that other
   * comments in fleet_registry/launch-on-plan.ts refer to): `leader:'spawn'` must
   * write the fleet row naming its leader BEFORE that leader exists, which is
   * exactly the "state a spawner keys pre-spawn" case the flag was added for.
   * Without it the fleet would have to be created under the CALLER and leadership
   * relayed after boot, leaving a window — permanent if the spawn never boots — in
   * which the registry says the caller leads a fleet it asked not to lead.
   */
  ownerId?: string;
  account?: string;
  workspace?: string;
  role?: string;
  model?: string;
  /** psu --effort: reasoning effort (low|medium|high|xhigh|max) when not baked into the model spec. */
  effort?: string;
  feature?: string;
  launchContext?: string;
  profile?: string;
  contextSize?: 'full' | 'trimmed';
  /** psu --compaction-limit: seed the session's soft compaction limit (tokens) at launch
   *  (per-member-declarative-launch-specs P-005) — removes the brief-instruction workaround. */
  compactionLimit?: number;
  brain?: boolean;
  addDir?: string[];
  allowSubagents?: boolean;
  seat?: string;
  extraArgs?: string[];
}

/**
 * A DECLARATIVE per-member launch spec (per-member-declarative-launch-specs
 * P-001, owner directive 2026-07-19: "make the arg a declarative spec where the
 * caller can specify the per member settings in the spec").
 *
 * Each field, when set, OVERRIDES the fleet-wide launch default for THAT member;
 * an unset field falls through to the fleet default, then the system/model-tier
 * default (D-001 precedence: member > fleet > system). The launch tools compose
 * one {@link MemberLaunchOpts} per member by folding its MemberSpec over the
 * shared fleet base (see {@link foldMemberSpec}), so N members can each run a
 * distinct model / effort / account / carry / context size / compaction limit /
 * role / brief / claim lane — generalizing today's brief-only
 * `perMemberLaunchContext` to ALL settings.
 *
 * `carry` and `claimKinds` are NOT psu command flags (carry shapes the member
 * baseline + loop:arm; claimKinds seeds the per-member claim spec), so they are
 * threaded by the launch tool, not by {@link memberLaunchCommand}.
 */
export interface MemberSpec {
  model?: string;
  effort?: string;
  account?: string;
  carry?: 'warm' | 'cold';
  contextSize?: 'full' | 'trimmed';
  compactionLimit?: number;
  role?: string;
  agent?: string;
  /** Path to a brief file injected as this member's launch context (distinct per member). */
  launchContext?: string;
  /** Inline brief TEXT for this member — composed to a launch-context file by the tool when set. */
  brief?: string;
  /** Per-member claim-lane restriction — seeds this member's claim spec (bee-level, overrides the fleet spec). */
  claimKinds?: Array<'feature' | 'chunk' | 'bug' | 'change' | 'task'>;
  headless?: boolean;
  addDir?: string[];
  allowSubagents?: boolean;
  brain?: boolean;
  feature?: string;
  profile?: string;
  display?: string;
  extraArgs?: string[];
}

/**
 * The wire (zod) shape of {@link MemberSpec} — the ONE shared schema both launch
 * doors accept for `members: MemberSpec[]` (per-member-declarative-launch-specs
 * P-002: `fleet:launch-on-plan` AND `capability:launch-agent`). Kept beside the
 * `MemberSpec` type so the two never drift. Every field is optional and OVERRIDES
 * the fleet-wide arg of the same name for THAT member only; an unset field falls
 * through (member > fleet > system, D-001). `.strict()` so an unknown field is a
 * loud error, not a silent drop.
 *
 * `carry` and `claimKinds` need the fleet baseline / claim-spec machinery only
 * `fleet:launch-on-plan` builds — `capability:launch-agent` accepts them (schema
 * parity) but surfaces a warning rather than honoring them silently.
 */
export const memberSpecSchema = z
  .object({
    model: z.string().optional().describe("psu --model: this member's model spec, overriding the fleet `model`."),
    effort: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max'])
      .optional()
      .describe(
        "Reasoning effort for this member. Composed onto the model spec (`<model>:<effort>`) — psu has no separate --effort flag — so it REQUIRES a model (this member's or the fleet's).",
      ),
    account: z.string().optional().describe("psu --account: this member's account routing (<pool-id>|auto|default)."),
    carry: z.enum(['warm', 'cold']).optional().describe("This member's warm/cold auto-mode carry."),
    contextSize: z.enum(['full', 'trimmed']).optional().describe("psu --context-size for this member."),
    compactionLimit: z
      .number()
      .int()
      .min(MIN_COMPACTION_LIMIT_TOKENS)
      .optional()
      .describe(
        `psu --compaction-limit: this member's soft compaction limit in TOKENS (>= ${MIN_COMPACTION_LIMIT_TOKENS}). Clamped down to the fleet-role ceiling at seed time — it can lower a member's limit, never raise it past its cap.`,
      ),
    role: z.string().optional().describe("psu --role for this member."),
    agent: z.string().optional().describe("psu --agent (claude|omp|codex) for this member."),
    launchContext: z.string().optional().describe("psu --launch-context: this member's own brief FILE path."),
    brief: z
      .string()
      .optional()
      .describe(
        "Inline brief TEXT for this member — becomes its own first turn / composed launch context. Use instead of `launchContext` when you have the text, not a file. Takes precedence over this member's `perMemberLaunchContext` entry.",
      ),
    claimKinds: z
      .array(z.enum(['feature', 'chunk', 'bug', 'change', 'task']))
      .min(1)
      .max(5)
      .optional()
      .describe("Per-member claim lane — seeds THIS member's claim spec, overriding the fleet-level `claimKinds`."),
    headless: z.boolean().optional().describe('Launch this member headless (no window).'),
    addDir: z.array(z.string()).optional().describe("psu --add-dir entries for this member."),
    allowSubagents: z.boolean().optional().describe('psu --allow-subagents for this member.'),
    brain: z.boolean().optional().describe('psu --brain for this member.'),
    feature: z.string().optional().describe('psu --feature for this member.'),
    profile: z.string().optional().describe('psu --profile for this member.'),
    display: z.string().optional().describe("Open this member's terminal on this X display."),
    extraArgs: z.array(z.string()).optional().describe("Extra verbatim psu args for this member."),
  })
  .strict();

/**
 * The fleet-wide launch defaults a per-member {@link MemberSpec} folds over
 * (P-002). Only the command-shaping fields live here; identity fields
 * (fleetSlug / harness / plan) are supplied by the launch tool per member.
 */
export type FleetMemberDefaults = Omit<MemberLaunchOpts, 'fleetSlug' | 'harness' | 'plan'> & {
  carry?: 'warm' | 'cold';
  claimKinds?: Array<'feature' | 'chunk' | 'bug' | 'change' | 'task'>;
};

/**
 * Fold a per-member {@link MemberSpec} over the fleet-wide defaults (P-002,
 * D-001 precedence: member field wins; an UNSET member field is a fallthrough,
 * never a zeroing override). Returns the per-member launch config plus the
 * non-command fields (`carry`, `claimKinds`) the tool threads separately.
 */
export function foldMemberSpec(
  base: FleetMemberDefaults,
  spec: MemberSpec | undefined,
): FleetMemberDefaults {
  if (!spec) return { ...base };
  const pick = <T>(memberVal: T | undefined, baseVal: T | undefined): T | undefined =>
    memberVal !== undefined ? memberVal : baseVal;
  return {
    ...base,
    // `agent` is the one REQUIRED field on the base — `pick` widens to
    // `string | undefined`, so narrow it back: an unset member agent inherits the
    // fleet's, it never clears it.
    agent: spec.agent ?? base.agent,
    model: pick(spec.model, base.model),
    effort: pick(spec.effort, base.effort),
    account: pick(spec.account, base.account),
    carry: pick(spec.carry, base.carry),
    contextSize: pick(spec.contextSize, base.contextSize),
    compactionLimit: pick(spec.compactionLimit, base.compactionLimit),
    role: pick(spec.role, base.role),
    launchContext: pick(spec.launchContext, base.launchContext),
    claimKinds: pick(spec.claimKinds, base.claimKinds),
    headless: pick(spec.headless, base.headless),
    addDir: pick(spec.addDir, base.addDir),
    allowSubagents: pick(spec.allowSubagents, base.allowSubagents),
    brain: pick(spec.brain, base.brain),
    feature: pick(spec.feature, base.feature),
    profile: pick(spec.profile, base.profile),
    extraArgs: pick(spec.extraArgs, base.extraArgs),
  };
}

/**
 * Compose the psu `--model` value from a model id + an optional separate effort
 * (per-member-declarative-launch-specs D-001). A `MemberSpec` names `model` and
 * `effort` independently — the wire form psu understands is the single suffixed
 * spec, so they are joined HERE.
 *
 * WI-6321: the IMPLEMENTATION now lives in the client-safe `agent-config-constants`
 * so the GUI launcher shares it rather than carrying a third copy that dropped
 * effort silently. This wrapper survives only to keep the `memberLaunchCommand:`
 * prefix on the error (fleet-launch callers match on it) and the local name.
 */
export function composeModelSpec(model?: string, effort?: string): string | undefined {
  try {
    return composeLaunchModelSpec(model, effort);
  } catch (e) {
    throw new Error(`memberLaunchCommand: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Shell-quote free-form values that are embedded in the scripted psu command. */
function quoteLaunchValue(value: string): string {
  return /^[A-Za-z0-9_.:=/+@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Compose the scripted psu launch for a fleet member. The command's base
 * identity values are validated as identifiers, while paths, role/profile,
 * launch context, and escape-hatch args retain the fleet launcher's
 * shell-quoting behavior. This keeps the fleet path on the shared launch core
 * without weakening its injection boundary or breaking paths with spaces.
 */
export function memberLaunchCommand(opts: MemberLaunchOpts): string {
  const identifier = (label: string, value: string): string => {
    if (!/^[A-Za-z0-9._:=@/,+-]+$/.test(value)) {
      throw new Error(`memberLaunchCommand: refusing ${label} with shell metacharacters: ${JSON.stringify(value)}`);
    }
    return value;
  };
  const parts = [
    'psu',
    '--no-picker',
    `--fleet=${identifier('fleet', opts.fleetSlug)}`,
    `--agent=${identifier('agent', opts.agent)}`,
    // Pre-pinned coord identity, emitted in the SAME slot buildAgentLaunchCommand
    // uses (after --agent, before --harness) so the two composers stay
    // argv-comparable — the property that lets a GUI launch and a tool launch be
    // diffed against each other when one of them misbehaves.
    ...(opts.ownerId ? [`--owner-id=${identifier('ownerId', opts.ownerId)}`] : []),
    `--harness=${identifier('harness', opts.harness)}`,
  ];
  // P-003: `plan` is optional — a pure claim-spec fleet (launched without a plan)
  // omits `--plan`; its members self-pull via the fleet claim spec, not a plan lane.
  if (opts.plan) parts.push(`--plan=${identifier('plan', opts.plan)}`);
  if (opts.headless) parts.push('--headless');
  if (opts.account) parts.push(`--account=${quoteLaunchValue(opts.account)}`);
  if (opts.workspace) parts.push(`--workspace=${quoteLaunchValue(opts.workspace)}`);
  if (opts.role) parts.push(`--role=${quoteLaunchValue(opts.role)}`);
  // Effort rides the MODEL SPEC, not a flag of its own: psu has no `--effort`
  // (D-001) — an unrecognized flag is WARNED AND DROPPED by parseArgs, so a
  // separate `--effort=` emission is a silent no-op. psu's modelArgsFor splits a
  // `<model>:<effort>` tail per backend (claude → `--model X --effort Y`; codex →
  // `-c model_reasoning_effort`; omp verbatim), so composing it here is the ONE
  // form every backend honors.
  const modelSpec = composeModelSpec(opts.model, opts.effort);
  if (modelSpec) parts.push(`--model=${quoteLaunchValue(modelSpec)}`);
  // P-005 (landed): psu parses `--compaction-limit` and re-emits it onto
  // adv_sessions.launch_argv; the compaction watchdog's seeding pass reads it back
  // and applies it ahead of the tier/model default, clamped to the fleet-role
  // ceiling. Emitting it here is what makes MemberSpec.compactionLimit real.
  if (opts.compactionLimit) parts.push(`--compaction-limit=${Math.floor(opts.compactionLimit)}`);
  if (opts.feature) parts.push(`--feature=${quoteLaunchValue(opts.feature)}`);
  if (opts.launchContext) parts.push(`--launch-context=${quoteLaunchValue(opts.launchContext)}`);
  if (opts.profile) parts.push(`--profile=${quoteLaunchValue(opts.profile)}`);
  if (opts.contextSize) parts.push(`--context-size=${opts.contextSize}`);
  if (opts.brain) parts.push('--brain');
  if (opts.allowSubagents) parts.push('--allow-subagents');
  if (opts.seat) parts.push(`--seat=${quoteLaunchValue(opts.seat)}`);
  for (const dir of opts.addDir ?? []) if (dir) parts.push(`--add-dir=${quoteLaunchValue(dir)}`);
  for (const arg of opts.extraArgs ?? []) if (arg) parts.push(quoteLaunchValue(arg));
  return parts.join(' ');
}

/**
 * The universal MEMBER OPERATING BASELINE rules, composed onto EVERY member's
 * launch context ahead of any per-fleet brief. Encodes the drain-discipline
 * lessons learned watching real fleets run: check-already-fixed before building,
 * flag to the leader (not just the broadcast stream), don't re-claim a
 * ping-ponging item, and always ship completion evidence. Single source so the
 * member's full text and the leader's echo (headlines) can never drift.
 */
export const MEMBER_BASELINE_RULES: ReadonlyArray<{ head: string; body: string }> = [
  {
    head: 'Already-fixed check FIRST',
    body: "Before building anything, spend ~2 min confirming the fix has not already shipped — check code/tests, `git log`, sibling work-items. Re-implementing a peer's fix is the single biggest fleet-time waste. If already done, close it as already-fixed WITH the evidence you checked — do not rebuild it.",
  },
  {
    // EI-8318: members were completing exactly ONE item per external wake, then ending
    // their turn with no armed self-wake — the leader became a manual clock, capping
    // fleet throughput at its re-wake cadence instead of draining continuously.
    // EI-8393: kept tight — this rule is the single biggest driver of the P-013
    // prompt-bloat budget; trim further before adding anything to it.
    head: 'STAY ALIVE across turns — loop:arm at spawn, not park',
    body: 'You have no human at your keyboard: as your FIRST action, call `loop:arm { intervalSec, goal }` to drain your lane. Each wake: pull via `scheduler:get_next` → work to terminal (`work_items:complete`) → repeat — the armed loop re-wakes you automatically. `loop:end` ONLY when nothing is claimable for your spec, or you are genuinely blocked. Ending a turn with no armed loop IS parking (EI-8318): you go silent until the leader manually re-wakes you, capping the WHOLE fleet at their wake cadence.',
  },
  {
    head: 'Flag to your LEADER; keep status in your FLEET, not the whole hive',
    body: 'Send blockers, systemic findings, and "nothing left to claim" to the leader (`wakeOnReply:true`) — broadcast is easy to miss. A finding >1 paragraph goes on the item, not chat; `coord:read {msg_id}` gets its full text. In-fleet: bare to:["*"] auto-scopes `@fleet:<slug>`; `allHive:true` only for system-wide news.',
  },
  {
    head: 'Do not re-claim a ping-ponging item',
    body: 'Releasing an item bumps its `updated_at`, so it can re-surface at the top of your next `scheduler:get_next` pull and you loop on it. If an item reappears right after you release it, sink it (work_items:set_priority) or set it `blocked` with a reason — do not re-claim.',
  },
  {
    head: 'Completion evidence is mandatory',
    body: 'Every terminal transition carries a completion_ref stating (a) files / root-cause, (b) the exact test or verification you ran AND its result, (c) any tests you added. Auditors mark you CLEAN on stated evidence — thin evidence on solid work still gets dinged.',
  },
  {
    head: '"Not available" means DEFERRED, not missing',
    body: 'An InputValidationError / "not available" on a tool means load it (ToolSearch / tools:find) and continue — never stop or report a tool as unavailable.',
  },
  {
    head: 'Edit only the staging tree; git-sync owns commit + push',
    body: 'Never git add / commit / push. If a file-lock blocks an edit, pivot to the next item rather than routing around the lock.',
  },
  {
    head: 'A hive pause is a Mug-loop signal, not a self-drain order',
    body: "`pauseNewWork` / `maxBees` / a pot-steering fact you SEE in orient governs the autonomous mug-cup loop — do NOT stop your claimed work on it. Wind down only on a graceful-drain cue ADDRESSED to you (check its authority+scope stamp: `hive-queen(<hive>)→hive-wide` is the Mug; a `fleet-leader(<other>)→fleet-members` cue is a DIFFERENT fleet's business — ignore it) or an explicit `fleet:*`/owner action. Unsure? Ask your leader, never self-drain on an observed pause.",
  },
  {
    // su-loop-capability-parity P-011: the bee turn-end reflection ritual + the overwatch
    // integrity clause, ported to fleet members (bee.base.md / the overwatch prompt).
    head: 'Turn-end reflection + reporting integrity',
    body: "End each turn with ONE bounded reflection: file an observation (`improvements:capture lane:\"observation\"`) ONLY if the turn surfaced something a FUTURE agent benefits from — a routine turn records NOTHING (a sensor reading, never a fix or self-grade). Never fabricate a signal: a truthful `blocked` beats a fabricated all-clear — never report a state you weren't in, a send you didn't make, or a reading you didn't take.",
  },
  {
    // su-loop-capability-parity P-012: the bee checkpoint protocol (bee.base.md §"End of
    // turn — checkpoint"), ported to fleet members. Store + injection seam already exist.
    head: 'Carry-note checkpoint at every boundary',
    body: 'Write `work_items:checkpoint { id, checkpoint }` at task completion, before going idle at a task boundary, and on graceful-evict — so your successor resumes mid-thread instead of cold. Content = what you accomplished / what is left / the key insight / a gotcha for your successor; concrete facts, not self-evaluation; a compact digest, never a transcript. Replace-on-write (blank to clear).',
  },
];

/** Render the full member-facing baseline markdown (the numbered rules with a
 *  short header). Pure + exported for tests.
 *  P-004 carry (owner directive 2026-07-10, orthogonal to headless): every member
 *  gets an explicit `carry` on its loop:arm instruction. `carry:'warm'` is the
 *  fleet default and is explicit because loop:arm has a different context-sensitive
 *  default for an unattended headless caller. `carry:'cold'` rewrites the rule to
 *  arm a COLD loop (each wake a fresh context) and promotes the carry-note checkpoint
 *  from "at every boundary" to LOAD-BEARING — a cold wake reconstructs ONLY from the
 *  last checkpoint. This keeps the fleet's warm/cold launch knob authoritative and
 *  prevents a headless member from silently overriding the fleet default. */
export function renderMemberBaseline(opts: {
  fleetSlug: string;
  /** OPTIONAL (P-003): a pure claim-spec fleet has no plan — the baseline then points
   *  at the fleet's claim lane instead of a named plan. */
  plan?: string | null;
  count: number;
  carry?: 'warm' | 'cold';
}): string {
  const { fleetSlug, plan, count, carry = 'warm' } = opts;
  const cold = carry === 'cold';
  const rules = MEMBER_BASELINE_RULES.map((r, i) => {
    let body = r.body;
    if (r.head.startsWith('STAY ALIVE')) {
      const carryInstruction = `\`loop:arm { intervalSec, goal, carry: '${carry}' }\``;
      body = body.replace('`loop:arm { intervalSec, goal }`', carryInstruction);
      if (cold) {
        body +=
          ' — you are a COLD member: each wake starts a FRESH context, so nothing but your checkpoint carries across wakes';
      }
    }
    if (cold && r.head.startsWith('Carry-note checkpoint')) {
      body = `${body} COLD CARRY makes this LOAD-BEARING, not optional: your next wake reconstructs itself ONLY from this checkpoint — skip it and your successor-self wakes blind with no memory of what you did.`;
    }
    return `${i + 1}. **${r.head}.** ${body}`;
  }).join('\n');
  return [
    '# Fleet member — operating baseline',
    '',
    `You are one of ${count} parallel worker agent${count === 1 ? '' : 's'} in fleet \`${fleetSlug}\`, ${plan ? `working plan \`${plan}\`` : 'draining your fleet claim-lane backlog'}. The session that launched you is your LEADER — report notable completions and blockers to them.`,
    '',
    "Your loop: **pull** via `scheduler:get_next { harness: '<your-harness>' }` (`heldPaths`, `states`, `rigAvailable`; omit `specId`/`revision` — inherited identity is in `claimedUnder`; leader steers via `scheduler:set_claim_spec`; NOT `work_items:claim_next`; PICKUP is yours) → **read** (`work_items:get`) → **act** (fix / fixed / blocked) → terminal evidence → repeat. Do NOT self-prioritize by scanning `work_items:list`.",
    '',
    '## Non-negotiables',
    rules,
  ].join('\n');
}

/** Compose a member's launch context = the universal baseline + (optionally) the
 *  leader's per-fleet brief BELOW it (the brief wins on fleet-specifics). Pure +
 *  exported for tests. */
export function composeMemberLaunchContext(opts: {
  fleetSlug: string;
  /** OPTIONAL (P-003): absent for a pure claim-spec fleet. */
  plan?: string | null;
  count: number;
  carry?: 'warm' | 'cold';
  customBriefText?: string | null;
}): string {
  const baseline = renderMemberBaseline(opts);
  const brief = opts.customBriefText?.trim();
  if (!brief) return `${baseline}\n`;
  return `${baseline}\n\n---\n\n# Fleet-specific brief (from your leader — wins on specifics)\n\n${brief}\n`;
}

/** The window a launch claim stays authoritative for. Old claims are pruned on
 *  each call — the ledger answers "did THIS call already land", not "has anyone
 *  ever used this key", so a week is generous for a retry. */
const LAUNCH_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AgentLaunchClaim {
  /** false ⇒ a prior call already launched under this key; do NOT launch again. */
  won: boolean;
  /** What that prior call reported (empty for a fresh claim). */
  priorSummary: Record<string, unknown> | null;
  priorLaunchedAt: number | null;
  priorLaunchedBy: string | null;
}

/**
 * Idempotency guard for agent launches (P-014, migration 586). A launch opens
 * REAL windows/processes, so a re-fired tool call (a client retry after a
 * timeout, a loop that fires twice) must not open a SECOND set — the 2026-07-03
 * "12 windows" incident class. The first caller for a key wins the row; a replay
 * loses the INSERT race and gets the original's summary back.
 *
 * No key ⇒ no guard (won: true) — the caller opted out, exactly like cup:spawn.
 */
export async function claimAgentLaunch(opts: {
  workspaceId: string;
  idempotencyKey: string | null | undefined;
  launchedBy?: string | null;
  now?: number;
}): Promise<AgentLaunchClaim> {
  const key = opts.idempotencyKey?.trim();
  if (!key) return { won: true, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null };
  const now = opts.now ?? Date.now();
  const { sql } = getOrgPg();
  try {
    await sql`
      DELETE FROM harness_shared.agent_launch_idempotency
       WHERE launched_at < ${now - LAUNCH_CLAIM_TTL_MS}
    `;
    const won = await sql<Array<{ idempotency_key: string }>>`
      INSERT INTO harness_shared.agent_launch_idempotency
        (workspace_id, idempotency_key, launched_at, launched_by, summary)
      VALUES (${opts.workspaceId}, ${key}, ${now}, ${opts.launchedBy ?? null}, '{}'::jsonb)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `;
    if (won.length) return { won: true, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null };
    const [prior] = await sql<
      Array<{ summary: Record<string, unknown>; launched_at: number; launched_by: string | null }>
    >`
      SELECT summary, launched_at, launched_by
        FROM harness_shared.agent_launch_idempotency
       WHERE workspace_id = ${opts.workspaceId} AND idempotency_key = ${key}
    `;
    return {
      won: false,
      priorSummary: prior?.summary ?? null,
      priorLaunchedAt: prior?.launched_at != null ? Number(prior.launched_at) : null,
      priorLaunchedBy: prior?.launched_by ?? null,
    };
  } catch (e) {
    // The guard is a safety net, not a gate: a ledger outage must not block a
    // launch the caller actually wants. Warn loudly and proceed unguarded.
    console.warn(`[agent-launch] idempotency claim failed (launching unguarded): ${(e as Error)?.message ?? e}`);
    return { won: true, priorSummary: null, priorLaunchedAt: null, priorLaunchedBy: null };
  }
}

/** Record what the winning launch actually did, so a later replay of the same key
 *  can report it instead of a bare "already launched". Best-effort. */
export async function recordAgentLaunchResult(opts: {
  workspaceId: string;
  idempotencyKey: string | null | undefined;
  summary: Record<string, unknown>;
}): Promise<void> {
  const key = opts.idempotencyKey?.trim();
  if (!key) return;
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.agent_launch_idempotency
         SET summary = ${JSON.stringify(opts.summary)}::text::jsonb
       WHERE workspace_id = ${opts.workspaceId} AND idempotency_key = ${key}
    `;
  } catch (e) {
    console.warn(`[agent-launch] idempotency result write failed: ${(e as Error)?.message ?? e}`);
  }
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

// ─── FRESH-launch verification (P-003 / D-004) ───────────────────────────────

/**
 * Tool names that are STATUSLINE / harness machinery, not the agent taking a turn.
 *
 * This list is the whole reason fresh-launch verification is possible. A DEAD
 * launch emits these too — the measured acceptance case (adv_session 14842) fired
 * `activity:report` at +3.6s and `coord:glance` at +3.7s and then never did
 * anything again, for the hour until the reaper closed it. Counting raw tool calls
 * therefore cannot separate a booted-and-working agent from a booted-and-dead one;
 * counting calls OUTSIDE this set can.
 */
export const LAUNCH_STATUSLINE_TOOLS: readonly string[] = ['activity:report', 'coord:glance'];

/** How long to watch a fresh launch before returning a verdict. */
export const FRESH_VERIFY_TIMEOUT_MS = 25_000;
/**
 * A session whose LAST signal of any kind is older than this, at the end of the
 * window, has gone silent. Measured basis: across 24h, a session that never made a
 * real call had its last statusline beat at a median of 4.9s after launch, while a
 * live session keeps beating for hours. 12s sits well clear of the dud median
 * without reaching into a live session's beat interval.
 */
export const FRESH_VERIFY_SILENCE_MS = 12_000;

export interface FreshLaunchSessionProbe {
  advSessionId: number;
  ownerId: string | null;
  /** Successful, agent-chosen calls other than launch statuslines. */
  successfulCalls: number;
  /** ms since this session's most recent signal of ANY kind (null = never any). */
  msSinceLastSignal: number | null;
  /** A live coord_presence row exists for its owner. */
  hasPresence: boolean;
  /** Requested-vs-actual differences measured from the persisted launch spec. */
  attestationDiffs: FreshLaunchAttestationDiff[];
}

export interface FreshLaunchAttestationDiff {
  field: string;
  requested: string | null;
  actual: string | null;
}

export interface FreshLaunchExpectedAttestation {
  ownerId: string;
  agent: string;
  workspaceId: string;
  harnessSlug: string | null;
  planSlug: string | null;
  model: string | null;
  fleetSlug: string | null;
  fleetRole: string | null;
}

export interface FreshLaunchVerdict {
  /**
   * THREE-STATE, never a boolean — see D-004. `true` = observed real agent
   * activity. `false` = observed SILENCE (the 14842 shape) and reported loudly.
   * `null` = UNVERIFIED: still beating at the window's edge but no turn yet, which
   * is the HONEST answer for most healthy launches inside any bounded window.
   */
  agentStarted: boolean | null;
  waitedMs: number;
  sessions: FreshLaunchSessionProbe[];
  /** Operator-facing sentence for the tool's own output. */
  note: string;
}

/**
 * Did the agents this call just launched actually START?
 *
 * ⚠ WHY THIS IS NOT THE OBVIOUS "poll ~20s for the adv_sessions row" CHECK. Three
 * things were measured before writing it (D-004), and each killed a simpler design:
 *
 *  1. The ROW is not evidence. 14842 has a row, a coord_owner_id and a session_id,
 *     and never did anything.
 *  2. A coord_presence row is not a 20s signal — observed lag from launch ranged
 *     7s to 7371s, and presence rows are REAPED, so absence is ambiguous BOTH ways.
 *  3. A 20s boolean would be WRONG FOR MOST HEALTHY LAUNCHES: first real tool call
 *     was p50 31s, p90 417s. Returning `false` there would make this a false-alarm
 *     generator, which is itself a defect — the exact failure a verification check
 *     is supposed to prevent, with the sign flipped.
 *
 * So the positive signal is real activity (fast when it happens), and the NEGATIVE
 * signal is SILENCE — the boot beats stopped — which is precisely what distinguishes
 * the dud. Anything else is honestly reported as unverified.
 *
 * `probe` is injectable so this unit-tests without PG.
 */
export async function verifyFreshLaunchStarted(
  {
    workspaceId,
    launcherOwnerId,
    since,
    expected,
    expectedOwnerIds,
    expectedAttestations,
  }: {
    workspaceId: string;
    launcherOwnerId: string;
    since: number;
    expected: number;
    expectedOwnerIds?: string[];
    expectedAttestations?: FreshLaunchExpectedAttestation[];
  },
  {
    timeoutMs = FRESH_VERIFY_TIMEOUT_MS,
    pollMs = 2_000,
    silenceMs = FRESH_VERIFY_SILENCE_MS,
    probe = probeFreshLaunchSessions,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    timeoutMs?: number;
    pollMs?: number;
    silenceMs?: number;
    probe?: typeof probeFreshLaunchSessions;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<FreshLaunchVerdict> {
  const begun = Date.now();
  let sessions: FreshLaunchSessionProbe[] = [];
  for (;;) {
    sessions = await probe({ workspaceId, launcherOwnerId, since, expectedOwnerIds, expectedAttestations });
    if (expectedOwnerIds?.length) {
      const wanted = new Set(expectedOwnerIds);
      sessions = sessions.filter((session) => session.ownerId != null && wanted.has(session.ownerId));
    }
    const mismatched = sessions.filter(
      (session) => session.successfulCalls > 0 && session.attestationDiffs.length > 0,
    );
    if (mismatched.length > 0) {
      const differences = mismatched.flatMap((session) =>
        session.attestationDiffs.map(
          (diff) => `${session.ownerId ?? session.advSessionId}.${diff.field}: requested=${JSON.stringify(diff.requested)} actual=${JSON.stringify(diff.actual)}`,
        ),
      );
      return {
        agentStarted: false,
        waitedMs: Date.now() - begun,
        sessions,
        note: `✗ ATTESTATION MISMATCH — ${differences.join('; ')}. Stop this launch transaction; do not open a later wave.`,
      };
    }
    // POSITIVE signal — return as soon as it lands, so a healthy launch pays
    // almost nothing and only a suspect one waits out the window.
    if (sessions.length >= expected && sessions.every((s) => s.successfulCalls > 0)) {
      return {
        agentStarted: true,
        waitedMs: Date.now() - begun,
        sessions,
        note: `✓ ${sessions.length} agent${sessions.length > 1 ? 's' : ''} verified running (took a real turn).`,
      };
    }
    if (Date.now() - begun + pollMs > timeoutMs) break;
    await sleep(pollMs);
  }

  const waitedMs = Date.now() - begun;
  const secs = Math.round(waitedMs / 1000);

  if (sessions.length === 0) {
    return {
      agentStarted: false,
      waitedMs,
      sessions,
      note:
        `✗ AGENT DID NOT START — no session registered within ${secs}s. The terminal spawned, but ` +
        `nothing ever reported in: psu died before reaching the operator (a backend it could not ` +
        `execute, a boot refusal, a bad account/model spec). Check the terminal window — it is left ` +
        `open on the failure by design.`,
    };
  }

  // NEGATIVE signal: booted, beat, then went silent. This is the 14842 shape.
  const silent = sessions.filter(
    (s) => s.successfulCalls === 0 && !s.hasPresence && s.msSinceLastSignal != null && s.msSinceLastSignal >= silenceMs,
  );
  if (silent.length > 0 && silent.length === sessions.length) {
    return {
      agentStarted: false,
      waitedMs,
      sessions,
      note:
        `✗ AGENT DID NOT START — ${silent.length} session${silent.length > 1 ? 's' : ''} registered and ` +
        `emitted only the launch statusline calls, then went SILENT (no signal for ` +
        `${Math.round((silent[0].msSinceLastSignal ?? 0) / 1000)}s, no turn taken, no presence). ` +
        `That is a booted CLI that never reached its first turn — the "reports Launched, never ` +
        `actually starts" failure. Do NOT assume it is working: check the terminal window, then ` +
        `relaunch. Sessions: ${silent.map((s) => s.advSessionId).join(', ')}.`,
    };
  }

  // Honest third state. A healthy launch commonly lands here, so it must not read
  // as either success or failure.
  return {
    agentStarted: null,
    waitedMs,
    sessions,
    note:
      `⏳ launch UNVERIFIED after ${secs}s — ${sessions.length} session${sessions.length > 1 ? 's' : ''} ` +
      `registered and ${sessions.length > 1 ? 'are' : 'is'} still signalling, but had not taken a first ` +
      `turn yet. That is NORMAL (first turn is p50 ~31s), not a failure. Confirm with coord:presence ` +
      `in a minute; if it is still idle then, it did not start.`,
  };
}

/**
 * The PG half of {@link verifyFreshLaunchStarted}: which sessions did THIS call
 * launch, and what has each one done?
 *
 * Correlation is `--launched-by=<caller>` in `launch_argv` (the injector puts it
 * on every psu command this door builds) plus `first_seen_at >= since`. That pairs
 * a row to the call that caused it without needing psu to hand an id back.
 */
export async function probeFreshLaunchSessions({
  workspaceId,
  launcherOwnerId,
  since,
  expectedOwnerIds,
  expectedAttestations,
}: {
  workspaceId: string;
  launcherOwnerId: string;
  since: number;
  expectedOwnerIds?: string[];
  expectedAttestations?: FreshLaunchExpectedAttestation[];
}): Promise<FreshLaunchSessionProbe[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: string | number;
        coord_owner_id: string | null;
        successful_calls: string | number;
        ms_since_last_signal: string | number | null;
        has_presence: boolean;
        launch_spec: unknown;
      }>
    >`
      SELECT s.id,
             s.coord_owner_id,
             COALESCE((SELECT count(*) FROM harness_shared.tool_invocations t
                        WHERE t.workspace_id = ${workspaceId}
                          AND t.coord_owner_id = s.coord_owner_id
                          AND t.status = 'ok'
                          AND t.call_origin = 'agent'
                          AND NOT (t.tool_name = ANY (${LAUNCH_STATUSLINE_TOOLS as string[]}))), 0) AS successful_calls,
             (SELECT EXTRACT(EPOCH FROM (now() - max(t.invoked_at))) * 1000
                FROM harness_shared.tool_invocations t
               WHERE t.workspace_id = ${workspaceId}
                 AND t.coord_owner_id = s.coord_owner_id) AS ms_since_last_signal,
             EXISTS (SELECT 1 FROM harness_shared.coord_presence p
                      WHERE p.workspace_id = ${workspaceId}
                        AND p.owner_id = s.coord_owner_id) AS has_presence,
             s.launch_spec
        FROM harness_shared.adv_sessions s
       WHERE s.workspace_id = ${workspaceId}
         AND s.first_seen_at >= to_timestamp(${Math.floor(since / 1000)})
         AND s.launch_argv::text LIKE ${`%--launched-by=${launcherOwnerId}%`}
       ORDER BY s.first_seen_at ASC
       LIMIT 50`;
    const wanted = expectedOwnerIds?.length ? new Set(expectedOwnerIds) : null;
    const expectedByOwner = new Map((expectedAttestations ?? []).map((item) => [item.ownerId, item]));
    return rows.filter((r) => !wanted || (r.coord_owner_id != null && wanted.has(r.coord_owner_id))).map((r) => {
      const expected = r.coord_owner_id ? expectedByOwner.get(r.coord_owner_id) : undefined;
      const spec = r.launch_spec && typeof r.launch_spec === 'object' ? r.launch_spec as Record<string, unknown> : {};
      const fleet = spec.fleet && typeof spec.fleet === 'object' ? spec.fleet as Record<string, unknown> : {};
      const actual: Record<string, string | null> = {
        agent: typeof spec.agent === 'string' ? spec.agent : null,
        workspaceId: typeof spec.workspaceId === 'string' ? spec.workspaceId : null,
        harnessSlug: typeof spec.harnessSlug === 'string' ? spec.harnessSlug : null,
        planSlug: typeof spec.planSlug === 'string' ? spec.planSlug : null,
        model: typeof spec.model === 'string' ? spec.model : null,
        fleetSlug: typeof fleet.slug === 'string' ? fleet.slug : null,
        fleetRole: typeof fleet.role === 'string' ? fleet.role : null,
      };
      const attestationDiffs: FreshLaunchAttestationDiff[] = [];
      if (expected) {
        for (const field of ['agent', 'workspaceId', 'harnessSlug', 'planSlug', 'model', 'fleetSlug', 'fleetRole'] as const) {
          if (expected[field] !== actual[field]) {
            attestationDiffs.push({ field, requested: expected[field], actual: actual[field] });
          }
        }
      }
      return {
      advSessionId: Number(r.id),
      ownerId: r.coord_owner_id,
      successfulCalls: Number(r.successful_calls ?? 0),
      msSinceLastSignal: r.ms_since_last_signal == null ? null : Number(r.ms_since_last_signal),
      hasPresence: Boolean(r.has_presence),
      attestationDiffs,
      };
    });
  } catch (e) {
    // ⚠ THROW, never `return []`. An empty list means "nothing registered", which
    // this verifier reads as agentStarted:FALSE — so swallowing a DB fault here
    // would report a perfectly healthy launch as dead, on the strength of an error
    // in our own probe. That is the same manufacture-a-failure defect the whole
    // check exists to prevent. The caller turns a throw into `null` (unverified),
    // which is the only honest verdict when the instrument is broken.
    throw new Error(`fresh-launch probe failed: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Post-resume LIVENESS VERIFICATION (EI-11524): an in-place `psu --resume` can
 * spawn a clean terminal yet leave NO running agent — the transcript was archived
 * off-disk, or `claude --resume` located the wrong projects dir, so it found
 * nothing, started no process, and the window closed seconds later. That silent
 * no-op previously reported SUCCESS: a launch that opens a window but leaves no
 * live agent is the core EI-11524 defect.
 *
 * A resumed session re-attaches its ORIGINAL coord identity, so a live psu-pty
 * host appearing for that `ownerId` is proof the agent actually booted (the host
 * writes its discovery file once the pty is up, and findLiveHost self-validates:
 * pid alive + socket exists + psu-host identity). If none appears within the
 * window, the resume no-op'd and the caller must say so LOUDLY rather than report
 * a phantom success.
 *
 * Returns as SOON as a host appears — a healthy resume waits only a few seconds;
 * ONLY a failed resume pays the full timeout, which is exactly when we need to
 * wait to detect the failure. Injectable (findHost / sleep) so it unit-tests
 * without a real host, mirroring injectKickoffAfterResume. (A FORK mints a fresh
 * identity we cannot poll by a known ownerId, so verification is scoped to an
 * in-place resume — the exact case the bug documents.)
 */
export async function verifyResumeStarted(
  ownerId: string,
  {
    timeoutMs = 30_000,
    pollMs = 1_000,
    findHost = findLiveHost,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    timeoutMs?: number;
    pollMs?: number;
    findHost?: typeof findLiveHost;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ started: boolean; waitedMs: number }> {
  const begun = Date.now();
  for (;;) {
    if (findHost(ownerId)) return { started: true, waitedMs: Date.now() - begun };
    if (Date.now() - begun + pollMs > timeoutMs) {
      return { started: false, waitedMs: Date.now() - begun };
    }
    await sleep(pollMs);
  }
}
