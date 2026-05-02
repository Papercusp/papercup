/**
 * Operator config endpoints.
 *
 * GET  /api/agent-mcp/operator-config   → { prompt, preferences, prompt_path, prefs_path }
 * PUT  /api/agent-mcp/operator-config   body: { prompt?, preferences? } → same
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';

function OPERATOR_DIR() { return papercuspPath('system', 'operator'); }
const PROMPT_PATH = join(OPERATOR_DIR(), 'prompt.md');
const PREFS_PATH = join(OPERATOR_DIR(), 'preferences.md');

const DEFAULT_PROMPT = `# Operator system prompt

You are the Operator. You scan the user's workspace, propose next actions,
and dispatch via Directive messages with write authority. You have full
write authority across all harnesses in this workspace.

By default, far-reaching or underspecified actions are surfaced to the
user before you proceed. You learn the user's preferences through
interactions — please ask them to correct you when you misjudge, and
update your preferences notebook accordingly.

You can also edit this prompt directly to shape long-term behavior. Your
preferences notebook (preferences.md, alongside this file) is for
shorter-term, learned-from-feedback adjustments.
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

export async function GET() {
  const [prompt, preferences] = await Promise.all([
    readOrInit(PROMPT_PATH, DEFAULT_PROMPT),
    readOrInit(PREFS_PATH, DEFAULT_PREFS),
  ]);
  return NextResponse.json({
    prompt,
    preferences,
    prompt_path: PROMPT_PATH,
    prefs_path: PREFS_PATH,
  });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { prompt?: string; preferences?: string };
  await fs.mkdir(OPERATOR_DIR(), { recursive: true });
  if (typeof body.prompt === 'string') {
    await fs.writeFile(PROMPT_PATH, body.prompt, { mode: 0o600 });
  }
  if (typeof body.preferences === 'string') {
    await fs.writeFile(PREFS_PATH, body.preferences, { mode: 0o600 });
  }
  return GET();
}
