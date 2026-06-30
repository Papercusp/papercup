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

/**
 * Build the scripted psu launch command for one fleet member working a plan. Pure +
 * exported for tests. `--no-picker --plan` is what triggers the EI-5503 auto-kickoff,
 * so a member starts working on boot. Args are shell-token-safe (slugs + the agent
 * enum), so no quoting is needed.
 */
export function memberLaunchCommand(opts: {
  fleetSlug: string;
  agent: string;
  harness: string;
  plan: string;
}): string {
  return [
    'psu',
    '--no-picker',
    `--fleet=${opts.fleetSlug}`,
    `--agent=${opts.agent}`,
    `--harness=${opts.harness}`,
    `--plan=${opts.plan}`,
  ].join(' ');
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export default defineTool({
  name: 'fleet:launch-on-plan',
  description:
    "Stand up a desktop fleet ON a plan in ONE call: ensure the named fleet (you become its leader), then open N visible member terminals each running a scripted psu launch on the plan. The members AUTO-START working the plan on boot (no manual kickoff wake). Author + start the plan first (plans:apply-plan-block / plans:start); this tool launches the workers. Linux + macOS only.",
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
  }),
  async handler(args, ctx) {
    const { identity, ownerId, workspaceId: callerWs } = resolveFleetCaller(ctx);
    const workspaceId = callerWs && callerWs !== '*' ? callerWs : activeWorkspaceId();
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

    const command = memberLaunchCommand({ fleetSlug, agent, harness, plan: args.plan });
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

    const lines: string[] = [];
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
        requested: count,
        opened,
        failed,
        message: lines.join('\n'),
      },
      opened.length === 0,
    );
  },
});
