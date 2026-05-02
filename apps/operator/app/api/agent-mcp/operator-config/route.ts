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
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { OPERATOR_SUBSTRATE_PROMPT } from '@/lib/operator-prompt-system';

function OPERATOR_DIR() { return papercuspPath('system', 'operator'); }
const PROMPT_USER_PATH = () => join(OPERATOR_DIR(), 'prompt-user.md');
const PROMPT_LEGACY_PATH = () => join(OPERATOR_DIR(), 'prompt.md');
const PREFS_PATH = () => join(OPERATOR_DIR(), 'preferences.md');

const DEFAULT_PROMPT_USER = `# Operator voice + free-form preferences

(Edit this to shape Operator's tone and any free-form preferences that
don't belong in the structured \`preferences.md\` notebook. The
substrate-owned prompt — schema, tier rules, anti-patterns — is shown
read-only below.)
`;

const DEFAULT_PREFS = `# Operator preferences (workspace-scoped)

(empty)
`;

async function readOrInit(path: string, def: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, def, { mode: 0o600 });
    return def;
  }
}

/**
 * Migrate a legacy `prompt.md` into `prompt-user.md` once. Best-effort —
 * if the rename fails the user just sees the default scaffold and their
 * old prompt remains on disk untouched.
 */
async function migrateLegacyPromptOnce(): Promise<void> {
  try {
    const userExists = await fs.stat(PROMPT_USER_PATH()).then(() => true, () => false);
    if (userExists) return;
    const legacy = await fs.readFile(PROMPT_LEGACY_PATH(), 'utf8');
    if (!legacy?.trim()) return;
    await fs.writeFile(PROMPT_USER_PATH(), legacy, { mode: 0o600 });
  } catch {
    /* no legacy file — nothing to migrate */
  }
}

export async function GET() {
  await migrateLegacyPromptOnce();
  const [prompt_user, preferences] = await Promise.all([
    readOrInit(PROMPT_USER_PATH(), DEFAULT_PROMPT_USER),
    readOrInit(PREFS_PATH(), DEFAULT_PREFS),
  ]);
  return NextResponse.json({
    prompt_user,
    preferences,
    substrate_prompt: OPERATOR_SUBSTRATE_PROMPT,
    prompt_user_path: PROMPT_USER_PATH(),
    prefs_path: PREFS_PATH(),
  });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { prompt_user?: string; preferences?: string };
  await fs.mkdir(OPERATOR_DIR(), { recursive: true });
  if (typeof body.prompt_user === 'string') {
    await fs.writeFile(PROMPT_USER_PATH(), body.prompt_user, { mode: 0o600 });
  }
  if (typeof body.preferences === 'string') {
    await fs.writeFile(PREFS_PATH(), body.preferences, { mode: 0o600 });
  }
  return GET();
}
