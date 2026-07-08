/**
 * plans:edit — targeted in-place edit of a plan body by exact string replace.
 *
 * The surgical complement to plans:set-content (whole-document) and the
 * structured verbs (set-now / add-decision / add-item, which only reach one
 * parser region each). This is the "fix the relevant part" verb: it replaces an
 * exact `old_string` with `new_string` in the canonical plan content — the same
 * ergonomics as the file Edit tool — so an agent can correct a stale citation, a
 * line in `## Background`, or a paragraph in a decision body WITHOUT resending the
 * whole document (which for a large plan means a chunked re-upload).
 *
 * Safety — three guards, mirroring set-content, plus the Edit-tool match guard:
 *   1. MATCH guard. `old_string` must occur exactly once (unless `replace_all`).
 *      0 occurrences → `string_not_found`; >1 without replace_all →
 *      `string_not_unique`. This match IS the primary concurrency guard: if a
 *      concurrent edit changed the surrounding text, `old_string` no longer
 *      matches and the edit fails cleanly — so `expectedHash` is OPTIONAL here
 *      (no plans:get round-trip needed), unlike set-content.
 *   2. CAS (optional). If `expectedHash` is supplied it is still honored (reject
 *      `stale` on mismatch), for callers that want belt-and-suspenders.
 *   3. Legacy-boundary + lint. The resulting body is parsed + linted in-memory
 *      (via the shared evaluateSetContent decision); a result that would degrade
 *      a real plan to legacy, or that fails lint, is rejected.
 *
 * Writes inside withPlanLock and records a plan revision, exactly like
 * set-content. Reuses evaluateSetContent for the CAS/legacy/lint/return so the
 * two write verbs share one safety core.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock } from './with-plan-lock';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { evaluateSetContent, type SetContentValue } from './set-content';

const argsSchema = z.object({
  slug: z.string().min(1),
  harness: harnessArg,
  old_string: z
    .string()
    .min(1)
    .describe('The exact substring to replace (must occur once, unless replace_all). Include enough surrounding context to be unique — same rules as the file Edit tool.'),
  new_string: z
    .string()
    .describe('The replacement text (may be empty to delete `old_string`). Must differ from old_string.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of requiring a unique match. Default false.'),
  expectedHash: z
    .string()
    .optional()
    .describe('Optional CAS baseline — the `contentHash` from plans:get. Usually unnecessary: the exact old_string match is itself the concurrency guard. When supplied and stale, the edit is rejected.'),
  rationale: z
    .string()
    .optional()
    .describe('Optional — the why behind this edit. Stored on the plan revision (D-009).'),
});

export type PlanEditValue =
  | SetContentValue
  | { ok: false; code: 'string_not_found' }
  | { ok: false; code: 'string_not_unique'; count: number }
  | { ok: false; code: 'no_change' };

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Pure decision for a plans:edit write — exported for unit testing without the
 * lock side-database. Computes the replaced body from the exact-match guard,
 * then delegates to evaluateSetContent for CAS + legacy-boundary + lint.
 *
 *   - `current` is the live body, or null if the file is absent.
 */
export async function evaluatePlanEdit(
  current: string | null,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  slug: string,
  expectedHash: string | undefined,
  opts: { expectedVersion?: number; meta?: { version: number; contentHash: string } | null } = {},
): Promise<{ newBody: string | null; value: PlanEditValue }> {
  if (current === null) {
    return { newBody: null, value: { ok: false, code: 'not_found' } };
  }
  if (oldString === newString) {
    return { newBody: null, value: { ok: false, code: 'no_change' } };
  }
  const count = countOccurrences(current, oldString);
  if (count === 0) {
    return { newBody: null, value: { ok: false, code: 'string_not_found' } };
  }
  if (count > 1 && !replaceAll) {
    return { newBody: null, value: { ok: false, code: 'string_not_unique', count } };
  }
  const content = replaceAll
    ? current.split(oldString).join(newString)
    : current.replace(oldString, newString);

  // Delegate to the shared CAS + legacy-boundary + lint core. (CAS re-checks the
  // same `current`; harmless and keeps one safety path.)
  return evaluateSetContent(current, content, slug, expectedHash, opts);
}

export default defineTool({
  name: 'plans:edit',
  description:
    'Edit a plan in place by exact string replace (old_string → new_string), like the file Edit tool — the surgical way to fix a citation, a line, or a paragraph without resending the whole document. old_string must match exactly once (or pass replace_all). Rejects: string_not_found, string_not_unique, a result that would degrade the plan to legacy, or a lint failure. Records a plan revision. expectedHash is optional — the exact match is the concurrency guard.',
  guidance: {
    when: 'Correcting or rewriting a SPECIFIC part of a plan body the structured verbs cannot reach — a stale citation, a wrong line, a paragraph in `## Background` or a decision body. The default for small/targeted prose fixes.',
    notWhen:
      'Replacing the whole Now block (set-now), appending a decision/item (add-decision / add-item), or flipping status (set-status) — use the structured verb. A wholesale rewrite of most of the document — use plans:set-content / set-content-chunk.',
    chaining:
      'Read the current text (plans:get) → plans:edit { slug, old_string, new_string }. For several edits, call plans:edit repeatedly (each is CAS-safe on its own match).',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
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
    const result = await withPlanLock<PlanEditValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:edit',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      (current, meta) =>
        evaluatePlanEdit(current, args.old_string, args.new_string, args.replace_all ?? false, args.slug, args.expectedHash, {
          meta,
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
      const payload: Record<string, unknown> = { error: v.code, slug: args.slug };
      if (v.code === 'stale') {
        payload.currentContent = v.currentContent;
        payload.currentHash = v.currentHash;
        if (v.currentVersion != null) payload.currentVersion = v.currentVersion;
      } else if (v.code === 'lint_failed') {
        payload.errors = v.errors;
      } else if (v.code === 'string_not_unique') {
        payload.count = v.count;
        payload.hint = 'add surrounding context to old_string to make it unique, or pass replace_all: true';
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        isError: true,
      };
    }

    // NB: a targeted edit could in principle flip frontmatter status to terminal
    // (by editing the `status:` line), but that's what set-plan-status is for;
    // the started/paused cleanup is skipped here and plans:list self-heals it
    // (reconcileStartStatus) on the next read.
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: v.slug,
            contentHash: v.contentHash,
            version: result.version,
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
            // Item-parse feedback (WI-3363), computed in evaluateSetContent — a
            // targeted edit can silently break (or fix) an item line, so report
            // itemsParsed + a hint when list-like lines look like unparsed items.
            ...v.parseFeedback,
          }),
        },
      ],
    };
  },
});
