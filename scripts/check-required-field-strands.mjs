#!/usr/bin/env node
/**
 * check-required-field-strands.mjs — the required-field trap, mechanised (WI-6814).
 *
 * THE TRAP (CLAUDE.md § "Tests after editing" documents it; documentation has not
 * stopped it recurring 5×): adding a REQUIRED field to an exported interface instantly
 * stales every construction site of that type — in files your change never touched.
 * `test:affected` is type-blind AND would not select those files anyway; a stale fixture
 * in a file whose tsc baseline already tolerates errors is invisible to the ratchet too.
 * So the first detector that fires is the green-checkpoint full suite: fleet-wide, hours
 * later, and (because `pushed` is commit-only:bridged) a red gate stops origin egress for
 * everyone. A correct one-line interface change becomes a multi-hour fleet outage.
 *
 * WHY THIS GUARD IS A TRIGGER, NOT A SECOND ANALYSER:
 * finding the stranded sites is not the hard part — `tsc` already does it perfectly and
 * precisely. The hard part is KNOWING TO RUN IT. So this guard does the one thing nothing
 * else does: it notices, from the diff alone, that you just made the specific kind of edit
 * that strands siblings, and then points at (or runs) the detector that already exists.
 * Re-implementing construction-site resolution here would be a second, worse tsc.
 *
 * That is also why the mere ADDITION is never itself a failure: adding a required field is
 * usually correct and usually accompanied by updated call sites. This guard only fails when
 * --typecheck confirms real errors. Advisory by default; it cannot false-block the fleet.
 *
 *   node scripts/check-required-field-strands.mjs              # advisory: name the trigger + the command
 *   node scripts/check-required-field-strands.mjs --typecheck  # run the typecheck, exit 1 on real errors
 *   node scripts/check-required-field-strands.mjs --base origin/main
 *   node scripts/check-required-field-strands.mjs --json
 *
 * Exit codes:
 *   0 — no required-field additions, or advisory mode, or --typecheck found nothing
 *   1 — --typecheck confirmed type errors in the workspace(s) the addition touched
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspaces that own their own typecheck, longest-prefix-first. */
const WORKSPACE_TYPECHECKS = [
  { prefix: 'packages/operator-core', cmd: 'npm run lint:tsc -- --files=<the files you edited>' },
  { prefix: 'apps/operator', cmd: 'build:typecheck { project: "apps/operator" }' },
  { prefix: 'apps/operator-vite', cmd: 'build:typecheck { project: "apps/operator-vite" }' },
  { prefix: 'libs/generic', cmd: 'build:typecheck { project: "<the libs/generic/* workspace>" }' },
  { prefix: 'libs/papercusp', cmd: 'build:typecheck { project: "<the libs/papercusp/* workspace>" }' },
  { prefix: 'packages/', cmd: 'build:typecheck { project: "<the packages/* workspace>" }' },
];

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/**
 * Collect every property of every EXPORTED interface / object-type alias, keyed by a
 * dotted path so nested object literals are covered too. The trap that motivated this
 * guard lived one level down (`IssueClaimExclusionBreakdown.excluded.remoteOrigin`), so a
 * top-level-only scan would have missed all 5 of its stranded sites.
 */
export function collectExportedRequiredProps(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const props = new Map(); // dotted path -> { optional }

  const walkMembers = (members, path) => {
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name) continue;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
      if (!name) continue;
      const dotted = `${path}.${name}`;
      props.set(dotted, { optional: Boolean(m.questionToken) });
      // Recurse into nested object literal types — and through an optional wrapper, since a
      // required field inside an optional object still strands every site that DOES supply
      // the wrapper.
      const t = m.type;
      if (t && ts.isTypeLiteralNode(t)) walkMembers(t.members, dotted);
    }
  };

  const isExported = (node) =>
    Boolean(node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));

  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && isExported(stmt)) {
      walkMembers(stmt.members, stmt.name.text);
    } else if (ts.isTypeAliasDeclaration(stmt) && isExported(stmt) && ts.isTypeLiteralNode(stmt.type)) {
      walkMembers(stmt.type.members, stmt.name.text);
    }
  }
  return props;
}

/** Required props present in `after` that were absent (or optional) in `before`. */
export function diffRequiredAdditions(beforeText, afterText, fileName = 'f.ts') {
  const before = collectExportedRequiredProps(beforeText, fileName);
  const after = collectExportedRequiredProps(afterText, fileName);
  const added = [];
  for (const [path, info] of after) {
    if (info.optional) continue;
    const prev = before.get(path);
    // Newly required: either it did not exist, or it existed as optional and became required.
    if (!prev) added.push({ path, reason: 'added-required' });
    else if (prev.optional) added.push({ path, reason: 'optional-to-required' });
  }
  return added;
}

function workspaceFor(file) {
  return WORKSPACE_TYPECHECKS.find((w) => file.startsWith(w.prefix)) ?? null;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const runTypecheck = argv.includes('--typecheck');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';

  // Changed .ts/.tsx files vs the base. A file with no base version is skipped: a brand-new
  // exported interface has no pre-existing construction sites, so it cannot strand anything.
  const nameStatus = git(['diff', '--name-status', base, '--', '*.ts', '*.tsx'], { allowFail: true });
  if (nameStatus === null) {
    console.error(`check-required-field-strands: cannot diff against '${base}'`);
    process.exit(0);
  }

  const findings = [];
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    if (!file || status.startsWith('A') || status.startsWith('D')) continue;
    if (file.endsWith('.d.ts')) continue;

    const beforeText = git(['show', `${base}:${file}`], { allowFail: true });
    if (beforeText === null) continue;
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) continue;
    const afterText = readFileSync(abs, 'utf8');

    const added = diffRequiredAdditions(beforeText, afterText, file);
    if (added.length) findings.push({ file, added });
  }

  if (json) console.log(JSON.stringify({ base, findings }, null, 2));

  if (!findings.length) {
    if (!json) console.log('✓ no required fields added to exported types in this diff');
    process.exit(0);
  }

  if (!json) {
    console.log('⚠ REQUIRED-FIELD ADDITION detected on an exported type.');
    console.log('  Every construction site of this type in OTHER files just went stale —');
    console.log('  including files test:affected will not select and vitest cannot see.\n');
    for (const f of findings) {
      console.log(`  ${f.file}`);
      for (const a of f.added) {
        const how = a.reason === 'optional-to-required' ? 'optional → required' : 'new required field';
        console.log(`    • ${a.path}  (${how})`);
      }
    }
    const cmds = [...new Set(findings.map((f) => workspaceFor(f.file)?.cmd).filter(Boolean))];
    console.log('\n  Confirm nothing was stranded:');
    for (const c of cmds) console.log(`    ${c}`);
    console.log('\n  (Adding a required field is often correct — this is a prompt to verify,');
    console.log('   not a verdict. Do NOT make the field optional just to silence errors.)');
  }

  if (!runTypecheck) process.exit(0);

  // --typecheck: run the detector that is already precise, and fail only on real errors.
  const touchesOperatorCore = findings.some((f) => f.file.startsWith('packages/operator-core'));
  if (!touchesOperatorCore) {
    if (!json) console.log('\n--typecheck: automated run covers packages/operator-core only; run the commands above.');
    process.exit(0);
  }
  if (!json) console.log('\n--typecheck: running lint:tsc over packages/operator-core …');
  let out = '';
  try {
    out = execFileSync('node', ['scripts/lint-tsc.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (!json) console.log(out);
    console.error('\n✗ typecheck reported errors above baseline after a required-field addition.');
    process.exit(1);
  }
  if (!json) console.log(out);
  process.exit(0);
}

// Only run main() when invoked as a script, so the pure fns above stay unit-testable.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
