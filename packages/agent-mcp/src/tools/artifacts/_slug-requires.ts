/**
 * Shared `requires:` preconditions for the artifacts:* tools
 * (adopt-event-rules-engines-2026-06-04, the requires:-half — D-012).
 *
 * The former in-handler guards — `if (!slug) throw` + `if (!SLUG_RE.test(slug))
 * throw` — lifted into declarative preconditions the dispatcher enforces before
 * the handler runs. A slug must arrive via the arg or the spawn ctx; when it
 * comes from ctx it must also be SLUG_RE-valid (an arg slug is already
 * zod-validated by each tool's args schema, so the validity spec only needs to
 * cover the ctx path).
 */

import type { ToolRequireSpec } from '@papercusp/tooldef';

/** Mirrors each tool's `args.slug` zod regex — one slug grammar everywhere. */
export const SLUG_RE = /^[a-z0-9._-]+$/i;

/** The two harness-slug preconditions, parameterized by tool name (errors only). */
export function slugRequires(toolName: string): ToolRequireSpec[] {
  return [
    {
      id: 'harness-slug',
      when: {
        any: [{ 'args.slug': { truthy: true } }, { 'ctx.harnessSlug': { truthy: true } }],
      },
      error: `${toolName} — \`slug\` required (no harnessSlug in spawn context)`,
    },
    {
      id: 'valid-ctx-slug',
      when: {
        any: [
          { 'args.slug': { truthy: true } },
          { 'ctx.harnessSlug': { matches: { source: SLUG_RE.source, flags: 'i' } } },
        ],
      },
      error: `${toolName} — invalid harnessSlug in spawn context`,
    },
  ];
}
