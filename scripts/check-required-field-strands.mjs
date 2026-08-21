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
// WI-37806: shared with the two guards ported from this one, which inherited this file's
// NOT-CHECKED prose but not its exit status. Re-exported below so this module's public
// surface is unchanged.
import { EXIT_NOT_CHECKED, exitForNoFindings, provedNothing } from './lib/not-checked.mjs';

export { EXIT_NOT_CHECKED, exitForNoFindings, provedNothing };

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

function git(args, { allowFail = false, cwd = ROOT } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/**
 * EI-20020054576584970: the guard was structurally blind to every file inside a submodule,
 * and that blindness is what let the 2026-08-12 incident through — `ActiveLockRow.lock_id`
 * in libs/papercusp/packages/locks/src/su-lock-store.ts stranded a mock fixture and froze
 * `main` for ~14h.
 *
 * The mechanism, which is worth stating because it produces no error you would notice: to
 * the SUPERPROJECT a submodule is a GITLINK, not a tree. So `git show HEAD:libs/papercusp/
 * .../su-lock-store.ts` does not return an old version of that file — it fails outright
 * ("exists on disk, but not in 'HEAD'"), and `git diff --name-only HEAD -- libs/papercusp`
 * can only ever name the gitlink, never a file within it. Both of this guard's entry points
 * — the DECLARED --files= set and the INFERRED diff set — therefore saw nothing to examine,
 * and the run degraded to NOT CHECKED while blaming the (real, familiar, benign) git-sync
 * race. A message that should have stopped the author instead reassured them.
 *
 * The fix is to ask the right repository. Each path is resolved to its owning submodule and
 * the show/diff is re-run with that submodule as cwd, against its OWN history — which is
 * what `HEAD` should have meant for that file all along.
 */
let submodulePrefixesCache = null;
function submodulePrefixes() {
  if (submodulePrefixesCache) return submodulePrefixesCache;
  const out = git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], {
    allowFail: true,
  });
  const prefixes = (out ?? '')
    .split('\n')
    .filter(Boolean)
    // `submodule.<name>.path <value>` — the value is everything past the first space, so a
    // path containing spaces survives (splitting on whitespace would truncate it).
    .map((line) => line.slice(line.indexOf(' ') + 1).trim())
    .filter(Boolean);
  // Longest-first so a nested submodule wins over its parent; otherwise the outer prefix
  // matches first and we re-run the query against the wrong repository.
  submodulePrefixesCache = prefixes.sort((a, b) => b.length - a.length);
  return submodulePrefixesCache;
}

/** The submodule prefix owning `file`, or null when it lives in the superproject. */
export function submoduleFor(file, prefixes) {
  for (const prefix of prefixes) {
    if (file === prefix || file.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/**
 * `file`'s contents at `base`, asked of whichever repository actually tracks it.
 * Returns null when the file has no version there (new file, or a base that repo lacks) —
 * the same contract the caller already handles by skipping the candidate.
 */
function showAtBase(file, base) {
  const prefix = submoduleFor(file, submodulePrefixes());
  if (!prefix) return git(['show', `${base}:${file}`], { allowFail: true });
  return git(['show', `${base}:${file.slice(prefix.length + 1)}`], {
    allowFail: true,
    cwd: resolve(ROOT, prefix),
  });
}

const isExported = (node) =>
  Boolean(node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));

/**
 * The names of every EXPORTED interface / type alias declared in `sourceText`.
 *
 * Deliberately SEPARATE from the property scan rather than derived from its dotted keys:
 * an `export interface Foo {}` with no members contributes zero property paths, so a
 * name-set inferred from those keys would not contain `Foo` — and adding the first
 * required field to it would then be suppressed as "new type" when it is exactly the
 * stranding case this guard exists to catch. Collecting declarations directly cannot
 * make that mistake.
 */
export function collectExportedTypeNames(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set();
  for (const stmt of sf.statements) {
    if ((ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) && isExported(stmt)) {
      names.add(stmt.name.text);
    }
  }
  return names;
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
  // Types that did not EXIST at `before`. main() already skips a brand-new FILE for exactly
  // this reason ("a brand-new exported interface has no pre-existing construction sites, so
  // it cannot strand anything") — but that reasoning was only applied at file granularity,
  // so a new type added to an EXISTING file reported every one of its fields as newly
  // required. Stranded sites are impossible there by construction, not merely unlikely: no
  // file at `before` can construct a type that does not exist at `before`, and any site
  // introduced alongside it is part of the same diff and is typechecked with it.
  //
  // This matters beyond noise (EI-19422135158287319): the guard re-fires on every later edit
  // to the same file, so one new type yields a run of identical warnings in a session, and a
  // warning that is provably impossible is how a genuinely valuable advisory gets tuned out.
  const beforeTypes = collectExportedTypeNames(beforeText, fileName);
  const added = [];
  for (const [path, info] of after) {
    if (info.optional) continue;
    // The declaring type is the dotted path's root (`Type.field`, `Type.nested.field`).
    if (!beforeTypes.has(path.split('.')[0])) continue;
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

/**
 * The no-findings verdict, as text.
 *
 * Exported as a seam because the DISTINCTION it draws is the entire value of the
 * check: "examined N files, found nothing" is a clean bill, while "examined ZERO
 * files" is not a result at all. Rendering the two identically is the same failure
 * class as `tsc -p .` typechecking zero files and reading as a pass — and on THIS
 * tree it is the common case rather than an edge one, because git-sync commits the
 * whole tree on a schedule, so a few minutes after you edit, working-tree == HEAD
 * and the default `--base HEAD` diff is empty.
 *
 * Measured 2026-08-02: this printed a green for a change that HAD added required
 * field `ServeProgress.bytesIn`, purely because git-sync had already swept it.
 */
export function formatNoFindings(examinedFiles, base, { declared = false, identicalFiles = [] } = {}) {
  const files = Array.isArray(examinedFiles) ? examinedFiles : [];
  if (files.length > 0) {
    // Naming the COUNT was not enough. A count is unfalsifiable by the one person who
    // could catch the mistake — the author, who knows which file carries their change.
    // Listing the files lets them see in one glance that theirs is not among them.
    //
    // EI-20097325488507587: when EVERY named file turned out identical to `base`, this
    // run compared nothing — and leading with ✓ makes the invalidation below read as a
    // caveat on a pass rather than as the verdict. The exit code already said
    // EXIT_NOT_CHECKED; the HEADLINE has to agree with it, because the headline is what
    // a reader acts on. Same reasoning as the zero-files branch below, which was already
    // fixed this way — this is the per-file form that survived it.
    const nothingProved = provedNothing({ examinedFiles: files, identicalFiles, declared });
    const lines = [
      nothingProved
        ? `⚠ NOT CHECKED — ${files.length} named file(s) are byte-identical to ${base}, so nothing was compared.`
        : `✓ no required fields added to exported types (${files.length} file(s) examined vs ${base})`,
      ...files.map((f) => `    ${f}`),
    ];
    if (!declared) {
      // The failure this exists to prevent (EI-19377892307939503): the set is INFERRED
      // from `git diff`, which on this shared tree is every agent's uncommitted edits.
      // git-sync commits YOUR file within minutes — dropping it out of the diff — while
      // peers' churn keeps the count non-zero, so the zero-files guard below never fires
      // and the green is a true statement about three files you have never opened.
      lines.push(
        '  ⚠ That set is INFERRED from `git diff` — on this shared tree it is EVERY agent’s',
        '    uncommitted edits, not necessarily yours. If the file carrying your change is',
        '    not listed above, this green says NOTHING about it (git-sync commits your edit',
        '    within minutes, which drops it out of this diff).',
        '    Scope it to what you actually changed:',
        '      node scripts/check-required-field-strands.mjs --files=<your,files>',
      );
    }
    // EI-19396116936287206: `--files=` DECLARES the set (trustworthy for WHICH files were
    // examined), but "examined" only ever meant "a before/after text pair was diffed" — it
    // said nothing about whether that diff was NON-EMPTY. On this tree git-sync commits an
    // edit within minutes, so a named file is frequently byte-identical to `base` (HEAD) by
    // the time you check it: the comparison runs, finds nothing to compare, and reports a
    // clean bill that is vacuously true of a file you never actually diffed against its
    // pre-edit state. This is the SAME root cause as the zero-files case below, one level
    // more specific (per-file instead of whole-run) — and it is silent under `declared`
    // because the warning above only fires for the INFERRED-set failure mode, not this one.
    if (identicalFiles.length > 0) {
      lines.push(
        `  ⚠ NOT CHECKED — ${identicalFiles.length} of ${files.length} named file(s) are BYTE-IDENTICAL`,
        `    to ${base}, so this run proves NOTHING about them (git-sync likely already`,
        '    committed your edit — on this tree that happens within minutes):',
        ...identicalFiles.map((f) => `      ${f}`),
        '    Re-run against the commit that actually carried your change:',
        "      C=$(git log -1 --format=%H -S'<a string your change introduced>' -- <file>)",
        '      node scripts/check-required-field-strands.mjs --base "$C^" --files=<your,files>',
      );
    }
    return lines.join('\n');
  }
  return [
    `⚠ NOT CHECKED — nothing differs from '${base}', so ZERO files were examined.`,
    '  This is NOT a clean bill. On this shared tree it usually means git-sync',
    '  already committed your edit, not that you changed nothing.',
    '',
    '  Re-run against the commit that actually carried your change:',
    "    C=$(git log -1 --format=%H -S'<a string your change introduced>' -- <file>)",
    '    node scripts/check-required-field-strands.mjs --base "$C^"',
    '',
    '  (Use -G instead of -S when searching by a name you did not introduce.)',
  ].join('\n');
}

// EXIT_NOT_CHECKED / exitForNoFindings / provedNothing now live in ./lib/not-checked.mjs
// (imported + re-exported at the top of this file). They were extracted in WI-37806 after
// the two guards ported from this one inherited this file's NOT-CHECKED prose but not its
// exit status — see that module's header for the full argument.

/**
 * EI-20097325488507587: `--typecheck` asked for, then never run.
 *
 * A caller passes `--typecheck` to have the precise detector RUN. When no required-field
 * additions are found we return before reaching it — correctly, since there is nothing to
 * check — but silently, so the exit status is the caller's only signal and it is
 * indistinguishable from "the typecheck ran and passed". That is the same
 * absent-evidence-reads-as-evidence-of-absence failure the EXIT_NOT_CHECKED work fixed
 * one level up, and it survives that fix: `exitForNoFindings` legitimately returns 0 for
 * a genuine diff with no additions, and that 0 then carries an implication it never earned.
 *
 * The two reasons differ in what the reader should DO, so they are not collapsed:
 *   'no-findings' — the run did compare, and found nothing to typecheck. Believe it.
 *   'not-checked' — the run compared nothing at all; the absent typecheck is the
 *                   second-order symptom, and the NOT CHECKED text above is the fix.
 * Returns null when a typecheck was not requested, so callers can print unconditionally.
 */
export function formatTypecheckNotRun({ requested = false, reason = null } = {}) {
  if (!requested || !reason) return null;
  if (reason === 'not-checked') {
    return '\n--typecheck: NOT RUN — this run examined nothing to find additions in (see above).';
  }
  return [
    '\n--typecheck: NOT RUN — no required-field additions were found, so there was nothing',
    '  to typecheck. This exit status means "nothing to check", NOT "the typecheck passed".',
  ].join('\n');
}

/**
 * EI-18717671811306780: the confirm step is slow, and the fast substitute is BLIND.
 *
 * The commands above are project-wide on purpose. Under fleet load the operator-core
 * one queues behind pc-heavy — measured 2026-08-13 at load 93: still queued at 90s,
 * never started. An author who reads that as a hang reaches for the fastest green
 * thing available, and the fastest green thing available is a SCOPED typecheck
 * (`build:typecheck { scopeToFiles: true }`, or any scoped tsc).
 *
 * That substitution is not merely weaker — it is blind to this exact class, by
 * construction. A scoped run compiles the named file plus its import graph: what the
 * file imports. The sites a required-field addition strands are its DEPENDENTS — they
 * import the changed file, so they are never in that graph. The scoped run therefore
 * reports GREEN precisely when this guard has just told you something is stale, which
 * is worse than not running it: it manufactures evidence for the wrong conclusion.
 * (build:typecheck states the same limitation in its own `scopeToFiles` contract.)
 *
 * So the warning is attached to the remediation, not to a doc a hurried author will
 * not open — and it names the queue as expected behaviour so a wait is not misread
 * as a failure that justifies the shortcut.
 */
export function formatScopedTypecheckWarning() {
  return [
    '\n  ⚠ Do NOT substitute a SCOPED typecheck to dodge the queue.',
    '    A scoped run — build:typecheck { scopeToFiles: true }, or any scoped tsc —',
    '    compiles your file plus what IT imports. The stranded sites are DEPENDENTS:',
    '    they import you, so they are never in that graph. A scoped run goes GREEN on',
    '    exactly the class this guard exists to catch. Under fleet load the command',
    '    above can sit in the pc-heavy queue for minutes — that is the queue working,',
    '    not a hang. Wait it out or run it detached; never swap in a narrower check.',
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const runTypecheck = argv.includes('--typecheck');
  const baseIdx = argv.indexOf('--base');
  // Green-checkpoint runs in a clean candidate checkout and supplies AFFECTED_BASE so this
  // diff-driven guard compares the candidate against the last green commit. Keep HEAD as the
  // local default, and let an explicit --base win over the gate environment.
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : process.env.AFFECTED_BASE || 'HEAD';

  // `--files=a,b,c` DECLARES the set instead of inferring it. Mirrors lint:tsc, which
  // learned the same lesson: on a tree the whole fleet edits, an inferred "changed set"
  // is everyone's, so only a declared one carries trustworthy attribution.
  const filesArg = argv.find((a) => a.startsWith('--files='));
  const declaredFiles = filesArg
    ? filesArg
        .slice('--files='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  let candidates;
  if (declaredFiles) {
    candidates = declaredFiles.map((file) => ({ status: 'M', file }));
  } else {
    // Changed .ts/.tsx files vs the base. A file with no base version is skipped: a brand-new
    // exported interface has no pre-existing construction sites, so it cannot strand anything.
    const nameStatus = git(['diff', '--name-status', base, '--', '*.ts', '*.tsx'], { allowFail: true });
    if (nameStatus === null) {
      console.error(`check-required-field-strands: cannot diff against '${base}'`);
      // A base we cannot diff against means we examined nothing — the one thing
      // this must never report as a clean bill (EI-20095543794921181).
      process.exit(EXIT_NOT_CHECKED);
    }
    const parseNameStatus = (text, prefix = '') =>
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [status, ...rest] = line.split('\t');
          const file = rest[rest.length - 1];
          return { status, file: prefix ? `${prefix}/${file}` : file };
        });

    candidates = parseNameStatus(nameStatus);

    // The superproject diff above lists a changed submodule as a single GITLINK entry, never
    // the .ts files inside it — so without this the inferred mode silently skips every
    // submodule edit (EI-20020054576584970). Ask each submodule about its own working tree.
    // allowFail per submodule: an uninitialised checkout, or a `base` that repo does not
    // have, must degrade to "examined nothing here" rather than abort the whole run.
    for (const prefix of submodulePrefixes()) {
      const subStatus = git(['diff', '--name-status', base, '--', '*.ts', '*.tsx'], {
        allowFail: true,
        cwd: resolve(ROOT, prefix),
      });
      if (subStatus) candidates.push(...parseNameStatus(subStatus, prefix));
    }
  }

  const findings = [];
  // The files genuinely COMPARED — not merely listed as candidates. A candidate can be
  // skipped (added/deleted, .d.ts, no base version, gone from the tree), and counting
  // those as "examined" is the same overstatement this check exists to stop.
  const examinedFiles = [];
  // Of the examined files, the ones byte-identical to `base` — a diff against yourself,
  // which proves nothing (EI-19396116936287206). Only meaningful in --files= (declared)
  // mode: the auto-diff mode derives its candidate set FROM `git diff --name-status`, so
  // a listed file is, by construction, never identical to base.
  const identicalFiles = [];
  for (const { status, file } of candidates) {
    if (!file || status.startsWith('A') || status.startsWith('D')) continue;
    if (file.endsWith('.d.ts')) continue;

    const beforeText = showAtBase(file, base);
    if (beforeText === null) continue;
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) continue;
    const afterText = readFileSync(abs, 'utf8');

    examinedFiles.push(file);
    if (declaredFiles && beforeText === afterText) identicalFiles.push(file);
    const added = diffRequiredAdditions(beforeText, afterText, file);
    if (added.length) findings.push({ file, added });
  }

  const noFindingsExit = exitForNoFindings({
    examinedFiles,
    identicalFiles,
    declared: Boolean(declaredFiles),
  });
  // Reported in JSON too: a machine reader has even less to go on than a human, and
  // `findings: []` alongside a requested-but-unrun typecheck reads as a pass.
  const typecheck = findings.length
    ? { requested: runTypecheck, ran: runTypecheck, reason: null }
    : {
        requested: runTypecheck,
        ran: false,
        reason: noFindingsExit === EXIT_NOT_CHECKED ? 'not-checked' : 'no-findings',
      };

  if (json) {
    console.log(
      JSON.stringify(
        { base, examined: examinedFiles, identical: identicalFiles, findings, typecheck },
        null,
        2,
      ),
    );
  }

  if (!findings.length) {
    if (!json) {
      console.log(
        formatNoFindings(examinedFiles, base, { declared: Boolean(declaredFiles), identicalFiles }),
      );
      const note = formatTypecheckNotRun({ requested: runTypecheck, reason: typecheck.reason });
      if (note) console.log(note);
    }
    // EI-20095543794921181: "no findings" is only a clean bill if something was
    // actually diffed. Two ways it is not: nothing differed from `base` at all
    // (zero files), or every DECLARED file turned out byte-identical to it — the
    // per-file form of the same root cause, already described at formatNoFindings.
    // A partial run (some named files identical, others genuinely diffed) still
    // exits 0: it verified what it could, and the warning above names the rest.
    process.exit(noFindingsExit);
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
    console.log(formatScopedTypecheckWarning());
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
    // NOT process.exit(): `out` holds up to 64MB of captured tsc output and exit() does
    // not drain an async pipe write, so piping this would cut the error list — which
    // reads as FEWER type errors. See scripts/check-undrained-stdout-exit.mjs.
    process.exitCode = 1;
    return;
  }
  if (!json) console.log(out);
  process.exitCode = 0;
}

// Only run main() when invoked as a script, so the pure fns above stay unit-testable.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
