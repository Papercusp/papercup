/**
 * flag-comment-lint — parses the FLAGS block's own doc comments in types.ts and
 * cross-checks each entry's declared default ("DEFAULT ON" / "DEFAULT OFF") against
 * its actual DARK_FLAGS membership (EI-9826, leader-directed class-fix).
 *
 * WHY THIS EXISTS: the exact same bug shape recurred 8+ times in this file's history
 * (WATCHDOG_AUTO_CLOSE, SUBSTRATE_LOG_SNAPSHOT, SUBSTRATE_SIDECAR, RECLAIM_STALLED,
 * PSU_END_USER, PLAN_PART_FEDERATION, GIT_SYNC_DERIVED_ATTRIBUTION, DOC_STEWARD, and
 * the WI-3855 sweep of 16 more) — a flag's OWN code comment says "DEFAULT OFF / dark"
 * while the flag is silently missing from DARK_FLAGS, so `FLAG_DEFAULTS` (which is
 * `!DARK_FLAGS.has(key)`) derives it live default-ON with zero owner ratification.
 * Nothing caught the disagreement at commit time. This module IS that catch.
 *
 * PARSING APPROACH — this is a lint over free-form prose comments, not a formal
 * grammar, so it is deliberately CONSERVATIVE: high precision over recall. It skips
 * (never asserts on) any entry it cannot classify with confidence, rather than
 * guessing and risking a false-positive CI failure on a legitimately fine entry. Real
 * mismatches it DOES find are exactly what a human reviewer would call a mismatch
 * reading the same text — the three normalization steps below just remove textual
 * noise a naive substring search would trip on:
 *
 *   1. QUOTED SPANS ARE STRIPPED. The established repo convention (every corrected
 *      WI-3855-class entry) is to narrate the OLD, WRONG claim inside literal double
 *      quotes when explaining the fix, e.g.:
 *        DEFAULT ON (WI-3855: this comment's own "DEFAULT OFF ... KNOWN_DARK_FLAGS"
 *        was never actually added to the DARK_FLAGS map, so ... it derived live
 *        default-ON) ...
 *      Without stripping the quoted span, a naive scan sees BOTH "DEFAULT ON" and
 *      "DEFAULT OFF" in the same block and can't tell which is the current claim.
 *      Quote-stripping removes the historical narrative, leaving only the entry's
 *      OWN current, unquoted declaration.
 *
 *   2. THE "alpha (flags-)default-on (policy)" BOILERPLATE IS STRIPPED. Many
 *      DELIBERATE-dark entries explain themselves by contrast with the repo-wide
 *      alpha policy, e.g. "DEFAULT OFF — DELIBERATE, NOT the alpha flags-default-on
 *      policy". The hyphenated phrase "default-on" inside that boilerplate is a
 *      reference to the GENERAL policy's name, not a claim about THIS flag, but it
 *      matches a naive `DEFAULT[\s-]+ON` scan and creates a false ambiguity.
 *
 *   3. AN ENTRY WHOSE (normalized) COMMENT STILL CONTAINS **BOTH** AN UNQUOTED
 *      "DEFAULT ON" AND AN UNQUOTED "DEFAULT OFF" IS SKIPPED, not asserted on. This
 *      happens legitimately when one comment block explains two related flags
 *      together (e.g. a flag's comment references a sibling flag's own default).
 *      Precision over recall: an unresolvable case is left to human review instead of
 *      being force-classified.
 */

export interface FlagCommentEntry {
  /** The FLAGS object key, e.g. "WATCHDOG_AUTO_CLOSE". */
  key: string;
  /** The flag's string value, e.g. "papercusp-watchdog-auto-close". */
  value: string;
  /** The comment block immediately above the entry's `KEY: "value",` line, with the
   *  `//` prefix + indentation stripped from each line and re-joined with spaces (so
   *  a claim word-wrapped across two comment lines is still one contiguous phrase). */
  comment: string;
}

/** Declarative default the entry's OWN comment claims — 'on' | 'off' | null (no
 *  confident unambiguous claim found — the entry is skipped by the checker). */
export type ClaimedDefault = 'on' | 'off' | null;

const FLAGS_BLOCK_START_RE = /^export const FLAGS = \{\s*$/m;
const FLAGS_BLOCK_END_RE = /^\} as const;\s*$/m;
const KEY_LINE_RE = /^\s*([A-Z0-9_]+):\s*"([^"]+)",?\s*$/;

/**
 * Parse every `KEY: "value",` entry inside `export const FLAGS = { ... } as const;`
 * out of the raw types.ts SOURCE TEXT, pairing each with its own preceding comment
 * block. Throws if the FLAGS block markers aren't found (a structural change to
 * types.ts this lint would need updating for — fail loud, not silently skip everything).
 */
export function parseFlagEntries(source: string): FlagCommentEntry[] {
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => FLAGS_BLOCK_START_RE.test(l));
  if (startIdx === -1) {
    throw new Error('flag-comment-lint: could not find "export const FLAGS = {" — has types.ts changed shape?');
  }
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (FLAGS_BLOCK_END_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error('flag-comment-lint: could not find the FLAGS block\'s closing "} as const;"');
  }

  const entries: FlagCommentEntry[] = [];
  let commentBuf: string[] = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    const m = line.match(KEY_LINE_RE);
    if (m) {
      entries.push({ key: m[1], value: m[2], comment: commentBuf.join(' ') });
      commentBuf = [];
    } else {
      const stripped = line.replace(/^\s*\/\/\s?/, '').trim();
      if (stripped) commentBuf.push(stripped);
    }
  }
  return entries;
}

/**
 * Parse the `[FLAGS.KEY, { case: ..., reason: ... }]` entries out of the DARK_FLAGS
 * map literal's raw source text, returning the set of dark-registered FLAGS keys.
 * A textual re-derivation (deliberately independent of importing the live `DARK_FLAGS`
 * export) so this lint can be exercised against an arbitrary fixture source string in
 * tests, not only the real module.
 */
export function extractDarkFlagKeys(source: string): Set<string> {
  const darkStart = source.indexOf('export const DARK_FLAGS');
  if (darkStart === -1) return new Set();
  const rest = source.slice(darkStart);
  const mapMatch = rest.match(/new Map<[^>]*>\(\[([\s\S]*?)\n\s*\]\);/);
  const body = mapMatch ? mapMatch[1] : rest;
  return new Set([...body.matchAll(/\[FLAGS\.([A-Z0-9_]+),/g)].map((m) => m[1]));
}

/** Strips quoted narrative spans + the "alpha (flags-)default-on (policy)" boilerplate
 *  (see the module doc's normalization steps 1-2) from a comment block. */
function normalize(comment: string): string {
  let s = comment.replace(/"[^"]*"/g, ' ');
  s = s.replace(/alpha[\s-]+(?:flags[\s-]+)?default[\s-]+on(?:\s+policy)?/gi, ' ');
  return s;
}

const DEFAULT_OFF_RE = /\bDEFAULT[\s-]+OFF\b/i;
const DEFAULT_ON_RE = /\bDEFAULT[\s-]+ON\b/i;

/** The entry's own claimed default, per the module doc's conservative parsing rules.
 *  Returns null (unclassifiable / ambiguous — skip, never assert) when the normalized
 *  comment contains both an unquoted "DEFAULT ON" and "DEFAULT OFF", or neither. */
export function claimedDefault(entry: FlagCommentEntry): ClaimedDefault {
  const normalized = normalize(entry.comment);
  const hasOff = DEFAULT_OFF_RE.test(normalized);
  const hasOn = DEFAULT_ON_RE.test(normalized);
  if (hasOff === hasOn) return null; // both or neither ⇒ unclassifiable, skip
  return hasOff ? 'off' : 'on';
}

export type MismatchKind = 'claims-dark-but-not-listed' | 'claims-light-but-listed-dark';

export interface FlagCommentMismatch {
  key: string;
  value: string;
  kind: MismatchKind;
}

/**
 * The core check: for every FLAGS entry with a confident, unambiguous claimed
 * default, assert it agrees with `darkKeys` membership. Returns every disagreement
 * found, in FLAGS declaration order — the caller (a test) decides how to react
 * (fail outright on a fixture; diff against a documented pending-allowlist on the
 * real tree).
 */
export function findMismatches(entries: FlagCommentEntry[], darkKeys: ReadonlySet<string>): FlagCommentMismatch[] {
  const out: FlagCommentMismatch[] = [];
  for (const entry of entries) {
    const claim = claimedDefault(entry);
    if (claim === null) continue;
    const inDark = darkKeys.has(entry.key);
    if (claim === 'off' && !inDark) {
      out.push({ key: entry.key, value: entry.value, kind: 'claims-dark-but-not-listed' });
    } else if (claim === 'on' && inDark) {
      out.push({ key: entry.key, value: entry.value, kind: 'claims-light-but-listed-dark' });
    }
  }
  return out;
}
