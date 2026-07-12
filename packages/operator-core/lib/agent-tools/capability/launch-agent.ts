/**
 * capability:launch-agent — THE agent-launch primitive: start agents ad-hoc (on a
 * free-form brief), RESUME a dead one mid-thread, or FORK a live one — into visible
 * desktop windows or headless, in a fleet or not, one or many.
 * (agent-launch-resume-primitives-2026-07-12, D-001/D-002/D-003.)
 *
 * It is the flexible superset of `fleet:launch-on-plan`: that tool stays as the
 * ergonomic "spin up N members on a plan" door, but a launch no longer REQUIRES a
 * plan, a fleet, or a leader. Both doors sit on one shared core
 * (`agent-launch-core.ts`) — the psu-command injectors, the resume/fork resolver,
 * and the launch idempotency guard — so there is no forked spawn path.
 *
 * The modes compose: (ad-hoc | resumed | forked) × (fleet | no-fleet) ×
 * (visible | headless) × 1..N.
 *
 * Two mechanisms are worth knowing, because they are what make a launched agent
 * actually WORK rather than sit at an idle prompt:
 *
 *  1. THE FIRST TURN. `brief` rides the spawn-safe `PAPERCUSP_KICKOFF_PROMPT` env
 *     (never a `--kickoff=` value — a free-form text inside a console greeting
 *     one-liner gets double-quoted and breaks the shell). A FRESH launch seeds it as
 *     the CLI's positional prompt; a RESUME/FORK has no such seam, so psu's
 *     managed-pty host injects it as a turn once the child settles at its prompt
 *     (D-008 — a resumed session's presence rows were reaped when it died, so
 *     roster-gated coord:wake/coord:send answer `unknown_recipient`: the pty is the
 *     ONLY way in).
 *
 *  2. RESUME vs FORK. An in-place resume re-attaches the ORIGINAL coord identity;
 *     resuming a session whose CLI is still running would open a second CLI against
 *     one transcript (WI-3882), so a LIVE source is auto-forked instead (D-007) —
 *     a fork mints a fresh identity and leaves the original untouched.
 */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless } from '../../console-spawn';
import { activeWorkspaceId } from '../../workspace-registry';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { fleetSlugFromName, getFleetScheme } from '../../agent-fleets-store';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  buildAgentLaunchCommand,
  claimAgentLaunch,
  injectFleetArg,
  injectLaunchedByArg,
  recordAgentLaunchResult,
  resolveResumeTarget,
} from '../../agent-launch-core';
import type { ColorScheme } from '../../console-color-schemes';

/** Launching more than this many agents in one call is almost certainly a mistake
 *  (and is heavy — each is a real CLI process). Mirrors capability:terminal's cap. */
const MAX_AGENTS = 12;

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function resolveOperatorBaseUrl(): string {
  const fromEnv = process.env.PAPERCUSP_OPERATOR_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  const port = process.env.PAPERCUSP_HONO_PORT?.trim() || '3070';
  return `http://localhost:${port}`;
}

export default defineTool({
  name: 'capability:launch-agent',
  description:
    'Launch agents: start one ad-hoc on a free-form `brief`, RESUME a dead agent mid-thread (`resume: { agentId }`), or FORK a live one — visible on the desktop or headless, in a fleet or not, one or many. The flexible superset of fleet:launch-on-plan (which stays the ergonomic one-call door for N members on a plan). The brief becomes the agent\'s FIRST TURN, so it starts working immediately instead of parking idle.',
  guidance: {
    when: 'You want another agent working: an ad-hoc task (`brief`), a plan (`plan`), a dead agent brought back mid-thread with its context intact (`resume: { agentId: "su-…" }`), or a branch off a live one (`fork: true`). `fleet` is optional — a non-leader can launch a plain unfleeted agent.',
    notWhen:
      'To run a COMMAND (dev server, build, REPL) rather than an agent: capability:terminal / capability:bash. For N members on a plan with fleet seats + capacity advice in one call, fleet:launch-on-plan is still the ergonomic door.',
    chaining:
      'Returns once spawned; does NOT wait. `resume: { agentId }` resolves that agent\'s latest session (no uuid hunting); a LIVE source is auto-FORKED (two CLIs on one transcript collide), minting a NEW identity — find it in coord:presence. Pass `idempotencyKey` if a retry might re-fire the call (a replay reports deduped:true instead of opening a second set of windows). EI-9748: a `:3170` restart reaps HEADLESS children.',
    seeAlso: [
      'fleet:launch-on-plan (N members on a plan, with seats + capacity advice)',
      'capability:terminal (run a COMMAND in a visible terminal, not an agent)',
      'coord:presence (a launched/forked agent\'s identity + liveness)',
    ],
  },
  capability: 'capability:terminal',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    brief: z
      .string()
      .min(1)
      .max(8000)
      .optional()
      .describe(
        "The agent's FIRST TURN — a free-form task/brief it starts working immediately (no plan required). Also allowed with `resume`/`fork`, where it becomes the resumed session's next turn (\"here's what changed, carry on\"). Omit for a launch that should open idle.",
      ),
    plan: z
      .string()
      .max(120)
      .optional()
      .describe('Plan slug to bind the agent to — it launches on the plan and auto-kicks-off against it (the fleet:launch-on-plan behavior, without needing a fleet).'),
    resume: z
      .object({
        agentId: z
          .string()
          .max(120)
          .optional()
          .describe("The agent's coord id (e.g. 'su-a1a71' — a prefix is fine). Resolves its MOST-RECENT session automatically."),
        sessionId: z
          .string()
          .max(200)
          .optional()
          .describe('An exact native CLI session uuid, when you want to pin one specific session rather than the agent\'s latest.'),
      })
      .optional()
      .describe('Resume an existing session mid-thread — its full context comes back. Pass EITHER agentId (usual) or sessionId (exact pin).'),
    fork: z
      .boolean()
      .optional()
      .describe('Branch off the resumed session instead of continuing it in place: the fork gets a FRESH identity + its own transcript, and the original is untouched. Forced automatically when the source session is still LIVE (a second CLI on one transcript collides — WI-3882).'),
    agent: z
      .enum(['claude', 'codex', 'omp'])
      .optional()
      .describe('Which agent CLI backs a FRESH launch (default: the psu default). Ignored for resume/fork — a session resumes under the CLI it was recorded on.'),
    fleet: z
      .string()
      .max(120)
      .optional()
      .describe("Fleet name or slug to JOIN (membership + the fleet's bound window colour). Optional: omit it and you launch a plain unfleeted agent. Omitted entirely, the tool falls back to YOUR OWN presence-fleet, so a fleet member's launches join their fleet by default (WI-4234)."),
    headless: z
      .boolean()
      .optional()
      .describe('Launch with no window (logs to a file under the workspace fleet-logs dir) instead of a visible desktop terminal. Default false = visible. Headless sessions stay injectable (managed pty), but note EI-9748: a `:3170` restart reaps them.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_AGENTS)
      .optional()
      .describe(`How many agents to launch with this brief/plan (default 1, max ${MAX_AGENTS}). Not allowed with an in-place resume — one session cannot be resumed N times (fork it instead).`),
    cwd: z.string().max(500).optional().describe('Working dir for a FRESH launch (absolute, or relative to the harness project dir). A resume always lands in the session\'s own recorded cwd.'),
    label: z.string().max(120).optional().describe('Display label (shown in /adv/sessions + the window title).'),
    display: z
      .string()
      .max(40)
      .optional()
      .describe("WI-4272 (demo/recording): open the window(s) on this X display (e.g. ':110') instead of the owner's desktop seat. Linux + visible only."),
    account: z
      .string()
      .max(120)
      .optional()
      .describe("Account routing: 'default' (the system login), 'auto' (gateway-routed), or a pool account id. Defaults to 'default' ('auto' on macOS, where a per-session config dir cannot reach the Keychain login). Always pinned — a scripted launch must never block on the interactive account picker."),
    model: z.string().max(80).optional().describe('Model override for the launched agent (e.g. an opus/sonnet spec).'),
    extraArgs: z
      .array(z.string().max(200))
      .max(20)
      .optional()
      .describe("Extra psu flags passed through verbatim (e.g. ['--brain', '--context-size=trimmed']) — the capability:terminal pass-through model, so a NEW psu flag needs no tool change. Shell metacharacters are refused."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Dedupe key for retries: pass the SAME key when re-firing a call that may have already landed — a replay reports deduped:true (with what the original launched) instead of opening a SECOND set of agent windows.'),
  }),
  async handler(args, ctx) {
    const isResume = !!(args.resume?.agentId || args.resume?.sessionId);
    if (!isResume && args.fork) {
      return err('`fork: true` needs a source session — pass `resume: { agentId }` (or `sessionId`) to fork from.');
    }
    if (isResume && args.plan) {
      return err('`plan` is for a FRESH launch. A resumed session keeps its own context — put any new direction in `brief`, which becomes its next turn.');
    }
    const count = args.count ?? 1;
    if (isResume && count > 1 && !args.fork) {
      return err(
        'A session cannot be resumed more than once (a second CLI on one transcript collides). Use `fork: true` with `count` to branch N agents off it, or launch fresh agents with a `brief`.',
      );
    }
    if (!isResume && !args.brief && !args.plan) {
      return err('Give the agent something to do: a `brief` (free-form first turn) or a `plan` slug — otherwise it launches and sits idle.');
    }

    const workspaceId = ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    const slug = ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null;

    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      callerOwnerId = null;
    }

    // P-014: claim the launch BEFORE spawning anything — a replay must not open a
    // second set of windows. (No key ⇒ unguarded, exactly like cup:spawn.)
    const claim = await claimAgentLaunch({
      workspaceId,
      idempotencyKey: args.idempotencyKey,
      launchedBy: callerOwnerId,
    });
    if (!claim.won) {
      const prior = claim.priorSummary && Object.keys(claim.priorSummary).length ? claim.priorSummary : null;
      const when = claim.priorLaunchedAt ? new Date(claim.priorLaunchedAt).toISOString() : 'earlier';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Already launched (deduped) — idempotencyKey ${JSON.stringify(args.idempotencyKey)} was claimed at ${when}` +
              `${claim.priorLaunchedBy ? ` by ${claim.priorLaunchedBy}` : ''}. Nothing new was spawned.\n` +
              (prior ? `That call reported: ${JSON.stringify(prior)}` : 'No summary was recorded for that call — check /adv/sessions for what it opened.'),
          },
        ],
      };
    }

    // Resolve the resume/fork target: an agent id (usual) or an exact session uuid.
    // D-007: a LIVE source must be FORKED, never resumed in place.
    let resumeSessionId: string | null = null;
    let resumeOwnerId: string | null = null;
    let fork = !!args.fork;
    const notes: string[] = [];
    if (isResume) {
      const target = await resolveResumeTarget({
        agentId: args.resume?.agentId ?? null,
        sessionId: args.resume?.sessionId ?? null,
      });
      if (!target.ok) return err(`Cannot resume: ${target.detail}`);
      resumeSessionId = target.sessionId;
      resumeOwnerId = target.ownerId;
      if (target.live && !fork) {
        fork = true;
        notes.push(
          `⚠ ${target.ownerId ?? 'that session'} is still LIVE — resuming it in place would open a second CLI against one transcript (WI-3882), so it was FORKED instead. The fork has a FRESH identity; the original keeps running untouched.`,
        );
      }
      notes.push(
        fork
          ? `Forking session ${target.sessionId} (${target.agent ?? 'agent'}, last seen ${target.endedAt ?? 'live'}) — the fork mints a NEW coord id; find it in coord:presence.`
          : `Resuming session ${target.sessionId} (${target.agent ?? 'agent'}, ended ${target.endedAt ?? 'unknown'}) — it re-attaches its ORIGINAL identity ${target.ownerId ?? '(unknown)'}.`,
      );
    }

    // Fleet: explicit name wins; else the caller's own presence fleet (WI-4234), so a
    // fleet member's launches join their fleet by default. Colour + membership come
    // from the SAME slug, so they can never diverge.
    let fleetSlug: string | null = args.fleet ? fleetSlugFromName(args.fleet) : null;
    let scheme: ColorScheme | null = null;
    if (fleetSlug) {
      try {
        scheme = await getFleetScheme(workspaceId, fleetSlug);
      } catch {
        scheme = null;
      }
    } else if (callerOwnerId) {
      try {
        const membership = (await fetchPresenceFleet([callerOwnerId])).get(callerOwnerId);
        if (membership?.fleetSlug) {
          fleetSlug = membership.fleetSlug;
          scheme = await getFleetScheme(workspaceId, membership.fleetSlug);
        }
      } catch {
        scheme = null;
      }
    }

    let command: string;
    try {
      command = buildAgentLaunchCommand({
        mode: isResume ? (fork ? 'fork' : 'resume') : 'fresh',
        sessionId: resumeSessionId,
        agent: args.agent ?? null,
        plan: args.plan ?? null,
        harness: args.plan ? slug : null,
        account: args.account ?? null,
        model: args.model ?? null,
        headless: !!args.headless,
        extraArgs: args.extraArgs ?? null,
      });
    } catch (e) {
      return err(`Cannot build the launch command: ${(e as Error)?.message ?? e}`);
    }
    // The same injectors capability:terminal uses — fleet membership + who launched me.
    command = injectFleetArg(command, fleetSlug).command;
    command = injectLaunchedByArg(command, callerOwnerId).command;

    let base;
    try {
      base = await buildConsoleEnvelope({
        workspaceId,
        slug,
        operatorBaseUrl: resolveOperatorBaseUrl(),
        // A launched AGENT is an MCP-connected console (unlike capability:terminal,
        // which just runs a command) — it needs the superuser .mcp.json.
        skipMcpJson: false,
      });
    } catch (e) {
      return err(`Failed to prepare the launch: ${(e as Error)?.message ?? e}`);
    }

    const cwd = args.cwd
      ? isAbsolute(args.cwd)
        ? args.cwd
        : resolvePath(base.cwd, args.cwd)
      : base.cwd;
    // The brief rides the ENV, never a --kickoff= value: a free-form text inside the
    // console greeting one-liner gets double-single-quoted and breaks the shell (the
    // gnome-terminal exit-2 the docs-agent hit). psu reads it for BOTH paths — the
    // fresh CLI positional prompt, and the pty-injected first turn of a resume/fork.
    const env = args.brief ? { ...base.env, PAPERCUSP_KICKOFF_PROMPT: args.brief } : base.env;
    const label =
      args.label ??
      (isResume
        ? `${fork ? 'fork' : 'resume'} · ${args.resume?.agentId ?? resumeSessionId ?? 'agent'}`
        : `agent · ${args.plan ?? (args.brief ?? '').slice(0, 40)}`);
    const headlessLogDir = args.headless ? join(papercuspPathForWorkspace(workspaceId), 'fleet-logs') : null;

    const results = await Promise.all(
      Array.from({ length: count }, (_v, i) =>
        args.headless
          ? spawnHeadless({
              envelope: { ...base, env, greetingCmd: command, cwd },
              label: count > 1 ? `${label} (${i + 1}/${count})` : label,
              logDir: headlessLogDir,
            })
          : spawnConsole({
              envelope: { ...base, env, greetingCmd: command, cwd },
              label: count > 1 ? `${label} (${i + 1}/${count})` : label,
              writeMcpJson: false,
              scheme,
              allowDesktopBridge: true,
              displayOverride: args.display,
            }),
      ),
    );

    const opened = results.filter((r) => r.status === 'ok');
    const failed = results.filter((r) => r.status !== 'ok');

    const lines: string[] = [];
    if (opened.length) {
      const how = args.headless ? 'headless' : 'visible';
      const fleetNote = fleetSlug ? ` in fleet ${fleetSlug}${scheme ? ` (${scheme.name})` : ''}` : ' (no fleet)';
      lines.push(`Launched ${opened.length} ${how} agent${opened.length > 1 ? 's' : ''}${fleetNote}:`);
      lines.push(`  ${command}`);
      for (const o of opened) {
        if (o.status !== 'ok') continue;
        lines.push(
          `  • ${o.terminal} (pid ${o.pid ?? '?'}) in ${cwd}${o.display ? ` [DISPLAY=${o.display}]` : ''}`,
        );
      }
      if (args.brief) {
        lines.push(
          isResume
            ? '  ↪ the brief is delivered as the resumed session\'s next turn (psu\'s managed pty injects it once the agent reaches its prompt).'
            : '  ↪ the brief is the agent\'s first turn — it starts working on boot, it does not park idle.',
        );
      } else {
        lines.push('  ⚠ no `brief` — the agent opens IDLE. It will not do anything until someone gives it a turn.');
      }
      if (args.headless) {
        lines.push(
          `  ⓘ headless logs: ${headlessLogDir}. EI-9748: a \`:3170\` restart reaps headless children — prefer a visible launch for long-lived work on the dev box.`,
        );
      }
    }
    for (const n of notes) lines.push(n);
    for (const f of failed) {
      if (f.status === 'ok') continue;
      lines.push(`✗ launch failed (${f.code}): ${f.error}`);
    }

    await recordAgentLaunchResult({
      workspaceId,
      idempotencyKey: args.idempotencyKey,
      summary: {
        opened: opened.length,
        failed: failed.length,
        command,
        fleet: fleetSlug,
        mode: isResume ? (fork ? 'fork' : 'resume') : 'fresh',
        resumedOwnerId: resumeOwnerId,
      },
    });

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      ...(opened.length === 0 ? { isError: true as const } : {}),
    };
  },
});
