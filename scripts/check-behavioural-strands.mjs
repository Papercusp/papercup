#!/usr/bin/env node
/**
 * check-behavioural-strands.mjs — the BEHAVIOURAL cross-workspace strand trap,
 * mechanised (EI-20022235111425919).
 *
 * THE TRAP, MEASURED 2026-08-09/10 (~3 gate reds, ~2h of frozen `main`, three agents
 * diagnosing it independently in parallel):
 *   WI-37582 added a two-stage lexical cascade to `libs/generic/search/src/hybrid.ts` —
 *   when stage 1 under-fills, the engine issues a SECOND `source.lexical()` call. Correct
 *   engine behaviour, tested, shipped. It stranded three
 *   `expect(searchDocs).toHaveBeenCalledTimes(1)` assertions in
 *   `packages/operator-core/lib/agent-tools/docs/__tests__/handlers.test.ts` — a DIFFERENT
 *   workspace, whose mock under-fills every time.
 *
 * WHY EVERY EXISTING GUARD IS STRUCTURALLY BLIND TO IT. The author ran, before landing,
 * the full owning-package suite (161 passed), the owning package's `tsc` (exit 0) and a
 * full operator-core typecheck (no new errors). All three were clean, and none of them
 * COULD have caught it:
 *   - `test:affected` maps CHANGED PATHS to workspaces. A `libs/generic/search` change
 *     never selects an `operator-core` suite. (CLAUDE.md documents the TYPE version of
 *     this; the behavioural version had no analogue.)
 *   - `tsc` cannot see it: a stale `toHaveBeenCalledTimes(N)` is perfectly well-typed.
 *     This is a RUNTIME strand.
 *   - `lint:required-field-strands` covers exactly the type-shaped version of this class
 *     (a new required field on a shared interface) and has no behavioural analogue.
 *   - `lint:di-seam-arity-strands` / `lint:optional-seam-strands` police the SHAPE of a DI
 *     seam at one site; neither compares a seam's CALL COUNT across a change.
 * So the first detector that fires is the shared fleet gate, hours later, blocking
 * everyone — the worst possible discovery point, and precisely the outcome
 * `lint:required-field-strands` exists to prevent for its own narrower class.
 *
 * THE GENERAL SHAPE. A change to a shared lib that alters HOW MANY TIMES it calls an
 * injected collaborator invalidates every downstream call-count / call-order assertion in
 * every OTHER workspace — none of which the selector will run. Adding a call is the common
 * case and a normal, correct thing to do, which is why this recurs and why the ADDITION is
 * never itself the failure. Advisory by default; it cannot false-block the fleet.
 *
 * WHY THIS GUARD IS A TRIGGER, NOT A SECOND ANALYSER (inherited from
 * check-required-field-strands' header, and true here for a different reason): the
 * authoritative detector for a behavioural strand is RUNNING THE DOWNSTREAM TESTS. There is
 * no `tsc` for this class, so this guard's job is to notice from the diff that you just made
 * the kind of edit that strands siblings, resolve the blast radius the workspace selector
 * cannot see, and hand you the exact command — or run it under `--run`.
 *
 * WHY THE BLAST RADIUS IS AN IMPORT GRAPH AND NOT A GREP. In the measured instance the
 * stranded test names neither the changed package nor the changed seam: it mocks
 * `@papercusp/docs-engine`'s `searchDocs`, which production code binds INTO the hybrid
 * engine's `source.lexical` seam two files away. Grepping test files for the seam finds
 * nothing. The link that exists is the import graph — `handlers.test.ts` → `../search` →
 * `@papercusp/search` — so that is what this walks, cross-workspace and through submodules.
 *
 * ⚠ EVERY FAILURE MODE HERE FAILS TOWARD NAMING MORE TESTS. Over-naming costs a glance;
 * under-naming reports a clean bill for a strand that is really there, which is the whole
 * defect this exists to prevent.
 *
 *   node scripts/check-behavioural-strands.mjs                  # advisory: name the trigger, the seam, and the command
 *   node scripts/check-behavioural-strands.mjs --run            # RUN the named tests, exit 1 on real failures
 *   node scripts/check-behavioural-strands.mjs --base "$C"      # pin the pre-edit commit (see below)
 *   node scripts/check-behavioural-strands.mjs --files=a.ts,b.ts
 *   node scripts/check-behavioural-strands.mjs --json
 *   node scripts/check-behavioural-strands.mjs --all            # do not clip the named-test list
 *
 * ⚠ `--base HEAD` DECAYS WITHIN MINUTES ON THIS TREE. git-sync commits the whole working
 * tree on a schedule, so a few minutes after your edit `working tree == HEAD` and the diff
 * is EMPTY — the guard then reports NOT CHECKED (exit 2), never a false green. Pin the
 * pre-edit sha (`C=$(git rev-parse HEAD)` BEFORE editing) or run it from the PostToolUse
 * nudge, which fires milliseconds after the write while HEAD is still unambiguously the
 * pre-edit content.
 *
 * ⚠ SUBMODULES. `libs/generic/*` and `libs/papercusp` are SUBMODULES, so a superproject
 * `git ls-files` / `git diff` cannot see the very files whose change is the trigger class —
 * the measured instance lives in one. This guard enumerates and diffs each submodule in its
 * OWN repo, and reports the base it actually used per repo (a superproject revision does not
 * name submodule content, so a submodule's base is its own HEAD).
 *
 * Exit codes:
 *   0 — examined a real diff and found no seam-call-count increase, or advisory mode, or
 *       `--run` found no failures
 *   1 — `--run` confirmed failing tests among the named blast radius
 *   2 — EXIT_NOT_CHECKED: nothing was compared (empty diff, or every declared file was
 *       byte-identical to its base), so this run proved nothing
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { EXIT_NOT_CHECKED, exitForNoFindings } from './lib/not-checked.mjs';
import { parseImportSpecifiers, resolveSpecifier } from './lib/module-reachability.mjs';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Repo-relative prefixes whose changes can strand another workspace's fixtures. */
const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|mjs|js|jsx)$/;
const EXCLUDED_DIR_RE = /(?:^|\/)(?:dist|build|node_modules|coverage|\.next|\.papercusp)\//;
const EXCLUDED_ROOT_RE = /^(?:papercup-release|papercup-checkpoint)\//;
/** Anything whose import specifiers are worth indexing. */
const IMPORTABLE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** A file bigger than this is a generated bundle, not a hand-written importer. */
const MAX_SCAN_BYTES = 512 * 1024;

/**
 * Matcher names whose meaning depends on HOW MANY TIMES (or IN WHAT ORDER) a collaborator
 * was called. Anchored on the SEMANTIC TOKEN inside the name, never on an exhaustive list
 * of spellings — the item that commissioned this guard names a form-blind detector as the
 * documented failure mode of the last three guards added here. `CalledTimes` therefore
 * matches `toHaveBeenCalledTimes` and `toBeCalledTimes` alike, `callCount` catches the
 * sinon spelling, and `NthCalled`/`LastCalled`/`CalledBefore`/`CalledAfter` catch the
 * order-sensitive family that an inserted call also invalidates.
 */
const COUNT_ORDER_MATCHER_RE =
  /(?:CalledTimes|CalledOnce|CalledTwice|CalledThrice|NthCalled|LastCalled|CalledBefore|CalledAfter|callCount)/;

/**
 * Property paths that read the call log directly — the hand-rolled spelling of the same
 * assertion, which a matcher-name-only detector would miss entirely.
 */
const CALL_LOG_ACCESS_RE = /\.mock\.(?:calls|lastCall|invocationCallOrder)\b/;

/** `expect(x).not.toHaveBeenCalled()` is a call-COUNT assertion (count must stay 0). */
const NEGATED_CALLED_RE = /\.not\s*(?:\.\w+\s*)*\.to(?:Have)?[Bb]eenCalled\s*\(/;

function git(args, { cwd = ROOT, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/**
 * `git diff <revision>` silently reinterprets an unknown revision as a PATHSPEC and returns
 * a working-tree diff with status 0 — after which `git show <revision>:<file>` yields empty
 * text and the guard counts files as examined while comparing against nothing. Validate the
 * base as a revision first. Borrowed verbatim in intent from check-required-field-strands,
 * where the same trap was measured.
 */
function resolvesRevision(revision, cwd = ROOT) {
  if (typeof revision !== 'string' || revision.length === 0) return false;
  return git(['rev-parse', '--verify', '--end-of-options', revision], { cwd, allowFail: true }) !== null;
}

/** Submodule paths, repo-relative, from .gitmodules (never from a plain `git ls-files`). */
function submodulePaths() {
  const out = git(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], {
    allowFail: true,
  });
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean)
    .filter((p) => existsSync(resolve(ROOT, p, '.git')) || existsSync(resolve(ROOT, p)))
    .sort();
}

/**
 * Which repo owns a repo-relative path: the superproject, or the longest matching
 * submodule. Every git question about a file must be asked of its OWNING repo — the
 * documented submodule trap is that the superproject answers "absent" for a file that is
 * committed, which reads exactly like "your change is not there".
 */
function repoForPath(file, submodules) {
  let best = null;
  for (const sub of submodules) {
    if (file === sub || file.startsWith(`${sub}/`)) {
      if (!best || sub.length > best.length) best = sub;
    }
  }
  if (best === null) return { submodule: null, cwd: ROOT, relPath: file };
  return { submodule: best, cwd: resolve(ROOT, best), relPath: file.slice(best.length + 1) };
}

function keepPath(file) {
  return !EXCLUDED_DIR_RE.test(file) && !EXCLUDED_ROOT_RE.test(file);
}

/** Every tracked source/test file in the superproject AND in each submodule. */
function allRepoFiles(submodules) {
  const files = [];
  const push = (list, prefix) => {
    for (const f of list) {
      if (!f) continue;
      const full = prefix ? `${prefix}/${f}` : f;
      if (keepPath(full)) files.push(full);
    }
  };
  push((git(['ls-files']) ?? '').split('\n'), '');
  for (const sub of submodules) {
    const out = git(['ls-files'], { cwd: resolve(ROOT, sub), allowFail: true });
    if (out) push(out.split('\n'), sub);
  }
  return files;
}

/** The `.` entry a manifest declares, as a package-relative path, or null. */
function declaredEntry(pkg) {
  const dot = pkg?.exports?.['.'];
  const fromExports =
    typeof dot === 'string' ? dot : dot?.import ?? dot?.default ?? dot?.types ?? null;
  const entry = fromExports ?? pkg?.module ?? pkg?.main ?? pkg?.types ?? null;
  return typeof entry === 'string' ? entry : null;
}

/**
 * TWO name->dir maps, because one is provably not enough (measured while building this
 * guard, on the very instance it exists to catch).
 *
 * `resolveSpecifier` resolves a bare specifier as `<dir>/<subpath>`, with `index` as the
 * subpath for a bare package name. That is right for `@papercusp/operator-core/lib/x`
 * (dir = the package dir) and WRONG for `@papercusp/search`, whose manifest entry is
 * `./src/index.ts` — there is no `libs/generic/search/index.ts` to find. With only the
 * package-dir map, reverse reachability from `libs/generic/search/src/hybrid.ts` reached
 * SIX files, all inside its own package, and did not name the operator-core test that this
 * change really stranded: a clean-looking green produced by a resolver that silently
 * dropped every cross-package edge into a `src/`-rooted package.
 *
 * So `byDir` handles subpath imports and `byEntryDir` handles bare imports of a package
 * whose entry is nested. Callers try both and take the first hit; a specifier that
 * resolves under neither was genuinely outside the repo.
 */
export function packageMapsByName(files) {
  const byDir = new Map();
  const byEntryDir = new Map();
  for (const f of files) {
    if (!/(?:^|\/)package\.json$/.test(f)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(resolve(ROOT, f), 'utf8'));
    } catch {
      // A malformed manifest fails open: one unresolvable package name costs edges, never
      // a wrong answer about the ones that did parse.
      continue;
    }
    if (!pkg?.name) continue;
    const dir = f === 'package.json' ? '' : dirname(f);
    byDir.set(pkg.name, dir);
    const entry = declaredEntry(pkg);
    if (entry) {
      const entryDir = dirname(entry.replace(/^\.\//, ''));
      if (entryDir && entryDir !== '.') byEntryDir.set(pkg.name, dir ? `${dir}/${entryDir}` : entryDir);
    }
  }
  return { byDir, byEntryDir };
}

/** Resolve `specifier` against both package maps; first hit wins. */
function resolveAcrossPackages({ specifier, fromFile, fileSet, byDir, byEntryDir }) {
  return (
    resolveSpecifier({ specifier, fromFile, fileSet, workspaceDirByName: byDir }) ??
    resolveSpecifier({ specifier, fromFile, fileSet, workspaceDirByName: byEntryDir })
  );
}

/** The nearest enclosing package dir for a file — this guard's definition of "workspace". */
function workspaceOf(file, packageDirs) {
  let best = '';
  for (const dir of packageDirs) {
    if (dir === '') continue;
    if (file.startsWith(`${dir}/`) && dir.length > best.length) best = dir;
  }
  return best;
}

// ── the trigger: a seam's call count went up ────────────────────────────────────────────

/**
 * Every call in `text` whose callee is rooted at a FUNCTION PARAMETER — i.e. an injected
 * collaborator, the only kind of call a downstream test can mock and count.
 *
 * Keyed by `param.member` (or `param()` for a directly-called parameter) and counted at
 * FILE level rather than per function: a call that merely MOVES between functions in the
 * same file strands nobody, and counting per function would report that move as an
 * increase. Nested closures still count, because the parameter they capture is the same
 * seam the caller injected.
 *
 * @returns {Map<string, number>} seam key -> number of call sites
 */
export function seamCallCounts(text, fileName = 'file.ts') {
  const counts = new Map();
  let source;
  try {
    source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return counts;
  }

  const paramScopes = [];
  const declaresParam = (name) => paramScopes.some((scope) => scope.has(name));

  const collectParamNames = (node, into) => {
    for (const param of node.parameters ?? []) {
      const bind = param.name;
      if (ts.isIdentifier(bind)) {
        into.add(bind.text);
      } else if (ts.isObjectBindingPattern(bind) || ts.isArrayBindingPattern(bind)) {
        // A destructured seam (`{ lexical }`) is injected exactly like a named one.
        for (const el of bind.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) into.add(el.name.text);
        }
      }
    }
  };

  /** `p(...)` -> `p()`; `p.m(...)` / `p?.m(...)` -> `p.m`; anything else -> null. */
  const seamKeyFor = (callee) => {
    if (ts.isIdentifier(callee)) return declaresParam(callee.text) ? `${callee.text}()` : null;
    if (ts.isPropertyAccessExpression(callee)) {
      const root = callee.expression;
      if (ts.isIdentifier(root) && declaresParam(root.text)) return `${root.text}.${callee.name.text}`;
      return null;
    }
    if (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee)) {
      return seamKeyFor(callee.expression);
    }
    return null;
  };

  const visit = (node) => {
    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node);

    if (isFunctionLike) {
      const names = new Set();
      collectParamNames(node, names);
      paramScopes.push(names);
    }

    if (ts.isCallExpression(node)) {
      const key = seamKeyFor(node.expression);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    ts.forEachChild(node, visit);
    if (isFunctionLike) paramScopes.pop();
  };

  ts.forEachChild(source, visit);
  return counts;
}

/**
 * Seams whose call count went UP between `before` and `after`.
 *
 * 0 -> N counts as an increase: a collaborator that was never called cannot have had a
 * `toHaveBeenCalledTimes` assertion pass by accident, but it very commonly has a
 * `expect(x).not.toHaveBeenCalled()` — the same class, same blast radius.
 */
export function increasedSeams(beforeText, afterText, fileName = 'file.ts') {
  const before = seamCallCounts(beforeText, fileName);
  const after = seamCallCounts(afterText, fileName);
  const rows = [];
  for (const [key, count] of after) {
    const was = before.get(key) ?? 0;
    if (count > was) rows.push({ seam: key, before: was, after: count });
  }
  rows.sort((a, b) => b.after - b.before - (a.after - a.before) || a.seam.localeCompare(b.seam));
  return rows;
}

// ── the blast radius: downstream call-count assertions in OTHER workspaces ──────────────

/**
 * Does this test file contain an assertion whose truth depends on a call COUNT or ORDER?
 *
 * Three independent forms, because each is a real spelling in this tree and a detector
 * that knew only the first would be exactly the form-blind guard the commissioning item
 * warns against: a count/order MATCHER name, a direct read of the call LOG, and a negated
 * "was never called" (an assertion that the count stays 0).
 */
export function hasCountOrOrderAssertion(text) {
  const stripped = stripCommentsOnly(String(text)) || String(text);
  return (
    COUNT_ORDER_MATCHER_RE.test(stripped) ||
    CALL_LOG_ACCESS_RE.test(stripped) ||
    NEGATED_CALLED_RE.test(stripped)
  );
}

/**
 * Reverse-reachable files from `seeds` over the import graph.
 *
 * Forward edges are built once for the whole tree (submodules included) and inverted;
 * an unresolvable specifier drops an edge, which under-names tests, so package-name
 * resolution is given every manifest in the tree rather than only root workspaces.
 */
export function reverseReachable({ seeds, files, readFile, byDir, byEntryDir }) {
  const fileSet = new Set(files);
  const indexOf = new Map(files.map((f, i) => [f, i]));
  /** @type {Map<number, number[]>} target index -> importer indices */
  const importers = new Map();

  for (const file of files) {
    if (!IMPORTABLE_RE.test(file)) continue;
    // The specifier scan runs on RAW text, deliberately. The shared comment stripper is a
    // full TypeScript scan per file; over this population (18.5k source files, ~320MB) that
    // exhausted a 2GB heap outright, while the raw regex completes in ~2.5s at ~80MB. The
    // only cost is that a COMMENTED-OUT import contributes an edge — which can only name
    // MORE downstream tests, the one direction this guard is allowed to be wrong in.
    const raw = readFile(file);
    if (!raw || raw.length > MAX_SCAN_BYTES) continue;
    const from = indexOf.get(file);
    for (const spec of parseImportSpecifiers(raw)) {
      const target = resolveAcrossPackages({ specifier: spec, fromFile: file, fileSet, byDir, byEntryDir });
      if (target === null || target === file) continue;
      const to = indexOf.get(target);
      if (to === undefined) continue;
      let arr = importers.get(to);
      if (!arr) {
        arr = [];
        importers.set(to, arr);
      }
      arr.push(from);
    }
  }

  const seen = new Set();
  const frontier = [];
  for (const seed of seeds) {
    const i = indexOf.get(seed);
    if (i !== undefined) frontier.push(i);
  }
  while (frontier.length > 0) {
    const current = frontier.pop();
    for (const importer of importers.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      frontier.push(importer);
    }
  }
  return new Set([...seen].map((i) => files[i]));
}

/**
 * The MEMBER names of the seams that grew — `source.lexical` -> `lexical`, `run()` -> `run`.
 *
 * Used to narrow the reachable set, because raw reachability is too blunt to act on and a
 * list nobody runs is worth nothing. MEASURED on the real instance: 4,182 reachable
 * other-workspace tests -> 1,567 carrying a count/order assertion -> 47 that also name a
 * seam member, with the genuinely-stranded file surviving all three filters (it mentions
 * `lexical` nine times). 47 is a 15-second check; 1,567 is a suite run nobody performs.
 *
 * The narrowing is a RANKING, never a silence: an aliased mock could carry a stale count
 * assertion without naming the seam, so the wider band is always reported, is runnable with
 * --wide, and is what gets named when the narrow set comes out empty.
 */
export function seamMemberNames(triggers) {
  const names = new Set();
  for (const t of triggers) {
    for (const s of t.seams) {
      const member = s.seam.includes('.') ? s.seam.slice(s.seam.indexOf('.') + 1) : s.seam.replace(/\(\)$/, '');
      if (member && /^[A-Za-z_$][\w$]*$/.test(member)) names.add(member);
    }
  }
  return [...names];
}

/** Does `text` name any of `members` as a whole word? */
export function mentionsSeamMember(text, members) {
  if (members.length === 0) return false;
  const escaped = members.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`).test(String(text));
}

// ── reporting ───────────────────────────────────────────────────────────────────────────

const CLIP = 25;

function formatFindings({ triggers, tests, clipped, baseNote, ran }) {
  const lines = [];
  lines.push('⚠ BEHAVIOURAL STRAND RISK — a shared seam gained call sites.');
  lines.push('');
  for (const t of triggers) {
    lines.push(`  ${t.file}`);
    for (const s of t.seams) {
      lines.push(`    seam ${s.seam}: ${s.before} call site(s) -> ${s.after}`);
    }
  }
  lines.push('');
  lines.push(
    'A downstream test in ANOTHER workspace that mocks this seam and asserts on how many',
  );
  lines.push(
    'times it was called is now stale. `test:affected` cannot select those files (it maps',
  );
  lines.push('changed paths to workspaces) and `tsc` cannot see them (a stale count is well-typed).');
  lines.push('');
  if (tests.length === 0) {
    lines.push('No downstream call-count/order assertions reachable from this change. Nothing to run.');
  } else {
    lines.push(`${tests.length} reachable test file(s) assert on call count or order:`);
    for (const f of tests.slice(0, clipped ? CLIP : tests.length)) lines.push(`  ${f}`);
    if (clipped && tests.length > CLIP) {
      lines.push(`  … and ${tests.length - CLIP} more (--all to list them, --json for the full set)`);
    }
    lines.push('');
    if (!ran) {
      lines.push('RUN THEM — this is the only detector for this class:');
      lines.push('  node scripts/check-behavioural-strands.mjs --run   # same selection, then runs it');
      lines.push('or, from an agent, the same set through the router:');
      lines.push(`  testing:run { files: [${tests.slice(0, 3).map((f) => `"${f}"`).join(', ')}${tests.length > 3 ? ', …' : ''}] }`);
    }
  }
  if (baseNote) {
    lines.push('');
    lines.push(baseNote);
  }
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const wantRun = argv.includes('--run');
  const wantAll = argv.includes('--all');
  const baseIdx = argv.indexOf('--base');
  const requestedBase = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';
  const filesArg = argv.find((a) => a.startsWith('--files='));
  const declared = Boolean(filesArg);
  const declaredFiles = filesArg
    ? filesArg
        .slice('--files='.length)
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  if (!resolvesRevision(requestedBase)) {
    const msg = `--base '${requestedBase}' does not resolve to a revision in the superproject; refusing to compare against a pathspec.`;
    if (wantJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(msg);
    return EXIT_NOT_CHECKED;
  }

  const submodules = submodulePaths();

  // Which files to examine. Declared mode fixes WHICH files, never WHETHER they differ.
  let candidates;
  if (declared) {
    candidates = declaredFiles.filter((f) => SOURCE_RE.test(f) && !TEST_RE.test(f) && keepPath(f));
  } else {
    const changed = new Set();
    const superDiff = git(['diff', '--name-only', requestedBase], { allowFail: true }) ?? '';
    for (const f of superDiff.split('\n')) if (f) changed.add(f);
    for (const sub of submodules) {
      const cwd = resolve(ROOT, sub);
      const out = git(['diff', '--name-only', 'HEAD'], { cwd, allowFail: true }) ?? '';
      for (const f of out.split('\n')) if (f) changed.add(`${sub}/${f}`);
    }
    candidates = [...changed].filter((f) => SOURCE_RE.test(f) && !TEST_RE.test(f) && keepPath(f));
  }

  // Compare each candidate against its OWNING repo's base.
  const triggers = [];
  const examined = [];
  const identical = [];
  const usedSubmoduleHead = new Set();
  for (const file of candidates) {
    const { submodule, cwd, relPath } = repoForPath(file, submodules);
    const base = submodule === null ? requestedBase : 'HEAD';
    if (submodule !== null && requestedBase !== 'HEAD') usedSubmoduleHead.add(submodule);
    const beforeText = git(['show', `${base}:${relPath}`], { cwd, allowFail: true });
    if (beforeText === null) continue; // new file: it can strand nothing that already exists
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) continue;
    const afterText = readFileSync(abs, 'utf8');
    examined.push(file);
    if (afterText === beforeText) {
      identical.push(file);
      continue;
    }
    const seams = increasedSeams(beforeText, afterText, file);
    if (seams.length > 0) triggers.push({ file, seams });
  }

  const baseNote =
    usedSubmoduleHead.size > 0
      ? `ⓘ base: superproject compared against '${requestedBase}'; submodule(s) ${[...usedSubmoduleHead].join(', ')} compared against their own HEAD (a superproject revision does not name submodule content).`
      : '';

  if (triggers.length === 0) {
    const exit = exitForNoFindings({ examinedFiles: examined, identicalFiles: identical, declared });
    const notChecked = exit === EXIT_NOT_CHECKED;
    const text = notChecked
      ? `⚠ NOT CHECKED — nothing was compared against '${requestedBase}' (${examined.length} file(s) examined, ${identical.length} identical).\n` +
        '  On this tree git-sync commits the working tree on a schedule, so a few minutes after an\n' +
        '  edit the default --base HEAD diff is EMPTY. Pin the pre-edit sha: --base "$C".\n' +
        '  This is NOT a clean bill.'
      : `✓ no seam gained call sites (${examined.length} changed source file(s) examined vs '${requestedBase}')`;
    if (wantJson) {
      console.log(
        JSON.stringify(
          { ok: true, notChecked, base: requestedBase, examined, identical, triggers: [], tests: [] },
          null,
          2,
        ),
      );
    } else {
      console.log(text);
      if (baseNote) console.log(baseNote);
    }
    return exit;
  }

  // Blast radius. Seeds are the changed files themselves; reachability is inverted over the
  // whole tree's import graph so a test that names neither the package nor the seam — the
  // measured instance — is still found.
  const allFiles = allRepoFiles(submodules);
  const { byDir, byEntryDir } = packageMapsByName(allFiles);
  const packageDirs = [...byDir.values()].filter(Boolean);
  const readFile = (f) => {
    try {
      return readFileSync(resolve(ROOT, f), 'utf8');
    } catch {
      return '';
    }
  };

  const seeds = triggers.map((t) => t.file);
  const reachable = reverseReachable({ seeds, files: allFiles, readFile, byDir, byEntryDir });
  const changedWorkspaces = new Set(seeds.map((f) => workspaceOf(f, packageDirs)));

  const tests = [...reachable]
    .filter((f) => TEST_RE.test(f))
    .filter((f) => !changedWorkspaces.has(workspaceOf(f, packageDirs)))
    .filter((f) => hasCountOrOrderAssertion(readFile(f)))
    .sort();

  let exit = 0;
  let ran = false;
  let runResult = null;
  if (wantRun && tests.length > 0) {
    ran = true;
    const proc = spawnSync('npm', ['run', 'test:file', '--', ...tests], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: wantJson ? 'pipe' : 'inherit',
      maxBuffer: 256 * 1024 * 1024,
    });
    runResult = { status: proc.status ?? null };
    if (proc.status !== 0) exit = 1;
  }

  if (wantJson) {
    console.log(
      JSON.stringify(
        { ok: true, notChecked: false, base: requestedBase, examined, identical, triggers, tests, ran, runResult },
        null,
        2,
      ),
    );
  } else {
    console.log(formatFindings({ triggers, tests, clipped: !wantAll, baseNote, ran }));
  }
  return exit;
}

if (isCliEntry(import.meta.url)) process.exit(main());

export { main, EXIT_NOT_CHECKED };
