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
import { harnessArg, harnessScopedCtx, resolveHarnessScope } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import {
  parsePlan,
  maskFences,
  normalizeDecisionBodyHeadings,
  type LegacyReason,
  type PlanDecision,
} from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { readPlanBySlug, VALID_PLAN_SLUG } from './source';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { emitDecisionAdded } from '../../harness/usage-emitters';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { hardText, LIMITS } from '../limits';
import { recoverHarnessFromSlugs, requireUnambiguousSlugScope } from './slug-scope';
import { decisionProvenance, FALSIFIED_OWNER_ANCHOR_NOTE } from './decision-provenance';
import { neutralizeToolCallTags } from '../../text-safety';

const REFS = z
  .array(z.string().regex(/^P-\d{3,}$/))
  .describe('Item IDs this decision relates to. Appear in the body as P-NNN tokens.');

const ITEM_REFS_ALIAS_DESC =
  'Alias for `refs` (EI-18735663944089262) — plans:get returns a decision\'s item refs under this exact name (itemRefs), so accepting it here means a read-then-write roundtrip does not need a field rename. Both fields enforce the same in-plan `P-NNN` reference format; work-item/issue ids are not accepted. Prefer `refs`; if both are given, `refs` wins.';

const AFFECTED_PLAN_SLUG = z
  .string()
  .min(1)
  .regex(VALID_PLAN_SLUG, 'existing plan slug (filename stem)')
  .describe(
    'An existing OTHER plan slug (the plan filename stem). This is not a surface label, work-item/issue id, or P-NNN item reference; use refs/itemRefs for in-plan P-NNN references.',
  );

const AFFECTS = z.array(AFFECTED_PLAN_SLUG).max(20);
const AFFECTS_DESC =
  'Existing plan slugs of OTHER plans this decision bears on. The decision stays canonically in `slug`; each affected plan gets a cross-reference plan_event + a notify to its watchers. Surface labels and item/work-item ids are not accepted here.';

const DECISION_BODY_DESC =
  'The decision body. HARD CAP 5000 chars — over-length is REJECTED, not truncated, so split a long rationale or trim before calling. ' +
  'Measure before you rule: when the decision asserts a factual claim about the tree, read the tree and add a `Measured:` line naming the file:line or command + result. A decision cited from another decision is authority for design, not evidence about current code.';

const itemSpec = z.object({
  slug: z.string().min(1),
  title: hardText(LIMITS.SHORT_TITLE),
  body: hardText(5000).describe(DECISION_BODY_DESC),
  refs: REFS.optional(),
  itemRefs: REFS.optional().describe(ITEM_REFS_ALIAS_DESC),
  affects: AFFECTS.optional().describe(AFFECTS_DESC),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z.string().optional().describe('per-item revision rationale (else the batch `rationale`)'),
});

const argsSchema = z
  .object({
    slug: z.string().min(1).optional(),
    harness: harnessArg,
    title: hardText(LIMITS.SHORT_TITLE).optional(),
    body: hardText(5000).optional().describe(DECISION_BODY_DESC),
    refs: REFS.optional(),
    itemRefs: REFS.optional().describe(ITEM_REFS_ALIAS_DESC),
    affects: AFFECTS.optional().describe(AFFECTS_DESC),
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

export interface DecisionMeasurementAdvisory {
  code: 'tree_fact_measurement_missing';
  paths: string[];
  message: string;
}

// Advisory-only by design: a path can appear in a design example that makes no
// factual claim, so rejecting every match would create false-positive governance
// failures. The returned warning is nevertheless machine-visible on the exact
// write that needs review, rather than relying on a prompt sentence alone.
const SOURCE_PATH_RE = /\b(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|rs|go|py)(?::\d+)?\b/g;
// Deliberately tolerant of how the label is WRITTEN, strict about whether
// evidence FOLLOWS it. A false alarm here is the expensive failure: this
// advisory's whole job is to catch a decision asserting tree facts it never
// verified, so firing it at an author who DID measure teaches "this warning is
// noise", and then it protects nothing when a genuinely unmeasured decision
// arrives. Measured 2026-08-30 against the anchored `^\s*Measured\b` form it
// replaces: that version demanded a literal `M` immediately after leading
// whitespace, so every markdown-decorated form silently read as absent —
// `**Measured:**`, `- Measured:`, `> Measured:` — and its 80-char qualifier cap
// rejected a 166-char parenthetical heading. TWO reporters filed it
// (EI-21900576470401486 bold, EI-21850043257707007 long qualifier) and BOTH
// diagnoses of the mechanism were wrong — one blamed colon adjacency, the other
// an inner colon in the qualifier; measurement showed neither. A THIRD variant
// (`- Measured:`) nobody had reported fell out of the same root cause. That is
// why the accepted and rejected forms are pinned as tests below rather than
// argued from the pattern.
//
// Accepts: an optional list/quote marker, optional markdown emphasis around the
// label, an optional `(...)`/`[...]` qualifier up to 200 chars (or a short bare
// one, as before), and evidence that may begin on the following line.
// Still rejects: a label with nothing after it — a promise is not a measurement.
const MEASURED_LINE_RE =
  /^[ \t]*(?:(?:[-*+>]|\d+[.)])[ \t]*)?(?:\*\*|__|\*|_)?[ \t]*Measured\b(?:[ \t]*[(\[][^\n]{0,200}[)\]]|[^:\n]{0,80})?[ \t]*:(?:\*\*|__|\*|_)?\s+\S.+$/im;

export function decisionMeasurementAdvisory(body: string): DecisionMeasurementAdvisory | null {
  const paths = [...new Set(body.match(SOURCE_PATH_RE) ?? [])].slice(0, 12);
  if (paths.length === 0 || MEASURED_LINE_RE.test(body)) return null;
  return {
    code: 'tree_fact_measurement_missing',
    paths,
    message:
      'This decision names source-like paths but has no `Measured:` line. If it asserts current tree behavior, ' +
      'open the code and amend the decision with `Measured: <file:line or command + result>`. Another decision ' +
      'is design authority, not evidence about the current tree.',
  };
}

function formatPadded(n: number): string {
  return n.toString().padStart(3, '0');
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Matches the `## Decisions` heading (optionally numbered, "## 5. Decisions")
// but NOT a suffixed variant like "## Decisions (settled)" — a different
// section that must never be scanned/absorbed. Kept in sync with
// `appendDecisionToBody`'s heading match via `findDecisionsSectionBody`.
const DECISIONS_HEADING_RE = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Decisions\s*$/m;

/**
 * Locate the `## Decisions` section's body text (fence-masked, so a
 * `D-NNN`-looking token inside a worked-example fence is excluded) — the
 * text between the heading and the next `## ` heading, or EOF. Returns
 * null when the doc has no (unsuffixed) Decisions section.
 */
function findDecisionsSectionBody(maskedBody: string): string | null {
  const headingMatch = DECISIONS_HEADING_RE.exec(maskedBody);
  if (!headingMatch) return null;
  const after = headingMatch.index + headingMatch[0].length;
  const restAfter = maskedBody.slice(after);
  const nextHeadingMatch = /^##\s/m.exec(restAfter);
  return nextHeadingMatch ? restAfter.slice(0, nextHeadingMatch.index) : restAfter;
}

/**
 * A `D-NNN` token in the Decisions section counts toward id allocation only
 * when it is DECLARATION-SHAPED: the first thing on its line (after an
 * optional blockquote marker and list bullet), written either as a markdown
 * heading (`#### D-014 — ...`) or wrapped in emphasis (`- **D-014** ...` —
 * the informal legacy bullet EI-15651 exists for).
 *
 * Anything else is a REFERENCE, not a declaration. That distinction is the
 * whole fix for EI-19989843927675996: a decision BODY that cites another
 * plan's ruling — `defers to D-054` — used to be scanned as if it declared
 * D-054 here, so the next allocation jumped to D-055 and the plan read as
 * though ~50 decisions were missing. Cross-plan citation is not an edge case
 * but the documented good practice (CLAUDE.md tells agents to name a ruling
 * as `<planSlug>#D-NNN`), and the inflation it caused was permanent and
 * monotonic.
 *
 * Requiring emphasis-or-heading rather than merely line-initial position is
 * measured, not guessed: across all 679 papercusp plans, informal
 * declarations appear ONLY as `**D-NNN**` (365 lines / 105 plans) or as
 * headings (4,631 lines / 586 plans) — a bare line-initial `D-NNN` occurs
 * zero times, while 7,917 mid-line reference tokens do. So the tighter shape
 * excludes no real declaration and admits no bullet-list citation
 * (`- Supersedes D-054.`), which the looser line-initial rule would have.
 *
 * Slug-qualified citations (`unified-agent-state-plane-2026-07-27#D-087`)
 * fall out for free: both branches require `D-` immediately after the
 * heading marker or emphasis delimiter, so a qualified token never matches
 * however it is positioned.
 */
const DECLARED_DECISION_TOKEN_RE =
  /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+\.)[ \t]+)?(?:#{1,6}[ \t]+D-(\d{3,})\b|(?:\*\*|__)D-(\d{3,})(?:\*\*|__))/gm;

/**
 * Allocate the next D-NNN.
 *
 * Considers BOTH real parsed (structured `### D-NNN`) decisions AND any
 * DECLARATION-SHAPED `D-NNN` token elsewhere in the `## Decisions` section
 * body — e.g. an informal legacy-style `- **D-001** ...` prose bullet, which
 * the structured parser does not recognise as a decision at all (EI-15651).
 * Without the latter, a plan hand-authored with informal decision bullets
 * makes the allocator start counting from 1 again, minting a `### D-001`
 * that collides VISUALLY with the pre-existing informal `**D-001**` bullet
 * in the rendered document, even though the store treats them as unrelated.
 *
 * References to D-NNN inside prose/example fences OUTSIDE the Decisions
 * section must not bump the allocator either — hence scoping the scan to the
 * section body (fence-masked within it too).
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
  const sectionBody = findDecisionsSectionBody(maskFences(body));
  if (sectionBody) {
    for (const m of sectionBody.matchAll(DECLARED_DECISION_TOKEN_RE)) {
      const n = parseInt(m[1] ?? m[2] ?? '0', 10);
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
  // Demote `#`/`##` headings in the body so they cannot break out of the
  // `## Decisions` section and shred the decision (EI-18804290731494084).
  // Enforced HERE, at authorship, rather than documented as a convention:
  // the failure is silent, so the only tier that works is a structural one.
  const { body: safeBody } = normalizeDecisionBodyHeadings(decisionBody.trim());
  const block =
    `\n### ${decisionId} — ${title.trim()}\n` +
    `Date: ${date}\n` +
    `${safeBody}${refsLine}\n`;

  // Find the `## Decisions` section — allowing a numbered prefix
  // ("## 5. Decisions") and trailing whitespace ONLY. A heading with a
  // suffix like "## Decisions (settled)" is a DIFFERENT section and
  // must never absorb new decisions (EI-141 / audit P-041).
  // Locate against the fence-masked body so a `## Decisions` heading
  // inside a worked-example fence is skipped; splice the real body by
  // index (maskFences preserves length, so indices are interchangeable).
  const masked = maskFences(body);
  const headingMatch = DECISIONS_HEADING_RE.exec(masked);
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

/**
 * Retry-safety for a NON-idempotent append (EI-19383795443003151): an MCP
 * write can time out client-side with no response, leaving the write's
 * server-side outcome genuinely unknown. A blind retry of `plans:add-decision`
 * — which only ever appends, never upserts — then risks minting a SECOND
 * decision with identical title+body, and a duplicated governing decision is
 * exactly the kind of thing other lanes are told to trust over paraphrase.
 *
 * This checks the cheapest safe signal: is the plan's MOST RECENTLY allocated
 * decision (by D-NNN, which is monotonic and only ever grows) already this
 * exact { title, body }? If so, the call is a retry of a write that already
 * landed — return the existing id instead of appending a duplicate.
 *
 * Deliberately narrow so it can never suppress a legitimate decision:
 *   - only ever compares against the LAST decision in the file, never the
 *     whole history, so a genuinely repeated title+body recorded long ago
 *     (a different decision that happens to read the same) is untouched;
 *   - requires an EXACT match on both title and (normalized) body — a
 *     retry always sends byte-identical args, so this never has to guess.
 */
export function findRetryDuplicateOfLastDecision(
  decisions: PlanDecision[],
  title: string,
  body: string,
): PlanDecision | null {
  if (decisions.length === 0) return null;
  let last: PlanDecision | null = null;
  let max = -1;
  for (const d of decisions) {
    const m = /^D-(\d+)$/.exec(d.id);
    const n = m ? parseInt(m[1] ?? '0', 10) : -1;
    if (n > max) {
      max = n;
      last = d;
    }
  }
  if (!last) return null;
  if (last.title.trim() !== title.trim()) return null;
  const { body: safeBody } = normalizeDecisionBodyHeadings(body.trim());
  // `last.body` (as parsed) also carries the `Date: …` line and any trailing
  // `Related: …` refs line the append wrote alongside it — compare by
  // containment rather than equality so those don't defeat the match.
  return last.body.includes(safeBody.trim()) ? last : null;
}

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type AddDecisionValue =
  | { ok: true; decisionId: string; slug: string; deduped?: boolean }
  | { ok: false; code: 'not_found' | 'legacy_plan'; reason?: LegacyReason };

type WritableSlugScope = ReturnType<typeof requireUnambiguousSlugScope>;
type WritableSlugScopeFailure = Exclude<WritableSlugScope, { status: 'resolved' }>;

/** Keep exact-slug recovery failures self-describing inside the bulk result. */
function decisionScopeFailure(slug: string, decision: WritableSlugScopeFailure): BulkItemResult {
  if (decision.status === 'missing') {
    return {
      ok: false,
      slug,
      error: 'plan_not_found_in_workspace',
      missing: decision.missing,
      ...(Object.keys(decision.found).length > 0 ? { foundIn: decision.found } : {}),
      workspaceId: decision.workspaceId,
    };
  }
  if (decision.status === 'split') {
    return {
      ok: false,
      slug,
      error: 'harness_split_across_plans',
      mapping: decision.mapping,
    };
  }
  return {
    ok: false,
    slug,
    error: 'plan_slug_ambiguous_across_harnesses',
    candidates: decision.candidates,
  };
}

/** Resolve the concrete harness for one plan decision, recovering it from the
 * exact slug only when the caller has no explicit/session harness scope. */
async function decisionContext(
  it: NewDecision,
  ctx: UnifiedToolContext,
): Promise<{ ok: true; ctx: UnifiedToolContext & { harnessSlug: string } } | { ok: false; result: BulkItemResult }> {
  const scope = resolveHarnessScope(it.harness, ctx);
  if (scope.kind !== 'none') {
    return { ok: true, ctx: harnessScopedCtx(it.harness, ctx) };
  }

  const recovered = await recoverHarnessFromSlugs(ctx, [it.slug]);
  const decision = requireUnambiguousSlugScope(
    recovered,
    ((ctx as { workspaceId?: string }).workspaceId ?? '').trim(),
  );
  if (decision.status !== 'resolved') {
    return { ok: false, result: decisionScopeFailure(it.slug, decision) };
  }

  (ctx as { metadata?: (data: Record<string, unknown>) => void }).metadata?.({
    harnessAutoResolved: decision.bySlug,
  });
  return { ok: true, ctx: { ...ctx, harnessSlug: decision.harnessSlug } };
}

/** Append ONE decision, returning the self-describing bulk result. PRESERVES the
 *  in-lock allocate → append → bump, the revision capture, the P-070 usage ledger,
 *  the plan-event emit, AND the cross-plan `affects` propagation. The new decisionId
 *  rides the result; not_found / legacy_plan / busy map to this item's failure.
 *  Busy results preserve the safe owner/expiry fields plus the optional point-in-time
 *  PostgreSQL holder snapshot. */
async function addDecisionOne(rawIt: NewDecision, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  // EI-21915372335188454: a client-side tool-call serializer that mis-closes a
  // `<parameter name="body">` block (e.g. `</body>` instead of `</parameter>`)
  // has been observed leaking the literal tool-call XML for every argument AFTER
  // the mismatch into this `body` string — silently dropping `refs` and, worse,
  // planting live-looking `<invoke>`/`<parameter>` markup in a durable governance
  // record a later agent could misread as its own tool-call transcript (the exact
  // risk EI-9267 already defends against for work-item text and facts:assert).
  // `plans:add-decision` had no such guard. Neutralize (cosmetic full-width `＜`
  // swap, non-destructive, idempotent) rather than refuse — same choice
  // facts:assert makes: the decision was still substantively authored and must
  // not be lost outright over a malformed closing tag.
  const it: NewDecision = {
    ...rawIt,
    title: neutralizeToolCallTags(rawIt.title),
    body: neutralizeToolCallTags(rawIt.body),
  };
  // WI-42142 — decision provenance, resolved BEFORE the plan lock (the helper's
  // header carries the full rationale and the measurement behind enforced-vs-advisory).
  const { fields: provenance, anchors } = await decisionProvenance(`${it.title}\n${it.body}`, ctx);
  const measurementAdvisory = decisionMeasurementAdvisory(it.body);
  if (anchors.length > 0) {
    return {
      ok: false,
      slug: it.slug,
      error: 'falsified_owner_anchor',
      message: FALSIFIED_OWNER_ANCHOR_NOTE,
      anchors,
    };
  }

  const resolved = await decisionContext(it, ctx);
  if (!resolved.ok) return resolved.result;
  const sctx = resolved.ctx;
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
        return {
          newBody: null,
          value: { ok: false, code: 'legacy_plan', reason: parsed.legacyReason ?? undefined },
        };
      }
      // EI-19383795443003151: a blind retry of a timed-out-but-actually-landed
      // write must not duplicate. No-op (no write, no revision, no plan-event)
      // and hand back the id that already carries this exact decision.
      const retryDup = findRetryDuplicateOfLastDecision(parsed.decisions, it.title, it.body);
      if (retryDup) {
        return { newBody: null, value: { ok: true, decisionId: retryDup.id, slug: it.slug, deduped: true } };
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
        owner: b.owner,
        owner_label: b.owner_label,
        intent: b.intent,
        expires_ts: b.expires_ts,
        holder_snapshot: b.holder_snapshot,
      })),
    };
  }

  if (!result.value.ok) {
    return {
      ok: false,
      slug: it.slug,
      error: result.value.code,
      ...(result.value.reason ? { reason: result.value.reason } : {}),
    };
  }

  // `result.value` is narrowed to the ok-variant by the guard above.
  const decisionId = result.value.decisionId;

  // A retry-duplicate no-op: nothing was written, so nothing to ledger, event,
  // or propagate — just hand back the id the earlier (already-landed) call
  // allocated.
  if (result.value.deduped) {
    return {
      ok: true,
      decisionId,
      slug: it.slug,
      deduped: true,
      filePath: result.filePath,
      ...(measurementAdvisory ? { measurementAdvisory } : {}),
      ...provenance,
    };
  }

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
    ...(measurementAdvisory ? { measurementAdvisory } : {}),
    // WI-42142: advisory provenance fields — absent on the clean common case, so a
    // decision with no directive shape and no turn ref keeps its exact prior shape.
    ...provenance,
  };
}

export default defineTool({
  name: 'plans:add-decision',
  description:
    "Append one or many decisions to a plan. Allocates the next D-NNN inside a lock and bumps frontmatter `updated:`; concurrent calls stay collision-free. Single: `{ slug, title, body }`; bulk: `items:[{ slug, title, body, refs?, affects? }]`. `itemRefs` aliases `refs` (refs wins). Tree-fact decisions require `Measured: <file:line or command + result>`; source-like paths without it return `measurementAdvisory`. Returns `{ ok, results:[{ ok, slug, decisionId, deduped?, propagated_to?, measurementAdvisory? | error }], counts }`; correlate each result by `decisionId`, and one failure never fails the rest. Exact `{ title, body }` retries dedupe against the plan's most recent decision instead of appending.",
  guidance: {
    when: "A decision-shaped output: trade-off resolved, scope ratified, or a choice made. Record it so fresh agents do not relitigate. For current-tree claims, open the tree and add `Measured: <file:line or command + result>`. Design authority is not tree evidence. Use items:[…] for bulk.",
    notWhen:
      'Adding work units — use plans:add-item. Flipping status — plans:set-status. Updating overall state — plans:set-now.',
    chaining:
      'plans:add-decision → optionally plans:set-now referencing the new D-NNN in **State:**.',
    seeAlso: [
      'plans:set-decision-body (edit an existing decision\'s body)',
      'plans:set-now (reference the new D-NNN in the Now)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    // `itemRefs` is a declared alias of `refs` (EI-18735663944089262):
    // plans:get echoes a decision's refs back under that exact name, so
    // accept it here too instead of rejecting the read-shape field name.
    // `refs` wins when both are given on the same object.
    const batchRefs = args.refs ?? args.itemRefs;
    const list: NewDecision[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          title: it.title,
          body: it.body,
          refs: it.refs ?? it.itemRefs ?? batchRefs,
          affects: it.affects ?? args.affects,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : [
          {
            slug: args.slug as string,
            title: args.title as string,
            body: args.body as string,
            refs: batchRefs,
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
