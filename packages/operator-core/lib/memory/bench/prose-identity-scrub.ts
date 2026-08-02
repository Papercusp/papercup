/**
 * Generation-time identity scrub for the prose benchmark corpus (WI-6994).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `prose-corpus-snapshot.ts` samples LIVE surfaces — doc_sections, session_turns,
 * harness_plans — and writes them to a fixture that is COMMITTED to shipped
 * source. Those surfaces are carry surfaces, where `[owner:<Name> <date>]` and
 * absolute home paths are *correct*; inside a shipped fixture they are the
 * WI-4776 identity leak.
 *
 * On 2026-08-02 that gap red-pinned the staging→main gate for the whole fleet:
 * `prose-corpus.v1.json` landed carrying 23 owner-name tags and 22 home paths,
 * and all three identity lints failed at once. Six agents spent ~2h on the red
 * because the gate's test section was green — the blocker was never a test.
 *
 * The leak was cleared in-place (WI-6878), but an in-place scrub is a MITIGATION:
 * the corpus is regenerated deliberately as new versions ("regenerate BOTH
 * together as a new version, never in place" — prose-corpus.ts), and nothing in
 * the generation path scrubbed identity. So `prose-corpus.v2` would have
 * reintroduced the identical gate red. This module is the durable half.
 *
 * ── WHAT IT DOES NOT TOUCH ──────────────────────────────────────────────────
 * `key` ONLY. The gold set binds expected results to corpus entry KEYS, so a
 * rewrite there silently invalidates every stored score. Scrub `text` and
 * `description`; never the key. (Measured on the v1 incident: 43/2029 entries
 * were dirty, all 2029 keys were preserved by the in-place scrub, and exactly 1
 * of 134 gold queries touched a dirty entry — and not on a redacted token.)
 *
 * ── AGREEMENT WITH THE DETECTORS IS THE SAFETY PROPERTY ─────────────────────
 * A scrub the detector disagrees with is a false green, not a fix (the same rule
 * `bash-substitution/corpus.ts` states for its own scrubber). So:
 *   - class 2 (home paths) REUSES `scrubIdentity` outright — no second copy;
 *   - class 3 (box literals) takes its match rule as a PARAMETER, built by the
 *     caller from the detector's own `literalPattern()`, so there is nothing to
 *     drift;
 *   - class 1 (owner-name tags) is the one genuine mirror, because no scrubber
 *     for it exists anywhere. It is pinned by `prose-corpus-identity.test.ts`,
 *     which runs the REAL `findOwnerNameLeaks` detector over scrubbed output —
 *     if this rewrite and that detector ever disagree, that test reds.
 */
import { scrubIdentity } from '../../bash-substitution/corpus';

/**
 * One class-3 literal rewrite, prepared by the caller.
 *
 * The detector module states the seam explicitly: "THE LITERALS ARE A PARAMETER,
 * NOT AN INTERNAL LOOKUP." Honouring it here is what makes this function pure and
 * testable — a test can pass synthetic literals, and this file (tracked source,
 * scanned by the very lint it serves) never has to spell a real box identity.
 */
export interface IdentityLiteralRule {
  /** The detector's key, e.g. `build-hostname` — carried for diagnostics. */
  key: string;
  /** Match rule, built from the detector's own `literalPattern()`. Needs the `g` flag. */
  rx: RegExp;
  /** What to put in its place — must itself be a generic//placeholder value. */
  replacement: string;
}

/**
 * FORM 1 — the `[owner:<name>` bracket tag.
 *
 * Mirrors `BRACKET_TAG` in `scripts/lib/identity-leak-patterns.mjs`. The
 * sanctioned fix is "strip the NAME, keep the tier and the date"
 * (`[owner:Jane 2026-07-13]` -> `[owner 2026-07-13]`), so the match deliberately
 * stops at the name and the replacement re-emits the bare tier.
 */
const BRACKET_TAG = /\[owner:\s*([A-Za-z][A-Za-z0-9._'-]*)/gi;

/**
 * FORM 2 — the `OWNER MANDATE (<Name>, <date>)` parenthetical header.
 *
 * Mirrors `PAREN_TAG`, but additionally consumes the separator that follows the
 * name so the rewrite leaves `OWNER MANDATE (2026-07-13)` rather than a dangling
 * `(, 2026-07-13)`. The three anchors of the original are preserved exactly: the
 * directive-noun phrase, a Capitalized digit-free first token, and that token
 * sitting in the attribution slot.
 */
const PAREN_TAG =
  /(\bowner\s+(?:mandate|rule|ask|directive|decision|request|order|instruction|say|says|said|wants?)\b\s*\(\s*)([A-Za-z][A-Za-z'.-]*)(?:\s*,\s*|\s+(?=\d)|(?=\s*\)))/gi;

/**
 * Names that identify NOBODY — mirrors `PLACEHOLDER_NAMES`. A tag using one of
 * these is not a leak, so rewriting it would be gratuitous churn in the corpus
 * text. Kept in step with the detector for exactly that reason: this set decides
 * what we DON'T touch, never what we let through.
 */
const PLACEHOLDER_NAMES = new Set([
  'jane', 'john', 'jdoe', 'jane-doe', 'johndoe', 'alice', 'bob', 'carol', 'dave',
  'someone', 'somebody', 'name', 'owner', 'user', 'example', 'test', 'testuser',
  'placeholder', 'redacted', 'anon', 'anonymous', 'foo', 'bar',
]);

/** A peer tag cites a session id (`[peer:su-…]`/`[owner:su-…]`), never a person. */
const isSessionId = (n: string): boolean => /^su-/i.test(n);
/** A bare date after the colon (`[owner:2026-07-13]`) names nobody. */
const isDateLike = (n: string): boolean => /^\d/.test(n);
/** A placeholder identifies nobody on purpose. */
const isPlaceholder = (n: string): boolean => PLACEHOLDER_NAMES.has(n.toLowerCase());
/** Form-2 only: a person's given name is Capitalized and digit-free. */
const looksLikePersonName = (n: string): boolean => n.length >= 2 && /^[A-Z][A-Za-z'.-]*$/.test(n);

/** Strip named owner-provenance tags, keeping the tier and the date. */
export function scrubOwnerNameTags(text: string): string {
  if (!text) return text;
  const bracketScrubbed = text.replace(BRACKET_TAG, (whole, name: string) => {
    if (isPlaceholder(name) || isSessionId(name) || isDateLike(name)) return whole;
    return '[owner';
  });
  return bracketScrubbed.replace(PAREN_TAG, (whole, pre: string, name: string) => {
    if (isPlaceholder(name) || isSessionId(name) || isDateLike(name)) return whole;
    if (!looksLikePersonName(name)) return whole;
    return pre;
  });
}

/**
 * Scrub every identity class from one piece of corpus prose.
 *
 * Order matters and is deliberate: home paths are rewritten FIRST, so
 * `/home/<account>` becomes `/home/dev` before the class-3 pass would otherwise
 * hunt that same account name inside a path it has already anonymised.
 *
 * @param text the raw prose sampled from a live surface
 * @param opts.literalRules class-3 rewrites; omit on a box that resolves none
 *   (the documented bare/CI no-op)
 * @param opts.selfUser this box's username, injectable so the munged-path rewrite
 *   is testable without writing a real identity into a test file
 */
export function scrubProseIdentity(
  text: string,
  opts: { literalRules?: IdentityLiteralRule[]; selfUser?: string } = {},
): string {
  if (!text) return text;
  let out = opts.selfUser === undefined ? scrubIdentity(text) : scrubIdentity(text, opts.selfUser);
  out = scrubOwnerNameTags(out);
  for (const rule of opts.literalRules ?? []) {
    out = out.replace(rule.rx, rule.replacement);
  }
  return out;
}

/**
 * The generic stand-in for each class-3 literal key.
 *
 * Every value is drawn from the detector's OWN exclusion sets (`GENERIC_ACCOUNTS`,
 * `isGenericHost`) so the replacement can never itself be flagged — the rewrite
 * has to land somewhere the lint already considers anonymous, or it just moves
 * the leak.
 */
export const IDENTITY_LITERAL_PLACEHOLDER: Record<string, string> = {
  'build-user-name': 'dev',
  'build-hostname': 'localhost',
  'build-git-email': 'dev@example.com',
  'build-git-name': 'dev',
};

/** Fallback for a literal key this module has no specific placeholder for. */
export const DEFAULT_IDENTITY_PLACEHOLDER = 'dev';
