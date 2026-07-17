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
import { getOrgPg } from '@papercusp/db-org';
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
  // An agentId may be a PREFIX (the short `su-b0fbf` handle agents actually say
  // out loud) — match by prefix, newest first. adv_sessions is deliberately NOT
  // workspace-scoped here: coord_owner_id and session_id are globally unique
  // (see advSessionsByCoordOwner's note), so a workspace predicate could only
  // drop valid rows.
  const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
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
  const row: AdvSessionRow = mapAdvSessionRow(rows[0]);
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
  harness?: string | null;
  account?: string | null;
  model?: string | null;
  workspace?: string | null;
  headless?: boolean;
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
    if (opts.harness) parts.push(`--harness=${safe('harness', opts.harness)}`);
    if (opts.plan) parts.push(`--plan=${safe('plan', opts.plan)}`);
  }
  // --headless keeps the managed-pty host ON despite non-TTY stdio, so the session
  // stays injectable (wakes AND the resume kickoff both ride that pty). Without it a
  // windowless member parks forever after one turn.
  if (opts.headless) parts.push('--headless');
  if (opts.model) parts.push(`--model=${safe('model', opts.model)}`);
  if (opts.workspace) parts.push(`--workspace=${safe('workspace', opts.workspace)}`);
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
  plan: string;
  headless?: boolean;
  account?: string;
  workspace?: string;
  role?: string;
  model?: string;
  feature?: string;
  launchContext?: string;
  profile?: string;
  contextSize?: 'full' | 'trimmed';
  brain?: boolean;
  addDir?: string[];
  allowSubagents?: boolean;
  seat?: string;
  extraArgs?: string[];
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
    `--harness=${identifier('harness', opts.harness)}`,
    `--plan=${identifier('plan', opts.plan)}`,
  ];
  if (opts.headless) parts.push('--headless');
  if (opts.account) parts.push(`--account=${quoteLaunchValue(opts.account)}`);
  if (opts.workspace) parts.push(`--workspace=${quoteLaunchValue(opts.workspace)}`);
  if (opts.role) parts.push(`--role=${quoteLaunchValue(opts.role)}`);
  if (opts.model) parts.push(`--model=${quoteLaunchValue(opts.model)}`);
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

export const MEMBER_BASELINE_RULES: ReadonlyArray<{ head: string; body: string }> = [
  {
    head: 'Already-fixed check FIRST',
    body: 'Before building anything, spend ~2 min confirming the fix has not already shipped — check code/tests, `git log`, sibling work-items. Re-implementing a peer\'s fix is the single biggest fleet-time waste. If already done, close it as already-fixed WITH the evidence you checked — do not rebuild it.',
  },
  {
    head: 'STAY ALIVE across turns — loop:arm at spawn, not park',
    body: 'You have no human at your keyboard: as your FIRST action, call `loop:arm { intervalSec, goal }` to drain your lane. Each wake: pull via `scheduler:get_next` → work to terminal (`work_items:complete`) → repeat — the armed loop re-wakes you automatically. `loop:end` ONLY when nothing is claimable for your spec, or you are genuinely blocked. Ending a turn with no armed loop IS parking (EI-8318): you go silent until the leader manually re-wakes you, capping the WHOLE fleet at their re-wake cadence instead of draining continuously.',
  },
  {
    head: 'Flag to your LEADER; keep status in your FLEET, not the whole hive',
    body: 'Send blockers, systemic findings, and "nothing left to claim" to the leader (`wakeOnReply:true`) — broadcast is easy to miss. A finding >1 paragraph goes on the item, not chat; `coord:read { msg_id }` gets its full text. In-fleet: bare to:["*"] auto-scopes `@fleet:<slug>`; `allHive:true` only for system-wide news.',
  },
  {
    head: 'Do not re-claim a ping-ponging item',
    body: 'Releasing an item bumps its `updated_at`, so it can re-surface at the top of your next `scheduler:get_next` pull and you loop on it. If an item reappears right after you release it, sink it (`work_items:set_priority`) or set it `blocked` with a reason — do not re-claim.',
  },
  {
    head: 'Completion evidence is mandatory',
    body: 'Every terminal transition carries a completion_ref stating (a) files / root-cause, (b) the exact test or verification you ran AND its result, (c) any tests you added. Auditors mark you CLEAN on stated evidence — thin evidence on solid work still gets dinged.',
  },
  {
    head: '"Not available" means DEFERRED, not missing',
    body: 'An InputValidationError / "not available" on a tool means load it (ToolSearch / `tools:find`) and continue — never stop or report a tool as unavailable.',
  },
  {
    head: 'Edit only the staging tree; git-sync owns commit + push',
    body: 'Never git add / commit / push. If a file-lock blocks an edit, pivot to the next item rather than routing around it.',
  },
  {
    head: 'A hive pause is a Mug-loop signal, not a self-drain order',
    body: '`pauseNewWork` / `maxBees` / a pot-steering fact you SEE in orient governs the autonomous mug-cup loop — do NOT stop your claimed work on it. Wind down only on a graceful-drain cue ADDRESSED to you (check its authority+scope stamp: `hive-queen(<hive>)→hive-wide` is the Mug; a `fleet-leader(<other>)→fleet-members` cue is a DIFFERENT fleet\'s business — ignore it) or an explicit `fleet:*`/owner action. Unsure? Ask your leader, never self-drain on an observed pause.',
  },
  {
    head: 'Turn-end reflection + reporting integrity',
    body: 'End each turn with ONE bounded reflection: file an observation (`improvements:capture lane:"observation"`) ONLY if the turn surfaced something a FUTURE agent benefits from — a routine turn records NOTHING (a sensor reading, never a fix or self-grade). Never fabricate a signal: a truthful `blocked` beats a fabricated all-clear — never report a state you weren\'t in, a send you didn\'t make, or a reading you didn\'t take.',
  },
  {
    head: 'Carry-note checkpoint at every boundary',
    body: 'Write `work_items:checkpoint { id, checkpoint }` at task completion, before going idle at a task boundary, and on graceful-evict — so your successor resumes mid-thread instead of cold. Content = what you accomplished / what is left / the key insight / a gotcha for your successor; concrete facts, not self-evaluation; a compact digest, never a transcript. Replace-on-write (blank to clear).',
  },
];

export function renderMemberBaseline(opts: {
  fleetSlug: string;
  plan: string;
  count: number;
  carry?: 'warm' | 'cold';
}): string {
  const { fleetSlug, plan, count, carry = 'warm' } = opts;
  const cold = carry === 'cold';
  const rules = MEMBER_BASELINE_RULES.map((r, i) => {
    let body = r.body;
    if (cold && r.head.startsWith('STAY ALIVE')) {
      body = body.replace(
        '`loop:arm { intervalSec, goal }`',
        "`loop:arm { intervalSec, goal, carry: 'cold' }` — you are a COLD member: each wake starts a FRESH context, so nothing but your checkpoint carries across wakes",
      );
    }
    if (cold && r.head.startsWith('Carry-note checkpoint')) {
      body = `${body} COLD CARRY makes this LOAD-BEARING, not optional: your next wake reconstructs itself ONLY from this checkpoint — skip it and your successor-self wakes blind with no memory of what you did.`;
    }
    return `${i + 1}. **${r.head}.** ${body}`;
  }).join('\n');
  return [
    '# Fleet member — operating baseline',
    '',
    `You are one of ${count} parallel worker agent${count === 1 ? '' : 's'} in fleet \`${fleetSlug}\`, working plan \`${plan}\`. The session that launched you is your LEADER — report notable completions and blockers to them.`,
    '',
    'Your loop, until nothing is claimable: **pull** via `scheduler:get_next` (NOT `work_items:claim_next` — leader steers WHICH item via `scheduler:set_claim_spec`; no spec = default order) → **read** it (`work_items:get`) → **classify + act** (fix / already-fixed-close / blocked) → drive to a **terminal** state with evidence → repeat. Do NOT self-prioritize by scanning `work_items:list` — scheduling is the leader\'s call, PICKUP is yours.',
    '',
    '## Non-negotiables',
    rules,
  ].join('\n');
}

export function composeMemberLaunchContext(opts: {
  fleetSlug: string;
  plan: string;
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
