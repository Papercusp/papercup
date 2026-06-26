/**
 * plans:add-decision — append one OR many new decisions with allocated D-NNN ids.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2 + §4.4.
 *
 * ID allocation MUST happen inside the lock — two concurrent calls
 * without serialization would both observe the same "max D-NNN" and
 * produce colliding ids. The withPlanLock helper holds the lock across
 * read → allocate → write.
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, title, body }, or many decisions (any plan) via
 * items:[{ slug, title, body, refs?, affects? }] → { ok, results:[{ ok, slug,
 * decisionId, propagated_to? | error }], counts }. This is a PLAN-level write, so
 * the self-describing key is { slug } and each result also carries its NEW
 * decisionId. Correlate by id not array position; one failure never fails the rest.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, maskFences } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { readPlanBySlug } from './source';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { emitDecisionAdded } from '../../harness/usage-emitters';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { hardText, LIMITS } from '../limits';

const REFS = z
  .array(z.string().regex(/^P-\d{3,}$/))
  .describe('Item IDs this decision relates to. Appear in the body as P-NNN tokens.');

const AFFECTS = z
  .array(z.string().min(1))
  .max(20)
  .describe(
    'Slugs of OTHER plans this decision bears on. The decision stays canonically in `slug`; each affected plan gets a cross-reference plan_event + a notify to its watchers. Never duplicates the decision.',
  );

const itemSpec = z.object({
  slug: z.string().min(1),
  title: hardText(LIMITS.SHORT_TITLE),
  body: hardText(5000),
  refs: REFS.optional(),
  affects: AFFECTS.optional(),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z.string().optional().describe('per-item revision rationale (else the batch `rationale`)'),
});

const argsSchema = z
  .object({
    slug: z.string().min(1).optional(),
    harness: harnessArg,
    title: hardText(LIMITS.SHORT_TITLE).optional(),
    body: hardText(5000).optional(),
    refs: REFS.optional(),
    affects: AFFECTS.optional(),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('add many decisions at once — each { slug, title, body, refs?, affects?, harness? }'),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional — a short why for this revision. A decision body already carries its own reasoning, so this is rarely needed. Stored on the plan revision (D-009).',
      ),
  })
  .refine(
    (a) => (a.items?.length ?? 0) > 0 || (Boolean(a.slug) && Boolean(a.title) && Boolean(a.body)),
    { message: 'pass { slug, title, body } for one, or items:[{ slug, title, body }] for many' },
  );

interface NewDecision {
  slug: string;
  title: string;
  body: string;
  refs?: string[];
  affects?: string[];
  harness?: string;
  rationale?: string;
}

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

/** Append ONE decision, returning the self-describing bulk result. PRESERVES the
 *  in-lock allocate → append → bump, the revision capture, the P-070 usage ledger,
 *  the plan-event emit, AND the cross-plan `affects` propagation. The new decisionId
 *  rides the result; not_found / legacy_plan / busy map to this item's failure. */
async function addDecisionOne(it: NewDecision, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  const sctx = harnessScopedCtx(it.harness, ctx);
  const harnessSlug = resolveCtxHarnessSlug(sctx);
  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    it.slug,
    it.rationale,
    harnessSlug ? { harnessSlug } : {},
  );
  const result = await withPlanLock<AddDecisionValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:add-decision: ${it.title.slice(0, 60)}`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: AddDecisionValue }> => {
      if (current === null) {
        return { newBody: null, value: { ok: false, code: 'not_found' } };
      }
      const parsed = parsePlan(current, { filePath: it.slug + '.md' });
      if (parsed.isLegacy) {
        return { newBody: null, value: { ok: false, code: 'legacy_plan' } };
      }
      const decisionId = allocateNextDecisionId(current);
      const appended = appendDecisionToBody(current, decisionId, it.title, it.body, todayISO(), it.refs ?? []);
      const final = bumpUpdatedDate(appended);
      return {
        newBody: final,
        value: { ok: true, decisionId, slug: it.slug },
      };
    },
  );

  if (result.kind === 'busy') {
    return {
      ok: false,
      slug: it.slug,
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
    return { ok: false, slug: it.slug, error: result.value.code };
  }

  // `result.value` is narrowed to the ok-variant by the guard above.
  const decisionId = result.value.decisionId;
  // P-070 usage ledger (best-effort): a decision is contributor activity on a
  // managed harness. Operator-level plans (harness:'all') have no harness slug
  // and the ledger is per-harness, so skip those.
  if (harnessSlug) void emitDecisionAdded(harnessSlug, decisionId);
  await emitPlanEventForCaller(ctx, {
    planSlug: it.slug,
    event: 'decision_added',
    detail: decisionId,
    after: it.title,
  });

  // Cross-plan propagation (agent-coordination-architecture-v2 §6.4 #7).
  // For each OTHER plan this decision affects: emit a cross-reference
  // plan_event scoped to the affected plan (so its history/sidebar
  // surfaces the incoming decision) and fire a notify to that plan's
  // watchers. The decision itself is NOT duplicated — it lives only in
  // `it.slug`; affected plans merely reference it. Unknown slugs are
  // reported back rather than silently skipped.
  const affects = normalizeAffects(it.affects, it.slug);
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
      detail: `${decisionId} (cross-ref from ${it.slug})`,
      after: it.title,
    });
    propagatedTo.push(affectedSlug);
  }

  return {
    ...result.value,
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    ...(propagatedTo.length > 0 ? { propagated_to: propagatedTo } : {}),
    ...(unknownAffects.length > 0 ? { unknown_affects: unknownAffects } : {}),
  };
}

export default defineTool({
  name: 'plans:add-decision',
  description:
    "Append one OR many new decisions to a plan. Allocates the next D-NNN id inside a lock (concurrent calls produce non-colliding ids). Auto-bumps frontmatter updated:. Single: { slug, title, body }. Many: items:[{ slug, title, body, refs?, affects? }]. Returns { ok, results:[{ ok, slug, decisionId, propagated_to? | error }], counts } — each result embeds the NEW decisionId; correlate by id, not position; one failure never fails the rest.",
  guidance: {
    when: "A decision-shaped output: trade-off resolved, scope ratified, choice made between options. Capture so a fresh agent doesn't relitigate. Add several at once via items:[…].",
    notWhen:
      'Adding work units — use plans:add-item. Flipping status — plans:set-status. Updating overall state — plans:set-now.',
    chaining:
      'plans:add-decision → optionally plans:set-now referencing the new D-NNN in **State:**.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: NewDecision[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          title: it.title,
          body: it.body,
          refs: it.refs ?? args.refs,
          affects: it.affects ?? args.affects,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : [
          {
            slug: args.slug as string,
            title: args.title as string,
            body: args.body as string,
            refs: args.refs,
            affects: args.affects,
            harness: args.harness,
            rationale: args.rationale,
          },
        ];
    const env = await runBulk(list, (it) => addDecisionOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug }),
    });
    return bulkContent(env);
  },
});
