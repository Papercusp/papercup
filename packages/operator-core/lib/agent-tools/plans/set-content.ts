/**
 * plans:set-content — whole-document write with compare-and-swap.
 *
 * agent-plan-tracking Phase 5 (D-011 of plans-admin-ui-2026-05-20).
 *
 * The one genuinely unstructured plan write. The assisted writers
 * (set-status / set-now / add-decision / add-item) each touch a single
 * parser-recognized region; this verb replaces the entire document —
 * for the Plans admin tab's raw-prose Edit mode (P-301), which lets a
 * human rewrite the free-prose sections (`## Background` etc.) that the
 * assisted verbs cannot reach.
 *
 * Three guards make it as safe as the structured verbs:
 *
 *   1. Compare-and-swap. `expectedHash` is the `contentHash` from the
 *      `plans:get` that loaded the editor. Inside the lock the live
 *      file is hashed; a mismatch rejects `{ error: 'stale' }` with the
 *      current bytes so the UI can reload — a concurrent change is
 *      never silently clobbered. A UI edit session holds the lock only
 *      for the write, not the minutes of editing, so CAS — not the
 *      lock — is the real concurrency guard.
 *   2. Legacy-boundary guard. `plans:lint` exempts legacy plans, so a
 *      payload that drops `slug:` / `status:` would degrade a real plan
 *      to legacy and lint would pass vacuously. If the file was
 *      non-legacy, a result that parses legacy is rejected.
 *   3. Reject on lint errors. The proposed body is parsed + linted
 *      in-memory (`lintParsed`) before the write; errors reject and
 *      return the findings, warnings pass.
 *
 * Writes inside `withPlanLock`. Does not emit a plan_event — the
 * plan-event vocabulary covers the structured lifecycle (now / item /
 * decision / status), not a whole-document rewrite.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock } from './with-plan-lock';
import { parsePlan, type ParsedPlan } from './parser';
import { lintParsed, type LintFinding } from './lint';
import { hashPlanContent } from './content-hash';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { clearStartedForTerminalPlan, isTerminalPlanStatus } from './plan-start-state';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';

const argsSchema = z.object({
  slug: z.string().min(1),
  harness: harnessArg,
  content: z
    .string()
    .min(1)
    .describe('The full new markdown document body — replaces the file wholesale.'),
  expectedVersion: z
    .number()
    .int()
    .optional()
    .describe(
      'The `version` from the plans:get that loaded the editor — the optimistic compare-and-swap baseline (plans-pg-canonical-migration D-005). When the live row has moved past it the write is rejected as stale. Preferred over expectedHash.',
    ),
  expectedHash: z
    .string()
    .optional()
    .describe(
      'Legacy CAS baseline — the `contentHash` from plans:get. Equivalent to expectedVersion (both detect a concurrent change); kept for callers that still send a hash. When it no longer matches the stored content the write is rejected as stale.',
    ),
  rationale: z
    .string()
    .optional()
    .describe(
      'Optional — the *why* behind this rewrite: the rejected alternative, the constraint that forced it, the argument that settled it. Stored on the plan revision and always loaded as context for any agent later launched from this plan (D-009). State it for a substantive rewrite; a trivial fix may omit it.',
    ),
  allowShrink: z
    .boolean()
    .optional()
    .describe(
      'A body that shrinks the plan to under 20% of its current size is rejected as a probable mass deletion (`suspicious_shrink`) unless this is true. Pass it only when the shrink is intentional — e.g. archiving prose that moved elsewhere.',
    ),
});

export type SetContentValue =
  | { ok: true; slug: string; contentHash: string; warning?: string }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'stale'; currentContent: string; currentHash: string; currentVersion?: number }
  | {
      ok: false;
      code: 'suspicious_shrink';
      /** What tripped the guard — a wholesale byte shrink, or a structural
       *  drop of items/decisions that byte size missed (EI-83). */
      reason: 'bytes' | 'structure';
      currentLength: number;
      proposedLength: number;
      /** Structural deltas (populated for `reason: 'structure'`). */
      priorItems?: number;
      priorDecisions?: number;
      droppedItems?: number;
      droppedDecisions?: number;
    }
  | { ok: false; code: 'would_orphan_frontmatter' }
  | { ok: false; code: 'lint_failed'; errors: LintFinding[] };

/** A proposed body this much smaller than the live one is treated as a
 *  probable mass deletion (truncated paste, wrong-plan write, model
 *  hallucinating a fresh doc) and rejected unless the caller passes
 *  `allowShrink: true` (EI-83 / audit P-040). */
export const SUSPICIOUS_SHRINK_RATIO = 0.2;

/** Once a plan carries at least this many items+decisions, wiping most of
 *  them is a red flag rather than ordinary churn. Below it the byte-ratio
 *  guard is the only shrink check — a tiny plan legitimately rewrites its
 *  handful of items, and a structural ratio on small counts is all noise. */
export const STRUCTURAL_GUARD_MIN_PRIOR = 5;
/** A write that drops MORE than this fraction of the prior plan's combined
 *  items+decisions is treated as a probable truncation and rejected without
 *  `allowShrink`. The EI-83 forensic dropped 100% (15 items + 9 decisions)
 *  while keeping enough prose that the byte-ratio guard alone would not have
 *  caught a prose-heavy variant — the structural count is the real signal. */
export const STRUCTURAL_DROP_RATIO = 0.5;

/**
 * The mass-deletion guard: a byte-ratio shrink OR a structural drop of
 * items/decisions (EI-83). Byte ratio catches a wholesale truncated paste;
 * the structural check catches the case byte size misses — a prose-heavy plan
 * whose items + decisions are wiped while a long `## Background` keeps the
 * byte count above the ratio. Returns the rejection value, or null to pass.
 */
function detectSuspiciousShrink(
  current: string,
  content: string,
  currentParsed: ParsedPlan,
  proposed: ParsedPlan,
): Extract<SetContentValue, { code: 'suspicious_shrink' }> | null {
  // 1. Wholesale byte shrink — a truncated paste / wrong-plan write.
  if (content.length < current.length * SUSPICIOUS_SHRINK_RATIO) {
    return {
      ok: false,
      code: 'suspicious_shrink',
      reason: 'bytes',
      currentLength: current.length,
      proposedLength: content.length,
    };
  }
  // 2. Structural drop — items/decisions destroyed even though bytes survived.
  const priorStructural = currentParsed.items.length + currentParsed.decisions.length;
  const proposedStructural = proposed.items.length + proposed.decisions.length;
  if (
    priorStructural >= STRUCTURAL_GUARD_MIN_PRIOR &&
    proposedStructural < priorStructural * (1 - STRUCTURAL_DROP_RATIO)
  ) {
    return {
      ok: false,
      code: 'suspicious_shrink',
      reason: 'structure',
      currentLength: current.length,
      proposedLength: content.length,
      priorItems: currentParsed.items.length,
      priorDecisions: currentParsed.decisions.length,
      droppedItems: currentParsed.items.length - proposed.items.length,
      droppedDecisions: currentParsed.decisions.length - proposed.decisions.length,
    };
  }
  return null;
}

/** Surfacing (EI-83 fix #2): a one-line "this write removed N items" note
 *  attached to a SUCCESSFUL write whenever it drops items/decisions — so even
 *  an allowed shrink is visible in the response instead of silent. */
function shrinkWarning(currentParsed: ParsedPlan, proposed: ParsedPlan): string | undefined {
  const droppedItems = currentParsed.items.length - proposed.items.length;
  const droppedDecisions = currentParsed.decisions.length - proposed.decisions.length;
  if (droppedItems <= 0 && droppedDecisions <= 0) return undefined;
  const parts: string[] = [];
  if (droppedItems > 0) parts.push(`${droppedItems} item${droppedItems === 1 ? '' : 's'}`);
  if (droppedDecisions > 0) parts.push(`${droppedDecisions} decision${droppedDecisions === 1 ? '' : 's'}`);
  return `This write removed ${parts.join(' and ')}.`;
}

/**
 * The pure CAS + legacy-boundary + lint decision for a set-content
 * write. Exported so it can be unit-tested without the SU lock
 * side-database — the handler runs exactly this inside `withPlanLock`.
 *
 *   - `current` is the live file body, or null if the file is absent.
 *   - `newBody` is what to write (null = reject, leave the file).
 */
export async function evaluateSetContent(
  current: string | null,
  content: string,
  slug: string,
  expectedHash: string | undefined,
  opts: {
    expectedVersion?: number;
    meta?: { version: number; contentHash: string } | null;
    allowShrink?: boolean;
  } = {},
): Promise<{ newBody: string | null; value: SetContentValue }> {
  if (current === null) {
    return { newBody: null, value: { ok: false, code: 'not_found' } };
  }

  // 1. Compare-and-swap — reject a write against a plan that changed since the
  //    editor loaded it. Prefer the optimistic version CAS (D-005); fall back to
  //    the equivalent content-hash CAS for callers that still send expectedHash.
  const currentHash = hashPlanContent(current);
  const currentVersion = opts.meta?.version;
  if (opts.expectedVersion != null && currentVersion != null && opts.expectedVersion !== currentVersion) {
    return {
      newBody: null,
      value: { ok: false, code: 'stale', currentContent: current, currentHash, currentVersion },
    };
  }
  if (expectedHash && expectedHash !== currentHash) {
    return {
      newBody: null,
      value: { ok: false, code: 'stale', currentContent: current, currentHash, currentVersion },
    };
  }

  const filePath = `${slug}.md`;
  const currentParsed = parsePlan(current, { filePath });
  const proposed = parsePlan(content, { filePath });

  // 1b. Mass-deletion guard (EI-83 / audit P-040) — a body that shrinks the
  //     plan past the byte ratio OR drops most of its items/decisions is far
  //     more often a truncated paste or a wrong-plan write than an intentional
  //     rewrite. Require the caller to say so explicitly via allowShrink.
  if (!opts.allowShrink) {
    const shrink = detectSuspiciousShrink(current, content, currentParsed, proposed);
    if (shrink) return { newBody: null, value: shrink };
  }

  // 2. Legacy-boundary guard — a real plan must not be silently
  //    degraded to a (lint-exempt) legacy plan.
  if (!currentParsed.isLegacy && proposed.isLegacy) {
    return { newBody: null, value: { ok: false, code: 'would_orphan_frontmatter' } };
  }

  // 3. Lint the proposed body in-memory; errors block the write.
  //    `archived` is cosmetic for the lint rules — set-content targets
  //    active plans.
  const report = await lintParsed(proposed, slug, false);
  if (report.errors.length > 0) {
    return { newBody: null, value: { ok: false, code: 'lint_failed', errors: report.errors } };
  }

  const warning = shrinkWarning(currentParsed, proposed);
  return {
    newBody: content,
    value: { ok: true, slug, contentHash: hashPlanContent(content), ...(warning ? { warning } : {}) },
  };
}

export default defineTool({
  name: 'plans:set-content',
  description:
    'Replace a plan file wholesale, guarded by a compare-and-swap on `expectedHash`. For raw-prose edits the structured verbs cannot make. Rejects a stale write (file changed since load), a write that would strip a real plan back to legacy, and a write that fails lint. A successful write is recorded as a plan revision; pass `rationale` to capture the why. For large plan bodies, use plans:set-content-chunk instead so the provider sends multiple small tool calls.',
  guidance: {
    when: 'A human is editing the raw markdown of a plan — prose sections the assisted verbs (set-now / set-status / add-decision / add-item) do not cover. Use only for small-to-medium bodies that fit comfortably in one tool call.',
    notWhen:
      'A structured edit — flipping an item, replacing the Now block, appending a decision/item — use the assisted verb. Converting a legacy plan — use plans:set-frontmatter. Writing a large plan body — use plans:set-content-chunk begin → append* → commit.',
    chaining:
      'plans:get { slug } → carry `contentHash` → plans:set-content { slug, content, expectedHash: contentHash }. For large bodies: plans:set-content-chunk begin → append* → commit.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    // Append a plan_revisions row after the write, while the lock is
    // still held — so `seq` allocation is race-free (P-002 / D-003).
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      args.slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<SetContentValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-content',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      (current, meta) =>
        evaluateSetContent(current, args.content, args.slug, args.expectedHash, {
          expectedVersion: args.expectedVersion,
          meta,
          allowShrink: args.allowShrink,
        }),
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

    const v = result.value;
    if (!v.ok) {
      // Domain failures all use the `error` key (the plans:* convention);
      // stale + lint_failed carry their extra payload alongside it.
      const payload: Record<string, unknown> = { error: v.code, slug: args.slug };
      if (v.code === 'stale') {
        payload.currentContent = v.currentContent;
        payload.currentHash = v.currentHash;
        if (v.currentVersion != null) payload.currentVersion = v.currentVersion;
      } else if (v.code === 'lint_failed') {
        payload.errors = v.errors;
      } else if (v.code === 'suspicious_shrink') {
        payload.reason = v.reason;
        payload.currentLength = v.currentLength;
        payload.proposedLength = v.proposedLength;
        if (v.reason === 'structure') {
          payload.priorItems = v.priorItems;
          payload.priorDecisions = v.priorDecisions;
          payload.droppedItems = v.droppedItems;
          payload.droppedDecisions = v.droppedDecisions;
          payload.hint = `This write drops ${v.droppedItems} of ${v.priorItems} items and ${v.droppedDecisions} of ${v.priorDecisions} decisions — looks like a truncation. If intentional, retry with allowShrink: true.`;
        } else {
          payload.hint =
            'The proposed body is under 20% of the live plan — looks like a mass deletion. If intentional, retry with allowShrink: true.';
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        isError: true,
      };
    }

    // Cross-store invariant: a whole-document write can flip the frontmatter
    // status to a terminal value (e.g. rejectDraftPlan sets superseded). If
    // it did, clear the operational started/paused row so a terminal plan is
    // never counted as "waiting". Best-effort — plans:list self-heals on read.
    if (isTerminalPlanStatus(parsePlan(args.content, { filePath: `${args.slug}.md` }).frontmatter.status)) {
      try {
        await clearStartedForTerminalPlan(harnessSlug ?? operatorHomeHarnessSlug(), args.slug);
      } catch {
        /* recovered by reconcileStartStatus on the next plans:list read */
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: v.slug,
            contentHash: v.contentHash,
            // Surfacing (EI-83 fix #2): present only when the write removed
            // items/decisions — so even an allowed shrink is visible.
            ...(v.warning ? { warning: v.warning } : {}),
            version: result.version,
            filePath: result.filePath,
            // The revision row appended for this write (D-003). `null`
            // when the best-effort append failed — the file write still
            // succeeded; the gap is recoverable via P-005's backfill.
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          }),
        },
      ],
    };
  },
});
