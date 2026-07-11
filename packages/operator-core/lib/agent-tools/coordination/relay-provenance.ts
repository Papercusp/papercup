/**
 * relay-provenance.ts — typed, platform-VERIFIED provenance for a RELAYED
 * directive (coord-authority-hardening-2026-07-11 P-004 / H2, owner-ratified
 * three-tier spec in the plan body).
 *
 * The EI-9501 telephone game: an agent re-types "OWNER DIRECTIVE: …" in its own
 * words and the receiver cannot tell owner text from the relayer's paraphrase.
 * H2 kills it with ZERO extra tool calls on either side: the sender passes
 * `relayOf` (a coord msg_id, or the `"owner-turn"` sentinel) or `relayQuote`
 * (a verbatim snippet), and the PLATFORM — at send time, server-side —
 * verifies the reference against its own stores, captures a bounded verbatim
 * quote, and stamps the envelope. Delivery renders the stamped tier + quote;
 * the receiver never fetches anything.
 *
 * Tiers (highest trust first):
 *   owner-verified(turn)             — Tier 2: the caller's CURRENT human turn,
 *                                      read server-side from the session store.
 *   owner-verified(transcript-match) — Tier 3 hit: sender-supplied quote found
 *                                      verbatim as a human turn in the caller's
 *                                      own transcript.
 *   coord-origin                     — Tier 1: origin is a real coord message,
 *                                      loaded + verified by id; chain extends
 *                                      relay-of-relay to root.
 *   unverified                       — Tier 3 miss: delivered, loudly stamped.
 *
 * Pure + import-light (only the pure ref-hydrate helpers): coord-schema (the
 * injection renderer) imports the read/render halves without pulling the DB
 * graph — same house pattern as cue-authority.ts. IO lives in
 * ./relay-provenance-resolve.ts.
 */

import { clampSnippet } from './ref-hydrate';

export type RelayProvenanceTier =
  | 'owner-verified-turn'
  | 'owner-verified-transcript'
  | 'coord-origin'
  | 'unverified';

export interface RelayProvenanceStamp {
  tier: RelayProvenanceTier;
  /** Bounded verbatim quote of the referenced original. Tiers 1/2: captured
   *  SERVER-SIDE (never the sender's paraphrase). Tier 3: sender-supplied,
   *  verified (or not) against the caller's transcript. */
  quote: string;
  /** Tier 1: the verified origin coord msg_id. */
  originMsgId?: string;
  /** Tier 1 multi-hop: msg_id chain, ROOT FIRST — a relay of a relay extends
   *  it; every link was verified to exist at ITS send time. */
  chain?: string[];
  /** Whether the verified ROOT is owner text or an agent message. */
  origin?: 'owner' | 'agent';
  /** Tier 2: the caller session whose human turn was captured, + its ts. */
  sessionId?: string;
  turnTs?: string;
}

/** The reserved envelope field the stamp rides on (nested object — same
 *  pass-through contract as cueAuthority). */
export const RELAY_PROVENANCE_FIELD = 'relayProvenance';

/** The `relayOf` sentinel for "the human turn I am currently answering". */
export const OWNER_TURN_SENTINEL = 'owner-turn';

/** Quote budget — bounded so a stamped envelope stays injection-friendly. */
export const RELAY_QUOTE_CHARS = 300;
/** Render-time cap for the inline `↪` suffix on a [coord+N] line. */
export const RELAY_RENDER_CHARS = 160;

const TIERS: ReadonlySet<string> = new Set([
  'owner-verified-turn',
  'owner-verified-transcript',
  'coord-origin',
  'unverified',
]);

/**
 * Read + validate a relay-provenance stamp off an envelope / inbox entry.
 * Defensive — absent/malformed → null, never throws (a forged or legacy
 * envelope can't crash the renderer).
 */
export function readRelayProvenance(
  env: Record<string, unknown> | null | undefined,
): RelayProvenanceStamp | null {
  const raw = env?.[RELAY_PROVENANCE_FIELD];
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.tier !== 'string' || !TIERS.has(s.tier)) return null;
  if (typeof s.quote !== 'string') return null;
  return {
    tier: s.tier as RelayProvenanceTier,
    quote: s.quote,
    ...(typeof s.originMsgId === 'string' && s.originMsgId ? { originMsgId: s.originMsgId } : {}),
    ...(Array.isArray(s.chain) && s.chain.every((c) => typeof c === 'string')
      ? { chain: s.chain as string[] }
      : {}),
    ...(s.origin === 'owner' || s.origin === 'agent' ? { origin: s.origin } : {}),
    ...(typeof s.sessionId === 'string' && s.sessionId ? { sessionId: s.sessionId } : {}),
    ...(typeof s.turnTs === 'string' && s.turnTs ? { turnTs: s.turnTs } : {}),
  };
}

/** The short trust tag a reader scans: `owner-verified(turn)` /
 *  `owner-verified(transcript-match)` / `coord-origin(<root msg_id>)` /
 *  `UNVERIFIED relay`. */
export function renderRelayProvenanceTag(stamp: RelayProvenanceStamp): string {
  switch (stamp.tier) {
    case 'owner-verified-turn':
      return 'owner-verified(turn)';
    case 'owner-verified-transcript':
      return 'owner-verified(transcript-match)';
    case 'coord-origin': {
      const root = stamp.chain?.[0] ?? stamp.originMsgId;
      const originMark = stamp.origin === 'owner' ? 'owner via ' : '';
      return `coord-origin(${originMark}${root ?? '?'})`;
    }
    case 'unverified':
      return 'UNVERIFIED relay';
  }
}

/**
 * The inline `↪` suffix appended to an injection line: the verified quote,
 * render-capped. Empty quote → tag-only suffix (still shows the tier).
 */
export function renderRelayQuoteSuffix(stamp: RelayProvenanceStamp): string {
  const tag = renderRelayProvenanceTag(stamp);
  const q = clampSnippet(stamp.quote, RELAY_RENDER_CHARS);
  return q ? ` ↪ ${tag}: "${q}"` : ` ↪ ${tag}`;
}

/**
 * Heuristic flag (spec last line): free text CLAIMING owner/queen authority
 * with NO provenance tier. Flag only — never blocks, never demotes; word-bound
 * conservative patterns to keep false positives low. The renderer prefixes
 * `[UNVERIFIED authority claim]` when this fires on an unstamped message.
 */
const AUTHORITY_CLAIM_RE =
  /\b(?:owner|queen)\s+directive\b|\bowner\s+(?:said|says|asked|wants|approved|told|directed|ordered)\b|\bper\s+the\s+owner\b/i;

export function detectAuthorityClaim(text: string): boolean {
  return AUTHORITY_CLAIM_RE.test(text);
}
