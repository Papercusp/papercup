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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, maskFences } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { readPlanBySlug } from './source';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { emitDecisionAdded } from '../../harness/usage-emitters';

const argsSchema = z.object({
  slug: z.string().min(1),
  harness: harnessArg,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  refs: z
    .array(z.string().regex(/^P-\d{3,}$/))
    .optional()
    .describe('Item IDs this decision relates to. Appear in the body as P-NNN tokens.'),
  affects: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      'Slugs of OTHER plans this decision bears on. The decision stays canonically in `slug`; each affected plan gets a cross-reference plan_event + a notify to its watchers. Never duplicates the decision.',
    ),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — a short why for this revision. A decision body already carries its own reasoning, so this is rarely needed. Stored on the plan revision (D-009).',
    ),
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

/**
 * Normalise an `affects` slug list: drop the home plan's own slug (a
 * decision can't cross-reference its own home) and de-duplicate so a
 * caller passing the same slug twice doesn't propagate twice.
 */
export function normalizeAffects(
  affects: string[] | undefined,
  homeSlug: string,
): string[] {
  return [...new Set((affects ?? []).filter((s) => s !== homeSlug))];
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

  // Find the `## Decisions` section — allowing a numbered prefix
  // ("## 5. Decisions") and trailing whitespace ONLY. A heading with a
  // suffix like "## Decisions (settled)" is a DIFFERENT section and
  // must never absorb new decisions (EI-141 / audit P-041).
  // Locate against the fence-masked body so a `## Decisions` heading
  // inside a worked-example fence is skipped; splice the real body by
  // index (maskFences preserves length, so indices are interchangeable).
  const masked = maskFences(body);
  const headingRe = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Decisions\s*$/m;
  const headingMatch = headingRe.exec(masked);
  // Collapse any run of trailing newlines to exactly one before gluing
  // the block on (whose leading \n supplies the single separating blank
  // line) — a splice point that already sat on a blank line otherwise
  // stacks doubles (EI-141 / audit P-041).
  const oneTrailingNL = (s: string) =>
    s.endsWith('\n') ? s.replace(/\n+$/, '\n') : s + '\n';
  if (headingMatch) {
    // Find the start of the next `## ` heading after this one, or end of file.
    const after = headingMatch.index + headingMatch[0].length;
    const restAfter = masked.slice(after);
    const nextHeadingRe = /^##\s/m;
    const nextHeadingMatch = nextHeadingRe.exec(restAfter);
    if (nextHeadingMatch) {
      const insertAt = after + nextHeadingMatch.index;
      return oneTrailingNL(body.slice(0, insertAt)) + block + '\n' + body.slice(insertAt);
    }
    // No subsequent heading — append at file end.
    return oneTrailingNL(body) + block;
  }
  // No Decisions section — append one at file end.
  return oneTrailingNL(body) + `\n## Decisions\n${block}`;
}

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type AddDecisionValue =
  | { ok: true; decisionId: string; slug: string }
  | { ok: false; code: 'not_found' | 'legacy_plan' };

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
    const result = await withPlanLock<AddDecisionValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:add-decision: ${args.title.slice(0, 60)}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: AddDecisionValue }> => {
        if (current === null) {
          return { newBody: null, value: { ok: false, code: 'not_found' } };
        }
        const parsed = parsePlan(current, { filePath: args.slug + '.md' });
        if (parsed.isLegacy) {
          return { newBody: null, value: { ok: false, code: 'legacy_plan' } };
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
          value: { ok: true, decisionId, slug: args.slug },
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

    // `result.value` is narrowed to the ok-variant by the guard above.
    const decisionId = result.value.decisionId;
    // P-070 usage ledger (best-effort): a decision is contributor activity on a
    // managed harness. Operator-level plans (harness:'all') have no harness slug
    // and the ledger is per-harness, so skip those.
    if (harnessSlug) void emitDecisionAdded(harnessSlug, decisionId);
    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'decision_added',
      detail: decisionId,
      after: args.title,
    });

    // Cross-plan propagation (agent-coordination-architecture-v2 §6.4 #7).
    // For each OTHER plan this decision affects: emit a cross-reference
    // plan_event scoped to the affected plan (so its history/sidebar
    // surfaces the incoming decision) and fire a notify to that plan's
    // watchers. The decision itself is NOT duplicated — it lives only in
    // `args.slug`; affected plans merely reference it. Unknown slugs are
    // reported back rather than silently skipped.
    const affects = normalizeAffects(args.affects, args.slug);
    const propagatedTo: string[] = [];
    const unknownAffects: string[] = [];
    for (const affectedSlug of affects) {
      const exists = await readPlanBySlug(affectedSlug);
      if (!exists) {
        unknownAffects.push(affectedSlug);
        continue;
      }
      await emitPlanEventForCaller(ctx, {
        planSlug: affectedSlug,
        event: 'decision_added',
        detail: `${decisionId} (cross-ref from ${args.slug})`,
        after: args.title,
      });
      propagatedTo.push(affectedSlug);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...result.value,
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
            ...(propagatedTo.length > 0 ? { propagated_to: propagatedTo } : {}),
            ...(unknownAffects.length > 0 ? { unknown_affects: unknownAffects } : {}),
          }),
        },
      ],
    };
  },
});
