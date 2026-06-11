/**
 * plans:launch — launch an autonomous agent on a plan.
 *
 * plan-agent-launch-2026-05-21, Phase 3 (P-012). The integration point
 * where Phase 3's pieces come together:
 *
 *   1. assemble the P-009 context bundle (`buildPlanContextBundle`);
 *   2. mint a `session_id` and insert the `plan_runs` row (P-010 table);
 *   3. run the agent via the P-011 runner (`runPlanAgent`);
 *   4. stream delta / tool_call / cost events to the caller;
 *   5. persist the user + assistant turns to `plan_run_turns`.
 *
 * A streaming tool in the mould of `oracle:chat`. The run is resumable
 * (D-010) — `plans:launch` performs the first turn; a later "continue"
 * (P-013) re-invokes the runner with the same `session_id`.
 *
 * Wire events:
 *   run_started { runId, sessionId }   ← emitted once the row exists
 *   delta       { text }
 *   tool_call   { name, input }
 *   cost        { usd }
 *   warning     { message }            ← e.g. launching a superseded plan
 *   error       { message }
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { buildPlanContextBundle } from './context-bundle';
import { getRepoRoot } from './source';
import { insertPlanRun } from './runs';
import { executePlanAgentTurn } from './turn';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { emitPlanEventForCaller } from '../coordination/plan-events';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename without .md) to launch an agent on.'),
  note: z
    .string()
    .optional()
    .describe(
      'Optional free-text instruction for the launched agent. Absent → a ' +
        'default "advance this plan" kickoff.',
    ),
  // P-022: an HTTP caller (the /admin/plans UI) cannot stream — it
  // can only block on the response. Setting `await: false` returns
  // as soon as the plan_runs row exists; the agent turn continues
  // fire-and-forget and reports its result via the row's `status`
  // (which the UI polls through `plans:runs`). Defaults to true so
  // the MCP streaming path is unchanged.
  await: z
    .boolean()
    .optional()
    .describe(
      'When false, return immediately after inserting the plan_runs ' +
        'row; the agent turn runs in the background and writes its ' +
        'turns + final status asynchronously. Default true (wait for the ' +
        'turn to complete).',
    ),
});

type LaunchArgs = z.infer<typeof argsSchema>;

const EVENTS = {
  run_started: z.object({ runId: z.number(), sessionId: z.string() }),
  delta: z.object({ text: z.string() }),
  tool_call: z.object({ name: z.string(), input: z.unknown() }),
  cost: z.object({ usd: z.number() }),
  warning: z.object({ message: z.string() }),
  error: z.object({ message: z.string() }),
} as const;

/**
 * The first user turn for a launch — the supplied note, or a default
 * kickoff when the launch carried none. Exported + pure for unit test.
 */
export function deriveLaunchPromptText(note: string | null | undefined): string {
  const trimmed = (note ?? '').trim();
  return trimmed.length > 0
    ? trimmed
    : 'Begin: advance this plan. Read the `## Now` block, pick up the ' +
        'next actionable item, and work it.';
}

/**
 * The runs-list label for a launch — the note's first line (truncated),
 * else the plan title. Exported + pure for unit test.
 */
export function deriveLaunchTitle(
  note: string | null | undefined,
  planTitle: string,
): string {
  const firstLine = (note ?? '').trim().split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return planTitle;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

/** The ctx subset `plans:launch` reads — identity (for `launched_by`)
 *  + the streaming/cancellation handles. The real `UnifiedToolContext`
 *  satisfies it structurally. */
type LaunchCtx = ResolveIdentityCtx & {
  emit: (name: string, data: unknown) => void;
  signal?: AbortSignal;
};

async function launchHandler(input: LaunchArgs, ctx: LaunchCtx) {
  // 1. Assemble the launch seed (plan doc + rationale digest — P-009).
  const sctx = harnessScopedCtx(input.harness, ctx);
  const __ctxHarness = resolveCtxHarnessSlug(sctx);
  const bundle = await buildPlanContextBundle(
    input.slug,
    __ctxHarness ? { harnessSlug: __ctxHarness } : {},
  );
  if (!bundle) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: 'not_found', slug: input.slug }),
        },
      ],
    };
  }

  // 2. Warn — but do not block — when launching a superseded plan.
  if (bundle.status === 'superseded') {
    ctx.emit('warning', {
      message: `Plan "${input.slug}" is superseded — launching anyway.`,
    });
  }

  // 3. Mint the run's session id (runAgentChat sessionId == ?plan_run=
  //    == plan_runs.session_id) and resolve who launched it.
  const sessionId = globalThis.crypto.randomUUID();
  let launchedBy = 'unknown';
  try {
    launchedBy = resolveAgentIdentity(ctx).ownerId;
  } catch {
    // Unattributable caller — record the launch as 'unknown' rather
    // than fail it (launched_by is NOT NULL).
  }

  const promptText = deriveLaunchPromptText(input.note);
  const title = deriveLaunchTitle(input.note, bundle.title);
  const note = (input.note ?? '').trim() || null;

  // 4. Insert the plan_runs row — the canonical record of the launch.
  const launchHarnessSlug = resolveCtxHarnessSlug(sctx);
  const runId = await insertPlanRun({
    planSlug: input.slug,
    ...(launchHarnessSlug ? { harnessSlug: launchHarnessSlug } : {}),
    planContentHash: bundle.contentHash,
    sessionId,
    note,
    launchedBy,
    title,
    status: 'running',
  });
  ctx.emit('run_started', { runId, sessionId });

  // 5. Emit the plan-event — `agent_launched` is plan-scoped activity
  //    the feed surfaces (P-014). Best-effort; never blocks the run.
  await emitPlanEventForCaller(ctx, {
    planSlug: input.slug,
    event: 'agent_launched',
    after: runId,
    detail: title,
  });

  // 6. Run the agent's first turn — stream + persist turns + settle
  //    status. Shared with resume (P-013); see turn.ts.
  //
  // `await: false` (the admin-route UI path — D-022): kick the turn
  // off in the background and return as soon as the row exists. Any
  // failure in the background run is swallowed here because
  // executePlanAgentTurn already settles `plan_runs.status` to
  // `failed` internally, and the run-row update is the canonical
  // signal — there is no other listener.
  if (input.await === false) {
    void executePlanAgentTurn({
      runId,
      sessionId,
      systemPromptText: bundle.text,
      promptText,
      cwd: getRepoRoot(),
      uiClientId: ctx.uiClientId ?? null,
      signal: ctx.signal,
      emit: ctx.emit,
    }).catch(() => { /* settled to 'failed' inside the turn */ });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            runId,
            sessionId,
            status: 'running',
            planSlug: input.slug,
            mode: 'background',
          }),
        },
      ],
    };
  }

  const { status, costUsd } = await executePlanAgentTurn({
    runId,
    sessionId,
    systemPromptText: bundle.text,
    promptText,
    cwd: getRepoRoot(),
    uiClientId: ctx.uiClientId ?? null,
    signal: ctx.signal,
    emit: ctx.emit,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          runId,
          sessionId,
          status,
          planSlug: input.slug,
          costUsd,
        }),
      },
    ],
  };
}

export default defineTool({
  name: 'plans:launch',
  profile: 'engineer',
  description:
    'Launch an autonomous agent on a plan. Assembles the plan context bundle (plan doc + revision rationale), starts a resumable run, streams the agent, records it in plan_runs. Returns the run id + session id.',
  guidance: {
    when: 'You want an agent to autonomously advance a plan — pick up its next actionable item and work it.',
    notWhen:
      'You only want to read a plan (plans:get) or edit it yourself (the plans:set-* verbs). Resuming an existing run is a continue call, not a fresh launch.',
    chaining:
      'plans:list / plans:get → plans:launch { slug } → the run streams; plans:runs lists past launches.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  // Streaming tool — opt into the replay ring buffer, same budget as
  // oracle:chat / architect:chat.
  replayBufferSize: 5000,
  args: argsSchema,
  events: EVENTS,
  handler: launchHandler,
});
