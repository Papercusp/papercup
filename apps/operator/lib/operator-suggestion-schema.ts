import { z } from 'zod';
import { lookupTier, type CapabilityTier } from '@papercusp/plugin-sdk';

/**
 * Operator suggestion schema (v5).
 *
 * 3 action variants, discriminated on `action`. The LLM emits these inside
 * `<suggestion>...</suggestion>` blocks; the server validates with Zod,
 * resolves the authoritative `tier` from the substrate `tier-table.json`,
 * and derives `auto_dispatch` from `(actualTier, preferences)`.
 *
 * Keep `title` ≤160 / `why` ≤280 — both are read aloud by voice mode.
 */

export const TITLE_MAX = 160;
export const WHY_MAX = 280;
export const REASON_MIN = 10;

// Note: title/why have NO `.max()` here — oversize is clamped post-validation
// in `clampSuggestion()` and surfaced via `provenanceFlags.oversized*`. The
// substrate prompt documents the soft limits; the LLM is nudged, not rejected.
const baseFields = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  why: z.string().min(1),
  reason: z.string().min(REASON_MIN),
  tier: z.enum(['low', 'medium', 'high']),
});

export const SuggestionSchema = z.discriminatedUnion('action', [
  baseFields.extend({
    action: z.literal('send_directive'),
    capability: z.literal('messages:write'),
    target_harness: z.string().min(1),
    directive_kind: z.enum(['Directive', 'Decision', 'Priority']),
    directive_subject: z.string().min(1),
    directive_body: z.string().min(1),
  }),
  baseFields.extend({
    action: z.literal('navigate'),
    capability: z.null(),
    target_harness: z.string().min(1),
    target_resource: z.string().min(1),
  }),
  baseFields.extend({
    action: z.literal('inform'),
    capability: z.null(),
    body: z.string().min(1),
  }),
  /**
   * High-level conversational suggestion the scanner surfaces to the
   * operator BRAIN, not to the user as a clickable card. Used by
   * operator-converse to compose contextual replies. Strict scope:
   *   - Non-technical decisions only (pricing, scope, direction)
   *   - NOT implementation choices ("which library", "which API")
   *   - NO capability gate, NO target_resource, NO directive — these
   *     are conversational prompts the operator weaves into chat,
   *     never auto-dispatched. If something needs an action, use
   *     send_directive/navigate instead.
   * Rendered as a prompt section in operator-converse, not as a panel
   * card. The operator says it (or doesn't, depending on context)
   * during the next open_canvas / user_says_ready turn.
   */
  baseFields.extend({
    action: z.literal('ask_user'),
    capability: z.null(),
    /** The question to surface to the user in chat. */
    question: z.string().min(1),
    /** Optional context the brain uses to frame the question. */
    framing: z.string().optional(),
  }),
]);

export type Suggestion = z.infer<typeof SuggestionSchema>;

export interface ProvenanceFlags {
  tierMismatch?: boolean;
  capabilityUnknown?: boolean;
  oversizedTitle?: boolean;
  oversizedWhy?: boolean;
  /** True when the suggestion came from a plugin's contributeOperatorSuggestions hook. */
  pluginAuthored?: boolean;
}

/**
 * Server-enriched form, what the panel reducer actually receives.
 *   - `actualTier` is authoritative (substrate-derived).
 *   - `auto_dispatch` is derived from (actualTier, standing approvals).
 *   - `provenanceFlags` carries soft diagnostics for UI display.
 */
export interface EnrichedSuggestion {
  raw: Suggestion;
  actualTier: CapabilityTier;
  auto_dispatch: boolean;
  provenanceFlags: ProvenanceFlags;
}

/**
 * Resolve the authoritative tier for a suggestion. Variants without a
 * capability (`navigate`, `inform`) are always `low` — they don't dispatch.
 * `send_directive` looks the capability up in the substrate table; an
 * unknown capability falls through to `high` (fail-safe).
 *
 * Optional `pluginLookup` consults plugin manifests for plugin-defined
 * caps. When omitted (or returns null for the cap), the fail-safe `high`
 * result still applies.
 */
export function resolveActualTier(
  s: Suggestion,
  pluginLookup?: (cap: string) => CapabilityTier | null,
): {
  tier: CapabilityTier;
  capabilityUnknown: boolean;
} {
  if (s.action !== 'send_directive') return { tier: 'low', capabilityUnknown: false };
  const substrate = lookupTier(s.capability);
  if (substrate !== null) return { tier: substrate, capabilityUnknown: false };
  const plugin = pluginLookup?.(s.capability) ?? null;
  if (plugin !== null) return { tier: plugin, capabilityUnknown: false };
  return { tier: 'high', capabilityUnknown: true };
}

/**
 * Truncate oversized fields and surface the truncation as a flag. Keeps the
 * panel + voice surface from breaking on a runaway title; the LLM gets a
 * soft signal via `provenanceFlags` to do better next time.
 */
export function clampSuggestion(raw: Suggestion): {
  s: Suggestion;
  oversizedTitle: boolean;
  oversizedWhy: boolean;
} {
  let oversizedTitle = false;
  let oversizedWhy = false;
  let title = raw.title;
  let why = raw.why;
  if (title.length > TITLE_MAX) {
    title = title.slice(0, TITLE_MAX);
    oversizedTitle = true;
  }
  if (why.length > WHY_MAX) {
    why = why.slice(0, WHY_MAX);
    oversizedWhy = true;
  }
  if (!oversizedTitle && !oversizedWhy) return { s: raw, oversizedTitle, oversizedWhy };
  return { s: { ...raw, title, why } as Suggestion, oversizedTitle, oversizedWhy };
}
