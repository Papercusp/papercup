/**
 * POST / OPTIONS /api/agent-mcp/console/bootstrap-su
 *
 * Bootstraps a tracked superuser engineer session for one of the three
 * `*-su` wrappers (claude-su / omp-su / codex-su). Called by the
 * plan-tracked launcher after the user picks a harness + plan; the
 * launcher cd's to `cwd`, exports `envelopeEnv`, and exec's `wrapperBin`.
 *
 * Per `psu-wrappers-and-plan-tracked-launch-2026-05-30` (P-006), pivoted
 * onto the shipped `*-su` wrappers + reconciled against the data model:
 *   - the session is an `adv_sessions` row (NOT a plan_run/spawn — those
 *     are the autonomous-execution surface). plan_slug set → plan-bound;
 *     null → a "No plan" row (D-005). Both appear in /adv Sessions.
 *   - the `*-su` wrappers already inject the playbook + skip-permissions
 *     + MCP auth (codex-su via a dedicated CODEX_HOME), so this returns
 *     only WHICH wrapper to exec + the tracking env — no cliFlags, no
 *     token handling.
 *
 * Principal-gated; CORS-open (operator binds loopback-only). `auth:
 * 'public'` — requirePrincipal() inline, mirroring console-launch.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId, readRegistry, workspaceById } from '../../../workspace-registry';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { markAdvSessionEnded, reactivateAdvSession, recordAdvSession } from '../../../adv-sessions';
import { isSuAgent, type SuAgent } from '../../../su-agents';
import { launchContextDir, launchContextPathFor } from '../../../su-launch-context';
import { buildLaunchSpec } from '../../../role-launch-spec';
import { deriveLaunchPromptText } from '../../../agent-tools/plans/launch-prompt';
import { writeSuCodexHome } from '../../../role-codex-home';
import { writeInteractiveClaudeConfig } from '../../../interactive-claude-config';
import { resolveSuLaunchCwd } from '../../../su-launch-cwd';
import {
  materializeCodexPrompts,
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '../../../saved-prompts-materialize';
import { emitCodexSlashToolPrompts } from '../../../slash-tool-prompts-codex';
import { resolveInstallPaths } from '../../../desktop-install/papercusp-files';
import { readSuperuserToken } from '../../../superuser-token';
import { homedir } from 'node:os';
import { accountProviderForInteractiveBackend, backendFeatureGuard, type BackendAccountProvider } from '../../../backend-feature-capabilities';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization',
};

function jsonRes(body: unknown, init?: number | ResponseInit): Response {
  const r = Response.json(body, typeof init === 'number' ? { status: init } : init);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

async function gatePrincipal(headers: Headers): Promise<Response | null> {
  try {
    await requirePrincipal(headers);
    return null;
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return jsonRes({ status: 'error', error: err.reason }, err.status);
    }
    throw err;
  }
}

export interface BootstrapSuResult {
  status: 'ok';
  /** adv_sessions row id; null if the insert failed (best-effort). */
  sessionId: number | null;
  /** The agent's NATIVE session id the launcher must force on the CLI so the
   *  session is resumable + recognizable by id. claude → a forced UUID
   *  (`claude --session-id`); omp/codex → null (they don't take a forced id). */
  nativeSessionId: string | null;
  agent: SuAgent;
  /** Workspace the harness + session belong to. */
  workspaceId: string;
  /** Working directory the launcher should exec the agent in. */
  cwd: string;
  harnessSlug: string | null;
  planSlug: string | null;
  /**
   * File holding the engineer playbook + per-launch scope/plan addendum —
   * the launcher feeds it as the system prompt. claude/omp: a launch-context
   * `.md` (--append-system-prompt[-file]). codex: the CODEX_HOME AGENTS.md.
   */
  promptFile: string;
  /**
   * Per-session CODEX_HOME for a codex su session (AGENTS.md = playbook,
   * config.toml = superuser MCP, settings.json = lock hooks, auth symlink).
   * null for claude/omp (their MCP + hooks are user-level). Also surfaced in
   * `envelopeEnv.CODEX_HOME`.
   */
  codexHome: string | null;
  /**
   * The omp coordination extension path (`~/.papercusp/papercusp-coord.ts`)
   * the launcher loads via `-e` for lock enforcement, or null if not
   * installed. Ignored for claude (hooks are user-level) + codex (home).
   */
  coordExtPath: string | null;
  /**
   * Env the launcher exports into the CHILD process (the raw CLI). Carries
   * the MCP/context vars + PAPERCUSP_AGENT + PAPERCUSP_SID (per-session
   * coord/lock owner) + PAPERCUSP_ADV_SESSION_ID + CODEX_HOME (codex) +
   * CLAUDE_CONFIG_DIR (claude — the per-session transcript-isolated config dir,
   * EI-155). No secrets — the superuser bearer is read from the 0600 token file
   * by the launcher, never sent over HTTP.
   */
  envelopeEnv: Record<string, string>;
  /**
   * psu-account-chooser P-002: a human-readable note about the `--account` request
   * — confirmed pin ("pinned to account X …") or the fail-soft reason it was skipped
   * ("--account X ignored: …"). null when no account was requested. The launcher
   * prints it so the user always knows whether the pin took effect.
   */
  accountNotice?: string | null;
  /**
   * named-su-agent-fleets P-006: a human-readable note about the chosen fleet —
   * "leading fleet X (Name)." for a freshly-created fleet, "joined fleet X as
   * member." for an existing one, or the fail-soft reason it was skipped. null when
   * no fleet was chosen. The launcher prints it so the membership is never silent.
   */
  fleetNotice?: string | null;
  /**
   * WI-1408 (fleet-join-startup-assertion): the resolved fleet slug/role, or null when
   * no fleet was requested. When a fleet WAS requested (`--fleet`/`--fleet-name`), this
   * route never returns `status: 'ok'` with a null `fleetSlug` — resolution failure is a
   * hard error (see the `fleetRequested` guard above) — so a caller (e.g. the launcher,
   * or a test) can assert `!body.fleet || result.fleetSlug != null` and it will hold.
   */
  fleetSlug?: string | null;
  fleetRole?: string | null;
  /**
   * improve-fleet-launch-autokickoff (EI-5503): the FIRST USER TURN a plan-bound
   * launch should submit so the agent immediately starts working the plan instead
   * of orienting once and parking idle. Present only when a plan is bound (else
   * null). The canonical kickoff text (deriveLaunchPromptText — the same string
   * headless plans:launch seeds), so it never drifts. The launcher GATES delivery
   * to scripted launches (--no-picker + --plan, unless --no-kickoff) so an
   * interactive human picker launch still opens at an empty prompt.
   */
  kickoffPrompt?: string | null;
}

const options = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const optionsForOptions = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/options',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * psu-account-chooser P-002: the env patch that pins an interactive psu session to a
 * chosen pool `account`. Mirrors the fleet's gateway routing (operator-spawn →
 * gatewaySpawnEnv) but with an EXPLICIT, validated account instead of the drain
 * selector. Fail-soft (D-002): gateway off / unknown / disallowed account → no env
 * patch + a human `notice` the launcher prints, never an error. Honors the
 * session-override allow/exclude (D-003). Exported so the gating unit-tests without
 * the POST handler.
 */
export async function resolveAccountPin(
  workspaceId: string,
  requested: string | null | undefined,
  agent: SuAgent = 'claude',
  ownerId?: string,
  // HARD PIN (account-hard-pin-2026-06-29): when true, the gateway routes this session to its pinned
  // account with NO failover ever (the operator explicitly chose it). The interactive PSU launcher passes
  // true (a person picking an account means "use THIS one"); autonomous role spawns leave it false so the
  // fleet's soft cache-affinity pin (which yields to liveness/load) is unchanged.
  hardPin: boolean = false,
): Promise<{ env: Record<string, string>; notice: string | null; accountId: string | null; provider: BackendAccountProvider | null }> {
  const raw = requested?.trim();
  const lower = (raw ?? '').toLowerCase();
  // account-routing-3-options (owner, 2026-06-30): three explicit routing modes carried on the ONE
  // `account` value — so a spawn (psu / fleet) picks exactly how its model calls are routed:
  //  • '' / 'default' / 'none' / 'system' → skip the inference gateway entirely (system credential — the DEFAULT).
  //  • 'auto' / 'gateway'                 → route THROUGH the gateway, which auto-selects an available pool
  //                                         account and fails over (no account-pin header).
  //  • <pool id>                          → pin to that specific account (HARD when hardPin — the PSU pin).
  if (!raw || lower === 'default' || lower === 'none' || lower === 'system') {
    return {
      env: {},
      notice: raw ? 'using the default system account (inference gateway skipped).' : null,
      accountId: null,
      provider: null,
    };
  }
  const wantAuto = lower === 'auto' || lower === 'gateway';
  const id = raw;
  const label = wantAuto ? 'auto' : id;
  const fail = (why: string) => ({
    env: {} as Record<string, string>,
    notice: `--account ${label} ignored: ${why} — using the default credential.`,
    accountId: null,
    provider: null as BackendAccountProvider | null,
  });
  const accountGuard = backendFeatureGuard(agent, wantAuto ? 'gateway-routing' : 'account-pinning');
  if (!accountGuard.supported)
    return fail(`${wantAuto ? 'gateway routing' : 'account pinning'} is unsupported for ${agent}: ${accountGuard.reason}`);
  const gatewayGuard = backendFeatureGuard(agent, 'gateway-routing');
  if (!gatewayGuard.supported) return fail(`gateway routing is unsupported for ${agent}: ${gatewayGuard.reason}`);
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.INFERENCE_GATEWAY, 'system'))) {
      return fail('the inference gateway is off (INFERENCE_GATEWAY)');
    }
    // Priority label for the admission tier (gateway-priority-tiers): a PSU session is role `su` (tier 2).
    // Without this, pinned/auto psu sessions fell to the default band — tier 5, cap 1 — and their first
    // turns serialized behind each other (the 2026-07-01 "15-minute first turn" starvation). Gated on the
    // same flag as the bee spawn path so flag-OFF emits no new header.
    const priority = (await getFlag(FLAGS.GATEWAY_PRIORITY_TIERS, 'system')) ? 'su' : undefined;
    // AUTO: route through the gateway with NO account pin — it selects an available account + fails over.
    if (wantAuto) {
      const expected = accountProviderForInteractiveBackend(agent);
      if (!expected) return fail(`account routing is unsupported for ${agent}`);
      if (expected === 'claude' && agent !== 'omp') {
        const { gatewaySpawnEnv } = await import('../../../inference-gateway/spawn-env');
        // ownerId → x-papercusp-owner (attribution + stall-wake); NO accountId → gateway active()/drain + failover.
        return {
          env: { ...gatewaySpawnEnv(true, { ownerId, priority }) },
          notice: 'routing through the inference gateway (auto — it selects an available pool account and fails over).',
          accountId: null,
          provider: expected,
        };
      }
      // Codex/OMP auto-routing needs a per-session config pointing at a specific account (there is none here),
      // so it is not wired interactively yet — fail-soft to the default credential, never block the launch.
      return fail(`auto gateway routing isn't wired for ${agent} yet`);
    }
    const { loadAccountPool } = await import('../../../deployment/account-pool-store');
    const { accountProvider } = await import('../../../deployment/account-pool');
    const pool = await loadAccountPool(workspaceId);
    const acct = (pool.accounts ?? []).find((a: { id: string }) => a.id === id);
    if (!acct) return fail(`'${id}' is not in the account pool (see accounts:list)`);
    const provider = accountProvider(acct as never);
    const expected = accountProviderForInteractiveBackend(agent);
    if (!expected) return fail(`account routing is unsupported for ${agent}`);
    if (provider !== expected) return fail(`'${id}' is a ${provider} account, but ${agent} sessions require ${expected} accounts`);
    const { getAccountOverride } = await import('../../../deployment/account-session-override');
    const ov = await getAccountOverride(workspaceId);
    if (ov.excludeAccounts.includes(id)) return fail('it is in the session-override exclude list');
    if (ov.forcedAccounts.length > 0 && !ov.forcedAccounts.includes(id)) {
      return fail('it is outside the session-override allow-list (forcedAccounts)');
    }
    if (provider === 'claude' && agent !== 'omp') {
      const { gatewaySpawnEnv } = await import('../../../inference-gateway/spawn-env');
      return {
        // Pass ownerId so the session ALSO sends x-papercusp-owner (not just the account pin) — this lets the
        // gateway attribute the session's routed account (GET /admin/route → the statusline ⇢ <account> chip).
        env: { ...gatewaySpawnEnv(true, { accountId: id, ownerId, priority, hardPin }), PAPERCUSP_ACCOUNT_ID: id },
        notice: `pinned to account ${id} (routed through the inference gateway${hardPin ? ', HARD pin — no failover' : ''}).`,
        accountId: id,
        provider,
      };
    }
    // Codex + OMP route via a per-session config FILE (codex CODEX_HOME config.toml /
    // OMP <home>/.omp/agent/models.yml) keyed off PAPERCUSP_ACCOUNT_ID — neither reads
    // the claude CLI's ANTHROPIC_BASE_URL/ANTHROPIC_CUSTOM_HEADERS. OMP pins to a Claude
    // account (provider==='claude') but is delivered the codex-shaped signal, not the
    // claude-CLI env. (omp-account-pinning-gateway-2026-06-29 D-001/D-003)
    return {
      env: { PAPERCUSP_ACCOUNT_ID: id },
      notice:
        agent === 'omp'
          ? `pinned to account ${id} (OMP routed through the inference gateway).`
          : `pinned to Codex account ${id} (routed through the inference gateway).`,
      accountId: id,
      provider,
    };
  } catch (e: any) {
    return fail(`account resolution failed (${e?.message ?? e})`);
  }
}

/**
 * psu-account-chooser P-005: the account choices the interactive psu picker offers.
 * Returns the pool account ids + the active session-override — but ONLY when the
 * inference gateway is on (pinning is a no-op otherwise, so the picker stays hidden
 * and the launch is byte-identical to today). `pool` empty ⇒ the launcher skips the
 * account step entirely. Fail-soft: any error ⇒ no choices (hidden picker). Exported
 * for tests.
 */
export async function resolveAccountChoices(
  workspaceId: string,
  agent: SuAgent = 'claude',
): Promise<{ gatewayOn: boolean; pool: string[]; forcedAccounts: string[]; excludeAccounts: string[]; provider: BackendAccountProvider | null; unsupportedReason?: string }> {
  const provider = accountProviderForInteractiveBackend(agent);
  const empty = { gatewayOn: false, pool: [] as string[], forcedAccounts: [] as string[], excludeAccounts: [] as string[], provider };
  const accountGuard = backendFeatureGuard(agent, 'account-pinning');
  if (!accountGuard.supported) return { ...empty, unsupportedReason: accountGuard.reason ?? 'account pinning unsupported' };
  const gatewayGuard = backendFeatureGuard(agent, 'gateway-routing');
  if (!gatewayGuard.supported) return { ...empty, unsupportedReason: gatewayGuard.reason ?? 'gateway routing unsupported' };
  if (!provider) return { ...empty, unsupportedReason: `account routing is unsupported for ${agent}` };
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.INFERENCE_GATEWAY, 'system'))) return empty;
    const { loadAccountPool } = await import('../../../deployment/account-pool-store');
    const { accountsForProvider } = await import('../../../deployment/account-pool');
    const pool = accountsForProvider(await loadAccountPool(workspaceId), provider).map((a: { id: string }) => a.id);
    const { getAccountOverride } = await import('../../../deployment/account-session-override');
    const ov = await getAccountOverride(workspaceId);
    return { gatewayOn: true, pool, forcedAccounts: ov.forcedAccounts, excludeAccounts: ov.excludeAccounts, provider };
  } catch {
    return empty;
  }
}

/**
 * named-su-agent-fleets P-006: resolve the chosen fleet into the env the spawned
 * agent reads — PAPERCUSP_FLEET_SLUG + PAPERCUSP_FLEET_ROLE (the presence-write
 * path keys off EXACTLY those names). Two shapes, mirroring resolveAccountPin:
 *   - `fleetName` (a freshly-entered name) → CREATE the durable agent_fleets row
 *     (D-001, idempotent) with this agent as owner + leader (D-002); role=leader.
 *   - `fleet` (an existing slug) → JOIN it; role=member (or the requested role).
 * No fleet ⇒ empty env (byte-identical to today). Fail-soft (mirrors the account
 * pin): any error ⇒ no env + a human `notice` the launcher prints, never a throw.
 * Exported so the resolution unit-tests without the POST handler.
 */
export async function resolveFleet(
  workspaceId: string,
  opts: { fleet?: string | null; fleetRole?: string | null; fleetName?: string | null; fleetScheme?: string | null; ownerId?: string } = {},
): Promise<{ env: Record<string, string>; notice: string | null; fleetSlug: string | null; fleetRole: string | null }> {
  const name = opts.fleetName?.trim();
  const requested = opts.fleet?.trim();
  if (!name && !requested) return { env: {}, notice: null, fleetSlug: null, fleetRole: null };
  try {
    const { fleetSlugFromName, createFleetIfAbsent, resolveFleetScheme, getFleetScheme } =
      await import('../../../agent-fleets-store');
    // The fleet's bound scheme as env the psu launch path reads to recolor the
    // window at startup — so EVERY fleet window (not just capability:terminal)
    // shows the fleet color (fleet-color-schemes: psu/bee terminals). The values
    // are `#rrggbb`, shell-safe; the psu-pty host builds the OSC from them.
    const schemeEnv = (s: { bg: string; fg: string; cursor: string }): Record<string, string> => ({
      PAPERCUSP_FLEET_BG: s.bg,
      PAPERCUSP_FLEET_FG: s.fg,
      PAPERCUSP_FLEET_CURSOR: s.cursor,
    });
    if (name) {
      // A new fleet → create it (idempotent) with this agent as owner + leader.
      const fleetSlug = fleetSlugFromName(name);
      // A scheme chosen in the psu picker forces that catalog colour; an unknown or
      // absent name (a legacy launcher / no pick) leaves it null → the store
      // auto-allocates the next unused scheme (createFleetIfAbsent: colorScheme ?? allocate).
      const { schemeByName } = await import('../../../console-color-schemes');
      const chosenScheme = schemeByName(opts.fleetScheme ?? undefined)?.name ?? null;
      const { record } = await createFleetIfAbsent({
        workspaceId,
        fleetSlug,
        title: name,
        owner: opts.ownerId ?? null,
        leaderOwnerId: opts.ownerId ?? null,
        colorScheme: chosenScheme,
      });
      return {
        env: {
          PAPERCUSP_FLEET_SLUG: fleetSlug,
          PAPERCUSP_FLEET_ROLE: 'leader',
          ...schemeEnv(resolveFleetScheme(record)),
        },
        notice: `leading fleet ${fleetSlug} (${name}).`,
        fleetSlug,
        fleetRole: 'leader',
      };
    }
    // An existing fleet → join it. Default member; honor an explicit leader request.
    // WI-1408 (fleet-join-startup-assertion): validate the slug is a REAL fleet before
    // handing back membership env. Without this, a typo'd/stale `--fleet=<slug>` "succeeded"
    // silently — the agent registered PAPERCUSP_FLEET_SLUG for a fleet row that never
    // existed (a phantom membership, invisible to fleet:assignments' roster of real
    // agent_fleets rows even though the env var itself was non-null).
    const fleetSlug = requested as string;
    const { getFleet } = await import('../../../agent-fleets-store');
    const record = await getFleet(workspaceId, fleetSlug);
    if (!record) {
      return {
        env: {},
        notice: `fleet \`${fleetSlug}\` does not exist in this workspace — join skipped (check the slug, or create it first).`,
        fleetSlug: null,
        fleetRole: null,
      };
    }
    const role = opts.fleetRole?.trim() === 'leader' ? 'leader' : 'member';
    const scheme = await getFleetScheme(workspaceId, fleetSlug);
    return {
      env: {
        PAPERCUSP_FLEET_SLUG: fleetSlug,
        PAPERCUSP_FLEET_ROLE: role,
        ...(scheme ? schemeEnv(scheme) : {}),
      },
      notice: `joined fleet ${fleetSlug} as ${role}.`,
      fleetSlug,
      fleetRole: role,
    };
  } catch (e: any) {
    return { env: {}, notice: `fleet selection skipped (${e?.message ?? e}).`, fleetSlug: null, fleetRole: null };
  }
}

/**
 * WI-1893 (cluster-safe fleet stamp): append the launched agent's fleet-membership
 * FACT at boot — durable (harness_shared.fleet_membership_events, WI-1345),
 * worker-agnostic. The prior mechanism (`setPendingFleet`, WI-1343) registered an
 * IN-MEMORY pending placement in whichever cluster worker served bootstrap; the
 * member's first presence write usually lands on a DIFFERENT worker (:3070 is
 * node:cluster + SO_REUSEPORT), so the placement was silently lost and the member
 * registered presence with fleet_slug=null — the 2026-07-03 backlog-clearance batch
 * lost ALL 10 members this way despite `--fleet=<slug>` on every argv. The durable
 * fact + the mig-430 triggers cover both orders: fact-first (materialize_presence_
 * fleet_trg fires on the presence-row INSERT) and row-first (project_fleet_
 * membership_trg fires on the fact INSERT). Populate-once (IfAbsent) so a re-POSTed
 * bootstrap (psu --resume) never clobbers a leadership promotion recorded since.
 *
 * Returns null on success, or the error message — the caller decides loud vs soft
 * (both bootstrap routes fail LOUD when a fleet was explicitly requested, per the
 * WI-1408 no-ghost-member rule).
 */
export async function stampFleetMembershipAtBoot(opts: {
  workspaceId: string;
  ownerId: string;
  ownerLabel?: string | null;
  fleetSlug: string;
  fleetRole?: string | null;
}): Promise<string | null> {
  try {
    const { appendFleetMembershipIfAbsent } = await import('../../../fleet-membership-store');
    await appendFleetMembershipIfAbsent({
      workspaceId: opts.workspaceId,
      ownerId: opts.ownerId,
      ownerLabel: opts.ownerLabel ?? null,
      fleetSlug: opts.fleetSlug,
      fleetRole: opts.fleetRole ?? 'member',
    });
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/**
 * fleet-auto-mode (WI-1356): the durable AUTO-mode activation a fleet/auto launch
 * bakes into the session — a fleet member has no human at its keyboard, so it must
 * start in the persona's "act, don't ask, loop until done" standing state. Injected
 * into the assembled system prompt (survives compaction) AND prepended to the seeded
 * turn-1 kickoff (so turn 1 enters AUTO). Shared so the two copies never drift.
 */
export const AUTO_MODE_DIRECTIVE =
  'AUTO mode is ON for this session — act on your judgment, do not stop to ask, ' +
  'loop continuously until the work is done. You are a fleet member with no human at your ' +
  'keyboard, so to persist across turns instead of PARKING after turn 1 you MUST ARM A ' +
  'SELF-SUSTAINING LOOP: call loop:arm { intervalSec, goal } toward your assigned work; each ' +
  'wake self-assign + advance a work_item; loop:end ONLY when the goal is done or you are ' +
  'blocked. (The persona\'s AUTO-mode section governs; the narrow irreversible-high-stakes ' +
  'brakes still apply.)';

/**
 * WI-1962: the turn-1 kickoff for a MISSION-BRIEF launch (`--launch-context` with
 * no plan bound). Without it a scripted solo launch boots to an interactive prompt
 * and PARKS FOREVER — claude sat 10+ minutes with a full mission in its system
 * prompt and ZERO turns taken (su-8ab32510, 2026-07-03) until a manual coord wake.
 * The launcher gates delivery exactly like the plan kickoff (--no-picker, not
 * --no-kickoff), so an interactive human launch still opens at an empty prompt.
 */
export const LAUNCH_CONTEXT_KICKOFF =
  'Begin your mission NOW, exactly as your launch brief (the launch-context section of your ' +
  'system prompt) directs. Orient first (coord:orient with a one-line intent), then start the ' +
  'work — do not park waiting for a human turn; this kickoff IS your first turn.';

/**
 * The turn-1 kickoff a launch seeds (EI-5503 + WI-1962 + WI-1356) — pure, exported
 * for tests. A plan-bound launch gets the canonical plan kickoff; a mission-brief
 * (--launch-context, no plan) launch gets the brief kickoff; an AUTO launch prepends
 * the AUTO activation (and kicks off even bare). null ⇒ the launcher seeds nothing
 * (an interactive human launch opens at an empty prompt).
 */
export function deriveKickoffPrompt(opts: {
  planSlug: string | null;
  autoMode: boolean;
  launchContextPath: string | null;
}): string | null {
  const base = opts.planSlug
    ? deriveLaunchPromptText(null, opts.autoMode)
    : opts.launchContextPath
      ? LAUNCH_CONTEXT_KICKOFF
      : null;
  return opts.autoMode
    ? [AUTO_MODE_DIRECTIVE, CONTEXT_DISCIPLINE_DIRECTIVE, base].filter(Boolean).join('\n\n')
    : base;
}

/**
 * context-trimming-tiers P-007: the context-discipline line a fleet launch bakes
 * next to the AUTO directive — durable system prompt (survives compaction) +
 * turn-1 kickoff, same dual delivery. Six 200k-window members died mid-task on
 * 2026-07-01 ("Prompt is too long") because nothing told them to act on the
 * `context: N/LIMIT (X%)` signal the coord inbox injects (agent-managed-compaction
 * P-007) once the compliance watchdog seeds their limit.
 */
export const CONTEXT_DISCIPLINE_DIRECTIVE =
  'CONTEXT DISCIPLINE: your coord inbox injects a `context: N/LIMIT (X%)` usage line once ' +
  'your session carries a compaction limit. HONOR it — past ~80%, finish the current unit of ' +
  'work, write durable state (plan `## Now` / work_items:checkpoint), then call ' +
  'session:request-compaction at that clean stopping point. Do NOT run to the hard window: ' +
  '"Prompt is too long" kills the session mid-task and loses your in-flight work. On a ' +
  'trimmed session, tool payloads are already tier-shaped; pass payloadTier:"full" on a call ' +
  'only when you genuinely need the unshaped result.';

/**
 * launch-path-argv-reconstruction (WI-1343): normalize a caller-supplied
 * `launch_argv` (the literal `psu …` invocation the launcher built) into the
 * string[] recorded on `adv_sessions.launch_argv`. Defensive: only strings,
 * each length-capped, the array element-capped — an untrusted body must never
 * bloat the row or poison the JSONB. Returns null when nothing usable was sent
 * (the caller then falls back to a server-side reconstruction). Exported for tests.
 */
export function normalizeLaunchArgv(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 2000));
  return out.length ? out.slice(0, 128) : null;
}

/**
 * launch-path-argv-reconstruction (WI-1343): the server-side FALLBACK argv for a
 * bootstrap-su launch whose caller did not send an explicit `launch_argv` (a
 * direct/web POST, or a launcher that predates the field). Reconstructs the
 * canonical `psu …` invocation from the RESOLVED launch fields so a killed batch
 * is still reconstructible. The psu launcher itself sends the literal argv (which
 * wins); this is the belt-and-suspenders path. Pure — exported for tests.
 */
export function reconstructPsuLaunchArgv(o: {
  agent: string;
  harnessSlug?: string | null;
  planSlug?: string | null;
  profile?: string | null;
  contextSize?: string | null;
  account?: string | null;
  fleet?: string | null;
  /** WI-1347: a role-scoped launch (`psu --role=<role>`, bootstrap-role's path)
   *  reduces to `--role=` instead of `--profile=` — mutually exclusive with
   *  `profile` at the call site. Omitted ⇒ byte-identical to the pre-WI-1347
   *  plain-SU/engineer reconstruction below. */
  role?: string | null;
}): string[] {
  const argv = ['psu', '--no-picker', `--agent=${o.agent}`];
  if (o.role) argv.push(`--role=${o.role}`);
  if (o.harnessSlug) argv.push(`--harness=${o.harnessSlug}`);
  argv.push(o.planSlug ? `--plan=${o.planSlug}` : '--no-plan');
  if (!o.role && o.profile && o.profile !== 'engineer') argv.push(`--profile=${o.profile}`);
  if (o.contextSize) argv.push(`--context-size=${o.contextSize}`);
  if (o.account) argv.push(`--account=${o.account}`);
  if (o.fleet) argv.push(`--fleet=${o.fleet}`);
  return argv;
}

const brainGet = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/bootstrap-su/brain',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    return jsonRes({ status: 'error', error: 'psu --brain is deprecated; use operator/sentinel converse or a normal psu session.' }, 410);
  },
});

/**
 * GET /api/agent-mcp/console/bootstrap-su/options
 *
 * Picker data for the `psu` launcher (and the /adv "Launch SU" modal).
 * Harnesses are workspace-scoped, so the picker walks workspace → harness
 * → plan:
 *   - no query                   → { activeWorkspace, workspace, workspaces:
 *                                    [{ id, name }], harnesses: [{ slug, path, status }] }
 *   - ?workspace=<id>            → harnesses for that workspace
 *   - ?workspace=<id>&harness=<slug> → { plans: [{ slug }] } (non-archived)
 * `workspace` defaults to the active workspace when omitted.
 */
const optionsGet = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/bootstrap-su/options',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    const url = new URL(req.url);
    const workspace = url.searchParams.get('workspace')?.trim() || activeWorkspaceId();
    const harness = url.searchParams.get('harness')?.trim() || null;
    const wantFeatures = url.searchParams.get('features') === '1';
    const accountAgentRaw = url.searchParams.get('agent')?.trim();
    const accountAgent = isSuAgent(accountAgentRaw) ? accountAgentRaw : 'claude';

    // ?harness=X&features=1 → feature list (for the psu --role feature picker).
    if (harness && wantFeatures) {
      try {
        const { listFeaturesForHarness } = await import('../../../harness-readers');
        const r = await listFeaturesForHarness(harness, 'staging');
        const features = r.ok
          ? (r.data.features as Array<{ id?: string; feature_id?: string; title?: string; description?: string; status?: string }>).map((f) => ({
              id: f.id ?? f.feature_id ?? '',
              title: f.title ?? f.description ?? '',
              status: f.status ?? null,
            })).filter((f) => f.id)
          : [];
        return jsonRes({ status: 'ok', workspace, harness, features });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: e?.message ?? 'features listing failed' }, 400);
      }
    }

    if (harness) {
      try {
        const { resolveHarnessPlansDir, listPlanFiles } = await import('../../../agent-tools/plans/source');
        const resolved = await resolveHarnessPlansDir(harness, { workspaceId: workspace });
        const entries = await listPlanFiles({ harnessSlug: resolved.harnessSlug, workspaceId: resolved.workspaceId });
        return jsonRes({
          status: 'ok',
          workspace,
          harness,
          plans: entries.filter((e) => !e.archived).map((e) => ({ slug: e.slug })),
        });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: e?.message ?? 'plans listing failed' }, 400);
      }
    }

    const { listHarnessesFor } = await import('../../../device-harnesses');
    const harnesses = (await listHarnessesFor(workspace)).map((h) => ({
      slug: h.slug,
      path: h.path,
      status: h.status,
    }));
    const workspaces = readRegistry().workspaces.map((w) => ({ id: w.id, name: w.name }));
    // Roles + their consumes (feature/plan needs) for the psu --role picker.
    const { getKnownRoles } = await import('../../../known-roles');
    const { roleConsumes } = await import('../../../role-registry');
    const roles = getKnownRoles().map((id) => ({ id, consumes: roleConsumes(id, harness ?? '') }));
    // psu-account-chooser P-005: pool accounts the interactive picker offers (empty +
    // hidden unless the gateway is on — see resolveAccountChoices).
    const accounts = await resolveAccountChoices(workspace, accountAgent);
    // named-su-agent-fleets P-006: the durable named fleets this workspace offers
    // for the psu fleet picker. Persist even with zero live members (D-003), so
    // this is the "pick existing fleet" list. Fail-soft: any error ⇒ [] (the picker
    // still shows its "no fleet" / "create new" rows).
    // fleet-color-schemes: carry each fleet's resolved color so the picker can
    // show a swatch, plus `nextScheme` — the color a NEW fleet would be allocated
    // — so the "create a new fleet" row previews its eventual color too.
    type SchemeColor = { name: string; bg: string; fg: string; cursor: string };
    let fleets: Array<{ slug: string; title: string | null; scheme: string | null; color: SchemeColor }> = [];
    let nextScheme: SchemeColor | null = null;
    // The full curated catalog (name + colours) so the psu picker can offer a
    // scheme SELECTOR with per-row swatches when creating a new fleet.
    let schemes: SchemeColor[] = [];
    try {
      const { listFleets, resolveFleetScheme } = await import('../../../agent-fleets-store');
      const { COLOR_SCHEMES, allocateNextSchemeName, schemeByName } = await import('../../../console-color-schemes');
      schemes = COLOR_SCHEMES.map((s) => ({ name: s.name, bg: s.bg, fg: s.fg, cursor: s.cursor }));
      const rows = await listFleets(workspace);
      fleets = rows.map((f) => ({
        slug: f.fleetSlug,
        title: f.title,
        scheme: f.colorScheme,
        color: resolveFleetScheme(f),
      }));
      // Deterministic given the current in-use set — the create path re-derives
      // the same one, so this preview matches what the new fleet actually gets.
      const used = rows.map((f) => f.colorScheme).filter((n): n is string => !!n);
      nextScheme = schemeByName(allocateNextSchemeName(used)) ?? null;
    } catch {
      /* fleet listing is optional — proceed without it */
    }
    return jsonRes({ status: 'ok', activeWorkspace: activeWorkspaceId(), workspace, workspaces, harnesses, roles, accounts, fleets, nextScheme, schemes });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    let body: {
      agent?: string;
      workspace?: string | null;
      harness_slug?: string | null;
      plan_slug?: string | null;
      label?: string | null;
      /** Playbook profile (engineer|power), assembled per-launch (P-023).
       *  Omitted/invalid → 'engineer'. */
      profile?: string | null;
      /** The launcher's own cwd — used for no-harness launches so the
       *  agent's cwd-scoped session resume works from the user's terminal. */
      cwd?: string | null;
      /** Deprecated tombstone input. When true, this route returns 410. */
      brain?: boolean;
      /** psu-account-chooser P-002: pin this interactive session to a specific pool
       *  account. Routed through the gateway (gatewaySpawnEnv) when INFERENCE_GATEWAY
       *  is on + the id is a valid, allowed pool account; fail-soft to the default
       *  credential + an `accountNotice` otherwise. */
      account?: string | null;
      /** named-su-agent-fleets P-006: the durable slug of a named fleet to JOIN
       *  (member). Folded into PAPERCUSP_FLEET_SLUG/PAPERCUSP_FLEET_ROLE on the
       *  spawn env. Ignored when `fleet_name` is present (a new fleet wins). */
      fleet?: string | null;
      /** Membership role for `fleet` — 'leader' | 'member' (default member). */
      fleet_role?: string | null;
      /** named-su-agent-fleets P-006: a freshly-entered fleet NAME. The server
       *  derives its slug (fleetSlugFromName) + creates the agent_fleets row, and
       *  this agent becomes the leader (D-002). */
      fleet_name?: string | null;
      /** fleet-color-schemes: a catalog scheme NAME chosen in the psu picker for a
       *  NEW fleet (with `fleet_name`). Forces that colour; an unknown/absent value
       *  auto-allocates the next unused scheme. Ignored for an existing-fleet join. */
      fleet_scheme?: string | null;
      /** agent-allocation P-005 (launch-from-seats): the delegated agent_slot
       *  template this member consumes ('<model>:<effort>:<account>', `psu
       *  --seat=<ref>`). Recorded in the consumption ledger (mig 487) keyed to
       *  the session's coord owner id — the boot-time seat-cap backstop refuses
       *  the over-cap member (P-006). Requires `fleet`. */
      seat?: string | null;
      /** Optional kickoff/launch-context file generated by the operator UI.
       * Claude/OMP receive this as an extra system prompt from the launcher;
       * Codex has no such flag, so bootstrap folds it into AGENTS.md. */
      launch_context?: string | null;
      /** solo-launch-provenance (WI-1962 sibling): the ownerId of the agent/session
       *  that LAUNCHED this one (`psu --launched-by=<ownerId>`; capability:terminal
       *  auto-injects it into psu commands). Baked into the system prompt, exported
       *  as PAPERCUSP_LAUNCHED_BY, and asserted as an owner-scoped standing fact —
       *  so the launched agent can always answer "who launched/supervises you"
       *  (su-8ab32510 2026-07-03 couldn't: no provenance existed anywhere). */
      launched_by?: string | null;
      /** su-context-size-variants: 'full' | 'trimmed' — the initial-context size. */
      context_size?: string | null;
      /** context-trimming-tiers P-017: persona tier — 'full' (today's playbook) |
       *  'fleet' (spine-only fleet-member tier). Omitted ⇒ auto-select from the
       *  model window in buildLaunchSpec (≤200k known model → fleet). */
      persona_tier?: string | null;
      /** weak-model-tool-tier: the model id the session launches with (e.g.
       *  `ollama/ornith-35b`, `anthropic/claude-opus-4-8`). Drives the tool-tier
       *  gate in buildLaunchSpec — a WEAK/local model is hard-trimmed to the core
       *  spine (codex path; omp trims client-side in psu-launcher; claude self-trims).
       *  Absent ⇒ 'frontier' tier (no trim) — the safe default. */
      model?: string | null;
      /** launch-path-argv-reconstruction (WI-1343): the literal `psu …` argv the
       *  launcher built, recorded on adv_sessions.launch_argv so a killed batch is
       *  reconstructible. Validated + capped server-side (normalizeLaunchArgv);
       *  omitted ⇒ the server reconstructs it from the resolved fields. */
      launch_argv?: unknown;
      /** fleet-auto-mode (WI-1356): start this session in AUTO mode (act/don't-ask/
       *  loop). The launcher sets it for `--fleet` launches (default) or an explicit
       *  `--auto`. When true, bake the durable AUTO directive into the system prompt
       *  and prepend the AUTO activation to the seeded kickoff. */
      auto?: boolean;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return jsonRes({ status: 'error', error: 'invalid JSON body' }, 400);
    }

    if (!isSuAgent(body.agent)) {
      return jsonRes(
        { status: 'error', error: `agent must be one of claude|omp|codex (got ${String(body.agent).slice(0, 24)})` },
        400,
      );
    }
    const agent: SuAgent = body.agent;
    const workspace = body.workspace?.trim() || activeWorkspaceId();
    if (body.workspace?.trim() && !workspaceById(workspace)) {
      return jsonRes({ status: 'error', error: `unknown workspace: ${workspace.slice(0, 48)}` }, 400);
    }
    const harnessSlug = body.harness_slug?.trim() || null;
    const planSlug = body.plan_slug?.trim() || null;
    const callerCwd = body.cwd?.trim() || null;
    // P-023: playbook profile. Valid base playbooks (prompts/papercusp-su-<profile>.tools.md):
    // 'engineer' (working ON papercusp) | 'power' (managing an external repo) |
    // 'generic' (a NON-CODING work hive — domain-generic-hive-architecture P-025: skips
    // papercup's repo CLAUDE.md, pulls domain context from the per-hive su override).
    // Anything else → 400 so a typo doesn't silently fall back. Omitted → engineer.
    const profileRaw = body.profile?.trim() || null;
    if (profileRaw && profileRaw !== 'engineer' && profileRaw !== 'power' && profileRaw !== 'generic') {
      return jsonRes({ status: 'error', error: `profile must be engineer|power|generic (got ${profileRaw.slice(0, 24)})` }, 400);
    }
    const profile = profileRaw ?? 'engineer';

    // su-context-size-variants: 'full' loads the whole superuser catalog up-front;
    // 'trimmed' uses each client's native soft-trim. Omitted ⇒ each client's native
    // default (no lever applied). Validated here so a typo 400s, never silently falls back.
    const contextSizeRaw = body.context_size?.trim() || null;
    if (contextSizeRaw && contextSizeRaw !== 'full' && contextSizeRaw !== 'trimmed') {
      return jsonRes(
        { status: 'error', error: `context_size must be full|trimmed (got ${contextSizeRaw.slice(0, 24)})` },
        400,
      );
    }
    const contextSize = contextSizeRaw as 'full' | 'trimmed' | null;
    // context-trimming-tiers P-017: persona tier (validated; omitted ⇒ model-window auto-select).
    const personaTierRaw = body.persona_tier?.trim() || null;
    if (personaTierRaw && personaTierRaw !== 'full' && personaTierRaw !== 'fleet') {
      return jsonRes(
        { status: 'error', error: `persona_tier must be full|fleet (got ${personaTierRaw.slice(0, 24)})` },
        400,
      );
    }
    const personaTier = personaTierRaw as 'full' | 'fleet' | null;
    // weak-model-tool-tier: the launch model drives the tool-tier gate in buildLaunchSpec.
    const model = body.model?.trim() || null;

    const brain = body.brain === true;
    if (brain) {
      return jsonRes({ status: 'error', error: 'brain launches are deprecated; use operator/sentinel converse or a normal psu session.' }, 410);
    }

    // Resolve cwd + context env from the existing console envelope builder
    // (shell mode), scoped to the chosen workspace. We use its env + cwd;
    // the prompt + MCP come from buildLaunchSpec(su) below.
    let envelope;
    try {
      envelope = await buildConsoleEnvelope({
        workspaceId: workspace,
        slug: harnessSlug,
        operatorBaseUrl: new URL(req.url).origin,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
    }

    // cwd: a harness launch runs in the harness repo (envelope.cwd). A
    // no-harness launch prefers the launcher's own cwd (the user's
    // terminal) over the internal .papercusp dir — agents scope their
    // resumable sessions by cwd, so this makes `--resume` work from where
    // the user is. Recorded + returned + exec'd consistently.
    //
    // EI-202 guard: never run a psu session in $HOME. At $HOME the cwd-level
    // CLAUDE.md / .claude/CLAUDE.md ARE the owner's personal config, which
    // Claude auto-loads as PROJECT memory — re-importing exactly the personal
    // instructions P-002 skip-links out of the per-session CLAUDE_CONFIG_DIR
    // (config-dir isolation governs GLOBAL memory only, not cwd project memory).
    // resolveSuLaunchCwd relocates a $HOME cwd to envelope.cwd (never $HOME).
    const cwd = resolveSuLaunchCwd({ harnessSlug, callerCwd, envelopeCwd: envelope.cwd });

    // Fetch the bound plan's `## Now` + title for the launch-context addendum
    // (best-effort — buildLaunchSpec composes the addendum from these).
    let planNow: { state: string; next: string } | null = null;
    let planTitle: string | null = null;
    if (planSlug && harnessSlug) {
      try {
        const { resolveHarnessPlansDir, readPlanBySlug } = await import('../../../agent-tools/plans/source');
        const resolved = await resolveHarnessPlansDir(harnessSlug, { workspaceId: workspace });
        const found = await readPlanBySlug(planSlug, { harnessSlug: resolved.harnessSlug, workspaceId: resolved.workspaceId });
        if (found) {
          // WI-1442 fix (a): decorate any su-* agent-id mention in the launch-
          // context Now echo with its CURRENT coord:presence session state —
          // this snapshot is baked into the launch prompt once, so a stale
          // "actively worked by su-X" claim must self-disclose right here or
          // it silently misleads the whole session it launches. Best-effort.
          const { decoratePlanNowBlock } = await import('../../../agent-tools/plans/liveness-decoration');
          planNow = await decoratePlanNowBlock(found.parsed.now);
          planTitle = found.parsed.frontmatter?.title ?? null;
        }
      } catch {
        // plan context is optional — proceed without it
      }
    }

    // Build the su launch spec: engineer playbook + per-launch scope/plan
    // addendum (promptText) + the superuser MCP url (codex consumes it). The
    // SAME builder roles use, at the superuser tier (D-001).
    let spec;
    try {
      spec = await buildLaunchSpec({
        kind: 'su',
        agent,
        workspaceId: workspace,
        operatorBaseUrl: new URL(req.url).origin,
        harnessSlug,
        profile,
        contextSize,
        personaTier,
        model,
        planSlug,
        planTitle,
        planNow,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'su launch spec build failed' }, 400);
    }

    // Per-session coord/lock owner (P-022). Replaces the wrapper's SID
    // minting: claude's user-level papercusp-su url env-expands ${PAPERCUSP_SID}
    // and the lock hooks read the same var, so a session's interactive calls
    // and its hooks share ONE owner — and two concurrent psu sessions get
    // distinct owners (the collapse the per-session id fixes). Minted BEFORE the
    // adv_sessions row so it's recorded as coord_owner_id — the live-roster join
    // key to coord_presence.owner_id (adv-sessions-live-roster P-001).
    const sid = `su-${randomUUID()}`;

    // The agent's NATIVE session id. claude lets us FORCE it (`--session-id`),
    // so we mint it here, record it, and the launcher passes it through — that's
    // the only way `psu --resume <native-uuid>` can later correlate this exact
    // session back to its adv row (without it, resume-by-uuid falls through to
    // the false "not started by psu" path). omp's native handle is the
    // omp_thread_id (linked post-launch); codex resumes via its per-session
    // CODEX_HOME and can't have its rollout id forced — so both stay null.
    const nativeSessionId = backendFeatureGuard(agent, 'forced-native-session-id').supported
      ? randomUUID()
      : null;

    // launch-path-argv-reconstruction (WI-1343): the exact `psu …` invocation that
    // launched this session — recorded on adv_sessions.launch_argv so a killed batch
    // (e.g. a 14-agent fleet) can be reconstructed. The launcher sends the literal argv
    // (normalizeLaunchArgv); a caller that omits it falls back to a server-side
    // reconstruction from the resolved fields. Before this the column was always NULL.
    const launchArgv =
      normalizeLaunchArgv(body.launch_argv) ??
      reconstructPsuLaunchArgv({
        agent,
        harnessSlug,
        planSlug,
        profile,
        contextSize,
        account: body.account?.trim() || null,
        fleet: body.fleet?.trim() || body.fleet_name?.trim() || null,
      });

    // named-su-agent-fleets P-006: resolve the chosen fleet (create-on-new-name +
    // membership env). sid is this session's coord owner id → the fleet's owner +
    // leader when it creates a new fleet (D-002).
    //
    // WI-1408 (fleet-join-startup-assertion): resolved + hard-asserted HERE, BEFORE
    // recordAdvSession/armInboxWake below, so a launch that explicitly asked to
    // join/create a fleet (`--fleet=<slug>` / a new fleet name) never leaves behind a
    // "ghost" adv_sessions row + an armed inbox-wake for a session that's about to be
    // rejected. A resolution hiccup (unknown slug, transient DB error) must never
    // silently degrade to an UNFLEETED member either — that's exactly the "colour-only,
    // membership forgotten" ghost the fleet tooling exists to prevent (a member invisible
    // to fleet:assignments despite the operator having asked for a named fleet). Fail
    // LOUD here, before ANY bookkeeping, instead of fail-soft + a notice nobody reads.
    const fleetPin = await resolveFleet(workspace, {
      fleet: body.fleet,
      fleetRole: body.fleet_role,
      fleetName: body.fleet_name,
      fleetScheme: body.fleet_scheme,
      ownerId: sid,
    });
    const fleetRequested = Boolean(body.fleet?.trim() || body.fleet_name?.trim());
    if (fleetRequested && !fleetPin.fleetSlug) {
      return jsonRes(
        {
          status: 'error',
          error: `fleet join failed: ${fleetPin.notice ?? 'unknown reason'} — refusing to launch an unfleeted member when a fleet was explicitly requested.`,
        },
        409,
      );
    }

    // WI-1893 (cluster-safe fleet stamp): append the DURABLE membership fact NOW —
    // before any bookkeeping (recordAdvSession/armInboxWake), same no-ghost ordering
    // as the WI-1408 guard above. Replaces the in-memory setPendingFleet placement
    // (WI-1343), which lived in ONE cluster worker and was lost when the member's
    // first presence write landed on another — see stampFleetMembershipAtBoot.
    if (fleetPin.fleetSlug) {
      const stampErr = await stampFleetMembershipAtBoot({
        workspaceId: workspace,
        ownerId: sid,
        ownerLabel: body.label?.trim() || null,
        fleetSlug: fleetPin.fleetSlug,
        fleetRole: fleetPin.fleetRole,
      });
      if (stampErr) {
        return jsonRes(
          {
            status: 'error',
            error: `fleet membership stamp failed: ${stampErr} — refusing to launch a member that would be invisible to its fleet (WI-1893).`,
          },
          409,
        );
      }
    }

    // agent-allocation P-005 (launch-from-seats): record the seat consumption NOW —
    // same no-ghost ordering as the WI-1893 fleet stamp above (before any
    // bookkeeping), and the boot-time CAP backstop: consumeSeatAtBoot's atomic
    // conditional insert refuses the over-cap member even when concurrent launches
    // raced past the fleet:launch-on-plan gate (the P-006 "N+1th spawn refused").
    const seatRef = body.seat?.trim() || null;
    if (seatRef) {
      if (!fleetPin.fleetSlug) {
        return jsonRes(
          {
            status: 'error',
            error: '`--seat` requires a fleet: a seat is delegated TO a fleet (agent-allocation P-005) — pass `--fleet=<slug>` with it.',
          },
          409,
        );
      }
      const { consumeSeatAtBoot } = await import('../../../fleet/seat-accounting');
      const seatRes = await consumeSeatAtBoot({
        workspaceId: workspace,
        fleetSlug: fleetPin.fleetSlug,
        seatRef,
        ownerId: sid,
      });
      if (!seatRes.ok) {
        return jsonRes(
          {
            status: 'error',
            error: `seat consumption refused [${seatRes.refusal.code}]: ${seatRes.refusal.detail}`,
          },
          409,
        );
      }
    }

    // Record the tracked session first so the prompt/home files key off its id.
    const sessionId = await recordAdvSession({
      planSlug,
      agent,
      workspaceId: workspace,
      mode: agent === 'omp' ? 'omp' : 'console',
      cwd,
      label: body.label?.trim() || null,
      coordOwnerId: sid,
      sessionId: nativeSessionId,
      launchArgv,
    });

    // launch-wakeability (turn-lifecycle-control): arm the standing inbox-wake NOW —
    // the reliable, synchronous, PRE-FIRST-TURN launch moment — so a coordinator sees
    // this session as `parked`/wakeable the instant bootstrap returns, instead of
    // waiting on the detached, fail-open SessionStart lifecycle hook (whose lost POST
    // otherwise leaves a freshly-launched agent visible-but-undispatchable — the "idle
    // su peers I can't wake" gap). Composes with the recorded-session roster leg: the
    // adv_sessions row makes it visible, this arm flips `recorded` → `parked`. Idempotent
    // (the hook's later re-arm refreshes the same standing row) + best-effort (a launch
    // must never fail on an arm hiccup).
    try {
      const { armInboxWake } = await import('../../../events/await/inbox-wake-arm');
      await armInboxWake({ ownerId: sid, workspaceId: workspace });
    } catch (e: any) {
      process.stderr.write(`[bootstrap-su] inbox-wake arm failed (non-fatal): ${e?.message}\n`);
    }

    const sessionKey = sessionId ?? `t-${randomUUID()}`;

    // psu-account-chooser: resolve before writing Codex launch artifacts so a Codex
    // account pin can be baked into CODEX_HOME/config.toml.
    // HARD pin (account-hard-pin-2026-06-29): the interactive PSU launcher pins are STRICT — the operator
    // explicitly chose this account, so route there with no failover (stricter than the bees' soft pins).
    const accountPin = await resolveAccountPin(workspace, body.account, agent, sid, true);

    // WI-1343's in-memory setPendingFleet placement used to live here; replaced by the
    // durable membership-fact stamp above (WI-1893 — the map was per-cluster-worker and
    // lost placements when the member's first presence write hit another worker).

    // Fleet-launched agents start AUTONOMOUS (WI-1356): a fleet member has no human
    // at its keyboard, so `--fleet` (or an explicit `--auto`) launches it in AUTO
    // mode. The launcher sends `auto` in the body; when set we (a) inject a DURABLE
    // AUTO directive into the assembled system prompt (survives compaction) and
    // (b) prepend the same activation to the seeded kickoff so turn 1 enters AUTO.
    const autoMode = body.auto === true;

    const launchContextPath = body.launch_context?.trim() || null;
    // solo-launch-provenance: identity-shaped only — refuse garbage loudly rather
    // than bake it into a system prompt / standing fact.
    const launchedByRaw = body.launched_by?.trim() || null;
    if (launchedByRaw && !/^[A-Za-z0-9._:-]{1,120}$/.test(launchedByRaw)) {
      return jsonRes(
        { status: 'error', error: `launched_by must be an owner id (got ${launchedByRaw.slice(0, 48)})` },
        400,
      );
    }
    const launchedBy = launchedByRaw;
    let promptText = spec.promptText;
    if (agent === 'codex' && launchContextPath) {
      try {
        const launchContext = readFileSync(launchContextPath, 'utf8').trim();
        if (launchContext) {
          promptText = `${promptText.replace(/\n+$/, '')}\n\n---\n## Launch Context\n\n${launchContext}\n`;
        }
      } catch (e: any) {
        return jsonRes({ status: 'error', error: `read launch_context: ${e?.message}` }, 400);
      }
    }

    // solo-launch-provenance: bake WHO launched this session into the assembled
    // system prompt (promptText is the single source for all three backends), so
    // the agent can always answer "who launched you / who supervises this mission"
    // — across compaction AND cold-loop resets. Found 2026-07-03: su-8ab32510
    // described its launcher as "an observer who doesn't assign or supervise my
    // work" because NOTHING in the system recorded the relationship.
    if (launchedBy) {
      promptText =
        `${promptText.replace(/\n+$/, '')}\n\n---\n## Provenance — who launched this session\n\n` +
        `You were launched by **${launchedBy}**, the agent that chose this mission and its launch ` +
        `brief. They are your LAUNCHER/SUPERVISOR: report milestones, blockers, and anomalies to ` +
        `them (coord:send), answer their messages before your own next step, and treat their ` +
        `directives as steering. If asked who launched you or whose work this is, the answer is ` +
        `${launchedBy}.\n`;
      // ALSO assert the provenance as an owner-scoped STANDING FACT — coord:orient
      // folds owner-scope facts VERBATIM at every orient, so the agent re-learns its
      // launcher on every wake (a cold loop re-orients from nothing each wake).
      // Best-effort: a facts outage must never block a launch.
      try {
        const { assertFact } = await import('../../../agent-facts/store');
        await assertFact({
          scope: 'owner',
          scopeRef: sid,
          key: 'launch-provenance',
          body:
            `You were launched by ${launchedBy}` +
            (planSlug ? ` on plan ${planSlug}` : '') +
            (launchContextPath ? ` with brief ${basename(launchContextPath)}` : '') +
            `. They are your launcher/supervisor — report milestones + anomalies to them.`,
          sourceRef: 'bootstrap-su:launched-by',
          createdBy: launchedBy,
          ttlSec: 30 * 24 * 3600,
          workspaceId: workspace,
        });
      } catch (e: any) {
        process.stderr.write(`[bootstrap-su] provenance fact assert failed (non-fatal): ${e?.message}\n`);
      }
    }

    // fleet-auto-mode (WI-1356): bake the durable AUTO directive into the assembled
    // system prompt so it survives compaction. promptText is the single source for
    // every backend's launch context (claude/omp launch-context file + codex AGENTS.md),
    // so injecting here covers all three.
    if (autoMode) {
      promptText = `${promptText.replace(/\n+$/, '')}\n\n---\n## AUTO mode\n\n${AUTO_MODE_DIRECTIVE}\n\n${CONTEXT_DISCIPLINE_DIRECTIVE}\n`;
    }

    // Materialize the launch artifacts. codex (no --mcp-config/-prompt flags)
    // gets a per-session CODEX_HOME (P-030); claude/omp get a launch-context
    // prompt file and rely on their USER-LEVEL papercusp-su MCP (it survives
    // a raw launch — no per-launch .mcp.json needed for su).
    let promptFile = '';
    let codexHome: string | null = null;
    try {
      if (agent === 'codex') {
        // D-006: the superuser bearer is baked into the home's config.toml
        // (codex 0.135's bearer_token_env_var doesn't deliver for HTTP MCP).
        // Read it server-side — it never transits the bootstrap HTTP response.
        const ch = writeSuCodexHome({
          sessionKey,
          mcpUrl: spec.mcpUrl,
          promptText,
          sid,
          token: readSuperuserToken(),
          codexGatewayAccountId: accountPin.provider === 'codex' ? accountPin.accountId : null,
        });
        codexHome = ch.codexHome;
        promptFile = ch.agentsPath; // AGENTS.md — diagnostics
      } else {
        promptFile = launchContextPathFor(sessionKey);
        mkdirSync(launchContextDir(), { recursive: true });
        writeFileSync(promptFile, promptText, { mode: 0o600 });
      }
    } catch (e: any) {
      return jsonRes({ status: 'error', error: `write su launch artifacts: ${e?.message}` }, 500);
    }

    // Materialize saved prompts so the session starts with the workspace's
    // `/name` commands (+ the harness's, when this su session is harness-
    // scoped) available in this client (plan saved-prompts-cross-client).
    // Codex needs them in its ephemeral home; claude/omp read .claude/commands.
    // Best-effort — never block a launch.
    try {
      if (agent === 'codex' && codexHome) {
        await materializeCodexPrompts(codexHome, workspace, harnessSlug);
        // Slash exposure (slash-exposure-tool-catalog-2026-06-12 P-009):
        // Codex doesn't surface MCP prompts as slash commands, so the
        // session-visible tool catalog is materialized as prompt FILES.
        // An su session runs the operator-role catalog.
        const r = await emitCodexSlashToolPrompts(codexHome, 'operator' as never);
        process.stderr.write(
          `[bootstrap-su] slash tool prompts: ${r.written} written, ${r.pruned} pruned in ${Math.round(r.ms)}ms\n`,
        );
      } else {
        await materializeWorkspacePrompts(workspace);
        if (harnessSlug) await materializeHarnessPrompts(workspace, harnessSlug);
      }
    } catch (e: any) {
      // stderr (not console.*) so the vitest fail-on-console guard stays green.
      process.stderr.write(`[bootstrap-su] saved-prompts materialize failed (non-fatal): ${e?.message}\n`);
    }

    // omp loads the coordination extension via -e for lock enforcement.
    const coordExt = resolveInstallPaths(homedir()).extensionPath;
    const coordExtPath = existsSync(coordExt) ? coordExt : null;

    // EI-155: an interactive claude session gets a per-session, transcript-
    // isolated CLAUDE_CONFIG_DIR (keyed by sid via the shared helper, so the
    // wake-executor resume leg resolves the SAME dir). It is a symlink mirror of
    // ~/.claude with only `projects/` isolated — the user-level papercusp-su MCP,
    // the lock/coord hooks, plugins, and onboarding/trust all carry through (a
    // creds-only dir like the bee path would strip all of those — see
    // writeInteractiveClaudeConfig). codex isolates via its CODEX_HOME; omp's
    // store is its own. Best-effort: a materialize failure must not block a
    // launch (the session falls back to the shared ~/.claude, exactly as before).
    let claudeConfigDir: string | null = null;
    if (agent === 'claude') {
      try {
        // P-020: a fleet-tier member gets the pruned plugin/MCP surface
        // (github/cloudflare/firecrawl plugins + the playwright mcpServer dropped).
        claudeConfigDir = writeInteractiveClaudeConfig({
          sid,
          prunePlugins: spec.personaTier === 'fleet',
        }).configDir;
      } catch (e: any) {
        process.stderr.write(`[bootstrap-su] claude config-dir materialize failed (non-fatal): ${e?.message}\n`);
      }
    }

    // domain-generic-agent-personas-2026-06-17 P-014 (REPLACE_CLAUDE_BASE, default-off):
    // resolve the flag server-side and thread it to the launcher via envelopeEnv (same env
    // name the fleet path reads). The psu launcher reads it to make the playbook REPLACE the
    // Claude base (--system-prompt-file + --exclude-dynamic) instead of appending. Fail-soft:
    // a flag-lookup throw ⇒ off ⇒ the launcher uses --append (byte-identical to today).
    let replaceClaudeBase = false;
    try {
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      replaceClaudeBase = await getFlag(FLAGS.REPLACE_CLAUDE_BASE, workspace);
    } catch {
      /* flag miss ⇒ replace-base stays off (Claude base + --append stands) */
    }

    const envelopeEnv: Record<string, string> = {
      ...envelope.env,
      ...(replaceClaudeBase ? { PAPERCUSP_REPLACE_CLAUDE_BASE: '1' } : {}),
      PAPERCUSP_AGENT: agent,
      PAPERCUSP_SID: sid,
      // Per-launch dispatch profile. claude's user-level MCP url expands
      // ${PAPERCUSP_PROFILE:-}; omp carries it via the x-papercusp-profile
      // header — without this export, --profile=power changed only the
      // playbook text while the MCP dispatcher kept gating as engineer.
      PAPERCUSP_PROFILE: profile,
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
      ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
      // solo-launch-provenance: the launcher's ownerId, readable by hooks/tools.
      ...(launchedBy ? { PAPERCUSP_LAUNCHED_BY: launchedBy } : {}),
    };

    // psu-account-chooser P-002: when the launch carries an explicit `account`, fold
    // the gateway-pin env into the envelope (fail-soft — a skipped pin just adds a
    // notice the launcher prints, never an error).
    Object.assign(envelopeEnv, accountPin.env);
    // named-su-agent-fleets P-006: fold the fleet membership env (PAPERCUSP_FLEET_SLUG /
    // PAPERCUSP_FLEET_ROLE) right next to the account pin — the presence-write path
    // reads those exact var names. Empty when no fleet was chosen (byte-identical).
    Object.assign(envelopeEnv, fleetPin.env);

    // improve-fleet-launch-autokickoff (EI-5503) + WI-1962 + fleet-auto-mode
    // (WI-1356): the first user turn the launcher seeds, so a scripted launch —
    // plan-bound, mission-brief (--launch-context), or AUTO — STARTS working
    // instead of parking idle. The launcher GATES delivery (--no-picker, unless
    // --no-kickoff); the server supplies the canonical text (deriveKickoffPrompt,
    // pure + tested) — shared with plans:launch's headless kickoff via
    // ./launch-prompt, so the two never drift.
    const kickoffPrompt = deriveKickoffPrompt({ planSlug, autoMode, launchContextPath });

    const result: BootstrapSuResult = {
      status: 'ok',
      sessionId,
      nativeSessionId,
      agent,
      workspaceId: workspace,
      cwd,
      harnessSlug,
      planSlug,
      promptFile,
      codexHome,
      coordExtPath,
      envelopeEnv,
      accountNotice: accountPin.notice,
      fleetNotice: fleetPin.notice,
      fleetSlug: fleetPin.fleetSlug,
      fleetRole: fleetPin.fleetRole,
      kickoffPrompt,
    };
    return jsonRes(result);
  },
});

/**
 * POST /api/agent-mcp/console/bootstrap-su/heartbeat  { ownerId }
 *
 * The psu SUPERVISOR beat (agent-liveness-heartbeat-hardening-2026-06-12
 * P-003): the launcher process — which stays alive as the agent's parent —
 * POSTs this every ~60s while its child runs, so a session in a long turn
 * with NO tool calls keeps its coord_presence row warm (process-alive
 * semantics, the interactive analog of the fleet nursery beat).
 *
 * touchHeartbeat is a no-op when no presence row exists (D-003 — the beat
 * never mints roster rows; declare-intent at session start does that).
 *
 * Deliberately NO audit/adv-session write: high-frequency + zero
 * information. Trust: principal-gated like the sibling console routes;
 * a same-UID loopback caller naming another ownerId is inside the existing
 * console trust boundary (same model as the cc/ hook chain).
 */
const heartbeat = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/heartbeat',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let ownerId = '';
    try {
      const body = (await req.json()) as { ownerId?: unknown };
      if (typeof body.ownerId === 'string') ownerId = body.ownerId.trim();
    } catch {
      /* fall through to the 400 */
    }
    if (!ownerId || ownerId.length > 200) {
      return jsonRes({ error: 'ownerId required' }, 400);
    }
    try {
      const { touchHeartbeat } = await import('../../../agent-tools/coordination/presence');
      await touchHeartbeat(ownerId);
      return jsonRes({ ok: true });
    } catch (err) {
      // Best-effort contract: the launcher treats any failure as a missed
      // beat, never an error loop.
      return jsonRes(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        503,
      );
    }
  },
});

const optionsForHeartbeat = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/heartbeat',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * POST /api/agent-mcp/console/bootstrap-su/session-ended  { advSessionId, exitCode? }
 *
 * The psu launcher's exit report. psu stays alive as the agent's parent in
 * BOTH launch paths (the same property the supervisor beat rides), and on
 * child exit it stamps the tracked adv_sessions row's ended_at/exit_code
 * here. Before this, CONSOLE sessions never got ended_at (markAdvSessionEnded
 * only fired for server-spawned terminals), so every dead launch sat
 * "· active" in the `psu --resume` picker forever — and the session-dir GC's
 * open-row protection never expired, wedging collection of abandoned dirs.
 *
 * Best-effort contract like the sibling heartbeat: the launcher swallows any
 * failure (it is about to process.exit). markAdvSessionEnded is idempotent —
 * it only stamps an unset ended_at — so a duplicate report is harmless.
 */
const sessionEnded = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-ended',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let advSessionId: number | null = null;
    let exitCode: number | null = null;
    try {
      const body = (await req.json()) as { advSessionId?: unknown; exitCode?: unknown };
      if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
        advSessionId = body.advSessionId;
      }
      if (typeof body.exitCode === 'number' && Number.isInteger(body.exitCode)) {
        exitCode = body.exitCode;
      }
    } catch {
      /* fall through to the 400 */
    }
    if (advSessionId == null || advSessionId <= 0) {
      return jsonRes({ error: 'advSessionId required' }, 400);
    }
    try {
      await markAdvSessionEnded(advSessionId, exitCode);
      return jsonRes({ ok: true });
    } catch (err) {
      return jsonRes(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        503,
      );
    }
  },
});

const optionsForSessionEnded = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-ended',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * POST /api/agent-mcp/console/bootstrap-su/session-resumed  { advSessionId }
 *
 * The psu launcher's RESUME report — the inverse of session-ended. `psu --resume`
 * brings the agent process back to life but `launchResume` takes the no-POST path
 * (it reuses the original coord identity + adv row), so without this the row keeps
 * the ended_at/exit_code from the prior exit and the running agent is recorded as
 * dead → invisible to the roster + presence-as-a-view. This re-activates the row
 * (clears ended_at/exit_code, bumps started_at) so a resumed session shows live
 * immediately, before it touches coord (presence-derive-from-session-log P-002).
 *
 * Best-effort + idempotent like the sibling session-ended: reactivateAdvSession
 * only touches an already-ENDED row, so a duplicate / already-live report is a
 * harmless no-op, and the launcher swallows any failure.
 */
const sessionResumed = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resumed',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let advSessionId: number | null = null;
    try {
      const body = (await req.json()) as { advSessionId?: unknown };
      if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
        advSessionId = body.advSessionId;
      }
    } catch {
      /* fall through to the 400 */
    }
    if (advSessionId == null || advSessionId <= 0) {
      return jsonRes({ error: 'advSessionId required' }, 400);
    }
    try {
      const reactivated = await reactivateAdvSession(advSessionId);
      return jsonRes({ ok: true, reactivated });
    } catch (err) {
      return jsonRes(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        503,
      );
    }
  },
});

const optionsForSessionResumed = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resumed',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

export default [options, optionsForOptions, post, optionsGet, brainGet, heartbeat, optionsForHeartbeat, sessionEnded, optionsForSessionEnded, sessionResumed, optionsForSessionResumed];
