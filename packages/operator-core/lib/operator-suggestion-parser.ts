import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import {
  SuggestionSchema,
  clampSuggestion,
  resolveActualTier,
  type EnrichedSuggestion,
  type ProvenanceFlags,
  type Suggestion,
} from './operator-suggestion-schema';
import type { OperatorPreferences } from './operator-preferences';
import { isOnCooldown } from './operator-dismissed-cache';
import { resolvePluginAwareTierSync } from './operator-plugin-tier';

const SUGGESTION_RE = /<suggestion>\s*([\s\S]*?)\s*<\/suggestion>/gi;

export interface ParsedBlock {
  /** Server-enriched, lifecycle-ready suggestion. */
  suggestion: EnrichedSuggestion;
}

export interface ParseResult {
  blocks: ParsedBlock[];
  parseErrors: string[];
}

/**
 * Parse `<suggestion>` blocks out of the LLM's stream, validate via Zod,
 * resolve authoritative tier from the substrate table, and derive
 * `auto_dispatch` from `(actualTier, preferences)`.
 *
 * Malformed blocks are surfaced as `parseErrors`; the rest stream through.
 */
export async function parseSuggestions(
  text: string,
  preferences: OperatorPreferences,
): Promise<ParseResult> {
  const result: ParseResult = { blocks: [], parseErrors: [] };
  const seenIds = new Set<string>();
  for (const match of text.matchAll(SUGGESTION_RE)) {
    const raw = match[1];
    if (!raw) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      result.parseErrors.push(
        `JSON parse failed: ${err instanceof Error ? err.message : String(err)}; raw=${raw.slice(0, 80)}…`,
      );
      continue;
    }
    const validated = SuggestionSchema.safeParse(json);
    if (!validated.success) {
      result.parseErrors.push(
        `schema mismatch: ${validated.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
      continue;
    }
    const enriched = enrich(validated.data, preferences);
    if (seenIds.has(enriched.raw.id)) continue; // de-dup within one scan
    if (await isOnCooldown(enriched.raw.id)) continue; // dismissed-cooldown
    seenIds.add(enriched.raw.id);
    result.blocks.push({ suggestion: enriched });
  }
  return result;
}

/**
 * Lift a Zod-validated suggestion into the enriched form the panel
 * reducer consumes: clamp oversized strings, resolve authoritative tier,
 * derive `auto_dispatch`, attach provenance flags.
 */
export function enrich(
  raw: Suggestion,
  preferences: OperatorPreferences,
): EnrichedSuggestion {
  const clamp = clampSuggestion(raw);
  const tierResult = resolveActualTier(clamp.s, resolvePluginAwareTierSync);
  const provenanceFlags: ProvenanceFlags = {};
  if (tierResult.tier !== clamp.s.tier) provenanceFlags.tierMismatch = true;
  if (tierResult.capabilityUnknown) provenanceFlags.capabilityUnknown = true;
  if (clamp.oversizedTitle) provenanceFlags.oversizedTitle = true;
  if (clamp.oversizedWhy) provenanceFlags.oversizedWhy = true;
  const auto_dispatch = deriveAutoDispatch(clamp.s, tierResult.tier, preferences);
  return {
    raw: clamp.s,
    actualTier: tierResult.tier,
    auto_dispatch,
    provenanceFlags,
  };
}

/**
 * Single source of truth for `auto_dispatch`, expressed as a declarative
 * `@papercusp/rules` `DataCondition` (adopt-event-rules-engines D-003 — the
 * tier→dispatch decision table):
 *   tier=low     → true
 *   tier=medium  → true unless it's a `send_directive` with no matching standing approval
 *   tier=high    → false always (no branch matches)
 *
 * The standing-approval *lookup* (a join against the user's preferences) is the
 * consumer's job — it's reduced to a `hasStandingApproval` boolean fed into the
 * event; the rule expresses only the tier/action *policy* over that boolean.
 */
const AUTO_DISPATCH_POLICY: DataCondition = {
  any: [
    { tier: { equals: 'low' } },
    { all: [{ tier: { equals: 'medium' } }, { action: { notEquals: 'send_directive' } }] },
    { all: [{ tier: { equals: 'medium' } }, { hasStandingApproval: { equals: true } }] },
  ],
};

export function deriveAutoDispatch(
  s: Suggestion,
  actualTier: 'low' | 'medium' | 'high',
  preferences: OperatorPreferences,
): boolean {
  const hasStandingApproval = preferences.standingApprovals.some(
    (a) => a.capability === s.capability && a.targetHarness === s.target_harness,
  );
  return evaluateDataCondition(AUTO_DISPATCH_POLICY, {
    tier: actualTier,
    action: s.action,
    hasStandingApproval,
  });
}
