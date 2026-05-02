/**
 * Operator prompt assembly.
 *
 * Builds the full prompt sent to Claude when the user opens the Operator
 * panel and triggers a scan, or interacts via the conversation thread.
 *
 * Composition (top to bottom):
 *   1. The first-run intro block (only if it's the user's first interaction
 *      with Operator in this workspace — gated by a marker file).
 *   2. The user-editable system prompt (apps/operator/api/agent-mcp/operator-config).
 *   3. The user-editable preferences notebook (workspace-scoped).
 *   4. A short auth/identity reminder.
 *   5. Tool catalog summary (so the LLM doesn't have to call tools/list).
 *   6. The current request — typically "scan the workspace, suggest next
 *      actions" or a freeform user message.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { papercuspPath } from './papercusp-root';

function OPERATOR_DIR() { return papercuspPath('system', 'operator'); }
const PROMPT_PATH = join(OPERATOR_DIR(), 'prompt.md');
const PREFS_PATH = join(OPERATOR_DIR(), 'preferences.md');
const FIRST_RUN_MARKER = join(OPERATOR_DIR(), '.first-run-shown');

const FIRST_RUN_INTRO = `\
Hi, I'm the Operator. I have full write authority across all harnesses
in this workspace and will work with you to implement your vision.

By default, any far-reaching or underspecified actions I will surface to
you before proceeding. I'll learn your preferences through our
interactions, so please correct me if I behave in a way you didn't like
so I can adjust for next time.

You can also edit my system prompt directly, and I keep a separate
notebook of preferences I've learned about you in this workspace —
both are editable from my settings page (/settings/operator).
`;

function read(p: string, def: string): string {
  if (!existsSync(p)) return def;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return def;
  }
}

export interface BuildPromptArgs {
  /** The user's request, or 'scan' for an unprompted scan. */
  request: string;
  /** Force the first-run intro even if the marker exists. */
  showFirstRun?: boolean;
}

export interface BuildPromptResult {
  promptText: string;
  isFirstRun: boolean;
}

export function buildOperatorPrompt(args: BuildPromptArgs): BuildPromptResult {
  const isFirstRun = args.showFirstRun ?? !existsSync(FIRST_RUN_MARKER);

  const userPrompt = read(PROMPT_PATH, '');
  const prefs = read(PREFS_PATH, '').trim();

  const sections: string[] = [];

  if (isFirstRun) {
    sections.push(FIRST_RUN_INTRO);
  }

  if (userPrompt.trim()) {
    sections.push(userPrompt.trim());
  }

  if (prefs) {
    sections.push(`## Preferences (workspace-scoped, learned)\n\n${prefs}`);
  }

  sections.push(`\
## How to act

- Use the Agent MCP tools to scan workspace state. Start with
  \`harness:list\`, \`tasks:list\`, and \`pending_events:list\`.
- Compose suggestions as JSON cards in your final response, one per
  \`<suggestion>\` block. Schema:

  <suggestion>
  {
    "title": "short imperative",
    "why": "one or two sentences citing what state triggered this",
    "action": "send_directive" | "open" | "draft" | "advise",
    "target_harness": "<slug>" | null,
    "directive_kind": "Directive" | "Decision" | "Priority" | null,
    "directive_subject": "<short>",
    "directive_body": "<full directive body>",
    "auto_dispatch": true | false,
    "reason": "why I'm classifying this as auto vs ask-first (>= 10 chars)"
  }
  </suggestion>

- Dispatch by emitting auto_dispatch=true with a non-empty
  directive_body. The operator app will route this through the
  \`messages:write\` tool with kind='Directive'.
- For underspecified or far-reaching actions, set auto_dispatch=false;
  the user will approve in the panel.
- After the suggestion blocks, write a short status sentence (no JSON).
  Example: "Scanned 7 harnesses, surfaced 3 suggestions, 1 would auto-dispatch."

## Identity

You are running as principal "system:operator" in workspace "<workspace_id>".
Your bearer token is supplied via env (you don't need to use it directly;
your tools handle auth).
`);

  sections.push(`## Request\n\n${args.request}`);

  const promptText = sections.join('\n\n---\n\n');
  return { promptText, isFirstRun };
}

/** Mark first-run as shown so subsequent calls don't repeat the intro. */
export function markFirstRunShown(): void {
  mkdirSync(dirname(FIRST_RUN_MARKER), { recursive: true });
  writeFileSync(FIRST_RUN_MARKER, new Date().toISOString());
}
