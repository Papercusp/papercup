/**
 * plans:set-now — replace the `## Now` block atomically.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2.
 *
 * The Now block is the cold-resume anchor. This verb rewrites just the
 * state+next pair, preserving the surrounding plan body.
 *
 * Tolerant heading match: any `## Now` (or `## 3. Now`, etc.) is found
 * and replaced. If no Now block exists, one is inserted directly after
 * the closing frontmatter `---` block, before the first body content.
 *
 * Writes inside a lock. Auto-bumps frontmatter updated:.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';

const SU_ROLES = [
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

const argsSchema = z.object({
  slug: z.string().min(1),
  state: z
    .string()
    .min(1)
    .max(2000)
    .describe('One paragraph describing where the plan currently stands.'),
  next: z
    .string()
    .min(1)
    .max(800)
    .describe('One sentence — the single next concrete action and who should do it.'),
});

export function replaceNowBlock(body: string, state: string, next: string): string {
  const block = `## Now\n\n**State:** ${state.trim()}\n\n**Next:** ${next.trim()}\n`;

  // Tolerant match — accept any "## [N.] Now" heading.
  const nowRe = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Now\b[^\n]*\n([\s\S]*?)(?=^##\s|\Z)/m;
  if (nowRe.test(body)) {
    return body.replace(nowRe, block + '\n');
  }
  // No Now block: insert after frontmatter close (or at top if none).
  if (body.startsWith('---')) {
    const close = body.indexOf('\n---', 3);
    if (close !== -1) {
      const afterClose = body.indexOf('\n', close + 4);
      const insertAt = afterClose === -1 ? body.length : afterClose + 1;
      return body.slice(0, insertAt) + '\n' + block + '\n' + body.slice(insertAt);
    }
  }
  return block + '\n' + body;
}

export default defineTool({
  name: 'plans:set-now',
  description:
    "Replace the `## Now` block atomically. The Now block is the cold-resume anchor — the single most-read field. Auto-bumps frontmatter updated:.",
  guidance: {
    when: 'Plan state advances meaningfully — phase boundaries, blocking discovery, finishing a chunk of work, picking up a new direction.',
    notWhen:
      'Per-item flip — that\'s plans:set-status. Or a decision — that\'s plans:add-decision.',
    chaining:
      'plans:set-status to flip current item → plans:set-now reflecting the new state.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  roles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const result = await withPlanLock(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-now`,
      },
      async (current) => {
        if (current === null) {
          return { newBody: null, value: { ok: false as const, code: 'not_found' as const } };
        }
        const replaced = replaceNowBlock(current, args.state, args.next);
        const final = bumpUpdatedDate(replaced);
        return { newBody: final, value: { ok: true as const } };
      },
    );

    if (result.kind === 'busy') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'busy',
              busy: result.busy.map((b) => ({
                path: b.path,
                owner_label: b.owner_label,
                intent: b.intent,
                expires_ts: b.expires_ts,
              })),
            }),
          },
        ],
        isError: true,
      };
    }

    if (!result.value.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.value.code, slug: args.slug }) }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, filePath: result.filePath }) }],
    };
  },
});
