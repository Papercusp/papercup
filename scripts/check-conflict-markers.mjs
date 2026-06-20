#!/usr/bin/env node
/**
 * check-conflict-markers.mjs — fail on COMMITTED git conflict markers (EI-1836).
 *
 * On 2026-06-20 `apps/operator/app/globals.css` carried three COMMITTED git
 * stash/merge conflict markers (a bad git-sync auto-merge — the live-merge resolver
 * does NOT catch markers that are ALREADY committed). `vite build` then died with a
 * cryptic `CssSyntaxError: Unknown word "Stashed"`, which froze the SPA build, the
 * desktop sidecar build, the WI-280 re-key witness rebuild, AND the green-checkpoint
 * SPA build — the whole fleet's deploy pipeline + a critical-path witness, all on a
 * stray "Stashed" word in CSS. Root-finding took a manual build + grep.
 *
 * This guard makes a committed conflict marker a loud, NAMED, language-agnostic
 * failure instead of a cryptic downstream build break.
 *
 *   node scripts/check-conflict-markers.mjs            # scan tracked files; exit 1 on any marker (gating)
 *   node scripts/check-conflict-markers.mjs --self-test # verify the detector on inline fixtures
 *
 * WHAT IT MATCHES (zero false positives by construction): the three conflict
 * BRACKETS git writes at the START of a line — 7 `<`, 7 `>`, or 7 `|` (diff3 base),
 * each followed by a space/tab or end-of-line. These bracket EVERY git-produced
 * conflict, and no valid source line begins with seven of them. We deliberately do
 * NOT flag the bare `=======` separator: a 7-wide markdown setext underline or an
 * ASCII divider is exactly seven `=`, so flagging it would add false positives — and
 * the brackets already catch every real conflict, so it adds no coverage.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The conflict BRACKETS at line start (start `<`, base `|`, end `>`), each followed
// by a space/tab or EOL. Anchored to line start (multiline flag) — the precision
// that makes this zero-false-positive. A fresh RegExp per scan avoids lastIndex state.
export const CONFLICT_MARKER_ERE = '^(<{7}|>{7}|\\|{7})([ \\t]|$)';
// ONE pattern source of truth: the JS detector is built FROM the same ERE string
// git grep uses, so the fast candidate pre-filter and the precise detector can never
// diverge. This simple pattern (anchors, alternation, {7}, char class) is identical
// under POSIX ERE and JS. Fresh RegExp per call avoids any lastIndex state.
const markerRegExp = () => new RegExp(CONFLICT_MARKER_ERE);

/**
 * Pure detector: the FIRST conflict marker in `content`, or null. 1-based line.
 * Exported so the guard's logic is unit-tested directly (check-conflict-markers-guard.test.ts).
 */
export function findConflictMarker(path, content) {
  const re = markerRegExp();
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) return { path, line: i + 1, marker: m[1], text: lines[i] };
  }
  return null;
}

// Files that legitimately contain a line-start bracket run (e.g. a doc DEMONSTRATING
// a conflict). Empty today — the tree is clean and the regex form in this file is
// `<{7}`, not seven literal brackets, so this script never self-flags.
const ALLOW = new Set([]);

/** Tracked files git grep flags as candidates (binary-skipped, fast). [] when clean.
 *  execFileSync with an argument array — no shell, so the (constant) ERE pattern is
 *  passed verbatim to git with no quoting/injection surface. */
function candidateFiles() {
  try {
    const out = execFileSync('git', ['grep', '-l', '-I', '-E', CONFLICT_MARKER_ERE, '--', '.'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    // git grep exits 1 with NO output when there are no matches — that is success.
    if (e && e.status === 1 && !String(e.stdout || '').trim()) return [];
    throw e;
  }
}

function scanTree() {
  const offenders = [];
  for (const file of candidateFiles()) {
    if (ALLOW.has(file)) continue;
    let content;
    try {
      content = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // unreadable / vanished between grep and read — skip
    }
    const hit = findConflictMarker(file, content);
    if (hit) offenders.push(hit);
  }
  return offenders;
}

function runSelfTest() {
  const B = (c) => c.repeat(7); // build a bracket run WITHOUT a literal marker in this source
  const cases = [
    { name: 'flags <<< start marker', text: `a\n${B('<')} HEAD\nb`, expectLine: 2 },
    { name: 'flags >>> end marker', text: `${B('>')} feature/x`, expectLine: 1 },
    { name: 'flags ||| diff3 base', text: `x\ny\n${B('|')} base`, expectLine: 3 },
    { name: 'flags a bare bracket run at EOL (no label)', text: `${B('<')}`, expectLine: 1 },
    { name: 'does NOT flag a lone ======= separator (FP-prone, excluded)', text: `${B('=')}`, expectNull: true },
    { name: 'does NOT flag 6 brackets (too few)', text: `${'<'.repeat(6)} HEAD`, expectNull: true },
    { name: 'does NOT flag a mid-line bracket run', text: `see ${B('<')} HEAD inline`, expectNull: true },
    { name: 'does NOT flag a markdown --- rule or normal code', text: '---\nconst x = a >> b;\n## Heading', expectNull: true },
  ];
  let failed = 0;
  for (const c of cases) {
    const hit = findConflictMarker('fixture', c.text);
    const ok = c.expectNull ? hit === null : hit && hit.line === c.expectLine;
    if (!ok) {
      failed++;
      console.error(`  ✗ ${c.name} — got ${JSON.stringify(hit)}`);
    }
  }
  if (failed) {
    console.error(`\ncheck-conflict-markers --self-test: ${failed} case(s) FAILED`);
    process.exit(1);
  }
  console.log(`check-conflict-markers --self-test: all ${cases.length} cases passed`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const offenders = scanTree();
  if (offenders.length === 0) {
    console.log('check-conflict-markers: clean — no committed git conflict markers');
    return;
  }
  console.error(
    `\ncheck-conflict-markers: ${offenders.length} COMMITTED git conflict marker(s) found.\n` +
      `A committed marker breaks builds with a cryptic error (EI-1836: a CSS marker froze the\n` +
      `whole fleet deploy + the WI-280 witness). Resolve the merge/stash before committing.\n`,
  );
  for (const o of offenders) {
    console.error(`  ${o.path}:${o.line}: ${o.text.slice(0, 80)}`);
  }
  process.exit(1);
}

// Only run the CLI when invoked directly — importing the detector (the guard test)
// must not trigger a tree scan.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
