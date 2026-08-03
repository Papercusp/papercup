/**
 * affected-tests-failing-files-line.test.ts — EI-19395701908500754 regression guard.
 *
 * ## What broke
 *
 * `AFFECTED_TESTS_RESULT ... failed=N` counts TASKS (workspaces). Nothing in a
 * green-checkpoint verdict log named the failing FILES, so triagers mined prose for them —
 * and the prose they reached for was the gate's own `[green-checkpoint] isolation:
 * re-running <files>` narration. green-checkpoint's self-tests drive the real `runGreen`,
 * so those lines are emitted by FIXTURES too and land interleaved in the persisted log.
 *
 * Measured on the 01:36:17Z red (`...-cand-060ea000f206.log`): mining `isolation:` yielded
 * `lib/a.test.ts` / `lib/b.test.ts` — files that do not exist in this tree — while the real
 * break set was 11 files spanning BOTH failing workspaces. Two agents reached opposite
 * conclusions from the same log inside ten minutes.
 *
 * WI-7274 tagged the fixture lines so they are identifiable. This is the other half: give
 * the run a first-class per-FILE break set so there is no reason to read the prose at all.
 *
 * ## What these tests pin
 *
 * 1. The coverage taxonomy — specifically that an EMPTY file list can never read as
 *    "nothing failed" while failed tasks exist. That is the failure mode this whole shape
 *    exists to prevent, and it is the one a naive `files=[]` would reintroduce.
 * 2. The line is single-line and machine-parseable (a log reader greps ONE line).
 * 3. The adversarial property: the fixture prose that misled the original reader cannot
 *    contribute a single path to the new break set.
 * 4. The runner actually wires it in — a formatter nothing calls is not a fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatFailingFilesLine,
  attributeFailedTask,
  renderFailingFilesSummary,
  parseFailedTestFiles,
  AFFECTED_TESTS_FAILING_FILES_TOKEN,
  FAILING_FILES_LINE_MAX_ENTRIES,
} from '../../../../scripts/lib/vitest-summary.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

/** Parse the emitted line back into fields, the way a log consumer would. */
function parseLine(line: string) {
  const scalar = (k: string) => line.match(new RegExp(`\\b${k}=([^\\s]+)`))?.[1];
  const json = (k: string) => {
    const at = line.indexOf(`${k}=[`);
    if (at < 0) return null;
    const from = line.slice(at + k.length + 1);
    // The two JSON payloads are adjacent; take the first balanced array.
    let depth = 0;
    for (let i = 0; i < from.length; i++) {
      if (from[i] === '[') depth++;
      else if (from[i] === ']' && --depth === 0) return JSON.parse(from.slice(0, i + 1));
    }
    return null;
  };
  return {
    run: scalar('run'),
    coverage: scalar('coverage'),
    fileCount: Number(scalar('fileCount')),
    unattributedCount: Number(scalar('unattributedCount')),
    truncated: scalar('truncated') === 'true',
    files: json('files') as Array<{ workspace: string; file: string }> | null,
    unattributed: json('unattributed') as Array<{ task: string; reason: string }> | null,
  };
}

describe('formatFailingFilesLine — coverage is reported separately from scope', () => {
  it('reports coverage=complete only when every failed task was attributed to files', () => {
    const line = formatFailingFilesLine({
      runToken: '1234-abcd0000',
      entries: [
        { workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' },
        { workspace: '@papercusp/web', file: 'app/_lints/no-nul-bytes.test.ts' },
      ],
    });
    const p = parseLine(line);
    expect(p.coverage).toBe('complete');
    expect(p.fileCount).toBe(2);
    expect(p.unattributedCount).toBe(0);
    expect(p.files).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' },
      { workspace: '@papercusp/web', file: 'app/_lints/no-nul-bytes.test.ts' },
    ]);
  });

  /**
   * THE case this shape exists for. A run where tasks failed but none could be attributed
   * must not emit anything a reader can mistake for a clean result. Under a bare
   * `files=[...]` field this run and a green one are byte-identical on the file list.
   */
  it('never reads as clean when tasks failed but no file could be named', () => {
    const line = formatFailingFilesLine({
      runToken: '1234-abcd0000',
      entries: [],
      unattributed: [{ task: '@papercusp/operator-core :: test', reason: 'no-file-rows' }],
    });
    const p = parseLine(line);
    expect(p.coverage).toBe('unattributed');
    expect(p.fileCount).toBe(0);
    // The distinguishing evidence: the failure is stated, with its reason, not omitted.
    expect(p.unattributedCount).toBe(1);
    expect(p.unattributed).toEqual([{ task: '@papercusp/operator-core :: test', reason: 'no-file-rows' }]);
    // And it is NOT the same line a genuinely-empty run would produce.
    expect(line).not.toBe(formatFailingFilesLine({ runToken: '1234-abcd0000' }));
  });

  it('reports coverage=partial when only some failed tasks were attributed', () => {
    const p = parseLine(
      formatFailingFilesLine({
        runToken: '1234-abcd0000',
        entries: [{ workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' }],
        unattributed: [{ task: 'papercusp-desktop :: cargo test', reason: 'non-vitest' }],
      }),
    );
    expect(p.coverage).toBe('partial');
    expect(p.fileCount).toBe(1);
    expect(p.unattributedCount).toBe(1);
  });

  it('reports coverage=none only when nothing failed at all', () => {
    expect(parseLine(formatFailingFilesLine({ runToken: 't' })).coverage).toBe('none');
  });

  it('carries the run token so a fixture line cannot be mistaken for this run', () => {
    // The token is the same one in `Full run log: /tmp/papercusp-affected-tests-<token>.log`,
    // which is what lets a reader tie a break set to a specific run in an interleaved log.
    expect(parseLine(formatFailingFilesLine({ runToken: '99-deadbeef' })).run).toBe('99-deadbeef');
  });

  it('stays on ONE line even with paths that would otherwise break a log reader', () => {
    const line = formatFailingFilesLine({
      runToken: 't',
      entries: [{ workspace: '@papercusp/web', file: 'lib/weird\nname.test.ts' }],
    });
    expect(line.split('\n')).toHaveLength(1);
    expect(parseLine(line).files).toEqual([{ workspace: '@papercusp/web', file: 'lib/weird\nname.test.ts' }]);
  });

  it('truncates a pathological break set but keeps the COUNT exact', () => {
    const entries = Array.from({ length: FAILING_FILES_LINE_MAX_ENTRIES + 5 }, (_, i) => ({
      workspace: '@papercusp/operator-core',
      file: `lib/f${i}.test.ts`,
    }));
    const p = parseLine(formatFailingFilesLine({ runToken: 't', entries }));
    expect(p.truncated).toBe(true);
    expect(p.fileCount).toBe(entries.length); // the count is never truncated
    expect(p.files).toHaveLength(FAILING_FILES_LINE_MAX_ENTRIES);
  });
});

describe('the fixture prose that caused EI-19395701908500754 cannot reach the break set', () => {
  /**
   * VERBATIM from the red-#12 verdict log
   * (`2026-08-03T01-36-17-607Z-base-1e0ddc586454-cand-060ea000f206.log`). Every path here
   * is SYNTHETIC — `lib/a.test.ts`, `lib/b.test.ts` do not exist in this tree — and the
   * candidate `abc123` is a fixture sha. This is what a `grep 'isolation:'` returned.
   */
  const FIXTURE_CONTAMINATED_LOG = [
    '[green-checkpoint] isolation: re-running 2 originally-failing file(s) at single concurrency: lib/a.test.ts, lib/b.test.ts',
    '[green-checkpoint] isolation: ALL 2 originally-failing file(s) PASSED ... absorbed as load-flake(s): @papercusp/operator-core::lib/a.test.ts, @papercusp/operator-core::lib/b.test.ts',
    '[green-checkpoint] __CAPTURED_TEST_FIXTURE_RESULT__ {"reason":"not-green","green":false,"candidate":"abc123"}',
    '[green-checkpoint] worker-crash: ALL 1 crashed workspace(s) PASSED on a reduced-concurrency re-run — absorbed as load/infra flake(s): @papercusp/operator-core',
    '[green-checkpoint] suite red was absorbed as a load-flake, but a post-suite leg FAILED — holding the gate: @papercusp/operator-vite (SPA build)',
  ].join('\n');

  it('yields ZERO files from the prose an agent actually mined', () => {
    // The prose names five plausible-looking paths. The break set is derived from vitest's
    // own line-anchored FAIL/rollup rows, which narration cannot forge.
    expect(FIXTURE_CONTAMINATED_LOG).toContain('lib/a.test.ts');
    expect(parseFailedTestFiles(FIXTURE_CONTAMINATED_LOG)).toEqual([]);
  });

  it('still names the REAL failures when genuine vitest rows are interleaved with that prose', () => {
    // The falsifier for the test above: prove it returns [] because the prose is not a FAIL
    // row, NOT because the parser is inert on this input.
    const withRealRows = [
      FIXTURE_CONTAMINATED_LOG,
      ' ❯ lib/release/green-checkpoint-real-deps.test.ts (12 tests | 2 failed) 812ms',
      'FAIL  app/adv/create/PreviewPanel.test.tsx',
    ].join('\n');
    expect(parseFailedTestFiles(withRealRows).sort()).toEqual([
      'app/adv/create/PreviewPanel.test.tsx',
      'lib/release/green-checkpoint-real-deps.test.ts',
    ]);
  });
});

describe('the shared parser does not truncate an extension into a phantom path', () => {
  /**
   * Measured on the 060ea000f206 verdict log while documenting the fallback recipe. The
   * recipe CLAUDE.md used to give — `grep -oE 'FAIL +[^ ]+\.test\.ts'` — does not merely
   * skip a `.tsx` suite: `\.test\.ts` matches the PREFIX of `PreviewPanel.test.tsx`, and
   * `-o` prints the truncated match. So it emitted `app/adv/create/PreviewPanel.test.ts`,
   * a path that does not exist in this tree, and the real `.tsx` file never appeared.
   *
   * Pinned here because the production parser is the thing everything else now depends on:
   * if its file-shape fragment is ever narrowed back to `\.test\.ts`, the break set this
   * whole change exists to make trustworthy starts fabricating paths instead.
   */
  const REAL_FAIL_ROW = 'FAIL  app/adv/create/PreviewPanel.test.tsx';

  it('keeps the full .tsx path that the naive regex truncates', () => {
    expect(parseFailedTestFiles(REAL_FAIL_ROW)).toEqual(['app/adv/create/PreviewPanel.test.tsx']);
  });

  it('demonstrates the truncation it is guarding against (the falsifier)', () => {
    // Not a test of our code — proof that the failure mode above is real, so the assertion
    // above cannot later be dismissed as guarding nothing.
    const naive = REAL_FAIL_ROW.match(/FAIL +[^ ]+\.test\.ts/)?.[0].replace(/^FAIL +/, '');
    expect(naive).toBe('app/adv/create/PreviewPanel.test.ts'); // ← the phantom path
    expect(naive).not.toBe('app/adv/create/PreviewPanel.test.tsx');
  });

  it('covers the other extensions a monorepo actually has', () => {
    const rows = [
      'FAIL  lib/a.test.ts',
      'FAIL  lib/b.spec.tsx',
      'FAIL  lib/c.test.mts',
      'FAIL  lib/d.test.jsx',
    ].join('\n');
    expect(parseFailedTestFiles(rows).sort()).toEqual([
      'lib/a.test.ts',
      'lib/b.spec.tsx',
      'lib/c.test.mts',
      'lib/d.test.jsx',
    ]);
  });
});

describe('attributeFailedTask — a red task never contributes nothing', () => {
  /** VERBATIM shape of a real captured vitest failure (rollup row + FAIL row). */
  const REAL_FAILURE_OUTPUT = [
    ' ❯ lib/release/green-checkpoint-real-deps.test.ts (12 tests | 2 failed) 812ms',
    'FAIL  app/adv/create/PreviewPanel.test.tsx',
    ' Test Files  2 failed | 3274 passed (3276)',
  ].join('\n');

  it('names every file a captured red printed', () => {
    const a = attributeFailedTask({
      workspace: '@papercusp/operator-core',
      task: '@papercusp/operator-core :: test',
      captured: true,
      output: REAL_FAILURE_OUTPUT,
    });
    expect(a.unattributed).toEqual([]);
    expect(a.entries.map((e) => e.file).sort()).toEqual([
      'app/adv/create/PreviewPanel.test.tsx',
      'lib/release/green-checkpoint-real-deps.test.ts',
    ]);
    expect(a.entries.every((e) => e.workspace === '@papercusp/operator-core')).toBe(true);
  });

  it('records an un-captured red (interactive TTY) instead of dropping it', () => {
    const a = attributeFailedTask({ workspace: 'w', task: 'w :: test', captured: false });
    expect(a.entries).toEqual([]);
    expect(a.unattributed).toEqual([{ task: 'w :: test', reason: 'no-captured-output' }]);
  });

  it('records a crash/OOM red whose output has no FAIL rows at all', () => {
    const a = attributeFailedTask({
      workspace: 'w',
      task: 'w :: test',
      captured: true,
      // A worker crash: real, fatal, and it never reached the reporter.
      output: 'Error: Worker terminated due to reaching memory limit: JS heap out of memory\n',
    });
    expect(a.entries).toEqual([]);
    expect(a.unattributed).toEqual([{ task: 'w :: test', reason: 'no-file-rows' }]);
  });

  it('every branch yields exactly one of files-or-a-reason — never silence', () => {
    const cases = [
      { workspace: 'w', task: 't', captured: true, output: REAL_FAILURE_OUTPUT },
      { workspace: 'w', task: 't', captured: true, output: '' },
      { workspace: 'w', task: 't', captured: false },
    ];
    for (const c of cases) {
      const a = attributeFailedTask(c);
      expect(a.entries.length + a.unattributed.length).toBeGreaterThan(0);
    }
  });
});

describe('renderFailingFilesSummary — the block the red path actually prints', () => {
  it('leads with the files, warns that failed=N counts tasks, and ends with the machine line', () => {
    const lines = renderFailingFilesSummary({
      runToken: '1234-abcd0000',
      failedTaskCount: 2,
      entries: [
        { workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' },
        { workspace: '@papercusp/web', file: 'app/_lints/no-nul-bytes.test.ts' },
      ],
    });
    expect(lines[0]).toContain('2 failing test file(s)');
    expect(lines[0]).toContain('failed=2 above counts TASKS, not files');
    expect(lines).toContain('  - @papercusp/operator-core :: lib/x.test.ts');
    expect(lines).toContain('  - @papercusp/web :: app/_lints/no-nul-bytes.test.ts');
    expect(lines.at(-1)).toContain(AFFECTED_TESTS_FAILING_FILES_TOKEN);
    expect(parseLine(String(lines.at(-1))).coverage).toBe('complete');
  });

  it('states, in prose a triager will read, that an unattributed list is not complete', () => {
    const lines = renderFailingFilesSummary({
      runToken: 't',
      failedTaskCount: 2,
      entries: [{ workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' }],
      unattributed: [{ task: 'papercusp-desktop :: cargo test', reason: 'non-vitest' }],
    });
    const prose = lines.join('\n');
    expect(prose).toContain('could NOT be attributed to files');
    expect(prose).toContain('do not read the list above as complete');
    expect(prose).toContain('  - papercusp-desktop :: cargo test (non-vitest)');
    expect(parseLine(String(lines.at(-1))).coverage).toBe('partial');
  });

  it('never emits a bare empty list when tasks failed', () => {
    const lines = renderFailingFilesSummary({
      runToken: 't',
      failedTaskCount: 1,
      unattributed: [{ task: '@papercusp/web :: test', reason: 'no-file-rows' }],
    });
    expect(lines.join('\n')).toContain('@papercusp/web :: test (no-file-rows)');
    expect(parseLine(String(lines.at(-1))).coverage).toBe('unattributed');
  });

  it('emits every line as a single log line, so an interleaved log stays parseable', () => {
    // The leading blank separator is deliberate; no OTHER line may carry an embedded newline.
    const lines = renderFailingFilesSummary({
      runToken: 't',
      failedTaskCount: 1,
      entries: [{ workspace: '@papercusp/web', file: 'a.test.ts' }],
    });
    expect(lines.slice(1).filter((l) => l.includes('\n'))).toEqual([]);
  });
});

describe('scripts/affected-tests.mjs wires the block in (a helper nothing calls is not a fix)', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('emits the summary on the failure path', () => {
    const failureBlock = source.slice(source.indexOf('if (failed) {'));
    expect(failureBlock).toContain('renderFailingFilesSummary({');
    expect(failureBlock).toContain('runToken: RUN_TOKEN');
    // Emitted alongside — not instead of — the task-level verdict line.
    expect(failureBlock).toContain("resultLine('failed')");
  });

  it('routes every failed vitest task through the attributor, keeping BOTH of its outputs', () => {
    // The vitest reasons are asserted behaviourally above, on the helper itself. What can
    // only be checked here is that the runner keeps the `unattributed` half — dropping it
    // is precisely what makes an empty file list read as clean.
    expect(source).toContain('attributeFailedTask({');
    expect(source).toContain('failedFileEntries.push(...a.entries)');
    expect(source).toContain('unattributedTasks.push(...a.unattributed)');
  });

  it('accounts for the non-vitest cargo task, which the attributor cannot speak for', () => {
    // Cargo does not go through attributeFailedTask, so its two failure sites are the one
    // place a red task could still be silently omitted from the break set.
    const cargoReasons = source.match(/reason: 'non-vitest'/g) ?? [];
    expect(cargoReasons).toHaveLength(2); // exit-nonzero, and runner-error
    expect(source).toContain("failedTaskNames.push('papercusp-desktop :: cargo test')");
  });

  it('stamps the same run token that names the full run log', () => {
    expect(source).toContain('const RUN_LOG_PATH = `/tmp/papercusp-affected-tests-${RUN_TOKEN}.log`');
  });

  it('greps for the token via the shared constant, so a rename cannot desync', () => {
    expect(AFFECTED_TESTS_FAILING_FILES_TOKEN).toBe('AFFECTED_TESTS_FAILING_FILES');
  });
});
