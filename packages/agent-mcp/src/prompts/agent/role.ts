/**
 * `agent:role` — return the canonical role-prompt md for any agent role
 * (architect, orchestrator, scoper, worker, validator, debugger, …).
 *
 * Source of truth: libs/papercusp/packages/harness/prompts/<role>.md.
 * Returns the file content as a single system-role message. Used by
 * external clients that want to spin up an LLM session with the same
 * persona Papercusp uses internally.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { definePrompt } from '../../define-prompt';
import type { PromptResult } from '../../types';

const KNOWN_ROLES = [
  'architect',
  'orchestrator',
  'scoper',
  'worker',
  'validator',
  'reviewer',
  'documenter',
  'debugger',
  'curator',
  'expert',
  'feedback',
  'project_manager',
  'security-reviewer',
  'infra-reviewer',
  'summarizer',
  'crosscheck',
  'ui-qa',
] as const;

function findPromptsDir(): string | null {
  // Search candidates from this file outward; works in monorepo + standalone.
  const candidates = [
    resolve(__dirname, '../../../../../libs/papercusp/packages/harness/prompts'),
    resolve(__dirname, '../../../../libs/papercusp/packages/harness/prompts'),
    resolve(process.cwd(), 'libs/papercusp/packages/harness/prompts'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export default definePrompt({
  name: 'agent:role',
  description:
    'Return the canonical role prompt for a Papercusp agent role. Args: role.',
  arguments: [
    {
      name: 'role',
      description: `One of: ${KNOWN_ROLES.join(', ')}.`,
      required: true,
    },
  ],
  async render(args): Promise<PromptResult> {
    const role = args.role;
    if (!role || !KNOWN_ROLES.includes(role as (typeof KNOWN_ROLES)[number])) {
      throw new Error(
        `Unknown role "${role}". Known: ${KNOWN_ROLES.join(', ')}`,
      );
    }
    const dir = findPromptsDir();
    if (!dir) {
      throw new Error(
        'Could not locate libs/papercusp/packages/harness/prompts on disk.',
      );
    }
    const path = join(dir, `${role}.md`);
    if (!existsSync(path)) {
      throw new Error(`Role prompt not found: ${path}`);
    }
    const text = readFileSync(path, 'utf8');
    return {
      description: `Canonical ${role} role prompt.`,
      messages: [{ role: 'system', content: { type: 'text', text } }],
    };
  },
});
