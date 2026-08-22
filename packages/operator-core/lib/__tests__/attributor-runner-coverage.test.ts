/**
 * attributor-runner-coverage.test.ts — the failed-task attributor must be able to speak for
 * every test RUNNER this repo actually runs (EI-20098997113620795).
 *
 * WHAT THIS GUARDS, AND WHY IT IS NOT JUST ANOTHER PARSER TEST
 *
 * `attributeFailedTask` is the single funnel every red task passes through to get named. Twice
 * now it has been unable to read a runner the repo was really using, and BOTH times the symptom
 * was not an error — it was a plausible wrong diagnosis. An unreadable runner yields no file rows,
 * which maps to the reason `no-file-rows`, documented as "a worker crash, an OOM, a spawn error".
 * So the system said "infrastructure" while the failing file sat named in plain text a few lines
 * up: `node --test` (EI-20095409199430877), then the bash selftest harness one leg further into
 * the very same `@papercusp/desktop :: test` chain (EI-20098997113620795).
 *
 * Its existing tests all passed through both, because every fixture was a vitest fixture — written
 * from the same assumption that created the gap. A test cannot find a blind spot it shares.
 *
 * So this file does not add another fixture. It derives the runner set FROM THE REPO — every
 * workspace's task scripts, `npm run` chains followed — and asserts the attributor has a
 * demonstrated fixture for each attributable class, and that the unattributable ones are a small
 * pinned list somebody reviewed. A workspace adopting a new runner fails HERE, by name, in under a
 * second, instead of drifting into more `no-file-rows` months later and reading as flakiness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { attributeFailedTask } from '../../../../scripts/lib/vitest-summary.mjs';
import {
  RUNNER_CLASSES,
  TASK_ENTRY_SCRIPTS,
  STANDALONE_PACKAGE_DIRS,
  UNATTRIBUTABLE_TASKS,
  DECLARED_FAILING_FILES_TASKS,
  classifyRunnerClasses,
  enumerateTaskRunnerClasses,
} from '../../../../scripts/lib/test-runner-classes.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS_SRC = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const tasks = enumerateTaskRunnerClasses(REPO_ROOT);

describe('the runner population is real, and non-empty', () => {
  /**
   * Guards the instrument before anything is concluded from it. Every assertion below is of the
   * form "nothing unexpected was found", and each would pass just as happily against a classifier
   * that found NOTHING — a broken glob, a moved repo root, a rename. An empty result must never
   * be able to read as a clean bill of health.
   */
  it('enumerates a substantial task population with a vitest majority', () => {
    expect(tasks.length).toBeGreaterThan(50);
    const vitest = tasks.filter((t) => t.classes.includes('vitest'));
    expect(vitest.length).toBeGreaterThan(50);
  });

  it('resolves npm-run chains rather than giving up at the first step', () => {
    // `@papercusp/desktop :: test` is `npm run test:config && npm run test:shell &&
    // npm run test:selftests` — three legs across TWO different runners. If chain-following ever
    // regresses this collapses to [] or ['unknown'], and the whole guard goes quietly vacuous.
    const desktop = tasks.find((t) => t.workspace === '@papercusp/desktop' && t.script === 'test');
    expect(desktop, '@papercusp/desktop :: test disappeared from the task set').toBeDefined();
    expect(desktop!.classes).toEqual(['bash-selftests', 'node-test']);
  });
});

describe('every runner the repo runs is declared', () => {
  it('classifies the shared workspace-test launcher by its deterministic Vitest branch', () => {
    expect(
      [...
        classifyRunnerClasses('test', {
          test: 'node ../../scripts/workspace-test.mjs --passWithNoTests',
        }),
      ],
    ).toEqual(['vitest']);
  });

  it('classifies every task into a declared runner class', () => {
    const undeclared = tasks
      .filter((t) => t.classes.some((c) => !RUNNER_CLASSES[c]))
      .map((t) => `${t.workspace} :: ${t.script} => [${t.classes.join(', ')}]`);

    expect(
      undeclared,
      'A task resolves to a runner class that scripts/lib/test-runner-classes.mjs does not ' +
        'declare (`unknown` means its command matched no known runner, or an npm-run step could ' +
        'not be followed).\n\n' +
        'This is the failure this guard exists for. Do NOT silence it by widening the ' +
        'classifier regexes — decide what the runner IS, then either:\n' +
        '  • teach scripts/lib/vitest-summary.mjs to parse its failure output (add a parse* ' +
        'function, union it into attributeFailedTask) and declare the class with a fixture of ' +
        'REAL emitted bytes; or\n' +
        '  • declare it `attributable: false` with a reason, and add the task to ' +
        'UNATTRIBUTABLE_TASKS.\n\n' +
        'Leaving it unclassified means its failures will report `no-file-rows`, which reads as ' +
        'a worker crash / OOM and sends triagers hunting infrastructure.\n\nOffending tasks:',
    ).toEqual([]);
  });

  it('demonstrates attribution for every class claimed attributable', () => {
    for (const [id, spec] of Object.entries(RUNNER_CLASSES)) {
      if (!spec.attributable) continue;

      expect(
        typeof spec.fixture === 'string' && spec.fixture.length > 0,
        `Runner class '${id}' claims attributable:true but carries no \`fixture\`. A coverage ` +
          `claim has to be demonstrated, not asserted — add VERBATIM real output from the runner ` +
          `(generate it; never paste a quote from a bug report or a doc, which is how two ` +
          `regexes here were written against text the emitter does not actually produce).`,
      ).toBe(true);

      const attributed = attributeFailedTask({
        workspace: 'w',
        task: `w :: ${id}`,
        captured: true,
        output: spec.fixture,
      });

      expect(
        attributed.entries.map((e: { file: string }) => e.file),
        `attributeFailedTask could not name a file from '${id}' output. That is exactly the ` +
          `silent failure this guard exists to catch: it does not throw, it returns [] and ` +
          `reports reason='${attributed.unattributed[0]?.reason}', which a triager reads as an ` +
          `infrastructure crash.`,
      ).toContain(spec.expectFile);

      expect(
        attributed.unattributed,
        `'${id}' produced files AND an unattributed entry — a task cannot be both.`,
      ).toEqual([]);
    }
  });

  it('pins exactly which tasks are unattributable today', () => {
    const actual = tasks
      .filter((t) => !t.classes.some((c) => RUNNER_CLASSES[c]?.attributable === true))
      .map((t) => `${t.workspace} :: ${t.script}`)
      .sort();

    expect(
      actual,
      'The set of tasks whose failures CANNOT be attributed to a file has changed.\n\n' +
        'If this list GREW: a new task will report `no-file-rows` on every red, which reads as ' +
        'a crash/OOM. That is usually worth fixing rather than accepting — and if it genuinely ' +
        'is not (a typechecker, a bespoke harness whose command string reveals nothing), add it ' +
        'to UNATTRIBUTABLE_TASKS with that reasoning.\n' +
        'If it SHRANK: good — delete the entry from UNATTRIBUTABLE_TASKS.\n\n' +
        'Membership is pinned rather than just the class set because a bespoke ' +
        '`node scripts/*.mjs` task is exactly where an entire new runner can hide.',
    ).toEqual([...UNATTRIBUTABLE_TASKS].sort());
  });
});

/**
 * The declaration mechanism (EI-20102376842495928).
 *
 * `DECLARED_FAILING_FILES_TASKS` is the one entry in this whole subsystem that is a CLAIM ABOUT
 * BEHAVIOUR rather than a derivation from the repo: it asserts "this task emits the contract".
 * A hand-kept list of such claims is the exact shape of the bug this file exists to catch —
 * nothing fails when it stops being true, and the only symptom is a quiet drift back to
 * `no-file-rows`, which reads as an infra crash. So the claim is verified against the emitting
 * script's source rather than believed.
 */
describe('a declared task really does declare', () => {
  it('names an emitting script that exists', () => {
    for (const [task, rel] of Object.entries(DECLARED_FAILING_FILES_TASKS)) {
      expect(
        existsSync(resolve(REPO_ROOT, rel)),
        `DECLARED_FAILING_FILES_TASKS maps '${task}' to '${rel}', which does not exist. The ` +
          'script was moved or renamed; the attributor still believes this task names its own ' +
          'culprit files.',
      ).toBe(true);
    }
  });

  /**
   * IMPORTING the shared emitter is the property, not "contains the token". A script that
   * hand-types `DECLARED_FAILING_FILE` would satisfy a substring check and then silently drift
   * the moment the constant changes — the two-ends-of-one-format failure the emitter was put in
   * vitest-summary.mjs to prevent.
   */
  it('emits through the SHARED formatter rather than a hand-typed copy of the token', () => {
    for (const [task, rel] of Object.entries(DECLARED_FAILING_FILES_TASKS)) {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(
        /import\s*\{[^}]*\bformatDeclaredFailingFileLines\b[^}]*\}\s*from\s*['"][^'"]*vitest-summary\.mjs['"]/s.test(
          src,
        ),
        `'${task}' is declared attributable via ${rel}, but that file does not import ` +
          '`formatDeclaredFailingFileLines` from scripts/lib/vitest-summary.mjs.\n\n' +
          'Either the emit was removed — in which case this task is now silently unattributable ' +
          'and the entry must move to UNATTRIBUTABLE_TASKS — or the token is being hand-typed, ' +
          'which is how the emitter and parser come apart with nothing failing.',
      ).toBe(true);
    }
  });

  it('classifies a declared task as attributable, and leaves undeclared bespoke scripts alone', () => {
    for (const task of Object.keys(DECLARED_FAILING_FILES_TASKS)) {
      const found = tasks.find((t) => `${t.workspace} :: ${t.script}` === task);
      expect(found, `DECLARED_FAILING_FILES_TASKS names '${task}', which is not a real task.`).toBeTruthy();
      expect(found!.classes).toContain('declared-failing-files');
      expect(
        found!.classes.some((c: string) => RUNNER_CLASSES[c as keyof typeof RUNNER_CLASSES]?.attributable),
        `'${task}' declares the contract but still classifies as unattributable.`,
      ).toBe(true);
    }

    // The declaration ADDS a class; it does not erase what the command string said. A declaring
    // task that later grew an unrecognised runner beside its emit must still surface that.
    const declaredBespoke = tasks.filter(
      (t) =>
        t.classes.includes('declared-failing-files') &&
        DECLARED_FAILING_FILES_TASKS[`${t.workspace} :: ${t.script}`],
    );
    for (const t of declaredBespoke) {
      expect(t.classes).toContain('bespoke-script');
    }
  });

  /**
   * The counter-case, pinned deliberately. `test:el-suite` asserts on the replies of a LIVE
   * REMOTE agent ("no 'great question' prelude", "response is ≤350 chars"); when one fails the
   * culprit is that agent's prompt, which is not in this repo. Declaring would name its own
   * source — a confident attribution pointing at the one file that is certainly not broken.
   * If a future edit "completes" the migration by declaring it, this fails and says why.
   */
  it('does NOT declare the task whose failures have no repo file to name', () => {
    expect(
      DECLARED_FAILING_FILES_TASKS['@papercusp/web :: test:el-suite'],
      'test:el-suite drives a live remote agent — its checks assert on replies, not on repo ' +
        'files. The only path it could declare is its own source, which would send triagers to ' +
        'the harness instead of the agent config. `no-file-rows` is the honest answer here.',
    ).toBeUndefined();
  });
});

describe('the classifier fails loudly rather than guessing', () => {
  /**
   * The falsifiability half. Every assertion above reports "nothing unexpected"; none of them can
   * tell a genuinely clean repo from a classifier that has stopped detecting anything. These
   * prove the detector can still fire.
   */
  it('reports `unknown` for a command it does not recognise', () => {
    const classes = classifyRunnerClasses('test', { test: 'jest --ci --runInBand' });
    expect([...classes]).toEqual(['unknown']);
  });

  it('reports `unknown` for an npm-run step it cannot follow', () => {
    // A chain step pointing at a script that does not exist, or into a workspace whose scripts
    // were not supplied, must NOT be silently dropped — an unfollowable step can hide any runner.
    const viaMissingPrefix = classifyRunnerClasses('test', {
      test: 'npm --prefix some/other/pkg run test',
    });
    expect([...viaMissingPrefix]).toEqual(['unknown']);
  });

  it('does not mistake the word "test" in a path for the node test runner', () => {
    // `node scripts/test-helper.mjs` invokes no runner; only the `--test` FLAG does.
    const classes = classifyRunnerClasses('test', { test: 'node scripts/test-helper.mjs' });
    expect([...classes]).toEqual(['bespoke-script']);
  });

  it('survives a self-referential npm-run chain instead of hanging', () => {
    const classes = classifyRunnerClasses('test', { test: 'npm run test' });
    expect([...classes]).toEqual([]);
  });

  it('surfaces an unrecognised runner through the whole enumerator, not just the classifier', () => {
    // The unit tests above prove `classifyRunnerClasses` can say `unknown`. This proves the
    // COMPOSITION does — glob expansion, package.json reading, classification — because that is
    // what the guard actually runs, and a detector that fires in isolation while its real
    // pipeline reports nothing is the failure mode this whole file is about.
    //
    // Built in a temp dir, never by mutating the shared tree: a probe that edits a tracked file
    // can be committed by the git-sync sweep even when nothing goes wrong and no handler fails.
    const fake = mkdtempSync(join(tmpdir(), 'attributor-runner-coverage-'));
    try {
      mkdirSync(join(fake, 'pkgs/thing'), { recursive: true });
      writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }));
      writeFileSync(
        join(fake, 'pkgs/thing/package.json'),
        JSON.stringify({ name: '@x/thing', scripts: { test: 'jest --ci' } }),
      );

      const rows = enumerateTaskRunnerClasses(fake);
      expect(rows).toEqual([
        { workspace: '@x/thing', dir: 'pkgs/thing', script: 'test', classes: ['unknown'] },
      ]);
      const undeclared = rows.filter((t) =>
        t.classes.some((c: string) => !RUNNER_CLASSES[c as keyof typeof RUNNER_CLASSES]),
      );
      expect(undeclared).toHaveLength(1);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });
});

describe('the mirrors of scripts/affected-tests.mjs have not drifted', () => {
  /**
   * `enumerateTaskRunnerClasses` mirrors two lists from affected-tests.mjs rather than importing
   * them, because that script does its work at module scope — importing it from a test would
   * execute a test run. A hand-kept mirror silently under-covering is precisely the shape of bug
   * this file exists to prevent, so the mirror is asserted against the real source.
   */
  const src = readFileSync(AFFECTED_TESTS_SRC, 'utf8').replaceAll('"', "'");

  it('covers every script affected-tests.mjs turns into a task', () => {
    // The task loop pushes `{ ws, script: '<name>' }` for scripts it finds on a workspace.
    const pushed = new Set<string>();
    for (const m of src.matchAll(/tasks\.push\(\{\s*ws,\s*script:\s*'([^']+)'/g)) pushed.add(m[1]);

    expect(
      pushed.size,
      'Found no `tasks.push({ ws, script: … })` sites in affected-tests.mjs — the task loop was ' +
        'restructured, so this drift check is now vacuous and must be rewritten against the new ' +
        'shape rather than deleted.',
    ).toBeGreaterThan(0);

    const unmirrored = [...pushed].filter((s) => !TASK_ENTRY_SCRIPTS.includes(s));
    expect(
      unmirrored,
      'affected-tests.mjs now runs task script(s) that TASK_ENTRY_SCRIPTS does not mirror, so ' +
        'their runners are invisible to this guard. Add them to TASK_ENTRY_SCRIPTS in ' +
        'scripts/lib/test-runner-classes.mjs.',
    ).toEqual([]);
  });

  it('covers the same standalone packages', () => {
    const declared = src.match(/const STANDALONE_PACKAGE_DIRS = \[([^\]]*)\]/)?.[1];
    expect(declared, 'STANDALONE_PACKAGE_DIRS not found in affected-tests.mjs').toBeDefined();
    const dirs = [...declared!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(
      dirs,
      'The standalone (non-workspace) packages affected-tests.mjs runs have changed; mirror them ' +
        'into STANDALONE_PACKAGE_DIRS in scripts/lib/test-runner-classes.mjs or their runners go ' +
        'unchecked. papercusp-desktop is in this list — the workspace both attribution bugs were ' +
        'found in.',
    ).toEqual([...STANDALONE_PACKAGE_DIRS].sort());
  });
});
