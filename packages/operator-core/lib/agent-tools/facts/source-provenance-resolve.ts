/**
 * source-provenance-resolve.ts — assert-time verification of a TYPED fact
 * sourceRef (coord-authority-hardening-2026-07-11 P-007 / H3+C).
 *
 * A fact's `sourceRef` ("the anchor that proved it") was free text — the same
 * EI-9501 hole H2 closed for relays: "src: owner said so" is unverifiable at
 * read time. When the sourceRef parses as a TYPED ref, the PLATFORM verifies it
 * against its own store AT ASSERT TIME and stamps the fact
 * ({@link FactSourceProvenance}); every future fold then renders the verified
 * quote with ZERO extra reads (the D-002 zero-extra-calls principle: verify
 * once at the write, deliver from the stamp forever).
 *
 * Typed shapes (D-004 — all resolved through the SHARED ref/relay machinery,
 * never a parallel resolver):
 *   msg:<id>            → coord message must exist (P-001 default msg resolver);
 *                         quote = bounded summary/body verbatim.
 *   wi:<id> / WI- / EI- → work-item must exist (P-001 default WI resolver);
 *                         quote = title/summary, label carries kind/state.
 *   owner-turn          → the caller's CURRENT human turn, read server-side
 *                         from the session store (H2 Tier-2 reuse) — the fact
 *                         carries the owner's verbatim words, not the agent's
 *                         paraphrase (D-005).
 * Anything else (plan slugs, prose, gate:/plan: refs) stays a plain free-text
 * anchor — no stamp, unchanged behavior.
 *
 * Fail-soft BY CONTRACT: verification decorates the assert, never blocks it.
 * A lookup miss / store error stamps `{ verified:false, error }` — rendered
 * LOUDLY in folds (`✗unverified`) instead of failing the write; only the
 * caller's zod/scope validation can reject an assert.
 */

import type { AgentIdentity } from '../coordination/identity';
import { parseRefToken, clampSnippet } from '../coordination/ref-hydrate';
import { hydrateRefs } from '../coordination/ref-hydrate-resolve';
import { resolveRelayProvenance } from '../coordination/relay-provenance-resolve';
import { OWNER_TURN_SENTINEL } from '../coordination/relay-provenance';
import {
  FACT_PROVENANCE_QUOTE_CHARS,
  type FactSourceProvenance,
} from '../../agent-facts/store';

/**
 * Resolve a sourceRef into an assert-time provenance stamp.
 * `null` = not a typed ref (free-text anchor — store it unstamped, unchanged).
 */
export async function resolveFactSourceProvenance(
  identity: AgentIdentity,
  sourceRef: string,
): Promise<FactSourceProvenance | null> {
  const ref = parseRefToken(sourceRef);
  if (!ref) return null;
  const verifiedAt = new Date().toISOString();

  try {
    if (ref.kind === 'owner-turn') {
      const { stamp } = await resolveRelayProvenance(identity, { relayOf: OWNER_TURN_SENTINEL });
      if (stamp?.tier === 'owner-verified-turn') {
        return {
          kind: 'owner-turn',
          verified: true,
          quote: clampSnippet(stamp.quote, FACT_PROVENANCE_QUOTE_CHARS),
          ...(stamp.turnTs ? { label: `owner turn ${stamp.turnTs}` } : {}),
          verifiedAt,
        };
      }
      return { kind: 'owner-turn', verified: false, error: 'owner_turn_unresolved', verifiedAt };
    }

    if (ref.kind === 'msg' || ref.kind === 'work-item') {
      const [h] = await hydrateRefs([ref], {
        budget: { snippetChars: FACT_PROVENANCE_QUOTE_CHARS, maxRefs: 1 },
      });
      if (h?.ok) {
        return {
          kind: ref.kind,
          verified: true,
          ...(h.snippet ? { quote: h.snippet } : {}),
          label: h.label,
          verifiedAt,
        };
      }
      return { kind: ref.kind, verified: false, error: h?.error ?? 'not_found', verifiedAt };
    }
  } catch {
    // Fail-soft: a store hiccup stamps loud-unverified, never blocks the assert.
    const kind = ref.kind === 'msg' || ref.kind === 'work-item' ? ref.kind : 'owner-turn';
    return { kind, verified: false, error: 'resolve_error', verifiedAt };
  }

  // plan-item / gate refs: not in the v1 typed-verification set — free text.
  return null;
}
