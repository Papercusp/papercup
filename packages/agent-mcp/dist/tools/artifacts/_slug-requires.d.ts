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
export declare const SLUG_RE: RegExp;
/** The two harness-slug preconditions, parameterized by tool name (errors only). */
export declare function slugRequires(toolName: string): ToolRequireSpec[];
