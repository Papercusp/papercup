/**
 * plans:add-item — append a new P-NNN item to a phase.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2 + §4.4.
 *
 * Allocates the next P-NNN id inside the lock. Two concurrent calls
 * without serialization would produce colliding ids; withPlanLock
 * holds the lock across read → allocate → write.
 *
 * Appends to a phase by its heading text (tolerant match — leading
 * `N. ` numbering stripped). Creates the phase section if it doesn't
 * exist, inserted before `## Decisions` (or at file end).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, maskFences, IMPORTANCE_LEVELS, type Importance } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';

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

export const argsSchema = z.object({
  slug: z.string().min(1),
  harness: harnessArg,
  phase: z
    .string()
    .min(1)
    .regex(
      /^Phase\b/i,
      'Phase heading must start with "Phase" (e.g. "Phase 1 — Tooling") — the plan parser only recognizes /^Phase\\b/i headings as phase sections, so anything else lint-warns as unphased.',
    )
    .describe('Phase heading text without the ## prefix and without numbering, e.g. "Phase 1 — Tooling".'),
  text: z.string().min(1).max(800),
  blockedBy: z
    .array(z.string().regex(/^P-\d{3,}$/))
    .optional()
    .describe('Item IDs that must complete before this one can effectively start.'),
  importance: z
    .enum([...IMPORTANCE_LEVELS] as [string, ...string[]])
    .describe(
      'REQUIRED. Item importance — urgent|high|normal|low. urgent = interrupt the human now / pick up first; high = should be seen today; normal = usual cadence; low = safe to defer. No silent default: choose it deliberately from the importance rubric (decide from consequences — "what breaks, and how fast, if this is never seen / picked up last?"). Most routine items are `normal`.',
    ),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — a short why for adding this item, if non-obvious. Stored on the plan revision (D-009); routine additions can omit it.',
    ),
});

function formatPadded(n: number): string {
  return n.toString().padStart(3, '0');
}

/**
 * Allocate the next P-NNN considering ONLY real parsed items.
 *
 * Scanning raw bytes would catch P-NNN tokens inside prose, fenced
 * code-block examples, or template comments — none of which are real
 * items. Using `parsePlan` keeps allocation stable against documents
 * that happen to mention `P-001` in an example sentence.
 */
export function allocateNextItemId(body: string): string {
  const parsed = parsePlanLazy(body);
  let max = 0;
  for (const it of parsed.items) {
    const m = /^P-(\d+)$/.exec(it.id);
    if (m) {
      const n = parseInt(m[1] ?? '0', 10);
      if (n > max) max = n;
    }
  }
  return `P-${formatPadded(max + 1)}`;
}

// Lazy import-of-parser via a separate name to avoid a circular import
// hazard if parser ever imports add-item helpers in the future.
function parsePlanLazy(body: string): ReturnType<typeof parsePlan> {
  return parsePlan(body);
}

export function buildItemLine(
  itemId: string,
  text: string,
  blockedBy: string[],
  importance: Importance = 'normal',
): string {
  const bbSuffix = blockedBy.length > 0 ? ` blocked-by: ${blockedBy.join(', ')}` : '';
  // Emit the importance keyword only when it departs from the parser
  // default (`normal`) — keeps routine lines clean, mirrors blocked-by.
  const impSuffix = importance !== 'normal' ? ` importance: ${importance}` : '';
  // Single-line form — preserves the ASCII-canonical examples in the spec.
  return `- **${itemId}** \`todo\` ${text.trim()}${bbSuffix}${impSuffix}`;
}

/**
 * Insert an item line under a named phase heading.
 *
 * If the phase exists: append to the end of that section's items.
 * If it doesn't exist: create the section just before `## Decisions`
 * (or at file end if no Decisions section), and put the item under it.
 */
export function appendItemToBody(
  body: string,
  phase: string,
  itemLine: string,
): { newBody: string; createdPhase: boolean } {
  const trimmedPhase = phase.trim();
  // The `\b` guards "Phase 1" from matching "Phase 10" — but a word boundary
  // only exists next to a word char, so after a phase ending in `)` / `.` / `"`
  // it can NEVER match and every add silently duplicated the section.
  // Apply the boundary only when the phase ends in a word char.
  const boundary = /\w$/.test(trimmedPhase) ? String.raw`\b` : '';
  const phaseRe = new RegExp(
    String.raw`^##\s+(?:\d+(?:\.\d+)?\.\s+)?` +
      trimmedPhase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      boundary +
      String.raw`[^\n]*$`,
    'm',
  );

  // Locate headings against the fence-masked body so a `## Phase`
  // heading inside a worked-example fence is skipped; splice the real
  // body by index (maskFences preserves length). The backward
  // whitespace scan below deliberately stays on the real body.
  const masked = maskFences(body);
  const phaseMatch = phaseRe.exec(masked);
  if (phaseMatch) {
    const after = phaseMatch.index + phaseMatch[0].length;
    const restAfter = masked.slice(after);
    const nextHeadingRe = /^##\s/m;
    const nextHeadingMatch = nextHeadingRe.exec(restAfter);
    const insertAt =
      nextHeadingMatch !== null ? after + nextHeadingMatch.index : body.length;

    // Walk backward from insertAt to skip trailing whitespace lines.
    let scan = insertAt;
    while (scan > after && (body[scan - 1] === '\n' || body[scan - 1] === ' ')) scan--;
    // Ensure exactly one blank line between previous content and new item.
    const prefix = body.slice(0, scan);
    const suffix = body.slice(scan);
    const sep = prefix.endsWith('\n') ? '' : '\n';
    return {
      newBody: prefix + sep + itemLine + '\n' + suffix,
      createdPhase: false,
    };
  }

  // Phase missing — create the section just before `## Decisions`.
  const decisionsRe = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Decisions\b[^\n]*$/m;
  const decisionsMatch = decisionsRe.exec(masked);
  const newSection = `\n## ${phase.trim()}\n\n${itemLine}\n`;
  if (decisionsMatch) {
    return {
      newBody: body.slice(0, decisionsMatch.index) + newSection + '\n' + body.slice(decisionsMatch.index),
      createdPhase: true,
    };
  }
  let withTrailingNL = body;
  if (!withTrailingNL.endsWith('\n')) withTrailingNL += '\n';
  return { newBody: withTrailingNL + newSection, createdPhase: true };
}

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type AddItemValue =
  | { ok: true; itemId: string; createdPhase: boolean; slug: string }
  | { ok: false; code: 'not_found' | 'legacy_plan' };

export default defineTool({
  name: 'plans:add-item',
  description:
    'Append a new item to a phase. Allocates the next P-NNN id inside a lock. Creates the phase section if it doesn\'t exist. Auto-bumps frontmatter updated:.',
  guidance: {
    when: 'New work surfaces — a chunk to do, a verification step, a follow-up. Pick the right phase (or name a new one).',
    notWhen:
      'Updating an existing item — that\'s a direct edit, not an assisted write (the format is stable). Or status flip — plans:set-status.',
    chaining:
      'plans:add-item → plans:set-status to flip newly added items off `todo` when work starts.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
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
    const result = await withPlanLock<AddItemValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:add-item to "${args.phase.slice(0, 40)}"`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: AddItemValue }> => {
        if (current === null) {
          return { newBody: null, value: { ok: false, code: 'not_found' } };
        }
        const parsed = parsePlan(current, { filePath: args.slug + '.md' });
        if (parsed.isLegacy) {
          return { newBody: null, value: { ok: false, code: 'legacy_plan' } };
        }
        const itemId = allocateNextItemId(current);
        const itemLine = buildItemLine(
          itemId,
          args.text,
          args.blockedBy ?? [],
          args.importance as Importance,
        );
        const { newBody, createdPhase } = appendItemToBody(current, args.phase, itemLine);
        const final = bumpUpdatedDate(newBody);
        return {
          newBody: final,
          value: { ok: true, itemId, createdPhase, slug: args.slug },
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
    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'item_added',
      detail: result.value.itemId,
      after: args.text.slice(0, 200),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...result.value,
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          }),
        },
      ],
    };
  },
});
