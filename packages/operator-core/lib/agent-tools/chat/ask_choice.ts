/**
 * chat:ask_choice — present the user with a structured set of clickable
 * choices and BLOCK until they pick (or decline / cancel).
 *
 * Implementation (post bespoke-card-improvements):
 *   Thin wrapper over ctx.askUser. The card lives on the state channel
 *   from the moment the handler awaits; the user's pick arrives as the
 *   tool's RETURN value, not as a separate user turn. The chat surface
 *   renders the AskChoiceCard from the state-snapshot, not from a
 *   tool-call SSE event.
 *
 * UX consequence vs the legacy fire-and-forget design:
 *   - Model now waits *inside* the tool call; SSE stream stays open.
 *   - The model can react to the choice without ending its turn.
 *   - If the user ignores the buttons, ctx.askUser eventually resolves
 *     {action:'cancel'} (run abort / workspace switch / timeout).
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.6
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { openEscalation, resolveEscalation as resolveEscalationRecord } from '../coordination/escalations';
import { resolveAgentIdentity, type AgentIdentity } from '../coordination/identity';
import {
  classifyAgentQuestion,
  isAutonomousAgent,
  openAgentQuestionEscalation,
} from '../coordination/agent-question-gate';

const MAX_OPTIONS = 6;
const MAX_QUESTION_LEN = 500;
const MAX_LABEL_LEN = 80;
const MAX_HINT_LEN = 120;
const MAX_ID_LEN = 32;
const MAX_ARGS_BYTES = 4 * 1024;

const optionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(MAX_ID_LEN)
    .regex(/^[a-zA-Z0-9_-]+$/, 'option.id must be [a-zA-Z0-9_-]+'),
  label: z.string().min(1).max(MAX_LABEL_LEN),
  hint: z.string().max(MAX_HINT_LEN).optional(),
  style: z.enum(['default', 'primary', 'danger']).optional(),
});

const argsSchema = z.object({
  // Caller-DX (watchdog P-006): actionable validation messages — an empty
  // `options` array previously failed with a bare "Array must contain at least
  // 1 element(s)" that gave the agent no idea what to supply.
  question: z
    .string({ required_error: 'chat:ask_choice needs a `question` — the prompt shown to the user.' })
    .min(1, '`question` must be a non-empty prompt.')
    .max(MAX_QUESTION_LEN),
  options: z
    .array(optionSchema, {
      required_error:
        'chat:ask_choice needs `options`: 1-6 clickable choices, each { id, label }. For an OPEN-ENDED question (describe / paste), use plain text instead.',
    })
    .min(
      1,
      'chat:ask_choice needs at least one option (each { id, label }) — provide 2-3 for a yes/no or pick-one decision.',
    )
    .max(MAX_OPTIONS, `chat:ask_choice accepts at most ${MAX_OPTIONS} options.`),
  /** Multi-select. Default false (radio: one pick commits). */
  multi: z.boolean().optional(),
  /** Show Skip affordance. Default true. */
  allowDecline: z.boolean().optional(),
  /**
   * Single-select cards only (multi !== true). When true, voice users
   * can answer this card by speaking the option label or id; the
   * voice-card router resolves the card via /card-response. Default
   * false: voice users hear fallbackText (announce-only) and must
   * click on the chat surface. Plan §C.3 (default false / H3 review).
   */
  voiceAnswerable: z.boolean().optional(),
  /**
   * B-17/P-040 decision-context: when an AUTONOMOUS agent (bee) asks, declare WHAT
   * the decision is about so the autonomy gate can route it (reversible + in-envelope
   * + below-ceiling → the bee may self-decide; else → the owner Queue). Ignored for
   * interactive callers and while the autonomy gate is disarmed (owner P-092 OFF).
   */
  decision: z
    .object({
      action: z
        .string()
        .max(120)
        .optional()
        .describe('Tool/verb or short slug of the action the decision is about (maps to an autonomy category, B-04).'),
      riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
      authority: z.enum(['system', 'owner']).optional(),
      reversibility: z.enum(['reversible', 'irreversible', 'unknown']).optional(),
    })
    .optional()
    .describe('Decision-context for the autonomy gate (B-17/P-040) — only the bee self-answer path uses it; omit for ordinary human-facing questions.'),
});

export default defineTool({
  name: 'chat:ask_choice',
  description:
    'Present the user with a structured set of clickable choices and BLOCK until they pick. The tool returns the chosen option(s) (or {declined:true} if the user skipped). Use for yes/no, accept/reject, or pick-one-of questions with up to 6 options. Set multi:true for "select all that apply".',
  capability: 'chat:write',
  guidance: {
    when: 'You need a yes/no, accept/reject, or pick-one-of decision from the user before continuing. Renders clickable buttons in the chat; the tool returns the choice as its result. You can keep working in the same turn after the result lands.',
    notWhen: 'For OPEN-ENDED questions ("describe what you want", "paste the error"), keep using plain text. Use 2-3 options; 4+ only when genuinely distinct (6 hard max).',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { worker: { perChunk: 10 }, operator: { perRun: 100 } },
  // Available in both text and voice. Voice users hear fallbackText
  // (announce-only) by default; opt in to spoken answering via
  // voiceAnswerable:true on single-select cards. Plan §C.4.
  args: argsSchema,
  async handler(args, ctx) {
    const serialized = JSON.stringify(args);
    if (serialized.length > MAX_ARGS_BYTES) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `args_too_large: ${serialized.length}B exceeds ${MAX_ARGS_BYTES}B cap`,
          }),
        }],
        isError: true,
      };
    }

    if (!ctx.askUser) {
      // Out-of-chat caller (no runId in ctx). chat:ask_choice only
      // makes sense from a surface that can render the card.
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'no_chat_surface: chat:ask_choice requires a runId-bearing context (chat or oracle)',
          }),
        }],
        isError: true,
      };
    }

    const normalized = {
      ...args,
      options: args.options.map((o) => ({ ...o, id: o.id.toLowerCase() })),
    };
    const knownIds = normalized.options.map((o) => o.id) as [string, ...string[]];
    const idSchema = z.enum(knownIds);
    const responseSchema = normalized.multi
      ? z.object({ picks: z.array(idSchema).min(1) })
      : z.object({ picks: z.tuple([idSchema]) });

    const fallbackText =
      `${normalized.question}\n\nOptions:\n` +
      normalized.options.map((o, i) => `  ${i + 1}. ${o.label}${o.hint ? ` — ${o.hint}` : ''}`).join('\n');

    // voiceAnswerable rides on the radio presentation only (multi !== true).
    // The router gates on presentation.kind === 'radio' + this flag — see
    // OperatorConversationProvider's focused-card sync effect.
    const presentation = normalized.multi
      ? { kind: 'checkbox' as const, options: normalized.options }
      : {
          kind: 'radio' as const,
          options: normalized.options,
          ...(normalized.voiceAnswerable === true ? { voiceAnswerable: true } : {}),
        };

    // Identity-aware interception. A decision card is mirrored into a durable,
    // card-linked coord escalation via one of two paths — resolved as ONE record
    // either way (the human/Queen answers via coord:resolve → unblockLinkedCard →
    // resolveCardResponse, which resolves THIS card and resumes the caller):
    //
    //   (1) B-10 card interception (QUEEN_CARD_INTERCEPTION, queen-autonomous-execution
    //       P-041/P-045): the caller is a FLEET AGENT (bee / signed-spawn) — no human
    //       is watching the card surface, so a blocking card is a freeze. Route it
    //       through the agent-question gate (owner Queue today; autonomy-policy injects
    //       the rung) AND give the card a bounded timeout so it degrades to
    //       {action:'cancel'} instead of holding the agent's run forever. Takes
    //       precedence over (2) — one escalation, not two.
    //   (2) inbox-cards-unification Phase D (INBOX_DURABLE_ESCALATIONS, P-034): an
    //       INTERACTIVE card ALSO lands in the owner inbox so it can be answered live
    //       OR later. Unchanged; the live card is left to block (a human is there).
    //
    // Best-effort throughout: a flag read / identity resolve / escalation write
    // failure never breaks the card flow.
    let flagIntercept = false;
    let flagDurable = false;
    try {
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      [flagIntercept, flagDurable] = await Promise.all([
        getFlag(FLAGS.QUEEN_CARD_INTERCEPTION, 'system'),
        getFlag(FLAGS.INBOX_DURABLE_ESCALATIONS, 'system'),
      ]);
    } catch {
      flagIntercept = false;
      flagDurable = false;
    }

    let identity: AgentIdentity | null = null;
    try {
      identity = resolveAgentIdentity(ctx);
    } catch {
      // Unattributable ctx (e.g. an out-of-band caller / test mock) — no
      // interception, no mirror; the live card path is untouched.
      identity = null;
    }

    const intercept = flagIntercept && identity !== null && isAutonomousAgent(identity);
    const durableMirror = !intercept && flagDurable;
    const optionPairs = normalized.options.map((o) => ({ id: o.id, label: o.label }));

    // Intercepted agent cards classify up-front so the bounded timeout is on the
    // spec before the card registers (the gate decides the rung + timeout).
    const interceptRouting = intercept
      ? await classifyAgentQuestion({
          identity: identity!,
          question: normalized.question,
          options: optionPairs,
          ...(normalized.decision?.action ? { action: normalized.decision.action } : {}),
          ...(normalized.decision?.riskTier ? { riskTier: normalized.decision.riskTier } : {}),
          ...(normalized.decision?.authority ? { authority: normalized.decision.authority } : {}),
          ...(normalized.decision?.reversibility ? { reversibility: normalized.decision.reversibility } : {}),
        })
      : null;

    // B-17/P-040 — bee SELF-ANSWER short-circuit. When the autonomy gate permits the
    // autonomous caller to self-decide this question (reversible · in-envelope · below
    // the per-category ceiling — only reachable once the owner arms P-092), do NOT
    // open an owner escalation or block on the card: return immediately so the bee
    // proceeds with its sensible default. The dispatch/confinement layer arms the
    // D-006 revert-handle on the auto reversible action it then takes
    // (armTripwireForDecision). DARK until armed: while disarmed the gate returns
    // owner-queue, so this branch is never taken (behavior-neutral, D-007).
    if (interceptRouting?.rung === 'bee-self') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              self_decide: true,
              rung: 'bee-self',
              options: optionPairs,
              message:
                'Autonomy gate permits self-decision (reversible · in-envelope · below-ceiling). Pick the sensible default and proceed — do NOT wait on the owner. Your reversible action is auto-watched with a revert-handle (D-006); undo if it trips.',
            }),
          },
        ],
      };
    }

    let escalationP: Promise<{ msg_id: string } | null> = Promise.resolve(null);
    const wantsOnCard = intercept || durableMirror;

    const response = await ctx.askUser({
      prompt: normalized.question,
      dataSchema: responseSchema,
      presentation,
      fallbackText,
      allowDecline: normalized.allowDecline ?? true,
      ...(interceptRouting ? { timeoutMs: interceptRouting.timeoutMs } : {}),
      ...(wantsOnCard
        ? {
            onCard: ({ correlationId, workspaceId }) => {
              try {
                if (intercept) {
                  escalationP = openAgentQuestionEscalation(
                    identity!,
                    {
                      identity: identity!,
                      question: normalized.question,
                      options: optionPairs,
                      cardCorrelationId: correlationId,
                      cardWorkspaceId: workspaceId,
                    },
                    interceptRouting!.rung,
                  ).catch(() => null);
                } else {
                  escalationP = openEscalation(identity ?? resolveAgentIdentity(ctx), {
                    severity: 'question',
                    summary: normalized.question,
                    options: optionPairs,
                    meta: { cardCorrelationId: correlationId, cardWorkspaceId: workspaceId },
                  }).catch(() => null);
                }
              } catch {
                /* identity/write failure must not break the card */
              }
            },
          }
        : {}),
    });

    // Close the inbox copy once the card resolves. Idempotent: if it was the
    // INBOX that resolved the card (via coord:resolve), the escalation is
    // already resolved and this is a no-op ('already_resolved'). On a timeout/
    // cancel the agent moved on, so the now-stale question is closed too.
    if (wantsOnCard) {
      const esc = await escalationP;
      if (esc) {
        const choice =
          response.action === 'submit'
            ? String(response.payload.picks[0] ?? 'resolved')
            : response.action;
        try {
          await resolveEscalationRecord({ msg_id: esc.msg_id, choice, resolver: 'human' });
        } catch {
          /* best-effort cleanup */
        }
      }
    }

    if (response.action === 'decline') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ declined: true, reason: response.reason }),
        }],
      };
    }
    if (response.action === 'cancel') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ cancelled: true }),
        }],
      };
    }

    const picks = response.payload.picks.map((id) => {
      const opt = normalized.options.find((o) => o.id === id)!;
      return { option_id: opt.id, label: opt.label };
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          picks,
          multi: normalized.multi ?? false,
        }),
      }],
    };
  },
});
