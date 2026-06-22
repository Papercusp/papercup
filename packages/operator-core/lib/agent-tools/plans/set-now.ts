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
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).optional(),
  slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to update with the same Now block in one call.'),
  state: z
    .string()
    .min(1)
    .max(
      2000,
      'state must be ≤2000 chars. The Now block is a cold-resume ANCHOR, not a log — trim to the essentials; move long-form detail (backlog, history, design notes) into the plan body via plans:set-content / set-content-chunk, or onto plan items / decisions.',
    )
    .describe(
      'One paragraph (≤2000 chars) describing where the plan currently stands. Keep it tight — the Now block is a cold-resume anchor, NOT a log. If it would exceed 2000 chars, trim to essentials and put the long-form detail in the plan body via plans:set-content / set-content-chunk (or on items/decisions); do not pad the Now block.',
    ),
  next: z
    .string()
    .min(1)
    .max(
      800,
      'next must be ≤800 chars — it is ONE next concrete action, not a plan. Trim it; multi-step detail belongs in plan items or the body.',
    )
    .describe('One sentence (≤800 chars) — the single next concrete action and who should do it.'),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — a short why behind this state change. Stored on the plan revision and shown in the revision timeline (D-009). Routine progress updates can omit it; the launch seed prefers substantive set-content rationales.',
    ),
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
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
    "Replace the `## Now` block atomically. The Now block is the cold-resume anchor — the single most-read field, NOT a log: keep State ≤2000 chars + Next ≤800 (trim hard; long-form backlog/history/design detail belongs in the plan body via plans:set-content / set-content-chunk, not the Now block). Auto-bumps frontmatter updated:.",
  guidance: {
    when: 'Plan state advances meaningfully — phase boundaries, blocking discovery, finishing a chunk of work, picking up a new direction.',
    notWhen:
      'Per-item flip — that\'s plans:set-status. Or a decision — that\'s plans:add-decision.',
    chaining:
      'plans:set-status to flip current item → plans:set-now reflecting the new state. Keep State ≤2000 chars / Next ≤800 — if either overflows, trim it and offload the detail to plans:set-content / set-content-chunk rather than retrying a too-long Now.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const rev = planRevisionCapture(
          ctx as PlanRevisionCtx,
          slug,
          args.rationale,
          harnessSlug ? { harnessSlug } : {},
        );
        const result = await withPlanLock<SetNowValue>(
          ctx as never,
          {
            slug,
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
            ok: false as const,
            slug,
            error: 'busy',
            busy: result.busy.map((b) => ({
              path: b.path,
              owner_label: b.owner_label,
              intent: b.intent,
              expires_ts: b.expires_ts,
            })),
          };
        }

        if (!result.value.ok) {
          return { ok: false as const, slug, error: result.value.code };
        }

        await emitPlanEventForCaller(ctx, {
          planSlug: slug,
          event: 'now_updated',
          after: args.next,
          detail: args.state.slice(0, 200),
        });

        return {
          ok: true as const,
          slug,
          filePath: result.filePath,
          revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    return bulkContent(env);
  },
});
