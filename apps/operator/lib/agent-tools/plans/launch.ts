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
import { defineTool } from '@papercusp/agent-mcp';
import { buildPlanContextBundle } from './context-bundle';
import { runPlanAgent } from './runner';
import { getRepoRoot } from './source';
import {
  appendPlanRunTurn,
  insertPlanRun,
  setPlanRunStatus,
  type PlanRunStatus,
  type PlanRunTurnRole,
} from './runs';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';

const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

const argsSchema = z.object({
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

/** Append a transcript turn, best-effort — the run has already streamed
 *  to the caller, so a lost `plan_run_turns` row must not fail the
 *  tool. The DAL throws on DB failure; this swallows + logs it. */
async function persistTurn(
  runId: number,
  turn: {
    role: PlanRunTurnRole;
    content: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
  },
): Promise<void> {
  try {
    await appendPlanRunTurn({ planRunId: runId, ...turn });
  } catch (err) {
    console.warn(
      `[plans:launch] failed to persist ${turn.role} turn for run ${runId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function launchHandler(input: LaunchArgs, ctx: LaunchCtx) {
  // 1. Assemble the launch seed (plan doc + rationale digest — P-009).
  const bundle = await buildPlanContextBundle(input.slug);
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
  const runId = await insertPlanRun({
    planSlug: input.slug,
    planContentHash: bundle.contentHash,
    sessionId,
    note,
    launchedBy,
    title,
    status: 'running',
  });
  ctx.emit('run_started', { runId, sessionId });

  // 5. Persist the user turn (the kickoff / note) as transcript seq 1.
  await persistTurn(runId, { role: 'user', content: promptText });

  // 6. Run the agent, streaming events and accumulating the reply.
  let finalText = '';
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let status: PlanRunStatus = 'idle';
  try {
    for await (const ev of runPlanAgent({
      sessionId,
      systemPromptText: bundle.text,
      promptText,
      cwd: getRepoRoot(),
      uiClientId: ctx.uiClientId ?? null,
      signal: ctx.signal,
    })) {
      if (ev.type === 'delta') {
        ctx.emit('delta', { text: ev.text });
        finalText += ev.text;
      } else if (ev.type === 'tool_call') {
        ctx.emit('tool_call', { name: ev.name, input: ev.input });
      } else if (ev.type === 'result') {
        costUsd = ev.costUsd;
        tokensIn = ev.tokensIn;
        tokensOut = ev.tokensOut;
        // runAgentChat's terminal result.finalText can be more complete
        // than the streamed accumulation — prefer the longer.
        if (ev.finalText.length > finalText.length) finalText = ev.finalText;
        ctx.emit('cost', { usd: ev.costUsd });
      } else if (ev.type === 'error') {
        status = 'failed';
        ctx.emit('error', {
          message: ev.stderr
            ? `${ev.message}: ${ev.stderr.slice(0, 400)}`
            : ev.message,
        });
      }
    }
  } catch (err) {
    status = 'failed';
    ctx.emit('error', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 7. Persist the assistant turn (transcript seq 2).
  await persistTurn(runId, {
    role: 'assistant',
    content: finalText,
    tokensIn,
    tokensOut,
    costUsd,
  });

  // 8. Settle the run status: idle (resumable — D-010) or failed.
  try {
    await setPlanRunStatus(runId, status);
  } catch (err) {
    console.warn(
      `[plans:launch] failed to set final status for run ${runId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

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
  roles: [...SU_ROLES],
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
