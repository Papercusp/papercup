/**
 * identity-leak-patterns.mjs — the ONE detector for named owner-provenance tags in
 * shipped source, shared by the gate lint and the edit-time hook (EI-18670349543629060,
 * EI-18670296139788697).
 *
 * WHY THIS MODULE EXISTS (two bugs, one root)
 *
 * 1. THE MATCHER WAS TOO NARROW. check-no-owner-name-tags.mjs anchored only on the
 *    BRACKET form `[owner:<name> …]`, and justified that narrowness well: `[owner:` is a
 *    structured marker, so matching inside it is exact and has no false-positive surface.
 *    Sound — but agents do not only write the bracket form. Of the 11 leaks that red-ed the
 *    green gate on 2026-07-26, THREE were parenthetical section headers:
 *
 *      * OWNER RULE (Jane, 2026-07-25): "…"
 *      * OWNER MANDATE (Jane, 2026-07-25, verbatim): "…"
 *
 *    These leak the same person and evaded the guard entirely.
 *
 * 2. THE FEEDBACK ARRIVED HOURS LATE. The three identity lints ran only as a
 *    green-checkpoint leg, so a one-line tag red-ed the gate and froze `main` — 4h10m with
 *    41 commits buffered on 2026-07-26 — before anyone saw it. That is the same shape as
 *    EI-18147177863084708, which moved these lints from release-CUT time to checkpoint
 *    time for exactly this reason. This module is the next hop: EDIT time, in the author's
 *    own turn, seconds after they type it.
 *
 * The two consumers MUST agree on what a leak is, or the edit-time advisory becomes a liar
 * that green-lights what the gate later rejects. Hence one detector, imported by both:
 *   - scripts/check-no-owner-name-tags.mjs                       (the gate lint, blocking)
 *   - apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs (edit-time, advisory)
 *
 * THIS FILE OBEYS ITS OWN RULE. It is tracked source, so it is packed into
 * source.tar.zst and scanned by bin/audit-release-bundle.py. It therefore cannot spell a
 * real contributor's name even to illustrate the bug — every example above and below is a
 * PLACEHOLDER for that reason, not by accident.
 *
 * THE RULE: in shipped source cite the tier and the date, never the person.
 *   [owner:Jane 2026-07-13]                 ->  [owner 2026-07-13]
 *   OWNER MANDATE (Jane, 2026-07-13): "…"   ->  OWNER MANDATE (2026-07-13): "…"
 * The NAMED form stays correct on carry surfaces (work items, facts, checkpoints, plans) —
 * those are internal and never packed into the bundle.
 */

/**
 * Names that identify NOBODY: the stand-ins a test fixture or doc example uses on purpose,
 * precisely because they name no real person. A fixture asserting that the release scrubber
 * strips `[owner:Jane …]` must be able to say `[owner:Jane …]`.
 *
 * This is a list of PLACEHOLDERS, not an allowlist of people. A real contributor's name does
 * not go here — strip it from the tag instead. Adding your name here is the bug this gate
 * exists to catch.
 */
export const PLACEHOLDER_NAMES = new Set([
  'jane', 'john', 'jdoe', 'jane-doe', 'johndoe', 'alice', 'bob', 'carol', 'dave',
  'someone', 'somebody', 'name', 'owner', 'user', 'example', 'test', 'testuser',
  'placeholder', 'redacted', 'anon', 'anonymous', 'foo', 'bar',
]);

/**
 * Not shipped / not source / regenerated. Mirrors check-no-box-identity.mjs so every rule
 * agrees on what "shipped" means. Exported so the edit-time hook skips the same paths the
 * gate skips — otherwise the hook nags about a `[owner:<name>]` tag on a CARRY surface,
 * where the named form is CORRECT, and agents learn to ignore it.
 */
export const SKIP = [
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)dist(-\w+)?\//, /(^|\/)build\//,
  /(^|\/)coverage\//, /(^|\/)_retired\//, /(^|\/)\.papercusp\//, /(^|\/)docs\.old\.\d+\//,
  /(^|\/)agent-briefs\//, /^docs\/plans\//, /(^|\/)public\/internal\/docs\//,
  /(^|\/)\.harness\//, /(^|\/)\.tmp(-[^/]*)?\//, /(^|\/)\.claude\//,
  /(^|\/)__pycache__\//, /\.pyc$/,
  /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|zst|gz|tgz|zip|pdf|mp[34]|wav|lock)$/i,
  /(^|\/)package-lock\.json$/, /(^|\/)junit\.xml$/,
  /^(HANDOFF|BRIEF|FLEET|SELF-BRIEF|LIVE)-.*\.md$/,
  /^shared-pot-release-testing\//,
  /(^|\/)\.papercusp-\w+\//, /\.(swp|swo|swn)$/,
];

/** True when `file` is outside the shipped-source set these rules police. */
export function isSkippedPath(file) {
  return SKIP.some((re) => re.test(file));
}

/**
 * FORM 1 — `[owner:<name>` , the named provenance tag. The sanctioned `[owner 2026-07-13]`
 * (no colon) and `[owner:2026-07-13]` (bare date) forms carry no name and do not match.
 * `[self-imposed]`, `[peer:su-…]`, `[inferred]` name no human and are untouched.
 */
const BRACKET_TAG = /\[owner:\s*([A-Za-z][A-Za-z0-9._'-]*)/gi;

/**
 * FORM 2 — the parenthetical section header `OWNER MANDATE (<Name>, <date>…)`.
 *
 * The bracket rule got its zero-false-positive guarantee from a structured marker, and this
 * one keeps that discipline rather than hunting bare names (which is what makes the release
 * audit noisy enough to get switched off). Three independent anchors must ALL hold:
 *   (a) an `owner <directive-noun>` phrase immediately followed by `(`,
 *   (b) the first token inside the paren is Capitalized and contains NO DIGIT — so a
 *       work-item ref `(WI-5811, …)`, a session id `(su-707…)` and a bare date `(2026-07-25)`
 *       cannot match, and lower-case prose like `OWNER RULE (see the docs)` cannot either,
 *   (c) that token is terminated by `,` `)` or whitespace-then-digit — i.e. it sits in the
 *       attribution slot, not mid-sentence.
 */
const PAREN_TAG =
  /\bowner\s+(?:mandate|rule|ask|directive|decision|request|order|instruction|say|says|said|wants?)\b\s*\(\s*([A-Za-z][A-Za-z'.-]*)(?=\s*[,)]|\s+\d)/gi;

/**
 * Cheap whole-file pre-filter: skip the overwhelming majority of files without running the
 * real matchers. Deliberately NOT a bare /owner/i — `ownerId` appears in thousands of files
 * in this tree, so that would reject almost nothing and cost more than it saves.
 */
export const FAST_REJECT =
  /\[owner:|owner\s+(?:mandate|rule|ask|directive|decision|request|order|instruction|say|says|said|wants?)\s*\(/i;

/** A peer tag cites a session id (`[peer:su-b0fbf…]`), never a person — not a leak. */
const isSessionId = (n) => /^su-/i.test(n);
/** A bare date after the colon (`[owner:2026-07-13]`) names nobody. */
const isDateLike = (n) => /^\d/.test(n);
/** A placeholder identifies nobody on purpose. */
const isPlaceholder = (n) => PLACEHOLDER_NAMES.has(n.toLowerCase());
/**
 * Form-2 only: a person's given name is Capitalized and digit-free. Rejects `WI-5811`,
 * `su-707…`, `2026-07-25` and every other ref/id that can sit in an attribution slot.
 */
const looksLikePersonName = (n) => n.length >= 2 && /^[A-Z][A-Za-z'.-]*$/.test(n);

/**
 * Find named owner-provenance tags in `text`.
 *
 * @param {string} text file contents (or, at edit time, just the incoming edit)
 * @returns {{line:number,name:string,form:'bracket'|'paren',text:string}[]} one row per leak
 */
export function findOwnerNameLeaks(text) {
  if (!text || !FAST_REJECT.test(text)) return [];
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(BRACKET_TAG)) {
      const name = m[1];
      if (isPlaceholder(name) || isSessionId(name) || isDateLike(name)) continue;
      findings.push({ line: i + 1, name, form: 'bracket', text: line.trim().slice(0, 120) });
    }
    for (const m of line.matchAll(PAREN_TAG)) {
      const name = m[1];
      if (isPlaceholder(name) || isSessionId(name) || isDateLike(name)) continue;
      if (!looksLikePersonName(name)) continue;
      findings.push({ line: i + 1, name, form: 'paren', text: line.trim().slice(0, 120) });
    }
  }
  return findings;
}

/** How the leak was written, for the fix hint. */
export function renderLeak(f) {
  return f.form === 'bracket' ? `[owner:${f.name} …]` : `OWNER … (${f.name}, …)`;
}

/** The one fix text, so the gate and the edit-time advisory teach the same thing. */
export const FIX_HINT =
  'FIX: strip the NAME, keep the tier and the date.\n' +
  '      [owner:Jane 2026-07-13]                ->  [owner 2026-07-13]\n' +
  '      OWNER MANDATE (Jane, 2026-07-13): "…"  ->  OWNER MANDATE (2026-07-13): "…"\n' +
  'The named form stays correct on CARRY SURFACES (work items, facts, checkpoints,\n' +
  'plans) — those are internal and never packed into the bundle. Do NOT silence this\n' +
  'by adding the name to PLACEHOLDER_NAMES: shipping that name is the bug.';
