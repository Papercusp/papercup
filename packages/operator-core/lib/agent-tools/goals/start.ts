/**
 * goals:start — open a goal AND spawn the GOAL-mode agent that owns it, in one
 * call (goals-tab-improvement-2026-08-09 P-015, D-008).
 *
 * WHY THIS EXISTS AS ONE TOOL. The owner's "+ Start a goal" composer needs
 * three writes to land together: the goal row, a spawned agent, and the
 * `agent_modes` stamp that JOINS them. Done client-side that is three
 * independent calls with two failure gaps, and the gaps are not hypothetical —
 * the workspace this shipped into had TWO goals, ONE goal-mode session, and
 * ZERO rows joining any of them (EI-20015592992797890). A goal whose agent
 * never spawned is worse than no goal: it sits on the board as an outcome
 * somebody believes is being pursued.
 *
 * ORDER IS LOAD-BEARING — row, then mode, then spawn:
 *   1. INSERT the goal (cheap, rollback-able).
 *   2. Stamp `agent_modes` for the PRE-PINNED owner id (cheap, rollback-able).
 *   3. Spawn the agent (expensive, and the only irreversible step).
 * The stamp must precede the spawn because it is what the agent reads on its
 * very first orient; writing it afterwards is a race against the agent's own
 * boot, and losing that race yields a GOAL-mode session that does not know
 * which goal it owns. Pre-pinning the identity (`psu --owner-id=`) is what
 * makes writing-before-existing possible at all.
 *
 * If the spawn fails, both writes are compensated and the tool reports the
 * failure — never a goal with no agent.
 *
 * WHY NOT IN agent-mcp beside goals:create: the spawn needs operator-core's
 * console-launcher, and agent-mcp deliberately does not depend on
 * operator-core. The shared half (id minting + the row write) lives in
 * `@papercusp/agent-mcp/goals` so the two writers cannot drift.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { TripwireSchema, deleteGoalRow, goalId, insertGoalRow } from '@papercusp/agent-mcp/goals';
import { applyGoalBlockedBy, replaceGoalBlockedBy } from '@papercusp/agent-mcp/goal-deps';
import { killCriterionProblem } from '../../goals/kill-criterion';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless } from '../../console-spawn';
import { activeWorkspaceId } from '../../workspace-registry';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import { buildAgentLaunchCommand, injectFleetArg, injectLaunchedByArg } from '../../agent-launch-core';
import {
  drainFleetAutoMintEnabled,
  mintDrainFleetForGoal,
  teardownDrainFleetMint,
} from '../../goals/drain-fleet-mint';
import { resolveGoalLaunchForGoal } from '../../goal-launch-settings';
import { resolveAgentIdentity } from '../coordination/identity';
import { setMode } from '../../modes/store';

/**
 * The agent's FIRST TURN.
 *
 * Deliberately NOT a restatement of GOAL mode's contract — that arrives
 * through the mode itself (`coord:orient` re-injects an active mode's contract
 * every wake, and the contract already carries the mandatory kickoff question:
 * read the existing portfolio before creating anything). Repeating it here
 * would be a second copy to drift.
 *
 * What this brief carries is the part the contract CANNOT know: which goal,
 * stated in the owner's own words, with the two constraints GOAL mode requires
 * and this form is now the only place that enforces.
 *
 * EI-20185528589678586 — TWO THINGS THIS BRIEF MUST NOT ASSERT ABOUT ITSELF.
 * Measured 2026-08-11: this brief was delivered ~26h after it was written, into
 * a session that was not the goal's agent, for a goal that had reached
 * `achieved` in between. Both of its standing claims were false on arrival:
 *
 *  1. FRESHNESS. It used to open "which the owner just started". A brief cannot
 *     know when it will be read, so it no longer claims to — it STAMPS the
 *     moment it was written and lets the reader do the subtraction. Any replay
 *     is then self-evident from the text alone, with no dependency on the nonce
 *     ledger or on the reader happening to be suspicious.
 *  2. DELIVERY OF THE CONTRACT. It used to say the contract was "delivered with
 *     your orient" — a statement of fact whose falsity is invisible, because an
 *     agent holding no `overlay:goal` row simply sees no contract and has no cue
 *     that one is missing. The pointer is now FALSIFIABLE: it names where to
 *     look and what to do when it is not there. The comment above still holds —
 *     do NOT paste the contract in here; a second copy is a second copy to
 *     drift. Point at it, checkably.
 *
 * A STATUS line was considered and deliberately NOT added: this door always
 * CREATES the goal it briefs (`goalId(args.title)` below), so status is
 * invariably 'active' at generation time and the field would be decorative
 * here. The stale-status problem belongs to whatever re-delivers a brief later,
 * which is a different surface.
 */
export function buildGoalKickoffBrief(opts: {
  goalId: string;
  title: string;
  killCriterion?: string | null;
  budgetCents?: number | null;
  body?: string | null;
  /** Injectable for tests; defaults to the moment the brief is written. */
  writtenAt?: Date;
}): string {
  /* Both constraints are OPTIONAL at creation since 2026-08-09 (see the args
     schema). When one is absent the brief SAYS SO rather than omitting the
     line: a missing CEILING line reads to the agent as "no budget discipline
     was mentioned", whereas "none declared" plus the spend-visibility
     boundary keeps the discipline without inventing a number the owner
     never gave. Never render `$0.00` or an empty criterion here — a fabricated
     constraint is worse than an acknowledged absent one. */
  const kill = opts.killCriterion?.trim();
  const ceiling =
    opts.budgetCents == null
      ? null
      : `$${(opts.budgetCents / 100).toFixed(2)}`;
  const spendVisibility =
    'SPEND VISIBILITY — use `goals:pots { goalId }` for measured child-fleet spend. No reliable interactive-session attribution source is exposed; do not invent per-session actuals.';
  const writtenAt = (opts.writtenAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    `You are in GOAL mode on goal \`${opts.goalId}\`, started by the owner at ${writtenAt}`,
    '(the moment THIS brief was written — if that is not roughly now, it reached you late).',
    '',
    `OUTCOME — ${opts.title}`,
    opts.body?.trim() ? `\n${opts.body.trim()}\n` : '',
    kill
      ? `KILL THIS IF — ${kill}`
      : 'KILL THIS IF — none declared. Propose a stopping condition in your kickoff question.',
    ceiling
      ? `CEILING — ${ceiling} declared. Do not quietly exceed it.`
      : 'CEILING — none declared. Flag before any large spend.',
    spendVisibility,
    '',
    'Your mode contract governs how to run this, including the mandatory kickoff question.',
    'It arrives in your orient, under `modes[].contract`. If it is NOT there you are not',
    'holding GOAL mode — STOP: run `mode:get { contracts: true }` and `goals:get`, and do',
    'not act on this brief until you hold the contract. A brief can reach the wrong session,',
    'or reach the right one long after the goal it names has moved on. Then begin.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export default defineTool({
  name: 'goals:start',
  description:
    'Open a GOAL and spawn the GOAL-mode agent that owns it, atomically — the goal row, the agent, and the agent_modes stamp joining them, or none of them. ' +
    '{ title, killCriterion, budgetCents, body?, tripwires?, parentId?, agent?, model?, account?, headless? }. Returns the goal id AND the new agent\'s ownerId. ' +
    'Kill criterion and ceiling are REQUIRED: GOAL mode mandates both at creation, and this is the surface that enforces it.',
  guidance: {
    when:
      'Starting a NEW outcome that needs an agent to own it end-to-end — the "+ Start a goal" path. One call: goal + its agent + the join between them.',
    notWhen:
      'Recording a goal with NO agent (a goal you or an existing session will own): goals:create. Proposing one for the owner to confirm: goals:propose. Launching an agent for a non-goal task: capability:launch-agent.',
    chaining:
      'goals:start → the spawned agent orients in GOAL mode with the goal as its subject and works the portfolio itself. Watch it on the Goals board, or coord:presence by the returned ownerId.',
    seeAlso: [
      'goals:create (the goal row alone, no agent)',
      'capability:launch-agent (an agent alone, no goal)',
    ],
  },
  // Same gate as goals:create, deliberately, and NOT capability:terminal. The
  // privileged thing capability:terminal guards is running an ARBITRARY
  // command; this spawns one fixed, fully-validated psu launch whose every
  // argument is schema-checked. Gating it harder than goals:create would also
  // lock out the owner's own HUD, which is the only caller this exists for.
  capability: 'goals:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    title: z
      .string()
      .min(1)
      .max(500)
      .describe('the outcome, stated so its achievement is checkable ("ship a paid app")'),
    /* OPTIONAL since 2026-08-09 [owner 2026-08-09, interactive, verbatim:
       "when creating a new goal the 'kill this if' and 'ceiling' should not be
       required properties"]. Both were `.min(1)` / required before, and the
       reasoning for that — an autonomous agent with no stopping condition and
       no declared ceiling is what GOAL mode's contract exists to prevent —
       still holds as ADVICE. It just is not the owner's to be blocked by at
       creation time: the surface that mandated it was the only way to record a
       goal at all, so the mandate became "you may not start a goal until you
       can phrase its kill criterion", which is a different and worse rule.

       Absent ⇒ stored NULL, never a placeholder string or a 0 ceiling. A `$0.00`
       ceiling would read as "declared zero budget" and a "" criterion would read
       as a criterion that was written and left blank; both are lies about what
       the owner said, and the UI already renders the missing case honestly
       (`killCriterionLine` shouts, `ceilingLine` says "no ceiling set"). */
    killCriterion: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'OPTIONAL — the written condition under which this goal is abandoned. Strongly advised: a goal with no kill criterion runs until somebody notices. Omitted ⇒ stored NULL and the agent is told none was set.',
      ),
    budgetCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'OPTIONAL — the declared spend ceiling in cents, the number actuals are reported against. Omitted ⇒ stored NULL (no ceiling declared), NOT 0.',
      ),
    body: z
      .string()
      .max(20000)
      .optional()
      .describe('the full statement: what winning looks like, scope, constraints'),
    tripwires: z
      .array(TripwireSchema)
      .max(12)
      .optional()
      .describe('structured form of the kill criterion — renders as live bars instead of prose nobody re-checks'),
    parentId: z.string().min(1).optional().describe('parent goal id, for a sub-goal'),
    blockedBy: z
      .array(z.string().min(1).max(200))
      .max(20)
      .optional()
      .describe(
        'Prerequisite refs (goal ids / bare WI-/EI- issue ids) this goal is blocked by. NOTE: goals:start spawns the owning agent NOW — a goal whose prerequisites are unsatisfied is usually better filed as a STUB via goals:create { blockedBy } and armed at activation (stub-then-arm, goal-dag-shared-substrate-2026-08-18 D-004). Refs must resolve; the goal graph must stay acyclic.',
      ),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness slug to file the goal under and bootstrap the agent in. Required when the caller context is wildcard/unset.'),
    agent: z.string().max(40).optional().describe("Which backend to launch (default 'claude')."),
    model: z.string().max(80).optional().describe('Model override for the spawned agent.'),
    account: z
      .string()
      .max(80)
      .optional()
      .describe("Account routing: 'default' (system credential, the default), 'auto' (gateway-routed with failover), or a pool account id."),
    headless: z
      .boolean()
      .optional()
      .describe('Launch with NO desktop window (still registers presence and stays injectable).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    if (!workspaceId) {
      return err('No concrete workspace in scope — a goal cannot be filed workspace-less.');
    }
    const installSlug =
      args.harness?.trim() || (ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null);
    if (!installSlug) {
      return err('No harness in scope — goals are filed against an install_slug. Pass `harness`.');
    }

    // EI-20049757392342975: the SAME refusal `goals:propose`, `goals:update` and
    // `goals:create` apply. This door was the one that mattered most and the one
    // the filing missed: it is what the owner's own HUD composer posts to
    // (GoalComposer → postGoalStart → here), and it lives in operator-core
    // rather than agent-mcp/tools/goals/, so an audit of "the goals tools"
    // does not list it. Nothing on that whole path enforced the rule — which is
    // also why GoalComposer.tsx renders an `errors.killCriterion` slot that
    // `validateGoalDraft` can never populate.
    //
    // Checked BEFORE the ownerId pre-pin and the row write, so a refusal costs
    // no minted identity and no rollback. Blank/absent still passes: a goal may
    // have no criterion at all (WI-37604, owner-directed 2026-08-09) — that
    // overrule is about PRESENCE, this rule is about quality GIVEN presence.
    const criterionArg = args.killCriterion?.trim();
    if (criterionArg) {
      const problem = killCriterionProblem(criterionArg);
      if (problem) return err(problem);
    }

    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      callerOwnerId = null;
    }

    const id = goalId(args.title);
    // PRE-PIN the agent's coord identity so the mode stamp below can name it
    // before it exists. Same minting `/api/adv/launch-su` does.
    const ownerId = `su-${randomUUID()}`;

    // ── 1. the goal row ───────────────────────────────────────────────────
    try {
      await insertGoalRow(ctx.tx, {
        id,
        installSlug,
        workspaceId,
        title: args.title,
        body: args.body ?? null,
        parentId: args.parentId ?? null,
        budgetCents: args.budgetCents,
        status: 'active',
        killCriterion: args.killCriterion,
        tripwires: args.tripwires ?? null,
        metadata: { startedBy: callerOwnerId ?? 'operator-ui', agentOwnerId: ownerId },
      });
    } catch (e) {
      return err(`Could not open the goal: ${(e as Error)?.message ?? e}`);
    }

    // ── 1.5 blocked-by edges (goal-dag-shared-substrate-2026-08-18 P-002) ──
    // Validate-and-write BEFORE the mode stamp: a refused set (unresolvable
    // ref, cycle) unwinds only the goal row — cheap, nothing spawned. This door
    // REFUSES rather than degrading (unlike goals:create) because it is about
    // to spawn an agent against exactly this record: silently dropping the
    // prerequisites the caller declared would start an agent on a premise the
    // caller did not state.
    if (args.blockedBy?.length) {
      const applied = await applyGoalBlockedBy(ctx.tx, {
        workspaceId,
        goalId: id,
        refs: args.blockedBy,
        createdBy: callerOwnerId ?? null,
      });
      if (!applied.ok) {
        await deleteGoalRow(ctx.tx, { id, workspaceId }).catch(() => {});
        return err(`blockedBy refused (nothing spawned, goal rolled back): ${applied.problem}`);
      }
    }

    // ── 2. the join: this agent, in GOAL mode, on THIS goal ───────────────
    // Written BEFORE the spawn on purpose — see the header. `subject` is the
    // marker the sessions pane filters on and the Goals board pairs by
    // (goals-tab-improvement-2026-08-09 D-007); without it the session is an
    // ordinary agent that happens to be in goal mode.
    const modeRes = await setMode({
      workspaceId,
      ownerId,
      modeId: 'goal',
      enabled: true,
      reason: `owns goal ${id} — ${args.title.slice(0, 120)}`,
      setBy: callerOwnerId ?? 'operator-ui',
      subject: id,
    });
    if (!modeRes.ok) {
      await deleteGoalRow(ctx.tx, { id, workspaceId }).catch(() => {});
      return err(
        `Could not put the new agent in GOAL mode (${modeRes.error ?? 'unknown error'}), so nothing was spawned and the goal was rolled back. ` +
          'A GOAL-mode agent that does not know its goal is the failure this tool exists to prevent.',
      );
    }

    // ── 2.5 the standing drain fleet (P-001, goal-mode-design-intent-hardening D-005) ──
    // The GOAL contract requires ONE STANDING DRAIN FLEET PER GOAL. Minting it
    // HERE — with the goal, before the agent exists — makes "the agent cannot
    // forget it" structural instead of prose; the goal-drain-fleet watchdog
    // demotes to backstop. Fail-SOFT: a goal start must not die on fleet
    // plumbing, and a drainless goal is exactly what the watchdog reports.
    // (Rows only at this point — the lane's headless member is spawned after
    // the goal agent below, so the rollback never has to unwind a process.)
    let drainFleet: { slug: string; specRevision: number | null } | null = null;
    const drainWarnings: string[] = [];
    if (await drainFleetAutoMintEnabled()) {
      try {
        const minted = await mintDrainFleetForGoal({
          workspaceId,
          goalId: id,
          goalTitle: args.title,
          agentOwnerId: ownerId,
          goalTx: ctx.tx,
        });
        drainFleet = { slug: minted.fleetSlug, specRevision: minted.specRevision };
      } catch (e) {
        drainWarnings.push(
          `drain-fleet auto-mint failed (goal started anyway; the goal-drain-fleet watchdog keeps reporting until a fleet exists): ${(e as Error)?.message ?? e}`,
        );
      }
    }

    // ── 3. the agent ──────────────────────────────────────────────────────
    const rollback = async () => {
      // P-001: the drain-fleet mint is compensable rows (registry + claim spec) —
      // tear them down with the goal, or the fleet strands as a registry row whose
      // goal no longer exists. The metadata.drainFleet stamp dies with the goal row.
      if (drainFleet) {
        await teardownDrainFleetMint({ workspaceId, fleetSlug: drainFleet.slug }).catch(() => {});
      }
      /* D-003: entering GOAL also wrote the modes it IMPLIES (auto, ideate), so
         a rollback that only clears 'goal' strands them on an ownerId that was
         never spawned. Clear exactly what the cascade SET — never a mode it
         merely found already there, which on a fresh ownerId is impossible but
         on a re-used one would revoke a posture this call did not create. */
      for (const modeId of ['goal', ...(modeRes.implied ?? []).filter((i) => i.status === 'set').map((i) => i.mode)]) {
        await setMode({
          workspaceId,
          ownerId,
          modeId,
          enabled: false,
          reason: 'launch failed — rolling back',
          setBy: callerOwnerId ?? 'operator-ui',
        }).catch(() => {});
      }
      // Edges before the row: a deleted goal must not leave dangling blocked-by
      // edges (they would be invisible absent-blocker no-ops, but they pollute
      // the workspace edge read every consumer folds).
      await replaceGoalBlockedBy(ctx.tx, { workspaceId, goalId: id, blockers: [] }).catch(() => {});
      await deleteGoalRow(ctx.tx, { id, workspaceId }).catch(() => {});
    };

    let base;
    try {
      base = await buildConsoleEnvelope({
        workspaceId,
        slug: installSlug,
        operatorBaseUrl: resolveSpawnHostOperatorBaseUrl(),
        // A launched AGENT is an MCP-connected console — it needs the
        // superuser .mcp.json (same call capability:launch-agent makes).
        skipMcpJson: false,
      });
    } catch (e) {
      await rollback();
      return err(`Could not prepare the launch (nothing spawned, goal rolled back): ${(e as Error)?.message ?? e}`);
    }

    // P-004/D-009: the goal's own launch settings apply to the goal's own agent.
    // This door uses the EXPLICIT-goal resolver rather than the launcher-derived
    // one because at this moment the goal is the SUBJECT of the launch and not
    // yet anybody's inherited context — resolveGoalContext(caller) correctly
    // returns null here. Fresh goals normally carry no settings yet (this is
    // where they are born), so the fold is usually a no-op; it matters when an
    // owner has edited the settings and the goal agent is being relaunched.
    const goalLaunch = await resolveGoalLaunchForGoal({
      workspaceId,
      goalId: id,
      goalRole: 'goal',
      requested: {
        ...(args.agent ? { agent: args.agent as 'claude' | 'codex' | 'omp' } : {}),
        ...(args.account ? { account: args.account } : {}),
        ...(args.model ? { model: args.model } : {}),
      },
    });
    if (goalLaunch.refusal) {
      await rollback();
      return err(goalLaunch.refusal.message);
    }

    let command: string;
    try {
      command = buildAgentLaunchCommand({
        mode: 'fresh',
        agent: goalLaunch.effective.agent ?? args.agent ?? 'claude',
        harness: installSlug,
        ownerId,
        account: goalLaunch.effective.account ?? args.account ?? null,
        model: goalLaunch.effective.model ?? args.model ?? null,
        effort: goalLaunch.effective.effort ?? null,
        contextSize: goalLaunch.effective.contextSize ?? null,
        headless: !!args.headless,
      });
    } catch (e) {
      await rollback();
      return err(`Could not build the launch command (nothing spawned, goal rolled back): ${(e as Error)?.message ?? e}`);
    }
    command = injectLaunchedByArg(command, callerOwnerId).command;

    // The brief rides the ENV, never a --kickoff= value: free-form text inside
    // the console greeting one-liner gets double-single-quoted and breaks the
    // shell. psu reads PAPERCUSP_KICKOFF_PROMPT as the fresh CLI's first turn.
    const env = {
      ...base.env,
      PAPERCUSP_KICKOFF_PROMPT: buildGoalKickoffBrief({
        goalId: id,
        title: args.title,
        killCriterion: args.killCriterion,
        budgetCents: args.budgetCents,
        body: args.body ?? null,
      }),
    };
    const label = `goal · ${args.title.slice(0, 40)}`;

    const spawned = args.headless
      ? await spawnHeadless({
          envelope: { ...base, env, greetingCmd: command, cwd: base.cwd },
          label: `${label} (headless)`,
          logDir: join(papercuspPathForWorkspace(workspaceId), 'fleet-logs'),
        })
      : await spawnConsole({
          envelope: { ...base, env, greetingCmd: command, cwd: base.cwd },
          label,
          writeMcpJson: false,
          allowDesktopBridge: true,
        });

    if (spawned.status !== 'ok') {
      await rollback();
      const detail = 'error' in spawned && spawned.error ? spawned.error : 'the spawn reported no detail';
      return err(
        `The goal's agent failed to launch (${detail}). The goal row and its mode stamp were ROLLED BACK — ` +
          'nothing was left behind, so retrying is safe.',
      );
    }

    // ── 3.5 the drain lane's puller (P-001) ───────────────────────────────
    // A lane needs a MEMBER, not just a spec. Spawned LAST on purpose: every
    // earlier side effect is compensable, a process is not — so it starts only
    // once the goal is definitely keeping its agent. `--fleet` is what makes
    // bootstrap-su stamp the membership fact getClaimSpec's fleet-inheritance
    // resolves through (and what triggers the launcher's fleet auto-kickoff, so
    // the member pulls instead of parking). Fail-soft: a memberless fleet reads
    // as 'drain-fleet-dead' to the watchdog, which is the designed backstop —
    // never a reason to unwind a successfully-started goal.
    let drainMember: { pid: number | null; terminal: string } | null = null;
    if (drainFleet) {
      try {
        let memberCmd = buildAgentLaunchCommand({
          mode: 'fresh',
          agent: goalLaunch.effective.agent ?? args.agent ?? 'claude',
          harness: installSlug,
          account: goalLaunch.effective.account ?? args.account ?? null,
          headless: true,
        });
        memberCmd = injectFleetArg(memberCmd, drainFleet.slug).command;
        memberCmd = injectLaunchedByArg(memberCmd, callerOwnerId).command;
        // Deliberately `base.env`, never the goal agent's `env`: the kickoff
        // brief names ONE owner of the goal, and a drain bee that also received
        // it would believe itself that owner.
        const member = await spawnHeadless({
          envelope: { ...base, greetingCmd: memberCmd, cwd: base.cwd },
          label: `goal-drain · ${args.title.slice(0, 40)}`,
          logDir: join(papercuspPathForWorkspace(workspaceId), 'fleet-logs'),
        });
        if (member.status === 'ok') {
          drainMember = { pid: member.pid ?? null, terminal: member.terminal };
        } else {
          const detail = 'error' in member && member.error ? member.error : 'no detail';
          drainWarnings.push(
            `drain-fleet member failed to launch (${detail}) — the fleet and its goal-scoped lane exist; ` +
              'the watchdog reports it dead until a member joins (fleet:join / capability:terminal with --fleet).',
          );
        }
      } catch (e) {
        drainWarnings.push(`drain-fleet member launch threw: ${(e as Error)?.message ?? e}`);
      }
    }

    return {
      data: {
        id,
        title: args.title,
        status: 'active',
        kill_criterion: args.killCriterion,
        budget_cents: args.budgetCents,
        parent_id: args.parentId ?? null,
        tripwires: args.tripwires ?? null,
        workspace_id: workspaceId,
        install_slug: installSlug,
        // The agent that owns it. This — not an adv_sessions row, which psu
        // records asynchronously once it boots — is the handle to open its
        // chat, poll coord:presence, or pair it on the Goals board.
        agent_owner_id: ownerId,
        agent_terminal: spawned.terminal,
        agent_pid: spawned.pid ?? null,
        headless: !!args.headless,
        // P-001: the auto-minted standing drain fleet (also declared on the goal
        // row as metadata.drainFleet — the watchdog's surface). Null means the
        // mint was skipped (flag off) or failed; see `warning`.
        drain_fleet: drainFleet?.slug ?? null,
        drain_member_pid: drainMember?.pid ?? null,
        ...(drainWarnings.length ? { warning: drainWarnings.join('\n') } : {}),
      },
    };
  },
});
