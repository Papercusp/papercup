/**
 * plans:add-decision — append a new decision with allocated D-NNN id.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2 + §4.4.
 *
 * ID allocation MUST happen inside the lock — two concurrent calls
 * without serialization would both observe the same "max D-NNN" and
 * produce colliding ids. The withPlanLock helper holds the lock across
 * read → allocate → write.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan } from './parser';

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
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  refs: z
    .array(z.string().regex(/^P-\d{3,}$/))
    .optional()
    .describe('Item IDs this decision relates to. Appear in the body as P-NNN tokens.'),
});

function formatPadded(n: number): string {
  return n.toString().padStart(3, '0');
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Allocate the next D-NNN considering ONLY real parsed decisions.
 *
 * Same rationale as allocateNextItemId — references to D-NNN inside
 * prose or example fences must not bump the allocator.
 */
export function allocateNextDecisionId(body: string): string {
  const parsed = parsePlan(body);
  let max = 0;
  for (const d of parsed.decisions) {
    const m = /^D-(\d+)$/.exec(d.id);
    if (m) {
      const n = parseInt(m[1] ?? '0', 10);
      if (n > max) max = n;
    }
  }
  return `D-${formatPadded(max + 1)}`;
}

export function appendDecisionToBody(
  body: string,
  decisionId: string,
  title: string,
  decisionBody: string,
  date: string,
  refs: string[],
): string {
  const refsLine =
    refs.length > 0 ? `\nRelated: ${refs.join(', ')}` : '';
  const block =
    `\n### ${decisionId} — ${title.trim()}\n` +
    `Date: ${date}\n` +
    `${decisionBody.trim()}${refsLine}\n`;

  // Find the `## Decisions` (tolerant) section. Insert at its end.
  const headingRe = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Decisions\b[^\n]*$/m;
  const headingMatch = headingRe.exec(body);
  if (headingMatch) {
    // Find the start of the next `## ` heading after this one, or end of file.
    const after = headingMatch.index + headingMatch[0].length;
    const restAfter = body.slice(after);
    const nextHeadingRe = /^##\s/m;
    const nextHeadingMatch = nextHeadingRe.exec(restAfter);
    if (nextHeadingMatch) {
      const insertAt = after + nextHeadingMatch.index;
      // Ensure trailing newline before the next heading.
      let prefix = body.slice(0, insertAt);
      if (!prefix.endsWith('\n')) prefix += '\n';
      return prefix + block + '\n' + body.slice(insertAt);
    }
    // No subsequent heading — append at file end.
    let withTrailingNL = body;
    if (!withTrailingNL.endsWith('\n')) withTrailingNL += '\n';
    return withTrailingNL + block;
  }
  // No Decisions section — append one at file end.
  let withTrailingNL = body;
  if (!withTrailingNL.endsWith('\n')) withTrailingNL += '\n';
  return withTrailingNL + `\n## Decisions\n${block}`;
}

export default defineTool({
  name: 'plans:add-decision',
  description:
    'Append a new decision to a plan. Allocates the next D-NNN id inside a lock (concurrent calls produce non-colliding ids). Auto-bumps frontmatter updated:.',
  guidance: {
    when: 'A decision-shaped output: trade-off resolved, scope ratified, choice made between options. Capture so a fresh agent doesn\'t relitigate.',
    notWhen:
      'Adding work units — use plans:add-item. Flipping status — plans:set-status. Updating overall state — plans:set-now.',
    chaining:
      'plans:add-decision → optionally plans:set-now referencing the new D-NNN in **State:**.',
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
        intent: `plans:add-decision: ${args.title.slice(0, 60)}`,
      },
      async (current) => {
        if (current === null) {
          return { newBody: null, value: { ok: false as const, code: 'not_found' as const } };
        }
        const parsed = parsePlan(current, { filePath: args.slug + '.md' });
        if (parsed.isLegacy) {
          return { newBody: null, value: { ok: false as const, code: 'legacy_plan' as const } };
        }
        const decisionId = allocateNextDecisionId(current);
        const appended = appendDecisionToBody(
          current,
          decisionId,
          args.title,
          args.body,
          todayISO(),
          args.refs ?? [],
        );
        const final = bumpUpdatedDate(appended);
        return {
          newBody: final,
          value: { ok: true as const, decisionId, slug: args.slug },
        };
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
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: result.value.code, slug: args.slug }) },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, ...result.value, filePath: result.filePath }) },
      ],
    };
  },
});
