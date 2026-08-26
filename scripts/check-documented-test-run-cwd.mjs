#!/usr/bin/env node
/**
 * check-documented-test-run-cwd.mjs — fail-loud guard against documented test
 * commands that only work from an UNSTATED working directory (EI-21463787319820028).
 *
 * Test-file headers document how to run the file (`Run: npx vitest run …`). A
 * command whose `--config` / file paths resolve ONLY from a package directory
 * (e.g. packages/operator-core) fails at the repo root with a missing-config
 * error BEFORE any test runs — and the natural fallback retry under the default
 * root config then collects half the tree and times out. Both failure modes
 * look like "this test is broken" instead of "I ran it from the wrong place".
 *
 * THE CONTRACT this guard enforces on every documented `Run:` command:
 *   - EITHER the command states its working directory explicitly
 *     (`Run: cd packages/operator-core && npx vitest …`) and every referenced
 *     path exists relative to that directory,
 *   - OR the command is repository-root-executable as written (the canonical
 *     `npm run test:file -- packages/…` form), i.e. every referenced path
 *     exists relative to the repo root.
 *
 *   node scripts/check-documented-test-run-cwd.mjs
 *
 * Scope: tracked *.ts/*.mts source; only comment lines shaped `* Run:` (plus
 * their `\`-continuation lines inside the same comment block) are commands —
 * prose mentioning vitest is ignored. The predicate is exported + unit-tested
 * (packages/operator-core/lib/documented-test-run-cwd-guard.test.ts) so the
 * "fails on an unstated-cwd command" property is durably verified, not only
 * green-on-clean-tree.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** Comment-line command opener: `* Run: <command>` (block-comment star optional-ish). */
const RUN_LINE = /^\s*\*\s*Run:\s*(\S.*\S|\S)\s*$/;

/**
 * Extract documented `Run:` commands (with their `\` continuations) from a
 * file's text. Returns [{ line, command }].
 * @param {string} text
 * @returns {{ line: number, command: string }[]}
 */
export function extractDocumentedRunCommands(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = RUN_LINE.exec(lines[i]);
    if (!m) continue;
    const first = m[1];
    // Only vitest/test-file invocations — other `Run:` prose is not this guard's concern.
    if (!/\b(vitest|npm run test)\b/.test(first)) continue;
    let command = first;
    const startLine = i + 1;
    // `\`-terminated fragments continue on following comment lines.
    while (/\\\s*$/.test(command) && i + 1 < lines.length && /^\s*\*/.test(lines[i + 1])) {
      i += 1;
      command = command.replace(/\\\s*$/, '') + ' ' + lines[i].replace(/^\s*\*\s?/, '').trim();
    }
    out.push({ line: startLine, command });
  }
  return out;
}

/**
 * Validate ONE documented command against the tree. Returns an error string,
 * or null when the command is executable as documented.
 * @param {string} command
 * @param {(p: string) => boolean} exists path-exists probe (injectable for tests)
 */
export function judgeDocumentedRunCommand(command, exists = (p) => existsSync(join(ROOT, p))) {
  const rest = command.trim();
  // Form 1 — explicit cwd: `cd <dir> [&&|;] …` (also tolerates a trailing `\` join).
  const cdMatch = /^cd\s+(\S+)\s*(?:&&|;)\s*(.*)$/.exec(rest);
  let cwd = '.';
  let body = rest;
  if (cdMatch) {
    const dir = cdMatch[1].replace(/\\$/, '');
    if (!exists(dir)) return `stated working directory '${dir}' does not exist`;
    cwd = dir;
    body = cdMatch[2].trim();
  } else if (!exists('.') === false) {
    // repo root always exists; fall through with implicit root cwd
  }
  // Collect every filesystem reference: --config values and bare path arguments.
  const refs = [];
  const cfg = /--config[= ](\S+)/.exec(body);
  if (cfg) refs.push(cfg[1]);
  for (const token of body
    .replace(/\\\s*$/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/\\$/, '').trim())
    .filter(Boolean)) {
    if (/^(-|--)/.test(token)) continue; // flags
    if (/^(npx|node|npm)$/.test(token)) continue;
    if (/^(run|vitest|exec|test:file|--)$/.test(token)) continue;
    if (token.includes('/') && !/^https?:/.test(token)) refs.push(token);
  }
  for (const ref of refs) {
    const target = cwd === '.' ? ref : `${cwd.replace(/\/$/, '')}/${ref}`;
    if (!exists(target)) {
      return cwd === '.'
        ? `no working directory stated and '${ref}' does not exist at the repo root — state it (e.g. prefix "cd packages/<pkg> && ")`
        : `path '${ref}' does not exist under stated working directory '${cwd}'`;
    }
  }
  return null;
}

/** @returns {string[]} human-readable violations */
export function findViolations(files, read = (f) => readFileSyncSafe(f)) {
  const violations = [];
  for (const file of files) {
    const text = read(file);
    if (!text) continue;
    for (const { line, command } of extractDocumentedRunCommands(text)) {
      const err = judgeDocumentedRunCommand(command);
      if (err) violations.push(`${file}:${line} — ${err}\n    command: ${command}`);
    }
  }
  return violations;
}

function readFileSyncSafe(f) {
  try {
    // eslint-disable-next-line n/no-sync -- guard script, sync IO is the norm here
    return require('node:fs').readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('check-documented-test-run-cwd.mjs')) {
  const files = (await listTrackedFiles(['packages/', 'apps/', 'libs/'])).filter((f) =>
    /\.(ts|mts)$/.test(f),
  );
  const violations = findViolations(files);
  if (violations.length > 0) {
    console.error(
      `check-documented-test-run-cwd: ${violations.length} documented Run: command(s) are not executable as written:\n\n` +
        violations.join('\n\n') +
        '\n\nFix: state the working directory ("Run: cd packages/<pkg> && npx vitest …") or use the root-executable form ("Run: npm run test:file -- <root-relative-path>").',
    );
    process.exit(1);
  }
  console.log(`check-documented-test-run-cwd: ${files.length} files scanned, all documented Run: commands are executable as written.`);
}
