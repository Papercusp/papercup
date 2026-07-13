#!/usr/bin/env node
/**
 * check-no-owner-name-tags.mjs — a provenance tag must never carry a real name
 * into shipped source (WI-4419, second rule).
 *
 * WHY THIS EXISTS
 * Two good rules collide. The compaction/provenance discipline says: tag an owner
 * directive `[owner:<name> <date>]` so a later reader can tell an owner mandate from
 * an agent's note-to-self. The release gate says: the build box's git identity must
 * never reach a shipped bundle. Agents follow the first rule INSIDE SOURCE COMMENTS,
 * and bin/audit-release-bundle.py — which resolves this box's `git config user.name`
 * — then kills the cut.
 *
 * It has now killed TWO 0.0.9 cuts, each ~10 minutes in, and it kills them at the
 * WORST possible moment: the audit runs BEFORE the platform legs, so the legs never
 * run and a whole build is spent discovering a one-word comment edit. This lint
 * catches the same class at EDIT time, in seconds.
 *
 * WHY A SEPARATE RULE FROM check-no-box-identity.mjs
 * That lint hunts the HOME-PATH class (`/home/<user>/…`) and deliberately refuses to
 * know your box's name — correctly, since a lint keyed to one machine only works on
 * one machine. This rule needs no such knowledge either: it keys on the TAG, not the
 * name. `[owner:` is a structured marker, so matching inside it is exact.
 *
 * WHY THIS CATCHES WHAT THE AUDIT CANNOT
 * The audit matches a short git name case-SENSITIVELY on a word boundary (`\bAvi\b`)
 * and says why: `\bavi\b` case-insensitively also hits `video.avi`, `Avicenna`, and a
 * vendored POS lexicon that lists "Avi" — noise that gets a gate switched off. Sound
 * for a bare word; it means `[owner:avi]` slips through while `[owner:Avi]` fails the
 * cut, though both leak the same person. Anchoring on `[owner:` removes the ambiguity:
 * this rule is case-INSENSITIVE with no false-positive surface at all.
 *
 * THE RULE: in shipped source, cite the tier and the date — `[owner 2026-07-13]` —
 * never the person: `[owner:Avi 2026-07-13]`. The named form stays CORRECT on carry
 * surfaces (work items, facts, checkpoints, plans); those are internal and never
 * packed into source.tar.zst. Only tracked source is shipped, so only tracked source
 * is linted.
 *
 *   node scripts/check-no-owner-name-tags.mjs
 *
 * BASELINE is EMPTY and must stay that way. If this fires, strip the NAME from the
 * tag — do not add an exception to make the build pass. Adding your name to the
 * placeholder list below is the bug this gate exists to catch.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Names that identify NOBODY: the stand-ins a test fixture or doc example uses on
 * purpose, precisely because they name no real person. A fixture asserting that the
 * release scrubber strips `[owner:Jane …]` must be able to say `[owner:Jane …]`.
 *
 * This is a list of PLACEHOLDERS, not an allowlist of people. A real contributor's
 * name does not go here — strip it from the tag instead.
 */
const PLACEHOLDER_NAMES = new Set([
  'jane', 'john', 'jdoe', 'jane-doe', 'johndoe', 'alice', 'bob', 'carol', 'dave',
  'someone', 'somebody', 'name', 'owner', 'user', 'example', 'test', 'testuser',
  'placeholder', 'redacted', 'anon', 'anonymous', 'foo', 'bar',
]);

/** Not shipped / not source / regenerated — mirrors check-no-box-identity.mjs so the
 *  two rules agree on what "shipped" means. */
const SKIP = [
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

/**
 * `[owner:<name>` — the named provenance tag. The sanctioned `[owner 2026-07-13]`
 * (no colon) and `[owner:<date>]` forms carry no name and do not match.
 * `[self-imposed]`, `[peer:su-…]`, `[inferred]` name no human and are untouched.
 */
const OWNER_TAG = /\[owner:\s*([A-Za-z][A-Za-z0-9._'-]*)/gi;

/** A peer tag cites a session id (`[peer:su-b0fbf…]`), never a person — not a leak. */
const isSessionId = (n) => /^su-/i.test(n);
/** A bare date after the colon (`[owner:2026-07-13]`) names nobody. */
const isDateLike = (n) => /^\d/.test(n);

const tracked = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1 << 28 })
  .toString()
  .split('\0')
  .filter(Boolean)
  .filter((f) => !SKIP.some((re) => re.test(f)));

const findings = [];
for (const file of tracked) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable / binary / vanished mid-run — not our class
  }
  if (!text.includes('[owner:')) continue; // fast reject: the overwhelming majority
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(OWNER_TAG)) {
      const name = m[1];
      const lower = name.toLowerCase();
      if (PLACEHOLDER_NAMES.has(lower) || isSessionId(name) || isDateLike(name)) continue;
      findings.push({ file, line: i + 1, name, text: lines[i].trim().slice(0, 120) });
    }
  }
}

if (findings.length === 0) {
  console.log('✓ no named [owner:<name>] provenance tags in shipped source');
  process.exit(0);
}

console.error(
  `\n✗ ${findings.length} named provenance tag(s) in shipped source — these leak a real ` +
    `person's name into the release bundle (source.tar.zst) and WILL fail the cut's ` +
    `box-identity audit (bin/audit-release-bundle.py), ~10 minutes in, before any ` +
    `platform leg runs.\n`
);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [owner:${f.name} …]`);
  console.error(`      ${f.text}`);
}
console.error(
  `\nFIX: strip the NAME, keep the tier and the date.\n` +
    `      [owner:Avi 2026-07-13]  ->  [owner 2026-07-13]\n` +
    `The named form stays correct on CARRY SURFACES (work items, facts, checkpoints,\n` +
    `plans) — those are internal and never packed into the bundle. Do NOT silence this\n` +
    `by adding the name to PLACEHOLDER_NAMES: shipping that name is the bug.\n`
);
process.exit(1);
