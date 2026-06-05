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
import { defineTool } from '@papercusp/agent-mcp';
import { openEscalation, resolveEscalation as resolveEscalationRecord } from '../coordination/escalations';
import { resolveAgentIdentity } from '../coordination/identity';

const ALL_ROLES = [
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
  question: z.string().min(1).max(MAX_QUESTION_LEN),
  options: z.array(optionSchema).min(1).max(MAX_OPTIONS),
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
  agentRoles: [...ALL_ROLES],
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

    // inbox-cards-unification Phase D (P-034): when the flag is on, ALSO write
    // a durable coord escalation linked to this card's correlationId, so the
    // human can answer it from the inbox and this blocked agent resumes
    // (coord:resolve → resolveCardResponse, P-035). Default OFF ⇒ no escalation
    // and zero behavior change. Best-effort throughout: a write/resolve failure
    // never breaks the card flow.
    let durableEscalation = false;
    try {
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      durableEscalation = await getFlag(FLAGS.INBOX_DURABLE_ESCALATIONS, 'system');
    } catch {
      durableEscalation = false;
    }
    let escalationP: Promise<{ msg_id: string } | null> = Promise.resolve(null);

    const response = await ctx.askUser({
      prompt: normalized.question,
      dataSchema: responseSchema,
      presentation,
      fallbackText,
      allowDecline: normalized.allowDecline ?? true,
      ...(durableEscalation
        ? {
            onCard: ({ correlationId, workspaceId }) => {
              try {
                escalationP = openEscalation(resolveAgentIdentity(ctx), {
                  severity: 'question',
                  summary: normalized.question,
                  options: normalized.options.map((o) => ({ id: o.id, label: o.label })),
                  meta: { cardCorrelationId: correlationId, cardWorkspaceId: workspaceId },
                }).catch(() => null);
              } catch {
                /* identity/write failure must not break the card */
              }
            },
          }
        : {}),
    });

    // Close the inbox copy once the card resolves. Idempotent: if it was the
    // INBOX that resolved the card (via coord:resolve), the escalation is
    // already resolved and this is a no-op ('already_resolved').
    if (durableEscalation) {
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
