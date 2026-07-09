/**
 * plans:add-item — append one OR many new P-NNN items to a phase.
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
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, phase, text, importance }, several to one phase of one
 * plan { slug, phase, importance, items:[{ text, blockedBy? }] }, or fully
 * heterogeneous items:[{ slug, phase, text, importance, … }] → { ok, results:[{ ok,
 * slug, itemId, createdPhase | error }], counts }. Each result embeds the NEWLY
 * ALLOCATED itemId; correlate by { slug, itemId } not array position; one failure
 * never fails the rest. Each item is appended inside its own plan lock so ids never
 * collide.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, maskFences, IMPORTANCE_LEVELS, type Importance } from './parser';
import { echoParsedItem } from './item-parse-feedback';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { hardText } from '../limits';

const PHASE = z
  .string()
  .min(1)
  .regex(
    // Fully anchored (^...$, not just a leading ^Phase\b) so the JSON-Schema
    // `pattern` Zod 4 emits is grammar-compilable by strict consumers (Ollama's
    // tool-calling grammar generator 400s the WHOLE catalog on any non-`^...$`
    // pattern: "Pattern must start with '^' and end with '$'" — see
    // packages/agent-mcp/src/tool-schema-sanitize.ts). Semantically identical to
    // the old /^Phase\b/i: only the prefix is constrained, anything may follow.
    /^Phase\b[\s\S]*$/i,
    'Phase heading must start with "Phase" (e.g. "Phase 1 — Tooling") — the plan parser only recognizes /^Phase\\b/i headings as phase sections, so anything else lint-warns as unphased.',
  )
  .describe('Phase heading text without the ## prefix and without numbering, e.g. "Phase 1 — Tooling".');

const IMPORTANCE = z
  .enum([...IMPORTANCE_LEVELS] as [string, ...string[]])
  .describe(
    'REQUIRED. Item importance — urgent|high|normal|low. urgent = interrupt the human now / pick up first; high = should be seen today; normal = usual cadence; low = safe to defer. No silent default: choose it deliberately from the importance rubric (decide from consequences — "what breaks, and how fast, if this is never seen / picked up last?"). Most routine items are `normal`.',
  );

const BLOCKED_BY = z
  .array(z.string().regex(/^P-\d{3,}$/))
  .describe('Item IDs that must complete before this one can effectively start.');

const itemSpec = z.object({
  slug: z.string().min(1).optional().describe('per-item plan slug (else the batch `slug`)'),
  phase: PHASE.optional().describe('per-item phase (else the batch `phase`)'),
  text: hardText(4000),
  blockedBy: BLOCKED_BY.optional(),
  importance: IMPORTANCE.optional().describe('per-item importance (else the batch `importance`)'),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z.string().optional().describe('per-item revision rationale (else the batch `rationale`)'),
});

// Exported (back-compat name) — the SINGLE-item arg shape, now folded into a
// dual-arity schema that also accepts items:[…].
export const argsSchema = z
  .object({
    slug: z.string().min(1).optional(),
    harness: harnessArg,
    phase: PHASE.optional(),
    text: hardText(4000).optional(),
    blockedBy: BLOCKED_BY.optional(),
    importance: IMPORTANCE.optional(),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('add many items at once — each { text, importance, phase?, slug?, blockedBy?, harness? }; phase/slug/importance fall back to the batch values'),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional — a short why for adding this item, if non-obvious. Stored on the plan revision (D-009); routine additions can omit it.',
      ),
  })
  .refine(
    (a) =>
      (a.items?.length ?? 0) > 0
        ? // Bulk form: every item must RESOLVE a slug, phase and importance (its own or
          // the batch fallback). The handler dereferences the resolved phase (`as string`
          // casts), so an unresolvable field used to escape validation and crash inside
          // the plan lock with "Cannot read properties of undefined (reading 'slice')".
          a.items!.every(
            (it) =>
              Boolean(it.slug ?? a.slug) &&
              Boolean(it.phase ?? a.phase) &&
              Boolean(it.importance ?? a.importance),
          )
        : Boolean(a.slug) && Boolean(a.phase) && Boolean(a.text) && Boolean(a.importance),
    {
      message:
        'pass { slug, phase, text, importance } for one, or items:[{ text, importance }] (with batch slug/phase) / items:[{ slug, phase, text, importance }] for many — every item must resolve a slug, a phase AND an importance (per-item or batch-level)',
    },
  );

interface NewItem {
  slug: string;
  phase: string;
  text: string;
  importance: Importance;
  blockedBy?: string[];
  harness?: string;
  rationale?: string;
}

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
  // Grammar guard (WI-3447): an item is ONE physical line — ITEM_LINE_RE's
  // `(.*)$` does not span newlines. A newline in `text` (e.g. a multi-line
  // paste) would split the line, truncating the item and orphaning the rest as
  // stray prose. Collapse any newline-bearing whitespace run to a single space
  // so the built line always parses back to the intended item. Single-line text
  // is unaffected (no newline → no-op).
  const singleLineText = text.trim().replace(/\s*[\r\n]+\s*/g, ' ');
  // Single-line form — preserves the ASCII-canonical examples in the spec.
  return `- **${itemId}** \`todo\` ${singleLineText}${bbSuffix}${impSuffix}`;
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

/** Append ONE item, returning the self-describing bulk result. PRESERVES the
 *  in-lock allocate → build → append → bump, the revision capture, the plan-event
 *  emit, and the not_found / legacy_plan / busy error mapping per item. The newly
 *  allocated itemId rides the result (CREATE → result embeds what the single call
 *  returned). */
async function addItemOne(it: NewItem, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  const sctx = harnessScopedCtx(it.harness, ctx);
  const harnessSlug = resolveCtxHarnessSlug(sctx);
  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    it.slug,
    it.rationale,
    harnessSlug ? { harnessSlug } : {},
  );
  // Capture the written body so we can echo the parsed item back (WI-3363).
  let writtenBody: string | null = null;
  const result = await withPlanLock<AddItemValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:add-item to "${it.phase.slice(0, 40)}"`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: AddItemValue }> => {
      if (current === null) {
        return { newBody: null, value: { ok: false, code: 'not_found' } };
      }
      const parsed = parsePlan(current, { filePath: it.slug + '.md' });
      if (parsed.isLegacy) {
        return { newBody: null, value: { ok: false, code: 'legacy_plan' } };
      }
      const itemId = allocateNextItemId(current);
      const itemLine = buildItemLine(itemId, it.text, it.blockedBy ?? [], it.importance);
      const { newBody, createdPhase } = appendItemToBody(current, it.phase, itemLine);
      const final = bumpUpdatedDate(newBody);
      writtenBody = final;
      return {
        newBody: final,
        value: { ok: true, itemId, createdPhase, slug: it.slug },
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
  await emitPlanEventForCaller(ctx, {
    planSlug: it.slug,
    event: 'item_added',
    detail: result.value.itemId,
    after: it.text.slice(0, 200),
  });

  // Echo the parsed item back (WI-3363) so the caller confirms exactly what
  // registered without a follow-up plans:get — and, in the edge where multi-line
  // or grammar-breaking text silently corrupts the built line, the item fails to
  // parse back and we surface a warning instead of a clean-looking success.
  const item = writtenBody ? echoParsedItem(writtenBody, result.value.itemId) : null;
  return {
    ...result.value,
    ...(item
      ? { item }
      : {
          warning: `the added item ${result.value.itemId} did not parse back as an item — check the text for newlines or grammar-breaking characters`,
        }),
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
  };
}

export default defineTool({
  name: 'plans:add-item',
  description:
    "Append one OR many new items to a phase. Allocates the next P-NNN id inside a lock. Creates the phase section if it doesn't exist. Auto-bumps frontmatter updated:. Single: { slug, phase, text, importance }. Many to one phase: { slug, phase, importance, items:[{ text, blockedBy? }] }. Heterogeneous: items:[{ slug, phase, text, importance }]. Returns { ok, results:[{ ok, slug, itemId, createdPhase | error }], counts } — each result embeds the NEW itemId; correlate by { slug, itemId }, not position; one failure never fails the rest.",
  guidance: {
    when: 'New work surfaces — a chunk to do, a verification step, a follow-up. Pick the right phase (or name a new one). Add several at once via items:[…] (the new ids come back per result).',
    notWhen:
      "Updating an existing item — that's a direct edit, not an assisted write (the format is stable). Or status flip — plans:set-status.",
    chaining:
      'plans:add-item → plans:set-status to flip newly added items off `todo` when work starts.',
    seeAlso: [
      'plans:set-status (advance an item you just added off todo)',
      'plans:set-importance (re-rank the new item vs its siblings)',
      'plans:set-item-blocked-by (record a dependency on another item)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: NewItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: (it.slug ?? args.slug) as string,
          phase: (it.phase ?? args.phase) as string,
          text: it.text,
          importance: (it.importance ?? args.importance) as Importance,
          blockedBy: it.blockedBy ?? args.blockedBy,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : [
          {
            slug: args.slug as string,
            phase: args.phase as string,
            text: args.text as string,
            importance: args.importance as Importance,
            blockedBy: args.blockedBy,
            harness: args.harness,
            rationale: args.rationale,
          },
        ];
    const env = await runBulk(list, (it) => addItemOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug }),
    });
    return bulkContent(env);
  },
});
