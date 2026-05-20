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
import * as fs from 'node:fs/promises';
import { withPlanLock } from './with-plan-lock';
import { PLAN_STATUSES } from './parser';

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
  slug: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'kebab-case, ends with alphanum'),
  title: z.string().min(1).max(200),
  status: z.enum([...PLAN_STATUSES] as [string, ...string[]]).optional(),
  owner: z.string().email().optional(),
});

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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
  roles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const date = todayISO();
    const status = args.status ?? 'draft';

    const result = await withPlanLock(
      ctx as never,
      {
        slug: args.slug,
        intent: `plans:new ${args.slug}`,
      },
      async (current) => {
        if (current !== null) {
          // Slug collision — leave existing untouched, signal via value.
          return { newBody: null, value: { ok: false as const, code: 'slug_exists' as const } };
        }
        const body = buildTemplate({
          slug: args.slug,
          title: args.title,
          status,
          owner: args.owner ?? null,
          date,
        });
        return { newBody: body, value: { ok: true as const, slug: args.slug } };
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
            text: JSON.stringify({ error: value.code, slug: args.slug }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: value.slug,
            filePath: result.filePath,
          }),
        },
      ],
    };
  },
});

// Re-export for test convenience; unused otherwise.
export { fs };
