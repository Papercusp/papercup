/**
 * Composition ops (`coordination-ops-as-blueprint-primitives-2026-06-04` D-006 /
 * D-009) — ops that *run a blueprint program*. These are the "called directly"
 * surface of the seed blueprints (D-009: a complex pattern is one op an agent
 * invokes): `coord:vote` runs the `vote` program, `coord:deliberate` runs the
 * `deliberate` program. They are also how a program composes recursively — the
 * `deliberate` spine's vote step invokes `coord:vote`, bounded by the depth cap
 * (`ctx.depth + 1`, D-008). `coord:ask` is the bare uncertainty-ladder rung (ask
 * the owner, bounded wait) — a simple op (D-009), not a program.
 *
 * The program execution itself is `ctx.caps.runProgram`, wired by the durable
 * `coordProgramWorkflow` (which loads the blueprint, runs its steps + gate as DBOS
 * steps, and returns the outcome). Keeping run-a-program behind a cap means these
 * ops have no DBOS dependency and stay unit-testable.
 */
import { z } from 'zod';
import type { CoordOp } from '../types.js';
import { registerCoordOp } from '../registry.js';

// ── coord:vote ────────────────────────────────────────────────────────────────

const voteArgs = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).min(2),
  /** One voter per lens (the diversity defense — D-010). Defaults applied by the blueprint knobs. */
  lenses: z.array(z.string()).optional(),
  quorum: z.number().int().positive().optional(),
  timeout_s: z.number().positive().optional(),
  max_voters: z.number().int().positive().optional(),
  topics: z.array(z.string()).optional(),
  /** The harness whose agents run the voters (the tool handler sets ctx from this). */
  harness: z.string().optional(),
});

const programResult = z.object({
  outcome: z.string(),
  resolved: z.boolean(),
  decision: z.unknown().optional(),
});

export const voteOp: CoordOp<z.infer<typeof voteArgs>, z.infer<typeof programResult>> = {
  name: 'coord:vote',
  description: 'Run a diverse-lens confidence-weighted vote on a decision; resolve decisively or escalate the split.',
  argsSchema: voteArgs,
  resultSchema: programResult,
  async run(a, ctx) {
    const r = await ctx.caps.runProgram({
      blueprintId: 'vote',
      payload: { ...a },
      depth: ctx.depth + 1,
      callerId: ctx.callerId ?? ctx.identity.ownerId,
    });
    return { outcome: r.outcome, resolved: r.resolved, decision: r.decision };
  },
};
registerCoordOp(voteOp);

// ── coord:deliberate (the uncertainty ladder) ──────────────────────────────────

const deliberateArgs = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).min(2),
  lenses: z.array(z.string()).optional(),
  ask_timeout_s: z.number().positive().optional(),
  quorum: z.number().int().positive().optional(),
  timeout_s: z.number().positive().optional(),
  harness: z.string().optional(),
});

export const deliberateOp: CoordOp<z.infer<typeof deliberateArgs>, z.infer<typeof programResult>> = {
  name: 'coord:deliberate',
  description: 'Run the uncertainty ladder: ask the owner → if unresolved, vote → if split, escalate.',
  argsSchema: deliberateArgs,
  resultSchema: programResult,
  async run(a, ctx) {
    const r = await ctx.caps.runProgram({
      blueprintId: 'deliberate',
      payload: { ...a },
      depth: ctx.depth + 1,
      callerId: ctx.callerId ?? ctx.identity.ownerId,
    });
    return { outcome: r.outcome, resolved: r.resolved, decision: r.decision };
  },
};
registerCoordOp(deliberateOp);

// ── coord:ask (bare ask-owner — a simple op, D-009) ─────────────────────────────

const askArgs = z.object({
  question: z.string().min(1),
  body: z.string().optional(),
  /** Bounded wait for the owner's answer (default 120s). */
  timeout_s: z.number().positive().default(120),
  poll_ms: z.number().int().positive().default(2000),
  topics: z.array(z.string()).optional(),
});

const askResult = z.object({
  answered: z.boolean(),
  answer: z.string().nullable(),
  conversation_id: z.string(),
});

const MAX_POLLS = 100_000;

export const askOp: CoordOp<z.infer<typeof askArgs>, z.infer<typeof askResult>> = {
  name: 'coord:ask',
  description: 'Ask the owner a question and wait a bounded time for an answer (the ladder\'s first rung).',
  argsSchema: askArgs,
  resultSchema: askResult,
  async run(a, ctx) {
    const thread = await ctx.caps.openThread({
      title: a.question,
      body: a.body ?? a.question,
      kind: 'question',
      topics: a.topics,
      harness: ctx.harnessSlug,
    });
    // Land it in the human's inbox so the ask is actually seen.
    await ctx.caps
      .escalate({ severity: 'question', summary: a.question, body: a.body })
      .catch(() => {
        /* best-effort — the thread itself is the durable ask surface */
      });

    const askerId = ctx.identity.ownerId;
    const maxPolls = Math.min(MAX_POLLS, Math.max(1, Math.ceil((a.timeout_s * 1000) / a.poll_ms)));
    let ans = await ctx.caps.readAnswer({ conversationId: thread.conversation_id, askerId });
    for (let poll = 0; poll < maxPolls && !ans.answered; poll++) {
      await ctx.caps.sleep(a.poll_ms);
      ans = await ctx.caps.readAnswer({ conversationId: thread.conversation_id, askerId });
    }
    return { answered: ans.answered, answer: ans.answer, conversation_id: thread.conversation_id };
  },
};
registerCoordOp(askOp);
