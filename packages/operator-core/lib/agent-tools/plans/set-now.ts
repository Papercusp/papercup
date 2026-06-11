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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { maskFences } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';

const argsSchema = z.object({
  harness: harnessArg,
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
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — a short why behind this state change. Stored on the plan revision and shown in the revision timeline (D-009). Routine progress updates can omit it; the launch seed prefers substantive set-content rationales.',
    ),
});

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type SetNowValue = { ok: true } | { ok: false; code: 'not_found' };

export function replaceNowBlock(body: string, state: string, next: string): string {
  const block = `## Now\n\n**State:** ${state.trim()}\n\n**Next:** ${next.trim()}\n`;

  // Tolerant match — accept any "## [N.] Now" heading. The capture runs
  // from just after the heading line to the next `## ` heading OR the
  // end of the document. NOTE: JavaScript regex has no `\Z` anchor —
  // a literal `\Z` matches the character "Z" — so end-of-input must be
  // spelled `(?![\s\S])` ("no character follows"). The earlier `\Z`
  // form truncated the match at the first capital Z in the Now text
  // (corrupting the file), and when the Now block had no following
  // `## ` heading it failed to match at all and got duplicated by the
  // insert branch below.
  const nowRe = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Now\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m;
  // Locate against the fence-masked body so a `## Now` heading inside a
  // worked-example code fence is never matched. m.index / m[0].length
  // are valid against the real body (maskFences preserves length); the
  // splice replaces the whole old block, so any fenced content that was
  // inside it is correctly discarded with it. Index splice rather than
  // body.replace also keeps user-supplied state/next literal.
  const m = nowRe.exec(maskFences(body));
  if (m) {
    return body.slice(0, m.index) + block + '\n' + body.slice(m.index + m[0].length);
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
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<SetNowValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:set-now`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: SetNowValue }> => {
        if (current === null) {
          return { newBody: null, value: { ok: false, code: 'not_found' } };
        }
        const replaced = replaceNowBlock(current, args.state, args.next);
        const final = bumpUpdatedDate(replaced);
        return { newBody: final, value: { ok: true } };
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

    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'now_updated',
      after: args.next,
      detail: args.state.slice(0, 200),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          }),
        },
      ],
    };
  },
});
