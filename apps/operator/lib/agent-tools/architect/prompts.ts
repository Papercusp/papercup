/**
 * Prompt composition for architect:chat + brainstorm:chat. Extracted
 * here so the tool handlers can be self-contained (IPC allowlist
 * eligibility): every disk/PG read that builds the prompt lives in
 * one place, dispatched by the tool itself rather than the Hono route
 * shim.
 *
 * Layering note: imports `harnessDir`/`safeRead`/`parseFeatures`/
 * `resolvePhasedProject` from `app/api/_hono/harness.ts`. That's a
 * reverse-direction edge (lib → app) — flagged because the helpers
 * predate this split and have many other call-sites on the route side.
 * Folding them into a `lib/harness/project.ts` is a documented future
 * refactor; for now, this file is the only place outside `app/api/`
 * that imports from harness.ts, so the smell is bounded.
 */

import { join } from 'node:path';
import {
  type ProjectEntry,
  harnessDir,
  safeRead,
  parseFeatures,
  resolvePhasedProject,
} from '@/app/api/_hono/harness';
import { type Phase, phasePhaseLabel } from '@/lib/harness-phases';
import { buildMemoryContextBlock } from '@/lib/memory/injection';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export type ChatHistoryEntry = { role: 'user' | 'assistant'; content: string };

function reviewsDir(project: ProjectEntry): string {
  return join(harnessDir(project), 'pending-reviews');
}

function brainstormPath(project: ProjectEntry): string {
  return join(harnessDir(project), 'brainstorm.md');
}

export async function resolveSlug(
  slug: string,
  phase: string | undefined,
): Promise<ProjectEntry | null> {
  return resolvePhasedProject(slug, phasePhaseLabel(phase));
}

export async function composeArchitectPrompt(
  project: ProjectEntry,
  history: ChatHistoryEntry[],
  message: string,
  reviewId?: string,
): Promise<string> {
  const spec = safeRead(join(project.path, 'SPEC.md')) ?? '';
  const contract = safeRead(join(harnessDir(project), 'validation-contract.md')) ?? '';
  const featuresList = await parseFeatures(project);
  const features = JSON.stringify(
    { features: featuresList.map((f) => ({ id: f.id, title: f.title, status: f.status, attempts: f.attempts })) },
    null,
    2,
  );
  const issues = safeRead(join(harnessDir(project), 'issues.md')) ?? '';
  let reviewContext = '';
  if (reviewId) {
    const rpath = join(reviewsDir(project), `${reviewId.replace(/[^A-Za-z0-9_.-]/g, '')}.json`);
    const rraw = safeRead(rpath);
    if (rraw) reviewContext = `\n\n## Pending review in context\n\n${rraw}\n`;
  }

  const systemPrompt = `You are the ARCHITECT in an autonomous coding harness, chatting with the human supervisor through the /harness Inbox.

Your job is to help them clarify the spec: ask Socratic questions about any vagueness until the user's intent is precise and testable, then propose a concrete change to SPEC.md or .harness/validation-contract.md.

Current state:

## SPEC.md
${spec.slice(0, 8000)}

## validation-contract.md
${contract.slice(0, 6000)}

## features (harness_features in Postgres — summary)
${features.slice(0, 3000)}

## issues.md tail
${issues.slice(-3000)}
${reviewContext}

Rules:
- Prefer short, pointed clarifying questions over long speeches.
- When you're ready to propose a change, emit a fenced block. The UI shows the user a summary + Accept button; they trust you on the mechanical details.

Format for file replacements:
\`\`\`proposal:SPEC.md
SUMMARY: <1–3 sentences in plain English: what will change and why. This is the ONLY text the user reads by default.>
---
<complete replacement file contents — verbatim, nothing elided>
\`\`\`

Use \`proposal:SPEC.md\` or \`proposal:contract\` as the fence language. First line after the fence MUST start with \`SUMMARY:\` then human-facing text; then a line \`---\`; then the full replacement body.

For a supervisor note (short message appended, not replacing a file):
\`\`\`note:supervisor
<text that appends to supervisor-notes.md>
\`\`\`

Rules for proposals:
- The summary is what the user sees. Make it precise and plain-English. No jargon without definition.
- The body must be complete — do not elide. The UI writes it verbatim on Accept.
- Be decisive but never fabricate facts. If you don't know a constraint, ask instead of proposing.`;

  // Workspace-scope memory injection (architect has no session user;
  // workspace shared memory is the right grain). Rebase-note adoption:
  // unlocks "the architect remembers prior design decisions" with no
  // new infrastructure.
  const memBlock = await buildMemoryContextBlock({
    userId: null,
    workspaceId: activeWorkspaceId(),
    queryContext: message,
    heading: 'Architect memory (relevant entries)',
  });
  const memorySection = memBlock ? `\n\n---\n\n${memBlock}` : '';

  const trimmed = history.slice(-10);
  const fullPrompt = [
    ...trimmed.map((m) => `${m.role === 'user' ? 'User' : 'Architect'}: ${m.content}`),
    `User: ${message}`,
    'Architect:',
  ].join('\n\n');

  return `${systemPrompt}${memorySection}\n\n---\n\n${fullPrompt}\n`;
}

export async function composeBrainstormPrompt(
  project: ProjectEntry,
  history: ChatHistoryEntry[],
  message: string,
): Promise<string> {
  const spec = safeRead(join(project.path, 'SPEC.md')) ?? '';
  const brainstorm = safeRead(brainstormPath(project)) ?? '';
  const featuresList = await parseFeatures(project);
  const features = JSON.stringify(
    { features: featuresList.map((f) => ({ id: f.id, title: f.title, status: f.status })) },
    null,
    2,
  );

  const systemPrompt = `You are a BRAINSTORM PARTNER for a software project. You're chatting with the human supervisor of a coding harness to help them explore ideas before they become features.

Your job: expand the space of possibilities. Suggest analogues, probe "have you considered…", challenge hidden assumptions. You are expansive, not reductive. This is pre-SPEC ideation — nothing needs to be final yet.

Current state:

## SPEC.md
${spec.slice(0, 6000)}

## Existing features (harness_features in Postgres — summary)
${features.slice(0, 2000)}

## Brainstorm scratchpad (what the user is working on)
${brainstorm.slice(0, 8000)}

Rules:
- Lead with ideas, tradeoffs, analogues from other domains. Be concrete.
- When an idea matures enough to be acted on, emit a fenced action block:
  - \`\`\`promote:feature — create a new todo feature in harness_features. Put a short title on the first line, then markdown body explaining intent + optional claims.
  - \`\`\`promote:spec — insert into SPEC.md under a "## Brainstormed" section.
  - \`\`\`promote:issue — file as an issue in issues.json. First line is title; rest is evidence/context.
- Don't promote too eagerly. Wait until the user signals the idea is ready, or ask them first.
- Keep responses short and punchy. Long speeches kill brainstorming.`;

  // Workspace-scope memory injection (same shape as architect).
  const memBlock = await buildMemoryContextBlock({
    userId: null,
    workspaceId: activeWorkspaceId(),
    queryContext: message,
    heading: 'Brainstorm memory (relevant entries)',
  });
  const memorySection = memBlock ? `\n\n---\n\n${memBlock}` : '';

  const trimmed = history.slice(-10);
  const fullPrompt = [
    ...trimmed.map((m) => `${m.role === 'user' ? 'User' : 'Partner'}: ${m.content}`),
    `User: ${message}`,
    'Partner:',
  ].join('\n\n');

  return `${systemPrompt}${memorySection}\n\n---\n\n${fullPrompt}\n`;
}
