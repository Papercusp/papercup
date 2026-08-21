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
import { statSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless } from '../../console-spawn';
import { activeWorkspaceId } from '../../workspace-registry';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { fleetSlugFromName, getFleetScheme } from '../../agent-fleets-store';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { fetchContextPressure } from '../coordination/context-pressure';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveGoalLaunch } from '../../goal-launch-settings';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import { listFacts } from '../../agent-facts/store';
import { getModes } from '../../modes/store';
import { modeInstructionsFactKey } from '../mode/set';
import {
  buildAgentLaunchCommand,
  claimAgentLaunch,
  foldMemberSpec,
  injectFleetArg,
  injectLaunchedByArg,
  memberSpecSchema,
  recordAgentLaunchResult,
  resolveResumeTarget,
  verifyFreshLaunchStarted,
  verifyResumeStarted,
  type FleetMemberDefaults,
  type FreshLaunchVerdict,
  type LaunchMode,
  type MemberSpec,
  resolveLaunchMode,
} from '../../agent-launch-core';
// WI-37920 / P-002: check the backend in the env the WINDOW gets, not ours.
import { preflightBackendLaunch } from '../../backend-bin-resolve.mjs';
import { describeSessionEndTime } from '../../adv-sessions';
import type { ColorScheme } from '../../console-color-schemes';

/** Launching more than this many agents in one call is almost certainly a mistake
 *  (and is heavy — each is a real CLI process). Mirrors capability:terminal's cap. */
const MAX_AGENTS = 12;

/** How long to wait for a resumed session's live psu-pty host to appear before
 *  declaring the resume UNVERIFIED (EI-11524). A healthy resume registers its host
 *  within a few seconds (verifyResumeStarted returns early), so only a silent
 *  no-op pays this full window — comfortably under the ~55s MCP foreground cap. */
const RESUME_VERIFY_TIMEOUT_MS = 30_000;

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// WI-6154: this-host identity (PAPERCUSP_HONO_PORT) must win over an inherited
// PAPERCUSP_OPERATOR_URL — see resolveSpawnHostOperatorBaseUrl's doc for why.
const resolveOperatorBaseUrl = resolveSpawnHostOperatorBaseUrl;

/** Read the launching session's durable DRAIN overlay once per call. A mode or
 * fact read outage must not strand an otherwise valid ad-hoc launch. */
async function readCallerLaunchMode(workspaceId: string, ownerId: string | null): Promise<LaunchMode | null> {
  if (!ownerId) return null;
  try {
    const modeRows = await getModes(workspaceId, ownerId);
    if (!modeRows.some((row) => row.mode === 'drain')) return null;
    const facts = await listFacts(
      { scope: 'owner', scopeRef: ownerId },
      { workspaceId, limit: 50 },
    );
    const instructions = facts.find((fact) => fact.key === modeInstructionsFactKey('drain'));
    return resolveLaunchMode({ modeRows, instructionsFact: instructions?.body });
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'capability:launch-agent',
  description:
    'Launch agents: start one ad-hoc on a free-form `brief`, RESUME a dead agent mid-thread (`resume: { agentId }`), or FORK a live one — visible on the desktop or headless, in a fleet or not, one or many. The flexible superset of fleet:launch-on-plan (which stays the ergonomic one-call door for N members on a plan). The brief becomes the agent\'s FIRST TURN, so it starts working immediately instead of parking idle.',
  guidance: {
    when: 'GENERAL AGENT-LAUNCH DOOR: launch, resume, or fork one or many agents — visible or headless, fleet or unfleeted. Use fleet:launch-on-plan instead only for the ergonomic “N agents on this plan” workflow.',
    notWhen:
      'To run a COMMAND (dev server, build, REPL): capability:terminal / capability:bash. For N members on a plan: fleet:launch-on-plan. Doors: /internal/docs/agent-insights/launching-agents-which-tool-for-which-door.',
    chaining:
      'A fresh/fork/headless launch returns once spawned; an in-place resume also VERIFIES a live agent registered (EI-11524) — isError + a loud "RESUME UNVERIFIED" note if the window opened but no agent booted (archived transcript / no-op), so a resume never reports phantom success. `resume: { agentId }` resolves that agent\'s latest session; a LIVE source is auto-FORKED (two CLIs on one transcript collide), minting a NEW identity — find it in coord:presence. Pass `idempotencyKey` if a retry might re-fire the call (a replay reports deduped:true instead of opening a second set of windows). EI-9748: a `:3170` restart reaps HEADLESS children.',
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
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness slug to bootstrap for an operator-scope launch. Required when the caller context is wildcard/unset; otherwise the caller harness is used.'),
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
      .describe(`How many agents to launch with this brief/plan (default 1 — or the length of \`members\` when that is given; max ${MAX_AGENTS}). Not allowed with an in-place resume — one session cannot be resumed N times (fork it instead).`),
    members: z
      .array(memberSpecSchema)
      .max(MAX_AGENTS)
      .optional()
      .describe(
        'DECLARATIVE per-member config for a FRESH multi-launch, index-aligned to agent number (entry 0 → agent 1, …). Each set field OVERRIDES the flat top-level arg (model/effort/account/model/context/limit/role/brief/…) for THAT agent only; an unset field falls through to the top-level arg, then the system default. Fewer entries than `count` ⇒ the rest use the flat args, never an error. `count` defaults to `members.length` when omitted. Not for resume/fork (a single session). `carry`/`claimKinds` need a self-pulling fleet — use fleet:launch-on-plan for those.',
      ),
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
      .describe("Account routing: 'default' (the system login), 'auto' (gateway-routed), or a pool account id. Defaults to 'default' on every platform; the gateway is never selected implicitly. Always resolved — a scripted launch must never block on the interactive account picker."),
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
    // P-002: `members` is a FRESH per-member spec array — one session can't be
    // resumed N different ways, so it never rides a resume/fork.
    if (isResume && args.members?.length) {
      return err('`members` configures a FRESH per-member multi-launch; a resume/fork is a single session — put any new direction in `brief`.');
    }
    // `count` defaults to the number of member specs when omitted, so `members: [a,b,c]`
    // opens 3 without a redundant `count: 3`.
    const count = args.count ?? (args.members?.length || 1);
    if (args.members && args.members.length > count) {
      return err(
        `You passed ${args.members.length} member specs but count is ${count}. Raise count (or omit it — it defaults to the number of member specs) so every spec maps to an agent, or trim members.`,
      );
    }
    if (isResume && count > 1 && !args.fork) {
      return err(
        'A session cannot be resumed more than once (a second CLI on one transcript collides). Use `fork: true` with `count` to branch N agents off it, or launch fresh agents with a `brief`.',
      );
    }
    const anyMemberBrief = (args.members ?? []).some((m) => m?.brief?.trim());
    if (!isResume && !args.brief && !args.plan && !anyMemberBrief) {
      return err('Give the agent something to do: a `brief` (free-form first turn), a per-member `members[i].brief`, or a `plan` slug — otherwise it launches and sits idle.');
    }

    const workspaceId = ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    // Operator/HTTP bridge calls can arrive with a wildcard or unset harness context. An explicit
    // harness keeps those launches on the su bootstrap path; without it, buildAgentLaunchCommand
    // omits --harness and a fresh psu falls into plain-CLI onboarding before it can receive its brief.
    const slug = args.harness?.trim() || (ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null);

    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      callerOwnerId = null;
    }
    // DRAIN is a durable caller overlay. Resolve it before composing either a
    // fresh command or a resume/fork command so every capability launch path
    // carries the same mode into bootstrap-su.
    const launchMode = await readCallerLaunchMode(workspaceId, callerOwnerId);

    // P-014: claim the launch BEFORE spawning anything — a replay must not open a
    // second set of windows. (No key ⇒ unguarded, exactly like cup:spawn.)
    const claim = await claimAgentLaunch({
      workspaceId,
      idempotencyKey: args.idempotencyKey,
      launchedBy: callerOwnerId,
    });
    if (!claim.won) {
      const prior = claim.priorSummary && Object.keys(claim.priorSummary).length ? claim.priorSummary : null;
      const priorLaunch = prior && typeof prior.launch === 'object' && prior.launch !== null
        ? prior.launch as Record<string, unknown>
        : prior;
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
        data: {
          deduped: true,
          launch: priorLaunch
            ? { ...priorLaunch, deduped: true }
            : { deduped: true, opened: 0, failed: 0, mode: 'deduped', fleet: null, tasks: [] },
        },
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
      // P-015: `endedAt` is an END TIME only when the session reported its own exit.
      // Otherwise a sweeper stamped it on noticing the process was already gone, so
      // stating it as "ended <ts>" asserts something we do not know (WI-7126).
      const endedPhrase = describeSessionEndTime(target);
      notes.push(
        fork
          ? `Forking session ${target.sessionId} (${target.agent ?? 'agent'}, ${target.live ? 'live' : endedPhrase}) — the fork mints a NEW coord id; find it in coord:presence.`
          : `Resuming session ${target.sessionId} (${target.agent ?? 'agent'}, ${endedPhrase}) — it re-attaches its ORIGINAL identity ${target.ownerId ?? '(unknown)'}.`,
      );

      // EI-21007744826020808: a live source at the context cliff can technically
      // fork/resume, accept the kickoff injection, and then die before it can take
      // the turn. Kickoff delivery is transport evidence, not usable-context
      // evidence. Reuse the same fresh/staleness-aware pressure oracle the fleet
      // roster uses; a stale/unknown reading fails open, while a current CRITICAL
      // reading fails closed before we open a doomed process.
      if (target.ownerId) {
        try {
          const pressure = (await fetchContextPressure([target.ownerId])).get(target.ownerId);
          if (pressure === 'critical') {
            return err(
              `Cannot ${fork ? 'fork' : 'resume'} ${target.ownerId}: its current context is CRITICAL ` +
                '(at or above 90% of its compaction limit). The resumed transcript may boot but cannot ' +
                'reliably take another turn. Compact/recover that source first, or launch a FRESH agent ' +
                'with a context-seeded brief.',
            );
          }
          if (pressure === 'high') {
            notes.push(
              `⚠ ${target.ownerId} is already at HIGH context pressure (≥80%); the ${fork ? 'fork' : 'resume'} may need to compact before doing useful work.`,
            );
          }
        } catch (e) {
          notes.push(
            `resume-context preflight unavailable (${(e as Error)?.message ?? e}) — proceeding without a context verdict`,
          );
        }
      }
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

    // ── Per-member launch composition (P-002) ──────────────────────────────────
    // A FRESH multi-launch folds `members[i]` over the flat top-level args, so agent i
    // can differ in model/effort/account/limit/role/context/brief/…; a shorter (or
    // absent) `members` falls each remaining agent back to the flat args — the common
    // case is one identical command for all `count`. A resume/fork is a single session,
    // so `members` never applies (rejected above): every clone shares one command.
    // ── Per-goal launch settings + ceilings (P-004/D-009) ─────────────────────
    // Resolved from the CALLER, not from an argument: if this agent is working
    // under a goal (running it, or having inherited it — D-008), its spawns
    // belong to that goal and are bound by the goal's ceilings. `count` is passed
    // whole so an over-large batch is refused once here rather than part-way
    // through, leaving half a fleet running against a breached ceiling.
    const goalLaunch = await resolveGoalLaunch({
      workspaceId,
      launcherOwnerId: callerOwnerId ?? '',
      // No slot at the BATCH level — this tool has no top-level launch slot, and
      // the ceilings do not depend on one (D-016).
      goalRole: null,
      fleetSlug,
      count,
      requested: {
        ...(args.agent ? { agent: args.agent as 'claude' | 'codex' | 'omp' } : {}),
        ...(args.account ? { account: args.account } : {}),
        ...(args.model ? { model: args.model } : {}),
      },
    });
    if (goalLaunch.refusal) return err(goalLaunch.refusal.message);

    const memberSpecs: (MemberSpec | undefined)[] = args.members ?? [];
    const flatBase: FleetMemberDefaults = {
      // The goal's effective profile is the BASE; an explicit per-member spec
      // still wins via foldMemberSpec below, which is the intended order —
      // settings are the goal's standing policy, not an override of a choice the
      // caller just made for one member.
      agent: goalLaunch.effective.agent ?? args.agent ?? 'claude',
      account: goalLaunch.effective.account ?? args.account ?? undefined,
      model: goalLaunch.effective.model ?? args.model ?? undefined,
      effort: goalLaunch.effective.effort ?? undefined,
      contextSize: goalLaunch.effective.contextSize ?? undefined,
      headless: args.headless || undefined,
      extraArgs: args.extraArgs ?? undefined,
    };
    const foldedConfigs: FleetMemberDefaults[] = Array.from({ length: count }, (_v, i) => {
      if (isResume) return flatBase;
      // D-016 (WI-38048): this used to fold `settings.roles[memberSpecs[i].role]`
      // — i.e. it looked the goal's launch profiles up by psu `--role`. That is
      // the defect, not a feature that was lost here: a launch SLOT is a function
      // (plan-fleet-member, grading, …) while `--role` is a persona, and persona
      // is `su` for ~all sessions, so the lookup matched nothing while making the
      // panel read as configured. This generic door is handed psu roles and no
      // slot, so it folds NO role layer — absent beats wrong.
      //
      // Slot binding is not lost, it moved to the door that KNOWS its slot:
      // fleet_registry/launch-on-plan resolves with `goalRole:'plan-fleet-member'`
      // and passes the folded profile down as fleetDefaults, and goals/start
      // resolves with `goalRole:'goal'`. If a caller ever needs per-member slot
      // pinning here, add an explicit `goalRole` to MemberSpec — do NOT reinstate
      // the `--role` lookup.
      return foldMemberSpec(flatBase, memberSpecs[i]);
    });
    // ── P-002: preflight the backend in the env the WINDOW will receive ───────
    //
    // Not the operator's env — that is the whole trap. A probe run from here
    // (process.env.PATH, a `which`, a capability:bash call) inherits the
    // OPERATOR's environment, which is precisely the environment that does NOT
    // have the defect; it reports green while the window dies. preflightBackendLaunch
    // searches ONLY the dirs we inject, so a pass means the window works no matter
    // what PATH it inherits, and a fail aborts HERE with a diagnosis instead of
    // opening a doomed terminal that reports "Launched".
    //
    // Fresh launches only: a resume/fork runs under the CLI its session was
    // recorded on, which this call does not choose.
    if (!isResume) {
      const preflighted = new Set<string>();
      for (const folded of foldedConfigs) {
        const agentName = folded.agent ?? 'claude';
        if (preflighted.has(agentName)) continue;
        preflighted.add(agentName);
        const pre = preflightBackendLaunch(agentName, base.env);
        if (!pre.ok) return err(pre.diagnosis);
      }
    }

    // EI-20362893066852316: capability:launch-agent is the flexible sibling of
    // fleet:launch-on-plan, so it must protect ad-hoc Codex launches with the
    // same model preflight. Run it before constructing/spawning any terminal;
    // only a definitive backend model refusal blocks, while auth, capacity,
    // transport, and unknown responses remain fail-open diagnostics.
    if (!isResume && foldedConfigs.some((folded) => folded.agent === 'codex' && folded.model?.trim())) {
      try {
        const [{ parseBridgeModel }, { preflightCodexModel, resolveCodexPreflightHome }] = await Promise.all([
          import('../../inference-gateway/codex-cli-bridge'),
          import('../../inference-gateway/codex-oauth-proxy'),
        ]);
        const preflighted = new Set<string>();
        for (const folded of foldedConfigs) {
          if (folded.agent !== 'codex' || !folded.model?.trim()) continue;
          const account = folded.account?.trim() || undefined;
          const key = `${account ?? 'default'}\u0000${folded.model.trim()}`;
          if (preflighted.has(key)) continue;
          preflighted.add(key);
          const home = await resolveCodexPreflightHome(account, workspaceId);
          if (!home) continue;
          const bareModel = parseBridgeModel(folded.model).id;
          const pf = await preflightCodexModel(home, bareModel);
          if (pf.verdict === 'refused') {
            return err(
              `Codex model preflight REFUSED '${bareModel}' on account '${account ?? 'default'}' — the ChatGPT backend answered: ${pf.detail} ` +
                `NO terminals were opened (a launch on this model would fail every turn). Working ids on this subscription are family-suffixed ` +
                `(e.g. gpt-5.6-sol, gpt-5.6-terra); verify one with a 1-turn probe: codex exec -m <id> 'Reply OK'.`,
            );
          }
          if (pf.verdict === 'unknown') {
            notes.push(`codex model preflight inconclusive (${pf.detail}) — proceeding fail-open`);
          }
        }
      } catch (e) {
        notes.push(`codex model preflight errored (${(e as Error).message}) — proceeding fail-open`);
      }
    }

    const memberCommands: string[] = [];
    for (let i = 0; i < count; i++) {
      const folded = foldedConfigs[i];
      let cmd: string;
      try {
        cmd = isResume
          ? buildAgentLaunchCommand({
              mode: fork ? 'fork' : 'resume',
              sessionId: resumeSessionId,
              account: args.account ?? null,
              model: args.model ?? null,
              headless: !!args.headless,
              launchMode,
              extraArgs: args.extraArgs ?? null,
            })
          : buildAgentLaunchCommand({
              mode: 'fresh',
              agent: folded.agent ?? null,
              plan: args.plan ?? null,
              // ALWAYS harness-scope a fresh launch, plan or not (caught by the P-016
              // live-verify): `--harness` is what makes psu bootstrap a papercusp-su
              // collaborator. Without it psu boots a PLAIN claude, skips the su bootstrap,
              // runs its first-run onboarding, never reaches a prompt, and the brief can
              // never be delivered — the agent is dead on arrival.
              harness: slug,
              account: folded.account ?? null,
              model: folded.model ?? null,
              effort: folded.effort ?? null,
              headless: !!folded.headless,
              contextSize: folded.contextSize ?? null,
              compactionLimit: folded.compactionLimit ?? null,
              role: folded.role ?? null,
              feature: folded.feature ?? null,
              profile: folded.profile ?? null,
              brain: folded.brain,
              allowSubagents: folded.allowSubagents,
              addDir: folded.addDir ?? null,
              launchContext: folded.launchContext ?? null,
              launchMode,
              extraArgs: folded.extraArgs ?? null,
            });
      } catch (e) {
        return err(
          count > 1
            ? `Cannot build agent ${i + 1}'s launch command: ${(e as Error)?.message ?? e}`
            : `Cannot build the launch command: ${(e as Error)?.message ?? e}`,
        );
      }
      // The same injectors capability:terminal uses — fleet membership + who launched me.
      cmd = injectFleetArg(cmd, fleetSlug).command;
      cmd = injectLaunchedByArg(cmd, callerOwnerId).command;
      memberCommands.push(cmd);
    }
    // Back-compat: `command` (singular) is the representative reported/recorded command
    // — identical across members in the common no-`members` case.
    const command = memberCommands[0] ?? '';
    // `carry`/`claimKinds` need the fleet baseline + claim-spec machinery this general
    // door doesn't build — accept them for schema parity, but never honor them silently.
    if ((args.members ?? []).some((m) => m?.carry || m?.claimKinds?.length)) {
      notes.push(
        '⚠ `carry` / `claimKinds` on a member are only honored by fleet:launch-on-plan (they seed the member baseline + per-member claim spec); this general launch door opens raw agents, so those fields were IGNORED. Use fleet:launch-on-plan for a self-pulling fleet.',
      );
    }

    const label =
      args.label ??
      (isResume
        ? `${fork ? 'fork' : 'resume'} · ${args.resume?.agentId ?? resumeSessionId ?? 'agent'}`
        : `agent · ${args.plan ?? (args.brief ?? '').slice(0, 40)}`);
    const anyHeadless = foldedConfigs.some((f) => !!f.headless);
    const headlessLogDir = anyHeadless ? join(papercuspPathForWorkspace(workspaceId), 'fleet-logs') : null;

    // The brief rides the ENV, never a --kickoff= value: free-form text inside the
    // console greeting one-liner gets double-single-quoted and breaks the shell (the
    // gnome-terminal exit-2 the docs-agent hit). psu reads it for BOTH paths — the fresh
    // CLI positional prompt, and the pty-injected first turn of a resume/fork. A member's
    // own `brief` overrides the shared one for that agent's first turn.
    // P-003: the correlation floor for verifyFreshLaunchStarted — only sessions
    // that registered AFTER this instant can belong to this call.
    const spawnStartedAt = Date.now();
    const memberLabels = memberCommands.map((_, i) => (count > 1 ? `${label} (${i + 1}/${count})` : label));
    const results = await Promise.all(
      memberCommands.map((cmd, i) => {
        const memberBrief = (memberSpecs[i]?.brief?.trim() || args.brief) ?? undefined;
        const env = memberBrief ? { ...base.env, PAPERCUSP_KICKOFF_PROMPT: memberBrief } : base.env;
        const memberLabel = memberLabels[i];
        return foldedConfigs[i].headless
          ? spawnHeadless({
              envelope: { ...base, env, greetingCmd: cmd, cwd },
              label: memberLabel,
              logDir: headlessLogDir,
              launchedBy: callerOwnerId ?? undefined,
              fleetSlug,
            })
          : spawnConsole({
              envelope: { ...base, env, greetingCmd: cmd, cwd },
              label: memberLabel,
              writeMcpJson: false,
              scheme,
              allowDesktopBridge: true,
              displayOverride: memberSpecs[i]?.display ?? args.display,
              // EI-21010422711013687: the server-side gnome-terminal factory can
              // open the requested window but silently drop the `-- CMD`
              // handoff. That strands BOTH fresh launches (no psu child ever
              // exists) and resume/fork launches (EI-11578). Every visible agent
              // launch is command-bearing, so reliability outranks the owner's
              // normal client-server terminal preference here.
              preferProcessPerWindow: true,
            });
      }),
    );

    const opened = results.filter((r) => r.status === 'ok');
    const failed = results.filter((r) => r.status !== 'ok');

    // EI-11524: a clean terminal spawn is NOT proof the agent is running. An
    // in-place `psu --resume` whose transcript was archived off-disk (or whose
    // launcher searched the wrong projects dir) finds nothing, starts no process,
    // and the window closes seconds later — yet we previously reported SUCCESS.
    // Verify a live psu-pty host actually appears for the resumed identity (which
    // re-attaches its ORIGINAL ownerId) before calling the resume good; if none
    // does, say so LOUDLY and fail the tool. Scoped to a VISIBLE IN-PLACE resume:
    // a fork mints a new identity we can't poll here, and a headless session hosts
    // no window whose silent close is the symptom.
    let resumeVerifyFailed = false;
    if (isResume && !fork && !args.headless && resumeOwnerId && opened.length > 0) {
      const verify = await verifyResumeStarted(resumeOwnerId, { timeoutMs: RESUME_VERIFY_TIMEOUT_MS });
      if (!verify.started) {
        resumeVerifyFailed = true;
        notes.push(
          `✗ RESUME UNVERIFIED — a window opened but NO live agent registered for ${resumeOwnerId} within ` +
            `${Math.round(RESUME_VERIFY_TIMEOUT_MS / 1000)}s, so the resume almost certainly NO-OP'd (its transcript may be ` +
            `archived off-disk, or \`claude --resume\` found nothing and the terminal exited). Do NOT assume it is running: ` +
            `check the terminal window; if it exited, rematerialize the archived transcript ` +
            `(POST /api/adv/sessions/rematerialize) or relaunch FRESH with a context-seeded brief.`,
        );
      }
    }

    // ── P-003: kill the false "Launched" for a FRESH/FORK launch ─────────────
    //
    // A clean spawn is not proof an agent is running — the 4th recurrence of this
    // class (EI-11543, WI-4752, EI-18696184925888288, and the measured acceptance
    // case adv_session 14842, which registered a row, fired its two launch
    // statusline calls, and then did nothing for the hour until the reaper closed
    // it, while the tool had already reported success).
    //
    // The verdict is THREE-state (D-004) and that is load-bearing: first real turn
    // is p50 ~31s, so a boolean at this timeout would report most HEALTHY launches
    // as failures. `null` says "still booting" honestly; only observed SILENCE is
    // reported as a failure, and only that sets isError.
    let freshVerdict: FreshLaunchVerdict | null = null;
    // A fork mints a fresh identity, so the same launched-by + spawn-time
    // correlation used for a fresh agent is authoritative for it too. An
    // in-place resume keeps its known owner id and uses verifyResumeStarted above.
    if ((!isResume || fork) && callerOwnerId && opened.length > 0) {
      // EI-20823593041668393: a slow headless first turn can stop making MCP
      // statusline calls while its CLI is plainly alive and rendering into the
      // durable log. Snapshot here, then let the verifier compare at the end of
      // its window before it turns ledger silence into a death verdict.
      const headlessLogSizes = new Map(
        opened.flatMap((result) => {
          if (result.status !== 'ok' || !result.logPath) return [];
          try { return [[result.logPath, statSync(result.logPath).size] as const]; } catch { return []; }
        }),
      );
      try {
        freshVerdict = await verifyFreshLaunchStarted(
          { workspaceId, launcherOwnerId: callerOwnerId, since: spawnStartedAt, expected: opened.length },
          {
            probeProcessEvidence: () => opened.flatMap((result) => {
              if (result.status !== 'ok' || result.pid == null || !result.logPath) return [];
              let pidAlive = false;
              let logGrowing = false;
              try { process.kill(result.pid, 0); pidAlive = true; } catch { pidAlive = false; }
              try { logGrowing = statSync(result.logPath).size > (headlessLogSizes.get(result.logPath) ?? 0); } catch { logGrowing = false; }
              return [{ pidAlive, logGrowing }];
            }),
          },
        );
        notes.push(freshVerdict.note);
      } catch (e) {
        // The instrument broke. Say THAT — never let a probe fault masquerade as
        // a launch failure (or, worse, as success).
        notes.push(
          `⏳ launch verification could not run (${(e as Error)?.message ?? e}) — the agents may be ` +
            `fine; this says nothing either way. Confirm with coord:presence.`,
        );
      }
    }

    const lines: string[] = [];
    if (opened.length) {
      const allHeadless = foldedConfigs.every((f) => !!f.headless);
      const how = allHeadless ? 'headless' : anyHeadless ? 'mixed (visible + headless)' : 'visible';
      const fleetNote = fleetSlug ? ` in fleet ${fleetSlug}${scheme ? ` (${scheme.name})` : ''}` : ' (no fleet)';
      lines.push(`Launched ${opened.length} ${how} agent${opened.length > 1 ? 's' : ''}${fleetNote}:`);
      // Per-member disclosure (P-002): when `members` made the composed commands differ,
      // show each one so the caller sees exactly what each agent got; otherwise the single
      // shared command.
      const distinctCommands = [...new Set(memberCommands)];
      if (distinctCommands.length <= 1) {
        lines.push(`  ${command}`);
      } else {
        lines.push('  per-member commands:');
        memberCommands.forEach((c, i) => lines.push(`    ${i + 1}. ${c}`));
      }
      for (const o of opened) {
        if (o.status !== 'ok') continue;
        lines.push(
          `  • ${o.terminal} (pid ${o.pid ?? '?'}) in ${cwd}${o.display ? ` [DISPLAY=${o.display}]` : ''}`,
        );
      }
      if (args.brief || anyMemberBrief) {
        lines.push(
          isResume
            ? '  ↪ the brief is QUEUED as the resumed session\'s next turn (psu\'s managed pty injects it once the agent reaches its prompt). Delivery alone is not proof the turn began; read the verification verdict below.'
            : '  ↪ the brief is the agent\'s first turn — it starts working on boot, it does not park idle.',
        );
      } else {
        lines.push('  ⚠ no `brief` — the agent opens IDLE. It will not do anything until someone gives it a turn.');
      }
      if (anyHeadless) {
        lines.push(
          `  ⓘ headless logs: ${headlessLogDir}. EI-9748: a \`:3170\` restart reaps headless children — prefer a visible launch for long-lived work on the dev box.`,
        );
      }
    }
    for (const n of notes) lines.push(n);
    // `failed` is already narrowed to the error arm by the filter's inferred
    // type predicate (TS 5.5+), so no re-guard — one would be dead code (TS2367).
    for (const f of failed) {
      lines.push(`✗ launch failed (${f.code}): ${f.error}`);
    }

    const launchSummary = {
      deduped: false,
      opened: opened.length,
      failed: failed.length,
      command,
      fleet: fleetSlug,
      mode: isResume ? (fork ? 'fork' : 'resume') : 'fresh',
      resumedOwnerId: resumeOwnerId,
      tasks: results.flatMap((result, i) =>
        result.status === 'ok'
          ? [{
              taskId: result.taskId ?? null,
              logPath: result.logPath ?? null,
              pid: result.pid,
              label: memberLabels[i],
              headless: !!foldedConfigs[i].headless,
            }]
          : [],
      ),
      ...(resumeVerifyFailed ? { resumeVerified: false } : {}),
      ...(freshVerdict ? { agentStarted: freshVerdict.agentStarted } : {}),
    };

    await recordAgentLaunchResult({
      workspaceId,
      idempotencyKey: args.idempotencyKey,
      summary: launchSummary,
    });

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      data: { deduped: false, launch: launchSummary },
      // Only an OBSERVED failure is an error. `agentStarted === null` (unverified —
      // still booting) must NOT set isError: most healthy launches land there
      // inside this window (D-004), and flagging them would make the tool cry wolf
      // on its own success path.
      ...(opened.length === 0 || resumeVerifyFailed || freshVerdict?.agentStarted === false
        ? { isError: true as const }
        : {}),
    };
  },
});
