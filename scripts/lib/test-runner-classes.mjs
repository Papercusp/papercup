// test-runner-classes.mjs — derive the set of TEST RUNNERS this repo actually runs, from the
// repo itself, so that `attributeFailedTask`'s coverage can be asserted against reality instead
// of against whatever the last editor happened to remember.
//
// WHY THIS EXISTS (EI-20098997113620795)
//
// `attributeFailedTask` (scripts/lib/vitest-summary.mjs) is the single funnel every red task
// passes through to get named. It knew exactly ONE runner's output format for most of its life,
// while the repo ran several. The consequence was not a crash and not a wrong answer — it was a
// PLAUSIBLE WRONG DIAGNOSIS: an unparseable runner yields no file rows, which maps to the reason
// `no-file-rows`, whose own docstring reads "a worker crash, an OOM, a spawn error". So the system
// did not report "I cannot read this runner"; it sent triagers hunting infrastructure while the
// failing file sat named in plain text a few lines up. Twice — first for `node --test`
// (EI-20095409199430877), then for the bash selftest harness one leg further into the very same
// task (EI-20098997113620795).
//
// Both fixes were correct and neither addressed the mechanism: nothing anywhere FAILS when a
// runner becomes unparseable. The only symptom is a slow drift toward more `no-file-rows`, which
// reads as flakiness. The tests could not see the gap because every fixture was written from the
// same assumption that created it.
//
// So this module answers one question mechanically — "what runners does this repo run?" — and
// attributor-runner-coverage.test.ts asserts the attributor can speak for each one. A workspace
// adopting a new runner then fails a fast unit test that names the runner, instead of degrading
// into a misleading reason months later.
//
// ⚠ WHAT THIS MODULE DELIBERATELY DOES NOT CLAIM. It classifies a COMMAND STRING, which is
// evidence about the binary being invoked and nothing more. It cannot know what
// `node scripts/some-harness.mjs` runs internally, and it does not guess — that is the
// `bespoke-script` class, whose whole meaning is "the command string cannot tell us". Pretending
// otherwise would rebuild the original bug one level up: a confident classification that is wrong
// in exactly the cases nobody sampled.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The workspace scripts that `scripts/affected-tests.mjs` turns into TASKS — i.e. the entry
 * points whose combined output `attributeFailedTask` is ever handed.
 *
 * Mirrored from that script's task loop rather than imported, because affected-tests.mjs does its
 * work at module scope (it enumerates, runs and calls `process.exit`), so importing it from a test
 * would execute a test run. `attributor-runner-coverage.test.ts` asserts this list still matches
 * that loop's source, so the mirror cannot drift silently — the failure mode a hand-kept copy
 * would otherwise have.
 */
export const TASK_ENTRY_SCRIPTS = ['test', 'lint:el-tools', 'test:integration', 'test:el-suite'];

/**
 * Packages that are not npm workspaces but are still selected as tasks. Mirrors
 * STANDALONE_PACKAGE_DIRS in scripts/affected-tests.mjs (same drift assertion as above).
 */
export const STANDALONE_PACKAGE_DIRS = [
  'papercusp-desktop',
  'libs/generic/sse',
  'libs/papercusp/packages/file-claim',
];

/**
 * The runner classes, and whether `attributeFailedTask` can name a failing FILE for each.
 *
 * `attributable: false` is a declared, reviewed boundary — NOT a to-do and NOT an excuse. A task
 * in such a class reports `no-file-rows` legitimately, and the value of writing that down is that
 * it stops being indistinguishable from the blind spot this whole module exists to detect.
 *
 * ⚠ An `attributable: true` class MUST carry `fixture` (VERBATIM real runner output) and
 * `expectFile` (the path that output has to yield). The guard iterates this registry, so a new
 * attributable class without a fixture fails structurally — you cannot claim coverage you have not
 * demonstrated. Every fixture below is real emitted bytes, never a quote from a bug report: that
 * distinction has already cost two wrong regexes here (the esbuild trailing colon, and node's
 * `test at` anchor), because a reformatted quote produces a plausible matcher that silently never
 * matches, and an empty parse result reads as "nothing failed" rather than "my matcher is wrong".
 *
 * ⚠ Annotated `@type` below rather than left to inference, and the two JSDoc blocks are kept
 * SEPARATE deliberately: a `@typedef` and a `@type` in one comment do not combine, and the
 * annotation is silently dropped — the emitted `.d.mts` then carries the inferred literal union,
 * in which the unattributable entries simply lack `fixture`/`expectFile`. The guard cannot then
 * even ASK whether a fixture is present: the check fails to COMPILE instead of failing loudly at
 * the one moment it matters, which is the same "the detector went quiet" shape as the bug itself.
 */

/**
 * @typedef {object} RunnerClassSpec
 * @property {boolean} attributable whether attributeFailedTask can name a FILE for this runner
 * @property {string} detail what the parser keys on, or why no parser is possible
 * @property {string} [fixture] REQUIRED when attributable: verbatim real output from the runner
 * @property {string} [expectFile] REQUIRED when attributable: the path `fixture` must yield
 */

/** @type {Record<string, RunnerClassSpec>} */
export const RUNNER_CLASSES = {
  vitest: {
    attributable: true,
    detail: "vitest's `FAIL` rows and per-file `❯ … (n failed)` rollups. parseFailedTestFiles.",
    // Verbatim from a real captured vitest failure; the same two rows
    // affected-tests-failing-files-line.test.ts has asserted since EI-19395701908500754.
    fixture: [
      ' ❯ lib/release/green-checkpoint-real-deps.test.ts (12 tests | 2 failed) 812ms',
      'FAIL  app/adv/create/PreviewPanel.test.tsx',
    ].join('\n'),
    expectFile: 'app/adv/create/PreviewPanel.test.tsx',
  },
  'node-test': {
    attributable: true,
    detail: "node's built-in runner: `test at <file>:<line>:<col>`. parseNodeTestFailedFiles.",
    // Verbatim from run 3655179-735cdb19, the real red that exposed the gap (EI-20095409199430877).
    fixture: 'test at test/build-desktop-sidecar-lock.test.js:11:1',
    expectFile: 'test/build-desktop-sidecar-lock.test.js',
  },
  'bash-selftests': {
    attributable: true,
    detail:
      'papercusp-desktop/bin/lib/run-selftests.sh: `--- <name>.selftest.sh: FAIL`. ' +
      'parseBashSelftestFailedFiles.',
    // Verbatim bytes from the UNMODIFIED harness (EI-20098997113620795): its `$DIR` comes from
    // BASH_SOURCE, so running a copy in a scratch dir against stub selftests exercises the real
    // emitter. Deliberately keeps a PASS line and the roll-up, so the fixture proves the matcher
    // is failure-exclusive and does not double-count the summary.
    fixture: [
      '=== roster-scope.selftest.sh ===',
      '--- roster-scope.selftest.sh: FAIL',
      '',
      '=== disk-preflight.selftest.sh ===',
      '--- disk-preflight.selftest.sh: PASS',
      '',
      'FAIL — 1/17 papercusp-desktop selftest(s) failed: roster-scope.selftest.sh',
    ].join('\n'),
    expectFile: 'bin/lib/roster-scope.selftest.sh',
  },
  cargo: {
    attributable: false,
    detail:
      'Rust. Attributed separately by affected-tests.mjs, which records it as `non-vitest` — a ' +
      'distinct reason, so it is never confused with an unreadable runner.',
  },
  'astro-check': {
    attributable: true,
    detail:
      '`astro check` diagnostics: `<file>:<line>:<col> - error ts(NNNN): …`. ' +
      'parseAstroCheckFailedFiles.',
    // Verbatim from a real `astro check` run (astro 6.3.6) against a copy of the
    // operator-docs app with a planted two-error .astro file, read back through `cat -A`.
    //
    // ⚠ The ANSI escapes are KEPT here on purpose, unlike the sibling fixtures. astro colors
    // its output even when piped to a file, so these codes are what production actually
    // captures — and a matcher written against the rendered text matches ZERO of them. This
    // fixture therefore proves the strip-then-match property, not just the regex.
    //
    // The warning row is kept for the same reason the bash-selftests fixture keeps a PASS:
    // it proves the matcher is failure-exclusive (` - error ` vs ` - warning `) rather than
    // attributing every diagnostic the typechecker prints.
    fixture: [
      '\x1b[96msrc/content.config.ts\x1b[0m:\x1b[93m34\x1b[0m:\x1b[93m14\x1b[0m - \x1b[93mwarning\x1b[0m\x1b[90m ts(6385): \x1b[0m\'z\' is deprecated.',
      '\x1b[96msrc/pages/__fixture-broken.astro\x1b[0m:\x1b[93m2\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m ts(2322): \x1b[0mType \'string\' is not assignable to type \'number\'.',
    ].join('\n'),
    expectFile: 'src/pages/__fixture-broken.astro',
  },
  'bespoke-script': {
    attributable: false,
    detail:
      'A hand-written `node scripts/*.mjs` harness. Unattributable BY CONSTRUCTION: the command ' +
      'string does not reveal what runs inside, so no parser can be written from it. Membership ' +
      'is pinned by UNATTRIBUTABLE_TASKS so a NEW one is reviewed rather than absorbed silently.',
  },
};

/**
 * The exact tasks that are expected to be unattributable today, as `<workspace> :: <script>`.
 *
 * Pinned as a MEMBER LIST, not just a class set, and that distinction is the point. A new
 * `node scripts/whatever.mjs` task would otherwise be absorbed into `bespoke-script` and pass —
 * but a bespoke script is exactly where a whole new runner can hide. Pinning membership means a
 * new one has to be looked at by a human once.
 *
 * SHRINK-FRIENDLY: making a task attributable removes its entry. Growing this list is the change
 * that deserves the scrutiny.
 */
export const UNATTRIBUTABLE_TASKS = [
  '@papercupai/operator-docs :: test',
  '@papercupai/papercusp-docs :: test',
  '@papercusp/web :: lint:el-tools',
  '@papercusp/web :: test:el-suite',
];

/** Split a shell command into the segments that could each invoke a different binary. */
function commandSegments(text) {
  return String(text)
    .split(/&&|\|\||[;|]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Classify ONE already-resolved command segment. Returns a class id, or `null` when the segment
 * is an `npm run` reference the caller must resolve, or `'unknown'` when nothing matches.
 */
function classifySegment(segment) {
  // Order matters: `npm run` is checked first because a chain step names no binary of its own.
  if (/\bnpm\b[^\n]*\brun\b/.test(segment)) return null;
  if (/\bvitest\b/.test(segment)) return 'vitest';
  // `node … --test` — the flag, not the word "test" anywhere in the line.
  if (/\bnode\b[^\n]*\s--test\b/.test(segment) || /--experimental-test-runner\b/.test(segment)) {
    return 'node-test';
  }
  if (/\bcargo\b[^\n]*\btest\b/.test(segment)) return 'cargo';
  if (/\brun-selftests\.sh\b/.test(segment)) return 'bash-selftests';
  if (/\bastro\b\s+check\b/.test(segment)) return 'astro-check';
  // A bare `node <script>` / `bash <script>` with no recognised runner inside it. This is the
  // honest bottom of the classifier, not a catch-all: see the module header.
  if (/^\s*(?:node|bash|tsx|npx\s+tsx)\s+\S+/.test(segment)) return 'bespoke-script';
  return 'unknown';
}

/**
 * The runner classes a workspace script resolves to, following `npm run` chains.
 *
 * @param {string} scriptName
 * @param {Record<string,string>} scripts the OWNING workspace's scripts map
 * @param {{ scriptsByDir?: Map<string,Record<string,string>>, _seen?: Set<string> }} [opts]
 * @returns {Set<string>} class ids; may contain `'unknown'`, which callers must treat as a failure
 */
export function classifyRunnerClasses(scriptName, scripts, opts = {}) {
  const seen = opts._seen ?? new Set();
  const found = new Set();
  if (seen.has(scriptName)) return found; // a self-referential chain contributes nothing further
  seen.add(scriptName);
  const text = scripts?.[scriptName];
  if (typeof text !== 'string' || !text.trim()) return found;

  for (const segment of commandSegments(text)) {
    const direct = classifySegment(segment);
    if (direct !== null) {
      found.add(direct);
      continue;
    }
    // An `npm run <name>` step. Resolve it against the right workspace's scripts map.
    const prefix = segment.match(/--prefix\s+(\S+)/)?.[1];
    const target = segment.match(/\brun\b\s+(?:-{1,2}\S+\s+)*([\w:.-]+)/)?.[1];
    const targetScripts = prefix ? opts.scriptsByDir?.get(prefix) : scripts;
    if (!target || !targetScripts) {
      // A chain step we cannot follow is NOT silently dropped — an unfollowable step could hide
      // any runner at all, which is the exact failure this module exists to make loud.
      found.add('unknown');
      continue;
    }
    for (const c of classifyRunnerClasses(target, targetScripts, { ...opts, _seen: seen })) {
      found.add(c);
    }
  }
  return found;
}

/** Expand the root package.json `workspaces` globs to concrete package directories. */
export function expandWorkspaceDirs(repoRoot, patterns) {
  const out = [];
  for (const p of patterns ?? []) {
    if (p.includes('*')) {
      const base = p.replace(/\/\*$/, '');
      const baseDir = join(repoRoot, base);
      if (!existsSync(baseDir)) continue;
      for (const entry of readdirSync(baseDir)) {
        const dir = `${base}/${entry}`;
        if (existsSync(join(repoRoot, dir, 'package.json'))) out.push(dir);
      }
    } else if (existsSync(join(repoRoot, p, 'package.json'))) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every task `scripts/affected-tests.mjs` could run, with the runner classes it resolves to.
 *
 * @param {string} repoRoot
 * @returns {Array<{ workspace: string, dir: string, script: string, classes: string[] }>}
 */
export function enumerateTaskRunnerClasses(repoRoot) {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const dirs = [
    ...expandWorkspaceDirs(repoRoot, root.workspaces),
    ...STANDALONE_PACKAGE_DIRS.filter((d) => existsSync(join(repoRoot, d, 'package.json'))),
  ];

  const scriptsByDir = new Map();
  const pkgByDir = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));
    scriptsByDir.set(dir, pkg.scripts ?? {});
    pkgByDir.set(dir, pkg);
  }

  const out = [];
  for (const dir of dirs) {
    const scripts = scriptsByDir.get(dir);
    for (const script of TASK_ENTRY_SCRIPTS) {
      if (!scripts[script]) continue;
      out.push({
        workspace: pkgByDir.get(dir).name ?? dir,
        dir,
        script,
        classes: [...classifyRunnerClasses(script, scripts, { scriptsByDir })].sort(),
      });
    }
  }
  return out;
}
