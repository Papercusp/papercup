/**
 * Operator config endpoints (v5: prompt split).
 *
 * GET  /api/agent-mcp/operator-config
 *   → { prompt_user, preferences, substrate_prompt,
 *       prompt_user_path, prefs_path }
 *
 * PUT  /api/agent-mcp/operator-config
 *   body: { prompt_user?, preferences? }
 *
 * The substrate prompt (`OPERATOR_SUBSTRATE_PROMPT` from
 * `lib/operator-prompt-system.ts`) is read-only — it carries the
 * load-bearing tier-table + schema rules and ships with the substrate.
 * The user only edits voice/tone (`prompt_user`) and the workspace's
 * learned preferences (`preferences`).
 *
 * Storage: both `prompt_user` and `preferences` live in PG (migration 022,
 * `harness_shared.operator_prompt_user` and `harness_shared.operator_preferences`).
 * The runtime operator (`lib/operator-prompt.ts`, `lib/operator-preferences.ts`)
 * already reads from these tables — keeping this route file-backed left a
 * silent bifurcation where settings-UI edits never reached the operator.
 * `prompt_user_path` / `prefs_path` are now informational labels showing
 * the qualified table name; the settings page displays them in a code
 * block so the user can still see where the data lives.
 */

import { NextRequest, NextResponse } from 'next/server';
import { OPERATOR_SUBSTRATE_PROMPT } from '@/lib/operator-prompt-system';
import { readOperatorState, writeOperatorState } from '@/lib/operator-state-pg';

const DEFAULT_PROMPT_USER = `# Operator voice + free-form preferences

(Edit this to shape Operator's tone and any free-form preferences that
don't belong in the structured \`preferences.md\` notebook. The
substrate-owned prompt — schema, tier rules, anti-patterns — is shown
read-only below.)
`;

const DEFAULT_PREFS = `# Operator preferences (workspace-scoped)

(empty)
`;

const PROMPT_USER_LABEL = 'harness_shared.operator_prompt_user';
const PREFS_LABEL = 'harness_shared.operator_preferences';

async function readContent(
  table: 'operator_prompt_user' | 'operator_preferences',
  fallback: string,
): Promise<string> {
  const raw = await readOperatorState<{ content?: string }>(table);
  return typeof raw?.content === 'string' ? raw.content : fallback;
}

export async function GET() {
  const [prompt_user, preferences] = await Promise.all([
    readContent('operator_prompt_user', DEFAULT_PROMPT_USER),
    readContent('operator_preferences', DEFAULT_PREFS),
  ]);
  return NextResponse.json({
    prompt_user,
    preferences,
    substrate_prompt: OPERATOR_SUBSTRATE_PROMPT,
    prompt_user_path: PROMPT_USER_LABEL,
    prefs_path: PREFS_LABEL,
  });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { prompt_user?: string; preferences?: string };
  if (typeof body.prompt_user === 'string') {
    await writeOperatorState('operator_prompt_user', { content: body.prompt_user });
  }
  if (typeof body.preferences === 'string') {
    await writeOperatorState('operator_preferences', { content: body.preferences });
  }
  return GET();
}
