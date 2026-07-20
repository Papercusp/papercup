#!/usr/bin/env node
/**
 * check-github-identity-terms.mjs — fail-loud guard against the
 * papercupai-vs-Papercusp user/org drift (WI-4978).
 *
 * Ground truth (verified live against the GitHub API, 2026-07-20):
 *   - `papercupai` is a GitHub **User** (created 2026-04-25) — the maintainer's
 *     personal admin login. It cannot be an "org" — GitHub has no org-membership
 *     endpoint for a user account, so any code or doc that treats it as one is
 *     either lying to a reader or, worse, silently broken (the first-party
 *     `@papercusp/*` publish gate in papercusp-registry's auth.ts hardcoded
 *     `FIRST_PARTY_ORG = 'papercupai'`, so `GET /orgs/papercupai/members/<login>`
 *     404'd for EVERY publisher, including the real owner — nobody could ever
 *     pass the check).
 *   - `Papercusp` is the real GitHub **Organization** (created 2026-05-28) that
 *     owns the canonical repos (`Papercusp/papercup`, `Papercusp/papercusp-registry`,
 *     `Papercusp/papercusp`, …). `papercupai` has active admin membership in it.
 *
 * This is a doc/prose guard (regex, not a live API call — keep it hermetic and
 * fast): it fails if any tracked doc describes `papercupai` as a GitHub org or
 * organization. The canonical explanation lives in ONE place —
 * apps/operator-docs/src/content/docs/spec/distribution.mdx, "Canonical GitHub
 * identity" callout — link to it instead of re-describing the identities.
 *
 * The sibling functional guard for the CODE side of this bug (the
 * FIRST_PARTY_ORG constant itself) lives in the papercusp-registry repo:
 * apps/marketplace-api/src/auth.guard.test.ts (separate repo, own test run).
 *
 * Usage: npm run lint:github-identity-terms
 * Exit codes: 0 clean, 1 a doc still calls papercupai an org.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_PREFIX = 'apps/operator-docs/src/content/docs/';

// Matches "papercupai ... org" / "papercupai ... organization" (either word
// order, small word-gap) case-insensitively — the exact shape of the bug's
// reported symptom ("papercupai GitHub org") and its inverse phrasing.
const BAD_PATTERNS = [
  /papercupai[^\n]{0,40}\borgani[sz]ation\b/i,
  /papercupai[^\n]{0,40}\borg\b/i,
  /\borgani[sz]ation[^\n]{0,40}papercupai\b/i,
  /\borg\b[^\n]{0,40}papercupai\b/i,
];

// The canonical-identity callout itself intentionally discusses both terms
// together to correct the record — exclude it (and this script's own source)
// from the scan rather than trying to make the regex clever enough to allow
// exactly one paragraph.
const isExcluded = (f) =>
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f === 'apps/operator-docs/src/content/docs/spec/distribution.mdx' ||
  f === 'scripts/check-github-identity-terms.mjs';

function main() {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!(f.endsWith('.mdx') || f.endsWith('.md'))) continue;
    if (!f.startsWith(DOCS_PREFIX)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const re of BAD_PATTERNS) {
        if (re.test(line)) {
          offenders.push({ file: f, line: i + 1, text: line.trim() });
          break;
        }
      }
    });
  }

  if (offenders.length > 0) {
    console.error(`❌ ${offenders.length} doc line(s) describe "papercupai" as a GitHub org/organization.`);
    console.error('   papercupai is a GitHub USER; the real org is `Papercusp`. See the canonical');
    console.error('   identity note in apps/operator-docs/src/content/docs/spec/distribution.mdx');
    console.error('   ("Canonical GitHub identity") and WI-4978.');
    for (const o of offenders) {
      console.error(`   ${o.file}:${o.line}: ${o.text}`);
    }
    process.exit(1);
  }

  console.log('✓ no doc describes papercupai as a GitHub org/organization.');
}

main();
