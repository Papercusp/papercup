#!/usr/bin/env node
/**
 * check-insight-citations.mjs — fail-loud guard for stale `documents:` citations
 * in the agent-insights corpus (WI-1576, first slice of
 * scout-declared-artifacts-agent-insight-file-citations-on-disk-migr-2026-06-12).
 *
 * Every agent-insights doc declares `documents:` frontmatter naming the repo
 * paths it documents. When the cited file is later renamed/moved/deleted and
 * nobody updates the doc, the citation goes stale — the doc silently points an
 * agent at a file that no longer exists. A one-time sweep (2026-07-02) found
 * exactly 5 stale citations across 381 docs / 1584 citations (all fixed in the
 * same change that added this guard); this script keeps that count at zero.
 *
 *   node scripts/check-insight-citations.mjs
 *
 * Detection reuses the SAME parse the harness-docs anchor/drift system uses
 * (`frontmatterDocuments` + `parseDocumentsField`, subject-ref.ts) so this CI
 * lint and that system can never disagree on what a doc cites. Only `path`/
 * `symbol` refs are filesystem-checked; a `feature` ref (`F-NNN`/`WI-NNN`) and a
 * glob-bearing path entry are skipped (see insight-citations.ts doc comment).
 *
 * Scope: tracked .mdx/.md under
 * apps/operator-docs/src/content/docs/agent-insights/ (the corpus this WI
 * scoped the sweep to).
 */
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findStaleInsightCitations, formatStaleCitations } from '../packages/operator-core/lib/content-lint/insight-citations';

export { findStaleInsightCitations, formatStaleCitations };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOCS_PREFIX = 'apps/operator-docs/src/content/docs/agent-insights/';

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/');

function main() {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!f.endsWith('.mdx') && !f.endsWith('.md')) continue;
    if (!f.startsWith(DOCS_PREFIX)) continue; // only the agent-insights corpus (this WI's scope)
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    const stale = findStaleInsightCitations(text, ROOT);
    const msg = formatStaleCitations(stale);
    if (msg) offenders.push(`${f}  ${msg}`);
  }

  if (offenders.length === 0) {
    console.log('✓ every agent-insights `documents:` citation resolves on disk.');
    process.exit(0);
  }

  console.error('✗ stale `documents:` citation(s) — the cited path does not exist on disk.');
  console.error('  Fix the frontmatter (and any prose naming the old path) to point at the');
  console.error('  file\'s current location, or drop the citation if the file is gone for good.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See WI-1576.`);
  process.exit(1);
}

// Run only as the entry point — importing the detector for reuse has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
