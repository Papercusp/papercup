/**
 * plans:set-template-data — write a plan's STRUCTURED template instance data,
 * validated against its template TYPE's registry zod schema on every write
 * (plan-templates-and-rubric-v2-2026-06-20 P-005).
 *
 * A template-instance plan declares a `template:` TYPE in its frontmatter (set via
 * plans:set-frontmatter-field, derived into the `template` column). THIS verb writes
 * the per-plan structured `template_data` jsonb — agents read/write the instance
 * data structured, never as markdown. The write is VALIDATED-ON-WRITE: `data` is
 * checked against the template type's code-registry zod schema
 * (template-registry.validateTemplateData) BEFORE it is persisted — an unknown type
 * or a schema violation rejects fail-loud, never silently stripping. A successful
 * write goes through withPlanLock (advisory-locked, version-bumped, revisioned) —
 * the structured-only path that writes template_data without touching content.
 *
 * The registry is the schema source. When the named type has no registered schema
 * yet (P-006 registers `rubric`; until then the registry may be empty), the write
 * rejects with `unknown_template` + the known types — the graceful no-schema case,
 * not a crash.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, type TemplateDataPatch } from './with-plan-lock';
import { parsePlan } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { validateTemplateData } from './template-registry';
import { softText, clampText, LIMITS } from '../limits';

export type SetTemplateDataValue =
  | { ok: true; slug: string; template: string }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan' }
  | { ok: false; code: 'no_template' }
  | { ok: false; code: 'unknown_template'; template: string; known: string[] }
  | { ok: false; code: 'invalid_data'; template: string; issues: string[] };

/**
 * The pure validate-on-write decision for a structured template_data write — the
 * sibling of evaluateSetContent (set-content.ts). Resolves the plan's template TYPE
 * from its `template:` frontmatter, validates `data` against that type's registry
 * zod schema, and returns the `template_data` patch to persist (the schema-COERCED
 * value) or a structured rejection. Exported so it unit-tests without a live PG —
 * the handler runs exactly this inside withPlanLock. Never throws.
 */
export function evaluateSetTemplateData(
  current: string | null,
  data: unknown,
  slug: string,
): { newBody: null; templateData?: TemplateDataPatch; value: SetTemplateDataValue } {
  if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
  const parsed = parsePlan(current, { filePath: `${slug}.md` });
  if (parsed.isLegacy) return { newBody: null, value: { ok: false, code: 'legacy_plan' } };

  const template = parsed.frontmatter.template?.trim();
  if (!template) return { newBody: null, value: { ok: false, code: 'no_template' } };

  const result = validateTemplateData(template, data);
  if (!result.ok) {
    return result.code === 'unknown_template'
      ? { newBody: null, value: { ok: false, code: 'unknown_template', template, known: result.known } }
      : { newBody: null, value: { ok: false, code: 'invalid_data', template, issues: result.issues } };
  }
  // Persist the schema-COERCED data (validateTemplateData returns parsed.data).
  return { newBody: null, templateData: { data: result.data }, value: { ok: true, slug, template } };
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  data: z
    .unknown()
    .describe(
      'The structured template instance data (jsonb) to write. Validated against the plan\'s template TYPE\'s registry zod schema before persisting — an unknown type or a schema violation is rejected fail-loud.',
    ),
  rationale: softText(LIMITS.ANNOTATION).optional().describe('Why — stored on the plan revision. Auto-truncated to 2000 chars if longer.'),
});

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:set-template-data',
  description:
    "Write a plan's STRUCTURED template instance data (the `template_data` jsonb), validated against its template TYPE's code-registry zod schema on write (validate-on-write). The plan must already declare a `template:` type (plans:set-frontmatter-field). Rejects fail-loud on an unknown type (no schema registered) or a schema violation — never silently strips. Advisory-locked, version-bumped, and recorded as a plan revision. Agents read/write the instance data structured here, never as markdown.",
  guidance: {
    when: 'Writing/updating a template-instance plan\'s structured data (e.g. a rubric instance\'s fields) — the validated, revisioned setter for the `template_data` jsonb.',
    notWhen:
      'Declaring WHICH template type a plan is (the `template:` frontmatter) — use plans:set-frontmatter-field. Editing the plan\'s prose/items — plans:set-content / the assisted verbs. Reading the data back — plans:get-template-data.',
    chaining:
      'plans:set-frontmatter-field { key:"template", value:"<type>" } (declare the type) → plans:set-template-data { slug, data } → plans:get-template-data to confirm.',
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
      clampText(args.rationale, LIMITS.ANNOTATION) ?? 'set template_data',
      harnessSlug ? { harnessSlug } : {},
    );

    const result = await withPlanLock<SetTemplateDataValue>(
      ctx as never,
      {
        slug: args.slug,
        intent: 'plans:set-template-data',
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current) => evaluateSetTemplateData(current, args.data, args.slug),
    );

    if (result.kind === 'busy') {
      return text(
        {
          error: 'busy',
          busy: result.busy.map((b) => ({
            path: b.path,
            owner_label: b.owner_label,
            intent: b.intent,
            expires_ts: b.expires_ts,
          })),
        },
        true,
      );
    }

    const v = result.value;
    if (!v.ok) {
      const payload: Record<string, unknown> = { error: v.code, slug: args.slug };
      if (v.code === 'unknown_template') {
        payload.template = v.template;
        payload.known = v.known;
        payload.hint =
          v.known.length > 0
            ? `No schema registered for template '${v.template}'. Known types: ${v.known.join(', ')}.`
            : `No template schemas are registered yet (P-006 registers 'rubric'). Cannot validate '${v.template}'.`;
      } else if (v.code === 'invalid_data') {
        payload.template = v.template;
        payload.issues = v.issues;
      } else if (v.code === 'no_template') {
        payload.hint =
          'This plan declares no template type. Set one first: plans:set-frontmatter-field { key:"template", value:"<type>" }.';
      }
      return text(payload, true);
    }

    // Refresh the plans rail so any template-derived facet updates immediately.
    try {
      const { notifySyncInvalidate } = await import('../../sync-sse');
      await notifySyncInvalidate('plans.list', undefined);
    } catch {
      /* best-effort — the next natural refresh picks it up */
    }

    return text({
      ok: true,
      slug: v.slug,
      template: v.template,
      version: result.version,
      revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
    });
  },
});
