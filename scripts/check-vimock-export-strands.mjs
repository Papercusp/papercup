#!/usr/bin/env node
/**
 * check-vimock-export-strands.mjs — the vi.mock export-strand TRIGGER
 * (WI-37445, class item EI-19462958615807409).
 *
 * THE TRAP. Adding a runtime-valued export to a module instantly strands every test that
 * mocks that module with an ENUMERATING `vi.mock` factory — a bare `() => ({ … })` that
 * lists the surface it wants. Vitest replaces the WHOLE module with that literal, so the
 * new export simply does not exist for anything in that test's graph:
 *
 *     Error: [vitest] No "DRAIN_UTIL_STALE_MS" export is defined on the
 *            "../../../deployment/account-pool" mock
 *
 * WHY IT IS WORSE THAN AN ORDINARY BREAK — and why a TRIGGER is the right shape:
 * `npm run test:affected` selects suites BY WORKSPACE, from the paths your diff touched.
 * Your diff touches the SOURCE module; the file that breaks is a TEST that names that
 * module only inside a string literal. Nothing in the changed-path set points at it, so
 * the selection is not merely unlucky — it is STRUCTURALLY incapable of choosing it. The
 * first thing that reliably notices is the fleet green-checkpoint, hours later, where it
 * reds the gate for everyone.
 *
 * So, exactly as scripts/check-required-field-strands.mjs argues for its own class:
 * finding the breakage is not the hard part — vitest already names it perfectly, at the
 * exact export and mock. The hard part is KNOWING TO RUN those tests. This guard does the
 * one thing nothing else does: it notices FROM THE DIFF that you just made the specific
 * kind of edit that strands mockers, and names the small set of files to run. Re-deriving
 * "would it actually throw" here would be a second, worse vitest — and unnecessary,
 * because RUNNING the named tests is itself the decisive answer.
 *
 * That is also why the mere ADDITION is never a failure: adding an export is normal and
 * usually harmless. Advisory by default — it cannot false-block the fleet.
 *
 * ⚠ TYPE-ONLY EXPORTS ARE EXCLUDED, and that exclusion is the whole precision story.
 * `export type` / `export interface` are erased at runtime, so they can never be missing
 * from a mock and belong in no factory. Counting them was measured to inflate this signal
 * by ~14× (43,431 candidate sites vs the real shape) while pointing at nothing — a guard
 * nobody can act on is a guard everybody tunes out.
 *
 *   node scripts/check-vimock-export-strands.mjs                 # advisory
 *   node scripts/check-vimock-export-strands.mjs --files=a.ts,b.ts
 *   node scripts/check-vimock-export-strands.mjs --base origin/main
 *   node scripts/check-vimock-export-strands.mjs --json
 *   node scripts/check-vimock-export-strands.mjs --self-test
 *
 * Exit codes:
 *   0 — always, unless --self-test fails. Advisory by design (see above).
 *   1 — --self-test only: the detector itself is broken.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
// REUSED, never re-implemented: this is the SAME factory classifier and specifier
// resolver that lint:full-replacement-mocks enforces with, so the two guards cannot
// disagree about what "enumerating" or "this module" means.
import { analyzeMockCalls, resolveSpec } from './check-full-replacement-mocks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

const hasExportModifier = (node) =>
  Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

/**
 * Every RUNTIME-VALUED exported name in `sourceText`.
 *
 * Runtime-valued means "a mock factory must provide it or an access throws": functions,
 * classes, enums, variables, re-exported value specifiers, and `default`. Types and
 * interfaces are deliberately absent — see the header's precision note.
 */
export function collectRuntimeExports(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, String(sourceText), ts.ScriptTarget.Latest, true);
  const names = new Set();

  const addBindingName = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    // `export const { a, b } = …` / `export const [x] = …` — each bound name is a real
    // runtime export, so a destructuring declaration contributes all of them.
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) addBindingName(el.name);
      }
    }
  };

  for (const stmt of sf.statements) {
    // export function / class / enum — all runtime values.
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) &&
      hasExportModifier(stmt)
    ) {
      if (stmt.name) names.add(stmt.name.text);
      continue;
    }
    // export const/let/var
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) addBindingName(decl.name);
      continue;
    }
    // export default …
    if (ts.isExportAssignment(stmt)) {
      names.add('default');
      continue;
    }
    // export { a, b } / export { a } from './x'
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue; // `export type { … }` — erased
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const spec of clause.elements) {
          if (spec.isTypeOnly) continue; // `export { type A }` — erased
          names.add(spec.name.text);
        }
      }
      // A bare `export * from './x'` names nothing here. Left out on purpose rather than
      // guessed at: resolving it needs the other module, and a star re-export is not the
      // shape that strands a factory (the factory would already be missing everything).
      continue;
    }
  }
  return names;
}

/** Runtime-valued exports present in `after` but absent in `before`. */
export function diffAddedRuntimeExports(beforeText, afterText, fileName = 'f.ts') {
  const before = collectRuntimeExports(beforeText, fileName);
  const after = collectRuntimeExports(afterText, fileName);
  return [...after].filter((n) => !before.has(n));
}

/**
 * Test files that mock `modulePath` with an ENUMERATING factory.
 *
 * `modulePath` is repo-relative and extensionless, matching resolveSpec's output, so the
 * comparison is between two values produced by the same resolver rather than between a
 * path and a hand-normalised string.
 */
export function findEnumeratingMockers({ modulePath, testFiles = [], read }) {
  const hits = [];
  const needle = modulePath.split('/').pop();
  for (const path of testFiles) {
    const text = read(path);
    if (text === null || text === undefined) continue;
    // Cheap substring pre-filter before parsing, mirroring collectCandidateFiles in the
    // sibling guard: a test that never mentions the basename cannot mock it relatively.
    if (needle && !text.includes(needle)) continue;
    for (const call of analyzeMockCalls(text)) {
      if (call.form !== 'full-replacement') continue;
      if (resolveSpec(path, call.spec) !== modulePath) continue;
      hits.push({ path, line: call.line, spec: call.spec });
    }
  }
  return hits;
}

/** Repo-relative + extensionless, so a changed source path is comparable to resolveSpec. */
export function moduleKeyFor(file) {
  return String(file).replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

/**
 * The no-findings verdict.
 *
 * Draws the same distinction its sibling does, for the same measured reason: "examined N
 * files, found nothing" is a clean bill, while "examined ZERO files" is not a result at
 * all. On this tree that is the COMMON case rather than an edge one — git-sync commits the
 * whole working tree on a schedule, so minutes after you edit, working-tree == HEAD and the
 * default `--base HEAD` diff is empty. Rendering the two identically is the same false-green
 * class as a `tsc -p .` that typechecked nothing.
 */
export function formatNoFindings(examinedFiles, base, { declared = false, identicalFiles = [] } = {}) {
  const files = Array.isArray(examinedFiles) ? examinedFiles : [];
  if (!files.length) {
    return [
      `⚠ NOT CHECKED — nothing differs from '${base}', so ZERO files were examined.`,
      '  This is NOT a clean bill. On this shared tree it usually means git-sync already',
      '  committed your edit, not that you changed nothing.',
      '',
      '  Re-run against the commit that actually carried your change:',
      "    C=$(git log -1 --format=%H -S'<a string your change introduced>' -- <file>)",
      '    node scripts/check-vimock-export-strands.mjs --base "$C^"',
      '',
      '  (Use -G instead of -S when searching by a name you did not introduce.)',
    ].join('\n');
  }
  const lines = [
    `✓ no runtime exports added to a module that enumerating vi.mock factories replace`,
    `  (${files.length} file(s) examined vs ${base})`,
    ...files.map((f) => `    ${f}`),
  ];
  if (!declared) {
    lines.push(
      '  ⚠ That set is INFERRED from `git diff` — on this shared tree that is EVERY agent’s',
      '    uncommitted edits, not necessarily yours. If the file carrying your change is not',
      '    listed above, this green says NOTHING about it.',
      '      node scripts/check-vimock-export-strands.mjs --files=<your,files>',
    );
  }
  if (identicalFiles.length) {
    lines.push(
      `  ⚠ NOT CHECKED — ${identicalFiles.length} of ${files.length} named file(s) are BYTE-IDENTICAL`,
      `    to ${base}, so this run proves NOTHING about them:`,
      ...identicalFiles.map((f) => `      ${f}`),
    );
  }
  return lines.join('\n');
}

/** `git ls-files` for the test corpus. */
function gitTestFiles() {
  const out = git(['ls-files', '*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx'], { allowFail: true });
  return (out ?? '').split('\n').filter(Boolean);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(runSelfTest() ? 0 : 1);

  const json = argv.includes('--json');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';

  // `--files=a,b` DECLARES the set instead of inferring it. Mirrors lint:tsc, which learned
  // the same lesson: on a tree the whole fleet edits, an inferred "changed set" is
  // everyone's, so only a declared one carries trustworthy attribution.
  const filesArg = argv.find((a) => a.startsWith('--files='));
  const declaredFiles = filesArg
    ? filesArg.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  let candidates;
  if (declaredFiles) {
    candidates = declaredFiles.map((file) => ({ status: 'M', file }));
  } else {
    const nameStatus = git(['diff', '--name-status', base, '--', '*.ts', '*.tsx'], { allowFail: true });
    if (nameStatus === null) {
      console.error(`check-vimock-export-strands: cannot diff against '${base}'`);
      process.exit(0);
    }
    candidates = nameStatus
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split('\t');
        return { status, file: rest[rest.length - 1] };
      });
  }

  const examinedFiles = [];
  const identicalFiles = [];
  const changed = [];
  for (const { status, file } of candidates) {
    if (!file || status.startsWith('A') || status.startsWith('D')) continue;
    if (file.endsWith('.d.ts')) continue;
    // A test file's own exports are not a mocked surface; skip to keep the signal about
    // production modules.
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;

    const beforeText = git(['show', `${base}:${file}`], { allowFail: true });
    if (beforeText === null) continue;
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) continue;
    const afterText = readFileSync(abs, 'utf8');

    examinedFiles.push(file);
    if (declaredFiles && beforeText === afterText) identicalFiles.push(file);
    const added = diffAddedRuntimeExports(beforeText, afterText, file);
    if (added.length) changed.push({ file, added });
  }

  // Only walk the test corpus when something actually added an export.
  const findings = [];
  if (changed.length) {
    const testFiles = gitTestFiles();
    const read = (f) => {
      try {
        return readFileSync(resolve(ROOT, f), 'utf8');
      } catch {
        return null;
      }
    };
    for (const c of changed) {
      const mockers = findEnumeratingMockers({ modulePath: moduleKeyFor(c.file), testFiles, read });
      if (mockers.length) findings.push({ ...c, mockers });
    }
  }

  if (json) {
    console.log(JSON.stringify({ base, examined: examinedFiles, identical: identicalFiles, findings }, null, 2));
    process.exit(0);
  }

  if (!findings.length) {
    // Distinguish "no exports added" from "exports added, but nothing enumerates them" —
    // the second is a real clean bill for a real trigger, and collapsing them would hide
    // that the trigger fired at all.
    if (changed.length) {
      console.log(
        `✓ ${changed.length} module(s) gained runtime exports, but no enumerating vi.mock factory targets them:`,
      );
      for (const c of changed) console.log(`    ${c.file}  (+${c.added.join(', ')})`);
    } else {
      console.log(formatNoFindings(examinedFiles, base, { declared: Boolean(declaredFiles), identicalFiles }));
    }
    process.exit(0);
  }

  console.log('⚠ RUNTIME EXPORT ADDED to a module that tests mock by ENUMERATION.');
  console.log('  `npm run test:affected` CANNOT select these — your diff touches the module,');
  console.log('  while the file that breaks names it only inside a string literal.\n');
  const toRun = new Set();
  for (const f of findings) {
    console.log(`  ${f.file}  (+${f.added.join(', ')})`);
    for (const m of f.mockers) {
      console.log(`    ↳ ${m.path}:${m.line}  vi.mock('${m.spec}', () => ({ … }))`);
      toRun.add(m.path);
    }
  }
  console.log('\n  Run them now, while it is still your turn:');
  console.log(`    npm run test:file -- ${[...toRun].join(' ')}`);
  console.log('\n  If one breaks, prefer the import-actual spread over adding the name by hand:');
  console.log("    vi.mock('<spec>', async (importOriginal) => ({ ...(await importOriginal()), … }))");
  console.log('  ⚠ That conversion is NOT always mechanical — spreading loads the REAL module, so its');
  console.log('    transitive imports load too and can strand a DIFFERENT bare mock in the same file.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Self-test — teeth proven here, not by a clean run over a green tree. A run
// reporting "no findings" would pass identically with the predicate inverted.
// ---------------------------------------------------------------------------
function runSelfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  // Runtime shapes are collected …
  const runtime = collectRuntimeExports(
    [
      'export function fn() {}',
      'export const CONST = 1;',
      'export class Klass {}',
      'export enum E { a }',
      'export const { destructured } = obj;',
      "export { reExported } from './x';",
    ].join('\n'),
  );
  for (const n of ['fn', 'CONST', 'Klass', 'E', 'destructured', 'reExported']) {
    check(`collects runtime export ${n}`, runtime.has(n));
  }

  // … and type-only shapes are NOT. This is the precision property: counting these
  // inflated the signal ~14× while pointing at nothing actionable.
  const typeOnly = collectRuntimeExports(
    [
      'export type Alias = string;',
      'export interface Iface { a: string }',
      'export type { OnlyType } from "./x";',
      'export { type InlineType } from "./y";',
    ].join('\n'),
  );
  check('excludes every type-only export', typeOnly.size === 0);

  // The diff reports only what is NEW.
  const added = diffAddedRuntimeExports('export const a = 1;', 'export const a = 1;\nexport const b = 2;');
  check('diff names the added export', added.length === 1 && added[0] === 'b');
  check(
    'diff is silent when only a type is added',
    diffAddedRuntimeExports('export const a = 1;', 'export const a = 1;\nexport type T = 2;').length === 0,
  );

  // An ENUMERATING factory on the changed module is a hit …
  const testPath = 'packages/x/lib/__tests__/a.test.ts';
  const hits = findEnumeratingMockers({
    modulePath: 'packages/x/lib/subject',
    testFiles: [testPath],
    read: () => "vi.mock('../subject', () => ({ old: 1 }));",
  });
  check('flags an enumerating factory on the changed module', hits.length === 1);

  // … while each SAFE form is silent. These are the controls: without them the check
  // above would pass just as well with the classifier stuck at "everything is a hit".
  check(
    'silent for the import-actual spread (the prescribed fix)',
    findEnumeratingMockers({
      modulePath: 'packages/x/lib/subject',
      testFiles: [testPath],
      read: () => "vi.mock('../subject', async (io) => ({ ...(await io()), old: 1 }));",
    }).length === 0,
  );
  check(
    'silent for an automock (no factory — vitest synthesises the whole surface)',
    findEnumeratingMockers({
      modulePath: 'packages/x/lib/subject',
      testFiles: [testPath],
      read: () => "vi.mock('../subject');",
    }).length === 0,
  );
  check(
    'silent for the SAME bad shape on a DIFFERENT module (precision, not zeal)',
    findEnumeratingMockers({
      modulePath: 'packages/x/lib/subject',
      testFiles: [testPath],
      read: () => "vi.mock('../other-subject', () => ({ old: 1 }));",
    }).length === 0,
  );

  // The zero-files verdict must NOT read as a clean bill (measured false-green class).
  check('zero examined files is reported as NOT CHECKED', formatNoFindings([], 'HEAD').includes('NOT CHECKED'));
  check('a non-empty examined set reads as a pass', formatNoFindings(['a.ts'], 'HEAD').startsWith('✓'));

  if (failures.length) {
    console.error(`check-vimock-export-strands --self-test FAILED:\n  ${failures.map((f) => `✗ ${f}`).join('\n  ')}`);
    return false;
  }
  console.log(`check-vimock-export-strands --self-test: all cases passed`);
  return true;
}

// Only run main() when invoked as a script, so the pure fns above stay unit-testable.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
