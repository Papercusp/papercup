#!/usr/bin/env node
/**
 * check-no-identity-literals.mjs — WI-4776, the closing sibling to
 * check-no-box-identity.mjs (the home-PATH class) and
 * check-no-owner-name-tags.mjs (the `[owner:<name>]` TAG class).
 *
 * WHY A THIRD RULE
 * All 4 documented 0.0.9 leaks (QuickPanelHeaderControls.tsx,
 * mac-transport-death-self-diagnosis.mdx, mcp-transport-resilience-2026-07-13.md,
 * mcp-dark-watchdog.ts) were named `[owner:<name> …]` provenance tags — already
 * fully closed by check-no-owner-name-tags.mjs (baseline 0 as of 2026-07-14). But
 * WI-4419's release-cut gate (papercusp-desktop/bin/audit-release-bundle.py
 * :: identity_literals()) hunts a WIDER set than either sibling lint covers:
 * this box's git user.name / user.email and its hostname, matched as BARE
 * literals — e.g. an owner's first name dropped into a comment with no
 * `[owner:]` wrapper at all, or a hostname/email pasted into a debug note —
 * neither of which is a `[owner:` tag nor
 * a `/home/<user>/` path, so neither existing lint would catch it. That gap is
 * real even though it has 0 historical instances yet: the class is "whatever
 * this box's identity is" and the two existing rules only close two of its
 * shapes. This rule closes the rest, at EDIT/STAGE time, before a release cut
 * burns a sidecar build only to discover it later.
 *
 * WHY THIS RULE MUST RUN ON *THIS* BOX (deliberately unlike its siblings)
 * check-no-box-identity.mjs is machine-agnostic BY DESIGN — it matches a path
 * SHAPE, not a value, so it works identically on every contributor's checkout.
 * This rule cannot be: it has to know what "this box's identity" actually IS to
 * search for it, exactly like audit-release-bundle.py's identity_literals()
 * does (both resolve git config / hostname / OS user AT RUN TIME — neither
 * hardcodes a name). Run on a CI runner with a bot/absent git identity, it
 * degrades to a same as a no-op (nothing sensitive to find) — that is expected,
 * not a bug: the box that matters is the one that actually cuts releases
 * (release-local.sh runs THIS rule right after staging the source tree, on
 * THIS box, where git config user.name genuinely resolves to the owner).
 *
 * MUST MIRROR identity_literals() / needs_word_boundary() / is_vendor() from
 * audit-release-bundle.py — memory ef6e21c4 / WI-4419: "the two MUST agree or
 * it's a false-green." Ported 1:1 below; keep them in lockstep if either changes.
 *
 * NEVER hardcodes a real identity (this file itself ships — scripts/ is in the
 * release bundle's allowlist, per stage-source-tree.sh) — every literal here is
 * resolved dynamically, same discipline as check-no-owner-name-tags.mjs's own
 * "this file obeys its own rule" note.
 *
 *   node scripts/check-no-identity-literals.mjs
 *
 * BASELINE is EMPTY and must stay that way. If this fires, remove/derive the
 * literal — never add an exception to make the build pass.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

/** Accounts/hosts that identify NOBODY — mirrors identity_literals()'s own
 *  exclusions (`user not in (root, runner, build, ubuntu)`, `host not startswith
 *  (runner, ci-, localhost)`) plus check-no-box-identity.mjs's GENERIC_USERS,
 *  so a CI runner or shared box never self-flags. */
const GENERIC_ACCOUNTS = new Set([
  'root', 'runner', 'build', 'ubuntu', 'node', 'vscode', 'codespace', 'ci', 'agent',
  'linuxbrew', 'dev', 'user', 'shared', 'Shared', 'pcusp', 'papercusp', 'papercup',
]);
const isGenericHost = (h) => /^(runner|ci-|localhost)/i.test(h);

/** Same shipped/not-shipped scope as the two sibling identity lints — the three
 *  rules MUST agree on what "shipped" means or a gap opens between them. Also
 *  excludes `scratchpad/` (WI-4776): unlike its two siblings, this rule hunts
 *  BARE literals with no structural anchor (no `[owner:` tag, no `/home/`
 *  shape) — that widens its surface to catch things like a scratch investigation
 *  artifact that RECORDS a past leak as data (e.g. a lexicon-audit dump), which
 *  is not itself a leak. `scratchpad/` is not in stage-source-tree.sh's ship
 *  allowlist either way, so excluding it costs nothing real. */
const SKIP = [
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)dist(-\w+)?\//, /(^|\/)build\//,
  /(^|\/)coverage\//, /(^|\/)_retired\//, /(^|\/)\.papercusp\//, /(^|\/)docs\.old\.\d+\//,
  /(^|\/)agent-briefs\//, /^docs\/plans\//, /(^|\/)public\/internal\/docs\//,
  /(^|\/)\.harness\//, /(^|\/)\.tmp(-[^/]*)?\//, /(^|\/)\.claude\//,
  /^scratchpad\//, /^scratch\//,
  /(^|\/)__pycache__\//, /\.pyc$/,
  /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|zst|gz|tgz|zip|pdf|mp[34]|wav|lock)$/i,
  /(^|\/)package-lock\.json$/, /(^|\/)junit\.xml$/,
  /^(HANDOFF|BRIEF|FLEET|SELF-BRIEF|LIVE)-.*\.md$/,
  /^shared-pot-release-testing\//,
  /(^|\/)\.papercusp-\w+\//, /\.(swp|swo|swn)$/,
  // This lint's own file: it necessarily contains words like "hostname" / "user.name"
  // in its comments describing the class — never itself a leak.
  /^scripts\/check-no-identity-literals\.mjs$/,
];

/** identity_literals() ported from audit-release-bundle.py — same sources, same
 *  exclusions. Returns { key: value } for whatever resolves on THIS box. */
function resolveIdentityLiterals() {
  const lits = {};
  try {
    const user = os.userInfo().username;
    if (user && !GENERIC_ACCOUNTS.has(user)) lits['build-user-name'] = user;
  } catch { /* best-effort */ }
  try {
    const host = os.hostname();
    if (host && !isGenericHost(host)) lits['build-hostname'] = host;
  } catch { /* best-effort */ }
  for (const [key, cfg] of [['build-git-email', 'user.email'], ['build-git-name', 'user.name']]) {
    try {
      const v = execFileSync('git', ['config', '--get', cfg], { encoding: 'utf8', timeout: 5000 }).trim();
      if (v) lits[key] = v;
    } catch { /* unset — nothing to hunt */ }
  }
  return lits;
}

/** needs_word_boundary() ported verbatim: a SHORT alnum literal must match as a
 *  whole word (case-sensitive) or it drowns in false positives — a three-letter
 *  first name also hits a matching file extension, a longer proper noun that
 *  starts with it, and vendored POS-lexicon entries (same rationale as
 *  check-no-owner-name-tags.mjs's OWNER_TAG matching). */
const needsWordBoundary = (lit) => lit.length < 6 && /^[A-Za-z0-9]+$/.test(lit);

/** is_vendor() ported verbatim: a low-entropy (short/common) literal is only
 *  hunted OUTSIDE node_modules — a bare first name is not vendor's fault to
 *  carry; a high-entropy literal (email, hostname, a longer username) is still
 *  hunted everywhere, because that DOES mean our own build baked it in. */
const isVendor = (path) => path.startsWith('node_modules/') || path.includes('/node_modules/');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalPattern(lit) {
  return needsWordBoundary(lit)
    ? new RegExp(`\\b${escapeRegExp(lit)}\\b`) // case-sensitive, same as the audit
    : new RegExp(escapeRegExp(lit));
}

const lits = resolveIdentityLiterals();
const entries = Object.entries(lits);
if (entries.length === 0) {
  console.log('✓ no build-box identity resolved on this host (nothing to hunt) — no-op on a bare/CI box, by design');
  process.exit(0);
}

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1 << 28 })
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter((f) => !SKIP.some((re) => re.test(f)));
} catch (e) {
  console.error(`check-no-identity-literals: git ls-files failed: ${e?.message}`);
  process.exit(2);
}

const findings = [];
for (const file of tracked) {
  const vendor = isVendor(file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary / unreadable / vanished mid-run
  }
  for (const [key, lit] of entries) {
    const lowEntropy = needsWordBoundary(lit);
    if (lowEntropy && vendor) continue; // is_vendor() scoping — bare short names only outside vendor
    const rx = new RegExp(literalPattern(lit).source, 'g');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) {
        findings.push({ file, line: i + 1, key, text: lines[i].trim().slice(0, 120) });
      }
      rx.lastIndex = 0;
    }
  }
}

if (findings.length === 0) {
  console.log(
    `✓ no bare build-box identity literal (${Object.keys(lits).join(', ')}) in ${tracked.length} tracked source files`,
  );
  process.exit(0);
}

console.error(
  `\n✗ ${findings.length} bare build-box identity literal(s) in tracked source — these leak this ` +
    `box's own identity (git name/email, hostname) into the release bundle (source.tar.zst / the ` +
    `packaged sidecar) and WILL fail the cut's box-identity audit (bin/audit-release-bundle.py), ` +
    `after real build time has already been spent.\n`,
);
const limit = process.argv.includes('--all') ? findings.length : 40;
for (const f of findings.slice(0, limit)) {
  console.error(`  ${f.file}:${f.line}  [${f.key}]`);
  console.error(`      ${f.text}`);
}
if (findings.length > limit) {
  console.error(`  … and ${findings.length - limit} more (re-run with --all)`);
}
console.error(
  '\n  FIX: remove the literal, or use the sanctioned provenance form that keeps the meaning\n' +
    "  without the name — `[owner:<name> <date>]` -> `[owner <date>]` (see\n" +
    '  check-no-owner-name-tags.mjs) — never add an exception to make the build pass.\n',
);
process.exit(1);
