/**
 * fleet:launch-on-plan — stand up a desktop fleet ON a plan in ONE call.
 *
 * Collapses the multi-step "create a desktop fleet to work a plan" flow
 * (improve-fleet-launch-autokickoff / EI-5504) that used to be:
 *   fleet:create → write a launch brief → capability:terminal (N psu windows)
 *   → coord:send a manual kickoff wake to each parked member.
 * into a single tool:
 *   1. ensure the named fleet exists (idempotent) with the caller as leader;
 *   2. validate the target plan exists in the harness;
 *   3. open N visible desktop member terminals, each running a scripted psu
 *      launch on the plan.
 *
 * The members AUTO-START: a scripted `psu --no-picker --plan=…` launch now seeds
 * the agent's first user turn (EI-5503), so each member begins working the plan on
 * boot — no leader kickoff wake needed (the gap this pairs with).
 *
 * Plan AUTHORING + START stay their own well-factored tools (plans:apply-plan-block
 * / plans:new + plans:add-item, then plans:start) — chain them before this. A member
 * works plan items directly (plans:get → plans:set-status wip auto-claims), so the
 * plan need not be "started" for the fleet to make progress; start it when you also
 * want Queen/orchestrator visibility.
 *
 * Reuses the maintained machinery rather than forking: createFleetIfAbsent (the
 * fleet:create registry path) + buildConsoleEnvelope/spawnConsole (the
 * capability:terminal desktop-spawn path). Desktop-spawn is Linux+macOS only; on
 * Windows (operator in WSL) spawnConsole returns 501 with an actionable error.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole } from '../../console-spawn';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  createFleetIfAbsent,
  fleetSlugFromName,
  getFleetScheme,
} from '../../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from '../coordination/presence';
import { resolveHarnessPlansDir, readPlanBySlug } from '../plans/source';
import { fleetRoleFor, json, resolveFleetCaller } from './_shared';
import type { ColorScheme } from '../../console-color-schemes';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import { buildCapacityReport, buildFleetSizingAdvisory } from '../../fleet/capacity-dispatch';

/** Opening more than this many desktop windows in one call is heavy + almost always
 *  a mistake — mirrors capability:terminal's MAX_TERMINALS. */
const MAX_MEMBERS = 12;

/** The operator's own base URL for the spawned terminal's API-callback env. Mirrors
 *  capability:terminal's resolver (strip a trailing /api/mcp back to the origin). */
function resolveOperatorBaseUrl(): string {
  const fromEnv = process.env.PAPERCUSP_OPERATOR_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  const port = process.env.PAPERCUSP_HONO_PORT?.trim() || '3070';
  return `http://localhost:${port}`;
}

/** Optional psu launch flags threaded onto EVERY member's `psu` invocation (EI-5765 /
 *  owner request). Each maps to the matching `psu --flag=value`; `brain` is the boolean
 *  `--brain`; `extraArgs` is a verbatim escape hatch for any psu flag without a first-class
 *  field. The fleet/agent/harness/plan/no-picker tokens are owned by the tool and not
 *  overridable here. */
export interface MemberLaunchOpts {
  fleetSlug: string;
  agent: string;
  harness: string;
  plan: string;
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
  extraArgs?: string[];
}

/** Shell-quote a value for the spawned greetingCmd: leave a safe token bare (clean,
 *  matches the slug-style flags) and single-quote anything with whitespace / shell
 *  metacharacters (paths, free-form extraArgs) so a member command can never be injected. */
function shq(v: string): string {
  return /^[A-Za-z0-9_.:=/+@-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the scripted psu launch command for one fleet member working a plan. Pure +
 * exported for tests. `--no-picker --plan` is what triggers the EI-5503 auto-kickoff, so a
 * member starts working on boot. The base tokens (fleet/agent/harness/plan) are constrained
 * slugs/enums (no quoting needed); every optional flag's VALUE is shell-quoted via shq.
 */
export function memberLaunchCommand(opts: MemberLaunchOpts): string {
  const parts = [
    'psu',
    '--no-picker',
    `--fleet=${opts.fleetSlug}`,
    `--agent=${opts.agent}`,
    `--harness=${opts.harness}`,
    `--plan=${opts.plan}`,
  ];
  if (opts.account) parts.push(`--account=${shq(opts.account)}`);
  if (opts.workspace) parts.push(`--workspace=${shq(opts.workspace)}`);
  if (opts.role) parts.push(`--role=${shq(opts.role)}`);
  if (opts.model) parts.push(`--model=${shq(opts.model)}`);
  if (opts.feature) parts.push(`--feature=${shq(opts.feature)}`);
  if (opts.launchContext) parts.push(`--launch-context=${shq(opts.launchContext)}`);
  if (opts.profile) parts.push(`--profile=${shq(opts.profile)}`);
  // su-context-size-variants: enum-constrained ('full'|'trimmed'), so no shq needed.
  if (opts.contextSize) parts.push(`--context-size=${opts.contextSize}`);
  if (opts.brain) parts.push('--brain');
  for (const d of opts.addDir ?? []) if (d) parts.push(`--add-dir=${shq(d)}`);
  for (const a of opts.extraArgs ?? []) if (a) parts.push(shq(a));
  return parts.join(' ');
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export default defineTool({
  name: 'fleet:launch-on-plan',
  description:
    "Stand up a desktop fleet ON a plan in ONE call: ensure the named fleet (you become its leader), then open N visible member terminals each running a scripted psu launch on the plan. The members AUTO-START working the plan on boot (no manual kickoff wake). Optional psu launch flags thread onto every member — account (pin the fleet's model load to a chosen gateway pool account), workspace, role, model, feature, launch-context, profile, context-size (full|trimmed), brain, add-dir, plus an `extraArgs` escape hatch for any other psu flag. Author + start the plan first (plans:apply-plan-block / plans:start); this tool launches the workers. Linux + macOS only.",
  guidance: {
    when: 'Routing option (3) — "spawn a new desktop fleet to work a plan" — in ONE call instead of fleet:create + capability:terminal + a manual kickoff. Pass the plan slug + a fleet name; members open on the user\'s desktop and start working immediately.',
    notWhen:
      'You only need worker windows with no fleet/plan → capability:terminal. You only need to register a fleet (no terminals) → fleet:create. Authoring or starting the plan → plans:apply-plan-block / plans:start (do that FIRST; this tool does not create or start plans).',
    chaining:
      'plans:apply-plan-block (or plans:new + plans:add-item) → plans:start (optional, for Queen visibility) → fleet:launch-on-plan { name, plan, count }. As leader you then monitor via fleet:assignments + coord:presence.',
  },
  // Desktop-spawn is the privileged action — gate it exactly like capability:terminal.
  capability: 'capability:terminal',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    name: z
      .string()
      .min(1)
      .describe('Fleet name — created (you become leader) if new, else joined. Slugified to the durable handle.'),
    plan: z.string().min(1).describe('Plan slug (filename without .md) the members should work. Must already exist.'),
    harness: z
      .string()
      .optional()
      .describe("Harness the plan belongs to. Defaults to the session's harness scope; required when the session is unscoped."),
    agent: z
      .enum(['claude', 'omp', 'codex'])
      .optional()
      .describe('Backend each member runs (default claude).'),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_MEMBERS)
      .optional()
      .describe(`Number of member terminals to open (default 1, max ${MAX_MEMBERS}).`),
    // --- optional psu launch flags threaded onto EVERY member (EI-5765 / owner request) ---
    account: z
      .string()
      .optional()
      .describe(
        "psu --account routing for EVERY member (account-routing-3-options) — one of three: a POOL ACCOUNT ID (from accounts:list / gateway:status) → pin every member to it via the inference gateway (isolate/concentrate the fleet's load; no failover); \"auto\" → route through the gateway, which auto-selects an available account + fails over; \"default\" (or omit) → skip the gateway, use the system / CLI-login credential. (For a multi-account spread, launch in batches with different account ids.) ANNOUNCE the choice to the owner per the persona spawn-disclosure rule.",
      ),
    workspace: z
      .string()
      .optional()
      .describe(
        "psu --workspace: the workspace the fleet + every member launch under. Defaults to the launch session's workspace.",
      ),
    role: z
      .string()
      .optional()
      .describe('psu --role: the su role each member runs as (default the standard su collaborator).'),
    model: z
      .string()
      .optional()
      .describe('psu --model: a per-member model spec, e.g. "opus:high" (default the role/tier default).'),
    feature: z.string().optional().describe('psu --feature: a feature id each member should pick up.'),
    launchContext: z
      .string()
      .optional()
      .describe("psu --launch-context: path to a brief/markdown file injected as each member's launch context."),
    profile: z.string().optional().describe('psu --profile: launch profile name for each member.'),
    contextSize: z
      .enum(['full', 'trimmed'])
      .optional()
      .describe(
        "psu --context-size: initial-context size variant for EVERY member — 'full' (~180k, whole tool catalog loaded up-front, native soft-trim OFF) or 'trimmed' (~50k, core spine + the client's native soft-trim). Omit for each backend's native default (byte-identical to no flag).",
      ),
    brain: z.boolean().optional().describe('psu --brain: launch each member in brain mode.'),
    addDir: z
      .array(z.string())
      .optional()
      .describe("psu --add-dir (repeatable): extra directories added to each member's workspace."),
    extraArgs: z
      .array(z.string())
      .optional()
      .describe(
        'Escape hatch for any other psu flag: each element is one full token (e.g. ["--yes", "--add-dir=/x"]), appended verbatim to every member\'s psu launch — covers psu args without a first-class field above.',
      ),
  }),
  async handler(args, ctx) {
    const { identity, ownerId, workspaceId: callerWs } = resolveFleetCaller(ctx);
    // An explicit `workspace` arg (psu --workspace) scopes the fleet + envelope + every
    // member; otherwise the launch session's workspace (never the '*' wildcard).
    const workspaceId =
      args.workspace?.trim() || (callerWs && callerWs !== '*' ? callerWs : activeWorkspaceId());
    const agent = args.agent ?? 'claude'; // constrained to claude|omp|codex by the arg enum
    const count = args.count ?? 1;

    // Harness scope: explicit arg, else the session's scope (never the '*' wildcard).
    const ctxSlug = (ctx as { harnessSlug?: string | null }).harnessSlug;
    const harness = args.harness?.trim() || (ctxSlug && ctxSlug !== '*' ? ctxSlug : null);
    if (!harness) {
      return err(
        'No harness for the plan. Pass `harness: "<slug>"` (the harness the plan belongs to) — this session is not harness-scoped.',
      );
    }

    // Validate the plan exists before opening any windows (fail clean, not N dead members).
    try {
      const resolved = await resolveHarnessPlansDir(harness, { workspaceId });
      const found = await readPlanBySlug(args.plan, {
        harnessSlug: resolved.harnessSlug,
        workspaceId: resolved.workspaceId,
      });
      if (!found) {
        return err(
          `Plan \`${args.plan}\` not found in harness \`${harness}\`. Create it first (plans:apply-plan-block / plans:new + plans:add-item), then launch the fleet.`,
        );
      }
    } catch (e: any) {
      return err(`Could not resolve plan \`${args.plan}\` in harness \`${harness}\`: ${e?.message ?? e}`);
    }

    // Ensure the fleet (idempotent) with the caller as owner + leader, then label the
    // caller's presence — same path as fleet:create.
    const fleetSlug = fleetSlugFromName(args.name);
    let leaderRole = 'leader';
    try {
      const { record } = await createFleetIfAbsent({
        workspaceId,
        fleetSlug,
        title: args.name,
        owner: ownerId,
        leaderOwnerId: ownerId,
      });
      leaderRole = fleetRoleFor(record.leaderOwnerId, ownerId);
      await heartbeatPresence(identity);
      await setPresenceFleet(workspaceId, ownerId, fleetSlug, leaderRole);
    } catch (e: any) {
      return err(`Failed to create/join fleet \`${fleetSlug}\`: ${e?.message ?? e}`);
    }

    // Base envelope (cwd/env) once — skip the superuser .mcp.json (each member's psu
    // bootstraps its own MCP), exactly like capability:terminal.
    let base;
    try {
      base = await buildConsoleEnvelope({
        workspaceId,
        slug: harness,
        operatorBaseUrl: resolveOperatorBaseUrl(),
        skipMcpJson: true,
      });
    } catch (e: any) {
      return err(`Failed to prepare the fleet terminals: ${e?.message ?? e}`);
    }

    // The fleet's bound color scheme (cosmetic — a lookup failure never blocks launch).
    let scheme: ColorScheme | null = null;
    try {
      scheme = await getFleetScheme(workspaceId, fleetSlug);
    } catch {
      scheme = null;
    }

    const command = memberLaunchCommand({
      fleetSlug,
      agent,
      harness,
      plan: args.plan,
      account: args.account?.trim() || undefined,
      workspace: args.workspace?.trim() || undefined,
      role: args.role?.trim() || undefined,
      model: args.model?.trim() || undefined,
      feature: args.feature?.trim() || undefined,
      launchContext: args.launchContext?.trim() || undefined,
      profile: args.profile?.trim() || undefined,
      contextSize: args.contextSize,
      brain: args.brain || undefined,
      addDir: args.addDir,
      extraArgs: args.extraArgs,
    });
    const opened: Array<{ terminal: string; pid: number | null }> = [];
    const failed: Array<{ error: string; code: number }> = [];
    for (let i = 0; i < count; i++) {
      const result = spawnConsole({
        envelope: { ...base, greetingCmd: command, cwd: base.cwd },
        label: `${fleetSlug} · member ${i + 1}/${count} (${args.plan})`,
        writeMcpJson: false,
        scheme,
      });
      if (result.status === 'ok') opened.push({ terminal: result.terminal, pid: result.pid });
      else failed.push({ error: result.error, code: result.code });
    }

    let sizingAdvisory: ReturnType<typeof buildFleetSizingAdvisory> = null;
    try {
      const capacity = buildCapacityReport(await fetchGatewayHeadroom({ timeoutMs: 1200 }), { clampArmed: false });
      sizingAdvisory = buildFleetSizingAdvisory(count, capacity);
    } catch {
      sizingAdvisory = null;
    }

    const lines: string[] = [];
    if (sizingAdvisory) lines.push(sizingAdvisory.message);
    lines.push(
      opened.length
        ? `Launched fleet \`${fleetSlug}\` (you are ${leaderRole}) on plan \`${args.plan}\` — ${opened.length}/${count} member${count > 1 ? 's' : ''} opened${scheme ? ` (scheme: ${scheme.name})` : ''}:`
        : `No member terminals opened for fleet \`${fleetSlug}\`.`,
    );
    for (const o of opened) lines.push(`  • ${o.terminal} (pid ${o.pid ?? '?'}) — ${command}`);
    if (failed.length) {
      lines.push(`${failed.length} failed:`);
      for (const f of failed) lines.push(`  • ${f.error}`);
      if (failed.some((f) => f.code === 501)) {
        lines.push(
          '(Desktop-spawn is Linux + macOS only; on Windows the operator runs inside WSL and cannot open a GUI terminal.)',
        );
      }
    }
    if (opened.length) {
      lines.push(
        'Members auto-start working the plan on boot (no manual kickoff needed). As leader, monitor with fleet:assignments + coord:presence, and drive the plan to done through the fleet.',
      );
    }

    return json(
      {
        ok: opened.length > 0,
        fleet: fleetSlug,
        leaderRole,
        plan: args.plan,
        harness,
        agent,
        account: args.account?.trim() || null,
        requested: count,
        sizingAdvisory,
        opened,
        failed,
        message: lines.join('\n'),
      },
      opened.length === 0,
    );
  },
});
