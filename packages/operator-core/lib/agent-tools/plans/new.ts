/**
 * plans:new — create a new plan from a template.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2.
 *
 * Slug uniqueness check + frontmatter write happen inside one
 * locks:acquire on the destination path (§4.4). Two concurrent
 * calls with the same slug get one winner; the loser sees the file
 * already exists.
 *
 * The body it writes is the exact bytes a human would type — same
 * template as the worked example in §3.7 of the plan spec.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import * as fs from 'node:fs/promises';
import { withPlanLock } from './with-plan-lock';
import { PLAN_STATUSES } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { emitPlanAuthored } from '../../harness/usage-emitters';

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

const argsSchema = z.object({
  harness: harnessArg,
  slug: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'kebab-case, ends with alphanum')
    .describe(
      'Topic slug in kebab-case. A -YYYY-MM-DD suffix is appended automatically if not already present (plan filename convention, §3.1).',
    ),
  title: z.string().min(1).max(200),
  status: z.enum([...PLAN_STATUSES] as [string, ...string[]]).optional(),
  owner: z.string().email().optional(),
  rationale: z
    .string()
    .optional()
    .describe(
      "Optional — why this plan exists / what prompted its creation. Stored as the rationale of the plan's first revision (D-009).",
    ),
});

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Ensure a slug carries the §3.1 `-YYYY-MM-DD` filename suffix.
 * Appends `today` when the slug doesn't already end with a date, so
 * the plan filename convention holds regardless of what the caller
 * passed. Exported for unit testing.
 */
export function ensureDatedSlug(slug: string, today: string): string {
  return /-\d{4}-\d{2}-\d{2}$/.test(slug) ? slug : `${slug}-${today}`;
}

function buildTemplate(args: {
  slug: string;
  title: string;
  status: string;
  owner: string | null;
  date: string;
}): string {
  const ownerLine = args.owner ? `owner: ${args.owner}\n` : '';
  return `---
title: ${args.title}
slug: ${args.slug}
status: ${args.status}
created: ${args.date}
updated: ${args.date}
${ownerLine}---

# ${args.title}

## Now

**State:** Draft. Plan body to be filled in.

**Next:** human reviews scope and lists Phase 1 items.

## Background

(Why this plan exists; what problem it addresses.)

## Phase 1 — TODO

(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)

## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)
`;
}

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type NewPlanValue = { ok: true; slug: string } | { ok: false; code: 'slug_exists' };

export default defineTool({
  name: 'plans:new',
  description:
    'Create a new SU plan from the canonical template. Slug uniqueness enforced inside a lock; rejects if a file with the same slug already exists.',
  guidance: {
    when: 'You are starting a new plan and want a templated file with valid frontmatter ready to fill in.',
    notWhen:
      'You want to edit an existing plan — use plans:set-status / set-now / add-decision / add-item.',
    chaining:
      'plans:new → plans:set-now (replace placeholder Now) → plans:add-item to populate Phase 1.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const date = todayISO();
    const status = args.status ?? 'draft';
    // §3.1: plan filenames carry a -YYYY-MM-DD suffix; ensureDatedSlug
    // appends today's date when the caller didn't already include one.
    const slug = ensureDatedSlug(args.slug, date);

    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<NewPlanValue>(
      ctx as never,
      {
        slug,
        intent: `plans:new ${slug}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: NewPlanValue }> => {
        if (current !== null) {
          // Slug collision — leave existing untouched, signal via value.
          return { newBody: null, value: { ok: false, code: 'slug_exists' } };
        }
        const body = buildTemplate({
          slug,
          title: args.title,
          status,
          owner: args.owner ?? null,
          date,
        });
        return { newBody: body, value: { ok: true, slug } };
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

    const value = result.value;
    if (!value.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: value.code, slug }),
          },
        ],
        isError: true,
      };
    }

    await emitPlanEventForCaller(ctx, {
      planSlug: value.slug,
      event: 'created',
      after: args.title,
      detail: args.title,
    });
    // P-070 usage ledger (best-effort): authoring a plan is contributor activity
    // on a managed harness. Operator-level plans (harness:'all') have no harness
    // slug and the ledger is per-harness, so skip those.
    if (harnessSlug) void emitPlanAuthored(harnessSlug, value.slug);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: value.slug,
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          }),
        },
      ],
    };
  },
});

// Re-export for test convenience; unused otherwise.
export { fs };
