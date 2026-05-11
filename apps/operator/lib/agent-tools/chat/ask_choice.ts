/**
 * chat:ask_choice — present the user with a structured set of clickable
 * choices in chat instead of asking the question as free-text.
 *
 * Fire-and-forget render hint: the handler echoes back the validated
 * args (for audit_log capture); the actual rendering happens client-side
 * when the chat surface emits the tool_call SSE event to the dock. The
 * dock renders an AskChoiceCard with the question + button list. On
 * click, the dock POSTs to the surface-specific turn-answer endpoint
 * AND sends the option's label as a new user message — same path as
 * Scout's suggestion chips, just model-driven.
 *
 * After calling this tool, the model should END ITS TURN. The user's
 * click arrives as the next user message; the buttons ARE the prompt.
 *
 * Why fire-and-forget instead of wait-for-result: holding an SSE turn
 * open while waiting for a click would tie up tokens, show "thinking"
 * UI for minutes, and break gracefully-cancellable UX (user can ignore
 * the buttons and type something else).
 *
 * Why in the `chat:*` namespace and not `ui:*`: the existing ui:* tools
 * (list_clients/get_state/dispatch) all operate on the browser tab via
 * the ui_intents PG queue. ask_choice renders into the chat transcript,
 * a different concern. Future chat-render tools (show_progress,
 * show_diff) go here too.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

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

// Hard caps. The model should usually use 2-3 options; 6 is the
// absolute maximum (chat UI gets crowded past 4).
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
});

export default defineTool({
  name: 'chat:ask_choice',
  description:
    'Present the user with a structured set of clickable choices (e.g. "Do you want me to go into passive mode?" → [Yes, go passive] [No, stay active]). The chat dock renders the question + buttons; the user clicks one and their pick becomes the next user message. After calling this tool, end your turn — do not also write the question as text. Use for yes/no, accept/reject, or pick-one-of questions with up to 6 options. For open-ended prompts ("describe what you want", "paste the error"), keep using plain text.',
  capability: 'chat:write',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 10 }, operator: { perRun: 100 } },
  args: argsSchema,
  async handler(args) {
    // Hard back-stop against runaway content (Zod size caps are
    // per-field, not aggregate).
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

    // Normalize ids to lowercase so the model can write "Yes" and the
    // server stores "yes" consistently (matches the regex but case-
    // insensitive for the model's convenience).
    const normalized = {
      ...args,
      options: args.options.map((o) => ({ ...o, id: o.id.toLowerCase() })),
    };

    // Warn (don't reject) on style anti-patterns. These show up in
    // audit_log if/when we look back at "what did the model ask?"
    const primaries = normalized.options.filter((o) => o.style === 'primary').length;
    const dangers = normalized.options.filter((o) => o.style === 'danger').length;
    const warnings: string[] = [];
    if (primaries > 1) warnings.push(`multiple_primary: ${primaries} options marked primary`);
    if (dangers > 1) warnings.push(`multiple_danger: ${dangers} options marked danger`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          rendered: true,
          question: normalized.question,
          options: normalized.options,
          ...(warnings.length > 0 ? { warnings } : {}),
        }),
      }],
    };
  },
});
