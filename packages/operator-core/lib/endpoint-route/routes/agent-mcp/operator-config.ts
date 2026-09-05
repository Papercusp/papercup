/**
 * GET /api/agent-mcp/operator-config — prompt + preferences + substrate.
 * PUT — write prompt_user / preferences.
 * Ported from app/api/agent-mcp/operator-config/route.ts. `auth: 'public'`.
 */
import { OPERATOR_SUBSTRATE_PROMPT } from '../../../operator-prompt-system';
import { readOperatorState, writeOperatorState } from '../../../operator-state-pg';
import { defineTool } from '@papercusp/agent-mcp';

/**
 * Defaults shown when nothing has been stored yet. EXPORTED because the sync
 * resolver `operatorConfig.byWorkspace` (sync-resolver/index.ts) renders the
 * same editor and must fall back to the SAME text: it used to return '' where
 * this route returned the template, so the Settings › Papercup form seeded
 * empty from the sync read and a Save would have blanked the prompt
 * (EI-22439758558949990).
 */
export const DEFAULT_PROMPT_USER = `# Operator voice + free-form preferences

(Edit this to shape Operator's tone and any free-form preferences that
don't belong in the structured \`preferences.md\` notebook. The
substrate-owned prompt — schema, tier rules, anti-patterns — is shown
read-only below.)
`;

export const DEFAULT_PREFS = `# Operator preferences (workspace-scoped)

(empty)
`;

/** The one fallback rule both readers apply: a stored string wins, else the default. */
export function operatorConfigContent(raw: { content?: unknown } | null | undefined, fallback: string): string {
  return typeof raw?.content === 'string' ? raw.content : fallback;
}

const PROMPT_USER_LABEL = 'harness_shared.operator_prompt_user';
const PREFS_LABEL = 'harness_shared.operator_preferences';

async function readContent(
  table: 'operator_prompt_user' | 'operator_preferences',
  fallback: string,
): Promise<string> {
  const raw = await readOperatorState<{ content?: string }>(table);
  return typeof raw?.content === 'string' ? raw.content : fallback;
}

async function buildPayload() {
  const [prompt_user, preferences] = await Promise.all([
    readContent('operator_prompt_user', DEFAULT_PROMPT_USER),
    readContent('operator_preferences', DEFAULT_PREFS),
  ]);
  return {
    prompt_user,
    preferences,
    substrate_prompt: OPERATOR_SUBSTRATE_PROMPT,
    prompt_user_path: PROMPT_USER_LABEL,
    prefs_path: PREFS_LABEL,
  };
}

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-config',
  auth: 'public',
  async handler() {
    return Response.json(await buildPayload());
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/operator-config',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json()) as { prompt_user?: string; preferences?: string };
    if (typeof body.prompt_user === 'string') {
      await writeOperatorState('operator_prompt_user', { content: body.prompt_user });
    }
    if (typeof body.preferences === 'string') {
      await writeOperatorState('operator_preferences', { content: body.preferences });
    }
    return Response.json(await buildPayload());
  },
});

export default [get, put];
