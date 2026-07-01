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
 *
 * Bulk (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): a bulk call carries per-item slugs
 * on `args.items[]`, so the top-level `args.slug` is absent. The declarative
 * precondition can't reach into the `items` array, so when `items` is present
 * BOTH preconditions short-circuit (hold) and per-item slug presence/validity
 * is re-asserted inside the handler — each bad item becomes an `{ ok:false,
 * error }` result rather than rejecting the whole batch. The n=1 single path
 * (`{ slug?, rel_path }`) is gated here exactly as before.
 */
import type { ToolRequireSpec } from '@papercusp/tooldef';
/** Mirrors each tool's `args.slug` zod regex — one slug grammar everywhere. */
export declare const SLUG_RE: RegExp;
/** The two harness-slug preconditions, parameterized by tool name (errors only). */
export declare function slugRequires(toolName: string): ToolRequireSpec[];
/**
 * Resolve + validate a per-item (or single-call) slug against the spawn ctx
 * fallback — the in-handler half of the slug guard for the bulk path. Mirrors
 * the `slugRequires` preconditions per item: a slug must arrive via the item or
 * the spawn ctx, and must be SLUG_RE-valid. Returns the resolved slug or an
 * error string (the per-item op turns the string into `{ ok:false, error }`).
 */
export declare function resolveSlug(toolName: string, itemSlug: string | undefined, ctxHarnessSlug: string | null | undefined): {
    slug: string;
} | {
    error: string;
};
